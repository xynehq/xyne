/**
 * Episodic memory retriever: fetches relevant long-term memories from Vespa.
 * Injected into the system prompt at request start (not an agent tool).
 * Optionally reinforces retrieved memories (importanceScore += 0.1, lastUsedAt = now).
 */

import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { MEMORY_CONFIG } from "@/config"
import { searchEpisodicMemory, UpdateDocument } from "@/search/vespa"
import { episodicMemorySchema, type VespaEpisodicMemorySearch } from "@xyne/vespa-ts/types"

const Logger = getLogger(Subsystem.Vespa).child({
  module: "episodic-memory-retriever",
})

export interface EpisodicMemory {
  docId: string
  memoryText: string
  memoryType: string
  importanceScore: number
  /** Chat where this memory originated; use this chatId with searchChatHistory to find related turns. */
  sourceChatId: string
}

/**
 * Retrieve relevant episodic memories for the user/workspace.
 * If chatIds is provided, search only within those chats; otherwise search globally.
 * After retrieval, optionally updates importanceScore and lastUsedAt (reinforcement).
 */
export async function retrieveEpisodicMemories(params: {
  query: string
  email: string
  workspaceId: string
  chatIds?: string[] | null
  limit?: number
}): Promise<EpisodicMemory[]> {
  const {
    query,
    email,
    workspaceId,
    chatIds,
    limit = MEMORY_CONFIG.MAX_EPISODIC_MEMORIES,
  } = params

  try {
    const response = await searchEpisodicMemory(
      query,
      email,
      workspaceId,
      chatIds ?? undefined,
      limit,
      0,
      0.5,
      config.defaultRecencyDecayRate ?? 0.1,
    )
    const children = response.root?.children ?? []
    const memories: EpisodicMemory[] = children.map((c) => {
      const f = c.fields as VespaEpisodicMemorySearch
      return {
        docId: (f.docId as string) ?? "",
        memoryText: (f.memoryText as string) ?? "",
        memoryType: (f.memoryType as string) ?? "workflow",
        importanceScore: (f.importanceScore as number) ?? 1,
        sourceChatId: (f.sourceChatId as string) ?? "",
      }
    })
    // Reinforcement: update importanceScore and lastUsedAt (fire-and-forget)
    const now = Date.now()
    for (const m of memories) {
      UpdateDocument(episodicMemorySchema, m.docId, {
        importanceScore: m.importanceScore + 0.1,
        lastUsedAt: now,
        updatedAt: now,
      }).catch((err) =>
        Logger.warn(
          { docId: m.docId, err },
          "Failed to reinforce episodic memory",
        ),
      )
    }
    return memories
  } catch (err) {
    Logger.error(err, "Episodic memory retrieval error")
    return []
  }
}
