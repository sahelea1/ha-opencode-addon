FROM node:20-slim

# System dependencies
# - git: required by OpenCode for file snapshots/undo
# - rsync: for efficient config backup/restore
# - jq: for parsing add-on options JSON
# - curl + ca-certificates: HTTPS to opencode.ai installer
# - unzip: the OpenCode installer extracts a release zip
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    rsync \
    jq \
    curl \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install OpenCode using the official installer.
# It downloads the prebuilt platform binary directly from GitHub
# releases, avoiding the broken npm postinstall path.
RUN curl -fsSL https://opencode.ai/install | bash

# Installer drops the binary into ~/.opencode/bin — make it discoverable.
ENV PATH="/root/.opencode/bin:${PATH}"

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
    io.hass.version="1.4.0" \
    io.hass.type="addon" \
    io.hass.arch="aarch64|amd64"

WORKDIR /config
CMD ["/run.sh"]
