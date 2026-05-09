/**
 * ha-opencode-addon — Guardian Server (v1.15, workspace mode)
 *
 * OpenCode now edits a sandboxed copy at /data/workspace, not /config
 * directly. This solves two real problems:
 *
 *   1. OpenCode's project detection requires a `.git` directory. The
 *      HA-managed /config typically has none, so opencode fell back
 *      to a "global pseudo-project" and the SPA came up blank.
 *      /data/workspace is git-init'd at boot, so opencode treats it
 *      as a real project and the file tree / VCS panels populate.
 *   2. Edits never touch /config silently. The user must click
 *      `Apply`, which is the moment guardian's existing safety net
 *      (backup + timed auto-revert + HA reload) kicks in.
 *
 * Two-stage flow:
 *
 *   workspace clean ──(user edits)──> workspace dirty
 *      │                                  │
 *      │                                  ▼
 *      │                           [Apply] [Discard]
 *      │                                  │
 *      │             ┌────────────────────┘
 *      ▼             ▼
 *   /config clean   /config pending  ──[timeout]──>  auto-revert
 *      ▲             │
 *      │             ▼
 *      └──────────[Confirm]
 *
 * Endpoints (all under /__guardian__/api/):
 *   GET  /status        — full state JSON
 *   POST /apply         — workspace -> /config (enters pending)
 *   POST /discard       — /config -> workspace (drop opencode edits)
 *   POST /pull          — /config -> workspace (refresh from HA-side edits)
 *   POST /confirm       — /config (pending) -> baseline
 *   POST /revert        — baseline -> /config (and -> workspace)
 */

const http = require("http");
const httpProxy = require("http-proxy");
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const OPENCODE_PORT = 8100;
const GUARDIAN_PORT = 8099;
const CONFIG_DIR    = process.env.HA_CONFIG_DIR  || "/config";
const WORKSPACE_DIR = process.env.WORKSPACE_DIR  || "/data/workspace";
const DATA_DIR      = "/data";
const BACKUP_DIR    = path.join(DATA_DIR, "last-known-good");
const STATE_FILE    = path.join(DATA_DIR, "guardian-state.json");
const POLL_INTERVAL_MS = 5000;

const TIMEOUT_MS =
  (parseInt(process.env.GUARDIAN_TIMEOUT_MIN, 10) || 10) * 60 * 1000;

// HA-managed paths we never sync, hash, or back up. Most are dynamic
// state (DB, secrets, .storage); .HA_VERSION changes on every HA upgrade.
// .git is excluded so the workspace's local commit history doesn't
// leak into /config and vice versa.
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
  ".git",
];
const RSYNC_EXCLUDES = EXCLUDES.map((e) => `--exclude=${e}`).join(" ");

const CLIENT_SCRIPT = fs.readFileSync(
  path.join(__dirname, "client.js"),
  "utf8"
);

// ---------------------------------------------------------------------------
// State (persisted to disk so we survive container restarts)
// ---------------------------------------------------------------------------
const MAX_CHANGED_FILES_SHOWN = 200;

let state = {
  status: "idle",          // "idle" | "pending" — refers to /config vs baseline
  deadline: null,
};

