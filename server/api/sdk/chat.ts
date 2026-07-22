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
import { db } from "@/db/client"
import { getSdkConfigByWorkspaceExternalId } from "@/db/sdkConfig"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { makeXyneGenericJAFProvider } from "@/api/chat/jaf-generic-provider"
import { buildVisibilityFilter } from "@/api/sdk/search"
import {
  resolveCollectionId,
  resolveWorkspaceCreator,
} from "@/api/sdk/collections"

const Logger = getLogger(Subsystem.Server)

// SDK SSE helpers — the SDK parser reads only the `data:` field and JSON.parses it.
// Each event must be a JSON object with a `type` discriminator matching ChatStreamEvent.
function sseEvent(evt: Record<string, unknown>): { data: string } {
  return { data: JSON.stringify(evt) }
}

// ---------------------------------------------------------------------------
// In-memory session store for multi-turn chat
// ---------------------------------------------------------------------------

type SdkAgentContext = {
  createdBy: string
  collectionId?: string
  isAuthenticated: boolean
  accessTags: string[]
  workspaceId: string
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

function saveSessionMessages(sessionId: string, messages: JAFMessage[]): void {
  sessionStore.set(sessionId, { messages, lastAccess: Date.now() })
}

// Periodic cleanup of expired sessions
setInterval(
  () => {
    const now = Date.now()
    for (const [id, entry] of sessionStore) {
      if (now - entry.lastAccess > SESSION_TTL_MS) sessionStore.delete(id)
    }
  },
  10 * 60 * 1000,
)

// ---------------------------------------------------------------------------
// Vespa search helper (shared by the tool)
// ---------------------------------------------------------------------------

async function searchWithAccessTags(
  query: string,
  createdBy: string,
  collectionId: string | undefined,
  isAuthenticated: boolean,
  accessTags: string[],
  hits: number = 5,
): Promise<
  Array<{ docId: string; title: string; content: string; sourceUrl?: string }>
> {
  const visibilityFilter = buildVisibilityFilter(isAuthenticated, accessTags)
  const collectionFilter = collectionId
    ? ` AND clId contains "${collectionId}"`
    : ""
  const yql = `select * from kb_items where userInput(@query) AND createdBy contains "${createdBy}"${collectionFilter} AND (${visibilityFilter})`

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
    Logger.error({ status: response.status }, "Vespa search failed in SDK chat")
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
  query: z.string().describe("The search query to recall relevant information"),
})

type SearchDocumentsParams = z.infer<typeof searchDocumentsSchema>

