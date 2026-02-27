/**
 * Database connector: sync database tables to Knowledge Base as CSV files.
 * Each table is exported to CSV, written to KB storage, and processed by the
 * same file processor used for sheets/CSVs (chunkSheetWithHeaders → kb_items).
 */

import { mkdir, writeFile, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { createClient } from "./client"
import { getDefaultDatabaseConfig } from "./config"
import type { DatabaseConnectorConfig, TableInfo, TableSyncState } from "./types"
import { tableRowsToCsvBuffer, getColumnNames } from "./csvExport"
import {
  saveTableSyncState,
} from "@/db/databaseSyncState"
import { db } from "@/db/client"
import {
  getCollectionById,
  createFileItem,
  getCollectionItemByPath,
  updateCollectionItem,
  generateStorageKey,
  generateFileVespaDocId,
  markParentAsProcessing,
} from "@/db/knowledgeBase"
import { boss, FileProcessingQueue } from "@/queue/api-server-queue"
import { UploadStatus } from "@/shared/types"
import { getStoragePath } from "@/api/knowledgeBase"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "databaseConnector",
})

function filterTables(
  tables: TableInfo[],
  config: DatabaseConnectorConfig["tables"],
): TableInfo[] {
  if (!config) return tables
  const { include, ignore } = config
  let out = tables
  if (include?.length) {
    const set = new Set(include.map((t) => t.toLowerCase()))
    out = out.filter((t) => set.has(t.name.toLowerCase()))
  }
  if (ignore?.length) {
    const set = new Set(ignore.map((t) => t.toLowerCase()))
    out = out.filter((t) => !set.has(t.name.toLowerCase()))
  }
  return out
}

export interface DatabaseSyncKbContext {
  workspaceId: number
  workspaceExternalId: string
  userId: number
  userEmail: string
  connectorName: string
  /** Returns KB collection id for this connector (creates if needed). */
  getOrCreateKbCollection: (connectorId: string) => Promise<string>
}

export async function syncDatabase(
  config: DatabaseConnectorConfig,
  connectorId: string,
  kbContext: DatabaseSyncKbContext,
): Promise<{ tablesSynced: number; rowsSynced: number }> {
  const defaults = getDefaultDatabaseConfig(config.engine)
  const batchSize = config.batchSize ?? defaults.batchSize
  const client = createClient(config)
  await client.connect()

  let totalRows = 0
  let tablesSynced = 0

  try {
    const tables = await client.listTables()
    const filtered = filterTables(tables, config.tables)
    Logger.info(
      { connectorId, total: tables.length, filtered: filtered.length },
      "Database connector: tables to sync",
    )

    const collectionId = await kbContext.getOrCreateKbCollection(connectorId)

    for (const table of filtered) {
      const result = await syncTableToKb(
        client,
        table,
        config,
        connectorId,
        collectionId,
        kbContext,
        batchSize,
      )
      totalRows += result.rowsSynced
      if (result.rowsSynced > 0) tablesSynced += 1
    }
  } finally {
    await client.disconnect()
  }

  return { tablesSynced, rowsSynced: totalRows }
}

/**
 * Sync a single table for a database connector to KB (same flow as syncTableToKb).
 * Use from SyncDatabaseTableApi. Throws if table not found or has no primary key.
 */
export async function syncSingleTable(
  config: DatabaseConnectorConfig,
  connectorId: string,
  tableName: string,
  kbContext: DatabaseSyncKbContext,
): Promise<{ rowsSynced: number }> {
  const defaults = getDefaultDatabaseConfig(config.engine)
  const batchSize = config.batchSize ?? defaults.batchSize
  const client = createClient(config)
  await client.connect()
  try {
    const tables = await client.listTables()
    const table = tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase())
    if (!table) throw new Error(`Table "${tableName}" not found in database`)
    const pkColumns = await client.getPrimaryKeyColumns(table.name)
    if (pkColumns.length === 0) throw new Error(`Table "${tableName}" has no primary key; cannot sync`)
    const collectionId = await kbContext.getOrCreateKbCollection(connectorId)
    return await syncTableToKb(
      client,
      table,
      config,
      connectorId,
      collectionId,
      kbContext,
      batchSize,
    )
  } finally {
    await client.disconnect()
  }
}

