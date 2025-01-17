#!/bin/bash
set -e

echo "Initializing Vespa permissions..."
./init-vespa.sh

if ! command -v bun &> /dev/null; then
  echo "Bun is not installed. Please install it before running this script."
  exit 1
fi

echo "Running generation and migration commands for the server..."

if [ ! -f ".env" ]; then
  echo ".env file not found. Creating a new one..."
  touch .env
fi 

bun i
bun run generate
bun run migrate

echo "Deploying Vespa..."
cd ./vespa

# Load .env variables (if any)
if [ -f "../.env" ]; then
  export $(grep -v '^#' ../.env | xargs)
fi

# Check if EMBEDDING_MODEL is set
if [ -n "$EMBEDDING_MODEL" ]; then
  echo "Using EMBEDDING_MODEL=$EMBEDDING_MODEL"
  ./deploy-docker.sh "$EMBEDDING_MODEL"
else
  ./deploy-docker.sh 
fi


echo "Initializing frontend..."

cd ../../frontend

bun i

bun run build

echo "***************Initialization completed*******************"