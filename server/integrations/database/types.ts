/**
 * Database connector types.
 * Engine-specific config (e.g. ssl) can be extended per implementation.
 */

export enum DatabaseEngine {
  Postgres = "postgres",
  MySQL = "mysql",
  MSSQL = "mssql",
}

export interface DatabaseConnectorConfig {
  engine: DatabaseEngine
  host: string
  port: number
  database: string
  schema?: string
  tables?: { include?: string[]; ignore?: string[] }
  auth: { username: string; password: string } | { iamAuth: true }
  batchSize: number
  concurrency: number
  /** Column name for watermark-based incremental sync (e.g. updated_at). Optional. */
  watermarkColumn?: string
  cdcEnabled: boolean
  ssl?: { rejectUnauthorized: boolean; ca?: string }
}

/** Payload stored in connectors.credentials (encrypted at rest) for DB connectors. */
export interface DatabaseCredentialsPayload {
  kind: "database"
  username: string
  password: string
}

export interface TableSyncState {
  table: string
  lastPk?: string
  lastUpdatedAt?: number
  lastLsn?: string
  rowsSynced: number
}

export interface TableInfo {
  name: string
  schema?: string
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
}

export type DbRow = Record<string, unknown>
