import { pgTable, uuid, varchar, jsonb, timestamp, text, index, integer } from 'drizzle-orm/pg-core';
import { historyActionEnum } from './workflowEnums';
import { workspaces } from './workspaces';
import { users } from './users';
import { workflowExe, workflowStepExe } from './workflowExecution';
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

// Workflow execution history (replaces history)
export const workflowHistory = pgTable('workflow_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflowExeId: uuid('workflow_exe_id').references(() => workflowExe.id),
  workflowStepExeId: uuid('workflow_step_exe_id').references(() => workflowStepExe.id),
  action: historyActionEnum('action').notNull(),
  oldData: jsonb('old_data'),
  newData: jsonb('new_data'),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  workspaceId: integer('workspace_id').references(() => workspaces.id),
}, (table) => ({
  workflowCreatedIdx: index('workflow_history_workflow_exe_created_idx').on(table.workflowExeId, table.createdAt),
  workspaceCreatedIdx: index('workflow_history_workspace_created_idx').on(table.workspaceId, table.createdAt),
}));

// CRUD history for workflow entities
export const workflowCrudHistory = pgTable('workflow_crud_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: varchar('username', { length: 255 }),
  tableName: varchar('table_name', { length: 100 }).notNull(),
  entryId: varchar('entry_id', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  createdBy: integer('created_by').references(() => users.id),
  record: jsonb('record'),
});

// Event tracking for workflow system
export const workflowEventLog = pgTable('workflow_event_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityType: varchar('entity_type', { length: 100 }).notNull(), // workflow, step, template, etc.
  entityId: uuid('entity_id').notNull(),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  eventData: jsonb('event_data'),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  workspaceId: integer('workspace_id').references(() => workspaces.id),
}, (table) => ({
  entityIdx: index('workflow_event_log_entity_idx').on(table.entityType, table.entityId),
  workspaceCreatedIdx: index('workflow_event_log_workspace_created_idx').on(table.workspaceId, table.createdAt),
}));

// Type exports for TypeScript
export const selectWorkflowHistorySchema = createSelectSchema(workflowHistory);
export const insertWorkflowHistorySchema = createInsertSchema(workflowHistory);
export type SelectWorkflowHistory = z.infer<typeof selectWorkflowHistorySchema>;
export type InsertWorkflowHistory = z.infer<typeof insertWorkflowHistorySchema>;

export const selectWorkflowCrudHistorySchema = createSelectSchema(workflowCrudHistory);
export const insertWorkflowCrudHistorySchema = createInsertSchema(workflowCrudHistory);
export type SelectWorkflowCrudHistory = z.infer<typeof selectWorkflowCrudHistorySchema>;
export type InsertWorkflowCrudHistory = z.infer<typeof insertWorkflowCrudHistorySchema>;

export const selectWorkflowEventLogSchema = createSelectSchema(workflowEventLog);
export const insertWorkflowEventLogSchema = createInsertSchema(workflowEventLog);
export type SelectWorkflowEventLog = z.infer<typeof selectWorkflowEventLogSchema>;
export type InsertWorkflowEventLog = z.infer<typeof insertWorkflowEventLogSchema>;

// Legacy exports for backward compatibility
export const history = workflowHistory;
export const crudHistory = workflowCrudHistory;
export const eventLog = workflowEventLog;