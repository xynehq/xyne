import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"

import { SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent"

import { getModelValueFromLabel } from "@/ai/modelConfig"
import {
  type ReasoningEmitter,
  ReasoningSteps,
  emitReasoningEvent,
} from "@/api/chat/reasoning-steps"
import { activeStreams } from "@/api/chat/stream"
import type { Citation } from "@/api/chat/types"
import {
  checkAndYieldCitationsForAgent,
  extractFileIdsFromMessage,
  isMessageWithContext,
  safeDecodeURIComponent,
} from "@/api/chat/utils"
import config from "@/config"
import { insertChatTrace } from "@/db/chatTrace"
import { db } from "@/db/client"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getLogger, getLoggerWithChild } from "@/logger"
import { expandSheetIds } from "@/search/utils"
import { ChatSSEvents, type ReasoningEventPayload } from "@/shared/types"
import { getTracer } from "@/tracer"
import { Subsystem, type UserMetadataType } from "@/types"
import { MessageRole } from "@/types"
import { getErrorMessage } from "@/utils"
import { getDateForAI } from "@/utils/index"
import { parseAttachmentMetadata } from "@/utils/parseAttachment"
import { Apps, AttachmentEntity } from "@xyne/vespa-ts/types"

import {
  type XyneAgentState,
  createInitialXyneState,
  registerSession,
  unregisterSession,
} from "./adapter"
import { processAttachments, getImagesForAgent } from "./attachments"
import {
  buildCitationSnapshot,
  restoreCitationState,
  CITATION_ENTRY_TYPE,
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
    }: {
      message: string
      chatId?: string
      selectedModelConfig?: string
    } = body

    if (!message)
      throw new HTTPException(400, { message: "Message is required" })
    message = safeDecodeURIComponent(message)
    rootSpan.setAttribute("message", message)

    let modelId: string = config.defaultBestModel
    if (selectedModelConfig) {
      try {
        const parsed = JSON.parse(selectedModelConfig)
        if (parsed.model) {
          modelId = getModelValueFromLabel(parsed.model) || parsed.model
        }
      } catch {
        /* ignore */
      }
    }

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
    })
    const { chat: chatRecord, attachmentError, userMessage } = bootstrap

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

        // ── Create RAG agent via core SDK ────────────────────────────
        agent = await createRAGAgent<XyneAgentState>({
          model: modelId,
          baseUrl,
          apiKey: "sk-BPXuhdygZKbV3z2-qbz0rg",
          tools: availableTools,
          systemPrompt,
          sessionManager: SessionManager.open(sessionFilePath),
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: true },
            retry: { enabled: true, maxRetries: 2 },
          }),
          extensions: [xyneExtension],
          state: xyneState,
          timeoutMs: 5 * 60 * 1000,
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

        Logger.info(
          { message: message.substring(0, 100), modelId, baseUrl },
          "Starting KB agentic RAG via core SDK...",
        )
        // ── Consume event stream ─────────────────────────────────────
        for await (const event of agent.run(message, { images })) {
          if (stream.closed) break

          switch (event.type) {
            case "turn_start":
              currentTurn.value = event.turnIndex
              xyneState.turnCount = event.turnIndex
              break
            case "text_delta": {
              if (!event.delta.trim()) break
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

            case "message_end": {
              const { message: msg } = event
              if (msg.role === "assistant" && msg.stopReason === "error") {
                await stream.writeSSE({
                  event: ChatSSEvents.Error,
                  data: JSON.stringify({
                    error: "llm_error",
                    message: "LLM error",
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
                          .join(" ")
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
            case "raw":
              break
            default:
              break
          }
        }

        Logger.info("KB agentic RAG completed")
        await emitReasoningEvent(
          emitReasoningStep,
          ReasoningSteps.synthesisCompleted(),
        )

        // Persist citation state for future turns
        try {
          piSession.sessionManager.appendCustomEntry(
            CITATION_ENTRY_TYPE,
            buildCitationSnapshot(xyneState),
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
            { answer, citations, citationMap, thinkingLog },
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
