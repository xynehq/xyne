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

/**
 * Prefer schema from Vespa metadata when present (set by file processor for application/x-database-schema).
 * Metadata is not chunked, so this is reliable. Older docs may only have chunks.
 */
function extractSchemaFromMetadata(meta: unknown): DatabaseTableSchemaDoc | null {
  if (meta == null) return null
  const str = typeof meta === "string" ? meta : undefined
  if (!str) return null
  try {
    const o = JSON.parse(str) as Record<string, unknown>
    const schema = o?.schema
    if (
      schema &&
      typeof schema === "object" &&
      (schema as DatabaseTableSchemaDoc).source === "database_connector" &&
      Array.isArray((schema as DatabaseTableSchemaDoc).columns)
    ) {
      return sanitizeSchemaDoc(schema as DatabaseTableSchemaDoc)
    }
  } catch {
    // ignore
  }
  return null
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

/** Fallback for legacy docs: reassemble schema from chunks (metadata may not have schema). */
function extractSchemaFromChunks(chunks: unknown): DatabaseTableSchemaDoc | null {
  if (!Array.isArray(chunks) || chunks.length === 0) return null
  const withIndex = chunks
    .map((c) => ({
      text: typeof c === "string" ? c : (c as { chunk?: string }).chunk,
      index: typeof (c as { index?: number }).index === "number" ? (c as { index: number }).index : -1,
    }))
    .filter((x): x is { text: string; index: number } => typeof x.text === "string" && x.text.length > 0)
  if (withIndex.length === 0) return null
  withIndex.sort((a, b) => a.index - b.index)
  const text = withIndex.map((x) => x.text).join("")
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
          (parsed as DatabaseTableSchemaDoc).source === "database_connector" &&
          Array.isArray((parsed as DatabaseTableSchemaDoc).columns)
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
    Logger.warn(
      { hasUserId: userId != null, hasWorkspaceId: workspaceId != null, hasQuery: typeof query === "string" && !!query?.trim() },
      "DatabaseContext: skipped building precomputed DB context (missing userId, workspaceId, or query)",
    )
    return new Map()
  }
  return buildPrecomputedDbContext(searchResults, query, userId, workspaceId)
}

const PRECOMPUTED_DB_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes; shared across users for same query + connector set
const PRECOMPUTED_DB_CACHE_MAX_ENTRIES = 50
const PRECOMPUTED_DB_MAX_CONCURRENT = 5
const PRECOMPUTED_DB_ORCHESTRATION_TIMEOUT_MS = 45_000

/** Multi-entry TTL cache: cacheKey -> { value, expiresAt }. Evicts expired and oldest when at capacity. */
const precomputedDbCache = new Map<
  string,
  { value: Map<string, string>; expiresAt: number }
>()
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
 * Uses a TTL cache keyed by query + connector/schema set (shared across users), concurrency limit, and orchestration timeout.
 */
