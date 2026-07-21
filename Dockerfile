# Dockerfile — Phase 2 FTN phone-enrichment service (Railway)
#
# Node 20 + Chromium system dependencies + playwright-core.
# Runs ftn_enrichment.js through railway-entrypoint-ftn.sh.
#
# The entrypoint:
#   - Configures HOME and temporary directories on the Railway volume
#   - Builds DATABASE_URL from DB_* variables
#   - Starts Xvfb on display :99
#   - Verifies Chrome dependencies
#   - Runs node ftn_enrichment.js

FROM node:20-bookworm-slim

# Avoid interactive prompts during apt operations.
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV DISPLAY=:99
ENV RAILWAY_VOLUME_PATH=/data

# ----------------------------------------------------------------------------
# System dependencies
# ----------------------------------------------------------------------------
RUN apt-get update -qq && apt-get install -y --no-install-recommends -qq \
        xvfb \
        xauth \
        fonts-liberation \
        fonts-dejavu-core \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libglib2.0-0 \
        libgtk-3-0 \
        libnss3 \
        libpango-1.0-0 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxcursor1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxi6 \
        libxrandr2 \
        libxrender1 \
        libxss1 \
        libxtst6 \
        ca-certificates \
        curl \
        gnupg \
        tini \
        wget \
    && rm -rf /var/lib/apt/lists/*

# ----------------------------------------------------------------------------
# Install Google Chrome so channel: "chrome" resolves in Playwright.
# ----------------------------------------------------------------------------
RUN wget -qO - https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update -qq \
    && apt-get install -y --no-install-recommends -qq \
        google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# ----------------------------------------------------------------------------
# Application dependencies
# ----------------------------------------------------------------------------
WORKDIR /app

COPY package*.json ./

# Use the existing package.json when present.
# Otherwise, create a minimal package.json with the required dependencies.
RUN if [ -f package.json ]; then \
        if [ -f package-lock.json ]; then \
            npm ci --omit=dev --no-audit --no-fund; \
        else \
            npm install --omit=dev --no-audit --no-fund; \
        fi; \
    else \
        printf '%s\n' \
        '{"name":"ftn-enrichment-phase2","version":"1.0.0","private":true,"dependencies":{"pg":"^8.11.3","playwright-core":"^1.43.0","dotenv":"^16.4.5"}}' \
        > package.json \
        && npm install --omit=dev --no-audit --no-fund; \
    fi

# Install the Playwright Chromium binary as a fallback.
# The script can still use system Google Chrome with channel: "chrome".
RUN npx --yes playwright-core install chromium || \
    npx --yes playwright install chromium || true

# ----------------------------------------------------------------------------
# Copy the enrichment script and Railway entrypoint
# ----------------------------------------------------------------------------
COPY ftn_enrichment.js ./
COPY railway-entrypoint-ftn.sh ./

RUN chmod +x /app/railway-entrypoint-ftn.sh

# ----------------------------------------------------------------------------
# Create the volume mount directory.
#
# Do not add a Docker VOLUME instruction here. The Railway volume is configured
# in Railway and mounted to /data when the service starts.
# ----------------------------------------------------------------------------
RUN mkdir -p /data

# Use tini as PID 1 for signal handling and zombie-process cleanup.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/railway-entrypoint-ftn.sh"]