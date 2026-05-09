FROM node:20-slim

# Debian (glibc) — the upstream OpenCode binary is glibc-only, so we
# can't use alpine here.
#
# - rsync: backup/restore /config <-> /data/last-known-good
# - jq:    parse /data/options.json
# - curl + ca-certificates + unzip: the OpenCode installer script
#   downloads + unpacks the platform binary from GitHub releases
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    rsync \
    jq \
    curl \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install OpenCode using the official installer (drops binary into
# /root/.opencode/bin). Using `npm install -g opencode-ai` was unreliable
# because its postinstall didn't always land the platform binary.
RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH="/root/.opencode/bin:${PATH}"

# Guardian dependencies
WORKDIR /opt/guardian
COPY guardian/package.json ./
RUN npm install --production

COPY guardian/ ./

COPY run.sh /run.sh
RUN chmod +x /run.sh

LABEL \
    io.hass.version="1.15.0" \
    io.hass.type="addon" \
    io.hass.arch="aarch64|amd64"

# WORKDIR is set inside run.sh after the workspace is initialized.
CMD ["/run.sh"]
