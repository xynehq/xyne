/**
 * Precompute context for database connector schema-only KB items: generate Postgres SQL from user query,
 * execute on the client DB, and return formatted results. Used so answerContextMap can substitute this
 * context when a search result is a DB schema doc.
 */

import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { db } from "@/db/client"
import { getDatabaseConnectorForUser } from "@/db/connector"
import { createClient } from "@/integrations/database/client"
import { MIME_DATABASE_SCHEMA } from "@/integrations/database"
import type { DatabaseTableSchemaDoc } from "@/integrations/database/types"
import type { VespaSearchResults } from "@xyne/vespa-ts/types"
import { KbItemsSchema } from "@xyne/vespa-ts/types"
import { generatePostgresSQL } from "./sqlInference"
import { validatePostgresQuery } from "./sqlValidator"
import { getDatabaseConnectorConfig } from "@/api/databaseConnector"
import { getDatabaseConnectorExternalIdByKbCollectionId } from "@/db/connector"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "databaseContext",
})

/** Strip Vespa highlight tags from search result text so schema identifiers are clean for SQL generation. */
function stripVespaHighlight(s: string): string {
  return s.replace(/<\/?hi>/gi, "")
}

function parseMetadata(meta: unknown): { source?: string; connectorId?: string; tableName?: string } {
  if (typeof meta !== "string") return {}
  try {
    const o = JSON.parse(meta) as Record<string, unknown>
    return {
      source: o.source as string,
      connectorId: o.connectorId as string,
      tableName: o.tableName as string,
    }
  } catch {
    return {}
  }
}

function sanitizeSchemaDoc(doc: DatabaseTableSchemaDoc): DatabaseTableSchemaDoc {
  return {
    ...doc,
    tableName: stripVespaHighlight(doc.tableName),
    schema: stripVespaHighlight(doc.schema),
    columns: doc.columns.map((c) => ({
      ...c,
      name: stripVespaHighlight(c.name),
    })),
    primaryKey: doc.primaryKey.map(stripVespaHighlight),
    foreignKeys: doc.foreignKeys?.map((fk) => ({
      columns: fk.columns.map(stripVespaHighlight),
      referencedTable: stripVespaHighlight(fk.referencedTable),
      referencedColumns: fk.referencedColumns.map(stripVespaHighlight),
    })),
  }
}

function extractSchemaFromChunks(chunks: unknown): DatabaseTableSchemaDoc | null {
  if (!Array.isArray(chunks) || chunks.length === 0) return null
  const text = chunks
    .map((c) => (typeof c === "string" ? c : (c as { chunk?: string }).chunk))
    .filter(Boolean)
    .join("\n")
  try {
    const parsed = JSON.parse(text) as unknown
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as DatabaseTableSchemaDoc).source === "database_connector" &&
      Array.isArray((parsed as DatabaseTableSchemaDoc).columns)
    ) {
      return sanitizeSchemaDoc(parsed as DatabaseTableSchemaDoc)
    }
  } catch {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start !== -1 && end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
        if (
          parsed &&
          typeof parsed === "object" &&
          (parsed as DatabaseTableSchemaDoc).source === "database_connector"
        ) {
          return sanitizeSchemaDoc(parsed as DatabaseTableSchemaDoc)
        }
      } catch {
        // ignore
      }
    }
  }
  return null
}

/**
 * One-liner for the common pattern: only build precomputed DB context when userId, workspaceId, and query are present.
 * Use this at call sites instead of repeating the null checks and buildPrecomputedDbContext call.
 */
export async function getPrecomputedDbContextIfNeeded(
  searchResults: VespaSearchResults[] | undefined,
  query: string | undefined,
  userId: number | null | undefined,
  workspaceId: number | null | undefined,
): Promise<Map<string, string>> {
  if (
    userId == null ||
    workspaceId == null ||
    typeof query !== "string" ||
    !query.trim()
  ) {
    return new Map()
  }
  return buildPrecomputedDbContext(searchResults, query, userId, workspaceId)
}

const PRECOMPUTED_DB_CACHE_TTL_MS = 60_000
const PRECOMPUTED_DB_MAX_CONCURRENT = 5
const PRECOMPUTED_DB_ORCHESTRATION_TIMEOUT_MS = 45_000

let precomputedDbCache: {
  key: string
  value: Map<string, string>
  expiresAt: number
} | null = null
let precomputedDbRunning = 0

function acquirePrecomputedDbSlot(): Promise<void> {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (precomputedDbRunning < PRECOMPUTED_DB_MAX_CONCURRENT) {
        precomputedDbRunning++
        resolve()
      } else {
        setTimeout(tryAcquire, 20)
      }
    }
    tryAcquire()
  })
}

function releasePrecomputedDbSlot(): void {
  precomputedDbRunning = Math.max(0, precomputedDbRunning - 1)
}

