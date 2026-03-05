/**
 * Postgres client for the database connector.
 * Uses the same `postgres` package as the app for consistency.
 */

import postgres, { type Sql } from "postgres"
import type {
  ColumnInfo,
  ColumnStats,
  DbRow,
  TableInfo,
  TableSyncState,
} from "./types"
import type { DatabaseTableSchemaDoc } from "./types"
import type { DatabaseConnectorConfig } from "@/shared/types"
import { DatabaseEngine } from "./types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Integrations).child({ module: "postgres-client" })

export class PostgresClient {
  private sql: Sql<{}> | null = null
  private config: DatabaseConnectorConfig

  constructor(config: DatabaseConnectorConfig) {
    if (config.engine !== DatabaseEngine.Postgres) {
      throw new Error("PostgresClient requires engine Postgres")
    }
    this.config = config
  }

  private getConnectionString(): string {
    const { host, port, database, auth } = this.config
    if ("iamAuth" in auth && auth.iamAuth) {
      throw new Error("IAM auth not supported for Postgres in this connector")
    }
    const { username, password: pwd } = auth as {
      username: string
      password: string
    }
    const user = encodeURIComponent(username)
    const password = encodeURIComponent(pwd)
    // URI-encode all components to prevent connection string manipulation (e.g. host="evil.com/foo?sslmode=disable")
    const hostEnc = encodeURIComponent(String(host))
    const portEnc = encodeURIComponent(String(port))
    const dbEnc = encodeURIComponent(String(database))
    return `postgres://${user}:${password}@${hostEnc}:${portEnc}/${dbEnc}`
  }

  async connect(): Promise<void> {
    if (this.sql) return
    const { host, port, database } = this.config
    const schema = this.getSchema()
    Logger.info(
      { host, port, database, schema },
      "PostgresClient: connecting",
    )
    const url = this.getConnectionString()
    this.sql = postgres(url, {
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10,
    })
    try {
      await this.sql`SELECT 1`
      Logger.info(
        { host, port, database, schema },
        "PostgresClient: connected successfully",
      )
    } catch (err) {
      Logger.error(
        { err, host, port, database, schema },
        "PostgresClient: connection failed",
      )
      await this.sql.end().catch(() => {})
      this.sql = null
      throw err
    }
  }

  async disconnect(): Promise<void> {
    if (this.sql) {
      await this.sql.end()
      this.sql = null
    }
  }

  private getSchema(): string {
    return this.config.schema || "public"
  }

