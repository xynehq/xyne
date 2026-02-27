import { sql } from "drizzle-orm"
import {
  pgTable,
  text,
  integer,
  timestamp,
  bigint,
  unique,
} from "drizzle-orm/pg-core"
import { connectors } from "./connectors"

/**
 * Per-table sync state for database connectors.
 * One row per (connector, table) for checkpoint/resume.
 */
export const databaseSyncState = pgTable(
  "database_sync_state",
  {
    connectorId: integer("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    tableName: text("table_name").notNull(),
    lastPk: text("last_pk"),
    lastUpdatedAt: bigint("last_updated_at", { mode: "number" }),
    lastLsn: text("last_lsn"),
    rowsSynced: integer("rows_synced").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [unique().on(t.connectorId, t.tableName)],
)
