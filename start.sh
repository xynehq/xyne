#!/bin/bash
set -euo pipefail

# Enable tracing only when DEBUG is explicitly set
if [ "${DEBUG:-}" = "1" ] || [ "${DEBUG:-}" = "true" ]; then
  set -x
fi

echo "Starting Xyne application..."

# Load environment variables
if [ -f /usr/src/app/server/.env ]; then
  echo "Loading environment variables..."
  set -o allexport
  source /usr/src/app/server/.env
  set +o allexport
fi

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL..."
cd /usr/src/app/server

# Construct DATABASE_URL from components if not set
if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_HOST="${DATABASE_HOST:-xyne-db}"
  DATABASE_PORT="${DATABASE_PORT:-5432}"
  DATABASE_USER="${DATABASE_USER:-xyne}"
  DATABASE_PASSWORD="${DATABASE_PASSWORD:-xyne}"
  DATABASE_NAME="${DATABASE_NAME:-xyne}"
  export DATABASE_URL="postgresql://${DATABASE_USER}:${DATABASE_PASSWORD}@${DATABASE_HOST}:${DATABASE_PORT}/${DATABASE_NAME}"
fi

# Initialize retry counters
ATTEMPTS=0
MAX_ATTEMPTS="${DB_WAIT_MAX_ATTEMPTS:-150}"

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

# Wait for Vespa to be ready
echo "Waiting for Vespa config server..."
until curl -f http://${VESPA_HOST:-vespa}:19071/state/v1/health 2>/dev/null; do
  echo "Vespa config server is unavailable - sleeping"
  sleep 2
done
echo "Vespa config server is ready!"

# Check if this is the first run (no init marker exists)
INIT_MARKER_FILE="/usr/src/app/server/storage/.xyne_initialized"
if [ ! -f "$INIT_MARKER_FILE" ]; then
  echo "First run detected, performing initial setup..."
  
  # Run database migrations
  echo "Running database setup..."
  cd /usr/src/app/server
  # Try to generate migrations, but don't fail if none exist
  bun run generate || true
  # Try to run migrations, but don't fail if none exist
  bun run migrate || true
  
  # Deploy Vespa schema and models
  echo "Deploying Vespa..."
  cd /usr/src/app/server/vespa
  EMBEDDING_MODEL=${EMBEDDING_MODEL:-bge-small-en-v1.5} ./deploy-docker.sh
  cd /usr/src/app/server
  
  # Create marker file to indicate initialization is complete
  mkdir -p /usr/src/app/server/storage
  touch "$INIT_MARKER_FILE"
  echo "Initial setup completed"
else
  echo "Existing installation detected, skipping migrations and Vespa deployment"
fi

# Start the server
echo "Starting server on port 3000..."
exec bun server.ts
