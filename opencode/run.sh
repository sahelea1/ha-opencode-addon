#!/usr/bin/env bash
set -eo pipefail

echo "========================================"
echo "  ha-opencode-addon Starting"
echo "========================================"

# ----------------------------------------------------------
# 1. Persistence
#
#    Persist OpenCode's config + auth at /data/oc-v3/{config,share}.
#    /data is the add-on's persistent volume (survives restarts and
#    rebuilds). /data/oc-v3 is a fresh path; previous versions
#    (1.5–1.10) wrote a half-broken opencode.json or partial auth
#    state into older paths and that state silently broke the UI.
#    We rename anything from those older paths to .legacy.<ts> so
#    the user can recover anything they care about, but stale state
#    can't poison the new install.
#
#    OpenCode reads ~/.config/opencode and ~/.local/share/opencode,
#    so we point those at the persistent dirs with simple symlinks.
#    Avoid any "rsync into target on first boot" magic — that's how
#    container-baked artifacts ended up leaking into the persisted
#    dir in earlier versions.
# ----------------------------------------------------------
quarantine_legacy() {
    local p="$1"
    if [ -e "$p" ] && [ ! -L "$p" ]; then
        local q="${p}.legacy.$(date +%s)"
        mv "$p" "$q" 2>/dev/null || true
        echo "[init] Quarantined legacy $p -> $q"
    fi
}

quarantine_legacy /data/opencode-config
quarantine_legacy /data/opencode-share
quarantine_legacy /data/opencode-state
quarantine_legacy /data/opencode-cache
quarantine_legacy /data/oc-v2

mkdir -p /data/oc-v3/config /data/oc-v3/share /data/last-known-good
mkdir -p /root/.config /root/.local/share

ln -sfn /data/oc-v3/config /root/.config/opencode
ln -sfn /data/oc-v3/share  /root/.local/share/opencode

export HOME=/root
export OPENCODE_DISABLE_AUTOUPDATE=true

echo "[init] Persistent OpenCode storage linked under /data/oc-v3"

# ----------------------------------------------------------
# 2. Read add-on options — only the guardian timeout
#
#    Provider selection, API keys, and login are entered
#    interactively in the OpenCode web UI. We do NOT pre-write any
#    opencode.json — earlier versions did that with empty provider
#    stubs, which OVERRODE OpenCode's own built-in provider preset
#    list and made the UI look blank.
# ----------------------------------------------------------
TIMEOUT_MIN=10
if [ -f /data/options.json ]; then
    TIMEOUT_MIN=$(jq -r '.confirm_timeout_minutes // 10' /data/options.json)
fi
export GUARDIAN_TIMEOUT_MIN="$TIMEOUT_MIN"
echo "[init] Confirm timeout: ${TIMEOUT_MIN} minutes"

# ----------------------------------------------------------
# 3. Validate /config mount
# ----------------------------------------------------------
if [ ! -d /config ]; then
    echo "[init] ERROR: Home Assistant /config mount is missing" >&2
    exit 1
fi
if [ ! -w /config ]; then
    echo "[init] ERROR: Home Assistant /config mount is not writable" >&2
    exit 1
fi
echo "[init] Home Assistant config mounted at /config"

# We deliberately do NOT init a git repo in /config. The guardian
# uses rsync snapshots at /data/last-known-good, not git, so /config
# stays exactly as Home Assistant manages it.

# ----------------------------------------------------------
# 4. Start the guardian (which manages OpenCode + safety)
# ----------------------------------------------------------
echo "[init] Starting guardian server..."
cd /opt/guardian
exec node server.js
