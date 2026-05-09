#!/usr/bin/env bash
set -eo pipefail

echo "========================================"
echo "  ha-opencode-addon Starting"
echo "========================================"

# ----------------------------------------------------------
# 1. Persistence — symlink OpenCode data dirs to /data/oc-v3
#
#    /data is the add-on's persistent volume (survives restarts,
#    rebuilds, and add-on updates).
#
#    We use a fresh path (/data/oc-v3) because:
#      • v1.5 wrote a hand-crafted opencode.json with empty provider
#        stubs into /data/opencode-config, replacing OpenCode's
#        built-in provider presets and producing a blank UI.
#      • v1.8/v1.9 moved to /data/oc-v2, but by then the user may
#        have triggered partial logins / project bootstraps that
#        wrote half-initialized state into /data/oc-v2/{config,share}.
#        That state survives upgrades and continues to break the UI.
#
#    Switching to /data/oc-v3 guarantees OpenCode boots from its own
#    built-in defaults: file tree mounted at the cwd (/config), real
#    provider presets, full project detection. Old paths are renamed
#    (not deleted) so the user can recover anything they care about.
#
#    Use plain `ln -sfn` (matches the v1.2 sketch behavior). The
#    over-engineered link_persistent_dir helper from v1.5+ rsynced
#    container-baked /root/.config/opencode INTO the persistence
#    target on first boot, which is exactly how empty/broken state
#    leaked into the persisted dir in the first place.
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

mkdir -p /data/oc-v3/config
mkdir -p /data/oc-v3/share
mkdir -p /data/last-known-good
mkdir -p /root/.config
mkdir -p /root/.local/share

ln -sfn /data/oc-v3/config /root/.config/opencode
ln -sfn /data/oc-v3/share  /root/.local/share/opencode

export HOME=/root
export OPENCODE_DISABLE_AUTOUPDATE=true

echo "[init] Persistent OpenCode storage linked under /data/oc-v3"

# ----------------------------------------------------------
# 2. Read add-on options — only the guardian timeout
# ----------------------------------------------------------
OPTIONS_FILE="/data/options.json"
if [ -f "$OPTIONS_FILE" ]; then
    TIMEOUT_MIN=$(jq -r '.confirm_timeout_minutes // 10' "$OPTIONS_FILE")
    echo "[init] Confirm timeout: ${TIMEOUT_MIN} minutes"
else
    TIMEOUT_MIN=10
    echo "[init] No options file found, using default 10 minutes"
fi

export GUARDIAN_TIMEOUT_MIN="$TIMEOUT_MIN"

# OpenCode ships with its own built-in provider/login presets. We do NOT
# write any opencode.json — doing so previously (v1.5) replaced the
# default presets with empty stubs and produced a blank UI. Users pick
# providers and log in through the web UI, and credentials persist under
# /data/oc-v3/{config,share} via the symlinks created above.

# ----------------------------------------------------------
# 3. Validate HA config mount
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

# ----------------------------------------------------------
# 4. /config/.git — preserve real user repos, quarantine old
#    add-on-created baselines.
#
#    v1.7 ran `git add -A && git commit "HA config baseline"` in
#    /config, which pulled HA secrets and the SQLite DB into the
#    repo. If that exact baseline still exists we move it aside.
#    A real user repo (different identity, has remotes, has its own
#    commits) is left untouched.
# ----------------------------------------------------------
if [ -d /config/.git ]; then
    GIT_EMAIL="$(git -C /config config --local --get user.email 2>/dev/null || true)"
    GIT_NAME="$(git -C /config config --local --get user.name 2>/dev/null || true)"
    REMOTE_COUNT="$(git -C /config remote 2>/dev/null | wc -l | tr -d ' ')"
    COMMIT_COUNT="$(git -C /config rev-list --count HEAD 2>/dev/null || echo 0)"
    LAST_MSG="$(git -C /config log -1 --pretty=%s 2>/dev/null || true)"

    addon_identity=false
    case "$GIT_EMAIL" in
        guardian@opencode-addon|opencode-addon@homeassistant) addon_identity=true ;;
    esac

    addon_baseline=false
    if [ "$addon_identity" = "true" ] && [ "$REMOTE_COUNT" = "0" ] && \
       { [ "$COMMIT_COUNT" = "0" ] || \
         [ "$COMMIT_COUNT" = "1" -a "$LAST_MSG" = "HA config baseline" ]; }; then
        addon_baseline=true
    fi

    if [ "$addon_baseline" = "true" ]; then
        Q="/data/legacy-config-git-$(date +%s)"
        mv /config/.git "$Q"
        echo "[init] Quarantined add-on-created /config/.git -> $Q"
    else
        echo "[init] Existing /config/.git preserved (user repo)"
    fi
fi

# OpenCode wants /config to be a git repo so its file snapshots/undo
# work. Init an EMPTY repo (no `git add`, no commit) so we never pull
# HA dynamic state into git. Matches the v1.2 sketch behavior that
# the user reported as working.
if [ ! -d /config/.git ]; then
    git -C /config init --quiet
    git -C /config config user.email "opencode-addon@homeassistant"
    git -C /config config user.name "OpenCode Addon"
    echo "[init] Initialized empty git repo in /config for OpenCode snapshots"
fi

# ----------------------------------------------------------
# 5. Start the guardian server (manages OpenCode + safety)
# ----------------------------------------------------------
echo "[init] Starting guardian server..."
cd /opt/guardian
exec node server.js
