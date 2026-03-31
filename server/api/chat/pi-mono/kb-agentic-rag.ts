/**
 * Knowledge Base Agentic RAG - Pi-Mono Native Implementation
 *
 * Simple agentic RAG focused on knowledge base search using pi-mono.
 * - Two tools: lsKnowledgeBase, searchKnowledgeBase
 * - Streaming support
 * - Citation support (K[docId_chunkIndex] format)
 * - No attachments, no MCP, no delegation
 */

import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"

import type { Message } from "@mariozechner/pi-ai"
// Pi-mono imports
import {
  AuthStorage,
  DefaultResourceLoader,
  type ExtensionEvent,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  type TurnStartEvent,
  createAgentSession,
} from "@mariozechner/pi-coding-agent"

import { getModelValueFromLabel } from "@/ai/modelConfig"
import { Models } from "@/ai/types"
import {
  type ReasoningEmitter,
  ReasoningSteps,
  emitReasoningEvent,
} from "@/api/chat/reasoning-steps"
import { activeStreams } from "@/api/chat/stream"
import type { Citation } from "@/api/chat/types"
import { safeDecodeURIComponent } from "@/api/chat/utils"
import { checkAndYieldCitationsForAgent } from "@/api/chat/utils"
// Xyne imports
import config from "@/config"
import { insertChat, updateChatByExternalIdWithAuth } from "@/db/chat"
import { insertChatTrace } from "@/db/chatTrace"
import { db } from "@/db/client"
import { getChatMessagesWithAuth, insertMessage } from "@/db/message"
import {
  ChatType,
  type InsertChat,
  type InsertMessage,
  type SelectChat,
  type SelectMessage,
} from "@/db/schema"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getLogger, getLoggerWithChild } from "@/logger"
import { maybeCompactAndIndex } from "@/services/chatMemoryIndexer"
import { ChatSSEvents, type ReasoningEventPayload } from "@/shared/types"
import { getTracer } from "@/tracer"
import { Subsystem } from "@/types"
import { MessageRole } from "@/types"
import { getErrorMessage } from "@/utils"
import { getDateForAI } from "@/utils/index"

import {
  type XyneAgentState,
  createInitialXyneState,
  registerSession,
  unregisterSession,
} from "./adapter"
import {
  clearExtensionState,
  setExtensionState,
  default as xyneExtension,
} from "./pi-mono-extension"
// KB tools
import {
  lsKnowledgeBaseTool,
  searchKnowledgeBaseTool,
  toDoWriteTool,
} from "./tools"

const { defaultBestModel, JwtPayloadKey } = config
const Logger = getLogger(Subsystem.Chat)
const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

// ============================================================================
// SYSTEM PROMPT FOR KB AGENTIC RAG
// ============================================================================

