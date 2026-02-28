/**
 * Database connector: sync database tables to Knowledge Base as CSV files.
 * Each table is exported to CSV, written to KB storage, and processed by the
 * same file processor used for sheets/CSVs (chunkSheetWithHeaders → kb_items).
 */

import { createWriteStream } from "node:fs"
import { mkdir, unlink, stat } from "node:fs/promises"
import { dirname } from "node:path"
import type { Writable } from "node:stream"
import { finished } from "node:stream/promises"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { createClient } from "./client"
import { getDefaultDatabaseConfig } from "./config"
import type { TableInfo, TableSyncState } from "./types"
import type { DatabaseConnectorConfig } from "@/shared/types"
import { csvHeader, getColumnNames, rowsToCsvLines } from "./csvExport"
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

/** Write a chunk to a stream; resolves when the chunk is flushed (honors backpressure). */
function writeChunk(stream: Writable, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

/**
 * Stream a table to a CSV file: fetch batches and write to the file without loading the full result into memory.
 */
async function streamTableToCsvFile(
  client: import("./client").DatabaseClient,
  tableName: string,
  batchSize: number,
  watermarkColumn: string | undefined,
  pkColumns: string[],
  columnNames: string[],
  storagePath: string,
): Promise<{ rowsSynced: number }> {
  await mkdir(dirname(storagePath), { recursive: true })
  const stream = createWriteStream(storagePath, { encoding: "utf-8" })

  await writeChunk(stream, csvHeader(columnNames) + "\n")

  let state: TableSyncState = { table: tableName, rowsSynced: 0 }
  let rowsSynced = 0

  while (true) {
    const rows = await client.fetchRows(
      tableName,
      state,
      batchSize,
      watermarkColumn,
    )
    if (rows.length === 0) break

    const chunk = rowsToCsvLines(columnNames, rows)
    if (chunk) await writeChunk(stream, chunk)

    rowsSynced += rows.length
    state = { ...state, rowsSynced }

    if (pkColumns.length > 0 && rows.length > 0) {
      const lastRow = rows[rows.length - 1] as Record<string, unknown>
      state = {
        ...state,
        lastPk: JSON.stringify(pkColumns.map((c) => lastRow[c])),
      }
    }

    if (rows.length < batchSize) break
  }

  stream.end()
  await finished(stream)
  return { rowsSynced }
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

  const columnNames = getColumnNames(columns)
  const fileName = `${tableName}.csv`
  const storageKey = generateStorageKey()
  const vespaDocId = generateFileVespaDocId()
  const storagePath = getStoragePath(
    kbContext.workspaceExternalId,
    collectionId,
    storageKey,
    fileName,
  )

  const { rowsSynced } = await streamTableToCsvFile(
    client,
    tableName,
    batchSize,
    config.watermarkColumn,
    pkColumns,
    columnNames,
    storagePath,
  )

  const fileStats = await stat(storagePath)
  const fileSize = fileStats.size

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
          fileSize,
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
      fileSize,
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
