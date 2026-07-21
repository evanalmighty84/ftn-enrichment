# Dockerfile — Phase 2 FTN phone-enrichment service (Railway)
#
# Node 20 + chromium system deps + playwright-core. Runs the proven
# ftn_enrichment.js via railway-entrypoint-ftn.sh (Xvfb + chromium, no Multilogin).
#
# The ENTRYPOINT is the shell script, which sets up HOME/TMPDIR on the Railway
# volume, builds DATABASE_URL from DB_* vars, starts Xvfb on :99, verifies
# chromium deps, then execs `node ftn_enrichment.js`.

FROM node:20-bookworm-slim

# Avoid interactive prompts during apt operations.
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    # Default display for the Xvfb virtual framebuffer (entrypoint starts Xvfb).
    DISPLAY=:99 \
    # Default Railway volume mount point. Override with RAILWAY_VOLUME_PATH.
    RAILWAY_VOLUME_PATH=/data

# ----------------------------------------------------------------------------
# System deps:
#  - xvfb: virtual framebuffer for headless chromium launched via
#    playwright-core launchPersistentContext (channel:"chrome", headless:false)
#  - chromium runtime libs (nss, gtk, glib, fonts, etc.)
#  - ca-certificates, curl, tini (init), fonts
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
        tini \
    && rm -rf /var/lib/apt/lists/*

# ----------------------------------------------------------------------------
# Install Google Chrome so `channel:"chrome"` in the script resolves. The
# proven script launches Chrome (not bundled Chromium), so we mirror the
# local Mac environment where it was validated.
# ----------------------------------------------------------------------------
RUN apt-get update -qq && apt-get install -y --no-install-recommends -qq gnupg wget \
    && wget -qO - https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update -qq \
    && apt-get install -y --no-install-recommends -qq google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# ----------------------------------------------------------------------------
# App + dependencies. playwright-core is the only runtime dep (the script uses
# `require("playwright-core")` and `require("pg")`). dotenv is used for local
# .env loading; harmless when absent in production.
# ----------------------------------------------------------------------------
WORKDIR /app

COPY package.json* package-lock.json* ./
# If a package.json is provided, install from it; otherwise create a minimal
# one with the two runtime deps so the image is self-contained.
RUN if [ -f package.json ]; then \
        npm install --omit=dev --no-audit --no-fund; \
    else \
        printf '{"name":"ftn-enrichment-phase2","version":"1.0.0","private":true,"dependencies":{"pg":"^8.11.3","playwright-core":"^1.43.0","dotenv":"^16.4.5"}}' > package.json && \
        npm install --omit=dev --no-audit --no-fund; \
    fi

# Install the chromium browser binary that playwright-core will launch. The
# system libs above satisfy its shared-library dependencies.
RUN npx --yes playwright-core install chromium || \
    npx --yes playwright install chromium || true

# ----------------------------------------------------------------------------
# Copy the enrichment script + entrypoint.
# ----------------------------------------------------------------------------
COPY ftn_enrichment.js ./
COPY railway-entrypoint-ftn.sh ./
RUN chmod +x railway-entrypoint-ftn.sh

# ----------------------------------------------------------------------------
# Railway volume mount point for the persistent browser profile.
# The entrypoint sets HOME/XDG_RUNTIME_DIR/TMPDIR under /data so the
# launchPersistentContext userDataDir (derived from os.tmpdir()) survives
# restarts. Declare the volume so Railway mounts it here by default.
# ----------------------------------------------------------------------------
RUN mkdir -p /data
VOLUME ["/data"]

# Use tini as PID 1 so signal handling / zombie reaping works correctly.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/railway-entrypoint-ftn.sh"]
