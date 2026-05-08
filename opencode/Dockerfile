FROM node:20-slim

# System dependencies
# - git: required by OpenCode for file snapshots/undo
# - rsync: for efficient config backup/restore
# - jq: for parsing add-on options JSON
# - curl: for HA Supervisor API calls
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    rsync \
    jq \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install OpenCode globally via npm
# node:20-slim is Debian/glibc — avoids the known musl/Alpine postinstall hang
RUN npm install -g opencode-ai

# Install guardian dependencies
WORKDIR /opt/guardian
COPY guardian/package.json ./
RUN npm install --production

# Copy guardian application
COPY guardian/ ./

# Copy startup script
COPY run.sh /run.sh
RUN chmod +x /run.sh

LABEL \
    io.hass.version="1.0.0" \
    io.hass.type="addon" \
    io.hass.arch="aarch64|amd64"

WORKDIR /config
CMD ["/run.sh"]
