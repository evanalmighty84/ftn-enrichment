#!/usr/bin/env bash
#
# railway-entrypoint-ftn.sh — Phase 2 FTN phone-enrichment entrypoint for Railway.
#
# Mirrors the user's existing Multilogin railway-entrypoint.sh pattern but
# WITHOUT Multilogin: Smartproxy is reached directly through playwright-core's
# launchPersistentContext (the script's own chromium channel), so we only need
# a virtual display + the chromium runtime deps.
#
#   1. export HOME / XDG_RUNTIME_DIR / TMPDIR (on the Railway volume so the
#      persistent browser profile survives restarts)
#   2. build DATABASE_URL from DB_* vars (node one-liner, bare URL — no
#      sslmode; the script's Pool sets ssl:{rejectUnauthorized:false}) if
#      DATABASE_URL is not already set
#   3. start Xvfb on DISPLAY=:99 for headless chromium
#   4. verify / install chromium + its system deps
#   5. exec node ftn_enrichment.js
#
set -Eeuo pipefail

# --- logging helpers ---------------------------------------------------------
log()  { printf '[ftn-entrypoint %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
err()  { printf '[ftn-entrypoint %s] ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# Bail with a clear message rather than a raw stack trace.
trap 'rc=$?; err "entrypoint failed (exit $rc) on line $LINENO"; exit $rc' ERR

log "starting Phase 2 FTN enrichment entrypoint"

# ----------------------------------------------------------------------------
# 1. HOME / XDG_RUNTIME_DIR / TMPDIR on the Railway volume
# ----------------------------------------------------------------------------
# Railway mounts volumes at /data by default. The persistent browser profile
# (playwright-core launchPersistentContext uses os.tmpdir()) must live on this
# volume so cookies/sessions survive container restarts. We point TMPDIR there
# because the script derives its userDataDir from os.tmpdir().
RAILWAY_VOLUME="${RAILWAY_VOLUME_PATH:-/data}"
if [ ! -d "${RAILWAY_VOLUME}" ]; then
    log "Railway volume ${RAILWAY_VOLUME} not present; using /tmp instead"
    RAILWAY_VOLUME="/tmp"
fi

export HOME="${HOME:-${RAILWAY_VOLUME}/home}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-${RAILWAY_VOLUME}/xdg}"
export TMPDIR="${TMPDIR:-${RAILWAY_VOLUME}/ftn}"

mkdir -p "${HOME}" "${XDG_RUNTIME_DIR}" "${TMPDIR}"
chmod 700 "${XDG_RUNTIME_DIR}" 2>/dev/null || true

log "HOME=${HOME}"
log "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}"
log "TMPDIR=${TMPDIR}"

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
# 3. Start Xvfb on DISPLAY=:99 (headless chromium needs a display even when
#    launched "headless: false" via playwright-core launchPersistentContext)
# ----------------------------------------------------------------------------
export DISPLAY="${DISPLAY:-:99}"

if command -v Xvfb >/dev/null 2>&1; then
    if ! pgrep -x Xvfb >/dev/null 2>&1; then
        log "starting Xvfb on DISPLAY=${DISPLAY}"
        # -ac disables access control; -screen gives a 1280x1024x24 framebuffer.
        Xvfb "${DISPLAY}" -ac -screen 0 1280x1024x24 >/tmp/xvfb.log 2>&1 &
        XVFB_PID=$!
        # Give the server a moment to bind.
        for _ in 1 2 3 4 5 6 7 8 9 10; do
            if pgrep -x Xvfb >/dev/null 2>&1; then break; fi
            sleep 0.3
        done
        log "Xvfb started (pid ${XVFB_PID})"
    else
        log "Xvfb already running on DISPLAY=${DISPLAY}"
    fi
else
    log "Xvfb not found; assuming a display server is available (DISPLAY=${DISPLAY})"
fi

# ----------------------------------------------------------------------------
# 4. Verify / install chromium + system deps
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

cd "$(dirname "$0")"

log "exec node ftn-trigger-server.js"
echo "🌐 Starting FTN trigger server..."


(
    while true; do
        sleep 10

        if ! kill -0 "$XVFB_PID" 2>/dev/null; then
            log "ERROR: Xvfb process $XVFB_PID died."
            log "Stopping trigger server so Railway restarts the container."

            kill -TERM "$$" 2>/dev/null || true
            exit 1
        fi
    done
) &

XVFB_WATCHDOG_PID=$!
exec node /app/ftn-trigger-server.js
