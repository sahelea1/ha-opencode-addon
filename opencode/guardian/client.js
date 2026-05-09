/**
 * Config Guardian — Client Banner
 *
 * Injected into OpenCode's HTML by the proxy. Polls the guardian API and
 * shows a floating banner that handles two states:
 *
 *   - workspace dirty: opencode edited files; ask the user to Apply or Discard
 *   - pending:         changes were Apply'd to /config; user must Confirm or
 *                      Revert before the timer expires
 */
(function () {
  "use strict";

  var ingressRoot = window.__GUARDIAN_BASE_PATH || "";
  var API_BASE = ingressRoot + "/__guardian__/api/";
  var POLL_MS = 3000;

  // ── Inject styles ───────────────────────────────────────────────────
  var style = document.createElement("style");
  style.textContent = [
    "#gcfg-bar{",
    "  position:fixed;top:0;left:0;right:0;z-index:2147483647;",
    "  display:flex;justify-content:center;",
    "  transform:translateY(-110%);opacity:0;",
    "  transition:transform .42s cubic-bezier(.2,0,0,1),opacity .3s;",
    "  pointer-events:none;",
    "  font:500 14px/1.3 'Inter','SF Pro Text',-apple-system,'Segoe UI',Roboto,system-ui,sans-serif;",
    "  -webkit-font-smoothing:antialiased;",
    "}",
    "#gcfg-bar.show{transform:translateY(0);opacity:1;pointer-events:auto;}",

    "#gcfg-bar .gcfg-pill{",
    "  display:flex;align-items:center;gap:14px;",
    "  margin:12px 16px;padding:10px 14px 10px 18px;",
    "  background:rgba(28,25,52,.94);",
    "  -webkit-backdrop-filter:saturate(180%) blur(18px);",
    "  backdrop-filter:saturate(180%) blur(18px);",
    "  border:1px solid rgba(162,89,230,.32);",
    "  border-radius:16px;",
    "  box-shadow:",
    "    0 1px 0 rgba(255,255,255,.04) inset,",
    "    0 12px 32px rgba(15,12,40,.55),",
    "    0 4px 12px rgba(89,78,234,.25);",
    "  color:#e2e8f0;max-width:880px;width:calc(100% - 32px);",
    "}",

    "#gcfg-bar .gcfg-dot{",
    "  flex-shrink:0;width:34px;height:34px;border-radius:11px;",
    "  background:linear-gradient(135deg,#594EEA 0%,#7C5CEC 50%,#A259E6 100%);",
    "  box-shadow:0 4px 12px rgba(124,92,236,.45);",
    "  display:flex;align-items:center;justify-content:center;",
    "  color:#fff;font:800 16px/1 ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace;",
    "  letter-spacing:-1px;",
    "}",
    "#gcfg-bar.workspace .gcfg-dot{",
    "  background:linear-gradient(135deg,#0ea5e9 0%,#3b82f6 50%,#6366f1 100%);",
    "}",

    "#gcfg-bar .gcfg-time{",
    "  flex-shrink:0;font:700 22px/1 ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace;",
    "  color:#a78bfa;letter-spacing:.5px;font-variant-numeric:tabular-nums;",
    "  min-width:62px;text-align:center;",
    "}",
    "#gcfg-bar.workspace .gcfg-time{display:none;}",
    "#gcfg-bar.urgent .gcfg-time{color:#fb7185;}",

    "#gcfg-bar .gcfg-text{flex:1;min-width:0;display:flex;flex-direction:column;}",
    "#gcfg-bar .gcfg-title{font-weight:600;color:#f1f5f9;letter-spacing:-.01em;}",
    "#gcfg-bar .gcfg-files{",
    "  font-size:12px;color:#94a3b8;margin-top:2px;",
    "  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
    "}",

    "#gcfg-bar .gcfg-btn{",
    "  flex-shrink:0;padding:8px 18px;border:0;border-radius:10px;",
    "  font:600 13px/1 inherit;letter-spacing:.02em;cursor:pointer;",
    "  transition:transform .12s,box-shadow .2s,filter .2s;",
    "  display:inline-flex;align-items:center;gap:6px;",
    "}",
    "#gcfg-bar .gcfg-btn:hover{filter:brightness(1.1);transform:translateY(-1px);}",
    "#gcfg-bar .gcfg-btn:active{transform:translateY(0);filter:brightness(.95);}",
    "#gcfg-bar .gcfg-btn:focus-visible{outline:2px solid #a78bfa;outline-offset:2px;}",
    "#gcfg-bar .gcfg-btn[disabled]{opacity:.55;cursor:wait;filter:grayscale(.3);}",
    "#gcfg-bar .gcfg-primary{",
    "  background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;",
    "  box-shadow:0 6px 16px rgba(34,197,94,.35);",
    "}",
    "#gcfg-bar .gcfg-secondary{",
    "  background:rgba(244,63,94,.12);color:#fb7185;",
    "  border:1px solid rgba(244,63,94,.4);",
    "}",
    "#gcfg-bar .gcfg-secondary:hover{background:rgba(244,63,94,.22);}",

    "#gcfg-bar.urgent .gcfg-pill{",
    "  border-color:rgba(244,63,94,.55);",
    "  animation:gcfgPulse 1.4s ease-in-out infinite alternate;",
    "}",
    "@keyframes gcfgPulse{",
    "  from{box-shadow:0 12px 32px rgba(15,12,40,.55),0 0 0 rgba(244,63,94,.0);}",
    "  to  {box-shadow:0 12px 32px rgba(15,12,40,.55),0 0 24px rgba(244,63,94,.45);}",
    "}",

    "#gcfg-toast{",
    "  position:fixed;top:18px;left:50%;",
    "  transform:translateX(-50%) translateY(-90px);",
    "  z-index:2147483647;padding:11px 22px;border-radius:12px;",
    "  font:600 13px/1 'Inter','SF Pro Text',system-ui,sans-serif;",
    "  letter-spacing:.01em;color:#fff;opacity:0;pointer-events:none;",
    "  transition:transform .42s cubic-bezier(.2,0,0,1),opacity .3s;",
    "  box-shadow:0 12px 32px rgba(0,0,0,.35);",
    "}",
    "#gcfg-toast.show{transform:translateX(-50%) translateY(0);opacity:1;}",
    "#gcfg-toast.success {background:linear-gradient(135deg,#22c55e,#16a34a);}",
    "#gcfg-toast.info    {background:linear-gradient(135deg,#3b82f6,#1d4ed8);}",
    "#gcfg-toast.reverted{background:linear-gradient(135deg,#f43f5e,#e11d48);}",
    "#gcfg-toast.error   {background:linear-gradient(135deg,#f59e0b,#d97706);}",

    "@media (max-width:640px){",
    "  #gcfg-bar .gcfg-files{display:none;}",
    "  #gcfg-bar .gcfg-pill{margin:8px 8px;padding:8px 10px 8px 12px;gap:10px;}",
    "}",
  ].join("\n");
  document.head.appendChild(style);

  // ── DOM ─────────────────────────────────────────────────────────────
  var bar = document.createElement("div");
  bar.id = "gcfg-bar";
  bar.innerHTML = [
    '<div class="gcfg-pill" role="status" aria-live="polite">',
    '  <div class="gcfg-dot">{}</div>',
    '  <div class="gcfg-time" aria-label="time remaining">--:--</div>',
    '  <div class="gcfg-text">',
    '    <span class="gcfg-title">Workspace changes pending</span>',
    '    <span class="gcfg-files"></span>',
    "  </div>",
    '  <button class="gcfg-btn gcfg-primary"   data-action="primary"   type="button">Apply</button>',
    '  <button class="gcfg-btn gcfg-secondary" data-action="secondary" type="button">Discard</button>',
    "</div>",
  ].join("\n");
  document.body.appendChild(bar);

  var titleEl = bar.querySelector(".gcfg-title");
  var filesEl = bar.querySelector(".gcfg-files");
  var timeEl  = bar.querySelector(".gcfg-time");
  var primaryBtn   = bar.querySelector('[data-action="primary"]');
  var secondaryBtn = bar.querySelector('[data-action="secondary"]');

  var toast = document.createElement("div");
  toast.id = "gcfg-toast";
  document.body.appendChild(toast);

  // ── Helpers ─────────────────────────────────────────────────────────
  function fmt(ms) {
    var total = Math.ceil(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  function showToast(text, cls) {
    toast.textContent = text;
    toast.className = cls + " show";
    setTimeout(function () { toast.className = ""; }, 3200);
  }
  function joinFiles(files) {
    if (!files || !files.length) return "";
    var head = files.slice(0, 4).join("  ·  ");
    return files.length > 4 ? head + "  +" + (files.length - 4) + " more" : head;
  }
  function setBusy(busy) {
    primaryBtn.disabled = busy;
    secondaryBtn.disabled = busy;
  }

  // mode === "workspace" | "pending" | null
  var currentMode = null;

  function renderWorkspace(d) {
    if (currentMode !== "workspace") {
      currentMode = "workspace";
      bar.classList.add("workspace");
      bar.classList.remove("urgent");
      primaryBtn.textContent = "Apply";
      secondaryBtn.textContent = "Discard";
    }
    titleEl.textContent = "Workspace changes ready to apply";
    filesEl.textContent = joinFiles(d.workspace && d.workspace.changedFiles);
    bar.classList.add("show");
    document.body.style.paddingTop = "62px";
  }

  function renderPending(d) {
    if (currentMode !== "pending") {
      currentMode = "pending";
      bar.classList.remove("workspace");
      primaryBtn.textContent = "Confirm";
      secondaryBtn.textContent = "Revert";
    }
    titleEl.textContent = "Applied — confirm or revert before timeout";
    filesEl.textContent = joinFiles(d.changedFiles);
    timeEl.textContent = fmt(d.remainingMs);
    if (d.remainingMs < 120000) bar.classList.add("urgent");
    else bar.classList.remove("urgent");
    bar.classList.add("show");
    document.body.style.paddingTop = "62px";
  }

  function hideBar() {
    currentMode = null;
    bar.classList.remove("show", "urgent", "workspace");
    document.body.style.paddingTop = "";
  }

  // ── Poll ────────────────────────────────────────────────────────────
  function poll() {
    fetch(API_BASE + "status", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === "pending") {
          renderPending(d);
        } else if (d.workspace && d.workspace.dirty) {
          renderWorkspace(d);
        } else {
          hideBar();
        }
      })
      .catch(hideBar);
  }

  // ── Actions ─────────────────────────────────────────────────────────
  function callAction(verb, opts) {
    opts = opts || {};
    if (opts.confirm && !confirm(opts.confirm)) return;
    setBusy(true);
    fetch(API_BASE + verb, { method: "POST" })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, body: d }; }); })
      .then(function (resp) {
        if (resp.ok && resp.body.ok) {
          showToast(opts.successMsg || "Done", opts.successCls || "success");
          if (opts.hide) hideBar();
        } else {
          showToast(resp.body.message || "Action failed", "error");
        }
      })
      .catch(function () { showToast("Network error", "error"); })
      .then(function () { setBusy(false); poll(); });
  }

  primaryBtn.addEventListener("click", function () {
    if (currentMode === "workspace") {
      callAction("apply", {
        successMsg: "Applied — HA reloading. Confirm before timeout.",
        successCls: "info",
      });
    } else if (currentMode === "pending") {
      callAction("confirm", {
        successMsg: "Changes confirmed",
        successCls: "success",
        hide: true,
      });
    }
  });
  secondaryBtn.addEventListener("click", function () {
    if (currentMode === "workspace") {
      callAction("discard", {
        confirm: "Discard all workspace edits and reset to /config?",
        successMsg: "Workspace reset to /config",
        successCls: "info",
        hide: true,
      });
    } else if (currentMode === "pending") {
      callAction("revert", {
        confirm: "Revert pending changes?\n\nThis restores /config from backup and reloads HA.",
        successMsg: "Reverted — HA reloading",
        successCls: "reverted",
        hide: true,
      });
    }
  });

  setInterval(poll, POLL_MS);
  poll();
})();
