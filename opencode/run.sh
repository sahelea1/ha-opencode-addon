#!/usr/bin/env bash
set -eo pipefail

echo "========================================"
echo "  OpenCode HA Add-on Starting"
echo "========================================"

# ----------------------------------------------------------
# 1. Persistence — symlink OpenCode data dirs to /data
#    /data is the add-on's persistent volume (survives restarts)
# ----------------------------------------------------------
mkdir -p /data/opencode-config
mkdir -p /data/opencode-share
mkdir -p /data/last-known-good
mkdir -p /root/.config
mkdir -p /root/.local/share

ln -sfn /data/opencode-config /root/.config/opencode
ln -sfn /data/opencode-share  /root/.local/share/opencode

echo "[init] Persistent storage linked"

# ----------------------------------------------------------
# 2. Read add-on options from /data/options.json
# ----------------------------------------------------------
OPTIONS_FILE="/data/options.json"
if [ -f "$OPTIONS_FILE" ]; then
    ANTHROPIC_KEY=$(jq -r '.ANTHROPIC_API_KEY // empty' "$OPTIONS_FILE")
    OPENAI_KEY=$(jq -r '.OPENAI_API_KEY // empty' "$OPTIONS_FILE")
    PROVIDER=$(jq -r '.provider // "anthropic"' "$OPTIONS_FILE")
    TIMEOUT_MIN=$(jq -r '.confirm_timeout_minutes // 10' "$OPTIONS_FILE")

    [ -n "$ANTHROPIC_KEY" ] && export ANTHROPIC_API_KEY="$ANTHROPIC_KEY"
    [ -n "$OPENAI_KEY" ]    && export OPENAI_API_KEY="$OPENAI_KEY"

    echo "[init] Provider: ${PROVIDER}"
    echo "[init] Confirm timeout: ${TIMEOUT_MIN} minutes"
else
    PROVIDER="anthropic"
    TIMEOUT_MIN=10
    echo "[init] No options file found, using defaults"
fi

export GUARDIAN_TIMEOUT_MIN="$TIMEOUT_MIN"

# ----------------------------------------------------------
# 3. Create minimal OpenCode config if none exists
# ----------------------------------------------------------
OC_CONFIG="/data/opencode-config/opencode.json"
if [ ! -f "$OC_CONFIG" ]; then
    cat > "$OC_CONFIG" << EOF
{
  "provider": "${PROVIDER}"
}
EOF
    echo "[init] Created initial opencode.json"
fi

# ----------------------------------------------------------
# 4. Initialize git in /config for change tracking (if needed)
# ----------------------------------------------------------
cd /config
if [ ! -d ".git" ]; then
    git init --quiet
    git config user.email "guardian@opencode-addon"
    git config user.name "Config Guardian"
    echo "[init] Initialized git in /config"
fi

# ----------------------------------------------------------
# 5. Start the guardian server (manages OpenCode + safety)
# ----------------------------------------------------------
echo "[init] Starting guardian server..."
cd /opt/guardian
exec node server.js
