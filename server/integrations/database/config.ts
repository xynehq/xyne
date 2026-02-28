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
  // Get engine-specific default port
  const defaultPort =
    engine === DatabaseEngine.Postgres
      ? 5432
      : engine === DatabaseEngine.MySQL
        ? 3306
        : 1433

  // Parse port with NaN validation
  const portEnvVar =
    engine === DatabaseEngine.Postgres
      ? process.env.DATABASE_CONNECTOR_PG_PORT
      : engine === DatabaseEngine.MySQL
        ? process.env.DATABASE_CONNECTOR_MYSQL_PORT
        : null
  const parsedPort = portEnvVar ? parseInt(portEnvVar, 10) : defaultPort
  const port = Number.isNaN(parsedPort) || parsedPort <= 0 ? defaultPort : parsedPort

  // Parse batchSize with NaN validation
  const parsedBatchSize = parseInt(
    process.env.DATABASE_CONNECTOR_BATCH_SIZE || String(DEFAULT_BATCH_SIZE),
    10,
  )
  const batchSize = Number.isNaN(parsedBatchSize) || parsedBatchSize <= 0 ? DEFAULT_BATCH_SIZE : parsedBatchSize

  // Parse concurrency with NaN validation
  const parsedConcurrency = parseInt(
    process.env.DATABASE_CONNECTOR_CONCURRENCY || String(DEFAULT_CONCURRENCY),
    10,
  )
  const concurrency = Number.isNaN(parsedConcurrency) || parsedConcurrency <= 0 ? DEFAULT_CONCURRENCY : parsedConcurrency

  return {
    port,
    batchSize,
    concurrency,
  }
}
