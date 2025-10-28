// Database functions for managing resumable Slack channel ingestion records
// Provides CRUD operations and business logic for the ingestions table

import { eq, and, sql } from "drizzle-orm"
import { 
  ingestions, 
  type InsertIngestion, 
  type SelectIngestion,
  type IngestionStatus 
} from "./schema/ingestions"
import type { TxnOrClient } from "@/types"

// Creates a new ingestion record in the database
// Returns the created record with generated ID and timestamps
export const createIngestion = async (
  txn: TxnOrClient,
  data: InsertIngestion
): Promise<SelectIngestion> => {
  const [result] = await txn
    .insert(ingestions)
    .values(data)
    .returning()
  return result as SelectIngestion
}

// Finds any active (in_progress, paused, or failed) ingestion for a specific user and connector
// Used to check if an ingestion is already running before starting a new one
// Returns null if no active ingestion exists
export const getActiveIngestionForUser = async (
  txn: TxnOrClient,
  userId: number,
  connectorId: number
): Promise<SelectIngestion | null> => {
  const result = await txn
    .select()
    .from(ingestions)
    .where(
      and(
        eq(ingestions.userId, userId),
        eq(ingestions.connectorId, connectorId),
        sql`status IN ('in_progress', 'paused', 'failed')`
      )
    )
    .limit(1)
  
  return (result[0] as SelectIngestion) || null
}

// Updates the status of an ingestion with automatic timestamp management
// Handles setting startedAt, completedAt, and error messages based on status
// Used throughout the ingestion lifecycle to track progress
export const updateIngestionStatus = async (
  txn: TxnOrClient,
  ingestionId: number,
  status: IngestionStatus,
  errorMessage?: string
): Promise<SelectIngestion> => {
  const updateData: any = {
    status,
    updatedAt: sql`NOW()`,
  }
  
  // Set startedAt timestamp when ingestion begins processing
  if (status === "in_progress" && !errorMessage) {
    updateData.startedAt = sql`NOW()`
  }
  
  // Set completedAt timestamp when ingestion finishes (any final state)
  if (status === "completed" || status === "failed" || status === "cancelled") {
    updateData.completedAt = sql`NOW()`
  }
  
  // Store error message for failed ingestions
  if (errorMessage) {
    updateData.errorMessage = errorMessage
  }

  const [result] = await txn
    .update(ingestions)
    .set(updateData)
    .where(eq(ingestions.id, ingestionId))
    .returning()
    
  return result as SelectIngestion
}

// Updates the metadata field of an ingestion record
// Used to store progress, WebSocket data, and resumability state
// Called frequently during ingestion to persist current state
export const updateIngestionMetadata = async (
  txn: TxnOrClient,
  ingestionId: number,
  metadata: any
): Promise<SelectIngestion> => {
  const [result] = await txn
    .update(ingestions)
    .set({
      metadata,
      updatedAt: sql`NOW()`,
    })
    .where(eq(ingestions.id, ingestionId))
    .returning()
    
  return result as SelectIngestion
}

// Retrieves a specific ingestion record by its ID
// Used for loading ingestion details for resume, cancel, and status operations
// Returns null if ingestion doesn't exist
export const getIngestionById = async (
  txn: TxnOrClient,
  ingestionId: number
): Promise<SelectIngestion | null> => {
  const result = await txn
    .select()
    .from(ingestions)
    .where(eq(ingestions.id, ingestionId))
    .limit(1)
    
  return (result[0] as SelectIngestion) || null
}


// Fast check to see if user has any active ingestions for a connector
// Used to prevent concurrent ingestions and enforce business rules
// Returns boolean - true if any pending, in_progress, paused, or failed ingestion exists
export const hasActiveIngestion = async (
  txn: TxnOrClient,
  userId: number,
  connectorId: number
): Promise<boolean> => {
  const result = await txn
    .select({ count: sql<number>`count(*)` })
    .from(ingestions)
    .where(
      and(
        eq(ingestions.userId, userId),
        eq(ingestions.connectorId, connectorId),
        sql`status IN ('pending', 'in_progress', 'paused', 'failed')`
      )
    )
    
  return Number(result[0].count) > 0
}