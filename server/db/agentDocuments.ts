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

// Helper function to convert citations from DB
const isAgentCitationReference = (
  value: unknown,
): value is AgentCitationReference => {
  if (!value || typeof value !== "object") return false
  const citation = value as Record<string, unknown>
  return (
    typeof citation.docId === "string" &&
    typeof citation.title === "string" &&
    typeof citation.app === "string" &&
    typeof citation.entity === "string" &&
    (citation.url === undefined || typeof citation.url === "string") &&
    (citation.chunkContent === undefined || typeof citation.chunkContent === "string")
  )
}

const parseCitations = (val: unknown): AgentCitationReference[] => {
  if (!Array.isArray(val)) return []
  return val.filter(isAgentCitationReference)
}

const mapRow = (row: typeof agentDocuments.$inferSelect): SelectAgentDocument => ({
  ...row,
  citations: parseCitations(row.citations),
})

/**
 * Insert a new agent document
 */
export const insertAgentDocument = async (
  documentData: Omit<InsertAgentDocument, "externalId">,
): Promise<SelectAgentDocument> => {
  const externalId = createId()

  const result = await db
    .insert(agentDocuments)
    .values({
      ...documentData,
      externalId,
    })
    .returning()

  if (!result[0]) {
    throw new Error("Failed to insert agent document")
  }

  loggerWithChild().info(
    { externalId, chatId: documentData.chatId, agentId: documentData.agentId },
    "Agent document inserted successfully",
  )

  return mapRow(result[0])
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

  return mapRow(result[0])
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

  return result.map(mapRow)
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
      reasoning: string | null
      citations: AgentCitationReference[]
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
      reasoning: agentDocuments.reasoning,
      citations: agentDocuments.citations,
      createdAt: agentDocuments.createdAt,
      chatId: agentDocuments.chatId,
      workspaceExternalId: chats.workspaceExternalId,
    })
    .from(agentDocuments)
    .innerJoin(chats, eq(agentDocuments.chatId, chats.id))
    .where(
      and(
        eq(agentDocuments.externalId, externalId),
        isNull(agentDocuments.deletedAt),
        isNull(chats.deletedAt),
      ),
    )
    .limit(1)

  if (!result[0]) {
    return undefined
  }

  return {
    ...result[0],
    citations: parseCitations(result[0].citations),
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
  const result = await db
    .update(agentDocuments)
    .set(updates)
    .where(
      and(eq(agentDocuments.externalId, externalId), isNull(agentDocuments.deletedAt)),
    )
    .returning()

  if (!result[0]) {
    return undefined
  }

  return mapRow(result[0])
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
