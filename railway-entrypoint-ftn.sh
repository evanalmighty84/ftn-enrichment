#!/usr/bin/env bash
#
# railway-entrypoint-ftn.sh — Phase 2 FTN phone-enrichment entrypoint for Railway.
#
# Mirrors the user's existing Multilogin railway-entrypoint.sh pattern but
# WITHOUT Multilogin: Smartproxy is reached directly through playwright-core's
# launchPersistentContext (the script's own chromium channel), so we only need
# a virtual display + the chromium runtime deps.
#
#   1. keep disposable Chromium runtime/profile data under /tmp, while
#      retaining /data only for truly persistent Railway volume data
#   2. build DATABASE_URL from DB_* vars (node one-liner, bare URL — no
#      sslmode; the script's Pool sets ssl:{rejectUnauthorized:false}) if
#      DATABASE_URL is not already set
#   3. verify / install chromium + its system deps
#   4. start and verify Xvfb on DISPLAY=:99 for headful chromium
#   5. exec the FTN trigger server
#
set -Eeuo pipefail

# --- logging helpers ---------------------------------------------------------
log()  { printf '[ftn-entrypoint %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
err()  { printf '[ftn-entrypoint %s] ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# Bail with a clear message rather than a raw stack trace.
trap 'rc=$?; err "entrypoint failed (exit $rc) on line $LINENO"; exit $rc' ERR

log "starting Phase 2 FTN enrichment entrypoint"

# ----------------------------------------------------------------------------
# 1. Runtime directories
# ----------------------------------------------------------------------------
# The FTN workers create a NEW Chromium userDataDir for every worker/run.
# Those profiles are disposable and must NOT live on the persistent Railway
# volume. Keep them under /tmp so they disappear when the container is replaced.
#
# The Railway volume remains available at /data for anything that truly needs
# persistence, but Chromium worker profiles, caches, and runtime files do not.

RAILWAY_VOLUME="${RAILWAY_VOLUME_PATH:-/data}"

if [ ! -d "${RAILWAY_VOLUME}" ]; then
    log "Railway volume ${RAILWAY_VOLUME} not present; continuing without it"
fi

# HOME may remain the normal container HOME.
export HOME="${HOME:-/root}"

# Chromium / Playwright disposable runtime data. Railway can restart the
# service process while reusing the container filesystem, so /tmp is not
# guaranteed to be empty between entrypoint invocations. Nothing in these
# directories needs to survive a service restart, and stale Chromium profiles
# can leave behind large caches and runtime artifacts.
export TMPDIR="/tmp/ftn"
export TMP="${TMPDIR}"
export TEMP="${TMPDIR}"
export XDG_RUNTIME_DIR="/tmp/ftn-xdg"
export XDG_CACHE_HOME="/tmp/ftn-cache"

log "Clearing stale disposable FTN runtime state from /tmp..."
rm -rf \
    "${TMPDIR}" \
    "${XDG_RUNTIME_DIR}" \
    "${XDG_CACHE_HOME}" \
    /tmp/ftn-chrome-smoke \
    /tmp/ftn-chrome-smoke.out \
    /tmp/ftn-chrome-smoke.err \
    2>/dev/null || true

mkdir -p \
    "${TMPDIR}" \
    "${XDG_RUNTIME_DIR}" \
    "${XDG_CACHE_HOME}"

chmod 700 "${XDG_RUNTIME_DIR}" 2>/dev/null || true

log "HOME=${HOME}"
log "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}"
log "TMPDIR=${TMPDIR}"
log "XDG_CACHE_HOME=${XDG_CACHE_HOME}"

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

    # These directories came from the old configuration where TMPDIR=/data/ftn.
    # A freshly-started trigger-server has no active FTN workers yet, so these
    # are stale disposable browser profiles from previous runs.
    log "Removing stale FTN Chromium worker profiles from persistent storage..."

    rm -rf /data/ftn/ftn-worker-* 2>/dev/null || true
    rm -f /data/ftn/ftn-batch-*.json 2>/dev/null || true

    log "/data/ftn usage AFTER stale-profile cleanup:"
    du -sh /data/ftn 2>/dev/null || true
fi

log "/tmp FTN runtime usage:"
du -sh "${TMPDIR}" 2>/dev/null || true

log "============================================================"

# ----------------------------------------------------------------------------
# 2. Build DATABASE_URL from DB_* vars if not already set
# ----------------------------------------------------------------------------
# Same node one-liner pattern the Multilogin scraper's entrypoint uses:
# compose a plain postgres:// URL from the DB_* vars when DATABASE_URL is
# unset. We deliberately do NOT append ?sslmode=require: in the installed pg
# version sslmode=require is treated as verify-full (see the SECURITY WARNING
# pg emits), which forces full RDS certificate verification and fails with
# "unable to get local issuer certificate" because the container has no
# matching CA. The script's Pool sets ssl:{rejectUnauthorized:false} itself,
# which is what the Phase 1 Heroku backend relies on to connect to this same
# DB — so we leave SSL handling entirely to the script and keep the URL bare.
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
# playwright-core's launchPersistentContext uses channel:"chrome", so we need a
# real chromium/chrome binary plus its shared-library deps. Try (in order):
#   a) system google-chrome / chromium / chromium-browser
#   b) playwright install chromium
# System chromium deps (fonts, nss, etc.) are installed in the Dockerfile; this
# block is a runtime safety net for bare containers.
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

# Best-effort: install missing chromium runtime libs if apt is present. Harmless
# when everything is already installed (errors swallowed).
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
# 4. Start and VERIFY Xvfb on DISPLAY=:99.
#
# FTN runs Playwright with headless:false, so a working X display is mandatory.
# Railway can restart the service process while keeping /tmp around. A prior
# Xvfb can therefore leave /tmp/.X99-lock or /tmp/.X11-unix/X99 behind even
# though no display server is alive. The old entrypoint only checked `pgrep`,
# which could briefly observe a dying Xvfb and incorrectly report success.
# ----------------------------------------------------------------------------
export DISPLAY="${DISPLAY:-:99}"
XVFB_PID=""
XVFB_LOG="/tmp/xvfb.log"
DISPLAY_NUM="${DISPLAY#:}"
DISPLAY_NUM="${DISPLAY_NUM%%.*}"
XVFB_LOCK="/tmp/.X${DISPLAY_NUM}-lock"
XVFB_SOCKET="/tmp/.X11-unix/X${DISPLAY_NUM}"

if ! command -v Xvfb >/dev/null 2>&1; then
    err "Xvfb is required because FTN launches Chrome with headless:false."
    exit 1
fi

# Reuse an already-live Xvfb only when one truly exists. Otherwise remove stale
# display artifacts before binding :99 again.
EXISTING_XVFB_PID="$(pgrep -x Xvfb 2>/dev/null | head -n 1 || true)"
if [ -n "${EXISTING_XVFB_PID}" ] && kill -0 "${EXISTING_XVFB_PID}" 2>/dev/null; then
    XVFB_PID="${EXISTING_XVFB_PID}"
    log "Xvfb already running on DISPLAY=${DISPLAY} (pid ${XVFB_PID})"
else
    log "No live Xvfb found; removing stale display lock/socket for DISPLAY=${DISPLAY}"
    rm -f "${XVFB_LOCK}" "${XVFB_SOCKET}" 2>/dev/null || true
    mkdir -p /tmp/.X11-unix
    chmod 1777 /tmp/.X11-unix 2>/dev/null || true
    : >"${XVFB_LOG}"

    log "starting Xvfb on DISPLAY=${DISPLAY}"
    Xvfb "${DISPLAY}" \
        -ac \
        -screen 0 1280x1024x24 \
        -nolisten tcp \
        -noreset \
        >"${XVFB_LOG}" 2>&1 &
    XVFB_PID=$!

    XVFB_READY=0
    for _ in {1..50}; do
        if ! kill -0 "${XVFB_PID}" 2>/dev/null; then
            err "Xvfb process ${XVFB_PID} exited during startup."
            log "--- ${XVFB_LOG} ---"
            sed -n '1,120p' "${XVFB_LOG}" 2>/dev/null || true
            exit 1
        fi

        if [ -S "${XVFB_SOCKET}" ]; then
            XVFB_READY=1
            break
        fi

        sleep 0.1
    done

    if [ "${XVFB_READY}" -ne 1 ]; then
        err "Xvfb process ${XVFB_PID} stayed alive but DISPLAY=${DISPLAY} never became ready."
        log "--- ${XVFB_LOG} ---"
        sed -n '1,120p' "${XVFB_LOG}" 2>/dev/null || true
        kill -TERM "${XVFB_PID}" 2>/dev/null || true
        exit 1
    fi

    log "Xvfb verified healthy on DISPLAY=${DISPLAY} (pid ${XVFB_PID})"
fi

# ----------------------------------------------------------------------------
# 4b. Chrome smoke test — mirrors the Multilogin entrypoint's mimic smoke test.
#     Launch Chrome headlessly for ~12s to confirm it actually starts on this
#     Linux image. Catches missing shared libraries and sandbox issues with
#     clear logs BEFORE the real enrichment script runs. Diagnostic only.
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
        local missing; missing="$(ldd "$CHROME_BIN" 2>/dev/null | grep "not found" || true)"
        if [ -n "$missing" ]; then
            log "--- missing shared libraries ---"; printf '%s\n' "$missing"
        else
            log "ldd reports no missing libraries"
        fi
    fi

    # `timeout` normally tears down the Chrome process group, but explicitly
    # remove any smoke-test process/profile that survived so startup diagnostics
    # cannot consume FTN's later process/thread budget.
    if command -v pkill >/dev/null 2>&1; then
        pkill -TERM -f -- "--user-data-dir=${profile}" 2>/dev/null || true
        sleep 0.2
        pkill -KILL -f -- "--user-data-dir=${profile}" 2>/dev/null || true
    fi
    rm -rf "$profile" 2>/dev/null || true

    log "==============================="
    return 0
}
test_chrome

# ----------------------------------------------------------------------------
# 5. Runtime diagnostics + exec the enrichment script
# ----------------------------------------------------------------------------
log "runtime diagnostics:"
log "  node:    $(node --version 2>/dev/null || echo 'missing')"
log "  npm:     $(npm --version 2>/dev/null || echo 'missing')"
log "  DISPLAY: ${DISPLAY}"
log "  WORKER_COUNT env: ${FTN_WORKER_COUNT:-<unset -> min(PROXY_POOL,3)>}"
log "  proxy pool: ${FTN_PROXIES:-207.228.202.97,207.228.200.57,107.158.19.135}"
log "  process count: $(ps -e --no-headers 2>/dev/null | wc -l | tr -d ' ' || echo unknown)"
log "  thread count:  $(ps -eLf --no-headers 2>/dev/null | wc -l | tr -d ' ' || echo unknown)"
log "  ulimit -u:     $(ulimit -u 2>/dev/null || echo unknown)"
if [ -r /sys/fs/cgroup/pids.current ]; then
    log "  cgroup pids.current: $(cat /sys/fs/cgroup/pids.current 2>/dev/null || echo unknown)"
fi
if [ -r /sys/fs/cgroup/pids.max ]; then
    log "  cgroup pids.max:     $(cat /sys/fs/cgroup/pids.max 2>/dev/null || echo unknown)"
fi

cd "$(dirname "$0")"

log "exec node ftn-trigger-server.js"
echo "🌐 Starting FTN trigger server..."


(
    while true; do
        sleep 10

        if ! kill -0 "$XVFB_PID" 2>/dev/null; then
            log "ERROR: Xvfb process $XVFB_PID died."
            log "--- ${XVFB_LOG} ---"
            sed -n '1,160p' "${XVFB_LOG}" 2>/dev/null || true
            if [ -r /sys/fs/cgroup/pids.current ]; then
                log "cgroup pids.current=$(cat /sys/fs/cgroup/pids.current 2>/dev/null || echo unknown)"
            fi
            if [ -r /sys/fs/cgroup/pids.max ]; then
                log "cgroup pids.max=$(cat /sys/fs/cgroup/pids.max 2>/dev/null || echo unknown)"
            fi
            log "Stopping trigger server so Railway restarts the container."

            kill -TERM "$$" 2>/dev/null || true
            exit 1
        fi
    done
) &

XVFB_WATCHDOG_PID=$!
exec node /app/ftn-trigger-server.js
