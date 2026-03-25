/**
 * Helper Functions for Xyne Pi-Mono
 *
 * Utility functions for chat bootstrap, message persistence,
 * attachment handling, and conversation history management.
 */

import type { Message } from "@aws-sdk/client-bedrock-runtime"
import { ConversationRole } from "@aws-sdk/client-bedrock-runtime"
import {
  SearchModes,
  type VespaSearchResult,
  type VespaSearchResults,
} from "@xyne/vespa-ts/types"

import config from "@/config"
import { db } from "@/db/client"
import { getChatMessagesWithAuth, insertMessage } from "@/db/message"
import {
  ChatType,
  type InsertChat,
  type InsertMessage,
  type SelectMessage,
} from "@/db/schema"
import { getLogger } from "@/logger"
import { Subsystem, type UserMetadataType } from "@/types"
import { getErrorMessage } from "@/utils"
import { MessageRole } from "@/types"
import { insertChat, updateChatByExternalIdWithAuth } from "@/db/chat"
import { storeAttachmentMetadata } from "@/db/attachment"
import {
  searchVespaInFiles,
  searchCollectionRAG,
  SearchEmailThreads,
} from "@/search/vespa"
import { getChunkCountPerDoc } from "@/api/chat/chunk-selection"
import { processThreadResults } from "@/api/chat/utils"
import { getUserPersonalizationByEmail } from "@/db/personalization"
import { answerContextMap } from "@/ai/context"
import { parseMessageText } from "@/api/chat/chat"
import { getPrecomputedDbContextIfNeeded } from "@/lib/databaseContext"
import { getTracer } from "@/tracer"
import { searchToCitation, processMessage } from "@/api/chat/utils"
import type { MinimalAgentFragment } from "@/api/chat/types"

import type {
  ChatBootstrapParams,
  ChatBootstrapResult,
  PersistAssistantMessageContext,
  PersistAssistantMessageData,
} from "./types"

const Logger = getLogger(Subsystem.Chat)
const { defaultBestModel, defaultBestModelAgenticMode } = config

// Re-export for convenience
export const helpersConfig = { defaultBestModel, defaultBestModelAgenticMode }

/**
 * Ensure chat exists and persist user message
 */
export async function ensureChatAndPersistUserMessage(
  params: ChatBootstrapParams,
): Promise<ChatBootstrapResult> {
  const { maybeCompactAndIndex } = await import("@/services/chatMemoryIndexer")

  const workspaceId = Number(params.workspace.id)
  const workspaceExternalId = String(params.workspace.externalId)
  const userId = Number(params.user.id)
  const userEmail = String(params.user.email)
  const incomingChatId = params.chatId ? String(params.chatId) : undefined
  let attachmentError: Error | null = null

  return await db.transaction(async (tx) => {
    if (!incomingChatId) {
      const chatInsert = {
        workspaceId,
        workspaceExternalId,
        userId,
        email: userEmail,
        title: "Untitled",
        attachments: [],
        agentId: params.agentId ?? undefined,
        chatType: ChatType.Default,
      } as unknown as Omit<InsertChat, "externalId">
      const chat = await insertChat(tx, chatInsert)

      const messageInsert = {
        chatId: chat.id,
        userId,
        workspaceExternalId,
        chatExternalId: chat.externalId,
        messageRole: MessageRole.User,
        email: userEmail,
        sources: [],
        message: params.message,
        modelId: (params.modelId as string) || defaultBestModel,
        fileIds: params.fileIds,
      } as unknown as Omit<InsertMessage, "externalId">
      const userMessage = await insertMessage(tx, messageInsert)

      if (params.attachmentMetadata.length > 0) {
        const storageErr = await storeAttachmentSafely(
          tx,
          userEmail,
          String(userMessage.externalId),
          params.attachmentMetadata,
        )
        if (storageErr) {
          attachmentError = storageErr
        }
      }

      return {
        chat,
        userMessage,
        conversationHistory: [],
        attachmentError: attachmentError ?? undefined,
      }
    }

    const chat = await updateChatByExternalIdWithAuth(
      tx,
      String(incomingChatId),
      String(params.email),
      {},
    )
    const allMessages = await getChatMessagesWithAuth(
      tx,
      String(incomingChatId),
      String(params.email),
    )
    const conversationHistory = await maybeCompactAndIndex({
      trx: tx,
      chatId: String(incomingChatId),
      email: String(params.email),
      workspaceId: workspaceExternalId,
      allMessages,
      chatIdInternal: chat.id,
      userId,
      modelId: (params.modelId as string) || defaultBestModel,
    })

    const messageInsert = {
      chatId: chat.id,
      userId,
      workspaceExternalId,
      chatExternalId: chat.externalId,
      messageRole: MessageRole.User,
      email: userEmail,
      sources: [],
      message: params.message,
      modelId: (params.modelId as string) || defaultBestModel,
      fileIds: params.fileIds,
    } as unknown as Omit<InsertMessage, "externalId">
    const userMessage = await insertMessage(tx, messageInsert)

    if (params.attachmentMetadata.length > 0) {
      const storageErr = await storeAttachmentSafely(
        tx,
        userEmail,
        String(userMessage.externalId),
        params.attachmentMetadata,
      )
      if (storageErr) {
        attachmentError = storageErr
      }
    }

    return {
      chat,
      userMessage,
      conversationHistory,
      attachmentError: attachmentError ?? undefined,
    }
  })
}

