import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { UserRole } from "@/shared/types"
import { workspaces } from "./workspaces"
import { encryptedText } from "../customType"
import { Encryption } from "@/utils/encryption"
const encryptionKey = process.env.ENCRYPTION_KEY!

export const userRoleEnum = pgEnum(
  "role",
  Object.values(UserRole) as [string, ...string[]],
)

const refreshTokenEncryption = new Encryption(encryptionKey)

// Users Table
export const users = pgTable(
  "users",
  {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: text("email").notNull(),
    name: text("name").notNull(),
    photoLink: text("photoLink"),
    externalId: text("external_id").unique().notNull(),
    // this will come handy for jwt token
    workspaceExternalId: text("workspace_external_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    lastLogin: timestamp("last_login", { withTimezone: true }),
    role: userRoleEnum("role").notNull().default(UserRole.User),
    refreshToken: encryptedText(refreshTokenEncryption)("refreshToken"),
    timeZone: text("time_zone").notNull().default("Asia/Kolkata"),
  },
  (table) => ({
    emailUniqueIndex: uniqueIndex("email_unique_index").on(
      sql`LOWER(${table.email})`,
    ),
  }),
)

export const selectUserSchema = createSelectSchema(users)
export type SelectUser = z.infer<typeof selectUserSchema>

export const userPublicSchema = selectUserSchema.omit({
  lastLogin: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  id: true,
  workspaceId: true,
})

export const userMetadataSchema = userPublicSchema.omit({
  role: true,
  timeZone: true,
  refreshToken: true
})

export type UserMetadata = z.infer<typeof userMetadataSchema>

export type PublicUser = z.infer<typeof userPublicSchema>
