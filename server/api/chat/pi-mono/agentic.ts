import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"

import { SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent"

import {
  getModelValueFromLabel,
  getModelConfiguration,
  getActualNameFromEnum,
} from "@/ai/modelConfig"
import { AIProviders } from "@/ai/types"
import {
  type ReasoningEmitter,
  ReasoningSteps,
  emitReasoningEvent,
} from "@/api/chat/reasoning-steps"
import { activeStreams } from "@/api/chat/stream"
import type { Citation } from "@/api/chat/types"
import {
  extractFileIdsFromMessage,
  isMessageWithContext,
  safeDecodeURIComponent,
} from "@/api/chat/utils"
import config from "@/config"
import { insertChatTrace } from "@/db/chatTrace"
import { db } from "@/db/client"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getAgentByExternalIdWithPermissionCheck } from "@/db/agent"
import { isCuid } from "@paralleldrive/cuid2"
import { DEFAULT_TEST_AGENT_ID } from "@/shared/types"
import { getLogger } from "@/logger"
import { ChatSSEvents, type ReasoningEventPayload } from "@/shared/types"
import { Models } from "@/ai/types"
import { getTracer } from "@/tracer"
import { Subsystem, type UserMetadataType } from "@/types"
import { getErrorMessage } from "@/utils"
import { getDateForAI } from "@/utils/index"
import { parseAttachmentMetadata } from "@/utils/parseAttachment"

import {
  type XyneAgentState,
  createInitialXyneState,
  registerSession,
  unregisterSession,
} from "./adapter"
import { getImagesForAgent, processAttachments } from "./attachments"
import {
  CITATION_ENTRY_TYPE,
  buildCitationDelta,
  restoreCitationState,
} from "./citation-state"
import { type RAGAgent, type RAGEvent, createRAGAgent } from "./core"
import {
  clearExtensionState,
  setExtensionState,
  default as xyneExtension,
} from "./pi-mono-extension"
import { buildPiMonoSystemPrompt } from "./prompts/xyne-prompts"
import { getAvailableTools } from "./tools"

const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.Chat)

import { bootstrapChat, persistAssistantMessage } from "./helpers"
import { checkAndYieldCitationsForAgent } from "./tools/tool-utils"

