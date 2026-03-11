/**
 * Chat memory retriever: fetches relevant past conversation turns from Vespa.
 * Used for automatic injection and for the searchChatHistory tool.
 */

import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { MEMORY_CONFIG } from "@/config"
import { searchChatMemory } from "@/search/vespa"
import type { VespaChatMemorySearch } from "@xyne/vespa-ts"

const Logger = getLogger(Subsystem.Vespa).child({
  module: "chat-memory-retriever",
})

export interface ChatMemoryFragment {
  turnNumber: number
  userMessage: string
  assistantMessage: string
  assistantThinking: string
  text: string
  docId: string
  relevance?: number
}

/**
 * Retrieve relevant conversation turns from Vespa (hybrid + recency).
 * Searches only within the given chatId; if chatId is missing, returns [].
 */
export async function retrieveRelevantChatHistory(params: {
  query: string
  chatId: string
  email: string
  workspaceId: string
  limit?: number
}): Promise<ChatMemoryFragment[]> {
  const {
    query,
    chatId,
    email,
    workspaceId,
    limit = MEMORY_CONFIG.MAX_CHAT_MEMORY_CHUNKS,
  } = params

  try {
    const response = await searchChatMemory(
      query,
      email,
      chatId,
      workspaceId,
      limit,
      0,
      0.5,
      config.defaultRecencyDecayRate ?? 0.1,
    )
    const children = response.root?.children ?? []
    return children.map((c) => {
      const f = c.fields as VespaChatMemorySearch
      return {
        turnNumber: (f.turnNumber as number) ?? 0,
        userMessage: (f.userMessage as string) ?? "",
        assistantMessage: (f.assistantMessage as string) ?? "",
        assistantThinking: (f.thinking as string) ?? "",
        text: (f.text as string) ?? "",
        docId: (f.docId as string) ?? "",
        relevance: f.relevance as number | undefined,
      }
    })
  } catch (err) {
    Logger.error(err, "Chat memory retrieval error")
    return []
  }
}
