import { and, eq, sql } from "drizzle-orm"
import { db } from "./client"
import { databaseSyncState } from "./schema"
import type { TxnOrClient } from "@/types"
import { connectors } from "./schema"
import { Apps } from "@/shared/types"

/** Per-table sync state for database connector (used by getTableSyncState / saveTableSyncState). */
export interface DatabaseTableSyncState {
    table: string
    lastPk?: string
    lastUpdatedAt?: number
    lastLsn?: string
    rowsSynced: number
  }
  
  /** Row shape for database_sync_state table (e.g. for API responses). */
  export interface DatabaseSyncStateRow {
    connectorId: string
    tableName: string
    lastPk: string | null
    lastUpdatedAt: number | null
    lastLsn: string | null
    rowsSynced: number
    updatedAt: Date
  }
  
  export async function getTableSyncState(
    connectorId: string,
    tableName: string,
  ): Promise<DatabaseTableSyncState> {
    const connectorIdNum = Number(connectorId)
    const rows = await db
      .select()
      .from(databaseSyncState)
      .where(
        and(
          eq(databaseSyncState.connectorId, connectorIdNum),
          eq(databaseSyncState.tableName, tableName),
        ),
      )
      .limit(1)
    const row = rows[0]
    if (!row) {
      return { table: tableName, rowsSynced: 0 }
    }
    return {
      table: tableName,
      lastPk: row.lastPk ?? undefined,
      lastUpdatedAt: row.lastUpdatedAt ?? undefined,
      lastLsn: row.lastLsn ?? undefined,
      rowsSynced: row.rowsSynced ?? 0,
    }
  }
  
  /**
   * Get all sync state rows for a connector (for API response).
   */
  export async function getSyncStateRowsByConnectorId(connectorId: string) {
    const connectorIdNum = Number(connectorId)
    const rows = await db
      .select()
      .from(databaseSyncState)
      .where(eq(databaseSyncState.connectorId, connectorIdNum))
    return rows.map((r) => ({
      tableName: r.tableName,
      lastPk: r.lastPk,
      lastUpdatedAt: r.lastUpdatedAt,
      lastLsn: r.lastLsn,
      rowsSynced: r.rowsSynced,
      updatedAt: r.updatedAt,
    }))
  }

  export async function saveTableSyncState(
    connectorId: string,
    tableName: string,
    state: DatabaseTableSyncState,
  ): Promise<void> {
    const connectorIdNum = Number(connectorId)
    await db
      .insert(databaseSyncState)
      .values({
        connectorId: connectorIdNum,
        tableName,
        lastPk: state.lastPk ?? null,
        lastUpdatedAt: state.lastUpdatedAt ?? null,
        lastLsn: state.lastLsn ?? null,
        rowsSynced: state.rowsSynced,
      })
      .onConflictDoUpdate({
        target: [databaseSyncState.connectorId, databaseSyncState.tableName],
        set: {
          lastPk: state.lastPk ?? null,
          lastUpdatedAt: state.lastUpdatedAt ?? null,
          lastLsn: state.lastLsn ?? null,
          rowsSynced: state.rowsSynced,
          updatedAt: new Date(),
        },
      })
  }
  