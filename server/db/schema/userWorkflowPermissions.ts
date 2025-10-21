import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  integer,
  uuid,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { users } from "./users"
import { workflowTemplate } from "./workflows"
import { UserWorkflowRole } from "@/shared/types"

export const userWorkflowRoleEnum = pgEnum(
  "user_workflow_role",
  Object.values(UserWorkflowRole) as [string, ...string[]],
)

export const userWorkflowPermissions = pgTable(
  "user_workflow_permissions",
  {
    id: serial("id").notNull().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflowTemplate.id, { onDelete: "cascade" }),
    role: userWorkflowRoleEnum("role")
      .notNull()
      .default(UserWorkflowRole.Shared),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (table) => ({
    // Index for efficient queries by user
    userIdIndex: index("user_workflow_permissions_user_id_index").on(
      table.userId,
    ),
    // Index for efficient queries by workflow
    workflowIdIndex: index("user_workflow_permissions_workflow_id_index").on(
      table.workflowId,
    ),
    // Index for efficient queries by role
    roleIndex: index("user_workflow_permissions_role_index").on(table.role),
  }),
)

export const insertUserWorkflowPermissionSchema = createInsertSchema(
  userWorkflowPermissions,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
})
export type InsertUserWorkflowPermission = z.infer<
  typeof insertUserWorkflowPermissionSchema
>

export const selectUserWorkflowPermissionSchema = createSelectSchema(
  userWorkflowPermissions,
)
export type SelectUserWorkflowPermission = z.infer<
  typeof selectUserWorkflowPermissionSchema
>

// Schema for user-workflow permission relationship with user and workflow details
export const userWorkflowPermissionWithDetailsSchema =
  selectUserWorkflowPermissionSchema.extend({
    user: z.object({
      id: z.number(),
      email: z.string(),
      name: z.string(),
      photoLink: z.string().nullable(),
      externalId: z.string(),
    }),
    workflow: z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      version: z.string(),
    }),
  })
export type UserWorkflowPermissionWithDetails = z.infer<
  typeof userWorkflowPermissionWithDetailsSchema
>