/**
 * Fetch all rows for a table (paginated) for full export.
 */
async function fetchAllRows(
  client: import("./client").DatabaseClient,
  tableName: string,
  batchSize: number,
  watermarkColumn?: string,
): Promise<import("./types").DbRow[]> {
  const allRows: import("./types").DbRow[] = []
  let state: TableSyncState = { table: tableName, rowsSynced: 0 }
  let hasMore = true
  while (hasMore) {
    const rows = await client.fetchRows(
      tableName,
      state,
      batchSize,
      watermarkColumn,
    )
    if (rows.length === 0) break
    allRows.push(...rows)
    state = { ...state, rowsSynced: state.rowsSynced + rows.length }
    if (rows.length < batchSize) hasMore = false
  }
  return allRows
}

async function syncTableToKb(
  client: import("./client").DatabaseClient,
  table: TableInfo,
  config: DatabaseConnectorConfig,
  connectorId: string,
  collectionId: string,
  kbContext: DatabaseSyncKbContext,
  batchSize: number,
): Promise<{ rowsSynced: number }> {
  const tableName = table.name
  const columns = await client.getTableColumns(tableName)
  const pkColumns = await client.getPrimaryKeyColumns(tableName)
  if (pkColumns.length === 0) {
    Logger.warn({ table: tableName }, "Table has no primary key; skipping")
    return { rowsSynced: 0 }
  }

  const allRows = await fetchAllRows(
    client,
    tableName,
    batchSize,
    config.watermarkColumn,
  )
  const columnNames = getColumnNames(columns)
  const csvBuffer = tableRowsToCsvBuffer(columnNames, allRows)
  const rowsSynced = allRows.length

  const fileName = `${tableName}.csv`
  const storageKey = generateStorageKey()
  const vespaDocId = generateFileVespaDocId()
  const storagePath = getStoragePath(
    kbContext.workspaceExternalId,
    collectionId,
    storageKey,
    fileName,
  )

  await mkdir(dirname(storagePath), { recursive: true })
  await writeFile(storagePath, csvBuffer)

  const collection = await getCollectionById(db, collectionId)
  if (!collection) {
    throw new Error("KB collection not found")
  }

  const existing = await getCollectionItemByPath(db, collectionId, "/", fileName)

  const item = await db.transaction(async (tx) => {
    if (existing) {
      if (existing.storagePath && existing.storagePath !== storagePath) {
        unlink(existing.storagePath).catch(() => {})
      }
      await updateCollectionItem(
        tx,
        existing.id,
        {
          storagePath,
          fileSize: csvBuffer.length,
          uploadStatus: UploadStatus.PENDING,
          statusMessage: "Database sync: queued for processing",
          updatedAt: new Date(),
        },
      )
      await markParentAsProcessing(tx, collectionId, true)
      return existing
    }
    return await createFileItem(
      tx,
      collectionId,
      null,
      fileName,
      vespaDocId,
      fileName,
      storagePath,
      storageKey,
      "text/csv",
      csvBuffer.length,
      null,
      {
        source: "database_connector",
        connectorId,
        tableName,
      },
      kbContext.userId,
      kbContext.userEmail,
      "Database sync: queued for processing",
    )
  })

  const fileId = typeof item.id === "string" ? item.id : String(item.id)
  await boss.send(
    FileProcessingQueue,
    { fileId, type: "file" as const },
    { retryLimit: 3, expireInHours: 12 },
  )

  await saveTableSyncState(connectorId, tableName, {
    table: tableName,
    rowsSynced,
  })

  Logger.info(
    { connectorId, table: tableName, rowsSynced, fileId: item.id },
    "Database connector: table synced to KB as CSV",
  )
  return { rowsSynced }
}