function buildKBSystemPrompt(
  context: XyneAgentState,
  dateForAI: string,
): string {
  return `You are a Knowledge Base Search Assistant with agentic RAG capabilities.

Current date: ${dateForAI}

<context>
User: ${context.user.email}
Workspace: ${context.user.workspaceId}
</context>

# IMPORTANT: DO NOT ANNOUNCE TOOL USAGE

- Do NOT say "I'll search...", "Let me look up...", or similar phrases before calling tools
- Do NOT explain your thought process or plans in the response
- Call tools silently and directly provide the final answer
- Start your response with the actual answer, not with what you plan to do

# CRITICAL: COMPLETE YOUR RESEARCH BEFORE ANSWERING

1. **Do NOT provide partial answers** - If you need more information, continue searching with additional queries
2. **Do NOT say "I need to look for more information"** - Just make another tool call silently
3. **Only provide the final answer when you have gathered sufficient information** from the knowledge base
4. **Continue searching** with different queries or broader terms if initial searches don't yield enough relevant information
5. **You can make multiple tool calls** in sequence to gather comprehensive information before answering

# CITATION FORMAT (CRITICAL)

When tools return context fragments:
- Each document has a header: index {citationDocId: N} {content...}
- Chunks are marked with bracketed indices: [0], [1], [2]

Citation rules (STRICT - NO EXCEPTIONS):
- The ONLY valid citation format is: K[citationDocId_chunkIndex]
- CORRECT examples: K[2_3], K[0_1], K[5_12]
- INCORRECT examples (NEVER USE): [Indices1,2,3], [1,2,3], K[2], K[3_4_5], Index4, [Index4_5], [doc1_chunk2], Document 1, Chunk 2
- Step-by-step: Look at the document header "index {citationDocId: N}" and chunk "[X]" → Use K[N_X]
- Place citations immediately after claims
- Maximum 1-2 citations per sentence
- STRICT RULE: Never use long citation lists like [Indices1,2,3,4,5,6,7,8...]. Maximum 2-3 citations per claim.
- If multiple sources support the same point, pick the most relevant 1-2 and ignore the rest
- Only cite information that appears in the fragment
- ANY citation not in K[X_Y] format will be rejected

# RESPONSE GUIDELINES

1. Lead with the answer, then provide supporting details
2. Every factual statement must have a citation
3. If information is not in the fragments, say so clearly
4. Keep responses concise and well-organized
5. Use markdown formatting for readability

# PLANNING WITH TODOWRITE

For complex queries with multiple aspects, contradictions, or requiring investigation:
1. **ALWAYS call toDoWrite FIRST** before any search tools
2. Break down the query into sub-tasks with specific types:
   - understand: Define key terms
   - identify/investigate: Find specific rules/conditions
   - analyze: Find relationships/patterns
   - reconcile: Resolve contradictions
   - synthesize: Compose final answer
3. Include 1-3 searchQueries per task
4. Set dependencies using dependsOn
5. Update the plan iteratively as you discover information

For simple queries, you may skip toDoWrite and search directly.

# CONVERSATIONAL QUERIES

For greetings or questions about your capabilities:
- Respond naturally without using tools
- Explain that you can search the knowledge base
`
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Ensure chat exists and persist user message
 */
async function bootstrapChat(params: {
  chatId?: string
  email: string
  user: { id: number; email: string }
  workspace: { id: number; externalId: string }
  message: string
  modelId?: string
}): Promise<{
  chat: SelectChat
  userMessage: SelectMessage
  conversationHistory: SelectMessage[]
  isNewChat: boolean
}> {
  const workspaceId = Number(params.workspace.id)
  const workspaceExternalId = String(params.workspace.externalId)
  const userId = Number(params.user.id)
  const userEmail = String(params.user.email)

  return await db.transaction(async (tx) => {
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
      const userMessage = await insertMessage(tx, messageInsert)

      return { chat, userMessage, conversationHistory: [], isNewChat: true }
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
    const conversationHistory = await maybeCompactAndIndex({
      trx: tx,
      chatId: params.chatId,
      email: params.email,
      workspaceId: workspaceExternalId,
      allMessages,
      chatIdInternal: chat.id,
      userId,
      modelId: (params.modelId as Models) || defaultBestModel,
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
      modelId: (params.modelId as Models) || defaultBestModel,
      fileIds: [],
    } as unknown as Omit<InsertMessage, "externalId">
    const userMessage = await insertMessage(tx, messageInsert)

    return { chat, userMessage, conversationHistory, isNewChat: false }
  })
}

/**
 * Convert Xyne conversation history to pi-mono Message format
 * This allows the agent to have context from previous messages
 */
function convertHistoryToPiMonoMessages(history: SelectMessage[]): Message[] {
  return history
    .filter(
      (msg) =>
        msg.messageRole === MessageRole.User ||
        msg.messageRole === MessageRole.Assistant,
    )
    .filter((msg) => msg.message && msg.message.trim().length > 0)
    .map((msg) => ({
      role: msg.messageRole === MessageRole.User ? "user" : "assistant",
      content: [{ type: "text" as const, text: msg.message }],
    })) as Message[]
}

/**
 * Build LiteLLM model configuration
 */
function buildModel(modelId: string, baseUrl: string) {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions" as const,
    provider: "litellm",
    baseUrl,
    reasoning: false,
    input: ["text"] as "text"[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    compat: {
      supportsStore: false,
      supportsStreaming: true,
      supportsToolStreaming: true,
    },
  }
}

/**
 * Persist assistant message
 */
async function persistAssistantMessage(
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

// ============================================================================
// MAIN KB AGENTIC RAG HANDLER
// ============================================================================

/**
 * Knowledge Base Agentic RAG Handler
 *
 * Simple agentic RAG focused on knowledge base search using pi-mono.
 */
export async function KBAgenticRAG(c: Context): Promise<Response> {
  const tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("KBAgenticRAG")

  const { sub: email, workspaceId } = c.get(JwtPayloadKey)

  try {
    loggerWithChild({ email }).info("KBAgenticRAG starting")
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    // Parse request
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

    if (!message) {
      throw new HTTPException(400, { message: "Message is required" })
    }
    console.log("selectedModelConfig:", selectedModelConfig)
    message = safeDecodeURIComponent(message)
    rootSpan.setAttribute("message", message)

    // Parse model configuration
    let modelId: string = config.defaultBestModel
    if (selectedModelConfig) {
      try {
        const modelConfig = JSON.parse(selectedModelConfig)
        const parsedModelId = modelConfig.model
        if (parsedModelId) {
          const converted = getModelValueFromLabel(parsedModelId)
          modelId = converted || parsedModelId
          loggerWithChild({ email }).info(
            { original: parsedModelId, converted: modelId },
            "Model ID conversion",
          )
        }
      } catch {
        loggerWithChild({ email }).warn("Failed to parse model config")
      }
    }

    // Get user and workspace
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

    // Bootstrap chat
    let chatRecord: SelectChat
    let conversationHistory: SelectMessage[] = []
    let isNewChat = true

    try {
      const bootstrap = await bootstrapChat({
        chatId,
        email,
        user: { id: user.id, email: user.email },
        workspace: { id: workspace.id, externalId: workspace.externalId },
        message,
        modelId,
      })
      chatRecord = bootstrap.chat
      conversationHistory = bootstrap.conversationHistory
      isNewChat = bootstrap.isNewChat

      loggerWithChild({ email }).info(
        {
          chatId: chatRecord.externalId,
          isNewChat,
          historyCount: conversationHistory.length,
        },
        "Chat bootstrapped",
      )
    } catch (error) {
      loggerWithChild({ email }).error(error, "Failed to bootstrap chat")
      throw new HTTPException(500, { message: "Failed to initialize chat" })
    }

    rootSpan.setAttribute("chatId", String(chatRecord.externalId))

    const userTimezone = user.timeZone || "UTC"
    const dateForAI = getDateForAI({ userTimeZone: userTimezone })
    const title = ""
    // Return streaming response
    return streamSSE(c, async (stream) => {
      const requestStartMs = Date.now()
      const stopController = new AbortController()
      const streamKey = String(chatRecord.externalId)
      let xyneStateRef: XyneAgentState | null = null
      let currentTurn = { value: 0 }
      let unsubscribe: (() => void) | undefined
      if (!chatId) {
        await stream.writeSSE({
          data: title,
          event: ChatSSEvents.ChatTitleUpdate,
        })
      }
      const markStop = () => {
        if (xyneStateRef) {
          xyneStateRef.stopRequested = true
        }
        stopController.abort()
      }

      c.req.raw.signal.addEventListener("abort", markStop)
      activeStreams.set(streamKey, { stream, stopController })

      try {
        let thinkingLog = ""

        // Reasoning event emitter
        const emitReasoningStep: ReasoningEmitter = async (
          payload: ReasoningEventPayload,
        ) => {
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

        // Initialize Xyne state
        const xyneState = createInitialXyneState(
          email,
          String(workspace.externalId),
          String(user.id),
          user.id,
          String(chatRecord.externalId),
          message,
          new Date().toISOString(),
        )
        xyneStateRef = xyneState
        xyneState.modelId = modelId
        xyneState.delegationEnabled = false
        xyneState.sessionId = String(chatRecord.externalId)
        console.log("Initialized Xyne state:", chatRecord.externalId)
        // Send start event
        await stream.writeSSE({
          event: ChatSSEvents.Start,
          data: "",
        })

        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({ chatId: chatRecord.externalId }),
        })

        // Configure pi-mono
        const baseUrl = config.LiteLLMBaseUrl?.endsWith("/v1")
          ? config.LiteLLMBaseUrl
          : `${config.LiteLLMBaseUrl}/v1`

        // KB-only tools
        const kbTools: ToolDefinition<any, any, any>[] = [
          toDoWriteTool,
          lsKnowledgeBaseTool,
          searchKnowledgeBaseTool,
        ]

        // Set enabled tools
        xyneState.enabledTools = new Set(kbTools.map((t) => t.name))

        // Build system prompt
        const systemPrompt = buildKBSystemPrompt(xyneState, dateForAI)

        // Create pi-mono session
        const authStorage = AuthStorage.create()
        if (config.LiteLLMApiKey) {
          authStorage.set("litellm", {
            type: "api_key",
            key: "sk-BPXuhdygZKbV3z2-qbz0rg",
          })
        }

        // Set up extension state for tool interception
        setExtensionState({
          xyneState,
          currentTurn,
          agenticModelId: modelId,
          message,
          email,
          emitReasoningStep,
        })

        const resourceLoader = new DefaultResourceLoader({
          systemPrompt,
          extensionFactories: [xyneExtension],
        })
        await resourceLoader.reload()

        const model = buildModel(modelId, baseUrl)
        const { session: piSession } = await createAgentSession({
          model,
          customTools: kbTools,
          tools: [],
          resourceLoader,
          authStorage,
          sessionManager: SessionManager.inMemory(),
          settingsManager: SettingsManager.inMemory({
            // Disable compaction - we restore conversation history via replaceMessages()
            // which doesn't include token usage metadata required by compaction
            compaction: { enabled: false },
            retry: { enabled: true, maxRetries: 2 },
          }),
        })

        piSession.agent.setSystemPrompt(systemPrompt)
        // Restore conversation history if this is a continuing chat
        if (!isNewChat && conversationHistory.length > 0) {
          const piMonoMessages =
            convertHistoryToPiMonoMessages(conversationHistory)
          if (piMonoMessages.length > 0) {
            piSession.agent.replaceMessages(piMonoMessages)
            loggerWithChild({ email }).info(
              { messageCount: piMonoMessages.length },
              "Restored conversation history to pi-mono agent",
            )
          }
        }

        const sessionId = String(chatRecord.externalId)
        const piMonoSessionId = piSession.sessionManager.getSessionId()

        registerSession(
          sessionId,
          xyneState,
          async () => {},
          undefined,
          piMonoSessionId,
        )

        // Response tracking
        let answer = ""
        const citations: Citation[] = []
        const citationsByDocId: Map<string, number> = new Map()
        const citationMap: Record<number, number> = {}
        const yieldedCitations = new Set<number>()
        const yieldedImageCitations = new Map<number, Set<number>>()
        let assistantMessageId: string | null = null

        // Agent completion tracking
        let agentCompleted = false
        let agentCompletionResolve: (() => void) | null = null
        const agentCompletionPromise = new Promise<void>((resolve) => {
          agentCompletionResolve = resolve
        })

        // Subscribe to events
        unsubscribe = piSession.subscribe(async (event) => {
          try {
            switch (event.type) {
              case "turn_start": {
                currentTurn.value++
                xyneState.turnCount = currentTurn.value
                break
              }

              case "tool_execution_start": {
                const toolName = event.toolName
                const toolCallId = event.toolCallId
                console.log(
                  `[KBAgenticRAG] Tool execution start: ${toolName}`,
                  { toolCallId },
                )
                // Extract query if available
                const query = event.args?.query
                await emitReasoningEvent(emitReasoningStep, {
                  ...ReasoningSteps.toolSelected(toolName, query),
                })
                break
              }

              case "tool_execution_end": {
                const toolName = event.toolName
                console.log(`[KBAgenticRAG] Tool execution end: ${toolName}`, {
                  isError: event.isError,
                })
                if (toolName === "searchKnowledgeBase" && !event.isError) {
                  const details = event.result.details
                  const query = details?.query || "unknown query"
                  const fragments = details?.fragments || []
                  const topFragments = fragments.slice(0, 3).map((f: any) => ({
                    title: f.source?.title || f.source?.fileName || "Untitled",
                    source: f.source?.fileName || f.source?.docId,
                  }))
                  await emitReasoningEvent(
                    emitReasoningStep,
                    ReasoningSteps.searchCompleted(
                      query,
                      fragments.length,
                      topFragments,
                      toolName,
                    ),
                  )
                } else if (toolName === "toDoWrite" && !event.isError) {
                  // Emit plan created event with full plan details
                  const details = event.result.details
                  const plan = details?.plan
                  if (plan) {
                    await emitReasoningEvent(
                      emitReasoningStep,
                      ReasoningSteps.planCreated(plan.goal, plan.subTasks),
                    )
                  }
                } else {
                  // For other tools, use standard completion message
                  await emitReasoningEvent(
                    emitReasoningStep,
                    ReasoningSteps.toolCompleted(toolName, event.isError),
                  )
                }
                break
              }

              case "message_update": {
                const assistantEvent = event.assistantMessageEvent
                if (assistantEvent?.type === "text_delta") {
                  const delta = assistantEvent.delta || ""
                  xyneState.thinkingLog = (xyneState.thinkingLog || "") + delta
                  if (delta.trim()) {
                    answer += delta
                    await stream.writeSSE({
                      event: ChatSSEvents.ResponseUpdate,
                      data: delta,
                    })
                  }

                  for await (const citationEvent of checkAndYieldCitationsForAgent(
                    answer,
                    yieldedCitations,
                    xyneState.allFragments,
                    yieldedImageCitations,
                    email,
                    xyneState.citationDocIdMapping,
                  )) {
                    if (stream.closed) break
                    if (citationEvent.citation) {
                      const { index, item } = citationEvent.citation
                      const docId = item.docId || String(index)

                      if (citationsByDocId.has(docId)) {
                        citationMap[index] = citationsByDocId.get(docId)!
                      } else {
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
                  }
                }
                break
              }

              case "message_end": {
                // Check if LLM call failed
                const msg = (event as any).message
                if (msg?.role === "assistant" && msg?.stopReason === "error") {
                  await stream.writeSSE({
                    event: ChatSSEvents.Error,
                    data: JSON.stringify({
                      error: "llm_error",
                      message:
                        "Failed to generate response from language model. The model may be unavailable or returned an error.",
                    }),
                  })
                }
                // Extract full message content if no text_delta events were streamed
                // This can happen when the model doesn't stream or streaming is disabled
                if (
                  msg?.role === "assistant" &&
                  msg.content &&
                  typeof msg.content === "string" &&
                  (answer as string).trim().length === 0
                ) {
                  const fullContent = msg.content.trim()
                  if (fullContent) {
                    answer = fullContent
                    await stream.writeSSE({
                      event: ChatSSEvents.ResponseUpdate,
                      data: fullContent,
                    })
                    loggerWithChild({ email }).info(
                      { contentLength: fullContent.length },
                      "Extracted full message content from message_end event (no streaming)",
                    )
                  }
                }
                break
              }

              case "agent_end": {
                agentCompleted = true
                if (agentCompletionResolve) agentCompletionResolve()
                break
              }
            }
          } catch (error) {
            Logger.error(error, "Event handler error")
          }
        })

        // Start the conversation
        loggerWithChild({ email }).info(
          { message: message.substring(0, 100), modelId, baseUrl },
          "Starting KB agentic RAG prompt...",
        )

        piSession.prompt(message).catch((err: any) => {
          console.error(`[KBAgenticRAG] Prompt error:`, err)
          if (!agentCompleted && agentCompletionResolve) {
            agentCompletionResolve()
          }
        })

        // Wait for completion (5 minute timeout)
        const completionTimeoutMs = 5 * 60 * 1000
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
          loggerWithChild({ email }).info("KB agentic RAG completed")
        } catch (timeoutErr) {
          loggerWithChild({ email }).error(
            timeoutErr,
            "Agent completion timeout",
          )
        }

        // Emit completion
        await emitReasoningEvent(
          emitReasoningStep,
          ReasoningSteps.synthesisCompleted(),
        )

        // Persist message
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

          // Persist trace
          const traceJson = tracer.serializeToJson()
          await insertChatTrace({
            workspaceId: workspace.id,
            userId: user.id,
            chatId: chatRecord.id,
            messageId: persisted.msg.id as number,
            chatExternalId: chatRecord.externalId as string,
            email: user.email,
            messageExternalId: assistantMessageId,
            traceJson,
          })
        } catch (persistErr) {
          loggerWithChild({ email }).error(
            persistErr,
            "Failed to persist message",
          )
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
        loggerWithChild({ email }).error(error, "KBAgenticRAG stream error")
        const errMsg = getErrorMessage(error)

        if (!stream.closed) {
          try {
            await stream.writeSSE({
              event: ChatSSEvents.Error,
              data: JSON.stringify({ error: "stream_error", message: errMsg }),
            })
            await stream.writeSSE({
              event: ChatSSEvents.End,
              data: "",
            })
          } catch {
            // Ignore write errors
          }
        }
        rootSpan.end()
      } finally {
        stopController.signal.removeEventListener("abort", markStop)
        const activeEntry = activeStreams.get(streamKey)
        if (activeEntry?.stream === stream) {
          activeStreams.delete(streamKey)
        }
        unregisterSession(chatRecord?.externalId ?? "")
        clearExtensionState()
        unsubscribe?.()
      }
    })
  } catch (error) {
    loggerWithChild({ email }).error(error, "KBAgenticRAG failed")
    rootSpan.end()
    throw error
  }
}
