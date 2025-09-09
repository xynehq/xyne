import { pgTable, uuid, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { toolTypeEnum } from './workflowEnums';
import { workflowTemplate } from './workflowTemplate';
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

// Tool table for storing tool configurations
export const workflowTool = pgTable('workflow_tool', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: toolTypeEnum('type').notNull(),
  value: jsonb('value'),
  config: jsonb('config'),
  workflowTemplateId: uuid('workflow_template_id').references(() => workflowTemplate.id),
});

// Tool execution table for storing tool execution results
export const workflowToolExec = pgTable('workflow_tool_exec', {
  id: uuid('id').primaryKey().defaultRandom(),
  result: jsonb('result'),
  toolId: uuid('tool_id').references(() => workflowTool.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

// Type exports for TypeScript
export const selectWorkflowToolSchema = createSelectSchema(workflowTool);
export const insertWorkflowToolSchema = createInsertSchema(workflowTool);
export type SelectWorkflowTool = z.infer<typeof selectWorkflowToolSchema>;
export type InsertWorkflowTool = z.infer<typeof insertWorkflowToolSchema>;

export const selectWorkflowToolExecSchema = createSelectSchema(workflowToolExec);
export const insertWorkflowToolExecSchema = createInsertSchema(workflowToolExec);
export type SelectWorkflowToolExec = z.infer<typeof selectWorkflowToolExecSchema>;
export type InsertWorkflowToolExec = z.infer<typeof insertWorkflowToolExecSchema>;

// Legacy exports for backward compatibility
export const tool = workflowTool;
export const toolExec = workflowToolExec;