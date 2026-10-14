# Dockerfile — Phase 2 FTN phone-enrichment service (Railway)
#
# Node 20 + Chromium system dependencies + playwright-core.
#
# The entrypoint:
#   - Configures HOME and temporary directories on the Railway volume
#   - Builds DATABASE_URL from DB_* variables
#   - Starts Xvfb on display :99
#   - Verifies Chrome dependencies
#   - Starts ftn-trigger-server.js
#
# Workflow:
#   POST /run
#       -> pre_enrichment.js
#       -> ftn_enrichment.js
#       -> chamber_lead_digest.js

FROM node:20-bookworm-slim


# ----------------------------------------------------------------------------
# Runtime environment
# ----------------------------------------------------------------------------

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV DISPLAY=:99
ENV RAILWAY_VOLUME_PATH=/data


# ----------------------------------------------------------------------------
# System dependencies
# ----------------------------------------------------------------------------

RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends -qq \
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
# Install Google Chrome.
#
# ftn_enrichment.js can use the system Chrome installation through Playwright.
# ----------------------------------------------------------------------------

RUN wget -qO - https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo \
        "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update -qq \
    && apt-get install -y --no-install-recommends -qq \
        google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*


# ----------------------------------------------------------------------------
# Application directory
# ----------------------------------------------------------------------------

WORKDIR /app


# ----------------------------------------------------------------------------
# Node dependencies
# ----------------------------------------------------------------------------

COPY package*.json ./


# Use package-lock.json when available.
#
# If package.json somehow does not exist, create a minimal package containing
# the dependencies required by this service.
# ----------------------------------------------------------------------------

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


# ----------------------------------------------------------------------------
# Install Playwright Chromium as a fallback.
#
# The application normally uses system Google Chrome, but this gives us a
# fallback browser binary if required.
# ----------------------------------------------------------------------------

RUN npx --yes playwright-core install chromium \
    || npx --yes playwright install chromium \
    || true


# ----------------------------------------------------------------------------
# Copy application scripts
# ----------------------------------------------------------------------------

COPY pre_enrichment.js ./
COPY ftn_enrichment.js ./

# Shared canonical lead types used by pre_enrichment.js and Chamber tooling.
COPY lead_types.js ./

# Chamber tools.
COPY chamber_classify.js ./
COPY chamber_lead_digest.js ./

# FTN trigger / support scripts.
COPY fix-ftn-location-fallback.js ./
COPY ftn-trigger-server.js ./
COPY railway-entrypoint-ftn.sh ./

# Neighborhood/location data.
COPY mckinney_neighborhoods_polygons.json ./


# ----------------------------------------------------------------------------
# Verify required files were actually copied into the Docker image.
#
# This catches missing COPY statements during the Railway build instead of
# waiting until POST /run fails in production.
# ----------------------------------------------------------------------------

RUN test -f /app/pre_enrichment.js \
    && test -f /app/ftn_enrichment.js \
    && test -f /app/lead_types.js \
    && test -f /app/chamber_classify.js \
    && test -f /app/chamber_lead_digest.js \
    && test -f /app/ftn-trigger-server.js \
    && test -f /app/railway-entrypoint-ftn.sh \
    && test -f /app/mckinney_neighborhoods_polygons.json \
    && echo "All FTN and Chamber application files copied successfully."


# ----------------------------------------------------------------------------
# Revert the unsafe direct-text city fallback introduced on Sept. 30.
#
# FTN requires a real autocomplete selection; merely retaining "City, ST"
# in the textbox does not prove the site's underlying location was selected.
# ----------------------------------------------------------------------------

RUN node /app/fix-ftn-location-fallback.js


# ----------------------------------------------------------------------------
# Node syntax checks.
#
# If one of these scripts contains invalid JavaScript, Railway will fail the
# build immediately instead of deploying a broken container.
# ----------------------------------------------------------------------------

RUN node --check /app/pre_enrichment.js \
    && node --check /app/ftn_enrichment.js \
    && node --check /app/lead_types.js \
    && node --check /app/chamber_classify.js \
    && node --check /app/chamber_lead_digest.js \
    && node --check /app/ftn-trigger-server.js


# ----------------------------------------------------------------------------
# Verify lead_types.js can actually be required.
#
# This specifically protects against the MODULE_NOT_FOUND problem we just had.
# ----------------------------------------------------------------------------

RUN node -e "\
const { ALLOWED_LEAD_TYPES } = require('/app/lead_types'); \
if (!Array.isArray(ALLOWED_LEAD_TYPES) || ALLOWED_LEAD_TYPES.length === 0) { \
    throw new Error('ALLOWED_LEAD_TYPES failed to load'); \
} \
console.log('Loaded', ALLOWED_LEAD_TYPES.length, 'allowed lead types'); \
"


# ----------------------------------------------------------------------------
# Polygon diagnostics
# ----------------------------------------------------------------------------

RUN echo "Polygon file copied successfully" \
    && ls -lh /app/mckinney_neighborhoods_polygons.json


# ----------------------------------------------------------------------------
# Make Railway entrypoint executable
# ----------------------------------------------------------------------------

RUN chmod +x /app/railway-entrypoint-ftn.sh


# ----------------------------------------------------------------------------
# Create persistent-volume mount directory.
#
# Do not add a Docker VOLUME instruction here.
# Railway mounts the configured service volume to /data.
# ----------------------------------------------------------------------------

# ----------------------------------------------------------------------------
# Create persistent-volume mount directory.
#
# Do not add a Docker VOLUME instruction here.
# Railway mounts the configured service volume to /data.
# ----------------------------------------------------------------------------

RUN mkdir -p /data


# ----------------------------------------------------------------------------
# tini = PID 1
#
# Provides reliable signal handling and cleans up zombie Chromium processes.
# ----------------------------------------------------------------------------

ENTRYPOINT ["/usr/bin/tini", "--", "/app/railway-entrypoint-ftn.sh"]