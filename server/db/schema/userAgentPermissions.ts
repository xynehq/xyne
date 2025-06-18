import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  integer,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { UserAgentRole } from "@/shared/types"
import { users } from "@/db/schema/users"
import { agents } from "@/db/schema/agents"

export const userAgentRoleEnum = pgEnum(
  "user_agent_role",
  Object.values(UserAgentRole) as [string, ...string[]],
)

// User-Agent Permissions Table
export const userAgentPermissions = pgTable(
  "user_agent_permissions",
  {
    id: serial("id").notNull().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: integer("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    role: userAgentRoleEnum("role").notNull().default(UserAgentRole.Shared),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (table) => ({
    // Unique constraint to prevent duplicate user-agent relationships
    userAgentPermissionUniqueIndex: uniqueIndex(
      "user_agent_permission_unique_index",
    ).on(table.userId, table.agentId),
    // Index for efficient queries by user
    userIdIndex: index("user_agent_permissions_user_id_index").on(table.userId),
    // Index for efficient queries by agent
    agentIdIndex: index("user_agent_permissions_agent_id_index").on(
      table.agentId,
    ),
    // Index for efficient queries by role
    roleIndex: index("user_agent_permissions_role_index").on(table.role),
  }),
)

export const insertUserAgentPermissionSchema = createInsertSchema(
  userAgentPermissions,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
})
export type InsertUserAgentPermission = z.infer<
  typeof insertUserAgentPermissionSchema
>

export const selectUserAgentPermissionSchema =
  createSelectSchema(userAgentPermissions)
export type SelectUserAgentPermission = z.infer<
  typeof selectUserAgentPermissionSchema
>

// Schema for user-agent permission relationship with user and agent details
export const userAgentPermissionWithDetailsSchema =
  selectUserAgentPermissionSchema.extend({
    user: z.object({
      id: z.number(),
      email: z.string(),
      name: z.string(),
      photoLink: z.string().nullable(),
      externalId: z.string(),
    }),
    agent: z.object({
      id: z.number(),
      externalId: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      model: z.string(),
    }),
  })
export type UserAgentPermissionWithDetails = z.infer<
  typeof userAgentPermissionWithDetailsSchema
>
