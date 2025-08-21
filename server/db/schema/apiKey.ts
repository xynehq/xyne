import { pgTable, serial, integer, timestamp,text } from "drizzle-orm/pg-core";
import { agents } from "./agents"; // your existing agents table

export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  agentId: text("agent_id")
    .references(() => agents.externalId, { onDelete: "cascade" })
    .notNull(),
  key: text("key").notNull(), // encrypted key
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
