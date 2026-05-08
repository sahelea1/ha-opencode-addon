#!/usr/bin/env bash
set -eo pipefail

echo "========================================"
echo "  OpenCode HA Add-on Starting"
echo "========================================"

# ----------------------------------------------------------
# 1. Persistence — symlink OpenCode data dirs to /data
#    /data is the add-on's persistent volume (survives restarts and
#    rebuilds). API keys, provider selection, login state, and any
#    other config the user enters in the OpenCode UI live in these
#    dirs and persist automatically.
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

# ----------------------------------------------------------
# 3. Initialize git in /config for change tracking (if needed)
# ----------------------------------------------------------
cd /config
if [ ! -d ".git" ]; then
    git init --quiet
    git config user.email "guardian@opencode-addon"
    git config user.name "Config Guardian"
    echo "[init] Initialized git in /config"
fi

# ----------------------------------------------------------
# 4. Start the guardian server (manages OpenCode + safety)
# ----------------------------------------------------------
echo "[init] Starting guardian server..."
cd /opt/guardian
exec node server.js