export async function buildPrecomputedDbContext(
  searchResults: VespaSearchResults[] | undefined,
  query: string,
  userId: number,
  workspaceId: number,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (!searchResults?.length || !query?.trim()) {
    Logger.warn(
      { resultsCount: searchResults?.length ?? 0, queryLength: query?.trim()?.length ?? 0 },
      "DatabaseContext: no search results or empty query, skipping precomputed DB context",
    )
    return map
  }

  const schemaDocs = searchResults.filter((r) => {
    const f = r.fields as Record<string, unknown>
    if (f?.sddocname !== KbItemsSchema) return false
    const mime = f.mimeType as string
    return mime === MIME_DATABASE_SCHEMA
  })

  if (schemaDocs.length === 0) {
    Logger.info(
      { totalResults: searchResults.length },
      "DatabaseContext: no DB schema docs in search results (mimeType not application/x-database-schema)",
    )
    return map
  }

  const byConnector = new Map<string, DatabaseTableSchemaDoc[]>()
  for (const r of schemaDocs) {
    const f = r.fields as Record<string, unknown>
    const meta = parseMetadata(f.metadata)
    let connectorId = meta.connectorId
    if (!connectorId && typeof f.clId === "string") {
      connectorId = (await getDatabaseConnectorExternalIdByKbCollectionId(f.clId)) ?? undefined
    }
    if (!connectorId) {
      Logger.warn(
        { tableName: meta.tableName, clId: f.clId },
        "DatabaseContext: DB schema doc surfaced but skipped (no connectorId in metadata and clId lookup returned null)",
      )
      continue
    }
    const schema = extractSchemaFromMetadata(f.metadata) ?? extractSchemaFromChunks(f.chunks_summary)
    if (!schema) {
      Logger.warn(
        { connectorId, tableName: meta.tableName },
        "DatabaseContext: DB schema doc surfaced but skipped (schema extraction failed from metadata and chunks)",
      )
      continue
    }
    if (schema) {
      const list = byConnector.get(connectorId) ?? []
      // Dedup by composite key (schema + tableName) to avoid collapsing distinct tables across schemas
      const schemaName = schema.schema ?? "public"
      if (!list.some((s) => (s.schema ?? "public") === schemaName && s.tableName === schema.tableName)) {
        list.push(schema)
      }
      byConnector.set(connectorId, list)
    }
  }

  if (byConnector.size === 0) {
    Logger.warn(
      { schemaDocsCount: schemaDocs.length },
      "DatabaseContext: DB schema docs surfaced but none had valid connectorId + schema; precomputed DB context will be empty",
    )
    return map
  }

  // TODO: improve caching logic later for large scale use cases
  const cacheKey = `${query.trim()}\n${[...byConnector.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, schemas]) => `${id}:${schemas.map((s) => s.tableName).sort().join(",")}`)
    .join(";")}`
  const now = Date.now()
  const cached = precomputedDbCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return new Map(cached.value)
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
    const expiresAt = now + PRECOMPUTED_DB_CACHE_TTL_MS
    precomputedDbCache.set(cacheKey, { value: result, expiresAt })
    if (precomputedDbCache.size > PRECOMPUTED_DB_CACHE_MAX_ENTRIES) {
      const keysToDelete: string[] = []
      for (const [k, v] of precomputedDbCache) {
        if (v.expiresAt <= now) keysToDelete.push(k)
      }
      keysToDelete.forEach((k) => precomputedDbCache.delete(k))
      while (precomputedDbCache.size > PRECOMPUTED_DB_CACHE_MAX_ENTRIES) {
        const oldest = [...precomputedDbCache.entries()].sort(
          (a, b) => a[1].expiresAt - b[1].expiresAt,
        )[0]
        if (oldest) precomputedDbCache.delete(oldest[0])
      }
    }
    return new Map(result)
  } catch (err) {
    if (String(err).includes("timeout")) {
      Logger.warn(
        { timeoutMs: PRECOMPUTED_DB_ORCHESTRATION_TIMEOUT_MS },
        "DatabaseContext: precomputed DB context skipped (orchestration timeout)",
      )
    } else {
      Logger.warn({ err }, "DatabaseContext: precomputed DB context failed with error")
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
      if (!connector) {
        Logger.warn(
          { connectorId, userId, workspaceId, tableNames: schemas.map((s) => s.tableName) },
          "DatabaseContext: connector not found for user/workspace; skipping query",
        )
        continue
      }
      const config = getDatabaseConnectorConfig(connector)
      if (!config) {
        Logger.warn(
          { connectorId, tableNames: schemas.map((s) => s.tableName) },
          "DatabaseContext: connector config invalid or missing (engine/host/database/credentials); skipping query",
        )
        continue
      }
      const pgResult = await generatePostgresSQL(
        query,
        schemas,
        config.schema ?? "public",
      )
      if (!pgResult?.sql) {
        Logger.warn(
          { connectorId, tableNames: schemas.map((s) => s.tableName) },
          "DatabaseContext: SQL not generated (model unset, LLM returned sql:null, or parse error); skipping query",
        )
        continue
      }

      const allowedTableNames = schemas.map((s) => s.tableName)
      const validation = validatePostgresQuery(pgResult.sql, allowedTableNames)
      if (!validation.isValid) {
        Logger.warn(
          { connectorId, error: validation.error, tableNames: allowedTableNames },
          "DatabaseContext: Postgres SQL validation failed; skipping query",
        )
        continue
      }

      const client = createClient(config)
      await client.connect()
      try {
        if (!client.executeReadOnlyQuery) {
          Logger.warn(
            { connectorId },
            "DatabaseContext: client has no executeReadOnlyQuery; skipping query",
          )
          continue
        }
        const rows = await client.executeReadOnlyQuery(validation.sanitizedSQL ?? pgResult.sql, {
          timeoutMs: 30_000,
          rowLimit: 1000,
        })

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
        // Disconnect in finally block to ensure cleanup on both success and error paths
        await client.disconnect().catch(() => {})
      }
    } catch (err) {
      Logger.warn(
        { err, connectorId, tableNames: schemas.map((s) => s.tableName) },
        "DatabaseContext: precompute failed for connector (connect or executeReadOnlyQuery threw)",
      )
    }
  }

  return map
}
