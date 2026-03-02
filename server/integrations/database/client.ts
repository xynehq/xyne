/**
 * Abstract database client and Postgres implementation.
 * MySQL can be added as a second implementation.
 */

import type {
  ColumnInfo,
  DbRow,
  TableInfo,
  TableSyncState,
} from "./types"
import type { DatabaseTableSchemaDoc } from "./types"
import type { DatabaseConnectorConfig } from "@/shared/types"
import { DatabaseEngine } from "./types"
import { PostgresClient } from "./client-postgres"

export interface DatabaseClient {
  connect(): Promise<void>
  disconnect(): Promise<void>
  listTables(): Promise<TableInfo[]>
  getTableColumns(table: string): Promise<ColumnInfo[]>
  getPrimaryKeyColumns(table: string): Promise<string[]>
  fetchRows(
    table: string,
    state: TableSyncState,
    batchSize: number,
    watermarkColumn?: string,
  ): Promise<DbRow[]>
  /** Schema-only sync: full table metadata (columns, PK, FKs). Optional for engines that don't support it yet. */
  getTableSchemaFull?(
    tableName: string,
    connectorId: string,
    options?: { includeRowCount?: boolean; includeColumnStats?: boolean },
  ): Promise<DatabaseTableSchemaDoc>
  /** Run a read-only SELECT (for schema-only retrieval). Caller must validate SQL. Optional. */
  executeReadOnlyQuery?(
    sql: string,
    options?: { timeoutMs?: number; rowLimit?: number },
  ): Promise<DbRow[]>
}

export function createClient(config: DatabaseConnectorConfig): DatabaseClient {
  switch (config.engine) {
    case DatabaseEngine.Postgres:
      return new PostgresClient(config)
    case DatabaseEngine.MySQL:
      throw new Error("MySQL client not yet implemented; use Postgres for MVP")
    case DatabaseEngine.MSSQL:
      throw new Error("MSSQL client not yet implemented")
    default:
      throw new Error(`Unknown database engine: ${(config as { engine: string }).engine}`)
  }
}

export { PostgresClient }
