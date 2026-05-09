#!/usr/bin/env bash
set -eo pipefail

echo "========================================"
echo "  ha-opencode-addon Starting"
echo "========================================"

# ----------------------------------------------------------
# 1. Persistence — symlink OpenCode data dirs to /data
#    /data is the add-on's persistent volume (survives restarts,
#    rebuilds, and add-on updates unless the user chooses to clear it
#    during uninstall). API keys, provider selection, login state,
#    sessions, and cache/state files live in these dirs.
# ----------------------------------------------------------
link_persistent_dir() {
    local target="$1"
    local link="$2"

    mkdir -p "$target"
    mkdir -p "$(dirname "$link")"

    if [ -L "$link" ]; then
        rm -f "$link"
    elif [ -d "$link" ]; then
        rsync -a "$link"/ "$target"/ >/dev/null 2>&1 || true
        rm -rf "$link"
    elif [ -e "$link" ]; then
        mv "$link" "${link}.bak.$(date +%s)"
    fi

    ln -sfnT "$target" "$link"
}

mkdir -p /data/opencode-config
mkdir -p /data/opencode-share
mkdir -p /data/opencode-state
mkdir -p /data/opencode-cache
mkdir -p /data/last-known-good

link_persistent_dir /data/opencode-config /root/.config/opencode
link_persistent_dir /data/opencode-share /root/.local/share/opencode
link_persistent_dir /data/opencode-state /root/.local/state/opencode
link_persistent_dir /data/opencode-cache /root/.cache/opencode

export HOME=/root
export XDG_CONFIG_HOME=/root/.config
export XDG_DATA_HOME=/root/.local/share
export XDG_STATE_HOME=/root/.local/state
export XDG_CACHE_HOME=/root/.cache
export OPENCODE_DISABLE_AUTOUPDATE=true

echo "[init] Persistent OpenCode storage linked under /data"

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

# OpenCode ships with its own built-in provider/login presets. We don't
# write a custom opencode.json — users pick providers and log in through
# the web UI, and credentials persist under /data/opencode-config and
# /data/opencode-share via the symlinks created above.

# ----------------------------------------------------------
# 3. Validate HA config mount and clean up legacy add-on git repo
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

if [ -L /root/ha-config ] || [ ! -e /root/ha-config ]; then
    ln -sfnT /config /root/ha-config
    echo "[init] Home Assistant config mirrored at /root/ha-config"
else
    echo "[init] /root/ha-config exists and is not a symlink; leaving it untouched"
fi

# Versions before 1.3.0 created an empty git repo in /config. The guardian
# uses rsync baselines, not git, so remove only that exact empty legacy repo to
# prevent every HA config file from appearing as an untracked git file.
if [ -d /config/.git ]; then
    cd /config
    GIT_EMAIL="$(git config --local --get user.email 2>/dev/null || true)"
    GIT_NAME="$(git config --local --get user.name 2>/dev/null || true)"
    COMMIT_COUNT="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
    REMOTE_COUNT="$(git remote 2>/dev/null | wc -l | tr -d ' ')"
    TRACKED_COUNT="$(git ls-files 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$GIT_EMAIL" = "guardian@opencode-addon" ] && [ "$GIT_NAME" = "Config Guardian" ] && [ "$COMMIT_COUNT" = "0" ] && [ "$REMOTE_COUNT" = "0" ] && [ "$TRACKED_COUNT" = "0" ]; then
        LEGACY_GIT_BACKUP="/data/legacy-guardian-git-$(date +%s)"
        mv /config/.git "$LEGACY_GIT_BACKUP"
        echo "[init] Moved empty legacy guardian git repo to $LEGACY_GIT_BACKUP"
    else
        echo "[init] Existing /config git repo preserved"
    fi
else
    # No git repo — initialize one so OpenCode recognizes /config as a project
    cd /config
    git init --quiet
    git config user.email "opencode-addon@homeassistant"
    git config user.name "OpenCode Addon"
    git add -A >/dev/null 2>&1 || true
    git commit -m "HA config baseline" --quiet 2>/dev/null || true
    echo "[init] Initialized git repo in /config for OpenCode project detection"
fi

# ----------------------------------------------------------
# 4. Start the guardian server (manages OpenCode + safety)
# ----------------------------------------------------------
echo "[init] Starting guardian server..."
cd /opt/guardian
exec node server.js
