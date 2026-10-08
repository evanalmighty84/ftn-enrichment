#!/usr/bin/env bash
#
# railway-entrypoint-ftn.sh — Phase 2 FTN phone-enrichment entrypoint for Railway.
#
# Smartproxy is reached directly through playwright-core's
# launchPersistentContext. This entrypoint keeps Chromium's disposable state
# out of the Railway volume, verifies Chrome, then starts a dedicated Xvfb
# display for the headed Playwright worker.
#
set -Eeuo pipefail

# --- logging helpers ---------------------------------------------------------
log()  { printf '[ftn-entrypoint %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
err()  { printf '[ftn-entrypoint %s] ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

trap 'rc=$?; err "entrypoint failed (exit $rc) on line $LINENO"; exit $rc' ERR

log "starting Phase 2 FTN enrichment entrypoint"

# ----------------------------------------------------------------------------
# 1. Runtime directories + stale-process cleanup
# ----------------------------------------------------------------------------
RAILWAY_VOLUME="${RAILWAY_VOLUME_PATH:-/data}"

if [ ! -d "${RAILWAY_VOLUME}" ]; then
    log "Railway volume ${RAILWAY_VOLUME} not present; continuing without it"
fi

export HOME="${HOME:-/root}"
export TMPDIR="/tmp/ftn"
export TMP="${TMPDIR}"
export TEMP="${TMPDIR}"
export XDG_RUNTIME_DIR="/tmp/ftn-xdg"
export XDG_CACHE_HOME="/tmp/ftn-cache"

log "HOME=${HOME}"
log "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}"
log "TMPDIR=${TMPDIR}"
log "XDG_CACHE_HOME=${XDG_CACHE_HOME}"

# A Railway restart can reuse the same writable container filesystem. That means
# /tmp is not guaranteed to be empty. FTN profiles are disposable, so clear
# them before creating a fresh runtime. Also terminate Chromium/Xvfb processes
# left behind by a previous crashed trigger-server instance in this container.
log "Cleaning stale FTN Chromium/Xvfb runtime before startup..."

pkill -TERM -x Xvfb 2>/dev/null || true
pkill -TERM -f '/opt/google/chrome/chrome|/usr/bin/google-chrome|google-chrome-stable|/usr/bin/chromium|chromium-browser' 2>/dev/null || true
sleep 1
pkill -KILL -x Xvfb 2>/dev/null || true
pkill -KILL -f '/opt/google/chrome/chrome|/usr/bin/google-chrome|google-chrome-stable|/usr/bin/chromium|chromium-browser' 2>/dev/null || true

if [ -d "${TMPDIR}" ]; then
    log "/tmp FTN usage BEFORE cleanup:"
    du -sh "${TMPDIR}" 2>/dev/null || true
fi

rm -rf \
    "${TMPDIR}" \
    "${XDG_RUNTIME_DIR}" \
    "${XDG_CACHE_HOME}" \
    /tmp/ftn-chrome-smoke \
    /tmp/ftn-chrome-smoke.out \
    /tmp/ftn-chrome-smoke.err \
    /tmp/xvfb.log \
    /tmp/.X99-lock \
    2>/dev/null || true

mkdir -p \
    "${TMPDIR}" \
    "${XDG_RUNTIME_DIR}" \
    "${XDG_CACHE_HOME}"

chmod 700 "${XDG_RUNTIME_DIR}" 2>/dev/null || true

log "/tmp FTN usage AFTER cleanup:"
du -sh "${TMPDIR}" 2>/dev/null || true

# ----------------------------------------------------------------------------
# Storage diagnostics
# ----------------------------------------------------------------------------
log "============================================================"
log "FTN STORAGE CHECK"
log "============================================================"

log "Filesystem usage:"
df -h 2>/dev/null || true

if [ -d /data ]; then
    log "/data total usage:"
    du -sh /data 2>/dev/null || true
fi

if [ -d /data/ftn ]; then
    log "/data/ftn usage BEFORE stale-profile cleanup:"
    du -sh /data/ftn 2>/dev/null || true

    log "Largest items currently in /data/ftn:"
    du -sh /data/ftn/* 2>/dev/null \
        | sort -h \
        | tail -20 \
        || true

    log "Removing stale FTN Chromium worker profiles from persistent storage..."
    rm -rf /data/ftn/ftn-worker-* 2>/dev/null || true
    rm -f /data/ftn/ftn-batch-*.json 2>/dev/null || true

    log "/data/ftn usage AFTER stale-profile cleanup:"
    du -sh /data/ftn 2>/dev/null || true
fi

log "============================================================"

# ----------------------------------------------------------------------------
# 2. Build DATABASE_URL from DB_* vars if not already set
# ----------------------------------------------------------------------------
if [ -z "${DATABASE_URL:-}" ]; then
    if [ -n "${DB_USER:-}" ] && [ -n "${DB_HOST:-}" ] && [ -n "${DB_NAME:-}" ]; then
        export DATABASE_URL="$(
            node -e '
                const u = encodeURIComponent(process.env.DB_USER || "");
                const p = encodeURIComponent(process.env.DB_PASSWORD || "");
                const h = process.env.DB_HOST || "";
                const port = process.env.DB_PORT || 5432;
                const n = encodeURIComponent(process.env.DB_NAME || "");
                process.stdout.write(`postgres://${u}:${p}@${h}:${port}/${n}`);
            '
        )"
        log "built DATABASE_URL from DB_* vars (host=${DB_HOST}, db=${DB_NAME}, port=${DB_PORT:-5432})"
    else
        err "DATABASE_URL is not set and DB_USER/DB_HOST/DB_NAME are incomplete; cannot connect to Postgres"
        exit 1
    fi
else
    log "DATABASE_URL already set (using it directly)"
fi

# ----------------------------------------------------------------------------
# 3. Verify / install chromium + system deps
# ----------------------------------------------------------------------------
CHROME_BIN=""
for c in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then
        CHROME_BIN="$(command -v "$c")"
        break
    fi
done

if [ -n "${CHROME_BIN}" ]; then
    log "found chrome/chromium binary: ${CHROME_BIN}"
else
    log "no system chrome found; installing chromium via playwright"
    if command -v npx >/dev/null 2>&1; then
        npx --yes playwright-core install chromium || \
            npx --yes playwright install chromium || true
    else
        log "npx unavailable — ensure chromium is installed in the image"
    fi
fi

if command -v apt-get >/dev/null 2>&1; then
    log "ensuring chromium runtime deps via apt-get (best-effort)"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null 2>&1 || true
    apt-get install -y --no-install-recommends -qq \
        fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
        libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 \
        libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
        libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
        libxrender1 libxss1 libxtst6 ca-certificates >/dev/null 2>&1 || true
fi

# ----------------------------------------------------------------------------
# 3b. Headless Chrome smoke test. This deliberately runs BEFORE Xvfb because
#     --headless=new does not need an X server. It prevents the diagnostic test
#     from interacting with the display process used by the real worker.
# ----------------------------------------------------------------------------
test_chrome() {
    [ -n "${CHROME_BIN:-}" ] || { log "chrome smoke test skipped (no binary found)"; return 0; }

    log "===== CHROME SMOKE TEST ====="
    local profile="/tmp/ftn-chrome-smoke"
    rm -rf "$profile"; mkdir -p "$profile"
    local out="/tmp/ftn-chrome-smoke.out" errf="/tmp/ftn-chrome-smoke.err"
    local code=0

    timeout 12s "$CHROME_BIN" \
        --headless=new \
        --no-sandbox \
        --disable-setuid-sandbox \
        --disable-dev-shm-usage \
        --disable-gpu \
        --user-data-dir="$profile" \
        --remote-debugging-port=9223 \
        about:blank >"$out" 2>"$errf" || code=$?

    log "smoke-test exit code: ${code}"
    log "--- chrome stdout ---"; sed -n '1,40p' "$out" 2>/dev/null || true
    log "--- chrome stderr ---"; sed -n '1,40p' "$errf" 2>/dev/null || true

    if [ "$code" -eq 124 ]; then
        log "chrome stayed alive for 12s (sandbox/shm flags effective)"
    elif [ "$code" -eq 0 ]; then
        log "chrome launched and exited cleanly"
    else
        log "chrome exited with code ${code} (see stderr above)"
    fi

    if command -v ldd >/dev/null 2>&1; then
        local missing
        missing="$(ldd "$CHROME_BIN" 2>/dev/null | grep "not found" || true)"
        if [ -n "$missing" ]; then
            log "--- missing shared libraries ---"
            printf '%s\n' "$missing"
        else
            log "ldd reports no missing libraries"
        fi
    fi

    # The smoke-test profile is disposable. Do not let repeated Railway
    # restarts accumulate hundreds of MB/GB under /tmp.
    rm -rf "$profile" "$out" "$errf" 2>/dev/null || true

    log "==============================="
    return 0
}

test_chrome

# ----------------------------------------------------------------------------
# 4. Start Xvfb only after all package work and the headless smoke test finish.
# ----------------------------------------------------------------------------
export DISPLAY="${DISPLAY:-:99}"
XVFB_LOG="/tmp/xvfb.log"
XVFB_PID=""

start_xvfb() {
    if ! command -v Xvfb >/dev/null 2>&1; then
        err "Xvfb is not installed; headed Playwright cannot run on DISPLAY=${DISPLAY}"
        return 1
    fi

    rm -f "$XVFB_LOG" /tmp/.X99-lock 2>/dev/null || true

    log "starting Xvfb on DISPLAY=${DISPLAY}"
    Xvfb "${DISPLAY}" \
        -ac \
        -screen 0 1280x1024x24 \
        -nolisten tcp \
        -noreset \
        >"$XVFB_LOG" 2>&1 &

    XVFB_PID=$!

    for _ in 1 2 3 4 5 6 7 8 9 10; do
        if kill -0 "$XVFB_PID" 2>/dev/null; then
            sleep 0.3
            if kill -0 "$XVFB_PID" 2>/dev/null; then
                log "Xvfb started and is alive (pid ${XVFB_PID})"
                return 0
            fi
        fi
        sleep 0.3
    done

    err "Xvfb failed to remain alive during startup."
    log "===== ${XVFB_LOG} ====="
    cat "$XVFB_LOG" 2>/dev/null || true
    log "======================="
    return 1
}

start_xvfb

# ----------------------------------------------------------------------------
# 5. Runtime diagnostics + exec the trigger server
# ----------------------------------------------------------------------------
log "runtime diagnostics:"
log "  node:    $(node --version 2>/dev/null || echo 'missing')"
log "  npm:     $(npm --version 2>/dev/null || echo 'missing')"
log "  DISPLAY: ${DISPLAY}"
log "  Xvfb PID: ${XVFB_PID}"
log "  WORKER_COUNT env: ${FTN_WORKER_COUNT:-<unset -> min(PROXY_POOL,3)>}"
log "  proxy pool: ${FTN_PROXIES:-204.77.129.143,207.228.200.92,23.231.0.74}"
log "  /tmp FTN usage before server: $(du -sh "${TMPDIR}" 2>/dev/null | awk '{print $1}' || echo unknown)"

cd "$(dirname "$0")"

log "exec node ftn-trigger-server.js"
echo "🌐 Starting FTN trigger server..."

# Keep the endpoint alive if Xvfb dies unexpectedly: dump the reason, restart
# the display, and only terminate the container if Xvfb cannot be restarted.
(
    while true; do
        sleep 10

        if ! kill -0 "$XVFB_PID" 2>/dev/null; then
            err "Xvfb process ${XVFB_PID} died."
            log "===== ${XVFB_LOG} ====="
            cat "$XVFB_LOG" 2>/dev/null || true
            log "======================="

            log "Attempting to restart Xvfb without dropping the FTN HTTP endpoint..."

            if start_xvfb; then
                log "Xvfb restart succeeded (pid ${XVFB_PID})."
                continue
            fi

            err "Xvfb restart failed; stopping trigger server so Railway can replace the container."
            kill -TERM "$$" 2>/dev/null || true
            exit 1
        fi
    done
) &

XVFB_WATCHDOG_PID=$!
log "Xvfb watchdog started (pid ${XVFB_WATCHDOG_PID})"

exec node /app/ftn-trigger-server.js
