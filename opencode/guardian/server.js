/**
 * OpenCode Guardian Server
 *
 * Responsibilities:
 * 1. Spawn and manage OpenCode web process on port 8100 (internal)
 * 2. Reverse-proxy all traffic from port 8099 → OpenCode
 * 3. Inject guardian banner script into HTML responses
 * 4. Monitor /config for file changes (hash-based polling)
 * 5. Manage backup/restore lifecycle with 10-min confirm window
 * 6. On timeout or crash-recovery: revert config and reload HA
 */

const http = require("http");
const httpProxy = require("http-proxy");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const OPENCODE_PORT = 8100;
const GUARDIAN_PORT = 8099;
const CONFIG_DIR = "/config";
const DATA_DIR = "/data";
const BACKUP_DIR = path.join(DATA_DIR, "last-known-good");
const STATE_FILE = path.join(DATA_DIR, "guardian-state.json");
const POLL_INTERVAL_MS = 5000;

const TIMEOUT_MS =
  (parseInt(process.env.GUARDIAN_TIMEOUT_MIN, 10) || 10) * 60 * 1000;

// Files/dirs to exclude from hashing and backup
const EXCLUDES = [
  "home-assistant_v2.db",
  "home-assistant_v2.db-shm",
  "home-assistant_v2.db-wal",
  ".storage",
  ".git",
  ".cloud",
  "deps",
  "__pycache__",
  "tts",
  ".HA_VERSION",
];

const RSYNC_EXCLUDES = EXCLUDES.map((e) => `--exclude=${e}`).join(" ");

// ---------------------------------------------------------------------------
// Guardian client script (injected into OpenCode HTML)
// ---------------------------------------------------------------------------
const CLIENT_SCRIPT = fs.readFileSync(
  path.join(__dirname, "client.js"),
  "utf8"
);

// ---------------------------------------------------------------------------
// State Management
// ---------------------------------------------------------------------------
let state = {
  status: "idle", // "idle" | "pending"
  deadline: null,
  changedFiles: [],
  lastHash: null,
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      Object.assign(state, saved);
    }
  } catch (e) {
    console.error("[guardian] Failed to load state:", e.message);
  }
}

function saveState() {
  try {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE); // atomic write
  } catch (e) {
    console.error("[guardian] Failed to save state:", e.message);
  }
}

// ---------------------------------------------------------------------------
// Config Hashing — detect changes by hashing all relevant files
// ---------------------------------------------------------------------------
function getConfigHash() {
  try {
    const excludeArgs = EXCLUDES.map(
      (e) => `-not -path '*/${e}' -not -path '*/${e}/*'`
    ).join(" ");
    const cmd = `find ${CONFIG_DIR} -maxdepth 4 \\( -name '*.yaml' -o -name '*.json' -o -name '*.py' -o -name '*.conf' -o -name '*.js' \\) ${excludeArgs} -type f -exec md5sum {} + 2>/dev/null | sort`;
    const output = execSync(cmd, { encoding: "utf8", timeout: 15000 });
    return crypto.createHash("md5").update(output).digest("hex");
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backup / Restore
// ---------------------------------------------------------------------------
function createBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    execSync(
      `rsync -a --delete ${RSYNC_EXCLUDES} ${CONFIG_DIR}/ ${BACKUP_DIR}/`,
      { timeout: 60000 }
    );
    console.log("[guardian] Backup created at", BACKUP_DIR);
  } catch (e) {
    console.error("[guardian] Backup failed:", e.message);
  }
}

function restoreBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      console.error("[guardian] No backup found, cannot restore");
      return false;
    }
    execSync(
      `rsync -a --delete ${RSYNC_EXCLUDES} ${BACKUP_DIR}/ ${CONFIG_DIR}/`,
      { timeout: 60000 }
    );
    console.log("[guardian] Config restored from backup");
    return true;
  } catch (e) {
    console.error("[guardian] Restore failed:", e.message);
    return false;
  }
}

