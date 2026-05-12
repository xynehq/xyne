import { type Context } from "hono"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"
import { z } from "zod"
import type {
  Agent as JAFAgent,
  Message as JAFMessage,
  RunConfig as JAFRunConfig,
  RunState as JAFRunState,
  Tool,
} from "@juspay-xyne-jaf/jaf"
import {
  ToolResponse,
  ToolErrorCodes,
  runStream,
  generateRunId,
  generateTraceId,
  getTextContent,
} from "@juspay-xyne-jaf/jaf"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { makeXyneGenericJAFProvider } from "@/api/chat/jaf-generic-provider"
import { buildVisibilityFilter } from "@/api/provider/search"

const Logger = getLogger(Subsystem.Server)

// SDK SSE helpers — the SDK parser reads only the `data:` field and JSON.parses it.
// Each event must be a JSON object with a `type` discriminator matching ChatStreamEvent.
function sseEvent(evt: Record<string, unknown>): { data: string } {
  return { data: JSON.stringify(evt) }
}

// ---------------------------------------------------------------------------
// In-memory session store for multi-turn chat
// ---------------------------------------------------------------------------

type ProviderAgentContext = {
  isAuthenticated: boolean
  accessTags: string[]
}

const SESSION_TTL_MS = 30 * 60 * 1000 // 30 minutes

const sessionStore = new Map<
  string,
  { messages: JAFMessage[]; lastAccess: number }
>()

function getSessionMessages(sessionId: string): JAFMessage[] {
  const entry = sessionStore.get(sessionId)
  if (!entry) return []
  entry.lastAccess = Date.now()
  return entry.messages
}

function saveSessionMessages(
  sessionId: string,
  messages: JAFMessage[],
): void {
  sessionStore.set(sessionId, { messages, lastAccess: Date.now() })
}

// Periodic cleanup of expired sessions
setInterval(() => {
  const now = Date.now()
  for (const [id, entry] of sessionStore) {
    if (now - entry.lastAccess > SESSION_TTL_MS) sessionStore.delete(id)
  }
}, 10 * 60 * 1000)

// ---------------------------------------------------------------------------
// Vespa search helper (shared by the tool)
// ---------------------------------------------------------------------------

async function searchWithAccessTags(
  query: string,
  isAuthenticated: boolean,
  accessTags: string[],
  hits: number = 5,
): Promise<
  Array<{ docId: string; title: string; content: string; sourceUrl?: string }>
