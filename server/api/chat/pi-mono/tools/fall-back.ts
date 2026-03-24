/**
 * fallBack tool - pi-mono version
 *
 * Fully wired to existing JAF implementation
 */

import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"
import { generateFallback } from "@/ai/provider"
import config from "@/config"

const fallBackParams = Type.Object({
  originalQuery: Type.String({
    description: "The original user query",
    minLength: 1,
  }),
  agentScratchpad: Type.String({
    description: "The agent reasoning history",
    minLength: 1,
  }),
  toolLog: Type.String({
    description: "The tool execution log",
    minLength: 1,
  }),
  gatheredFragments: Type.String({
    description: "The gathered context fragments",
    minLength: 1,
  }),
})

export const fallBackTool = createXyneTool(
  "fallBack",
  "Generate detailed reasoning about why the search failed when initial iterations are exhausted but synthesis is still not complete.",
  fallBackParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    try {
      const userContext = ctx.xyneState.userContext || ""

      const fallbackResponse = await generateFallback(
        userContext,
        params.originalQuery,
        params.agentScratchpad,
        params.toolLog,
        params.gatheredFragments,
        {
          modelId: config.defaultFastModel,
          stream: false,
          json: true,
        },
      )

      if (!fallbackResponse.reasoning?.trim()) {
        return {
          content: [{ type: "text", text: "No reasoning could be generated." }],
          isError: true,
          details: { toolName: "fallBack" },
        }
      }

      return {
        content: [{ type: "text", text: fallbackResponse.reasoning }],
        details: {
          reasoning: fallbackResponse.reasoning,
          toolName: "fallBack",
        },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: "text", text: `Fallback error: ${errMsg}` }],
        isError: true,
        details: { toolName: "fallBack", error: errMsg },
      }
    }
  },
)
