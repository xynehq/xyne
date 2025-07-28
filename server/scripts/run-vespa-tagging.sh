#!/bin/bash

# Navigate to server directory
cd "$(dirname "$0")/.."

# Run the TypeScript file using bun
echo "🚀 Running Vespa Tagging Script..."
echo ""

# Check if bun is available
if command -v bun &> /dev/null; then
    bun run scripts/vespaTagging.ts
else
    echo "❌ Error: bun is not installed."
    echo "Please install bun from https://bun.sh"
    exit 1
fi