/**
 * Store attachment metadata safely
 */
export async function storeAttachmentSafely(
  tx: Parameters<typeof storeAttachmentMetadata>[0],
  email: string,
  messageExternalId: string,
  attachments: any[],
): Promise<Error | null> {
  try {
    await storeAttachmentMetadata(tx, messageExternalId, attachments, email)
    return null
  } catch (error) {
    Logger.error(
      error,
      `Failed to store attachment metadata for message ${messageExternalId}`,
    )
    return error as Error
  }
}

/**
 * Resolve agentic model ID
 */
export function resolveAgenticModelId(requestedModelId?: string): string {
  const hasAgenticOverride =
    defaultBestModelAgenticMode && defaultBestModelAgenticMode !== ""
  const fallback = hasAgenticOverride
    ? defaultBestModelAgenticMode
    : defaultBestModel
  const normalized = requestedModelId || fallback
  return normalized
}

/**
 * Build conversation history for agent run
 */
export function buildConversationHistoryForAgentRun(history: SelectMessage[]): {
  messages: Message[]
} {
  const filtered = history
    .filter((msg) => !msg?.errorMessage)
    .filter(
      (msg) => !(msg.messageRole === MessageRole.Assistant && !msg.message),
    )
    .filter(
      (msg) =>
        msg.messageRole === MessageRole.User ||
        msg.messageRole === MessageRole.Assistant,
    )

  const toText = (msg: SelectMessage) => normalizeUserMessageForHistory(msg)

  return {
    messages: filtered.map((msg) => ({
      role:
        msg.messageRole === MessageRole.Assistant
          ? ConversationRole.ASSISTANT
          : ConversationRole.USER,
      content: [{ text: toText(msg) }],
    })),
  }
}

/**
 * Normalize user message for history
 */
export function normalizeUserMessageForHistory(message: SelectMessage): string {
  const fileIds = Array.isArray(message?.fileIds) ? message.fileIds : []
  if (
    message.messageRole !== MessageRole.User ||
    !fileIds.length ||
    !message.message.startsWith("[{")
  ) {
    return message.message
  }

  try {
    const parsed = JSON.parse(message.message)
    if (!Array.isArray(parsed)) {
      return message.message
    }
    return parsed
      .map((item) => {
        if (item?.type === "text") {
          return `${item?.value ?? ""} `
        }
        if (item?.type === "pill") {
          const title = item?.value?.title ?? "Unknown file"
          return `<User referred a file with title "${title}" here> `
        }
        if (item?.type === "link") {
          return "<User added a link with url here, this url's content is already available to you in the prompt> "
        }
        return ""
      })
      .join("")
      .trim()
  } catch {
    return message.message
  }
}

/**
 * Prepare initial attachment context
 */
