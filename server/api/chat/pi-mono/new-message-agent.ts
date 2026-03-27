/**
 * MessageAgents - Pi-Mono Version
 *
 * Full implementation using pi-mono coding-agent runtime.
 * Based on the INTEGRATION_GUIDE.md for proper SDK usage.
 */

import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import { isCuid } from "@paralleldrive/cuid2"
import { Apps, AttachmentEntity } from "@xyne/vespa-ts/types"

// Xyne imports
import config from "@/config"
import { db } from "@/db/client"
import { type SelectChat, type SelectMessage } from "@/db/schema"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getLogger } from "@/logger"
import { Subsystem, type UserMetadataType } from "@/types"
import { getErrorMessage } from "@/utils"
import { getDateForAI } from "@/utils/index"
import { ChatSSEvents, DEFAULT_TEST_AGENT_ID } from "@/shared/types"
import { getAgentByExternalIdWithPermissionCheck } from "@/db/agent"
import { expandSheetIds } from "@/search/utils"
import {
  extractFileIdsFromMessage,
  collectReferencedFileIdsUntilCompaction,
} from "@/api/chat/utils"
import {
  ReasoningSteps,
  emitReasoningEvent,
  type ReasoningEmitter as StructuredReasoningEmitter,
} from "@/api/chat/reasoning-steps"
import { activeStreams } from "@/api/chat/stream"
import type { Citation, MinimalAgentFragment } from "@/api/chat/types"
import { checkAndYieldCitationsForAgent } from "@/api/chat/utils"
import { getModelValueFromLabel } from "@/ai/modelConfig"
import { Models } from "@/ai/types"
import { parseAttachmentMetadata } from "@/utils/parseAttachment"
import { userContext } from "@/ai/context"
import {
  createEmptyConnectorState,
  getUserConnectorState,
} from "@/api/chat/resource-access"
import { isMessageWithContext } from "@/api/chat/utils"
import { safeDecodeURIComponent } from "@/api/chat/utils"
import { retrieveEpisodicMemories } from "@/services/episodicMemoryRetriever"
import { retrieveRelevantChatHistory } from "@/services/chatMemoryRetriever"
import { insertChatTrace } from "@/db/chatTrace"
import { getTracer } from "@/tracer"

// Pi-mono tools
import {
  searchGlobalTool,
  searchGmailTool,
  searchDriveFilesTool,
  searchCalendarEventsTool,
  searchGoogleContactsTool,
  getSlackRelatedMessagesTool,
  lsKnowledgeBaseTool,
  searchKnowledgeBaseTool,
  searchChatHistoryTool,
  toDoWriteTool,
  fallBackTool,
  synthesizeFinalAnswerTool,
  listCustomAgentsTool,
  runPublicAgentTool,
} from "./tools"

import {
  setXyneState,
  setRuntime,
  registerSession,
  unregisterSession,
  createInitialXyneState,
  type XyneAgentState,
  setPersistFunction,
} from "./adapter"
import { createXyneAgentSession } from "./core/runtime"
import type { AgentSession as PiMonoAgentSession } from "@mariozechner/pi-coding-agent"
import { createEventRouter } from "./core/event-router"
import { createXyneEventHandlers } from "./xyne-handlers"
import { buildXyneSystemPrompt } from "./prompts/xyne-prompts"
import {
  ensureChatAndPersistUserMessage,
  resolveAgenticModelId,
  buildConversationHistoryForAgentRun,
  prepareInitialAttachmentContext,
  persistAssistantMessage,
} from "./helpers"

const { JwtPayloadKey } = config

const Logger = getLogger(Subsystem.Chat)

// ============================================================================
// CUSTOM TOOLS FOR PI-MONO
// ============================================================================

/**
 * Build the list of Xyne tools for pi-mono
 * Uses existing tool definitions from ./tools
 */
function buildXyneTools(): any[] {
  return [
    searchGlobalTool,
    searchGmailTool,
    searchDriveFilesTool,
    searchCalendarEventsTool,
    searchGoogleContactsTool,
    getSlackRelatedMessagesTool,
    lsKnowledgeBaseTool,
    searchKnowledgeBaseTool,
    searchChatHistoryTool,
    toDoWriteTool,
    fallBackTool,
    synthesizeFinalAnswerTool,
    listCustomAgentsTool,
    runPublicAgentTool,
  ]
}

