import {
  SearchModes,
  type VespaSearchResponse,
  type VespaSearchResult,
  type VespaSearchResults,
} from "@xyne/vespa-ts/types"

import config from "@/config"
import { db } from "@/db/client"

import { answerContextMap } from "@/ai/context"
import { parseMessageText } from "@/api/chat/chat"
import { getChunkCountPerDoc } from "@/api/chat/chunk-selection"
import type { Citation, MinimalAgentFragment } from "@/api/chat/types"
import { processThreadResults } from "@/api/chat/utils"
import { processMessage, searchToCitation } from "@/api/chat/utils"
import { getUserPersonalizationByEmail } from "@/db/personalization"
import { getPrecomputedDbContextIfNeeded } from "@/lib/databaseContext"
import { getLogger } from "@/logger"
import {
  SearchEmailThreads,
  searchCollectionRAG,
  searchVespaInFiles,
} from "@/search/vespa"
import { getTracer } from "@/tracer"
import { MessageRole, Subsystem, type UserMetadataType } from "@/types"
import { getErrorMessage } from "@/utils"
import type { AttachmentMetadata } from "@/shared/types"
import {
  ChatType,
  type InsertChat,
  type InsertMessage,
  type SelectChat,
  type SelectMessage,
} from "@/db/schema"
import { insertChat, updateChatByExternalIdWithAuth } from "@/db/chat"
import type { Models } from "@/ai/types"
import {
  getChatMessagesWithAuth,
  getMessageByExternalId,
  insertMessage,
} from "@/db/message"
import { storeAttachmentMetadata } from "@/db/attachment"

const Logger = getLogger(Subsystem.Chat)
const { defaultBestModel, defaultBestModelAgenticMode } = config

// Re-export for convenience
export const helpersConfig = { defaultBestModel, defaultBestModelAgenticMode }

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
    visibleChunkIndices: [],
  }
}

export async function bootstrapChat(params: {
  chatId?: string
  email: string
  user: { id: number; email: string }
  workspace: { id: number; externalId: string }
  message: string
  modelId?: string
  attachmentMetadata: AttachmentMetadata[]
}): Promise<{
  chat: SelectChat
  userMessage: SelectMessage
  conversationHistory: SelectMessage[]
  isNewChat: boolean
  attachmentError?: Error
}> {
  const workspaceId = Number(params.workspace.id)
  const workspaceExternalId = String(params.workspace.externalId)
  const userId = Number(params.user.id)
  const userEmail = String(params.user.email)

  return await db.transaction(async (tx) => {
    let attachmentError: Error | undefined

    if (!params.chatId) {
      // Create new chat
      const chatInsert = {
        workspaceId,
        workspaceExternalId,
        userId,
        email: userEmail,
        title: "Untitled",
        attachments: [],
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
        modelId: (params.modelId as Models) || defaultBestModel,
        fileIds: [],
      } as unknown as Omit<InsertMessage, "externalId">
      let userMessage = await insertMessage(tx, messageInsert)

      // Store attachment metadata if present
      if (params.attachmentMetadata.length > 0) {
        try {
          await storeAttachmentMetadata(
            tx,
            String(userMessage.externalId),
            params.attachmentMetadata,
            userEmail,
          )
        } catch (err) {
          attachmentError = err as Error
          Logger.error(
            err,
            `Failed to store attachment metadata for message ${userMessage.externalId}`,
          )
        }
      }

      return {
        chat,
        userMessage,
        conversationHistory: [],
        isNewChat: true,
        attachmentError,
      }
    }

    // Existing chat - get conversation history
    const chat = await updateChatByExternalIdWithAuth(
      tx,
      params.chatId,
      params.email,
      {},
    )
    const allMessages = await getChatMessagesWithAuth(
      tx,
      params.chatId,
      params.email,
    )

    const messageInsert = {
      chatId: chat.id,
      userId,
      workspaceExternalId,
      chatExternalId: chat.externalId,
      messageRole: MessageRole.User,
      email: userEmail,
      sources: [],
      message: params.message,
      modelId: (params.modelId as Models) || defaultBestModel,
      fileIds: [],
    } as unknown as Omit<InsertMessage, "externalId">
    let userMessage = await insertMessage(tx, messageInsert)

    // Store attachment metadata if present
    if (params.attachmentMetadata.length > 0) {
      try {
        await storeAttachmentMetadata(
          tx,
          String(userMessage.externalId),
          params.attachmentMetadata,
          userEmail,
        )
      } catch (err) {
        attachmentError = err as Error
        Logger.error(
          err,
          `Failed to store attachment metadata for message ${userMessage.externalId}`,
        )
      }
    }

    return {
      chat,
      userMessage,
      conversationHistory: allMessages,
      isNewChat: false,
      attachmentError,
    }
  })
}

export async function persistAssistantMessage(
  chatRecord: SelectChat,
  user: { id: number; email: string },
  workspace: { externalId: string },
  modelId: string,
  requestStartMs: number,
  data: {
    answer: string
    citations: Citation[]
    citationMap: Record<number, number>
    thinkingLog: string
  },
): Promise<{ msg: SelectMessage; assistantMessageId: string }> {
  const timeTakenMs = Date.now() - requestStartMs

  const assistantInsert = {
    chatId: chatRecord.id,
    userId: user.id,
    workspaceExternalId: String(workspace.externalId),
    chatExternalId: String(chatRecord.externalId),
    messageRole: MessageRole.Assistant,
    email: user.email,
    sources: data.citations,
    message: data.answer,
    thinking: data.thinkingLog,
    modelId,
    cost: "0",
    tokensUsed: 0,
    timeTakenMs,
  } as unknown as Omit<InsertMessage, "externalId">

  const msg = await insertMessage(db, assistantInsert)

  return {
    msg,
    assistantMessageId: String(msg.externalId),
  }
}
