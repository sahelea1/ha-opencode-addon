FROM node:20-alpine

# System dependencies
# - git: required by OpenCode for file snapshots/undo
# - bash: for run.sh
# - rsync: for efficient config backup/restore
# - jq: for parsing add-on options JSON
# - curl: for HA Supervisor API calls and OpenCode install
RUN apk add --no-cache git bash rsync jq curl

# Install OpenCode globally via npm
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

WORKDIR /config
CMD ["/run.sh"]
