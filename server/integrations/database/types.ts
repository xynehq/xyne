/**
 * Database connector types.
 * Engine-specific config (e.g. ssl) can be extended per implementation.
 */

export enum DatabaseEngine {
  Postgres = "postgres",
  MySQL = "mysql",
  MSSQL = "mssql",
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

/** Schema-only document written to KB (no row data). Used for retrieval → generate SQL → execute on client DB. */
export interface DatabaseTableSchemaDoc {
  source: "database_connector"
  connectorId: string
  tableName: string
  schema: string
  columns: { name: string; type: string; nullable: boolean; isPrimaryKey?: boolean }[]
  primaryKey: string[]
  foreignKeys?: { columns: string[]; referencedTable: string; referencedColumns: string[] }[]
  rowCount?: number
  description: string
}
