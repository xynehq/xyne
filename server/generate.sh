#!/bin/bash
# Run the specific migration script
bun run migrations/202405241920_migrate_tracejson_to_bytea.ts
# Run generate
bun run generate
# Run migrate
bun run migrate
