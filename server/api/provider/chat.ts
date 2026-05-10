import { type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server)

// Provider SSE events — matches SDK client's expected ChatStreamEvent format
const ProviderSSEvents = {
  Text: "text",
  Sources: "sources",
  SessionId: "session_id",
  Done: "done",
  Error: "error",
} as const

/**
 * Searches Vespa kb_items with access_tags filtering.
 * Shared helper for chat and explain endpoints.
 */
async function searchWithAccessTags(
  query: string,
  accessTags: string[],
  hits: number = 5,
): Promise<Array<{ docId: string; title: string; content: string; sourceUrl?: string }>> {
  const tagFilters = accessTags
    .map((tag) => `access_tags contains "${tag}"`)
    .join(" OR ")
  const yql = `select * from kb_items where userInput(@query) AND (${tagFilters})`

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
    Logger.error({ status: response.status }, "Vespa search failed in provider chat")
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
      content: (hit.fields?.chunks as string[])?.join("\n") ?? "",
      sourceUrl: (hit.fields?.storagePath as string) ?? undefined,
    })) ?? []
  )
}

/**
 * Provider Chat API — SSE streaming response.
 * Searches scoped documents and generates an AI answer.
 */
export const ProviderChatApi = async (c: Context) => {
  const { query, session_id } = c.req.valid("json" as never)
  const accessTags = c.get("accessTags") as string[]
  const workspaceId = c.get("workspaceId") as string

  if (!accessTags || accessTags.length === 0) {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: ProviderSSEvents.Error, data: "No access" })
      await stream.writeSSE({ event: ProviderSSEvents.Done, data: "" })
    })
  }

  return streamSSE(c, async (stream) => {
    try {
      // 1. Search for relevant documents scoped by access_tags
      const sources = await searchWithAccessTags(query as string, accessTags, 5)

      // 2. Emit sources
      if (sources.length > 0) {
        await stream.writeSSE({
          event: ProviderSSEvents.Sources,
          data: JSON.stringify(
            sources.map((s) => ({
              docId: s.docId,
              title: s.title,
              sourceUrl: s.sourceUrl,
            })),
          ),
        })
      }

      // 3. Build context from retrieved documents
      const context = sources
        .map((s) => `## ${s.title}\n${s.content}`)
        .join("\n\n---\n\n")

      const systemPrompt = `You are a helpful AI assistant. Answer the user's question based on the following context. If the context doesn't contain enough information, say so clearly.

Context:
${context}`

      // 4. Call AI for streaming response
      // TODO: Integrate with Xyne's existing agent infrastructure for full-featured streaming
      // For now, use a direct AI call with the retrieved context
      const aiResponse = await fetch(`${config.vespaEndpoint.queryEndpoint}`, {
        method: "POST",
        // Placeholder — will integrate with Xyne's AI/agent system
      }).catch(() => null)

      // Emit a placeholder response indicating the endpoint structure is ready
      // Full AI integration will use Xyne's existing agent infrastructure
      await stream.writeSSE({
        event: ProviderSSEvents.Text,
        data: `Based on the retrieved documents, here is a summary of relevant information:\n\n${sources.map((s) => `- **${s.title}**: ${s.content.slice(0, 200)}...`).join("\n")}`,
      })

      // 5. Emit session_id for conversation continuity
      const resolvedSessionId = (session_id as string) ?? `provider-${Date.now()}`
      await stream.writeSSE({
        event: ProviderSSEvents.SessionId,
        data: resolvedSessionId,
      })

      // 6. Done
      await stream.writeSSE({ event: ProviderSSEvents.Done, data: "" })
    } catch (error) {
      Logger.error(error, "Provider chat streaming error")
      await stream.writeSSE({
        event: ProviderSSEvents.Error,
        data: "An error occurred while processing your request",
      })
      await stream.writeSSE({ event: ProviderSSEvents.Done, data: "" })
    }
  })
}

/**
 * Provider Explain API — SSE streaming explanation of selected text.
 */
export const ProviderExplainApi = async (c: Context) => {
  const { text } = c.req.valid("json" as never)
  const accessTags = c.get("accessTags") as string[]

  return streamSSE(c, async (stream) => {
    try {
      // Search for context related to the text being explained
      const sources = await searchWithAccessTags(text as string, accessTags, 3)

      if (sources.length > 0) {
        await stream.writeSSE({
          event: ProviderSSEvents.Sources,
          data: JSON.stringify(
            sources.map((s) => ({
              docId: s.docId,
              title: s.title,
              sourceUrl: s.sourceUrl,
            })),
          ),
        })
      }

      // TODO: Integrate with Xyne's AI system for actual explanation generation
      await stream.writeSSE({
        event: ProviderSSEvents.Text,
        data: `Explanation based on available documentation:\n\n${sources.map((s) => `- From **${s.title}**: ${s.content.slice(0, 300)}`).join("\n\n")}`,
      })

      await stream.writeSSE({ event: ProviderSSEvents.Done, data: "" })
    } catch (error) {
      Logger.error(error, "Provider explain streaming error")
      await stream.writeSSE({
        event: ProviderSSEvents.Error,
        data: "An error occurred",
      })
      await stream.writeSSE({ event: ProviderSSEvents.Done, data: "" })
    }
  })
}
