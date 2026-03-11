/**
 * Chat memory indexer: persists conversation turns to Vespa for later retrieval.
 * Each doc = one turn (user + assistant pair).
 * DocId uses the Postgres message PK so it is globally unique across compactions.
 *
 * Episodic memory extraction is triggered here during compaction — only for the
 * messages being archived, never for the full history.
 */

import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { insertWithRetry } from "@/search/vespa"
import {
  chatMemorySchema,
  Apps,
  ChatMemoryEntity,
  type VespaChatMemory,
} from "@xyne/vespa-ts/types"
import { MEMORY_CONFIG } from "@/config"
import { insertMessage } from "@/db/message"
import type { SelectMessage } from "@/db/schema"
import type { TxnOrClient } from "@/types"
import { MessageRole } from "@/types"
import { textToChunkCitationIndex, textToCitationIndex, textToImageCitationIndex } from "@/api/chat/utils"
import { parseMessageText } from "@/api/chat/chat"
import { queueEpisodicMemoryExtraction } from "@/queue/episodic-memory-extraction"
import { queueChatMemoryIndexing } from "@/queue/chat-memory-indexing"

const Logger = getLogger(Subsystem.Vespa).child({ module: "chat-memory-indexer" })

const NOISE_USER_PATTERN = /^(ok|thanks|got it|yes|no|hmm|sure|hello|hi|hey)\.?$/i

function stripRagCitations(text: string): string {
  return text
    .replace(textToCitationIndex, "")
    .replace(textToImageCitationIndex, "")
    .replace(textToChunkCitationIndex, "")
    .replace(/\s+/g, " ")
    .trim()
}

function isNoiseUserMessage(msg: string): boolean {
  const t = msg.trim()
  return t.length < 10 || NOISE_USER_PATTERN.test(t)
}

/**
 * Index a single conversation turn to Vespa.
 * DocId uses the Postgres message PKs so IDs are globally unique across compactions.
 * Fire-and-forget safe; errors are logged.
 */
export async function indexConversationTurn(params: {
  chatId: string
  workspaceId: string
  email: string
  userMessageId: number
  assistantMessageId: number
  userMessage: string
  assistantMessage: string
  /** Assistant reasoning/thinking included in text for embedding. */
  assistantThinking?: string
  toolsUsed?: string[]
}): Promise<void> {
  const {
    chatId,
    workspaceId,
    email,
    userMessageId,
    assistantMessageId,
    userMessage,
    assistantMessage,
    assistantThinking,
    toolsUsed = [],
  } = params

  if (isNoiseUserMessage(userMessage)) {
    Logger.debug(
      { chatId, userMessageId, userMessageLen: userMessage.length },
      "Skipping noise user message for chat memory indexing",
    )
    return
  }

  const cleanedUser = parseMessageText(userMessage)
  const cleanedAssistant = stripRagCitations(assistantMessage)
  const cleanedThinking =
    assistantThinking?.trim() && stripRagCitations(assistantThinking.trim())
  const text =
    cleanedThinking && cleanedThinking.length > 0
      ? `User: ${cleanedUser}\nAssistant thinking: ${cleanedThinking}\nAssistant: ${cleanedAssistant}`
      : `User: ${cleanedUser}\nAssistant: ${cleanedAssistant}`
  const now = Date.now()
  // Stable, globally-unique docId using both message PKs
  const docId = `${chatId}:u${userMessageId}:a${assistantMessageId}`

  const document: VespaChatMemory = {
    docId,
    chatId,
    workspaceId,
    email,
    turnNumber: userMessageId,
    userMessage: cleanedUser,
    assistantMessage: cleanedAssistant,
    thinking: cleanedThinking,
    text,
    topics: [],
    toolsUsed,
    permissions: [email],
    app: Apps.ChatMemory,
    entity: ChatMemoryEntity.ConversationTurn,
    createdAt: now,
    updatedAt: now,
  }

  await insertWithRetry(document, chatMemorySchema)
  Logger.debug(
    { chatId, docId },
    "Indexed conversation turn to chat_memory",
  )
}

