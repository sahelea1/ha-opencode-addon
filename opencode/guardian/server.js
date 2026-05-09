/**
 * ha-opencode-addon — Guardian Server
 *
 * Boots OpenCode (`opencode serve`) on a private port, proxies the
 * web UI through HA's ingress on 8099, and watches /config for
 * unconfirmed edits with a 10-minute auto-revert safety net.
 *
 * Flow:
 *   1. On startup: rsync /config -> /data/last-known-good (baseline).
 *   2. Poll /config every 5s, hash the relevant files.
 *   3. When the hash changes: open a 10-min confirm window.
 *   4. If the user clicks "Confirm": baseline = current state.
 *   5. If the timer expires (or the container crash-recovers in
 *      pending state): rsync the baseline BACK into /config,
 *      then ask HA Supervisor to reload.
 *
 * The restore step deliberately runs WITHOUT --delete and with a
 * sane-backup precondition, because v1.7's restore wiped /config
 * when the backup was empty/partial. Files added after the baseline
 * are left for the user to review, never silently deleted.
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
const OPENCODE_PORT = 8100; // OpenCode binds here on 127.0.0.1
const GUARDIAN_PORT = 8099; // HA ingress hits this
const CONFIG_DIR = "/config";
const DATA_DIR = "/data";
const BACKUP_DIR = path.join(DATA_DIR, "last-known-good");
const STATE_FILE = path.join(DATA_DIR, "guardian-state.json");
const POLL_INTERVAL_MS = 5000;

const TIMEOUT_MS =
  (parseInt(process.env.GUARDIAN_TIMEOUT_MIN, 10) || 10) * 60 * 1000;

// HA-managed paths we never back up or hash. Most are dynamic state
// (DB, secrets, .storage); .HA_VERSION changes on every HA upgrade.
const EXCLUDES = [
  "home-assistant_v2.db",
  "home-assistant_v2.db-shm",
  "home-assistant_v2.db-wal",
  ".storage",
  ".cloud",
  "deps",
  "__pycache__",
  "tts",
  ".HA_VERSION",
];
const RSYNC_EXCLUDES = EXCLUDES.map((e) => `--exclude=${e}`).join(" ");

const CLIENT_SCRIPT = fs.readFileSync(
  path.join(__dirname, "client.js"),
  "utf8"
);

// ---------------------------------------------------------------------------
// State (persisted to disk so we survive container restarts)
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
      Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
    }
  } catch (e) {
    console.error("[guardian] Failed to load state:", e.message);
  }
}

function saveState() {
  try {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error("[guardian] Failed to save state:", e.message);
  }
}

// ---------------------------------------------------------------------------
// Change detection — md5 over the YAML/JSON/PY/CONF/JS files in /config.
// We don't hash the whole tree because the HA DB constantly changes.
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
// Backup + restore
// ---------------------------------------------------------------------------
function countFiles(dir) {
  try {
    return parseInt(
      execSync(
        `find ${dir} -mindepth 1 -maxdepth 6 -type f 2>/dev/null | wc -l`,
        { encoding: "utf8", timeout: 10000 }
      ).trim(),
      10
    ) || 0;
  } catch {
    return 0;
  }
}

// Sanity check: never restore from an empty / non-HA-looking dir.
// Without this, a partial first-boot snapshot + --delete combo
// would wipe the user's real /config.
function backupLooksSane() {
  if (!fs.existsSync(BACKUP_DIR)) return false;
  if (countFiles(BACKUP_DIR) < 5) {
    console.error(
      `[guardian] Backup at ${BACKUP_DIR} has fewer than 5 files — refusing to restore.`
    );
    return false;
  }
  const hasSentinel = ["configuration.yaml", "configuration.yml"].some((s) =>
    fs.existsSync(path.join(BACKUP_DIR, s))
  );
  if (!hasSentinel) {
    console.error(
      `[guardian] Backup at ${BACKUP_DIR} has no configuration.yaml — refusing to restore.`
    );
    return false;
  }
  return true;
}

function createBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    // --delete here is safe because it operates on /data/last-known-good,
    // never on /config.
    execSync(
      `rsync -a --delete ${RSYNC_EXCLUDES} ${CONFIG_DIR}/ ${BACKUP_DIR}/`,
      { timeout: 120000 }
    );
    console.log(
      `[guardian] Backup created at ${BACKUP_DIR} (${countFiles(BACKUP_DIR)} files)`
    );
  } catch (e) {
    console.error("[guardian] Backup failed:", e.message);
  }
}

function restoreBackup() {
  if (!backupLooksSane()) {
    console.error(
      "[guardian] Aborting restore: backup is missing/empty/doesn't look like an HA config."
    );
    return false;
  }
  try {
    // No --delete: copy baseline files BACK into /config. Modified
    // files revert, deleted files come back. Files OpenCode created
    // that weren't in the baseline stay on disk for the user to
    // review or remove themselves — much safer than nuking /config.
    execSync(
      `rsync -a ${RSYNC_EXCLUDES} ${BACKUP_DIR}/ ${CONFIG_DIR}/`,
      { timeout: 120000 }
    );
    console.log("[guardian] Config files restored from backup (non-destructive)");
    return true;
  } catch (e) {
    console.error("[guardian] Restore failed:", e.message);
    return false;
  }
}

function getChangedFiles() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    const output = execSync(
      `rsync -n -a --delete ${RSYNC_EXCLUDES} --out-format='%n' ${CONFIG_DIR}/ ${BACKUP_DIR}/ 2>/dev/null | head -30 || true`,
      { encoding: "utf8", timeout: 10000 }
    );
    return output
      .split("\n")
      .filter((l) => l.trim() && !l.endsWith("/"))
      .map((f) => f.trim());
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// HA Supervisor API
// ---------------------------------------------------------------------------
function supervisorRequest(p, method, callback) {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) {
    console.log("[guardian] No SUPERVISOR_TOKEN, skipping API call:", p);
    if (callback) callback(false);
    return;
  }
  const req = http.request(
    {
      hostname: "supervisor",
      port: 80,
      path: p,
      method: method || "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    },
    (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        console.log(`[guardian] Supervisor ${p}: ${res.statusCode}`);
        if (callback)
          callback(res.statusCode >= 200 && res.statusCode < 300, data);
      });
    }
  );
  req.on("error", (e) => {
    console.error(`[guardian] Supervisor API error (${p}):`, e.message);
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
// Confirm / revert
// ---------------------------------------------------------------------------
function confirmChanges() {
  console.log("[guardian] User confirmed changes");
  createBackup(); // new baseline
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
  return { ok: false, message: "Restore failed — backup unavailable." };
}

// ---------------------------------------------------------------------------
// Crash recovery — if the container died with status=pending, revert.
// ---------------------------------------------------------------------------
function crashRecovery() {
  loadState();
  if (state.status === "pending") {
    console.log("======================================================");
    console.log("  CRASH RECOVERY: pending changes found — reverting!");
    console.log("======================================================");
    if (fs.existsSync(BACKUP_DIR)) {
      restoreBackup();
      setTimeout(() => reloadHA(), 5000);
    }
    state.status = "idle";
    state.deadline = null;
    state.changedFiles = [];
    saveState();
  }
}

// ---------------------------------------------------------------------------
// File watcher
// ---------------------------------------------------------------------------
function startWatcher() {
  state.lastHash = getConfigHash();
  console.log(
    `[guardian] Watcher started (polling every ${POLL_INTERVAL_MS / 1000}s)`
  );

  setInterval(() => {
    try {
      const currentHash = getConfigHash();
      if (!currentHash) return;

      if (state.status === "idle") {
        if (currentHash !== state.lastHash) {
          console.log("[guardian] Config changes detected — opening confirm window");
          state.status = "pending";
          state.deadline = Date.now() + TIMEOUT_MS;
          state.changedFiles = getChangedFiles();
          saveState();
        }
      } else if (state.status === "pending") {
        state.changedFiles = getChangedFiles();
        if (Date.now() > state.deadline) {
          console.log("[guardian] TIMEOUT — auto-reverting");
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
// OpenCode process manager
// ---------------------------------------------------------------------------
let opencodeProcess = null;
let opencodeReady = false;

function startOpenCode() {
  console.log(
    `[guardian] Starting \`opencode serve\` for ${CONFIG_DIR} on 127.0.0.1:${OPENCODE_PORT}`
  );

  // `serve` (not `web`) — `web` tries to launch a desktop browser
  // via xdg-open on startup, which is meaningless inside the
  // container and previously left the SPA half-initialized.
  opencodeProcess = spawn(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", String(OPENCODE_PORT)],
    {
      cwd: CONFIG_DIR, // project root = HA /config
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
      `[guardian] OpenCode exited (code=${code}, signal=${signal}), restarting in 5s`
    );
    setTimeout(startOpenCode, 5000);
  });

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
        res.resume();
      }
    );
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
  }, 2000);
}

// ---------------------------------------------------------------------------
// HTTP proxy — forwards to OpenCode, injects guardian banner into HTML,
// and rewrites paths so the SPA loads correctly behind HA ingress.
//
// HA proxies the add-on under a path prefix like
//   /api/hassio_ingress/<TOKEN>/
// but strips that prefix before forwarding. The browser still uses
// the full HA URL, so absolute paths in OpenCode's HTML
// (src="/assets/app.js") resolve against HA's root and 404. Three
// layers fix it:
//   1. Inject <base href="<prefix>/"> so RELATIVE paths resolve.
//   2. Regex over the HTML to prefix absolute src/href/action.
//   3. Runtime patcher wraps fetch / XHR / WebSocket.
// ---------------------------------------------------------------------------
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${OPENCODE_PORT}`,
  selfHandleResponse: true,
  ws: true,
});

proxy.on("proxyReq", (proxyReq, req) => {
  proxyReq.removeHeader("accept-encoding");
  const ip = req.headers["x-ingress-path"];
  if (ip) proxyReq.setHeader("x-ingress-path", ip);
});

proxy.on("proxyRes", (proxyRes, req, res) => {
  const contentType = proxyRes.headers["content-type"] || "";

  if (contentType.includes("text/html")) {
    const chunks = [];
    proxyRes.on("data", (c) => chunks.push(c));
    proxyRes.on("end", () => {
      let body = Buffer.concat(chunks).toString("utf8");
      const ingressPath = (req.headers["x-ingress-path"] || "").replace(/\/$/, "");

      // Layer 2: rewrite absolute attribute paths in the HTML.
      if (ingressPath) {
        body = body.replace(
          /((?:src|href|action|data-src)=["'])(\/(?!\/))/g,
          `$1${ingressPath}/`
        );
      }

      // Layer 1 + 3: <base> + runtime patcher + guardian banner.
      const baseHref = ingressPath ? `${ingressPath}/` : "/";
      const injection = `<base href="${baseHref}">
<script>
window.__GUARDIAN_BASE_PATH = ${JSON.stringify(ingressPath)};
(function () {
  var _ip = ${JSON.stringify(ingressPath)};
  if (!_ip) return;
  var _origin = window.location.origin;
  var _wsHost = window.location.host;

  // Returns the rewritten URL string if rewriting is needed, else null.
  // Handles: relative paths, root-absolute paths, and same-origin absolute URLs.
  function rewriteHttpUrl(input) {
    if (typeof input !== "string") return null;
    try {
      // Fast path: root-absolute path that doesn't already have the prefix.
      if (input.charAt(0) === "/" && input.charAt(1) !== "/") {
        if (input.slice(0, _ip.length) !== _ip) return _ip + input;
        return null;
      }
      // Otherwise: try to parse as URL (relative or absolute).
      var u = new URL(input, _origin);
      if (u.origin === _origin && u.pathname.slice(0, _ip.length) !== _ip) {
        u.pathname = _ip + u.pathname;
        return u.toString();
      }
    } catch (e) {}
    return null;
  }

  function rewriteWsUrl(input) {
    if (typeof input !== "string") return null;
    try {
      var u = new URL(input);
      if (u.host === _wsHost && u.pathname.slice(0, _ip.length) !== _ip) {
        u.pathname = _ip + u.pathname;
        return u.toString();
      }
    } catch (e) {}
    return null;
  }

  // ---- fetch ---------------------------------------------------------------
  var _fetch = window.fetch;
  window.fetch = function (resource, init) {
    try {
      // Request object: rebuild with rewritten URL.
      if (typeof Request !== "undefined" && resource instanceof Request) {
        var newUrl = rewriteHttpUrl(resource.url);
        if (newUrl) {
          var hasBody = resource.method !== "GET" && resource.method !== "HEAD";
          var initFromReq = {
            method: resource.method,
            headers: resource.headers,
            mode: resource.mode === "navigate" ? "same-origin" : resource.mode,
            credentials: resource.credentials,
            cache: resource.cache,
            redirect: resource.redirect,
            referrer: resource.referrer,
            integrity: resource.integrity,
            keepalive: resource.keepalive,
            signal: resource.signal,
          };
          if (hasBody) {
            // Materialize body to ArrayBuffer to avoid streaming-body pitfalls.
            return resource.clone().arrayBuffer().then(function (buf) {
              if (buf && buf.byteLength > 0) initFromReq.body = buf;
              if (init) Object.assign(initFromReq, init);
              return _fetch.call(window, newUrl, initFromReq);
            });
          }
          if (init) Object.assign(initFromReq, init);
          return _fetch.call(this, newUrl, initFromReq);
        }
        return _fetch.call(this, resource, init);
      }

      // String URL.
      if (typeof resource === "string") {
        var s = rewriteHttpUrl(resource);
        if (s !== null) resource = s;
        return _fetch.call(this, resource, init);
      }

      // URL object.
      if (resource && typeof resource.href === "string") {
        var s2 = rewriteHttpUrl(resource.href);
        if (s2 !== null) return _fetch.call(this, s2, init);
      }
    } catch (e) {}
    return _fetch.call(this, resource, init);
  };

  // ---- XMLHttpRequest ------------------------------------------------------
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (typeof url === "string") {
      var s = rewriteHttpUrl(url);
      if (s !== null) arguments[1] = s;
    } else if (url && typeof url.href === "string") {
      var s2 = rewriteHttpUrl(url.href);
      if (s2 !== null) arguments[1] = s2;
    }
    return _open.apply(this, arguments);
  };

  // ---- WebSocket -----------------------------------------------------------
  var _WS = window.WebSocket;
  function PatchedWS(url, protocols) {
    if (typeof url === "string") {
      var s = rewriteWsUrl(url);
      if (s !== null) url = s;
    } else if (url && typeof url.href === "string") {
      var s2 = rewriteWsUrl(url.href);
      if (s2 !== null) url = s2;
    }
    return protocols !== undefined ? new _WS(url, protocols) : new _WS(url);
  }
  PatchedWS.prototype = _WS.prototype;
  PatchedWS.CONNECTING = _WS.CONNECTING;
  PatchedWS.OPEN       = _WS.OPEN;
  PatchedWS.CLOSING    = _WS.CLOSING;
  PatchedWS.CLOSED     = _WS.CLOSED;
  window.WebSocket = PatchedWS;

  // ---- EventSource (defensive) --------------------------------------------
  if (typeof window.EventSource === "function") {
    var _ES = window.EventSource;
    function PatchedES(url, init) {
      if (typeof url === "string") {
        var s = rewriteHttpUrl(url);
        if (s !== null) url = s;
      } else if (url && typeof url.href === "string") {
        var s2 = rewriteHttpUrl(url.href);
        if (s2 !== null) url = s2;
      }
      return init !== undefined ? new _ES(url, init) : new _ES(url);
    }
    PatchedES.prototype  = _ES.prototype;
    PatchedES.CONNECTING = _ES.CONNECTING;
    PatchedES.OPEN       = _ES.OPEN;
    PatchedES.CLOSED     = _ES.CLOSED;
    window.EventSource = PatchedES;
  }

  // ---- navigator.sendBeacon (defensive) -----------------------------------
  if (navigator && typeof navigator.sendBeacon === "function") {
    var _sb = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (typeof url === "string") {
        var s = rewriteHttpUrl(url);
        if (s !== null) url = s;
      } else if (url && typeof url.href === "string") {
        var s2 = rewriteHttpUrl(url.href);
        if (s2 !== null) url = s2;
      }
      return _sb(url, data);
    };
  }
})();
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
      delete headers["x-frame-options"]; // allow embedding in HA iframe

      res.writeHead(proxyRes.statusCode, headers);
      res.end(body);
    });
  } else {
    // Non-HTML: stream straight through (preserves SSE / chunked).
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

// ---------------------------------------------------------------------------
// Loading + status pages
// ---------------------------------------------------------------------------
const LOADING_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ha-opencode-addon — Starting</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="3">
  <style>
    body { background:#0d1117; color:#c9d1d9; font-family:system-ui,sans-serif;
      margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; }
    .card { text-align:center; }
    .spinner { width:40px; height:40px; margin:0 auto 18px; border-radius:50%;
      border:3px solid #21262d; border-top-color:#58a6ff; animation:spin 0.8s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    h1 { font-size:18px; font-weight:500; margin:0 0 6px; }
    p  { font-size:13px; color:#8b949e; margin:0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>ha-opencode-addon is starting…</h1>
    <p>This page refreshes automatically.</p>
  </div>
</body>
</html>`;

function getStatusPage(req) {
  const remaining = state.deadline ? Math.max(0, state.deadline - Date.now()) : null;
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
<html><head><meta charset="utf-8">
<title>Config Guardian</title>
<meta http-equiv="refresh" content="5">
<style>
  body { background:#0d1117; color:#c9d1d9; font-family:system-ui,sans-serif; padding:32px; }
  h1 { color:#58a6ff; font-size:20px; margin:0 0 16px; }
  .card { background:#161b22; border:1px solid #30363d; border-left-width:4px;
    border-radius:8px; padding:18px; margin-bottom:14px; }
  .idle    { border-left-color:#3fb950; }
  .pending { border-left-color:#d29922; }
  .timer   { font-size:32px; font-weight:700; color:#d29922; margin:8px 0; }
  ul { list-style:none; padding:0; margin:8px 0 0; font-size:12px; color:#8b949e; }
  .actions { display:flex; gap:10px; }
  button { padding:8px 18px; border:0; border-radius:6px; font-weight:600;
    cursor:pointer; font-family:inherit; }
  .confirm { background:#238636; color:#fff; }
  .revert  { background:#da3633; color:#fff; }
</style></head>
<body>
  <h1>Config Guardian</h1>
  <div class="card ${isPending ? "pending" : "idle"}">
    <strong>${isPending ? "Changes pending" : "All clear"}</strong>
    ${isPending ? `<div class="timer">${min}:${String(sec).padStart(2, "0")}</div>
      ${filesList ? `<ul>${filesList}</ul>` : ""}
      <div class="actions">
        <form method="POST" action="${ingressPath}/__guardian__/api/confirm">
          <button class="confirm">Confirm changes</button>
        </form>
        <form method="POST" action="${ingressPath}/__guardian__/api/revert">
          <button class="revert">Revert</button>
        </form>
      </div>` : ""}
  </div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Main HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;

  if (pathname === "/__guardian__/api/status") {
    const remaining = state.deadline ? Math.max(0, state.deadline - Date.now()) : null;
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({
      status: state.status,
      remainingMs: remaining,
      changedFiles: state.changedFiles,
      timeoutMinutes: TIMEOUT_MS / 60000,
    }));
    return;
  }

  if (pathname === "/__guardian__/api/confirm" && req.method === "POST") {
    const result = state.status === "pending"
      ? confirmChanges()
      : { ok: false, message: "No pending changes to confirm." };
    if ((req.headers.accept || "").includes("text/html")) {
      res.writeHead(303, { Location: "/__guardian__/" });
      res.end();
    } else {
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }
    return;
  }

  if (pathname === "/__guardian__/api/revert" && req.method === "POST") {
    const result = state.status === "pending"
      ? revertChanges()
      : { ok: false, message: "No pending changes to revert." };
    if ((req.headers.accept || "").includes("text/html")) {
      res.writeHead(303, { Location: "/__guardian__/" });
      res.end();
    } else {
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }
    return;
  }

  if (pathname === "/__guardian__/" || pathname === "/__guardian__") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getStatusPage(req));
    return;
  }

  if (!opencodeReady) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    res.end(LOADING_PAGE);
    return;
  }

  proxy.web(req, res);
});

server.on("upgrade", (req, socket, head) => {
  if (!opencodeReady) {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head);
});

// ---------------------------------------------------------------------------
// Boot
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
  console.log(`[guardian] Listening on 0.0.0.0:${GUARDIAN_PORT}`);
  console.log(`[guardian] Confirm timeout: ${TIMEOUT_MS / 60000} minutes`);
});

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