/**
 * Build a map of connectorId -> formatted context string for database schema-only docs in the search results.
 * Call this before mapping over search results so answerContextMap can use the precomputed context.
 * Uses a short TTL cache, concurrency limit, and orchestration timeout to avoid latency spikes and pool exhaustion.
 */
export async function buildPrecomputedDbContext(
  searchResults: VespaSearchResults[] | undefined,
  query: string,
  userId: number,
  workspaceId: number,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (!searchResults?.length || !query?.trim()) return map

  const schemaDocs = searchResults.filter((r) => {
    const f = r.fields as Record<string, unknown>
    if (f?.sddocname !== KbItemsSchema) return false
    const mime = f.mimeType as string
    return mime === MIME_DATABASE_SCHEMA
  })

  if (schemaDocs.length === 0) return map

  const byConnector = new Map<string, DatabaseTableSchemaDoc[]>()
  for (const r of schemaDocs) {
    const f = r.fields as Record<string, unknown>
    const meta = parseMetadata(f.metadata)
    let connectorId = meta.connectorId
    if (!connectorId && typeof f.clId === "string") {
      connectorId = (await getDatabaseConnectorExternalIdByKbCollectionId(f.clId)) ?? undefined
    }
    if (!connectorId) continue
    const schema = extractSchemaFromChunks(f.chunks_summary)
    if (schema) {
      const list = byConnector.get(connectorId) ?? []
      if (!list.some((s) => s.tableName === schema.tableName)) list.push(schema)
      byConnector.set(connectorId, list)
    }
  }

  const cacheKey = `${userId}:${workspaceId}:${query.trim()}\n${[...byConnector.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, schemas]) => `${id}:${schemas.map((s) => s.tableName).sort().join(",")}`)
    .join(";")}`
  const now = Date.now()
  if (precomputedDbCache?.key === cacheKey && precomputedDbCache.expiresAt > now) {
    return new Map(precomputedDbCache.value)
  }

  const run = async (): Promise<Map<string, string>> => {
    await acquirePrecomputedDbSlot()
    try {
      return await buildPrecomputedDbContextInner(byConnector, query, userId, workspaceId)
    } finally {
      releasePrecomputedDbSlot()
    }
  }

  try {
    const result = await Promise.race([
      run(),
      new Promise<Map<string, string>>((_, reject) =>
        setTimeout(
          () => reject(new Error("Precomputed DB context timeout")),
          PRECOMPUTED_DB_ORCHESTRATION_TIMEOUT_MS,
        ),
      ),
    ])
    precomputedDbCache = {
      key: cacheKey,
      value: result,
      expiresAt: now + PRECOMPUTED_DB_CACHE_TTL_MS,
    }
    return new Map(result)
  } catch (err) {
    if (String(err).includes("timeout")) {
      Logger.warn("Precomputed DB context skipped: orchestration timeout")
    }
    return map
  }
}

async function buildPrecomputedDbContextInner(
  byConnector: Map<string, DatabaseTableSchemaDoc[]>,
  query: string,
  userId: number,
  workspaceId: number,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const [connectorId, schemas] of byConnector) {
    try {
      const connector = await getDatabaseConnectorForUser(db, connectorId, userId, workspaceId)
      if (!connector) continue
      const config = getDatabaseConnectorConfig(connector)
      if (!config) continue
      const pgResult = await generatePostgresSQL(
        query,
        schemas,
        config.schema ?? "public",
      )
      if (!pgResult?.sql) continue

      const allowedTableNames = schemas.map((s) => s.tableName)
      const validation = validatePostgresQuery(pgResult.sql, allowedTableNames)
      if (!validation.isValid) {
        Logger.warn({ connectorId, error: validation.error }, "Postgres SQL validation failed")
        continue
      }

      const client = createClient(config)
      await client.connect()
      try {
        if (!client.executeReadOnlyQuery) continue
        const rows = await client.executeReadOnlyQuery(validation.sanitizedSQL ?? pgResult.sql, {
          timeoutMs: 30_000,
          rowLimit: 1000,
        })
        await client.disconnect()

        const lines: string[] = [
          "Database query result (from connected database):",
          `Assumptions: ${pgResult.notes}`,
          `SQL: ${validation.sanitizedSQL ?? pgResult.sql}`,
          `Rows: ${rows.length}`,
          "",
        ]
        if (rows.length > 0) {
          const cols = Object.keys(rows[0] as object)
          lines.push(cols.join("\t"))
          for (const row of rows) {
            lines.push(cols.map((c) => String((row as Record<string, unknown>)[c] ?? "")).join("\t"))
          }
        }
        map.set(connectorId, lines.join("\n"))
      } finally {
        await client.disconnect().catch(() => {})
      }
    } catch (err) {
      Logger.warn({ err, connectorId }, "Precompute DB context failed for connector")
    }
  }

  return map
}
