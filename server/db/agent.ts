import {
  agents,
  insertAgentSchema,
  selectAgentSchema,
  selectPublicAgentSchema,
  type InsertAgent,
  type SelectAgent,
  type SelectPublicAgent,
} from "@/db/schema"
export type { SelectAgent } // Re-export SelectAgent
import { createId } from "@paralleldrive/cuid2"
import type { TxnOrClient } from "@/types"
import { z } from "zod"
import { and, desc, eq, isNull } from "drizzle-orm"

export const insertAgent = async (
  trx: TxnOrClient,
  agentData: Omit<InsertAgent, "externalId" | "userId" | "workspaceId">,
  userId: number,
  workspaceId: number,
): Promise<SelectAgent> => {
  const externalId = createId()
  const agentWithIds = {
    ...agentData,
    externalId,
    userId,
    workspaceId,
  }
  const validatedAgentData = insertAgentSchema.parse(agentWithIds)
  const agentArr = await trx
    .insert(agents)
    .values(validatedAgentData)
    .returning()
  if (!agentArr || !agentArr.length) {
    throw new Error('Error in insert of agent "returning"')
  }
  return selectAgentSchema.parse(agentArr[0])
}

export const getAgentByExternalId = async (
  trx: TxnOrClient,
  agentExternalId: string,
  workspaceId: number,
): Promise<SelectAgent | null> => {
  const agentArr = await trx
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.externalId, agentExternalId),
        isNull(agents.deletedAt),
      ),
    )
  if (!agentArr || !agentArr.length) {
    return null
  }
  return selectAgentSchema.parse(agentArr[0])
}

export const getAgentsByUserId = async (
  trx: TxnOrClient,
  userId: number,
  workspaceId: number,
  limit: number = 50,
  offset: number = 0,
): Promise<SelectPublicAgent[]> => {
  const agentsArr = await trx
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.userId, userId),
        eq(agents.workspaceId, workspaceId),
        isNull(agents.deletedAt),
      ),
    )
    .orderBy(desc(agents.updatedAt))
    .limit(limit)
    .offset(offset)
  return z.array(selectPublicAgentSchema).parse(agentsArr)
}

// to list all the agent which are there is respective of who has created it
export const getAllAgents = async (
  trx: TxnOrClient,
  // userId: number,
  // workspaceId: number,
  limit: number = 50,
  offset: number = 0,
): Promise<SelectPublicAgent[]> => {
  const agentsArr = await trx
    .select()
    .from(agents)
    .where(
      and(
        isNull(agents.deletedAt),
      ),
    )
    .orderBy(desc(agents.updatedAt))
    .limit(limit)
    .offset(offset)
  return z.array(selectPublicAgentSchema).parse(agentsArr)
}

export const updateAgentByExternalId = async (
  trx: TxnOrClient,
  agentExternalId: string,
  workspaceId: number,
  agentData: Partial<
    Omit<InsertAgent, "externalId" | "userId" | "workspaceId">
  >,
): Promise<SelectAgent | null> => {
  const updateData = { ...agentData, updatedAt: new Date() }
  // Validate partial update data - Drizzle Zod doesn't directly support partial insert schemas for updates
  // We can manually pick keys or ensure the input is structured correctly.
  // For simplicity, we assume agentData contains valid updatable fields.

  const agentArr = await trx
    .update(agents)
    .set(updateData)
    .where(
      and(
        eq(agents.externalId, agentExternalId),
        eq(agents.workspaceId, workspaceId),
        isNull(agents.deletedAt),
      ),
    )
    .returning()

  if (!agentArr || !agentArr.length) {
    return null
  }
  return selectAgentSchema.parse(agentArr[0])
}

export const deleteAgentByExternalId = async (
  trx: TxnOrClient,
  agentExternalId: string,
  workspaceId: number,
): Promise<SelectAgent | null> => {
  const agentArr = await trx
    .update(agents)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(agents.externalId, agentExternalId),
        eq(agents.workspaceId, workspaceId),
        isNull(agents.deletedAt), // Ensure we only "delete" it once
      ),
    )
    .returning()
  if (!agentArr || !agentArr.length) {
    return null
  }
  return selectAgentSchema.parse(agentArr[0])
}