let liveStats = {
  workspaceDirty: false,
  workspaceChangedFiles: [],
  configDirtyVsBackup: false,
  configChangedFiles: [],
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

function resetStateToIdle() {
  state.status = "idle";
  state.deadline = null;
  saveState();
}

function diffDirs(src, dst) {
  try {
    const out = execSync(
      `rsync -n -a --delete ${RSYNC_EXCLUDES} --out-format='%n' ${src}/ ${dst}/ 2>/dev/null || true`,
      { encoding: "utf8", timeout: 15000 }
    );
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.endsWith("/"))
      .slice(0, MAX_CHANGED_FILES_SHOWN);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sync primitives
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

// Refuse to sync FROM a source that obviously isn't a real HA
// config tree. Without this, an empty / partially-mounted source
// + --delete would wipe the destination.
function sourceLooksSane(src) {
  if (countFiles(src) < 3) {
    console.error(`[guardian] Refusing sync from ${src}: < 3 files`);
    return false;
  }
  const hasSentinel = ["configuration.yaml", "configuration.yml"].some((s) =>
    fs.existsSync(path.join(src, s))
  );
  if (!hasSentinel) {
    console.error(`[guardian] Refusing sync from ${src}: no configuration.yaml`);
    return false;
  }
  return true;
}

function syncDirs(src, dst, withDelete) {
  fs.mkdirSync(dst, { recursive: true });
  const flags = withDelete ? "-a --delete" : "-a";
  execSync(`rsync ${flags} ${RSYNC_EXCLUDES} ${src}/ ${dst}/`, {
    timeout: 180000,
  });
}

function gitCommitWorkspace(message) {
  try {
    execSync(
      `git -C ${WORKSPACE_DIR} add -A && git -C ${WORKSPACE_DIR} -c commit.gpgsign=false commit -q --allow-empty -m ${JSON.stringify(message)}`,
      { timeout: 30000 }
    );
  } catch {}
}

// ---------------------------------------------------------------------------
// Backup + restore (the /config <-> /data/last-known-good safety net)
// ---------------------------------------------------------------------------
function createBackup() {
  if (!sourceLooksSane(CONFIG_DIR)) {
    console.error("[guardian] Skipping backup: /config doesn't look sane.");
    return false;
  }
  try {
    syncDirs(CONFIG_DIR, BACKUP_DIR, /*withDelete=*/ true);
    console.log(
      `[guardian] Backup created at ${BACKUP_DIR} (${countFiles(BACKUP_DIR)} files)`
    );
    return true;
  } catch (e) {
    console.error("[guardian] Backup failed:", e.message);
    return false;
  }
}

function restoreBackup() {
  if (!sourceLooksSane(BACKUP_DIR)) {
    console.error(
      "[guardian] Aborting restore: backup is missing/empty/not HA-shaped."
    );
    return false;
  }
  try {
    // No --delete: files OpenCode created stay on disk so the user
    // can review them. Modified files revert; deleted files come back.
    syncDirs(BACKUP_DIR, CONFIG_DIR, /*withDelete=*/ false);
    console.log("[guardian] /config restored from backup (non-destructive)");
    return true;
  } catch (e) {
    console.error("[guardian] Restore failed:", e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Workspace operations (the new /data/workspace <-> /config layer)
// ---------------------------------------------------------------------------
function applyWorkspaceToConfig() {
  if (!sourceLooksSane(WORKSPACE_DIR)) {
    return { ok: false, message: "Workspace is empty or invalid." };
  }
  try {
    // Snapshot pre-apply /config so Revert restores HA's known-good
    // state, not the just-applied broken one.
    if (!createBackup()) {
      return { ok: false, message: "Failed to create pre-apply backup." };
    }
    syncDirs(WORKSPACE_DIR, CONFIG_DIR, /*withDelete=*/ true);

    state.status = "pending";
    state.deadline = Date.now() + TIMEOUT_MS;
    saveState();

    // If reload fails the timer still protects the user.
    reloadHA();
    console.log("[guardian] Applied workspace -> /config; reload requested");
    return { ok: true, message: "Applied. Confirm or revert before timeout." };
  } catch (e) {
    console.error("[guardian] Apply failed:", e.message);
    return { ok: false, message: "Apply failed: " + e.message };
  }
}

function syncConfigToWorkspace(verb) {
  if (!sourceLooksSane(CONFIG_DIR)) {
    return { ok: false, message: "/config doesn't look sane." };
  }
  try {
    syncDirs(CONFIG_DIR, WORKSPACE_DIR, /*withDelete=*/ true);
    // Commit so the SPA's diff view shows a clean state.
    gitCommitWorkspace(`${verb} from /config`);
    console.log(`[guardian] ${verb}: /config -> workspace`);
    return { ok: true, message: `Workspace ${verb.toLowerCase()}ed from /config.` };
  } catch (e) {
    console.error(`[guardian] ${verb} failed:`, e.message);
    return { ok: false, message: `${verb} failed: ` + e.message };
  }
}

// Discard and Pull are the same operation with different intent:
// discard = "throw away my edits"; pull = "fetch HA-side updates".
const pullConfigToWorkspace = () => syncConfigToWorkspace("Pull");
const discardWorkspace      = () => syncConfigToWorkspace("Discard");

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
// Confirm / revert (the /config-vs-baseline safety net)
// ---------------------------------------------------------------------------
function confirmChanges() {
  console.log("[guardian] User confirmed changes");
  createBackup();
  resetStateToIdle();
  return { ok: true, message: "Changes confirmed. New baseline saved." };
}

function revertChanges() {
  console.log("[guardian] Reverting changes...");
  const restored = restoreBackup();
  if (restored) {
    // Sync workspace back to baseline so the SPA's view doesn't
    // diverge from /config after revert.
    try {
      syncDirs(BACKUP_DIR, WORKSPACE_DIR, /*withDelete=*/ true);
    } catch (e) {
      console.error("[guardian] Workspace re-sync after revert failed:", e.message);
    }
  }
  resetStateToIdle();
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
    if (restoreBackup()) reloadHA();
    resetStateToIdle();
  }
}

// ---------------------------------------------------------------------------
// Watcher — refresh dirty-state stats and enforce the pending timeout.
// ---------------------------------------------------------------------------
function startWatcher() {
  console.log(
    `[guardian] Watcher started (polling every ${POLL_INTERVAL_MS / 1000}s)`
  );

  setInterval(() => {
    try {
      liveStats.workspaceChangedFiles = diffDirs(WORKSPACE_DIR, CONFIG_DIR);
      liveStats.workspaceDirty = liveStats.workspaceChangedFiles.length > 0;
      liveStats.configChangedFiles = diffDirs(CONFIG_DIR, BACKUP_DIR);
      liveStats.configDirtyVsBackup = liveStats.configChangedFiles.length > 0;

      if (state.status === "pending" && Date.now() > state.deadline) {
        console.log("[guardian] TIMEOUT — auto-reverting");
        revertChanges();
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
    `[guardian] Starting \`opencode serve\` cwd=${WORKSPACE_DIR} on 127.0.0.1:${OPENCODE_PORT}`
  );

  // `serve` (not `web`) — `web` tries to launch a desktop browser
  // via xdg-open on startup, which is meaningless inside the
  // container and previously left the SPA half-initialized.
  opencodeProcess = spawn(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", String(OPENCODE_PORT)],
    {
      cwd: WORKSPACE_DIR,
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

  startReadyCheck();
}

function ensureStarterSession() {
  // On a fresh install the SPA's session list is empty and the user
  // lands on a blank screen. Pre-create a session so they can start
  // chatting immediately. Idempotent: only fires when GET /session
  // returns [].
  const get = http.get(
    `http://127.0.0.1:${OPENCODE_PORT}/session`,
    { timeout: 3000 },
    (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let arr;
        try { arr = JSON.parse(buf); } catch (e) { return; }
        if (!Array.isArray(arr) || arr.length > 0) return;
        const post = http.request(
          {
            hostname: "127.0.0.1",
            port: OPENCODE_PORT,
            path: "/session",
            method: "POST",
            headers: { "content-type": "application/json", "content-length": 2 },
            timeout: 5000,
          },
          (r) => {
            r.resume();
            if (r.statusCode >= 200 && r.statusCode < 300) {
              console.log("[guardian] Created starter session");
            } else {
              console.log("[guardian] Starter session POST returned " + r.statusCode);
            }
          }
        );
        post.on("error", (e) =>
          console.error("[guardian] Starter session error:", e.message)
        );
        post.write("{}");
        post.end();
      });
    }
  );
  get.on("error", () => {});
  get.on("timeout", () => get.destroy());
}

function startReadyCheck() {
  const handle = setInterval(() => {
    const req = http.get(
      `http://127.0.0.1:${OPENCODE_PORT}/`,
      { timeout: 2000 },
      (res) => {
        if (res.statusCode < 500) {
          opencodeReady = true;
          console.log("[guardian] OpenCode is ready");
          clearInterval(handle);
          ensureStarterSession();
        }
        res.resume();
      }
    );
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
  }, 2000);
  return handle;
}

// ---------------------------------------------------------------------------
// Loading page — shown to clients while opencode is still booting and
// returned from the proxy error handler too, so it must be defined
// before the proxy handlers reference it.
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

      if (ingressPath) {
        body = body.replace(
          /((?:src|href|action|data-src)=["'])(\/(?!\/))/g,
          `$1${ingressPath}/`
        );
      }

      const baseHref = ingressPath ? `${ingressPath}/` : "/";
      const injection = `<base href="${baseHref}">
<script>
window.__GUARDIAN_BASE_PATH = ${JSON.stringify(ingressPath)};

// Layout pre-seed: the SPA's stored default sets the file-tree panel to
// closed and the "changes" tab. Override once per browser so first load
// shows the full file tree on the "all" tab.
(function () {
  try {
    if (localStorage.getItem("__guardian_seeded_v2")) return;
    var KEY = "opencode.global.dat:layout";
    var current = null;
    try { current = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) {}
    var needsFix =
      !current ||
      !current.fileTree ||
      current.fileTree.opened === false ||
      current.fileTree.tab === "changes";
    if (needsFix) {
      var merged = current && typeof current === "object" ? current : {};
      merged.fileTree = Object.assign({ width: 280 }, merged.fileTree || {}, {
        opened: true,
        tab: "all",
      });
      if (!merged.sidebar) merged.sidebar = { opened: true };
      localStorage.setItem(KEY, JSON.stringify(merged));
    }
    localStorage.setItem("__guardian_seeded_v2", "1");
  } catch (e) {}
})();

(function () {
  var _ip = ${JSON.stringify(ingressPath)};
  if (!_ip) return;
  var _origin = window.location.origin;
  var _wsHost = window.location.host;

  function rewriteHttpUrl(input) {
    if (typeof input !== "string") return null;
    try {
      if (input.charAt(0) === "/" && input.charAt(1) !== "/") {
        if (input.slice(0, _ip.length) !== _ip) return _ip + input;
        return null;
      }
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

  var _fetch = window.fetch;
  window.fetch = function (resource, init) {
    try {
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

      if (typeof resource === "string") {
        var s = rewriteHttpUrl(resource);
        if (s !== null) resource = s;
        return _fetch.call(this, resource, init);
      }

      if (resource && typeof resource.href === "string") {
        var s2 = rewriteHttpUrl(resource.href);
        if (s2 !== null) return _fetch.call(this, s2, init);
      }
    } catch (e) {}
    return _fetch.call(this, resource, init);
  };

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
      delete headers["x-frame-options"];

      res.writeHead(proxyRes.statusCode, headers);
      res.end(body);
    });
  } else {
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
// Status page (server-rendered fallback for the floating banner)
// ---------------------------------------------------------------------------
function getStatusPage(req) {
  const remaining = state.deadline ? Math.max(0, state.deadline - Date.now()) : null;
  const min = remaining ? Math.floor(remaining / 60000) : 0;
  const sec = remaining ? Math.ceil((remaining % 60000) / 1000) : 0;
  const ingressPath = req && req.headers["x-ingress-path"]
    ? req.headers["x-ingress-path"].replace(/\/$/, "")
    : "";
  const isPending = state.status === "pending";
  const isWorkspaceDirty = liveStats.workspaceDirty && !isPending;

  const fileLi = (files) =>
    (files || []).map((f) => `<li><code>${f.replace(/[<>&]/g, "")}</code></li>`).join("");

  let cardClass = "idle";
  let title = "All clear";
  let body = "";
  if (isPending) {
    cardClass = "pending";
    title = "Changes applied — pending HA validation";
    body = `<div class="timer">${min}:${String(sec).padStart(2, "0")}</div>
      ${liveStats.configChangedFiles.length ? `<ul>${fileLi(liveStats.configChangedFiles)}</ul>` : ""}
      <div class="actions">
        <form method="POST" action="${ingressPath}/__guardian__/api/confirm">
          <button class="confirm">Confirm</button>
        </form>
        <form method="POST" action="${ingressPath}/__guardian__/api/revert">
          <button class="revert">Revert</button>
        </form>
      </div>`;
  } else if (isWorkspaceDirty) {
    cardClass = "workspace";
    title = "Workspace changes ready to apply";
    body = `${liveStats.workspaceChangedFiles.length ? `<ul>${fileLi(liveStats.workspaceChangedFiles)}</ul>` : ""}
      <div class="actions">
        <form method="POST" action="${ingressPath}/__guardian__/api/apply">
          <button class="confirm">Apply to /config</button>
        </form>
        <form method="POST" action="${ingressPath}/__guardian__/api/discard">
          <button class="revert">Discard</button>
        </form>
      </div>`;
  } else {
    body = `<div class="actions">
        <form method="POST" action="${ingressPath}/__guardian__/api/pull">
          <button class="confirm">Pull from /config</button>
        </form>
      </div>`;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>Config Guardian</title>
<meta http-equiv="refresh" content="5">
<style>
  body { background:#0d1117; color:#c9d1d9; font-family:system-ui,sans-serif; padding:32px; }
  h1 { color:#58a6ff; font-size:20px; margin:0 0 16px; }
  .card { background:#161b22; border:1px solid #30363d; border-left-width:4px;
    border-radius:8px; padding:18px; margin-bottom:14px; }
  .idle      { border-left-color:#3fb950; }
  .workspace { border-left-color:#58a6ff; }
  .pending   { border-left-color:#d29922; }
  .timer   { font-size:32px; font-weight:700; color:#d29922; margin:8px 0; }
  ul { list-style:none; padding:0; margin:8px 0 0; font-size:12px; color:#8b949e; }
  .actions { display:flex; gap:10px; margin-top:12px; }
  button { padding:8px 18px; border:0; border-radius:6px; font-weight:600;
    cursor:pointer; font-family:inherit; }
  .confirm { background:#238636; color:#fff; }
  .revert  { background:#da3633; color:#fff; }
</style></head>
<body>
  <h1>Config Guardian</h1>
  <div class="card ${cardClass}">
    <strong>${title}</strong>
    ${body}
  </div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Main HTTP server
// ---------------------------------------------------------------------------
function jsonResponse(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function actionResponse(req, res, result) {
  if ((req.headers.accept || "").includes("text/html")) {
    res.writeHead(303, { Location: "/__guardian__/" });
    res.end();
  } else {
    jsonResponse(res, result.ok ? 200 : 400, result);
  }
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;

  if (pathname === "/__guardian__/api/status") {
    const remaining = state.deadline ? Math.max(0, state.deadline - Date.now()) : null;
    return jsonResponse(res, 200, {
      status: state.status,
      remainingMs: remaining,
      timeoutMinutes: TIMEOUT_MS / 60000,
      changedFiles: liveStats.configChangedFiles,
      workspace: {
        dirty: liveStats.workspaceDirty,
        changedFiles: liveStats.workspaceChangedFiles,
      },
      config: {
        dirtyVsBackup: liveStats.configDirtyVsBackup,
        changedFiles: liveStats.configChangedFiles,
      },
    });
  }

  if (req.method === "POST") {
    if (pathname === "/__guardian__/api/apply") {
      return actionResponse(req, res, applyWorkspaceToConfig());
    }
    if (pathname === "/__guardian__/api/discard") {
      return actionResponse(req, res, discardWorkspace());
    }
    if (pathname === "/__guardian__/api/pull") {
      return actionResponse(req, res, pullConfigToWorkspace());
    }
    if (pathname === "/__guardian__/api/confirm") {
      const result = state.status === "pending"
        ? confirmChanges()
        : { ok: false, message: "No pending changes to confirm." };
      return actionResponse(req, res, result);
    }
    if (pathname === "/__guardian__/api/revert") {
      const result = state.status === "pending"
        ? revertChanges()
        : { ok: false, message: "No pending changes to revert." };
      return actionResponse(req, res, result);
    }
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
// Boot — launch opencode first so the user-visible loading page flips to
// the SPA as soon as possible, then run the slower rsync/backup work in
// the background. applyWorkspaceToConfig() always re-runs createBackup
// before any /config write so safety isn't compromised by deferring it.
// ---------------------------------------------------------------------------
console.log(`[guardian] CONFIG_DIR=${CONFIG_DIR}  WORKSPACE_DIR=${WORKSPACE_DIR}`);
console.log("[guardian] Running crash recovery check...");
crashRecovery();
console.log("[guardian] Launching OpenCode...");
startOpenCode();
console.log("[guardian] Starting file watcher...");
startWatcher();
setImmediate(() => {
  console.log("[guardian] Creating initial backup (async)...");
  createBackup();
});

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