export async function prepareInitialAttachmentContext(
  fileIds: string[],
  threadIds: string[],
  userMetadata: UserMetadataType,
  query: string,
  email: string,
  allowChunkCitations?: boolean,
): Promise<{ fragments: MinimalAgentFragment[]; summary: string } | null> {
  if (!fileIds?.length) {
    return null
  }

  const queryText = parseMessageText(query)
  let userAlpha = 0.5
  try {
    const personalization = await getUserPersonalizationByEmail(db, email)
    if (personalization) {
      const nativeRankParams =
        personalization.parameters?.[SearchModes.NativeRank]
      if (nativeRankParams?.alpha !== undefined) {
        userAlpha = nativeRankParams.alpha
      }
    }
  } catch (err) {
    // proceed with default alpha
  }

  const tracer = getTracer("chat")
  const span = tracer.startSpan("prepare_initial_attachment_context")

  try {
    const combinedSearchResponse: VespaSearchResult[] = []
    let chunksPerDocument: number[] = []
    const targetChunks = config.maxChunksPerPage
    const maxSummaryChunks = config.maxDefaultSummary

    if (fileIds && fileIds.length > 0) {
      const fileSearchSpan = span.startSpan("file_search")
      let results
      const collectionFileIds = fileIds.filter(
        (fid) => fid.startsWith("clf-") || fid.startsWith("att_"),
      )
      const nonCollectionFileIds = fileIds.filter(
        (fid) => !fid.startsWith("clf-") && !fid.startsWith("att"),
      )
      const attachmentFileIds = fileIds.filter((fid) => fid.startsWith("attf_"))

      if (nonCollectionFileIds && nonCollectionFileIds.length > 0) {
        results = await searchVespaInFiles(
          queryText,
          email,
          nonCollectionFileIds,
          {
            limit: fileIds?.length,
            alpha: userAlpha,
            rankProfile: SearchModes.GlobalSorted,
          },
        )
        if (results.root.children) {
          combinedSearchResponse.push(...results.root.children)
        }
      }

      if (collectionFileIds && collectionFileIds.length > 0) {
        allowChunkCitations = true
        results = await searchCollectionRAG(
          queryText,
          collectionFileIds,
          undefined,
          undefined,
          undefined,
          undefined,
          SearchModes.GlobalSorted,
        )
        if (results.root.children) {
          combinedSearchResponse.push(...results.root.children)
        }
      }

      if (attachmentFileIds && attachmentFileIds.length > 0) {
        results = await searchVespaInFiles(
          queryText,
          email,
          attachmentFileIds,
          {
            limit: fileIds?.length,
            alpha: userAlpha,
            rankProfile: SearchModes.GlobalSorted,
          },
        )
        if (results.root.children) {
          combinedSearchResponse.push(...results.root.children)
        }
      }

      chunksPerDocument = await getChunkCountPerDoc(
        combinedSearchResponse,
        targetChunks,
        email,
        fileSearchSpan,
      )
      fileSearchSpan?.end()
    }

    if (threadIds && threadIds.length > 0) {
      const threadSpan = span.startSpan("fetch_email_threads")
      threadSpan.setAttribute("threadIds", JSON.stringify(threadIds))

      try {
        const threadResults = await SearchEmailThreads(threadIds, email)
        if (
          threadResults.root.children &&
          threadResults.root.children.length > 0
        ) {
          const existingDocIds = new Set(
            combinedSearchResponse.map((child: any) => child.fields.docId),
          )

          const { addedCount, threadInfo } = processThreadResults(
            threadResults.root.children,
            existingDocIds,
            combinedSearchResponse,
          )
          threadSpan.setAttribute("added_email_count", addedCount)
          threadSpan.setAttribute(
            "total_thread_emails_found",
            threadResults.root.children.length,
          )
          threadSpan.setAttribute("thread_info", JSON.stringify(threadInfo))
        }
      } catch (error) {
        Logger.error(
          error,
          `Error fetching email threads: ${getErrorMessage(error)}`,
        )
        threadSpan?.setAttribute("error", getErrorMessage(error))
      }

      threadSpan?.end()
    }

    const precomputedDbContext = await getPrecomputedDbContextIfNeeded(
      combinedSearchResponse as VespaSearchResults[],
      query,
      userMetadata.userId,
      userMetadata.workspaceId,
    )
    const fragments = await Promise.all(
      combinedSearchResponse.map((child, idx) =>
        vespaResultToAttachmentFragment(
          child as VespaSearchResult,
          idx,
          userMetadata,
          query,
          allowChunkCitations,
          idx < chunksPerDocument.length
            ? chunksPerDocument[idx]
            : maxSummaryChunks,
          precomputedDbContext,
        ),
      ),
    )

    const summary = `User provided ${fragments.length} attachment fragment${
      fragments.length === 1 ? "" : "s"
    } for the first turn.`
    return { fragments, summary }
  } catch (error) {
    span.addEvent("attachment_context_error", {
      message: getErrorMessage(error),
    })
    Logger.error(error, "Failed to load attachment context")
    return null
  } finally {
    span.end()
  }
}

/**
 * Convert Vespa result to attachment fragment
 */
export async function vespaResultToAttachmentFragment(
  child: VespaSearchResult,
  idx: number,
  userMetadata: UserMetadataType,
  query: string,
  allowChunkCitations?: boolean,
  maxSummaryChunks?: number,
  precomputedDbContext?: Map<string, string>,
): Promise<MinimalAgentFragment> {
  const docId =
    (child.fields as Record<string, unknown>)?.docId ||
    `attachment_fragment_${idx}`

  return {
    id: String(docId),
    content: await answerContextMap(
      child as VespaSearchResults,
      userMetadata,
      maxSummaryChunks ? maxSummaryChunks : 0,
      true,
      allowChunkCitations ?? false,
      query,
      precomputedDbContext,
    ),
    source: searchToCitation(child as VespaSearchResults),
    confidence: 1,
  }
}

/**
 * Persist assistant message to database
 */
export async function persistAssistantMessage(
  context: PersistAssistantMessageContext,
  data: PersistAssistantMessageData,
): Promise<{ msg: SelectMessage; assistantMessageId: string }> {
  const timeTakenMs = Date.now() - context.requestStartMs

  const assistantInsert = {
    chatId: context.chatRecord.id,
    userId: context.user.id,
    workspaceExternalId: String(context.workspace.externalId),
    chatExternalId: String(context.chatRecord.externalId),
    messageRole: MessageRole.Assistant,
    email: context.user.email,
    sources: data.citations,
    imageCitations: data.imageCitations,
    message: processMessage(data.answer, data.citationMap),
    thinking: data.thinkingLog,
    modelId: context.agenticModelId,
    cost: context.totalCost.toString(),
    tokensUsed: context.tokenUsage.input + context.tokenUsage.output,
    timeTakenMs,
  } as unknown as Omit<InsertMessage, "externalId">

  const msg = await insertMessage(db, assistantInsert)

  return {
    msg,
    assistantMessageId: String(msg.externalId),
  }
}
