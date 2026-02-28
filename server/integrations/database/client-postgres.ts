/**
 * Postgres client for the database connector.
 * Uses the same `postgres` package as the app for consistency.
 */

import postgres, { type Sql } from "postgres"
import type {
  ColumnInfo,
  DbRow,
  TableInfo,
  TableSyncState,
} from "./types"
import type { DatabaseConnectorConfig } from "@/shared/types"
import { DatabaseEngine } from "./types"

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
    const { host, port, database, auth, ssl } = this.config
    if ("iamAuth" in auth && auth.iamAuth) {
      throw new Error("IAM auth not supported for Postgres in this connector")
    }
    const { username, password: pwd } = auth as {
      username: string
      password: string
    }
    const user = encodeURIComponent(username)
    const password = encodeURIComponent(pwd)
    const sslMode = ssl?.rejectUnauthorized === false ? "require" : "prefer"
    return `postgres://${user}:${password}@${host}:${port}/${database}?sslmode=${sslMode}`
  }

  async connect(): Promise<void> {
    if (this.sql) return
    const url = this.getConnectionString()
    this.sql = postgres(url, {
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10,
    })
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
    const rows = await this.sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ${schema}
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `
    return (rows as unknown as { table_name: string }[]).map((r) => ({
      name: r.table_name,
      schema,
    }))
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

  /** Allow only safe SQL identifiers (table, schema, column names from info_schema). */
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
      // Validate lastUpdatedAt is a safe number/date before use
      const lastUpdatedAt = new Date(state.lastUpdatedAt).toISOString()
      const rows = await this.sql.unsafe(
        `SELECT * FROM ${fromClause}
         WHERE ${quotedWatermark} > $1
         ORDER BY ${orderByClause}
         LIMIT $2`,
        [lastUpdatedAt, batchSize]
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