// ============================================================================
// MAIN MESSAGE AGENTS FUNCTION (PI-MONO VERSION)
// ============================================================================

/**
 * MessageAgents - Pi-Mono Implementation
 *
 * Full implementation using pi-mono coding-agent runtime.
 */
export async function MessageAgentsPiMono(c: Context): Promise<Response> {
  const tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("MessageAgentsPiMono")

  const { sub: email, workspaceId } = c.get(JwtPayloadKey)

  try {
    Logger.info("MessageAgentsPiMono starting")
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    // @ts-ignore
    const body = c.req.valid("query")
    let {
      message,
      chatId,
      agentId: rawAgentId,
      toolsList,
      selectedModelConfig,
    }: {
      message: string
      chatId?: string
      agentId?: string
      toolsList?: Array<{ connectorId: string; tools: string[] }>
      selectedModelConfig?: string
    } = body

    if (!message) {
      throw new HTTPException(400, { message: "Message is required" })
    }

    message = safeDecodeURIComponent(message)
    rootSpan.setAttribute("message", message)
    rootSpan.setAttribute("chatId", chatId || "new")

    // Parse model configuration
    let parsedModelId: string | undefined = undefined
    let isReasoningEnabled = false
    let enableWebSearch = false
    let isDeepResearchEnabled = false

    if (selectedModelConfig) {
      try {
        const modelConfig = JSON.parse(selectedModelConfig)
        parsedModelId = modelConfig.model
        isReasoningEnabled = modelConfig.reasoning === true
        enableWebSearch = modelConfig.websearch === true
        isDeepResearchEnabled = modelConfig.deepResearch === true

        if (
          modelConfig.capabilities &&
          !isReasoningEnabled &&
          !enableWebSearch &&
          !isDeepResearchEnabled
        ) {
          if (Array.isArray(modelConfig.capabilities)) {
            isReasoningEnabled = modelConfig.capabilities.includes("reasoning")
            enableWebSearch = modelConfig.capabilities.includes("websearch")
            isDeepResearchEnabled =
              modelConfig.capabilities.includes("deepResearch")
          } else if (typeof modelConfig.capabilities === "object") {
            isReasoningEnabled = modelConfig.capabilities.reasoning === true
            enableWebSearch = modelConfig.capabilities.websearch === true
            isDeepResearchEnabled =
              modelConfig.capabilities.deepResearch === true
          }
        }

        Logger.debug(
          `Parsed model config for MessageAgentsPiMono: model="${parsedModelId}", reasoning=${isReasoningEnabled}, websearch=${enableWebSearch}, deepResearch=${isDeepResearchEnabled}`,
        )
      } catch (error) {
        Logger.warn(
          error,
          "Failed to parse selectedModelConfig JSON in MessageAgentsPiMono. Using defaults.",
        )
        parsedModelId = config.defaultBestModel
      }
    } else {
      parsedModelId = config.defaultBestModel
      Logger.debug(
        "No model config provided to MessageAgentsPiMono, using default",
      )
    }

    let actualModelId: string = parsedModelId || config.defaultBestModel
    if (parsedModelId) {
      const convertedModelId = getModelValueFromLabel(parsedModelId)
      if (convertedModelId) {
        actualModelId = convertedModelId as string
        Logger.debug(
          `Converted model label "${parsedModelId}" to value "${actualModelId}" for MessageAgentsPiMono`,
        )
      } else if (parsedModelId in Models) {
        actualModelId = parsedModelId
        Logger.debug(
          `Using model ID "${parsedModelId}" directly for MessageAgentsPiMono`,
        )
      } else {
        Logger.error(
          `Invalid model: ${parsedModelId}. Model not found in label mappings or Models enum for MessageAgentsPiMono.`,
        )
      }
    }

    const agenticModelId = resolveAgenticModelId(actualModelId)

    if (typeof toolsList === "string") {
      try {
        toolsList = JSON.parse(toolsList) as Array<{
          connectorId: string
          tools: string[]
        }>
      } catch (error) {
        Logger.warn(
          { err: error },
          "Unable to parse toolsList payload; skipping MCP connectors.",
        )
        toolsList = []
      }
    }

    let normalizedAgentId =
      typeof rawAgentId === "string" ? rawAgentId.trim() : undefined
    if (normalizedAgentId === "") {
      normalizedAgentId = undefined
    }
    if (normalizedAgentId === DEFAULT_TEST_AGENT_ID) {
      normalizedAgentId = undefined
    }
    if (normalizedAgentId && !isCuid(normalizedAgentId)) {
      throw new HTTPException(400, {
        message: "Invalid agentId. Expected a valid CUID.",
      })
    }

    const isMsgWithContext = isMessageWithContext(message)
    const extractedInfo = isMsgWithContext
      ? await extractFileIdsFromMessage(message, email)
      : {
          totalValidFileIdsFromLinkCount: 0,
          fileIds: [],
          threadIds: [],
        }
    let attachmentsForContext =
      extractedInfo?.fileIds.map((fileId) => ({
        fileId,
        isImage: false,
      })) || []
    const attachmentMetadata = parseAttachmentMetadata(c)
    attachmentsForContext = attachmentsForContext.concat(
      attachmentMetadata.map((meta) => ({
        fileId: meta.fileId,
        isImage: meta.isImage,
      })),
    )
    const threadIds = extractedInfo?.threadIds || []
    const referencedFileIds = Array.from(
      new Set(
        attachmentsForContext
          .filter((meta) => !meta.isImage)
          .flatMap((meta) => expandSheetIds(meta.fileId)),
      ),
    )
    let allReferencedFileIds = referencedFileIds
    const imageAttachmentFileIds = Array.from(
      new Set(
        attachmentsForContext
          .filter((meta) => meta.isImage)
          .map((meta) => meta.fileId),
      ),
    )
    const isMstWithAttachments = attachmentMetadata.length > 0

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const rawUser = userAndWorkspace.user
    const rawWorkspace = userAndWorkspace.workspace
    const user = {
      id: Number(rawUser.id),
      email: String(rawUser.email),
      timeZone: typeof rawUser.timeZone === "string" ? rawUser.timeZone : "UTC",
    }
    const workspace = {
      id: Number(rawWorkspace.id),
      externalId: String(rawWorkspace.externalId),
    }
    // Load connector state for tool access
    let connectorState = createEmptyConnectorState()
    try {
      connectorState = await getUserConnectorState(db, email)
    } catch (error) {
      Logger.warn(
        error,
        "Failed to load user connector state; assuming no connectors",
      )
    }
    // Make connector state available to tools via session-scoped storage
    // This is used by search tools to determine which connectors are available
    void connectorState // Available for future tool integration
    let agentPromptForLLM: string | undefined
    let resolvedAgentId: string | undefined
    let agentRecord: any | null = null

    if (normalizedAgentId) {
      agentRecord = await getAgentByExternalIdWithPermissionCheck(
        db,
        normalizedAgentId,
        workspace.id,
        user.id,
      )
      if (!agentRecord) {
        throw new HTTPException(403, {
          message:
            "Access denied: You do not have permission to use this agent",
        })
      }
      resolvedAgentId = String(agentRecord.externalId)
      agentPromptForLLM = JSON.stringify(agentRecord)
      rootSpan.setAttribute("agentId", resolvedAgentId)
    }
    const userTimezone: string = user.timeZone || "UTC"
    const dateForAI = getDateForAI({ userTimeZone: userTimezone })
    const userMetadata: UserMetadataType = {
      userTimezone,
      dateForAI,
      userId: user.id,
      workspaceId: workspace.id,
    }
    const userCtxString = userContext(userAndWorkspace)

    let chatRecord: SelectChat
    let lastPersistedMessageExternalId = ""
    let attachmentStorageError: Error | null = null
    let previousConversationHistory: SelectMessage[] = []

    try {
      const bootstrap = await ensureChatAndPersistUserMessage({
        chatId,
        email,
        user: { id: user.id, email: user.email },
        workspace: { id: workspace.id, externalId: workspace.externalId },
        message,
        fileIds: referencedFileIds,
        attachmentMetadata,
        modelId: agenticModelId,
        agentId: resolvedAgentId ?? undefined,
      })
      chatRecord = bootstrap.chat
      lastPersistedMessageExternalId = String(bootstrap.userMessage.externalId)
      attachmentStorageError = bootstrap.attachmentError ?? null
      previousConversationHistory = bootstrap.conversationHistory ?? []
      const historyFileIds = collectReferencedFileIdsUntilCompaction(
        previousConversationHistory,
      )
      allReferencedFileIds = Array.from(
        new Set([
          ...referencedFileIds,
          ...historyFileIds.flatMap((id) => expandSheetIds(id)),
        ]),
      )
      const chatAgentId = chatRecord.agentId
        ? String(chatRecord.agentId)
        : undefined
      if (resolvedAgentId && chatAgentId && chatAgentId !== resolvedAgentId) {
        throw new HTTPException(400, {
          message:
            "This chat is already associated with a different agent. Please start a new chat for that agent.",
        })
      }
      if (!resolvedAgentId && chatAgentId) {
        resolvedAgentId = chatAgentId
      }
    } catch (error) {
      Logger.error(error, "Failed to persist user turn for MessageAgentsPiMono")
      const errMsg =
        error instanceof Error ? error.message : "Unknown persistence error"
      if (errMsg.includes("Chat not found")) {
        throw new HTTPException(404, { message: "Chat not found" })
      }
      throw new HTTPException(500, {
        message: "Failed to initialize chat for request",
      })
    }
    rootSpan.setAttribute("chatId", String(chatRecord.externalId))
    rootSpan.setAttribute(
      "conversation_history_count",
      previousConversationHistory.length,
    )

    if (
      resolvedAgentId &&
      !agentRecord &&
      resolvedAgentId !== DEFAULT_TEST_AGENT_ID
    ) {
      agentRecord = await getAgentByExternalIdWithPermissionCheck(
        db,
        resolvedAgentId,
        workspace.id,
        user.id,
      )
      if (!agentRecord) {
        throw new HTTPException(403, {
          message:
            "Access denied: You do not have permission to use the agent linked to this conversation",
        })
      }
      agentPromptForLLM = JSON.stringify(agentRecord)
      rootSpan.setAttribute("agentId", resolvedAgentId)
    }

    // Determine if we have a dedicated agent for this conversation
    const dedicatedAgentSystemPrompt =
      typeof agentRecord?.prompt === "string" &&
      agentRecord.prompt.trim().length > 0
        ? agentRecord.prompt.trim()
        : undefined

    // Return streaming response
    return streamSSE(c, async (stream) => {
      const requestStartMs = Date.now()
      const stopController = new AbortController()
      const streamKey = String(chatRecord.externalId)

      const markStop = () => {
        stopController.abort()
      }
      // Listen to the incoming request's signal for client disconnect
      c.req.raw.signal.addEventListener("abort", markStop)
      activeStreams.set(streamKey, { stream, stopController })

      if (!chatId) {
        await stream.writeSSE({
          event: ChatSSEvents.ChatTitleUpdate,
          data: String(chatRecord.title) || "Untitled",
        })
      }

      const persistTrace = async (
        messageId: number,
        messageExternalId: string,
      ) => {
        try {
          const traceJson = tracer.serializeToJson()
          await insertChatTrace({
            workspaceId: workspace.id as number,
            userId: user.id as number,
            chatId: chatRecord.id as number,
            messageId: messageId as number,
            chatExternalId: chatRecord.externalId as string,
            email: user.email as string,
            messageExternalId: messageExternalId as string,
            traceJson,
          })
        } catch (traceError) {
          Logger.error(traceError, "Failed to persist chat trace")
        }
      }

      try {
        let thinkingLog = ""

        // Prepare initial attachment context
        let initialAttachmentContext: {
          fragments: MinimalAgentFragment[]
          summary: string
        } | null = null

        if (allReferencedFileIds.length > 0) {
          await emitReasoningEvent(async (payload) => {
            thinkingLog += `${JSON.stringify(payload)}\n`
            await stream.writeSSE({
              event: ChatSSEvents.Reasoning,
              data: JSON.stringify(payload),
            })
          }, ReasoningSteps.attachmentAnalyzing())

          initialAttachmentContext = await prepareInitialAttachmentContext(
            allReferencedFileIds,
            threadIds,
            userMetadata,
            message,
            email,
            isMstWithAttachments,
          )

          if (initialAttachmentContext) {
            await emitReasoningEvent(async (payload) => {
              thinkingLog += `${JSON.stringify(payload)}\n`
              await stream.writeSSE({
                event: ChatSSEvents.Reasoning,
                data: JSON.stringify(payload),
              })
            }, ReasoningSteps.attachmentExtracted(
              initialAttachmentContext.fragments.length,
            ))
          }
        }

        // Handle image attachments
        const allFragments: MinimalAgentFragment[] =
          initialAttachmentContext?.fragments || []
        if (imageAttachmentFileIds.length > 0) {
          const imageFragments = imageAttachmentFileIds.map((fileId, index) => {
            const fragmentId = `user_attachment_image:${fileId}:${index}`
            return {
              id: fragmentId,
              content: `User provided image attachment ${index + 1}.`,
              source: {
                docId: fileId,
                title: `Attachment image ${index + 1}`,
                url: "",
                app: Apps.Attachment,
                entity: AttachmentEntity.Image,
              } as Citation,
              confidence: 0.9,
              images: [
                {
                  fileName: `${index}_${fileId}_0`,
                  addedAtTurn: 0,
                  sourceFragmentId: fragmentId,
                  sourceToolName: "user_input",
                  isUserAttachment: true,
                },
              ],
            } as MinimalAgentFragment
          })
          allFragments.push(...imageFragments)
        }

        // Send start event
        await stream.writeSSE({
          event: ChatSSEvents.Start,
          data: "",
        })

        // Send initial metadata
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({
            chatId: chatRecord.externalId,
          }),
        })

        if (attachmentMetadata.length > 0 && lastPersistedMessageExternalId) {
          await stream.writeSSE({
            event: ChatSSEvents.AttachmentUpdate,
            data: JSON.stringify({
              messageId: lastPersistedMessageExternalId,
              attachments: attachmentMetadata,
            }),
          })
        }

        if (attachmentStorageError) {
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: JSON.stringify({
              error: "attachment_storage_failed",
              message:
                "Failed to store attachment metadata. Your message was saved but attachments may not be available for future reference.",
              details: attachmentStorageError.message,
            }),
          })
        }

        // 1. Format Base URL (ensure /v1 suffix)
        const baseUrl = config.LiteLLMBaseUrl?.endsWith("/v1")
          ? config.LiteLLMBaseUrl
          : `${config.LiteLLMBaseUrl}/v1`

        // Create Xyne state first (needed by tools)
        const xyneState = createInitialXyneState(
          email,
          String(workspace.id),
          String(user.id),
          String(chatRecord.externalId),
          message,
          new Date().toISOString(),
        )

        // Add additional context to state
        xyneState.userContext = userCtxString
        xyneState.agentPrompt = agentPromptForLLM
        xyneState.dedicatedAgentSystemPrompt = dedicatedAgentSystemPrompt
        xyneState.user.workspaceNumericId = workspace.id
        xyneState.chat.id = chatRecord.id
        xyneState.modelId = agenticModelId

        // Register session for concurrent-safe state access by tools
        const sessionId = chatRecord.externalId
        const persistFn = async (_state: XyneAgentState) => {
          Logger.debug("Persisting Xyne state")
        }
        registerSession(sessionId, xyneState, persistFn)

        // Set up persist function (legacy compat)
        setPersistFunction(persistFn)

        // --- Retrieve episodic + chat memory ---
        try {
          const [episodicResults, chatMemoryResults] = await Promise.all([
            retrieveEpisodicMemories({
              query: message,
              email,
              workspaceId: String(workspace.id),
            }).catch((err) => {
              Logger.warn(err, "Episodic memory retrieval failed")
              return []
            }),
            retrieveRelevantChatHistory({
              query: message,
              chatId: String(chatRecord.externalId),
              email,
              workspaceId: String(workspace.id),
            }).catch((err) => {
              Logger.warn(err, "Chat memory retrieval failed")
              return []
            }),
          ])

          if (episodicResults.length > 0) {
            xyneState.episodicMemoriesText = episodicResults
              .map((m: any) => m.content || m.text || JSON.stringify(m))
              .join("\n---\n")
          }
          if (chatMemoryResults.length > 0) {
            xyneState.chatMemoryText = chatMemoryResults
              .map((m: any) => m.content || m.text || JSON.stringify(m))
              .join("\n---\n")
          }

          Logger.info(
            {
              episodicCount: episodicResults.length,
              chatMemoryCount: chatMemoryResults.length,
            },
            "[Pi-Mono] Memory retrieval complete",
          )
        } catch (memErr) {
          Logger.warn(memErr, "Memory retrieval failed")
        }

        // --- Store conversation history for synthesis ---
        xyneState.conversationHistoryMessages = previousConversationHistory
          .filter(
            (m: any) =>
              m.messageRole === "user" || m.messageRole === "assistant",
          )
          .slice(-20) // Keep last 20 messages for context
          .map((m: any) => ({
            role: m.messageRole === "user" ? "user" : "assistant",
            content: [{ text: m.message || "" }],
          }))

        const customTools = buildXyneTools()

        // Build robust system prompt using the xyne-prompts abstraction
        const systemPrompt = buildXyneSystemPrompt({
          state: xyneState,
          toolNames: customTools.map((tool) => tool.name),
          dateForAI,
          delegationEnabled: true,
        })

        const session = await createXyneAgentSession({
          model: agenticModelId,
          systemPrompt,
          tools: customTools,
          state: xyneState,
          baseUrl,
          apiKey: config.LiteLLMApiKey,
        })

        // Get the underlying piSession for event subscription
        const piSession = session.getUnderlyingSession() as PiMonoAgentSession

        // Store Xyne state in adapter for tools to access
        setXyneState(piSession, xyneState)

        Logger.info(
          {
            systemPromptLength: systemPrompt.length,
            toolCount: customTools.length,
            toolNames: customTools.map((t: any) => t.name),
          },
          "Created pi-mono session with Xyne state",
        )

        // Subscribe to events
        let answer = ""
        const citations: Citation[] = []
        const citationsByDocId: Map<string, number> = new Map() // docId -> index in citations array
        const imageCitations: any[] = []
        const citationMap: Record<number, number> = {}
        const yieldedCitations = new Set<number>()
        const yieldedImageCitations = new Map<number, Set<number>>()
        let assistantMessageId: string | null = null

        const reasoningEmitter: StructuredReasoningEmitter = async (
          payload,
        ) => {
          if (stream.closed) return
          await stream.writeSSE({
            event: ChatSSEvents.Reasoning,
            data: JSON.stringify(payload),
          })
        }

        // Set up runtime callbacks BEFORE tools run
        // This gives synthesizeFinalAnswer direct access to the SSE stream
        setRuntime({
          streamAnswerText: async (text: string) => {
            if (!text || stream.closed) return
            answer += text
            await stream.writeSSE({
              event: ChatSSEvents.ResponseUpdate,
              data: text,
            })

            // Extract citations inline as text streams (mirrors JAF's streamAnswerText)
            const fragmentsForCitations = xyneState.allFragments
            for await (const citationEvent of checkAndYieldCitationsForAgent(
              answer,
              yieldedCitations,
              fragmentsForCitations,
              yieldedImageCitations,
              email,
              xyneState.citationDocIdMapping,
            )) {
              if (stream.closed) break
              if (citationEvent.citation) {
                const { index, item } = citationEvent.citation
                const docId = item.docId || item.url || String(index)

                // Check if we've already seen this document
                if (citationsByDocId.has(docId)) {
                  // Reuse existing citation index
                  citationMap[index] = citationsByDocId.get(docId)!
                } else {
                  // Add new citation
                  citations.push(item)
                  const citationIndex = citations.length - 1
                  citationsByDocId.set(docId, citationIndex)
                  citationMap[index] = citationIndex
                }

                await stream.writeSSE({
                  event: ChatSSEvents.CitationsUpdate,
                  data: JSON.stringify({
                    contextChunks: citations,
                    citationMap,
                  }),
                })
              }
              if (citationEvent.imageCitation) {
                imageCitations.push(citationEvent.imageCitation)
                await stream.writeSSE({
                  event: ChatSSEvents.ImageCitationUpdate,
                  data: JSON.stringify(citationEvent.imageCitation),
                })
              }
            }
          },
          emitReasoning: async (payload: any) => {
            await emitReasoningEvent(reasoningEmitter, payload)
          },
        })

        // Track completion
        let agentCompleted = false
        let agentCompletionResolve: (() => void) | null = null
        let agentCompletionReject: ((err: Error) => void) | null = null
        const agentCompletionPromise = new Promise<void>((resolve, reject) => {
          agentCompletionResolve = resolve
          agentCompletionReject = reject
        })

        // Set up event handlers using the modular event router
        const eventHandlers = createXyneEventHandlers({
          message,
          customTools,
          dateForAI,
          agentCompletionResolve,
          agentCompletionReject,
          state: xyneState,
          stream: {
            closed: false,
            writeSSE: async (data: { event: string; data: string }) => {
              if (!stream.closed) {
                await stream.writeSSE(data)
              }
            },
          },
          session: piSession,
          stateManager: {
            persist: async () => {
              Logger.debug("Persisting Xyne state")
            },
          },
          reasoningEmitter,
          setAgentCompleted: (completed: boolean) => {
            agentCompleted = completed
          },
          buildSystemPrompt: (s, toolNames, date, delegation) =>
            buildXyneSystemPrompt({
              state: s,
              toolNames,
              dateForAI: date,
              delegationEnabled: delegation,
            }),
        })

        // Create and start the event router
        const router = createEventRouter({
          state: xyneState,
          session: piSession,
          handlers: eventHandlers,
          onError: (error) => {
            Logger.error(error, "Event router error")
          },
        })
        router.start()

        // Start the conversation
        Logger.info("Starting pi-mono prompt...")

        // Catch synchronous errors from prompt()
        let promptError: Error | null = null
        piSession.prompt(message).catch((err: any) => {
          promptError = err instanceof Error ? err : new Error(String(err))
          Logger.error({ err }, "PI-MONO PROMPT CRASHED")
          // Force agent completion to unblock the promise
          if (!agentCompleted && agentCompletionResolve) {
            agentCompletionResolve()
          }
        })

        // Small delay to see if prompt() fails synchronously
        await new Promise((resolve) => setTimeout(resolve, 100))

        if (promptError) {
          throw new Error(`Prompt failed: ${(promptError as Error).message}`)
        }

        Logger.info("Pi-mono prompt returned, waiting for completion...")

        // Wait for completion
        const completionTimeoutMs = 10 * 60 * 1000 // 10 minutes
        try {
          await Promise.race([
            agentCompletionPromise,
            new Promise<void>((_, reject) =>
              setTimeout(
                () => reject(new Error("Agent completion timeout")),
                completionTimeoutMs,
              ),
            ),
          ])
          Logger.info("Agent completed successfully")
        } catch (timeoutErr) {
          Logger.error(timeoutErr, "Agent completion timeout")
          if (!agentCompleted) {
            throw timeoutErr
          }
        }

        // Fallback if the agent disobeyed the prompt and answered natively without using synthesizeFinalAnswer
        // Fallback if the agent disobeyed the prompt and answered natively without using synthesizeFinalAnswer
        if (!xyneState.finalSynthesis.requested && thinkingLog.trim() !== "") {
          Logger.warn(
            "Agent bypassed synthesizeFinalAnswer tool, forcefully intercepting to ensure grounding...",
          )

          try {
            // Forcefully execute the synthesis tool to guarantee a grounded, cited answer
            await synthesizeFinalAnswerTool.execute(
              "forced_fallback_call",
              { insightsUsefulForAnswering: thinkingLog.trim() },
              undefined,
              () => {},
              piSession as any,
            )
          } catch (forcedSynthesisErr) {
            Logger.error(
              forcedSynthesisErr,
              "Forced synthesis failed, falling back to raw text dump",
            )

            // Absolute worst-case fallback: stream the raw text
            const fallbackText = thinkingLog.trim()
            answer = fallbackText

            await stream.writeSSE({
              event: ChatSSEvents.ResponseUpdate,
              data: fallbackText,
            })

            // Extract citations from the fallback text too
            const fragmentsForCitations = xyneState.allFragments
            for await (const citationEvent of checkAndYieldCitationsForAgent(
              answer,
              yieldedCitations,
              fragmentsForCitations,
              yieldedImageCitations,
              email,
              xyneState.citationDocIdMapping,
            )) {
              if (stream.closed) break
              if (citationEvent.citation) {
                const { index, item } = citationEvent.citation
                const docId = item.docId || item.url || String(index)

                // Check if we've already seen this document
                if (citationsByDocId.has(docId)) {
                  // Reuse existing citation index
                  citationMap[index] = citationsByDocId.get(docId)!
                } else {
                  // Add new citation
                  citations.push(item)
                  const citationIndex = citations.length - 1
                  citationsByDocId.set(docId, citationIndex)
                  citationMap[index] = citationIndex
                }

                await stream.writeSSE({
                  event: ChatSSEvents.CitationsUpdate,
                  data: JSON.stringify({
                    contextChunks: citations,
                    citationMap,
                  }),
                })
              }
              if (citationEvent.imageCitation) {
                imageCitations.push(citationEvent.imageCitation)
                await stream.writeSSE({
                  event: ChatSSEvents.ImageCitationUpdate,
                  data: JSON.stringify(citationEvent.imageCitation),
                })
              }
            }
            await emitReasoningEvent(
              reasoningEmitter,
              ReasoningSteps.synthesisCompleted(),
            )
          }
        }

        // Persist final message
        try {
          const persisted = await persistAssistantMessage(
            {
              chatRecord,
              user,
              workspace: { externalId: workspace.externalId },
              agenticModelId,
              totalCost: 0,
              tokenUsage: { input: 0, output: 0 },
              requestStartMs,
            },
            {
              answer,
              citations,
              imageCitations,
              citationMap,
              thinkingLog,
            },
          )
          assistantMessageId = persisted.assistantMessageId
          await persistTrace(persisted.msg.id as number, assistantMessageId)
        } catch (persistErr) {
          Logger.error(persistErr, "Failed to persist message")
        }

        // Send final metadata
        if (!stream.closed) {
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chatRecord.externalId,
              messageId: assistantMessageId || "temp-message-id",
              timeTakenMs: Date.now() - requestStartMs,
            }),
          })
          await stream.writeSSE({
            event: ChatSSEvents.End,
            data: "",
          })
        }

        rootSpan.end()
      } catch (error) {
        Logger.error(error, "MessageAgentsPiMono stream error")
        const streamErrMsg = getErrorMessage(error)

        if (!stream.closed) {
          try {
            await stream.writeSSE({
              event: ChatSSEvents.Error,
              data: JSON.stringify({
                error: "stream_error",
                message: streamErrMsg,
              }),
            })
            await stream.writeSSE({
              event: ChatSSEvents.End,
              data: "",
            })
          } catch (writeErr) {
            Logger.warn(writeErr, "Failed to send error to client")
          }
        }
        rootSpan.end()
      } finally {
        stopController.signal.removeEventListener("abort", markStop)
        const activeEntry = activeStreams.get(streamKey)
        if (activeEntry?.stream === stream) {
          activeStreams.delete(streamKey)
        }
        // Clean up session-scoped state
        unregisterSession(chatRecord?.externalId ?? "")
      }
    })
  } catch (error) {
    Logger.error(error, "MessageAgentsPiMono failed")
    rootSpan.end()
    throw error
  }
}