  async listTables(): Promise<TableInfo[]> {
    if (!this.sql) throw new Error("Not connected")
    const schema = this.getSchema()
    Logger.debug({ schema }, "PostgresClient: listTables querying information_schema")
    const rows = await this.sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ${schema}
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `
    const tables = (rows as unknown as { table_name: string }[]).map((r) => ({
      name: r.table_name,
      schema,
    }))
    Logger.info(
      { schema, tableCount: tables.length, tableNames: tables.map((t) => t.name) },
      "PostgresClient: listTables result",
    )
    return tables
  }

  async getTableColumns(table: string): Promise<ColumnInfo[]> {
    if (!this.sql) throw new Error("Not connected")
    const schema = this.getSchema()
    const rows = await this.sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = ${table}
      ORDER BY ordinal_position
    `
    return (rows as unknown as { column_name: string; data_type: string; is_nullable: string }[]).map(
      (r) => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === "YES",
      }),
    )
  }

  async getPrimaryKeyColumns(table: string): Promise<string[]> {
    if (!this.sql) throw new Error("Not connected")
    const schema = this.getSchema()
    const rows = await this.sql`
      SELECT a.attname
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema}
        AND c.relname = ${table}
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)
    `
    return (rows as unknown as { attname: string }[]).map((r) => r.attname)
  }

  /** Foreign keys for a table. Used for schema-only docs and SQL generation. */
  async getForeignKeyColumns(table: string): Promise<
    { columns: string[]; referencedTable: string; referencedColumns: string[] }[]
  > {
    if (!this.sql) throw new Error("Not connected")
    const schema = this.getSchema()
    const rows = await this.sql`
      SELECT
        array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columns,
        ccu.table_name AS referenced_table,
        array_agg(ccu.column_name ORDER BY kcu.ordinal_position) AS referenced_columns
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = ${schema}
        AND tc.table_name = ${table}
      GROUP BY tc.constraint_name, ccu.table_name
    `
    return (rows as unknown as { columns: string[]; referenced_table: string; referenced_columns: string[] }[]).map(
      (r) => ({
        columns: r.columns,
        referencedTable: r.referenced_table,
        referencedColumns: r.referenced_columns,
      }),
    )
  }

  /** Full schema for one table (columns, PK, FKs, optional row count and column stats). Used for schema-only sync. */
  async getTableSchemaFull(
    tableName: string,
    connectorId: string,
    options?: { includeRowCount?: boolean; includeColumnStats?: boolean },
  ): Promise<DatabaseTableSchemaDoc> {
    const schema = this.getSchema()
    const columns = await this.getTableColumns(tableName)
    const pkColumns = await this.getPrimaryKeyColumns(tableName)
    const pkSet = new Set(pkColumns)
    const fkRows = await this.getForeignKeyColumns(tableName)
    const foreignKeys = fkRows.map((r) => ({
      columns: r.columns,
      referencedTable: r.referencedTable,
      referencedColumns: r.referencedColumns,
    }))
    let rowCount: number | undefined
    if (options?.includeRowCount) {
      const countRows = await this.sql!.unsafe(
        `SELECT count(*)::int AS c FROM ${PostgresClient.safeIdentifier(schema)}.${PostgresClient.safeIdentifier(tableName)}`,
      ) as { c: number }[]
      rowCount = countRows[0]?.c
    }
    const columnList = columns.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      isPrimaryKey: pkSet.has(c.name),
    }))
    const description = `Table: ${schema}.${tableName} - ${columns.length} columns (${columns.map((c) => c.name).join(", ")})`
    let columnStats: Record<string, ColumnStats> | undefined
    if (options?.includeColumnStats && columns.length > 0) {
      columnStats = await this.getTableColumnStats(tableName, columns)
    }
    return {
      source: "database_connector",
      connectorId,
      tableName,
      schema,
      columns: columnList,
      primaryKey: pkColumns,
      foreignKeys: foreignKeys.length ? foreignKeys : undefined,
      rowCount,
      columnStats,
      description,
    }
  }

  /** True if Postgres type supports MIN/MAX/AVG/STDDEV (numeric). */
  private static isNumericType(dataType: string): boolean {
    return /^(integer|bigint|smallint|numeric|decimal|real|double precision)$/i.test(dataType)
  }

  /** True if Postgres type supports MIN/MAX (date/time). */
  private static isDateTimeType(dataType: string): boolean {
    return /^(date|timestamp|time)/i.test(dataType)
  }

  /**
   * Get describe-like aggregates per column from a sample of the table.
   * Helps the LLM with SQL generation (value ranges, distinct counts).
   */
  async getTableColumnStats(
    tableName: string,
    columns: ColumnInfo[],
    options?: { sampleRows?: number; timeoutMs?: number },
  ): Promise<Record<string, ColumnStats>> {
    if (!this.sql) throw new Error("Not connected")
    const schema = this.getSchema()
    const sampleRows = Math.min(Math.max(options?.sampleRows ?? 10_000, 1), 50_000)
    const timeoutMs = options?.timeoutMs ?? 30_000
    const quotedSchema = PostgresClient.safeIdentifier(schema)
    const quotedTable = PostgresClient.safeIdentifier(tableName)

    const selects: string[] = []
    const colMeta: { name: string; type: string }[] = []
    for (let i = 0; i < columns.length; i++) {
      const c = columns[i]
      const q = PostgresClient.safeIdentifier(c.name)
      const base = `(COUNT(*) - COUNT(${q}))::int AS _null_${i}, COUNT(DISTINCT ${q})::int AS _dist_${i}`
      if (PostgresClient.isNumericType(c.type)) {
        selects.push(
          `${base}, MIN(${q}) AS _min_${i}, MAX(${q}) AS _max_${i}, AVG(${q}) AS _avg_${i}, STDDEV(${q}) AS _stddev_${i}`,
        )
      } else if (PostgresClient.isDateTimeType(c.type)) {
        selects.push(`${base}, MIN(${q})::text AS _min_${i}, MAX(${q})::text AS _max_${i}`)
      } else {
        selects.push(base)
      }
      colMeta.push({ name: c.name, type: c.type })
    }

    const sql = `SELECT ${selects.join(", ")} FROM (SELECT * FROM ${quotedSchema}.${quotedTable} LIMIT ${sampleRows}) _t`
    const aggRows = await this.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = '${timeoutMs}'`)
      return (await tx.unsafe(sql)) as Record<string, unknown>[]
    })
    const row = aggRows[0]
    if (!row || typeof row !== "object") return {}

    const out: Record<string, ColumnStats> = {}
    for (let i = 0; i < colMeta.length; i++) {
      const { name, type } = colMeta[i]
      const stats: ColumnStats = {}
      const nullVal = row[`_null_${i}`]
      const distVal = row[`_dist_${i}`]
      if (typeof nullVal === "number") stats.nullCount = nullVal
      if (typeof distVal === "number") stats.distinctCount = distVal
      if (PostgresClient.isNumericType(type)) {
        const minVal = row[`_min_${i}`]
        const maxVal = row[`_max_${i}`]
        const avgVal = row[`_avg_${i}`]
        const stdVal = row[`_stddev_${i}`]
        if (minVal !== null && minVal !== undefined) stats.min = minVal as number
        if (maxVal !== null && maxVal !== undefined) stats.max = maxVal as number
        if (typeof avgVal === "number") stats.avg = avgVal
        if (typeof stdVal === "number" && !Number.isNaN(stdVal)) stats.stddev = stdVal
      } else if (PostgresClient.isDateTimeType(type)) {
        const minVal = row[`_min_${i}`]
        const maxVal = row[`_max_${i}`]
        if (minVal != null) stats.min = String(minVal)
        if (maxVal != null) stats.max = String(maxVal)
      }
      out[name] = stats
    }

    /** Only store sample values for enum-like columns (low cardinality in sample). */
    const maxDistinctForSampleValues = 300
    const sampleStringMaxLen = 100

    const enumLikeColumns = new Set(
      colMeta
        .filter((c) => {
          const s = out[c.name]
          return s?.distinctCount != null && s.distinctCount <= maxDistinctForSampleValues
        })
        .map((c) => c.name),
    )
    if (enumLikeColumns.size === 0) return out

    const sampleSql = `SELECT * FROM ${quotedSchema}.${quotedTable} LIMIT ${sampleRows}`
    const sampleRowsResult = await this.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = '${timeoutMs}'`)
      return (await tx.unsafe(sampleSql)) as Record<string, unknown>[]
    })
    if (Array.isArray(sampleRowsResult) && sampleRowsResult.length > 0) {
      for (const { name } of colMeta) {
        if (!enumLikeColumns.has(name) || !out[name]) continue
        const seen = new Set<string>()
        const values: (string | number | boolean | null)[] = []
        for (const r of sampleRowsResult) {
          const v = (r as Record<string, unknown>)[name]
          const key =
            v === null || v === undefined
              ? "__null__"
              : typeof v === "object"
                ? JSON.stringify(v)
                : String(v)
          if (seen.has(key)) continue
          seen.add(key)
          if (v === null || v === undefined) {
            values.push(null)
          } else if (typeof v === "number" || typeof v === "boolean") {
            values.push(v)
          } else {
            const s = typeof v === "string" ? v : String(v)
            values.push(s.length > sampleStringMaxLen ? s.slice(0, sampleStringMaxLen) + "…" : s)
          }
        }
        if (values.length > 0) out[name].sampleValues = values
      }
    }

    return out
  }

  /**
   * Execute a read-only SELECT on the client DB. Uses a read-only transaction, statement_timeout, and row limit.
   * SET TRANSACTION READ ONLY ensures the database rejects any write even if validation is bypassed.
   * Caller must ensure SQL is validated as SELECT-only (e.g. via validatePostgresQuery).
   */
  async executeReadOnlyQuery(
    sql: string,
    options?: { timeoutMs?: number; rowLimit?: number },
  ): Promise<DbRow[]> {
    if (!this.sql) throw new Error("Not connected")
    const timeoutMs = options?.timeoutMs ?? 30_000
    const rowLimit = options?.rowLimit ?? 1000
    const trimmed = sql.trimEnd().replace(/;\s*$/, "")
    const limited = `SELECT * FROM (${trimmed}) AS __xyne_limited LIMIT $1`
    const sqlPreview = trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed
    Logger.info(
      { sqlPreview, timeoutMs, rowLimit },
      "PostgresClient: executeReadOnlyQuery start",
    )
    let rows: DbRow[]
    try {
      rows = await this.sql.begin(async (tx) => {
        await tx.unsafe("SET TRANSACTION READ ONLY")
        await tx.unsafe(`SET LOCAL statement_timeout = '${timeoutMs}'`)
        return (await tx.unsafe(limited, [rowLimit])) as DbRow[]
      })
    } catch (err) {
      Logger.error(
        { err, sqlPreview, timeoutMs, rowLimit },
        "PostgresClient: executeReadOnlyQuery failed",
      )
      throw err
    }
    const result = Array.isArray(rows) ? rows : []
    Logger.info(
      { rowCount: result.length, rowLimit, sqlPreview },
      "PostgresClient: executeReadOnlyQuery result",
    )
    return result
  }

  /**
   * Quote a SQL identifier. Security boundary is the regex: only [a-zA-Z_][a-zA-Z0-9_]* is allowed.
   * Do not relax the regex (e.g. to allow hyphens or Unicode) without proper escaping.
   */
  private static safeIdentifier(name: string): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid identifier: ${name}`)
    }
    return `"${name.replace(/"/g, '""')}"`
  }

  async fetchRows(
    table: string,
    state: TableSyncState,
    batchSize: number,
    watermarkColumn?: string,
  ): Promise<DbRow[]> {
    if (!this.sql) throw new Error("Not connected")
    const schema = this.getSchema()
    const pkCols = await this.getPrimaryKeyColumns(table)
    if (pkCols.length === 0) {
      throw new Error(`Table ${schema}.${table} has no primary key`)
    }
    const quotedSchema = PostgresClient.safeIdentifier(schema)
    const quotedTable = PostgresClient.safeIdentifier(table)
    const quotedPkCols = pkCols.map((c) => PostgresClient.safeIdentifier(c))
    const orderByClause = quotedPkCols.join(", ")
    const fromClause = `${quotedSchema}.${quotedTable}`

    if (watermarkColumn && state.lastUpdatedAt != null) {
      const quotedWatermark = PostgresClient.safeIdentifier(watermarkColumn)
      const columns = await this.getTableColumns(table)
      const watermarkCol = columns.find(
        (c) => c.name.toLowerCase() === watermarkColumn.toLowerCase(),
      )
      const dataType = watermarkCol?.type?.toLowerCase() ?? ""
      const isNumeric =
        /^(integer|bigint|smallint|numeric|decimal|real|double precision)$/.test(
          dataType,
        )
      const param: string | number =
        isNumeric && typeof state.lastUpdatedAt === "number"
          ? state.lastUpdatedAt
          : isNumeric && typeof state.lastUpdatedAt === "string"
            ? Number(state.lastUpdatedAt) || new Date(state.lastUpdatedAt).getTime()
            : new Date(state.lastUpdatedAt).toISOString()

      if (state.lastPk) {
        let cursorValues: unknown[]
        try {
          cursorValues = JSON.parse(state.lastPk) as unknown[]
        } catch {
          throw new Error(`Invalid lastPk cursor for table ${schema}.${table}`)
        }
        if (cursorValues.length !== pkCols.length) {
          throw new Error(
            `lastPk cursor length does not match primary key columns for table ${schema}.${table}`,
          )
        }
        const pkPlaceholders = cursorValues.map((_, i) => `$${i + 2}`).join(", ")
        const params: (string | number | boolean | Date | null)[] = [
          param,
          ...(cursorValues as (string | number | boolean | Date | null)[]),
          batchSize,
        ]
        const limitParam = `$${params.length}`
        const rows = await this.sql.unsafe(
          `SELECT * FROM ${fromClause}
           WHERE (${quotedWatermark} > $1) OR (${quotedWatermark} = $1 AND (${orderByClause}) > (${pkPlaceholders}))
           ORDER BY ${quotedWatermark} ASC, ${orderByClause}
           LIMIT ${limitParam}`,
          params,
        ) as DbRow[]
        return rows
      }

      const rows = await this.sql.unsafe(
        `SELECT * FROM ${fromClause}
         WHERE ${quotedWatermark} > $1
         ORDER BY ${quotedWatermark} ASC, ${orderByClause}
         LIMIT $2`,
        [param, batchSize],
      ) as DbRow[]
      return rows
    }

    if (state.lastPk) {
      let cursorValues: unknown[]
      try {
        cursorValues = JSON.parse(state.lastPk) as unknown[]
      } catch {
        throw new Error(`Invalid lastPk cursor for table ${schema}.${table}`)
      }
      if (cursorValues.length !== pkCols.length) {
        throw new Error(
          `lastPk cursor length does not match primary key columns for table ${schema}.${table}`,
        )
      }
      const placeholders = cursorValues.map((_, i) => `$${i + 1}`).join(", ")
      const params: (string | number | boolean | Date | null)[] = [
        ...(cursorValues as (string | number | boolean | Date | null)[]),
        batchSize,
      ]
      const limitParam = `$${params.length}`
      const rows = await this.sql.unsafe(
        `SELECT * FROM ${fromClause}
         WHERE (${quotedPkCols.join(", ")}) > (${placeholders})
         ORDER BY ${orderByClause}
         LIMIT ${limitParam}`,
        params
      ) as DbRow[]
      return rows
    }

    const rows = await this.sql.unsafe(
      `SELECT * FROM ${fromClause}
       ORDER BY ${orderByClause}
       LIMIT $1`,
      [batchSize]
    ) as DbRow[]
    return rows
  }
}
