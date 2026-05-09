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
#
#    NOTE: We use a fresh path (/data/oc-v2/*) because earlier add-on
#    versions (1.5) wrote a hand-crafted opencode.json with empty
#    provider stubs into /data/opencode-config, which overrode
#    OpenCode's built-in provider presets and produced a blank web UI.
#    Switching to a new location guarantees a clean default state on
#    upgrade. Old paths are renamed (not deleted) so the user can still
#    recover anything they cared about.
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

# Quarantine the legacy persistent dirs from add-on versions <= 1.7 so
# their broken opencode.json / stale state cannot poison the new install.
for legacy in opencode-config opencode-share opencode-state opencode-cache; do
    if [ -d "/data/$legacy" ] && [ ! -L "/data/$legacy" ]; then
        mv "/data/$legacy" "/data/${legacy}.legacy.$(date +%s)"
        echo "[init] Quarantined legacy /data/$legacy"
    fi
done

mkdir -p /data/oc-v2/config
mkdir -p /data/oc-v2/share
mkdir -p /data/last-known-good

# Match the OpenCode 1.2 sketch behavior: only symlink the two dirs
# OpenCode actually keeps state in. State + cache are derived data;
# letting them live in ephemeral container locations is fine and
# avoids overriding XDG defaults that future OpenCode versions might
# rely on.
link_persistent_dir /data/oc-v2/config /root/.config/opencode
link_persistent_dir /data/oc-v2/share /root/.local/share/opencode

export HOME=/root
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

# OpenCode ships with its own built-in provider/login presets. We do NOT
# write any custom opencode.json — doing so previously (v1.5) replaced the
# default presets with empty stubs and produced a blank UI. Users pick
# providers and log in through the web UI, and credentials persist under
# /data/oc-v2/{config,share} via the symlinks created above.

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

# OpenCode wants /config to be a git repo so it can do per-edit
# snapshots/undo. We only initialize an EMPTY repo (no `git add`,
# no commit) so we never pull HA's database, .storage, secrets, or
# other dynamic state into git. If the user already has a git repo
# in /config (their own, or one set up by another tool) we leave it
# completely alone.
if [ ! -d /config/.git ]; then
    (
        cd /config
        git init --quiet
        git config user.email "opencode-addon@homeassistant"
        git config user.name "OpenCode Addon"
    )
    echo "[init] Initialized empty git repo in /config for OpenCode snapshots"
else
    echo "[init] Existing /config git repo preserved"
fi

# ----------------------------------------------------------
# 4. Start the guardian server (manages OpenCode + safety)
# ----------------------------------------------------------
echo "[init] Starting guardian server..."
cd /opt/guardian
exec node server.js