> {
  const visibilityFilter = buildVisibilityFilter(isAuthenticated, accessTags)
  const yql = `select * from kb_items where userInput(@query) AND (${visibilityFilter})`

  const vespaQuery = {
    yql,
    query,
    hits,
    offset: 0,
    "ranking.profile": "default_ai",
    "ranking.features.query(alpha)": 0.5,
    "input.query(e)": `embed(${query})`,
    "presentation.summary": "default",
  }

  const response = await fetch(
    `${config.vespaEndpoint.queryEndpoint}/search/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(vespaQuery),
    },
  )

  if (!response.ok) {
    Logger.error(
      { status: response.status },
      "Vespa search failed in provider chat",
    )
    return []
  }

  const vespaResult = (await response.json()) as {
    root?: {
      children?: Array<{
        fields?: Record<string, unknown>
      }>
    }
  }

  return (
    vespaResult.root?.children?.map((hit) => ({
      docId: (hit.fields?.docId as string) ?? "",
      title: (hit.fields?.fileName as string) ?? "",
      content: (hit.fields?.chunks_summary as string[])?.join("\n") ?? "",
      sourceUrl: (hit.fields?.storagePath as string) ?? undefined,
    })) ?? []
  )
}

// ---------------------------------------------------------------------------
// JAF search tool
// ---------------------------------------------------------------------------

const searchDocumentsSchema = z.object({
  query: z
    .string()
    .describe("The search query to recall relevant information"),
})

type SearchDocumentsParams = z.infer<typeof searchDocumentsSchema>

const searchDocumentsTool: Tool<
  SearchDocumentsParams,
  ProviderAgentContext
> = {
  schema: {
    name: "searchDocuments",
    description:
      "Recall internal information relevant to the query. Use this to look up facts, procedures, policies, or context before responding.",
    parameters: searchDocumentsSchema as any,
  },
  async execute(
    params: SearchDocumentsParams,
    context: ProviderAgentContext,
  ) {
    try {
      const results = await searchWithAccessTags(
        params.query,
        context.isAuthenticated,
        context.accessTags,
        5,
      )
      if (results.length === 0) {
        return ToolResponse.success({
          documents: [],
          message: "No documents found for this query.",
        })
      }
      return ToolResponse.success({
        documents: results.map((r) => ({
          docId: r.docId,
          title: r.title,
          content: r.content,
          sourceUrl: r.sourceUrl,
        })),
      })
    } catch (error) {
      return ToolResponse.error(
        ToolErrorCodes.EXECUTION_FAILED,
        `Search failed: ${error}`,
      )
    }
  },
}

// ---------------------------------------------------------------------------
// Shared JAF agent runner — maps TraceEvents → SSE
// ---------------------------------------------------------------------------

async function runProviderAgent(
  stream: SSEStreamingApi,
  agentName: string,
  instructions: string,
  userMessage: string,
  isAuthenticated: boolean,
  accessTags: string[],
  sessionId: string,
): Promise<void> {
  const agent: JAFAgent<ProviderAgentContext, string> = {
    name: agentName,
    instructions: () => instructions,
    tools: [searchDocumentsTool],
    modelConfig: { name: config.defaultFastModel },
  }

  const agentRegistry = new Map([[agent.name, agent]])
  const modelProvider = makeXyneGenericJAFProvider<ProviderAgentContext>()

  // Load previous messages for multi-turn, append new user message
  const previousMessages = getSessionMessages(sessionId)
  const allMessages: JAFMessage[] = [
    ...previousMessages,
    { role: "user" as const, content: [{ type: "text" as const, text: userMessage }] },
  ]

  const runState: JAFRunState<ProviderAgentContext> = {
    runId: generateRunId(),
    traceId: generateTraceId(),
    messages: allMessages,
    currentAgentName: agent.name,
    context: { isAuthenticated, accessTags },
    turnCount: 0,
  }

  const runCfg: JAFRunConfig<ProviderAgentContext> = {
    agentRegistry,
    modelProvider,
    maxTurns: 6,
  }

  let assistantText = ""
  let emittedTextLength = 0 // track how much text we've already sent

  for await (const evt of runStream<ProviderAgentContext, string>(
    runState,
    runCfg,
  )) {
    if (stream.closed) break

    switch (evt.type) {
      case "assistant_message": {
        const text = getTextContent(evt.data.message.content) || ""
        const hasToolCalls =
          Array.isArray(evt.data.message?.tool_calls) &&
          (evt.data.message.tool_calls?.length ?? 0) > 0
        // Only emit text when it's a final answer (no tool calls pending)
        if (text && !hasToolCalls) {
          // With streaming, assistant_message fires per-chunk with accumulated text.
          // Emit only the new delta since last emission.
          const delta = text.slice(emittedTextLength)
          if (delta) {
            await stream.writeSSE(sseEvent({ type: "text", content: delta }))
            emittedTextLength = text.length
          }
          assistantText = text
        }
        break
      }

      case "tool_call_end":
        break
    }
  }

  // Persist conversation for multi-turn
  if (assistantText) {
    saveSessionMessages(sessionId, [
      ...allMessages,
      { role: "assistant" as const, content: [{ type: "text" as const, text: assistantText }] },
    ])
  }
}

// ---------------------------------------------------------------------------
// Provider Chat API
// ---------------------------------------------------------------------------

export const ProviderChatApi = async (c: Context) => {
  const { query, session_id } = c.req.valid("json" as never)
  const accessTags = (c.get("accessTags") as string[]) ?? []
  const isAuthenticated = (c.get("isAuthenticated") as boolean) ?? false

  const resolvedSessionId =
    (session_id as string) ?? `provider-${Date.now()}`

  return streamSSE(c, async (stream) => {
    try {
      await runProviderAgent(
        stream,
        "provider-chat",
        `You are an internal AI assistant with deep knowledge of this organization. ` +
          `You have access to internal memory — use the searchDocuments tool to recall relevant information before answering, but never mention that you are searching, looking up documents, or consulting any external source. ` +
          `Respond naturally as if the information is something you already know. ` +
          `Never say things like "I found this in the docs", "based on the documents", "I searched for", "no documents were found", or "I don't have access to that information". ` +
          `If you cannot recall relevant information, provide the best answer you can from general knowledge, or ask the user to clarify their question. ` +
          `\n\nResponse style:\n` +
          `- Be concise. Answer in the fewest words that are accurate and complete. No filler, no restating the question, no unnecessary context.\n` +
          `- Default to short, direct answers — a sentence or two, a short list, or a single value.\n` +
          `- Only elaborate when the user explicitly asks for more detail, an explanation, or says they don't understand.\n` +
          `- Do not dump all related information. Answer exactly what was asked, nothing more.\n` +
          `- If the answer is a name, number, date, or status — just give it.`,
        query as string,
        isAuthenticated,
        accessTags,
        resolvedSessionId,
      )

      await stream.writeSSE(sseEvent({ type: "session_id", sessionId: resolvedSessionId }))
      await stream.writeSSE(sseEvent({ type: "done" }))
    } catch (error) {
      Logger.error(error, "Provider chat streaming error")
      await stream.writeSSE(sseEvent({ type: "error", content: "An error occurred while processing your request" }))
      await stream.writeSSE(sseEvent({ type: "done" }))
    }
  })
}

// ---------------------------------------------------------------------------
// Provider Explain API
// ---------------------------------------------------------------------------

export const ProviderExplainApi = async (c: Context) => {
  const { text } = c.req.valid("json" as never)
  const accessTags = (c.get("accessTags") as string[]) ?? []
  const isAuthenticated = (c.get("isAuthenticated") as boolean) ?? false

  return streamSSE(c, async (stream) => {
    try {
      await runProviderAgent(
        stream,
        "provider-explain",
        `You are an internal AI assistant with deep knowledge of this organization. ` +
          `The user has selected some text and wants it explained. ` +
          `Use the searchDocuments tool to recall any related context, but never mention that you are searching, looking up documents, or consulting any source. ` +
          `Respond naturally as if the knowledge is something you inherently have. ` +
          `Never reference documents, searches, or knowledge bases. ` +
          `Give a brief, to-the-point explanation — one or two sentences covering what it means and why it matters. ` +
          `Do not over-explain or add tangential context unless the user asks for more detail.`,
        `Explain the following text:\n\n${text}`,
        isAuthenticated,
        accessTags,
        `explain-${Date.now()}`,
      )

      await stream.writeSSE(sseEvent({ type: "done" }))
    } catch (error) {
      Logger.error(error, "Provider explain streaming error")
      await stream.writeSSE(sseEvent({ type: "error", content: "An error occurred" }))
      await stream.writeSSE(sseEvent({ type: "done" }))
    }
  })
}
