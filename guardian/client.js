/**
 * Config Guardian — Client Banner
 *
 * Injected into OpenCode's HTML by the proxy.
 * Polls the guardian API and shows a floating confirmation bar
 * when config changes are pending.
 */
(function () {
  "use strict";

  // Resolve guardian API base URL — works with both direct access and HA ingress
  var currentHref = window.location.href;
  if (!currentHref.endsWith("/")) currentHref += "/";
  var API_BASE = new URL("__guardian__/api/", currentHref).href;
  var POLL_MS = 3000;

  // ── Build the banner DOM ────────────────────────────────
  var style = document.createElement("style");
  style.textContent = [
    "#gcfg-bar {",
    "  position:fixed; top:0; left:0; right:0; z-index:2147483647;",
    "  transform:translateY(-100%); opacity:0;",
    "  transition:transform .35s cubic-bezier(.4,0,.2,1), opacity .35s;",
    "  pointer-events:none;",
    "  font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;",
    "}",
    "#gcfg-bar.visible { transform:translateY(0); opacity:1; pointer-events:auto; }",
    "#gcfg-bar .gcfg-inner {",
    "  display:flex; align-items:center; gap:14px;",
    "  padding:9px 18px; margin:8px 12px 0;",
    "  background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);",
    "  border:1px solid rgba(233,69,96,.45); border-radius:10px;",
    "  box-shadow:0 4px 24px rgba(0,0,0,.45),0 0 0 1px rgba(233,69,96,.1);",
    "  color:#e2e8f0; font-size:13px; line-height:1.3;",
    "}",
    "#gcfg-bar.urgent .gcfg-inner {",
    "  border-color:rgba(255,68,68,.7);",
    "  animation:gcfgPulse 1.2s ease-in-out infinite alternate;",
    "}",
    "@keyframes gcfgPulse {",
    "  from { box-shadow:0 4px 24px rgba(0,0,0,.45),0 0 8px rgba(255,68,68,.15); }",
    "  to   { box-shadow:0 4px 24px rgba(0,0,0,.45),0 0 18px rgba(255,68,68,.35); }",
    "}",
    "#gcfg-bar .gcfg-icon { font-size:18px; flex-shrink:0; }",
    "#gcfg-bar .gcfg-timer {",
    "  font-family:'SF Mono','Fira Code','Cascadia Code',monospace;",
    "  font-size:20px; font-weight:700; min-width:54px;",
    "  color:#e94560; letter-spacing:.5px;",
    "}",
    "#gcfg-bar.urgent .gcfg-timer { color:#ff4444; }",
    "#gcfg-bar .gcfg-label { font-weight:600; white-space:nowrap; }",
    "#gcfg-bar .gcfg-files {",
    "  flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
    "  font-size:11px; color:#8b949e;",
    "}",
    "#gcfg-bar .gcfg-btn {",
    "  padding:5px 16px; border:none; border-radius:6px;",
    "  font-size:12px; font-weight:700; cursor:pointer;",
    "  font-family:inherit; letter-spacing:.3px;",
    "  transition:filter .15s,transform .1s;",
    "  text-transform:uppercase; flex-shrink:0;",
    "}",
    "#gcfg-bar .gcfg-btn:hover { filter:brightness(1.2); transform:scale(1.03); }",
    "#gcfg-bar .gcfg-btn:active { transform:scale(.97); }",
    "#gcfg-bar .gcfg-confirm { background:#238636; color:#fff; }",
    "#gcfg-bar .gcfg-revert  { background:#da3633; color:#fff; }",
    "",
    /* Slide body content down when bar is visible */
    "#gcfg-bar.visible ~ *, #gcfg-bar.visible + * { /* handled via JS margin */ }",
    "",
    /* Success/revert toast */
    "#gcfg-toast {",
    "  position:fixed; top:12px; left:50%; transform:translateX(-50%) translateY(-80px);",
    "  z-index:2147483647; padding:10px 24px; border-radius:8px;",
    "  font-family:-apple-system,sans-serif; font-size:13px; font-weight:600;",
    "  transition:transform .4s cubic-bezier(.4,0,.2,1), opacity .4s;",
    "  opacity:0; pointer-events:none;",
    "}",
    "#gcfg-toast.show { transform:translateX(-50%) translateY(0); opacity:1; }",
    "#gcfg-toast.success { background:#238636; color:#fff; }",
    "#gcfg-toast.reverted { background:#da3633; color:#fff; }",
  ].join("\n");
  document.head.appendChild(style);

  var bar = document.createElement("div");
  bar.id = "gcfg-bar";
  bar.innerHTML = [
    '<div class="gcfg-inner">',
    '  <span class="gcfg-icon">⚡</span>',
    '  <span class="gcfg-timer">--:--</span>',
    '  <span class="gcfg-label">Config changes pending</span>',
    '  <span class="gcfg-files"></span>',
    '  <button class="gcfg-btn gcfg-confirm" onclick="window.__gcfgConfirm()">✓ Confirm</button>',
    '  <button class="gcfg-btn gcfg-revert" onclick="window.__gcfgRevert()">✗ Revert</button>',
    "</div>",
  ].join("\n");
  document.body.appendChild(bar);

  var toast = document.createElement("div");
  toast.id = "gcfg-toast";
  document.body.appendChild(toast);

  // ── Helpers ─────────────────────────────────────────────
  function fmt(ms) {
    var total = Math.ceil(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function showToast(text, cls) {
    toast.textContent = text;
    toast.className = cls + " show";
    setTimeout(function () {
      toast.className = "";
    }, 3000);
  }

  // ── Poll loop ───────────────────────────────────────────
  var lastStatus = "idle";

  function poll() {
    fetch(API_BASE + "status", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.status === "pending") {
          bar.classList.add("visible");
          bar.querySelector(".gcfg-timer").textContent = fmt(d.remainingMs);
          bar.querySelector(".gcfg-files").textContent =
            d.changedFiles.length > 0
              ? d.changedFiles.slice(0, 5).join("  ·  ")
              : "";

          if (d.remainingMs < 120000) {
            bar.classList.add("urgent");
          } else {
            bar.classList.remove("urgent");
          }
          document.body.style.paddingTop = "54px";
        } else {
          bar.classList.remove("visible", "urgent");
          document.body.style.paddingTop = "";

          // Show toast when transitioning from pending to idle
          if (lastStatus === "pending" && d.status === "idle") {
            // toast already shown by confirm/revert action
          }
        }
        lastStatus = d.status;
      })
      .catch(function () {
        // API unreachable — hide bar silently
        bar.classList.remove("visible", "urgent");
        document.body.style.paddingTop = "";
      });
  }

  // ── Actions ─────────────────────────────────────────────
  window.__gcfgConfirm = function () {
    fetch(API_BASE + "confirm", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) {
          showToast("✓ Changes confirmed", "success");
          bar.classList.remove("visible", "urgent");
          document.body.style.paddingTop = "";
        }
      })
      .catch(function () {});
    poll();
  };

  window.__gcfgRevert = function () {
    if (
      !confirm(
        "Revert all pending changes?\n\nThis restores the last confirmed config state and triggers a Home Assistant reload."
      )
    )
      return;

    fetch(API_BASE + "revert", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) {
          showToast("✗ Changes reverted — HA reloading", "reverted");
          bar.classList.remove("visible", "urgent");
          document.body.style.paddingTop = "";
        }
      })
      .catch(function () {});
    poll();
  };

  // ── Start ───────────────────────────────────────────────
  setInterval(poll, POLL_MS);
  poll();
})();
