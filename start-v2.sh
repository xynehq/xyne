#!/bin/bash
# Production boot for the v2 stack (ui2 + backendv2).
# Mirrors start.sh in shape: load env, wait for postgres, optionally wait for
# Vespa, run migrations on first boot, then exec the bun server.
#
# The only differences from start.sh:
#   - Entrypoint is backendv2/server.ts (not server.ts)
#   - Skips the v1-specific Vespa schema deployment (deploy-docker.sh) — v2
#     reads from the same KB Vespa instance, no per-version schema changes.
#   - Sets UI2_DIST_DIR so backendv2's serveStatic finds the built SPA.
set -euo pipefail

if [ "${DEBUG:-}" = "1" ] || [ "${DEBUG:-}" = "true" ]; then
  set -x
fi

echo "Starting Xyne v2 (ui2 + backendv2)..."

if [ -f /usr/src/app/server/.env ]; then
  echo "Loading environment variables..."
  set -o allexport
  source /usr/src/app/server/.env
  set +o allexport
fi

cd /usr/src/app/server

# DATABASE_URL fallback construction (same as v1).
if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_HOST="${DATABASE_HOST:-xyne-db}"
  DATABASE_PORT="${DATABASE_PORT:-5432}"
  DATABASE_USER="${DATABASE_USER:-xyne}"
  DATABASE_PASSWORD="${DATABASE_PASSWORD:-xyne}"
  DATABASE_NAME="${DATABASE_NAME:-xyne}"
  export DATABASE_URL="postgresql://${DATABASE_USER}:${DATABASE_PASSWORD}@${DATABASE_HOST}:${DATABASE_PORT}/${DATABASE_NAME}"
fi

# Wait for postgres.
ATTEMPTS=0
MAX_ATTEMPTS="${DB_WAIT_MAX_ATTEMPTS:-150}"
echo "Waiting for PostgreSQL..."
while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
  if bun -e "import postgres from 'postgres'; const sql = postgres(process.env.DATABASE_URL); await sql\`SELECT 1\`; await sql.end();" 2>/dev/null; then
    echo "PostgreSQL is ready!"
    break
  fi
  ATTEMPTS=$((ATTEMPTS + 1))
  echo "PostgreSQL is unavailable - sleeping (attempt $ATTEMPTS/$MAX_ATTEMPTS)"
  sleep 2
done
if [ $ATTEMPTS -ge $MAX_ATTEMPTS ]; then
  echo "ERROR: Failed to connect to PostgreSQL after $MAX_ATTEMPTS attempts"
  exit 1
fi

# Vespa is optional — v2 will degrade gracefully if it's unreachable; only the
# vespa-backed research tools stop working.
VESPA_REQUIRED="${VESPA_REQUIRED:-false}"
VESPA_REQUIRED_NORMALIZED="$(printf '%s' "$VESPA_REQUIRED" | tr '[:upper:]' '[:lower:]')"
VESPA_ATTEMPTS=0
VESPA_MAX_ATTEMPTS="${VESPA_WAIT_MAX_ATTEMPTS:-30}"
VESPA_READY=false
echo "Waiting for Vespa config server..."
while [ "$VESPA_ATTEMPTS" -lt "$VESPA_MAX_ATTEMPTS" ]; do
  if curl --connect-timeout 2 --max-time 5 -f "http://${VESPA_HOST:-vespa}:19071/state/v1/health" 2>/dev/null; then
    VESPA_READY=true
    echo "Vespa config server is ready!"
    break
  fi
  VESPA_ATTEMPTS=$((VESPA_ATTEMPTS + 1))
  echo "Vespa is unavailable - sleeping (attempt $VESPA_ATTEMPTS/$VESPA_MAX_ATTEMPTS)"
  sleep 2
done
if [ "$VESPA_READY" != "true" ]; then
  if [ "$VESPA_REQUIRED_NORMALIZED" = "true" ] || [ "$VESPA_REQUIRED" = "1" ]; then
    echo "ERROR: Failed to connect to Vespa after $VESPA_MAX_ATTEMPTS attempts"
    exit 1
  fi
  echo "WARNING: Vespa unavailable; continuing without research tools"
fi

# Run migrations on first boot. Same marker file as v1 — v2 shares the schema.
INIT_MARKER_FILE="/usr/src/app/server/storage/.xyne_initialized"
if [ ! -f "$INIT_MARKER_FILE" ]; then
  echo "First run detected, running migrations..."
  bun run generate || true
  bun run migrate || true
  mkdir -p /usr/src/app/server/storage
  touch "$INIT_MARKER_FILE"
fi

# Point backendv2's serveStatic at the ui2 build that Dockerfile.v2 staged
# next to it. Override at runtime if you need to mount a custom UI build.
export UI2_DIST_DIR="${UI2_DIST_DIR:-/usr/src/app/server/ui2-dist}"

echo "Starting backendv2 on port ${BACKENDV2_PORT:-3000} (UI2_DIST_DIR=$UI2_DIST_DIR)..."
exec bun backendv2/server.ts
