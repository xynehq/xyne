// Database schema for resumable Slack channel ingestion system
// This file defines the ingestions table and related types for managing
// long-running ingestion processes with resumability support

import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { workspaces } from "./workspaces"
import { users } from "./users"
import { connectors } from "./connectors"

// Enum defining all possible states of an ingestion process
// - pending: Ingestion created but not yet started
// - in_progress: Currently running ingestion
// - paused: Ingestion temporarily paused by user
// - completed: Successfully finished ingestion
// - failed: Ingestion stopped due to error
// - cancelled: User manually cancelled the ingestion
export const ingestionStatusEnum = pgEnum("ingestion_status", [
  "pending",
  "in_progress", 
  "paused",
  "completed",
  "failed",
  "cancelled"
])

// Main ingestions table that tracks all ingestion processes
// Each row represents one ingestion job with its current state and progress
export const ingestions = pgTable(
  "ingestions",
  {
    // Primary key for the ingestion record
    id: serial("id").notNull().primaryKey(),
    
    // Foreign key to users table - identifies who started this ingestion
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    
    // Foreign key to connectors table - identifies which Slack workspace
    connectorId: integer("connector_id")
      .notNull()
      .references(() => connectors.id),
    
    // Foreign key to workspaces table - identifies the workspace context
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    
    // Current status of the ingestion process (see enum above)
    status: ingestionStatusEnum("status").notNull().default("pending"),
    
    // JSONB field storing all ingestion state and progress data
    // Contains WebSocket data, channel progress, resumability state, etc.
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    
    // Optional error message when ingestion fails
    errorMessage: text("error_message"),
    
    // Timestamp when ingestion actually started processing
    startedAt: timestamp("started_at", { withTimezone: true }),
    
    // Timestamp when ingestion finished (completed, failed, or cancelled)
    completedAt: timestamp("completed_at", { withTimezone: true }),
    
    // Timestamp when ingestion record was created
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    
    // Timestamp when ingestion record was last updated
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  // No unique constraints - application logic will handle preventing concurrent active ingestions
)

// Zod schema defining the structure of Slack-specific metadata stored in JSONB
// This contains all the data needed for resumability and WebSocket communication
export const slackIngestionMetadataSchema = z.object({
  // Data sent over WebSocket to frontend for real-time progress updates
  websocketData: z.object({
    // Connector ID for WebSocket message routing
    connectorId: z.string(),
    // Currently processing channel ID (for display)
    currentChannelId: z.string().optional(),
    // Progress information shown to user
    progress: z.object({
      totalChannels: z.number().optional(),        // Total channels to process
      processedChannels: z.number().optional(),    // Channels completed so far
      currentChannel: z.string().optional(),       // Name of current channel
      totalMessages: z.number().optional(),        // Total messages found
      processedMessages: z.number().optional(),    // Messages processed so far
    }).optional(),
  }),
  
  // Internal state data used for resuming interrupted ingestions
  ingestionState: z.object({
    // Current channel being processed (for resumability)
    currentChannelId: z.string().optional(),
    // Last message timestamp processed (for resumability)
    lastMessageTs: z.string().optional(),
    // When this state was last updated
    lastUpdated: z.string(),
    
    // Original ingestion parameters (needed for resuming)
    channelsToIngest: z.array(z.string()).optional(),  // List of channel IDs to process
    startDate: z.string().optional(),                  // Date range start
    endDate: z.string().optional(),                    // Date range end
    includeBotMessage: z.boolean().optional(),         // Whether to include bot messages
    currentChannelIndex: z.number().optional(),        // Index in channelsToIngest array
  }).optional(),
})

// Generic metadata schema that can support different integration types
// Currently only supports Slack, but extensible for future integrations
export const ingestionMetadataSchema = z.object({
  slack: slackIngestionMetadataSchema.optional(),
})

// Zod schemas for type-safe database operations
// These provide runtime validation and TypeScript types

// Schema for inserting new ingestion records
export const insertIngestionSchema = createInsertSchema(ingestions, {
  metadata: ingestionMetadataSchema.optional(),
})

// Schema for selecting/reading ingestion records
export const selectIngestionSchema = createSelectSchema(ingestions, {
  metadata: ingestionMetadataSchema.optional(),
})

// TypeScript types exported for use throughout the application
export type InsertIngestion = z.infer<typeof insertIngestionSchema>
export type SelectIngestion = z.infer<typeof selectIngestionSchema>
export type IngestionStatus =
  | "pending"
  | "in_progress"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
export type SlackIngestionMetadata = z.infer<typeof slackIngestionMetadataSchema>