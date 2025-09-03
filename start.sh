#!/bin/bash
set -xe

echo "Starting Xyne application..."

# Restore sample data if needed (before services start)
echo "🔄 Checking for data restoration..."
if [ -f /usr/src/app/deployment/restore-data.sh ]; then
  /usr/src/app/deployment/restore-data.sh
else
  echo "   ⚠️  No restore script found, starting with empty data"
fi

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL..."
until bun run -e "import postgres from 'postgres'; const sql = postgres({host: process.env.DATABASE_HOST || 'xyne-db', port: 5432, database: 'xyne', username: 'xyne', password: 'xyne'}); await sql\`SELECT 1\`; await sql.end();" 2>/dev/null; do
  echo "PostgreSQL is unavailable - sleeping"
  sleep 2
done
echo "PostgreSQL is ready!"

# Wait for Vespa to be ready
echo "Waiting for Vespa config server..."
until curl -f http://vespa:19071/state/v1/health 2>/dev/null; do
  echo "Vespa config server is unavailable - sleeping"
  sleep 2
done
echo "Vespa config server is ready!"

# Load environment variables
if [ -f /usr/src/app/server/.env ]; then
  echo "📄 Loading environment variables..."
  export $(grep -v "^#" /usr/src/app/server/.env | sed "s/#.*$//" | grep -v "^$" | xargs)
fi

# Check if this is the first run (no init marker exists)
INIT_MARKER_FILE="/usr/src/app/server/storage/.xyne_initialized"
if [ ! -f "$INIT_MARKER_FILE" ]; then
  echo "🔧 First run detected, performing initial setup..."
  
  # Run database migrations
  echo "Running database setup..."
  # Try to generate migrations, but don't fail if none exist
  bun run generate
  # Try to run migrations, but don't fail if none exist
  bun run migrate
  
  # Deploy Vespa schema and models
  echo "Deploying Vespa..."
  cd /usr/src/app/server/vespa
  EMBEDDING_MODEL=${EMBEDDING_MODEL:-bge-small-en-v1.5} ./deploy-docker.sh
  cd /usr/src/app/server
  
  # Create marker file to indicate initialization is complete
  mkdir -p /usr/src/app/server/storage
  touch "$INIT_MARKER_FILE"
  echo "✅ Initial setup completed"
else
  echo "🚀 Existing installation detected, skipping migrations and Vespa deployment"
fi

# Start the server
echo "Starting server on port 3000..."
exec bun server.ts
