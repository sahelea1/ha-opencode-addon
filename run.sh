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
# 2. Read add-on options — provider preset/API keys + guardian timeout
# ----------------------------------------------------------
OPTIONS_FILE="/data/options.json"
PROVIDER="anthropic"
ANTHROPIC_KEY=""
OPENAI_KEY=""
OPENROUTER_KEY=""

if [ -f "$OPTIONS_FILE" ]; then
    PROVIDER=$(jq -r '.provider // "anthropic"' "$OPTIONS_FILE")
    ANTHROPIC_KEY=$(jq -r '.ANTHROPIC_API_KEY // empty' "$OPTIONS_FILE")
    OPENAI_KEY=$(jq -r '.OPENAI_API_KEY // empty' "$OPTIONS_FILE")
    OPENROUTER_KEY=$(jq -r '.OPENROUTER_API_KEY // empty' "$OPTIONS_FILE")
    TIMEOUT_MIN=$(jq -r '.confirm_timeout_minutes // 10' "$OPTIONS_FILE")
    [ -n "$ANTHROPIC_KEY" ] && export ANTHROPIC_API_KEY="$ANTHROPIC_KEY"
    [ -n "$OPENAI_KEY" ] && export OPENAI_API_KEY="$OPENAI_KEY"
    [ -n "$OPENROUTER_KEY" ] && export OPENROUTER_API_KEY="$OPENROUTER_KEY"
    echo "[init] Provider preset: ${PROVIDER}"
    echo "[init] Confirm timeout: ${TIMEOUT_MIN} minutes"
else
    TIMEOUT_MIN=10
    echo "[init] No options file found, using defaults"
fi

export GUARDIAN_TIMEOUT_MIN="$TIMEOUT_MIN"

OC_CONFIG="/data/opencode-config/opencode.json"
write_default_opencode_config() {
    cat > "$OC_CONFIG" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "anthropic": {},
    "openai": {},
    "openrouter": {}
  }
}
EOF
}

if [ ! -f "$OC_CONFIG" ]; then
    write_default_opencode_config
    echo "[init] Created OpenCode provider preset config"
elif jq -e '(.provider | type) == "string"' "$OC_CONFIG" >/dev/null 2>&1; then
    LEGACY_PROVIDER=$(jq -r '.provider' "$OC_CONFIG")
    cp "$OC_CONFIG" "${OC_CONFIG}.legacy.$(date +%s)"
    TMP_CONFIG="${OC_CONFIG}.tmp"
    jq 'del(.provider) + {provider: {anthropic: {}, openai: {}, openrouter: {}}}' "$OC_CONFIG" > "$TMP_CONFIG"
    mv "$TMP_CONFIG" "$OC_CONFIG"
    echo "[init] Migrated legacy OpenCode provider preset: ${LEGACY_PROVIDER}"
fi

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
fi

# ----------------------------------------------------------
# 4. Start the guardian server (manages OpenCode + safety)
# ----------------------------------------------------------
echo "[init] Starting guardian server..."
cd /opt/guardian
exec node server.js