function getChangedFiles() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    const cmd = `diff -rq ${RSYNC_EXCLUDES.replace(/--exclude=/g, "--exclude=")} ${BACKUP_DIR}/ ${CONFIG_DIR}/ 2>/dev/null | head -30 || true`;
    // Use rsync dry-run instead - more reliable
    const output = execSync(
      `rsync -n -a --delete ${RSYNC_EXCLUDES} --out-format='%n' ${CONFIG_DIR}/ ${BACKUP_DIR}/ 2>/dev/null | head -30 || true`,
      { encoding: "utf8", timeout: 10000 }
    );
    return output
      .split("\n")
      .filter((l) => l.trim() && !l.endsWith("/"))
      .map((f) => f.trim());
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// HA Supervisor API
// ---------------------------------------------------------------------------
function supervisorRequest(path, method, callback) {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) {
    console.log("[guardian] No SUPERVISOR_TOKEN, skipping API call:", path);
    if (callback) callback(false);
    return;
  }

  const options = {
    hostname: "supervisor",
    port: 80,
    path: path,
    method: method || "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 30000,
  };

  const req = http.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      console.log(`[guardian] Supervisor ${path}: ${res.statusCode}`);
      if (callback) callback(res.statusCode >= 200 && res.statusCode < 300, data);
    });
  });

  req.on("error", (e) => {
    console.error(`[guardian] Supervisor API error (${path}):`, e.message);
    if (callback) callback(false);
  });

  req.on("timeout", () => {
    req.destroy();
    if (callback) callback(false);
  });

  req.end();
}

