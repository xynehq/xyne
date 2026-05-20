// Sub-agents are leaves under a parent agent. A parent can have 0..N
// sub-agents; each sub-agent has its own system prompt + tool subset but
// shares the parent's agentScope (KB / data-source / channel filters)
// when invoked — that is, when chat is routed to the parent agent and the
// LLM calls `dispatchSubagent({name, query})`, the nested pi-mono session
// inherits the parent's scope so vespa tools see the same allowlist.
//
// Persistence shape mirrors the in-memory contract M6/M7 will need:
//   • One row per sub-agent. Soft-deleted via `deleted_at` like the
//     parent `agents` table.
//   • `tools` is a JSONB string array of registry names — same shape as
//     the column added to `agents` in M3. Empty array = all registry
//     tools (back-compat with the "all tools" runner path).
//   • Sub-agents are flat: a sub-agent cannot dispatch further
//     sub-agents. The registry filter at build time enforces this; the
//     schema simply has no recursive FK.
//
// External-facing identity is the `external_id` text (same scheme as
// `agents.external_id`). The v2_chat_runs row written for a nested run
// stores this string in `sub_agent_id` (un-FK'd, mirroring how `agent_id`
// is stored there).

import { sql } from "drizzle-orm"
import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import { agents } from "./agents"
import { workspaces } from "./workspaces"

export const subAgents = pgTable(
  "sub_agents",
  {
    id: serial("id").notNull().primaryKey(),
    externalId: text("external_id").unique().notNull(),
    parentAgentId: integer("parent_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    // Short slug used as the `name` argument of dispatchSubagent. Unique
    // within a parent so the LLM can address sub-agents
    // unambiguously (e.g. {"name": "researcher", "query": "..."}).
    name: text("name").notNull(),
    // Routing hint surfaced to the parent LLM in the assembled prompt
    // (rendered as `<subagent name="…">{description}</subagent>`). Short
    // and action-oriented — this is what the model reads to decide
    // whether to dispatch.
    description: text("description").notNull(),
    // Sub-agent's own system prompt. Single field — sub-agents are leaves
    // and don't further split into main / tools / subagents sections.
    systemPrompt: text("system_prompt").notNull(),
    // Subset of pi-mono registry tool names this sub-agent can call.
    // Empty array = all registry tools (matches the runner's back-compat
    // path). `dispatchSubagent` is never registered into a sub-agent's
    // toolset — enforced in the runner, not by data.
    tools: jsonb("tools").notNull().default(sql`'[]'::jsonb`),
    // Reasoning effort for the nested pi-mono session this sub-agent
    // runs in. Stored per sub-agent so each leaf can be tuned
    // independently (a quick formatter sub-agent at "minimal", a
    // research sub-agent at "high"). At dispatch time the dispatch
    // tool reads this value off the resolved sub-agent record — the
    // parent's request doesn't override it. Stored as text rather than
    // pgEnum because pi-ai's ThinkingLevel may add variants (e.g.
    // "xhigh") without warranting an enum-alter migration; the zod
    // schema below pins the allowed values at the API boundary.
    thinkingLevel: text("thinking_level").notNull().default("medium"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    parentIndex: index("sub_agents_parent_idx").on(table.parentAgentId),
    nameUniquePerParent: uniqueIndex("sub_agents_name_per_parent_unique").on(
      table.parentAgentId,
      table.name,
    ),
  }),
)

// Allowed values for `thinking_level`. Mirrors pi-ai's `ThinkingLevel`
// minus "xhigh" (we don't expose it to sub-agent authors yet — the
// extra context-window cost isn't worth the variance, but the column
// is text-typed so adding it later is a zod-only change). Exported so
// the API layer + UI form can share one source of truth.
export const SUB_AGENT_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
] as const
export type SubAgentThinkingLevel = (typeof SUB_AGENT_THINKING_LEVELS)[number]
export const subAgentThinkingLevelSchema = z.enum(SUB_AGENT_THINKING_LEVELS)

export const insertSubAgentSchema = createInsertSchema(subAgents, {
  // Tool name list — validated as a subset of the registry at the API
  // layer (M6), so here we just enforce shape.
  tools: z.array(z.string()).optional().default([]),
  name: z
    .string()
    .min(2)
    .max(64)
    .regex(
      /^[a-z][a-z0-9-]*$/,
      "name must be a lowercase slug ([a-z][a-z0-9-]*)",
    ),
  description: z.string().min(1).max(500),
  systemPrompt: z.string().min(1),
  // Optional on input — defaults to "medium" if omitted so existing
  // create-payloads (without the field) keep working.
  thinkingLevel: subAgentThinkingLevelSchema.optional().default("medium"),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
})
export type InsertSubAgent = z.infer<typeof insertSubAgentSchema>

export const selectSubAgentSchema = createSelectSchema(subAgents, {
  tools: z.array(z.string()).default([]),
  thinkingLevel: subAgentThinkingLevelSchema,
})
export type SelectSubAgent = z.infer<typeof selectSubAgentSchema>
