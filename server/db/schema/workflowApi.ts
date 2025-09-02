import { pgTable, uuid, varchar, jsonb, integer, text, timestamp } from 'drizzle-orm/pg-core';
import { httpMethodEnum } from './workflowEnums';
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

// API call configurations (enhanced from api_call_info)
export const workflowApiCallConfig = pgTable('workflow_api_call_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  url: text('url').notNull(),
  method: httpMethodEnum('method').notNull(),
  headers: jsonb('headers'), // placeholders for some fields for runtime
  body: jsonb('body'),
  jsFunction: text('js_function'), // JavaScript function as string: return a.field1 == b.field2
  responseMapping: jsonb('response_mapping'),
  timeoutSeconds: integer('timeout_seconds').default(30),
  retryConfig: jsonb('retry_config'),
  authConfig: jsonb('auth_config'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Type exports for TypeScript
export const selectWorkflowApiCallConfigSchema = createSelectSchema(workflowApiCallConfig);
export const insertWorkflowApiCallConfigSchema = createInsertSchema(workflowApiCallConfig);
export type SelectWorkflowApiCallConfig = z.infer<typeof selectWorkflowApiCallConfigSchema>;
export type InsertWorkflowApiCallConfig = z.infer<typeof insertWorkflowApiCallConfigSchema>;

// Legacy exports for backward compatibility
export const apiCallConfig = workflowApiCallConfig;