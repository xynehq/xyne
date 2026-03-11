/**
 * Episodic memory extractor: distills long-term memories from conversation turns via LLM.
 * Receives only the archived messages from the compaction batch — never the full history.
 * Feeds new memories to Vespa episodic_memory schema.
 */

import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { getProviderByModel } from "@/ai/provider"
import { insertWithRetry, searchEpisodicMemory } from "@/search/vespa"
import {
  episodicMemorySchema,
  Apps,
  EpisodicMemoryEntity,
  type VespaEpisodicMemory,
  type VespaEpisodicMemorySearch,
} from "@xyne/vespa-ts/types"
import { createId } from "@paralleldrive/cuid2"
import type { EpisodicMemoryMessage } from "@/queue/episodic-memory-extraction"
import { Models } from "@/ai/types"

const Logger = getLogger(Subsystem.AI).child({
  module: "episodic-memory-extractor",
})

const MEMORY_TYPES = [
  "preference",
  "decision",
  "solution",
  "project_context",
  "workflow",
] as const

const MIN_MEMORY_LENGTH = 10
const MAX_MEMORY_LENGTH = 300
/** Cap conversation length so the model gets recent context and has room to output JSON. */
const MAX_CONVERSATION_CHARS = 14_000
const DUPLICATE_MEMORY_SEARCH_LIMIT = 3
/** Treat as duplicate if vector_score or combined_bm25 from matchfeatures is at least this (close to 1). */
const DUPLICATE_SIMILARITY_THRESHOLD = 0.9

const EXTRACTION_PROMPT = `Extract important long-term memories from this conversation.
Only include:
- user preferences
- successful solutions
- decisions made
- project context
- workflow patterns
Ignore:
- temporary conversation
- greetings
- short explanations
- raw data/numbers
Output a JSON array only, no markdown or explanation. Each item: { "memory": "...", "type": "preference|decision|solution|project_context|workflow" }
If nothing worth remembering, output: []`

/** Parse LLM response into episodic memory items: array, or object with .memories/.items, or single { memory, type }. */
function parseEpisodicMemoriesResponse(raw: string | undefined): Array<{ memory: string; type: string }> {
  const s = (raw ?? "").trim()
  if (!s) return []
  let jsonStr = s
  const codeBlock = /^```(?:json)?\s*([\s\S]*?)\s*```$/m
  const m = s.match(codeBlock)
  if (m) jsonStr = m[1].trim()
  try {
    const parsed = JSON.parse(jsonStr)
    if (Array.isArray(parsed)) {
      return (parsed as Array<{ memory?: string; type?: string }>).map((x) => ({
        memory: (x.memory ?? "").trim(),
        type: x.type ?? "workflow",
      }))
    }
    if (parsed && typeof parsed === "object") {
      const arr = (parsed as { memories?: unknown[] }).memories ?? (parsed as { items?: unknown[] }).items
      if (Array.isArray(arr)) {
        return (arr as Array<{ memory?: string; type?: string }>).map((x) => ({
          memory: (x.memory ?? "").trim(),
          type: x.type ?? "workflow",
        }))
      }
      if ("memory" in (parsed as object)) {
        const one = parsed as { memory?: string; type?: string }
        return [{ memory: (one.memory ?? "").trim(), type: one.type ?? "workflow" }]
      }
    }
  } catch {
    // fall through to return []
  }
  return []
}

function buildConversationText(messages: EpisodicMemoryMessage[]): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const content = m.content.trim()
      const thinking = m.thinking?.trim()
      if (m.role === "assistant" && thinking && thinking.length > 0) {
        return `assistant (thinking): ${thinking}\nassistant: ${content}`
      }
      return `${m.role}: ${content}`
    })
    .join("\n\n")
}

async function isDuplicateMemory(params: {
  candidate: string
  email: string
  workspaceId: string
}): Promise<boolean> {
  try {
    const response = await searchEpisodicMemory(
      params.candidate,
      params.email,
      params.workspaceId,
      undefined,
      DUPLICATE_MEMORY_SEARCH_LIMIT,
      0,
      0.5,
      config.defaultRecencyDecayRate ?? 0.1,
    )
    const children = response.root?.children ?? []
    for (const c of children) {
      const f = (c.fields ?? {}) as VespaEpisodicMemorySearch & {
        matchfeatures?: { vector_score?: number; combined_bm25?: number }
      }
      const mf = f.matchfeatures
      if (!mf) continue
      const vectorScore = typeof mf.vector_score === "number" ? mf.vector_score : 0
      const combinedBm25 =
        typeof mf.combined_bm25 === "number" ? mf.combined_bm25 : 0
      if (
        vectorScore >= DUPLICATE_SIMILARITY_THRESHOLD ||
        combinedBm25 >= DUPLICATE_SIMILARITY_THRESHOLD
      ) {
        return true
      }
    }
  } catch (err) {
    Logger.warn(
      { err },
      "Episodic extraction: duplicate check failed, proceeding without dedupe",
    )
  }
  return false
}

