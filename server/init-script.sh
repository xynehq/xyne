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

./deploy.sh

echo "Running build Command for Frontend....."
cd ../../frontend

bun i

bun run build