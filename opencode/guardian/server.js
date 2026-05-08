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
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>OpenCode — Starting</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="3">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    :root{
      --surface:#0a0e1a; --surface-1:#141828; --surface-2:#1c2238;
      --primary:#a78bfa; --primary-2:#7c5cec; --text:#e2e8f0; --muted:#94a3b8;
    }
    body{
      min-height:100dvh;background:
        radial-gradient(1200px 600px at 70% -10%,rgba(124,92,236,.18),transparent 60%),
        radial-gradient(900px 600px at -10% 110%,rgba(89,78,234,.16),transparent 55%),
        var(--surface);
      color:var(--text);
      font:500 14px/1.5 'Inter','SF Pro Text',-apple-system,'Segoe UI',Roboto,system-ui,sans-serif;
      -webkit-font-smoothing:antialiased;
      display:flex;align-items:center;justify-content:center;padding:24px;
    }
    .card{
      width:100%;max-width:380px;text-align:center;
      background:linear-gradient(180deg,rgba(28,34,56,.72),rgba(20,24,40,.72));
      border:1px solid rgba(167,139,250,.18);border-radius:24px;
      padding:36px 28px;
      box-shadow:
        0 1px 0 rgba(255,255,255,.04) inset,
        0 24px 60px rgba(8,10,24,.55),
        0 0 0 1px rgba(167,139,250,.08);
      backdrop-filter:saturate(180%) blur(16px);
      -webkit-backdrop-filter:saturate(180%) blur(16px);
    }
    .logo{
      width:64px;height:64px;border-radius:18px;margin:0 auto 22px;
      background:linear-gradient(135deg,#594EEA 0%,#7C5CEC 50%,#A259E6 100%);
      box-shadow:0 12px 28px rgba(124,92,236,.45),
                 inset 0 1px 0 rgba(255,255,255,.18);
      display:flex;align-items:center;justify-content:center;
      color:#fff;font:800 24px/1 ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace;
      letter-spacing:-1.5px;
    }
    h1{font-size:18px;font-weight:600;color:#f1f5f9;letter-spacing:-.01em;margin-bottom:6px;}
    p{font-size:13px;color:var(--muted);}
    .progress{
      margin:24px auto 0;width:200px;height:4px;border-radius:2px;
      background:rgba(255,255,255,.05);overflow:hidden;
    }
    .progress::after{
      content:"";display:block;width:40%;height:100%;border-radius:2px;
      background:linear-gradient(90deg,transparent,var(--primary),transparent);
      animation:slide 1.4s cubic-bezier(.4,0,.2,1) infinite;
    }
    @keyframes slide{
      0%  {transform:translateX(-100%);}
      100%{transform:translateX(350%);}
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">{}</div>
    <h1>Starting OpenCode</h1>
    <p>This will refresh automatically once the server is ready.</p>
    <div class="progress" aria-hidden="true"></div>
  </div>
</body>
</html>`;

// Guardian status page (fallback if banner injection fails or for direct visits)
function getStatusPage(req) {
  const remaining = state.deadline
    ? Math.max(0, state.deadline - Date.now())
    : null;
  const min = remaining ? Math.floor(remaining / 60000) : 0;
  const sec = remaining ? Math.ceil((remaining % 60000) / 1000) : 0;
  const ingressPath = req && req.headers["x-ingress-path"]
    ? req.headers["x-ingress-path"].replace(/\/$/, "")
    : "";
  const isPending = state.status === "pending";
  const filesList = (state.changedFiles || [])
    .map((f) => `<li><code>${f.replace(/[<>&]/g, "")}</code></li>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Config Guardian — OpenCode</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="5">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    :root{
      --surface:#0a0e1a; --surface-1:#141828; --surface-2:#1c2238;
      --primary:#a78bfa; --primary-2:#7c5cec;
      --success:#22c55e; --warning:#f59e0b; --danger:#f43f5e;
      --text:#e2e8f0; --muted:#94a3b8; --border:rgba(167,139,250,.18);
    }
    html,body{height:100%;}
    body{
      background:
        radial-gradient(1200px 600px at 80% -10%,rgba(124,92,236,.16),transparent 60%),
        radial-gradient(900px 500px at -10% 110%,rgba(89,78,234,.14),transparent 55%),
        var(--surface);
      color:var(--text);
      font:500 14px/1.5 'Inter','SF Pro Text',-apple-system,'Segoe UI',Roboto,system-ui,sans-serif;
      -webkit-font-smoothing:antialiased;
      display:flex;align-items:center;justify-content:center;padding:24px;
    }
    .wrap{width:100%;max-width:560px;}
    .header{display:flex;align-items:center;gap:14px;margin-bottom:20px;}
    .logo{
      width:48px;height:48px;border-radius:14px;flex-shrink:0;
      background:linear-gradient(135deg,#594EEA 0%,#7C5CEC 50%,#A259E6 100%);
      box-shadow:0 8px 22px rgba(124,92,236,.45),inset 0 1px 0 rgba(255,255,255,.18);
      display:flex;align-items:center;justify-content:center;color:#fff;
      font:800 19px/1 ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace;
      letter-spacing:-1.2px;
    }
    .header h1{font-size:20px;font-weight:600;color:#f1f5f9;letter-spacing:-.01em;}
    .header p{font-size:13px;color:var(--muted);}

    .card{
      background:linear-gradient(180deg,rgba(28,34,56,.72),rgba(20,24,40,.72));
      border:1px solid var(--border);border-radius:20px;
      padding:24px;
      box-shadow:0 1px 0 rgba(255,255,255,.04) inset,0 18px 48px rgba(8,10,24,.45);
      backdrop-filter:saturate(180%) blur(16px);
      -webkit-backdrop-filter:saturate(180%) blur(16px);
    }

    .badge{
      display:inline-flex;align-items:center;gap:8px;
      padding:6px 12px;border-radius:999px;font-size:12px;font-weight:600;
      letter-spacing:.02em;
    }
    .badge.idle{background:rgba(34,197,94,.12);color:#86efac;border:1px solid rgba(34,197,94,.3);}
    .badge.pending{background:rgba(245,158,11,.12);color:#fcd34d;border:1px solid rgba(245,158,11,.35);}
    .badge .dot{width:6px;height:6px;border-radius:50%;}
    .badge.idle .dot{background:#22c55e;box-shadow:0 0 8px #22c55e;}
    .badge.pending .dot{background:#f59e0b;box-shadow:0 0 8px #f59e0b;animation:blink 1.4s ease-in-out infinite;}
    @keyframes blink{50%{opacity:.3;}}

    .timer{
      font:700 56px/1 ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace;
      letter-spacing:-1px;color:var(--warning);
      font-variant-numeric:tabular-nums;margin:18px 0 6px;
    }
    .timer.urgent{color:var(--danger);}
    .timer-sub{font-size:13px;color:var(--muted);}

    .files{
      margin-top:18px;background:rgba(10,14,26,.6);
      border:1px solid rgba(255,255,255,.05);border-radius:12px;
      padding:14px 16px;
    }
    .files-label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:8px;}
    .files ul{list-style:none;display:flex;flex-direction:column;gap:4px;}
    .files code{
      font:500 12px/1.6 ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace;
      color:#cbd5e1;
    }

    .actions{display:flex;gap:10px;margin-top:22px;}
    .btn{
      flex:1;padding:12px 18px;border:0;border-radius:12px;
      font:600 14px/1 inherit;letter-spacing:.02em;cursor:pointer;
      transition:transform .12s,filter .2s,box-shadow .2s;
      display:inline-flex;align-items:center;justify-content:center;gap:8px;
    }
    .btn:hover:not(:disabled){filter:brightness(1.1);transform:translateY(-1px);}
    .btn:active:not(:disabled){transform:translateY(0);filter:brightness(.95);}
    .btn:disabled{opacity:.35;cursor:not-allowed;}
    .btn-confirm{
      background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;
      box-shadow:0 8px 22px rgba(34,197,94,.32);
    }
    .btn-revert{
      background:rgba(244,63,94,.12);color:#fb7185;
      border:1px solid rgba(244,63,94,.35);
    }
    .btn-revert:hover:not(:disabled){background:rgba(244,63,94,.22);}

    .empty{text-align:center;padding:18px 0 6px;}
    .empty-emoji{font-size:32px;margin-bottom:8px;}
    .empty h2{font-size:16px;font-weight:600;color:#f1f5f9;margin-bottom:4px;}
    .empty p{font-size:13px;color:var(--muted);}

    .footer{
      text-align:center;margin-top:18px;font-size:11px;color:#64748b;
      letter-spacing:.04em;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="logo">{}</div>
      <div>
        <h1>Config Guardian</h1>
        <p>Safety net for OpenCode edits to your Home Assistant config.</p>
      </div>
    </div>

    <div class="card">
      <span class="badge ${isPending ? "pending" : "idle"}">
        <span class="dot"></span>
        ${isPending ? "Changes pending" : "All clear"}
      </span>

      ${
        isPending
          ? `<div class="timer ${remaining < 120000 ? "urgent" : ""}">${min}:${String(sec).padStart(2, "0")}</div>
             <div class="timer-sub">until automatic revert</div>
             ${
               filesList
                 ? `<div class="files">
                      <div class="files-label">Files changed</div>
                      <ul>${filesList}</ul>
                    </div>`
                 : ""
             }
             <div class="actions">
               <form method="POST" action="${ingressPath}/__guardian__/api/confirm" style="flex:1">
                 <button class="btn btn-confirm" type="submit">Confirm changes</button>
               </form>
               <form method="POST" action="${ingressPath}/__guardian__/api/revert" style="flex:1">
                 <button class="btn btn-revert" type="submit">Revert</button>
               </form>
             </div>`
          : `<div class="empty">
               <div class="empty-emoji">✨</div>
               <h2>No pending changes</h2>
               <p>Your config is in a known-good state. Edits in OpenCode will appear here for confirmation.</p>
             </div>`
      }
    </div>

    <div class="footer">Auto-refreshes every 5 seconds</div>
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
    res.end(getStatusPage(req));
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
