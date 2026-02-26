# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install gog CLI (Google Workspace) - linux/arm64 binary
RUN curl -sL "https://github.com/steipete/gogcli/releases/download/v0.11.0/gogcli_0.11.0_linux_arm64.tar.gz" \
    | tar -xz -C /usr/local/bin/ gog && chmod +x /usr/local/bin/gog

# Install mcporter (MCP CLI generator)
RUN npm install -g mcporter

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Sources env from mounted /workspace/env-dir/env if it exists (workaround for Apple Container -i bug)
# Stdin is buffered to /tmp then piped (Apple Container requires EOF to flush stdin pipe)
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
# Configure gog to use file-based keyring (no system keyring in container)
RUN mkdir -p /home/node/.config/gogcli
ENV GOG_KEYRING_BACKEND=file

RUN printf '#!/bin/bash\nset -e\n[ -f /workspace/env-dir/env ] && export $(cat /workspace/env-dir/env | xargs)\nexport GOG_KEYRING_BACKEND=file\nif [ -f /home/node/.config/gogcli/marketing-token.json ]; then\n  gog auth credentials set /home/node/.config/gogcli/credentials.json 2>/dev/null || true\n  gog auth tokens import /home/node/.config/gogcli/marketing-token.json 2>/dev/null || true\nfi\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
