import { relations } from "drizzle-orm/relations"
import {
  workspaces,
  users,
  oauthProviders,
  connectors,
  syncJobs,
} from "./schema"

export const usersRelations = relations(users, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [users.workspaceId],
    references: [workspaces.id],
  }),
  oauthProviders: many(oauthProviders),
  connectors: many(connectors),
}))

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  users: many(users),
  oauthProviders: many(oauthProviders),
  syncJobs: many(syncJobs),
  connectors: many(connectors),
}))

export const oauthProvidersRelations = relations(oauthProviders, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [oauthProviders.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [oauthProviders.userId],
    references: [users.id],
  }),
  connector: one(connectors, {
    fields: [oauthProviders.containerId],
    references: [connectors.id],
  }),
}))

export const connectorsRelations = relations(connectors, ({ one, many }) => ({
  oauthProviders: many(oauthProviders),
  syncJobs: many(syncJobs),
  workspace: one(workspaces, {
    fields: [connectors.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [connectors.userId],
    references: [users.id],
  }),
}))

export const syncJobsRelations = relations(syncJobs, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [syncJobs.workspaceId],
    references: [workspaces.id],
  }),
  connector: one(connectors, {
    fields: [syncJobs.connectorId],
    references: [connectors.id],
  }),
}))
