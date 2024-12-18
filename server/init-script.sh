#!/bin/bash
set -e

echo "Setting Vespa permissions....."
./init-vespa.sh

if ! command -v bun &> /dev/null; then
  echo "Bun is not installed. Please install it before running this script."
  exit 1
fi

echo "Running Generation and Migration Commands for Server....."

bun i

bun run generate
bun run migrate

echo "Deploying Vespa....."

cd ./vespa

# Load .env variables (if any)
if [ -f "../.env" ]; then
  export $(grep -v '^#' ../.env | xargs)
fi

# Check if EMBEDDING_MODEL is set
if [ -n "$EMBEDDING_MODEL" ]; then
  echo "Using EMBEDDING_MODEL=$EMBEDDING_MODEL"
  ./deploy.sh "$EMBEDDING_MODEL"
else
  echo "No EMBEDDING_MODEL provided. Using default model."
  ./deploy.sh
fi

echo "Running build Command for Frontend....."
cd ../../frontend

bun i

bun run build