const searchDocumentsTool: Tool<SearchDocumentsParams, SdkAgentContext> = {
  schema: {
    name: "searchDocuments",
    description:
      "Recall internal information relevant to the query. Use this to look up facts, procedures, policies, or context before responding.",
    parameters: searchDocumentsSchema as any,
  },
  async execute(params: SearchDocumentsParams, context: SdkAgentContext) {
    try {
      const results = await searchWithAccessTags(
        params.query,
        context.createdBy,
        context.collectionId,
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
// JAF create support ticket tool
// ---------------------------------------------------------------------------

const createSupportTicketSchema = z.object({
  email: z
    .string()
    .describe("The end-user's email address for ticket correspondence"),
  subject: z.string().describe("Short summary of the support request"),
  body: z
    .string()
    .describe("Detailed description of the issue (HTML supported)"),
})

type CreateSupportTicketParams = z.infer<typeof createSupportTicketSchema>

const createSupportTicketTool: Tool<
  CreateSupportTicketParams,
  SdkAgentContext
> = {
  schema: {
    name: "createSupportTicket",
    description:
      "Create a support ticket in the desk system for the user's issue. " +
      "Use when the user needs help that requires human follow-up or " +
      "when they explicitly ask to raise a ticket.",
    parameters: createSupportTicketSchema as any,
  },
  async execute(
    params: CreateSupportTicketParams,
    context: SdkAgentContext,
  ) {
    try {
      const sdkConfig = await getSdkConfigByWorkspaceExternalId(
        db,
        context.workspaceId,
      )
      const ticketConfig = sdkConfig?.spacesConfig?.createTicketWithEmail
      if (!ticketConfig?.enabled) {
        return ToolResponse.error(
          ToolErrorCodes.EXECUTION_FAILED,
          "Ticket creation is not configured",
        )
      }

      const requestBody = {
        channelId: ticketConfig.channelId,
        email: params.email,
        subject: ticketConfig.ackSubject
          ? ticketConfig.ackSubject.replace("{{subject}}", params.subject)
          : params.subject,
        body: params.body,
        ...(ticketConfig.ackBody && { ackBody: ticketConfig.ackBody }),
      }

      const response = await fetch(
        `${ticketConfig.spacesBaseUrl}/api/apps/email/createTicketWithEmail`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ticketConfig.spacesAppToken}`,
          },
          body: JSON.stringify(requestBody),
        },
      )

      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as {
          message?: string
        }
        return ToolResponse.error(
          ToolErrorCodes.EXECUTION_FAILED,
          err.message || "Failed to create ticket",
        )
      }

      const result = (await response.json()) as {
        ticketId: string
        conversationId: string
        externalThreadId: string
      }
      return ToolResponse.success({
        ticketId: result.ticketId,
        message:
          "Support ticket created. The user will receive an acknowledgment email.",
      })
    } catch (error) {
      return ToolResponse.error(
        ToolErrorCodes.EXECUTION_FAILED,
        `Ticket creation failed: ${error}`,
      )
    }
  },
}

// ---------------------------------------------------------------------------
// Shared JAF agent runner — maps TraceEvents → SSE
// ---------------------------------------------------------------------------

async function runSdkAgent(
  stream: SSEStreamingApi,
  agentName: string,
  instructions: string,
  userMessage: string,
  createdBy: string,
  collectionId: string | undefined,
  isAuthenticated: boolean,
  accessTags: string[],
  sessionId: string,
  workspaceId: string,
): Promise<void> {
  // Conditionally register support ticket tool based on spacesConfig
  const tools: Tool<any, SdkAgentContext>[] = [searchDocumentsTool]
  const sdkConfig = await getSdkConfigByWorkspaceExternalId(db, workspaceId)
  if (sdkConfig?.spacesConfig?.createTicketWithEmail?.enabled) {
    tools.push(createSupportTicketTool)
  }

  const agent: JAFAgent<SdkAgentContext, string> = {
    name: agentName,
    instructions: () => instructions,
    tools,
    modelConfig: { name: config.defaultFastModel },
  }

  const agentRegistry = new Map([[agent.name, agent]])
  const modelProvider = makeXyneGenericJAFProvider<SdkAgentContext>()

  // Load previous messages for multi-turn, append new user message
  const previousMessages = getSessionMessages(sessionId)
  const allMessages: JAFMessage[] = [
    ...previousMessages,
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: userMessage }],
    },
  ]

  const runState: JAFRunState<SdkAgentContext> = {
    runId: generateRunId(),
    traceId: generateTraceId(),
    messages: allMessages,
    currentAgentName: agent.name,
    context: { createdBy, collectionId, isAuthenticated, accessTags, workspaceId },
    turnCount: 0,
  }

  const runCfg: JAFRunConfig<SdkAgentContext> = {
    agentRegistry,
    modelProvider,
    maxTurns: 6,
  }

  let assistantText = ""
  let emittedTextLength = 0 // track how much text we've already sent

  for await (const evt of runStream<SdkAgentContext, string>(
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
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: assistantText }],
      },
    ])
  }
}

// ---------------------------------------------------------------------------
// SDK Chat API
// ---------------------------------------------------------------------------

export const SdkChatApi = async (c: Context) => {
  const {
    query,
    session_id,
    collection: collectionName,
  } = c.req.valid("json" as never)
  const workspaceId = c.get("workspaceId") as string
  const accessTags = (c.get("accessTags") as string[]) ?? []
  const isAuthenticated = (c.get("isAuthenticated") as boolean) ?? false

  // Resolve workspace → admin email for createdBy scoping
  const createdBy = await resolveWorkspaceCreator(workspaceId)
  // Resolve collection name → UUID before entering the stream
  const collectionUuid = await resolveCollectionId(
    workspaceId,
    collectionName as string | undefined,
  )

  const resolvedSessionId = (session_id as string) ?? `sdk-${Date.now()}`

  return streamSSE(c, async (stream) => {
    try {
      await runSdkAgent(
        stream,
        "sdk-chat",
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
        createdBy,
        collectionUuid,
        isAuthenticated,
        accessTags,
        resolvedSessionId,
        workspaceId,
      )

      await stream.writeSSE(
        sseEvent({ type: "session_id", sessionId: resolvedSessionId }),
      )
      await stream.writeSSE(sseEvent({ type: "done" }))
    } catch (error) {
      Logger.error(error, "SDK chat streaming error")
      await stream.writeSSE(
        sseEvent({
          type: "error",
          content: "An error occurred while processing your request",
        }),
      )
      await stream.writeSSE(sseEvent({ type: "done" }))
    }
  })
}

// ---------------------------------------------------------------------------
// SDK Explain API
// ---------------------------------------------------------------------------

export const SdkExplainApi = async (c: Context) => {
  const { text, collection: collectionName } = c.req.valid("json" as never)
  const workspaceId = c.get("workspaceId") as string
  const accessTags = (c.get("accessTags") as string[]) ?? []
  const isAuthenticated = (c.get("isAuthenticated") as boolean) ?? false

  // Resolve workspace → admin email for createdBy scoping
  const createdBy = await resolveWorkspaceCreator(workspaceId)
  // Resolve collection name → UUID before entering the stream
  const collectionUuid = await resolveCollectionId(
    workspaceId,
    collectionName as string | undefined,
  )

  return streamSSE(c, async (stream) => {
    try {
      await runSdkAgent(
        stream,
        "sdk-explain",
        `You are an internal AI assistant with deep knowledge of this organization. ` +
          `The user has selected some text and wants it explained. ` +
          `Use the searchDocuments tool to recall any related context, but never mention that you are searching, looking up documents, or consulting any source. ` +
          `Respond naturally as if the knowledge is something you inherently have. ` +
          `Never reference documents, searches, or knowledge bases. ` +
          `Give a brief, to-the-point explanation — one or two sentences covering what it means and why it matters. ` +
          `Do not over-explain or add tangential context unless the user asks for more detail.`,
        `Explain the following text:\n\n${text}`,
        createdBy,
        collectionUuid,
        isAuthenticated,
        accessTags,
        `explain-${Date.now()}`,
        workspaceId,
      )

      await stream.writeSSE(sseEvent({ type: "done" }))
    } catch (error) {
      Logger.error(error, "SDK explain streaming error")
      await stream.writeSSE(
        sseEvent({ type: "error", content: "An error occurred" }),
      )
      await stream.writeSSE(sseEvent({ type: "done" }))
    }
  })
}
