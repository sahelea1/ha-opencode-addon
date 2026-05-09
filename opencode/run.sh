#!/usr/bin/env bash
set -eo pipefail

echo "========================================"
echo "  ha-opencode-addon v1.16 — workspace + project pre-seed"
echo "========================================"

# ----------------------------------------------------------
# 1. Persistence
#
#    Persist OpenCode's config + auth at /data/oc-v3/{config,share}.
#    /data is the add-on's persistent volume (survives restarts and
#    rebuilds). OpenCode reads ~/.config/opencode and
#    ~/.local/share/opencode, so we point those at the persistent
#    dirs with simple symlinks.
#
#    Older versions wrote a half-broken opencode.json or partial auth
#    state into earlier paths and that state silently broke the UI.
#    We rename anything from those older paths to .legacy.<ts> so
#    the user can recover anything they care about, but stale state
#    can't poison the new install.
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

# ----------------------------------------------------------
# 4. Workspace initialization
#
#    OpenCode's project detection walks up from cwd looking for .git.
#    Without it, it falls back to a "global pseudo-project" and the
#    SPA's file tree / VCS panels come up empty — that's the blank
#    state earlier versions hit. We can't `git init` /config because
#    HA owns that directory and adds .git would surprise the user.
#
#    Instead we work in /data/workspace: rsync /config in on first
#    boot, `git init` it, and run opencode there. The guardian
#    exposes Apply/Discard/Pull endpoints to move files between the
#    workspace and /config under user control.
# ----------------------------------------------------------
WORKSPACE_DIR=/data/workspace
RSYNC_EXCLUDES=(
    --exclude=home-assistant_v2.db
    --exclude=home-assistant_v2.db-shm
    --exclude=home-assistant_v2.db-wal
    --exclude=.storage
    --exclude=.cloud
    --exclude=deps
    --exclude=__pycache__
    --exclude=tts
    --exclude=.HA_VERSION
    --exclude=.git
)

mkdir -p "$WORKSPACE_DIR"

# Initial seed: only when workspace is empty (or only contains a .git
# scaffold from a previous boot's first-run). Subsequent boots leave
# the workspace alone so the user's in-progress edits survive
# restarts. The `Pull` button in the UI is the explicit way to
# refresh from /config.
ws_files=$(find "$WORKSPACE_DIR" -mindepth 1 -maxdepth 1 \
    -not -name '.git' -not -name '.gitignore' 2>/dev/null | wc -l)
if [ "$ws_files" -eq 0 ]; then
    echo "[init] Workspace is empty — seeding from /config..."
    rsync -a "${RSYNC_EXCLUDES[@]}" /config/ "$WORKSPACE_DIR/"
    echo "[init] Seeded workspace ($(find "$WORKSPACE_DIR" -type f | wc -l) files)"
else
    echo "[init] Workspace already populated ($ws_files top-level entries) — leaving as-is"
fi

# Git scaffold: opencode falls back to a global pseudo-project
# without .git in the cwd. We init lazily and commit a baseline so
# the SPA gets a real project context AND `git diff` shows the
# user's edits relative to "what was last applied". Any commit
# author config writes go to /root/.gitconfig, which is in the
# persistent home (symlinked above), so they survive rebuilds.
cd "$WORKSPACE_DIR"
if [ ! -d .git ]; then
    echo "[init] git init workspace..."
    git -c init.defaultBranch=main init -q
    git config user.email "opencode@ha-addon.local"
    git config user.name  "ha-opencode-addon"
    # .gitignore prevents the HA database etc. from showing in the
    # SPA's diff view if they ever leak in (defensive — rsync
    # already excludes them).
    cat > .gitignore <<'EOF'
home-assistant_v2.db
home-assistant_v2.db-shm
home-assistant_v2.db-wal
.storage/
.cloud/
deps/
__pycache__/
tts/
.HA_VERSION
EOF
    git add -A
    git -c commit.gpgsign=false commit -q -m "ha-opencode-addon: workspace baseline" || true
    echo "[init] Workspace git baseline created"
fi

# AGENTS.md: opencode's default project context file. Drop a tiny
# one in so the agent has a hint about WHERE it is (HA config) and
# WHAT the apply mechanism is. Keep it boring — anything more
# elaborate becomes a maintenance burden for us.
if [ ! -f AGENTS.md ]; then
    cat > AGENTS.md <<'EOF'
# Home Assistant config workspace

This directory is a sandboxed copy of the user's Home Assistant `/config`.
Edit YAML/JSON/Python files here as you would normally.

When the user clicks **Apply** in the guardian banner, your edits get
copied into the live `/config` directory and HA reloads. If anything
breaks, the guardian auto-reverts after the configured timeout.

Files like `home-assistant_v2.db`, `.storage/`, `.cloud/`, etc. are
managed by Home Assistant itself and are intentionally NOT in this
workspace — don't try to create them.
EOF
    git add AGENTS.md 2>/dev/null || true
    git -c commit.gpgsign=false commit -q -m "Add AGENTS.md" 2>/dev/null || true
fi

export WORKSPACE_DIR
export HA_CONFIG_DIR=/config

# ----------------------------------------------------------
# 5. Start the guardian (which manages OpenCode + safety)
# ----------------------------------------------------------
echo "[init] Starting guardian server..."
cd /opt/guardian
exec node server.js