export async function AgenticRAG(c: Context): Promise<Response> {
  const tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("AgenticRAG")
  const { sub: email, workspaceId } = c.get(JwtPayloadKey)

  try {
    Logger.info("AgenticRAG starting")
    // @ts-ignore
    const body = c.req.valid("query")
    let {
      message,
      chatId,
      selectedModelConfig,
      agentId: rawAgentId,
    }: {
      message: string
      chatId?: string
      selectedModelConfig?: string
      agentId?: string
    } = body

    if (!message)
      throw new HTTPException(400, { message: "Message is required" })
    message = safeDecodeURIComponent(message)
    rootSpan.setAttribute("message", message)

    // ── Parse and validate agentId ─────────────────────────────────────
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

    let modelId: string = config.defaultBestModel
    let requestedModelLabel: string | undefined

    if (selectedModelConfig) {
      try {
        const parsed = JSON.parse(selectedModelConfig)
        if (parsed.model) {
          requestedModelLabel = parsed.model
          const resolvedModel = getModelValueFromLabel(parsed.model)
          if (resolvedModel) {
            modelId = resolvedModel as string
            Logger.info(
              { email, requestedModel: parsed.model, resolvedModelId: modelId },
              "Resolved model label to model ID",
            )
          } else if (parsed.model in Models) {
            modelId = parsed.model
            Logger.info(
              { email, modelId },
              "Using model ID directly from Models enum",
            )
          } else {
            // Model could not be resolved - this is a configuration mismatch
            Logger.error(
              {
                email,
                requestedModel: parsed.model,
                availableModels: Object.keys(Models),
              },
              "Model resolution failed: requested model not found in configuration",
            )
            throw new HTTPException(400, {
              message: `Invalid model '${parsed.model}'. This model is not available in the current configuration. Please select a different model or contact your administrator.`,
            })
          }
        }
      } catch (error) {
        if (error instanceof HTTPException) {
          throw error
        }
        Logger.error({ error, email }, "Failed to parse selectedModelConfig")
        throw new HTTPException(400, {
          message:
            "Invalid model configuration. Please try again or select a different model.",
        })
      }
    }

    // Validate that the resolved model exists in configuration
    const modelConfig = getModelConfiguration(modelId)
    if (!modelConfig) {
      Logger.error(
        { email, modelId, requestedModelLabel },
        "Model configuration not found for resolved model ID",
      )
    }

    // TODO: add multi provider support
    // if (modelConfig.provider !== AIProviders.LiteLLM) {
    //   throw new HTTPException(400, {
    //     message: `Agentic mode requires LiteLLM models. Selected model '${modelId}' uses ${modelConfig.provider} provider.`,
    //   })
    // }

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const user = {
      id: Number(userAndWorkspace.user.id),
      email: String(userAndWorkspace.user.email),
      timeZone: (userAndWorkspace.user as any).timeZone ?? "UTC",
    }
    const workspace = {
      id: Number(userAndWorkspace.workspace.id),
      externalId: String(userAndWorkspace.workspace.externalId),
    }

    // ── Fetch agent record if agentId provided ─────────────────────────
    let agentRecord: Awaited<
      ReturnType<typeof getAgentByExternalIdWithPermissionCheck>
    > | null = null
    let resolvedAgentId: string | undefined
    let agentPromptForLLM: string | undefined
    let dedicatedAgentSystemPrompt: string | undefined

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
      dedicatedAgentSystemPrompt =
        typeof agentRecord.prompt === "string" &&
        agentRecord.prompt.trim().length > 0
          ? agentRecord.prompt.trim()
          : undefined
      rootSpan.setAttribute("agentId", resolvedAgentId)
      Logger.info(
        { agentId: resolvedAgentId, agentName: agentRecord.name },
        "[AgenticRAG] Using agent configuration",
      )
    }

    // Parse attachment metadata early
    const attachmentMetadata = parseAttachmentMetadata(c)
    const bootstrap = await bootstrapChat({
      chatId,
      email,
      user: { id: user.id, email: user.email },
      workspace,
      message,
      modelId,
      attachmentMetadata,
      agentId: resolvedAgentId,
    })
    const { chat: chatRecord, attachmentError, userMessage } = bootstrap

    // Validate that existing chat's agent matches the requested agent
    const chatAgentId = chatRecord.agentId
      ? String(chatRecord.agentId)
      : undefined
    if (resolvedAgentId && chatAgentId && chatAgentId !== resolvedAgentId) {
      throw new HTTPException(400, {
        message:
          "This chat is already associated with a different agent. Please start a new chat for that agent.",
      })
    }
    // If no agent was requested but chat has an agent, use the chat's agent
    if (!resolvedAgentId && chatAgentId) {
      agentRecord = await getAgentByExternalIdWithPermissionCheck(
        db,
        chatAgentId,
        workspace.id,
        user.id,
      )
      if (!agentRecord) {
        throw new HTTPException(403, {
          message:
            "Access denied: You do not have permission to use the agent linked to this conversation",
        })
      }
      resolvedAgentId = chatAgentId
      agentPromptForLLM = JSON.stringify(agentRecord)
      dedicatedAgentSystemPrompt =
        typeof agentRecord.prompt === "string" &&
        agentRecord.prompt.trim().length > 0
          ? agentRecord.prompt.trim()
          : undefined
    }

    // Log attachment storage error if present
    if (attachmentError) {
      Logger.error(
        attachmentError,
        "Failed to store attachment metadata. Your message was saved but attachments may not be available for future reference.",
      )
    }

    // ── Attachments ────────────────────────────────────────────────────
    const isMsgWithContext = isMessageWithContext(message)
    const extractedInfo = isMsgWithContext
      ? await extractFileIdsFromMessage(message, email)
      : { totalValidFileIdsFromLinkCount: 0, fileIds: [], threadIds: [] }

    // Separate document file IDs and image file IDs
    const documentFileIds = (extractedInfo?.fileIds ?? []).concat(
      attachmentMetadata.filter((m) => !m.isImage).map((m) => m.fileId),
    )
    const imageAttachmentFileIds = attachmentMetadata
      .filter((m) => m.isImage)
      .map((m) => m.fileId)
    const threadIds = extractedInfo?.threadIds ?? []

    const userTimezone = user.timeZone || "UTC"
    const dateForAI = getDateForAI({ userTimeZone: userTimezone })

    // ── Stream response ────────────────────────────────────────────────
    return streamSSE(c, async (stream) => {
      const requestStartMs = Date.now()
      const stopController = new AbortController()
      const streamKey = String(chatRecord.externalId)
      let currentTurn = { value: 0 }
      let agent: RAGAgent<XyneAgentState> | null = null

      if (!chatId) {
        await stream.writeSSE({ data: "", event: ChatSSEvents.ChatTitleUpdate })
      }

      const markStop = () => {
        agent?.stop().catch(() => {})
        stopController.abort()
      }
      c.req.raw.signal.addEventListener("abort", markStop)
      activeStreams.set(streamKey, { stream, stopController })

      try {
        let thinkingLog = ""
        let agentThinkingEvents: string[] = []
        const emitReasoningStep: ReasoningEmitter = async (payload) => {
          if (stream.closed) return
          const withMeta = {
            ...payload,
            turnNumber: payload.turnNumber ?? currentTurn.value,
          }
          thinkingLog += `${JSON.stringify(withMeta)}\n`
          await stream.writeSSE({
            event: ChatSSEvents.Reasoning,
            data: JSON.stringify(withMeta),
          })
        }

        const xyneState = createInitialXyneState(
          email,
          String(workspace.externalId),
          String(user.id),
          String(chatRecord.externalId),
          message,
          new Date().toISOString(),
        )
        xyneState.modelId = modelId
        xyneState.delegationEnabled = false
        // Set agent context for KB search scoping and custom prompts
        if (agentPromptForLLM) {
          xyneState.agentPrompt = agentPromptForLLM
        }
        if (dedicatedAgentSystemPrompt) {
          xyneState.dedicatedAgentSystemPrompt = dedicatedAgentSystemPrompt
        }

        // Process document and thread attachments
        if (documentFileIds.length > 0 || threadIds.length > 0) {
          await emitReasoningEvent(
            emitReasoningStep,
            ReasoningSteps.attachmentAnalyzing(),
          )

          const { fragments, summary } = await processAttachments({
            fileIds: documentFileIds,
            threadIds,
            message,
            email,
            userTimezone,
            dateForAI,
            userId: user.id,
            workspaceId: workspace.id,
          })
          xyneState.attachmentContext = { fragments, summary }
        }
        const images = await getImagesForAgent(imageAttachmentFileIds, email)

        // ── Prepare session persistence ──────────────────────────────
        const sessionsDir = config.piMonoSessionsDir
        if (!existsSync(sessionsDir))
          mkdirSync(sessionsDir, { recursive: true })
        const sessionFilePath = join(
          sessionsDir,
          `${chatRecord.externalId}.jsonl`,
        )
        if (!existsSync(sessionFilePath)) {
          const dir = dirname(sessionFilePath)
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          writeFileSync(
            sessionFilePath,
            JSON.stringify({
              type: "session",
              version: 3,
              id: randomUUID(),
              timestamp: new Date().toISOString(),
              cwd: "/tmp",
            }) + "\n",
          )
        }

        setExtensionState({
          xyneState,
          currentTurn,
          agenticModelId: modelId,
          message,
          email,
          emitReasoningStep,
        })

        const availableTools = await getAvailableTools(email)

        xyneState.enabledTools = new Set(availableTools.map((t) => t.name))
        const systemPrompt = buildPiMonoSystemPrompt(xyneState, dateForAI)

        const baseUrl = config.LiteLLMBaseUrl?.endsWith("/v1")
          ? config.LiteLLMBaseUrl
          : `${config.LiteLLMBaseUrl}/v1`
        const apiKey = config.LiteLLMApiKey
        const contextWindow = 250000
        const maxTokens = 32000
        const compactionSettings = {
          enabled: true,
          reserveTokens: maxTokens + 8192, // Reserve space for response + buffer
          keepRecentTokens: 50000, // Keep more recent context
        }

        // TODO: handle model configuration based on provider
        const llmModelName = getActualNameFromEnum(modelId) || modelId

        agent = await createRAGAgent<XyneAgentState>({
          model: llmModelName,
          baseUrl,
          apiKey,
          tools: availableTools,
          systemPrompt,
          sessionManager: SessionManager.open(sessionFilePath),
          settingsManager: SettingsManager.inMemory({
            compaction: compactionSettings,
            retry: { enabled: true, maxRetries: 2 },
          }),
          modelOptions: {
            contextWindow,
            maxTokens,
            reasoning: true,
          },
          thinkingLevel: "low",
          extensions: [xyneExtension],
          state: xyneState,
          timeoutMs: 10 * 60 * 1000, // 10 minutes
        })

        const piSession = agent.getSession()
        const piMonoSessionId = piSession.sessionManager?.getSessionId()
        registerSession(piMonoSessionId, xyneState)

        // Restore citation state from prior turns
        restoreCitationState(piSession.sessionManager.getEntries(), xyneState)

        // ── Send start events ────────────────────────────────────────
        await stream.writeSSE({ event: ChatSSEvents.Start, data: "" })
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({
            chatId: chatRecord.externalId,
            messageId: String(userMessage.externalId),
          }),
        })

        if (attachmentMetadata.length > 0) {
          await stream.writeSSE({
            event: ChatSSEvents.AttachmentUpdate,
            data: JSON.stringify({
              messageId: String(userMessage.externalId),
              attachments: attachmentMetadata,
            }),
          })
        }

        let answer = ""
        const citations: Citation[] = []
        const citationsByDocId = new Map<string, number>()
        const citationMap: Record<number, number> = {}
        const yieldedCitations = new Set<number>()
        const yieldedImageCitations = new Map<number, Set<number>>()
        let assistantMessageId: string | null = null
        let lastStopReason: string | undefined

        // ── Thinking delta batching ──────────────────────────────────
        // Instead of sending every single thinking token as a separate
        // SSE event (thousands of events crashing the browser), batch
        // them and flush periodically.
        const THINKING_BATCH_SIZE = 200 // chars
        const THINKING_BATCH_INTERVAL_MS = 150 // ms
        let thinkingBatch = ""
        let lastThinkingFlushTime = Date.now()

        const flushThinkingBatch = async (contentIndex: number) => {
          if (!thinkingBatch || stream.closed) return
          const batch = thinkingBatch
          thinkingBatch = ""
          lastThinkingFlushTime = Date.now()
          const deltaEvent = {
            type: "thinking_delta",
            delta: batch,
            contentIndex,
            timestamp: Date.now(),
          }
          agentThinkingEvents.push(JSON.stringify(deltaEvent))
          await stream.writeSSE({
            event: ChatSSEvents.Reasoning,
            data: JSON.stringify(deltaEvent),
          })
        }

        // ── Consume event stream ─────────────────────────────────────
        for await (const event of agent.run(message, { images })) {
          if (stream.closed) break

          // Skip raw events early — they carry full accumulated content
          // and are not used in the SSE output
          if (event.type === "raw") continue

          // Flush any pending thinking batch before processing
          // non-thinking events to preserve ordering
          if (event.type !== "thinking_delta" && thinkingBatch) {
            await flushThinkingBatch((event as any).contentIndex ?? 0)
          }

          switch (event.type) {
            case "turn_start":
              currentTurn.value = event.turnIndex
              xyneState.turnCount = event.turnIndex
              break
            case "text_delta": {
              if (!event.delta) break
              answer += event.delta
              await stream.writeSSE({
                event: ChatSSEvents.ResponseUpdate,
                data: event.delta,
              })

              // Yield citations inline
              for await (const ce of checkAndYieldCitationsForAgent(
                answer,
                yieldedCitations,
                xyneState.allFragments,
                yieldedImageCitations,
                email,
                xyneState.citationDocIdMapping,
              )) {
                if (stream.closed) break
                if (ce.citation) {
                  const { index, item } = ce.citation
                  const docId = item.docId || String(index)
                  if (citationsByDocId.has(docId)) {
                    citationMap[index] = citationsByDocId.get(docId)!
                  } else {
                    citations.push(item)
                    citationsByDocId.set(docId, citations.length - 1)
                    citationMap[index] = citations.length - 1
                  }
                  await stream.writeSSE({
                    event: ChatSSEvents.CitationsUpdate,
                    data: JSON.stringify({
                      contextChunks: citations,
                      citationMap,
                    }),
                  })
                }
              }
              break
            }

            case "thinking_start": {
              const startEvent = {
                type: "thinking_start",
                contentIndex: event.contentIndex,
                timestamp: Date.now(),
              }
              agentThinkingEvents.push(JSON.stringify(startEvent))
              await stream.writeSSE({
                event: ChatSSEvents.Reasoning,
                data: JSON.stringify(startEvent),
              })
              break
            }

            case "thinking_delta": {
              thinkingBatch += event.delta || ""
              const now = Date.now()
              if (
                thinkingBatch.length >= THINKING_BATCH_SIZE ||
                now - lastThinkingFlushTime >= THINKING_BATCH_INTERVAL_MS
              ) {
                await flushThinkingBatch(event.contentIndex)
              }
              break
            }

            case "thinking_end": {
              const endEvent = {
                type: "thinking_end",
                contentIndex: event.contentIndex,
                contentSignature: event.contentSignature,
                timestamp: Date.now(),
              }
              agentThinkingEvents.push(JSON.stringify(endEvent))
              await stream.writeSSE({
                event: ChatSSEvents.Reasoning,
                data: JSON.stringify(endEvent),
              })
              break
            }

            case "message_end": {
              const { message: msg } = event
              if (msg.role === "assistant" && msg.stopReason) {
                lastStopReason = msg.stopReason
              }
              if (msg.role === "assistant" && msg.stopReason === "error") {
                // Check if content is empty (common for model/configuration errors)
                const hasEmptyContent =
                  !msg.content ||
                  (Array.isArray(msg.content) && msg.content.length === 0) ||
                  (typeof msg.content === "string" && msg.content.trim() === "")

                let errorMessage =
                  "An error occurred while processing your request."

                if (hasEmptyContent) {
                  errorMessage = `Model '${modelId}' is not available or not properly configured. Please try a different model or contact your administrator.`
                  Logger.error(
                    { email, modelId, chatId: chatRecord.externalId },
                    "LLM error with empty content - likely model configuration issue",
                  )
                }

                await stream.writeSSE({
                  event: ChatSSEvents.Error,
                  data: JSON.stringify({
                    error: "llm_error",
                    message: errorMessage,
                  }),
                })
              }
              if (
                msg.role === "assistant" &&
                msg.content &&
                !(answer ?? "").trim()
              ) {
                const content = msg.content as
                  | string
                  | Array<{ type?: string; text?: string } | string>

                const fullContent =
                  typeof content === "string"
                    ? content.trim()
                    : Array.isArray(content)
                      ? content
                          .map((b) => {
                            if (typeof b === "string") return b
                            if (b?.type === "output_text") return b.text ?? ""
                            return b?.text ?? ""
                          })
                          .join("\n\n")
                          .trim()
                      : ""

                if (fullContent) {
                  answer = fullContent

                  await stream.writeSSE({
                    event: ChatSSEvents.ResponseUpdate,
                    data: answer,
                  })
                }
              }
              break
            }
            default:
              break
          }
        }

        await flushThinkingBatch(0)

        Logger.info("KB agentic RAG completed")
        if (
          lastStopReason &&
          lastStopReason !== "stop" &&
          lastStopReason !== "toolUse"
        ) {
          await emitReasoningEvent(
            emitReasoningStep,
            ReasoningSteps.agentStopped(lastStopReason),
          )
        } else {
          await emitReasoningEvent(
            emitReasoningStep,
            ReasoningSteps.synthesisCompleted(),
          )
        }

        try {
          piSession.sessionManager.appendCustomEntry(
            CITATION_ENTRY_TYPE,
            buildCitationDelta(xyneState, currentTurn.value),
          )
        } catch (citErr) {
          Logger.error(citErr, "Failed to persist citation state")
        }

        // ── Persist assistant message ────────────────────────────────
        try {
          const persisted = await persistAssistantMessage(
            chatRecord,
            user,
            { externalId: workspace.externalId },
            modelId,
            requestStartMs,
            {
              answer,
              citations,
              citationMap,
              thinkingLog:
                thinkingLog +
                (agentThinkingEvents.length > 0
                  ? agentThinkingEvents.join("\n") + "\n"
                  : ""),
            },
          )
          assistantMessageId = persisted.assistantMessageId
          await insertChatTrace({
            workspaceId: workspace.id,
            userId: user.id,
            chatId: chatRecord.id,
            messageId: persisted.msg.id as number,
            chatExternalId: chatRecord.externalId as string,
            email: user.email,
            messageExternalId: assistantMessageId,
            traceJson: tracer.serializeToJson(),
          })
        } catch (persistErr) {
          Logger.error(persistErr, "Failed to persist message")
        }

        // ── Send final metadata ──────────────────────────────────────
        if (!stream.closed) {
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chatRecord.externalId,
              messageId: assistantMessageId || "temp-message-id",
              timeTakenMs: Date.now() - requestStartMs,
            }),
          })
          await stream.writeSSE({ event: ChatSSEvents.End, data: "" })
        }
        rootSpan.end()
      } catch (error) {
        Logger.error(error, "AgenticRAG stream error")
        if (!stream.closed) {
          try {
            await stream.writeSSE({
              event: ChatSSEvents.Error,
              data: JSON.stringify({
                error: "stream_error",
                message: getErrorMessage(error),
              }),
            })
            await stream.writeSSE({ event: ChatSSEvents.End, data: "" })
          } catch {
            /* ignore */
          }
        }
        rootSpan.end()
      } finally {
        c.req.raw.signal.removeEventListener("abort", markStop)
        const activeEntry = activeStreams.get(streamKey)
        if (activeEntry?.stream === stream) activeStreams.delete(streamKey)
        // Unregister session from sessionStore
        const piSess = agent?.getSession() as any
        const sessId =
          piSess?.sessionManager?.getSessionId?.() ??
          chatRecord?.externalId ??
          ""
        unregisterSession(sessId)
        agent?.dispose()
        clearExtensionState()
      }
    })
  } catch (error) {
    Logger.error(error, "AgenticRAG failed")
    rootSpan.end()
    throw error
  }
}
