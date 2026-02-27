/**
 * Database connector configuration defaults and env overrides.
 */

import { DatabaseEngine } from "./types"

export const DEFAULT_BATCH_SIZE = 1000
export const DEFAULT_CONCURRENCY = 2

export function getDefaultDatabaseConfig(engine: DatabaseEngine): {
  port: number
  batchSize: number
  concurrency: number
} {
  const port =
    engine === DatabaseEngine.Postgres
      ? parseInt(process.env.DATABASE_CONNECTOR_PG_PORT || "5432", 10)
      : engine === DatabaseEngine.MySQL
        ? parseInt(process.env.DATABASE_CONNECTOR_MYSQL_PORT || "3306", 10)
        : 1433
  return {
    port,
    batchSize: parseInt(
      process.env.DATABASE_CONNECTOR_BATCH_SIZE || String(DEFAULT_BATCH_SIZE),
      10,
    ),
    concurrency: parseInt(
      process.env.DATABASE_CONNECTOR_CONCURRENCY ||
        String(DEFAULT_CONCURRENCY),
      10,
    ),
  }
}