/**
 * Pair consecutive user+assistant messages into turns.
 * Skips orphaned messages (e.g. consecutive users or assistants without a pair).
 */
function pairMessagesIntoTurns(
  messages: SelectMessage[],
): Array<{ user: SelectMessage; assistant: SelectMessage }> {
  const turns: Array<{ user: SelectMessage; assistant: SelectMessage }> = []
  for (let i = 0; i < messages.length - 1; i++) {
    const a = messages[i]
    const b = messages[i + 1]
    if (
      a.messageRole === MessageRole.User &&
      b.messageRole === MessageRole.Assistant
    ) {
      turns.push({ user: a, assistant: b })
      i++ // skip b — it was consumed as the assistant half
    }
  }
  return turns
}

/**
 * If the conversation exceeds the working memory window:
 *   1. Identify messages to archive (everything outside the window).
 *   2. Index archived turns to Vespa chat_memory (fire-and-forget).
 *   3. Queue episodic memory extraction for ONLY the archived messages.
 *   4. Insert a compaction boundary marker (isSummary=true).
 *   5. Return only the last N messages (working window).
 *
 * If within the window, returns all messages unchanged.
 */
export async function maybeCompactAndIndex(params: {
  trx: TxnOrClient
  chatId: string
  email: string
  workspaceId: string
  allMessages: SelectMessage[]
  chatIdInternal: number
  userId: number
  workspaceExternalId: string
  modelId: string
}): Promise<SelectMessage[]> {
  const {
    trx,
    chatId,
    email,
    workspaceId,
    allMessages,
    chatIdInternal,
    userId,
    workspaceExternalId,
    modelId,
  } = params

  const N = MEMORY_CONFIG.WORKING_MEMORY_MESSAGES
  if (allMessages.length <= N) {
    return allMessages
  }

  const toArchive = allMessages.slice(0, -N)
  const workingWindow = allMessages.slice(-N)

  // 1. Queue chat memory indexing for each archived turn
  const turns = pairMessagesIntoTurns(toArchive)
  for (const { user, assistant } of turns) {
    queueChatMemoryIndexing({
      chatId,
      workspaceId,
      email,
      userMessageId: user.id as number,
      assistantMessageId: assistant.id as number,
      userMessage: user.message ?? "",
      assistantMessage: assistant.message ?? "",
      assistantThinking: assistant.thinking ?? undefined,
    }).catch((err) =>
      Logger.error(err, "Failed to queue chat memory indexing"),
    )
  }

  // 2. Queue episodic memory extraction for the archived messages only (include thinking for assistants)
  const messagesToProcess = toArchive
    .filter(
      (m) =>
        m.messageRole === MessageRole.User ||
        m.messageRole === MessageRole.Assistant,
    )
    .map((m) => ({
      role: m.messageRole,
      content: m.message ?? "",
      ...(m.messageRole === MessageRole.Assistant && (m.thinking ?? "").trim()
        ? { thinking: m.thinking ?? "" }
        : {}),
    }))

  if (messagesToProcess.length >= 2) {
    queueEpisodicMemoryExtraction({
      chatId,
      email,
      workspaceId,
      messagesToProcess,
    }).catch((err) =>
      Logger.error(err, "Failed to queue episodic memory extraction"),
    )
  }

  // 3. Insert compaction boundary marker just before the working window
  const lastArchived = toArchive[toArchive.length - 1]
  const boundaryCreatedAt = lastArchived?.createdAt ?? new Date(0)
  await insertMessage(trx, {
    chatId: chatIdInternal,
    userId,
    workspaceExternalId,
    chatExternalId: chatId,
    messageRole: MessageRole.User,
    email,
    sources: [],
    message:
      "[Compaction boundary - older messages available via chat memory retrieval]",
    modelId,
    fileIds: [],
    isSummary: true,
    createdAt: boundaryCreatedAt,
    updatedAt: boundaryCreatedAt,
  })

  Logger.info(
    {
      chatId,
      archivedCount: toArchive.length,
      workingWindowSize: workingWindow.length,
      turnsIndexed: turns.length,
      episodicMessagesQueued: messagesToProcess.length,
    },
    "Compaction complete",
  )

  return workingWindow
}
