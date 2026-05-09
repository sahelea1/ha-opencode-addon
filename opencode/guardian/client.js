/**
 * Config Guardian — Client Banner (v1.16)
 *
 * Injected into OpenCode's HTML by the proxy. Always mounts a small pill
 * at the top of the SPA so users can drive the apply/revert flow without
 * ever leaving the OpenCode UI for the /__guardian__/ fallback page.
 *
 * Three render states (driven by /__guardian__/api/status polling):
 *   - idle:      "All clear" + Pull-from-/config + Open-in-new-tab
 *   - workspace: workspace dirty → Apply / Discard
 *   - pending:   /config in pending state → countdown + Confirm / Revert
 */
(function () {
  "use strict";

  var ingressRoot = window.__GUARDIAN_BASE_PATH || "";
  var API_BASE = ingressRoot + "/__guardian__/api/";
  var POLL_MS = 3000;

  // ── Mount: prefer the server-rendered placeholder; fall back to body
  //    once parsing reaches it. Guards against the race where client.js
  //    runs from <head> before document.body exists in iframe contexts.
  function mount(cb) {
    var host = document.getElementById("gcfg-bar-host");
    if (host) return cb(host);
    if (!document.body) return setTimeout(function () { mount(cb); }, 50);
    cb(document.body);
  }

  mount(function (host) {
    // ── Inject styles ─────────────────────────────────────────────────
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
      "#gcfg-bar.idle{transform:translateY(0);opacity:.92;pointer-events:auto;}",
      "#gcfg-bar.idle .gcfg-pill{padding:6px 12px 6px 14px;gap:10px;}",
      "#gcfg-bar.idle .gcfg-dot{width:24px;height:24px;border-radius:8px;font-size:12px;}",
      "#gcfg-bar.idle .gcfg-title{font-size:13px;}",
      "#gcfg-bar.idle .gcfg-time{display:none;}",
      "#gcfg-bar.idle .gcfg-files{display:none;}",
      "#gcfg-bar.idle .gcfg-btn{padding:5px 12px;font-size:12px;}",

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
      "#gcfg-bar.idle .gcfg-dot{",
      "  background:linear-gradient(135deg,#16a34a 0%,#22c55e 100%);",
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
      "  text-decoration:none;",
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
      "#gcfg-bar .gcfg-ghost{",
      "  background:rgba(148,163,184,.1);color:#cbd5e1;",
      "  border:1px solid rgba(148,163,184,.25);",
      "}",
      "#gcfg-bar .gcfg-ghost:hover{background:rgba(148,163,184,.2);}",

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

    // ── DOM ───────────────────────────────────────────────────────────
    var bar = document.createElement("div");
    bar.id = "gcfg-bar";
    bar.innerHTML = [
      '<div class="gcfg-pill" role="status" aria-live="polite">',
      '  <div class="gcfg-dot">{}</div>',
      '  <div class="gcfg-time" aria-label="time remaining">--:--</div>',
      '  <div class="gcfg-text">',
      '    <span class="gcfg-title">Loading…</span>',
      '    <span class="gcfg-files"></span>',
      "  </div>",
      '  <button class="gcfg-btn gcfg-primary"   data-action="primary"   type="button">Apply</button>',
      '  <button class="gcfg-btn gcfg-secondary" data-action="secondary" type="button">Discard</button>',
      '  <a       class="gcfg-btn gcfg-ghost"    data-action="popout"    href="#" target="_blank" rel="noopener" title="Open in a new tab (escapes the HA iframe — useful if the file tree fails to load embedded)">Open ↗</a>',
      "</div>",
    ].join("\n");
    host.appendChild(bar);

    var titleEl = bar.querySelector(".gcfg-title");
    var filesEl = bar.querySelector(".gcfg-files");
    var timeEl  = bar.querySelector(".gcfg-time");
    var primaryBtn   = bar.querySelector('[data-action="primary"]');
    var secondaryBtn = bar.querySelector('[data-action="secondary"]');
    var popoutBtn    = bar.querySelector('[data-action="popout"]');

    // The popout link mirrors the current URL so HA users can
    // break out of the iframe with a single click. We set href
    // on each render so SPA route changes stay in sync.
    function syncPopoutHref() {
      try { popoutBtn.href = window.location.href; } catch (e) {}
    }
    syncPopoutHref();

    var toast = document.createElement("div");
    toast.id = "gcfg-toast";
    document.body && document.body.appendChild(toast);

    // ── Helpers ───────────────────────────────────────────────────────
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

    // mode === "idle" | "workspace" | "pending"
    var currentMode = null;

    function setMode(mode) {
      if (currentMode === mode) return;
      currentMode = mode;
      bar.classList.remove("workspace", "idle", "urgent");
      if (mode === "workspace") {
        bar.classList.add("workspace");
        primaryBtn.textContent = "Apply";
        secondaryBtn.textContent = "Discard";
        primaryBtn.style.display = "";
        secondaryBtn.style.display = "";
      } else if (mode === "pending") {
        primaryBtn.textContent = "Confirm";
        secondaryBtn.textContent = "Revert";
        primaryBtn.style.display = "";
        secondaryBtn.style.display = "";
      } else {
        bar.classList.add("idle");
        primaryBtn.textContent = "Pull from /config";
        secondaryBtn.style.display = "none";
        primaryBtn.style.display = "";
      }
      syncPopoutHref();
    }

    function renderIdle() {
      setMode("idle");
      titleEl.textContent = "All clear";
      filesEl.textContent = "";
      timeEl.textContent = "";
      bar.classList.add("show");
      // Idle bar is small + low-emphasis; don't shove the SPA down.
      document.body.style.paddingTop = "";
    }

    function renderWorkspace(d) {
      setMode("workspace");
      titleEl.textContent = "Workspace changes ready to apply";
      filesEl.textContent = joinFiles(d.workspace && d.workspace.changedFiles);
      bar.classList.add("show");
      document.body.style.paddingTop = "62px";
    }

    function renderPending(d) {
      setMode("pending");
      titleEl.textContent = "Applied — confirm or revert before timeout";
      filesEl.textContent = joinFiles(d.changedFiles);
      timeEl.textContent = fmt(d.remainingMs);
      if (d.remainingMs < 120000) bar.classList.add("urgent");
      else bar.classList.remove("urgent");
      bar.classList.add("show");
      document.body.style.paddingTop = "62px";
    }

    // ── Poll ──────────────────────────────────────────────────────────
    function poll() {
      fetch(API_BASE + "status", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.status === "pending") {
            renderPending(d);
          } else if (d.workspace && d.workspace.dirty) {
            renderWorkspace(d);
          } else {
            renderIdle();
          }
        })
        .catch(function () {
          // Guardian unreachable — hide rather than confuse the user.
          bar.classList.remove("show", "idle", "urgent", "workspace");
          document.body.style.paddingTop = "";
          currentMode = null;
        });
    }

    // ── Actions ───────────────────────────────────────────────────────
    function callAction(verb, opts) {
      opts = opts || {};
      if (opts.confirm && !confirm(opts.confirm)) return;
      setBusy(true);
      fetch(API_BASE + verb, { method: "POST" })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, body: d }; }); })
        .then(function (resp) {
          if (resp.ok && resp.body.ok) {
            showToast(opts.successMsg || "Done", opts.successCls || "success");
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
        });
      } else {
        callAction("pull", {
          confirm: "Pull from /config? Any uncommitted workspace edits will be overwritten.",
          successMsg: "Workspace refreshed from /config",
          successCls: "info",
        });
      }
    });
    secondaryBtn.addEventListener("click", function () {
      if (currentMode === "workspace") {
        callAction("discard", {
          confirm: "Discard all workspace edits and reset to /config?",
          successMsg: "Workspace reset to /config",
          successCls: "info",
        });
      } else if (currentMode === "pending") {
        callAction("revert", {
          confirm: "Revert pending changes?\n\nThis restores /config from backup and reloads HA.",
          successMsg: "Reverted — HA reloading",
          successCls: "reverted",
        });
      }
    });

    setInterval(poll, POLL_MS);
    poll();
  });
})();