function reloadHA() {
  console.log("[guardian] Requesting HA config reload...");
  supervisorRequest(
    "/core/api/services/homeassistant/reload_all",
    "POST",
    (ok) => {
      if (!ok) {
        console.log("[guardian] Reload failed, attempting HA restart...");
        supervisorRequest("/homeassistant/restart", "POST");
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Confirm / Revert Logic
// ---------------------------------------------------------------------------
function confirmChanges() {
  console.log("[guardian] User confirmed changes");
  createBackup(); // New baseline = current (confirmed) state
  state.status = "idle";
  state.deadline = null;
  state.changedFiles = [];
  state.lastHash = getConfigHash();
  saveState();
  return { ok: true, message: "Changes confirmed. New baseline saved." };
}

function revertChanges() {
  console.log("[guardian] Reverting changes...");
  const restored = restoreBackup();
  state.status = "idle";
  state.deadline = null;
  state.changedFiles = [];
  state.lastHash = getConfigHash();
  saveState();

  if (restored) {
    reloadHA();
    return { ok: true, message: "Changes reverted. HA reload triggered." };
  }
  return { ok: false, message: "Restore failed — no backup found." };
}

// ---------------------------------------------------------------------------
// Crash Recovery — runs on startup before anything else
// ---------------------------------------------------------------------------
function crashRecovery() {
  loadState();
  if (state.status === "pending") {
    console.log(
      "============================================================"
    );
    console.log("  CRASH RECOVERY: Unconfirmed changes found — reverting!");
    console.log(
      "============================================================"
    );
    if (fs.existsSync(BACKUP_DIR)) {
      restoreBackup();
      console.log("[guardian] Config restored to last known good state");
      // HA will reload on its own since it's restarting, or we trigger it
      setTimeout(() => reloadHA(), 5000);
    }
    state.status = "idle";
    state.deadline = null;
    state.changedFiles = [];
    saveState();
  }
}

// ---------------------------------------------------------------------------
// File Watcher — poll-based change detection
// ---------------------------------------------------------------------------
function startWatcher() {
  state.lastHash = getConfigHash();
  console.log("[guardian] Watcher started (polling every %ds)", POLL_INTERVAL_MS / 1000);

  setInterval(() => {
    try {
      const currentHash = getConfigHash();
      if (!currentHash) return; // hash failed, skip this cycle

      if (state.status === "idle") {
        if (currentHash !== state.lastHash) {
          console.log("[guardian] ⚡ Config changes detected!");
          state.status = "pending";
          state.deadline = Date.now() + TIMEOUT_MS;
          state.changedFiles = getChangedFiles();
          saveState();
        }
      } else if (state.status === "pending") {
        // Update changed files list
        state.changedFiles = getChangedFiles();

        // Check for timeout
        if (Date.now() > state.deadline) {
          console.log("[guardian] ⏰ TIMEOUT — reverting all changes");
          revertChanges();
          return;
        }
        saveState();
      }
    } catch (e) {
      console.error("[guardian] Watcher error:", e.message);
    }
  }, POLL_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// OpenCode Process Manager
// ---------------------------------------------------------------------------
let opencodeProcess = null;
let opencodeReady = false;

function startOpenCode() {
  console.log("[guardian] Starting OpenCode server on 127.0.0.1:%d ...", OPENCODE_PORT);

  opencodeProcess = spawn(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", String(OPENCODE_PORT)],
    {
      cwd: CONFIG_DIR,
      stdio: "inherit",
      env: process.env,
    }
  );

  opencodeProcess.on("error", (err) => {
    console.error("[guardian] Failed to start OpenCode:", err.message);
  });

  opencodeProcess.on("exit", (code, signal) => {
    opencodeReady = false;
    console.log(
      `[guardian] OpenCode exited (code=${code}, signal=${signal}), restarting in 5s...`
    );
    setTimeout(startOpenCode, 5000);
  });

  // Probe until OpenCode is ready
  const readyCheck = setInterval(() => {
    const req = http.get(
      `http://127.0.0.1:${OPENCODE_PORT}/`,
      { timeout: 2000 },
      (res) => {
        if (res.statusCode < 500) {
          opencodeReady = true;
          console.log("[guardian] OpenCode is ready");
          clearInterval(readyCheck);
        }
        res.resume(); // drain response
      }
    );
    req.on("error", () => {}); // not ready yet
    req.on("timeout", () => req.destroy());
  }, 2000);
}

// ---------------------------------------------------------------------------
// HTTP Proxy + Guardian API Server
// ---------------------------------------------------------------------------
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${OPENCODE_PORT}`,
  selfHandleResponse: true,
  ws: true,
});

// Strip accept-encoding so we receive uncompressed HTML to inject into.
// Forward X-Ingress-Path so OpenCode can optionally use it.
proxy.on("proxyReq", (proxyReq, req) => {
  proxyReq.removeHeader("accept-encoding");
  const ip = req.headers["x-ingress-path"];
  if (ip) proxyReq.setHeader("x-ingress-path", ip);
});

// Handle proxied responses — inject guardian script into HTML
proxy.on("proxyRes", (proxyRes, req, res) => {
  const contentType = proxyRes.headers["content-type"] || "";

  if (contentType.includes("text/html")) {
    const chunks = [];
    proxyRes.on("data", (chunk) => chunks.push(chunk));
    proxyRes.on("end", () => {
      let body = Buffer.concat(chunks).toString("utf8");

      // ── HA Ingress path fix ────────────────────────────────────────
      // HA proxies the add-on under a path prefix such as
      //   /api/hassio_ingress/TOKEN/
      // but strips that prefix before forwarding requests to us, so
      // OpenCode sees normal paths.  The browser however still uses the
      // full HA URL, meaning absolute paths like src="/assets/app.js"
      // resolve to HA's own root and the app never loads (blank page).
      //
      // Fix in three layers:
      //   1. <base href="…"> — makes RELATIVE paths resolve correctly
      //   2. Attribute regex — rewrites absolute paths already in the HTML
      //   3. JS runtime patch — intercepts fetch / XHR / WebSocket calls
      //      that construct absolute paths dynamically
      const ingressPath = (req.headers["x-ingress-path"] || "").replace(/\/$/, "");

      // Layer 2: rewrite absolute src/href/action attributes in the raw HTML
      if (ingressPath) {
        body = body.replace(
          /((?:src|href|action|data-src)=["'])(\/(?!\/))/g,
          `$1${ingressPath}/`
        );
      }

      // Layer 1 + 3: inject <base> and the runtime JS patcher + guardian banner
      const baseHref = ingressPath ? `${ingressPath}/` : "/";
      const injection = `<base href="${baseHref}">
<script>
/* ── HA Ingress runtime path patcher ── */
(function () {
  var _ip = ${JSON.stringify(ingressPath)};
  if (!_ip) return;
  function fixPath(u) {
    if (typeof u !== "string") return u;
    if (u.charAt(0) === "/" && u.slice(0, _ip.length) !== _ip) return _ip + u;
    return u;
  }
  /* fetch */
  var _fetch = window.fetch;
  window.fetch = function (resource, init) {
    return _fetch.call(this, typeof resource === "string" ? fixPath(resource) : resource, init);
  };
  /* XMLHttpRequest */
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    arguments[1] = fixPath(url);
    return _open.apply(this, arguments);
  };
  /* WebSocket — rewrite the pathname portion only */
  var _WS = window.WebSocket;
  function PatchedWS(url, protocols) {
    if (typeof url === "string") {
      try {
        var u = new URL(url);
        if (u.pathname.charAt(0) === "/" && u.pathname.slice(0, _ip.length) !== _ip) {
          u.pathname = _ip + u.pathname;
          url = u.toString();
        }
      } catch (e) {}
    }
    return protocols !== undefined ? new _WS(url, protocols) : new _WS(url);
  }
  PatchedWS.prototype = _WS.prototype;
  PatchedWS.CONNECTING = _WS.CONNECTING;
  PatchedWS.OPEN      = _WS.OPEN;
  PatchedWS.CLOSING   = _WS.CLOSING;
  PatchedWS.CLOSED    = _WS.CLOSED;
  window.WebSocket = PatchedWS;
})();
/* ── Guardian banner ── */
${CLIENT_SCRIPT}
</script>`;

      if (body.includes("<head>")) {
        body = body.replace("<head>", "<head>\n" + injection);
      } else if (body.includes("</head>")) {
        body = body.replace("</head>", injection + "\n</head>");
      } else {
        body = injection + body;
      }

      const headers = Object.assign({}, proxyRes.headers);
      headers["content-length"] = Buffer.byteLength(body);
      delete headers["content-encoding"];
      delete headers["content-security-policy"];
      delete headers["content-security-policy-report-only"];
      delete headers["x-frame-options"]; // allow embedding in HA iframe panels

      res.writeHead(proxyRes.statusCode, headers);
      res.end(body);
    });
  } else {
    // Non-HTML: pipe through unchanged
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  }
});

proxy.on("error", (err, req, res) => {
  console.error("[proxy] Error:", err.message);
  if (res && res.writeHead) {
    res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    res.end(LOADING_PAGE);
  }
});

// Fallback page shown while OpenCode boots up
const LOADING_PAGE = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>OpenCode — Starting</title>
  <meta http-equiv="refresh" content="3">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0d1117;
      color: #c9d1d9;
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    }
    .loader { text-align: center; }
    .spinner {
      width: 40px; height: 40px;
      border: 3px solid #21262d;
      border-top-color: #58a6ff;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 20px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 18px; font-weight: 500; margin-bottom: 8px; }
    p { font-size: 13px; color: #8b949e; }
  </style>
</head>
<body>
  <div class="loader">
    <div class="spinner"></div>
    <h1>OpenCode is starting up…</h1>
    <p>This page will refresh automatically.</p>
  </div>
</body>
</html>`;

// Guardian status page (fallback if injection fails)
function getStatusPage() {
  const remaining = state.deadline
    ? Math.max(0, state.deadline - Date.now())
    : null;
  const min = remaining ? Math.floor(remaining / 60000) : 0;
  const sec = remaining ? Math.ceil((remaining % 60000) / 1000) : 0;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Config Guardian</title>
  <meta http-equiv="refresh" content="5">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { min-height:100vh; background:#0d1117; color:#c9d1d9;
           font-family:'SF Mono','Fira Code',monospace; padding:40px; }
    h1 { font-size:20px; margin-bottom:20px; color:#58a6ff; }
    .status { padding:16px; border-radius:8px; margin-bottom:16px;
              background:#161b22; border:1px solid #30363d; }
    .idle { border-left:4px solid #3fb950; }
    .pending { border-left:4px solid #d29922; }
    .timer { font-size:28px; font-weight:bold; color:#d29922; }
    .files { font-size:12px; color:#8b949e; margin-top:8px; }
    .actions { margin-top:16px; display:flex; gap:12px; }
    .btn { padding:8px 24px; border:none; border-radius:6px;
           font-size:14px; font-weight:600; cursor:pointer;
           font-family:inherit; }
    .btn-confirm { background:#238636; color:#fff; }
    .btn-revert { background:#da3633; color:#fff; }
    .btn:hover { filter:brightness(1.15); }
    .btn:disabled { opacity:0.4; cursor:default; filter:none; }
  </style>
</head>
<body>
  <h1>⚡ Config Guardian</h1>
  <div class="status ${state.status}">
    <div><strong>Status:</strong> ${state.status === "idle" ? "✅ All clear — no pending changes" : "⚠️ Changes pending confirmation"}</div>
    ${state.status === "pending" ? `<div class="timer">${min}:${String(sec).padStart(2, "0")} remaining</div>` : ""}
    ${state.changedFiles.length > 0 ? `<div class="files"><strong>Changed:</strong><br>${state.changedFiles.join("<br>")}</div>` : ""}
  </div>
  <div class="actions">
    <form method="POST" action="/__guardian__/api/confirm" style="display:inline">
      <button class="btn btn-confirm" ${state.status !== "pending" ? "disabled" : ""}>✓ Confirm Changes</button>
    </form>
    <form method="POST" action="/__guardian__/api/revert" style="display:inline">
      <button class="btn btn-revert" ${state.status !== "pending" ? "disabled" : ""}>✗ Revert Changes</button>
    </form>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main HTTP Server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  // ── Guardian API ─────────────────────────────────────────
  if (pathname === "/__guardian__/api/status") {
    const remaining = state.deadline
      ? Math.max(0, state.deadline - Date.now())
      : null;
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        status: state.status,
        remainingMs: remaining,
        changedFiles: state.changedFiles,
        timeoutMinutes: TIMEOUT_MS / 60000,
      })
    );
    return;
  }

  if (pathname === "/__guardian__/api/confirm" && req.method === "POST") {
    let result;
    if (state.status === "pending") {
      result = confirmChanges();
    } else {
      result = { ok: false, message: "No pending changes to confirm." };
    }
    // If request came from a form (not fetch), redirect back
    const accept = req.headers.accept || "";
    if (accept.includes("text/html")) {
      res.writeHead(303, { Location: "/__guardian__/" });
      res.end();
    } else {
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }
    return;
  }

  if (pathname === "/__guardian__/api/revert" && req.method === "POST") {
    let result;
    if (state.status === "pending") {
      result = revertChanges();
    } else {
      result = { ok: false, message: "No pending changes to revert." };
    }
    const accept = req.headers.accept || "";
    if (accept.includes("text/html")) {
      res.writeHead(303, { Location: "/__guardian__/" });
      res.end();
    } else {
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }
    return;
  }

  // Guardian status page (fallback UI)
  if (pathname === "/__guardian__/" || pathname === "/__guardian__") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getStatusPage());
    return;
  }

  // ── Proxy to OpenCode ────────────────────────────────────
  if (!opencodeReady) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    res.end(LOADING_PAGE);
    return;
  }

  proxy.web(req, res);
});

// WebSocket upgrade — proxy to OpenCode (no selfHandleResponse needed)
server.on("upgrade", (req, socket, head) => {
  if (!opencodeReady) {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head);
});

// ---------------------------------------------------------------------------
// Boot Sequence
// ---------------------------------------------------------------------------
console.log("[guardian] Running crash recovery check...");
crashRecovery();

console.log("[guardian] Creating initial backup...");
createBackup();

console.log("[guardian] Starting file watcher...");
startWatcher();

console.log("[guardian] Launching OpenCode...");
startOpenCode();

server.listen(GUARDIAN_PORT, "0.0.0.0", () => {
  console.log("[guardian] ✅ Guardian server listening on 0.0.0.0:%d", GUARDIAN_PORT);
  console.log("[guardian] ✅ Confirm timeout: %d minutes", TIMEOUT_MS / 60000);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[guardian] SIGTERM received, shutting down...");
  if (opencodeProcess) opencodeProcess.kill("SIGTERM");
  server.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[guardian] SIGINT received, shutting down...");
  if (opencodeProcess) opencodeProcess.kill("SIGTERM");
  server.close();
  process.exit(0);
});
