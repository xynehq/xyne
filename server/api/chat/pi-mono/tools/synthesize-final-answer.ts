/**
 * synthesizeFinalAnswer tool - pi-mono version
 *
 * Final synthesis tool that streams the answer to the user
 */

import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"
import { buildFinalSynthesisPayload } from "../../message-agents"

const synthesizeFinalAnswerParams = Type.Object({
  insightsUsefulForAnswering: Type.Optional(
    Type.String({
      description:
        "Optional guidance to help the final answer model emphasize key conclusions, ordering, or non-obvious takeaways.",
    }),
  ),
})

export const synthesizeFinalAnswerTool = createXyneTool(
  "synthesizeFinalAnswer",
  "MANDATORY FINAL STEP. Call this exactly once when you have gathered all required context and are ready to deliver the final answer. Streams the final response to the user.",
  synthesizeFinalAnswerParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    const { xyneState, persistState } = ctx

    try {
      // Mark final synthesis as requested
      xyneState.finalSynthesis.requested = true
      xyneState.finalSynthesis.suppressAssistantStreaming = true

      // Lock review state
      xyneState.review.lockedByFinalSynthesis = true

      await persistState()

      // Build synthesis payload
      const { systemPrompt, userMessage } = buildFinalSynthesisPayload(
        xyneState as any,
        {
          insightsUsefulForAnswering: params.insightsUsefulForAnswering,
        },
      )

      // Note: Actual streaming is handled by the runtime
      // This tool just signals that synthesis should begin

      return {
        content: [
          {
            type: "text",
            text: "Final answer synthesis initiated.",
          },
        ],
        details: {
          toolName: "synthesizeFinalAnswer",
          streamed: true,
          metadata: {
            fragmentsCount: xyneState.allFragments.length,
            hasInsights: !!params.insightsUsefulForAnswering,
          },
        },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)

      // Reset synthesis state on error
      xyneState.finalSynthesis.requested = false
      xyneState.finalSynthesis.suppressAssistantStreaming = false

      return {
        content: [{ type: "text", text: `Synthesis failed: ${errMsg}` }],
        isError: true,
        details: { toolName: "synthesizeFinalAnswer", error: errMsg },
      }
    }
  },
)
