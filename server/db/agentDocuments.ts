import { db } from "./client"
import {
  agentDocuments,
  type InsertAgentDocument,
  type SelectAgentDocument,
  type AgentCitationReference,
  chats,
} from "@/db/schema"
import { createId } from "@paralleldrive/cuid2"
import { and, eq, isNull, desc } from "drizzle-orm"
import { getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"

const loggerWithChild = getLoggerWithChild(Subsystem.Db)

// Helper function to convert numeric DB column to number
type NumericColumn = string | null
const numericToNumber = (val: NumericColumn): number | undefined => {
  if (val === null || val === undefined) return undefined
  const num = Number(val)
  return isNaN(num) ? undefined : num
}

// Helper function to convert citations from DB
const parseCitations = (val: unknown): AgentCitationReference[] => {
  if (!val) return []
  if (Array.isArray(val)) return val as AgentCitationReference[]
  return []
}

/**
 * Insert a new agent document
 */
export const insertAgentDocument = async (
  documentData: Omit<InsertAgentDocument, "externalId">,
): Promise<SelectAgentDocument> => {
  const externalId = createId()

  // Convert confidence to string for numeric column
  const confidenceValue = documentData.confidence !== undefined && documentData.confidence !== null
    ? documentData.confidence.toString() 
    : undefined

  const result = await db
    .insert(agentDocuments)
    .values({
      ...documentData,
      externalId,
      confidence: confidenceValue,
    })
    .returning()

  if (!result[0]) {
    throw new Error("Failed to insert agent document")
  }

  loggerWithChild().info(
    { externalId, chatId: documentData.chatId, agentId: documentData.agentId },
    "Agent document inserted successfully",
  )

  return {
    ...result[0],
    citations: parseCitations(result[0].citations),
    confidence: numericToNumber(result[0].confidence as NumericColumn),
  }
}

/**
 * Get agent document by external ID
 */
export const getAgentDocumentByExternalId = async (
  externalId: string,
): Promise<SelectAgentDocument | undefined> => {
  const result = await db
    .select()
    .from(agentDocuments)
    .where(
      and(eq(agentDocuments.externalId, externalId), isNull(agentDocuments.deletedAt)),
    )
    .limit(1)

  if (!result[0]) {
    return undefined
  }

  return {
    ...result[0],
    citations: parseCitations(result[0].citations),
    confidence: numericToNumber(result[0].confidence as NumericColumn),
  }
}

/**
 * Get agent documents by chat ID
 */
export const getAgentDocumentsByChatId = async (
  chatId: number,
): Promise<SelectAgentDocument[]> => {
  const result = await db
    .select()
    .from(agentDocuments)
    .where(
      and(eq(agentDocuments.chatId, chatId), isNull(agentDocuments.deletedAt)),
    )
    .orderBy(desc(agentDocuments.createdAt))

  return result.map(doc => ({
    ...doc,
    citations: parseCitations(doc.citations),
    confidence: numericToNumber(doc.confidence as NumericColumn),
  }))
}

/**
 * Get agent documents by chat external ID
 */
export const getAgentDocumentsByChatExternalId = async (
  chatExternalId: string,
): Promise<SelectAgentDocument[]> => {

  const chat = await db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.externalId, chatExternalId), isNull(chats.deletedAt)))
    .limit(1)

  if (!chat[0]) {
    return []
  }

  return getAgentDocumentsByChatId(chat[0].id)
}

/**
 * Get agent document content by external ID
 * Returns just the fields needed for displaying the document along with permission check fields
 */
export const getAgentDocumentContent = async (
  externalId: string,
): Promise<
  | {
      externalId: string
      agentName: string
      content: string
      summary: string | null
      reasoning: string | null
      citations: AgentCitationReference[]
      confidence: number | null
      createdAt: Date
      chatId: number
      workspaceExternalId: string
    }
  | undefined
> => {
  const result = await db
    .select({
      externalId: agentDocuments.externalId,
      agentName: agentDocuments.agentName,
      content: agentDocuments.content,
      summary: agentDocuments.summary,
      reasoning: agentDocuments.reasoning,
      citations: agentDocuments.citations,
      confidence: agentDocuments.confidence,
      createdAt: agentDocuments.createdAt,
      chatId: agentDocuments.chatId,
      workspaceExternalId: chats.workspaceExternalId,
    })
    .from(agentDocuments)
    .innerJoin(chats, eq(agentDocuments.chatId, chats.id))
    .where(
      and(eq(agentDocuments.externalId, externalId), isNull(agentDocuments.deletedAt)),
    )
    .limit(1)

  if (!result[0]) {
    return undefined
  }

  return {
    ...result[0],
    citations: parseCitations(result[0].citations),
    confidence: numericToNumber(result[0].confidence as NumericColumn) ?? null,
  }
}

/**
 * Update agent document with additional metadata
 * Used to add reasoning, citations, etc. after initial creation
 */
export const updateAgentDocument = async (
  externalId: string,
  updates: Partial<InsertAgentDocument>,
): Promise<SelectAgentDocument | undefined> => {
  // Convert confidence to string for numeric column if present
  const updateData: any = { ...updates }
  if (updates.confidence !== undefined && updates.confidence !== null) {
    updateData.confidence = updates.confidence.toString()
  }

  const result = await db
    .update(agentDocuments)
    .set(updateData)
    .where(
      and(eq(agentDocuments.externalId, externalId), isNull(agentDocuments.deletedAt)),
    )
    .returning()

  if (!result[0]) {
    return undefined
  }

  return {
    ...result[0],
    citations: parseCitations(result[0].citations),
    confidence: numericToNumber(result[0].confidence as NumericColumn),
  }
}

/**
 * Soft delete agent document
 */
export const deleteAgentDocument = async (
  externalId: string,
): Promise<boolean> => {
  const result = await db
    .update(agentDocuments)
    .set({ deletedAt: new Date() })
    .where(
      and(eq(agentDocuments.externalId, externalId), isNull(agentDocuments.deletedAt)),
    )
    .returning()

  return result.length > 0
}
