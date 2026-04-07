/**
 * Knowledge Base Agentic RAG — Pi-Mono SDK Wrapper Implementation
 *
 * Uses the core RAG Agent SDK (`./core`) for a clean, minimal handler.
 * All pi-mono session lifecycle, event routing, and tool registration
 * is handled by `createRAGAgent()`.
 */

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"

import { SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent"

import { getModelValueFromLabel } from "@/ai/modelConfig"
import { Models } from "@/ai/types"
import {
  type ReasoningEmitter,
  ReasoningSteps,
  emitReasoningEvent,
} from "@/api/chat/reasoning-steps"
import { activeStreams } from "@/api/chat/stream"
import type { Citation } from "@/api/chat/types"
import type { MinimalAgentFragment } from "@/api/chat/types"
import {
  checkAndYieldCitationsForAgent,
  extractFileIdsFromMessage,
  isMessageWithContext,
  safeDecodeURIComponent,
} from "@/api/chat/utils"
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
import { type RAGAgent, type RAGEvent, createRAGAgent } from "./core"
import { prepareInitialAttachmentContext } from "./helpers"
import {
  clearExtensionState,
  setExtensionState,
  default as xyneExtension,
} from "./pi-mono-extension"
import {
  lsKnowledgeBaseTool,
  searchKnowledgeBaseTool,
  toDoWriteTool,
} from "./tools"
import { getDocumentOutlineTool } from "./tools/get-document-outline"
import { getPageContentTool } from "./tools/get-page-content"

const { defaultBestModel, JwtPayloadKey } = config
const Logger = getLogger(Subsystem.Chat)

function buildKBSystemPrompt(
  context: XyneAgentState,
  dateForAI: string,
): string {
  return `You are a Knowledge Base Search Assistant with autonomous agentic RAG capabilities.

<context>
  Current date: ${dateForAI}
  User: ${context.user.email}
</context>

# CORE IDENTITY
You are an autonomous research agent. You plan, search, assess your own progress, extend your plan when gaps are found, and only answer when you have sufficient evidence. You do NOT need external review — you assess completeness yourself.

# STRICT GROUNDING POLICY (MOST IMPORTANT RULE)
- You have NO internal knowledge of documents in this Knowledge Base.
- **EVERY factual claim MUST come from a retrieved fragment.** If it's not in a fragment, you do NOT know it.
- If searches return no results, state: "The available documentation does not provide information regarding [X]."
- **NEVER fabricate or guess:** numbers, durations, percentages, dates, regulation names, section numbers, or procedural details. These are the most dangerous hallucinations.
- **When in doubt, quote the fragment.** Use the exact language from the retrieved text rather than paraphrasing from memory.
- If two fragments give different numbers for the same concept, cite both and note the discrepancy — do NOT pick one from your own knowledge.
- Pre-trained knowledge may ONLY be used for: general vocabulary, grammar, logical connectives, and structuring the answer. NEVER for domain-specific facts.

# AUTONOMOUS RESEARCH LOOP

For any non-trivial query, follow this loop:

## 1. PLAN (toDoWrite)
- Call toDoWrite to decompose the query into tasks
- Every plan MUST include at least one "investigate" or "identify" task before a "synthesize" task
- The tool returns your FULL plan state — use it to track progress

## 2. DISCOVER (lsKnowledgeBase)
- Call lsKnowledgeBase to list accessible collections
- Identify relevant files/folders by name, path, or metadata

## 3. EXECUTE (searchKnowledgeBase)
- For each pending task, run targeted searches using filters.targets for specific files/folders
- Only use broad search (no filters) when no relevant files were found or the query is very general
- After each search, update your plan: call toDoWrite again marking completed tasks with results

## 4. ASSESS & EXTEND (toDoWrite again)
- After completing all initial tasks, read the plan state returned by toDoWrite
- The tool will prompt you to self-assess: does the gathered context fully address the goal?
- **If gaps remain: ADD NEW TASKS** to the plan and continue searching
- **If sufficient: proceed to write the final answer**
- Your initial plan is rarely perfect — discovering new information often reveals new questions
- There is no limit on how many times you can update the plan

## 5. ANSWER
- Only generate the final response when YOU judge all tasks are complete with sufficient evidence
- If you realize mid-answer that something is missing, stop and go back to searching

# PLAN EVOLUTION EXAMPLES

Good pattern:
1. Create plan with 3 tasks -> execute searches -> mark tasks completed
2. Call toDoWrite again -> see "All 3 tasks complete" -> realize the answer needs pricing info not yet gathered
3. Add task-4 (type: "investigate", description: "Find pricing details") -> search -> mark completed
4. Call toDoWrite again -> all 4 tasks complete -> context is sufficient -> write answer

Bad pattern:
1. Create plan with 3 tasks -> execute searches -> immediately write answer without checking completeness

# CITATION FORMAT (CRITICAL)

When tools return context fragments:
- Each document has a header: {citationDocId: N} {content...}
- Chunks are marked with bracketed indices: [0], [1], [2]

Citation rules (STRICT - NO EXCEPTIONS):
- The ONLY valid citation format is: K[citationDocId_Index]
- CORRECT examples: K[2_3], K[0_1], K[5_12]
- INCORRECT examples (NEVER USE): [Indices1,2,3], [1,2,3], K[2], K[3_4_5], Index4, [Index4_5]
- Step-by-step: Look at the document header "citationDocId: N" and chunk "[X]" -> Use K[N_X]
- Place citations immediately after claims
- Maximum 1-2 citations per sentence, max 2-3 per claim
- Only cite information that appears in the fragment

# RESPONSE GUIDELINES
1. **NO CITATION, NO CLAIM:** Every factual sentence MUST have a K[citationDocId_Index] citation. If you cannot cite it, do not state it as fact.
2. **PRE-ANSWER GROUNDING CHECK:** Before writing your answer, mentally verify: "Can I point to a specific fragment for every number, duration, percentage, and regulation I'm about to mention?" If not, search again or state the gap.
3. If you cannot find a source, state: "The available documentation does not provide information regarding [X]."
4. **QUOTE CRITICAL DETAILS:** For numbers, durations, thresholds, and regulation references, prefer quoting the exact fragment language rather than paraphrasing. This prevents subtle distortions.
5. Use well-organized markdown with bullet points, numbered lists, and sections for readability.
6. For summaries, synthesize concisely while still citing sources.

# SEARCH BEST PRACTICES
- Prefer targeted searches (with filters.targets) over broad searches
- If multiple relevant files are found via ls, target them all in one search call
- If targeted search yields insufficient results, expand to folder or collection level
- Use varied query phrasings — if one query finds nothing, try synonyms or broader terms

# HANDLING INFORMATION GAPS

When search results don't fully answer a question:
1. **Search more first.** Try different queries, broader terms, or different target files before concluding information is missing.
2. **State what you DID find** from fragments, with citations.
3. **Explicitly state what is NOT covered:** "The retrieved documents do not specify [X]."
4. **Inference is allowed ONLY for "why" questions** and ONLY when:
   - You have FIRST stated all relevant facts from fragments with citations
   - You clearly label the inference: "Based on the provisions above, this likely reflects..." or "This suggests..."
   - The inference does NOT introduce any new numbers, durations, dates, percentages, regulation names, or procedural details not found in fragments
   - The inference is purely logical reasoning over cited facts
5. **NEVER fill a factual gap with your own knowledge.** If the TFT duration isn't in the fragments, do NOT guess "6 months" or "10 days" — say the specific duration is not stated in the retrieved documents.

# WHEN TO USE toDoWrite

**Use for:**
- Queries requiring multiple searches or combining information from different sources
- Multi-part questions, comparisons, or complex investigations
- Any time information seems incomplete or contradictory

**Skip for:**
- Simple greetings or capability questions (respond directly)
- Single-fact lookups that need only one search

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

    return {
      chat,
      userMessage,
      conversationHistory: allMessages,
      isNewChat: false,
    }
  })
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

export async function KBAgenticRAG(c: Context): Promise<Response> {
  const tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("KBAgenticRAG")
  const { sub: email, workspaceId } = c.get(JwtPayloadKey)

  try {
    Logger.info("KBAgenticRAG starting")
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

    const bootstrap = await bootstrapChat({
      chatId,
      email,
      user: { id: user.id, email: user.email },
      workspace,
      message,
      modelId,
    })
    const { chat: chatRecord, conversationHistory, isNewChat } = bootstrap

    // ── Attachments ────────────────────────────────────────────────────
    const isMsgWithContext = isMessageWithContext(message)
    const extractedInfo = isMsgWithContext
      ? await extractFileIdsFromMessage(message, email)
      : { totalValidFileIdsFromLinkCount: 0, fileIds: [], threadIds: [] }

    // Separate document file IDs and image file IDs
    const documentFileIds = (extractedInfo?.fileIds ?? []).concat(
      parseAttachmentMetadata(c)
        .filter((m) => !m.isImage)
        .map((m) => m.fileId),
    )
    const imageAttachmentFileIds = parseAttachmentMetadata(c)
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
          user.id,
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

        // Load images for the agent
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

        const kbTools = [
          toDoWriteTool,
          lsKnowledgeBaseTool,
          searchKnowledgeBaseTool,
          getDocumentOutlineTool,
          getPageContentTool,
        ]
        xyneState.enabledTools = new Set(kbTools.map((t) => t.name))
        const systemPrompt = buildKBSystemPrompt(xyneState, dateForAI)

        const baseUrl = config.LiteLLMBaseUrl?.endsWith("/v1")
          ? config.LiteLLMBaseUrl
          : `${config.LiteLLMBaseUrl}/v1`

        // ── Create RAG agent via core SDK ────────────────────────────
        agent = await createRAGAgent<XyneAgentState>({
          model: modelId,
          baseUrl,
          apiKey: "sk-BPXuhdygZKbV3z2-qbz0rg",
          tools: kbTools,
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

        // ── Send start events ────────────────────────────────────────
        await stream.writeSSE({ event: ChatSSEvents.Start, data: "" })
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({ chatId: chatRecord.externalId }),
        })

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
        Logger.error(error, "KBAgenticRAG stream error")
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
    Logger.error(error, "KBAgenticRAG failed")
    rootSpan.end()
    throw error
  }
}