export type EpisodicExtractionResult = {
  extracted: number
  indexed: number
  skippedReason?: "messages_too_few" | "conversation_too_short" | "invalid_json"
}

/**
 * Extract episodic memories from the given messages and feed them to Vespa.
 * Only receives the archived compaction batch — not the full chat history.
 */
export async function extractEpisodicMemories(params: {
  chatId: string
  email: string
  workspaceId: string
  messagesToProcess: EpisodicMemoryMessage[]
}): Promise<EpisodicExtractionResult> {
  const { chatId, email, workspaceId, messagesToProcess } = params

  if (messagesToProcess.length < 2) {
    return { extracted: 0, indexed: 0, skippedReason: "messages_too_few" }
  }

  let conversationText = buildConversationText(messagesToProcess)
  if (conversationText.length < 100) {
    return { extracted: 0, indexed: 0, skippedReason: "conversation_too_short" }
  }
  if (conversationText.length > MAX_CONVERSATION_CHARS) {
    conversationText = conversationText.slice(-MAX_CONVERSATION_CHARS)
    Logger.debug(
      { chatId, originalLength: buildConversationText(messagesToProcess).length, truncatedTo: MAX_CONVERSATION_CHARS },
      "Episodic extraction: truncated conversation to fit context",
    )
  }

  const prompt = `${EXTRACTION_PROMPT}\n\nConversation:\n${conversationText}`

  try {
    const { text: rawResponse } = await getProviderByModel(
      Models.GLM_LATEST,
    ).converse(
      [{ role: "user", content: [{ text: prompt }] }],
      {
        modelId: Models.GLM_LATEST,
        max_new_tokens: 1024,
        temperature: 0.2,
        stream: false,
        json: true,
      },
    )

    const items = parseEpisodicMemoriesResponse(rawResponse)
    if (items.length === 0) {
      try {
        JSON.parse((rawResponse ?? "").trim())
      } catch {
        Logger.warn(
          {
            chatId,
            rawLength: rawResponse?.length ?? 0,
            rawPreview: rawResponse?.slice(0, 200),
          },
          "Episodic extraction: invalid JSON from model",
        )
        return { extracted: 0, indexed: 0, skippedReason: "invalid_json" }
      }
    }

    if (items.length === 0) {
      Logger.info(
        {
          chatId,
          conversationLength: conversationText.length,
          rawLength: rawResponse?.length ?? 0,
          rawPreview: rawResponse?.slice(0, 500),
        },
        "Episodic extraction: model returned no memories; logging raw response for debugging",
      )
    }

    const now = Date.now()
    let indexedCount = 0

    for (const item of items) {
      const memory = typeof item.memory === "string" ? item.memory.trim() : ""
      const memoryType = MEMORY_TYPES.includes(
        item.type as (typeof MEMORY_TYPES)[number],
      )
        ? item.type
        : "workflow"

      if (!memory || memory.length < MIN_MEMORY_LENGTH) continue
      if (memory.length > MAX_MEMORY_LENGTH) {
        Logger.debug(
          { chatId, len: memory.length },
          "Skipping episodic memory longer than cap",
        )
        continue
      }

      // Skip if an identical memory already exists for this user/workspace
      // to avoid duplicates from overlapping batches.
      // Best-effort: failure just means we might insert a duplicate.
      // eslint-disable-next-line no-await-in-loop
      const duplicate = await isDuplicateMemory({
        candidate: memory,
        email,
        workspaceId,
      })
      if (duplicate) {
        Logger.debug(
          { chatId, memoryType, len: memory.length },
          "Skipping duplicate episodic memory",
        )
        continue
      }

      let importanceScore = 1.0
      switch (memoryType) {
        case "decision":
          importanceScore = 1.5
          break
        case "solution":
          importanceScore = 1.4
          break
        case "preference":
          importanceScore = 1.2
          break
        case "project_context":
          importanceScore = 1.1
          break
        case "workflow":
        default:
          importanceScore = 1.0
          break
      }

      const docId = createId()
      const document: VespaEpisodicMemory = {
        docId,
        workspaceId,
        email,
        memoryText: memory,
        memoryType,
        sourceChatId: chatId,
        permissions: [email],
        app: Apps.ChatMemory,
        entity: EpisodicMemoryEntity.Memory,
        importanceScore,
        lastUsedAt: now,
        createdAt: now,
        updatedAt: now,
      }
      await insertWithRetry(document, episodicMemorySchema)
      indexedCount += 1
      Logger.debug(
        {
          chatId,
          docId: document.docId,
          memoryType: document.memoryType,
          len: document.memoryText.length,
        },
        "Indexed episodic memory",
      )
    }

    Logger.info(
      {
        chatId,
        extracted: items.length,
        indexed: indexedCount,
        inputMessages: messagesToProcess.length,
      },
      "Episodic memory extraction done",
    )
    return { extracted: items.length, indexed: indexedCount }
  } catch (err) {
    Logger.error(err, "Episodic memory extraction failed")
    throw err
  }
}
