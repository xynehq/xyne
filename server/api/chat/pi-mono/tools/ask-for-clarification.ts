/**
 * askForClarification tool - pi-mono version
 *
 * Explicit clarification (Approach 1)
 */

import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"

const askForClarificationParams = Type.Object({
  question: Type.String({
    description: "The clarification question to ask the user",
    minLength: 1,
  }),
})

export const askForClarificationTool = createXyneTool(
  "askForClarification",
  "Ask the user for clarification when the query is ambiguous. Use this tool to explicitly request more information (Approach 1).",
  askForClarificationParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    const { xyneState, persistState, events } = ctx

    // Generate clarification ID
    const clarificationId = `clarification-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`

    // Store clarification in state
    xyneState.clarifications.push({
      id: clarificationId,
      question: params.question,
      timestamp: Date.now(),
    })
    xyneState.pendingClarificationId = clarificationId
    xyneState.ambiguityResolved = false

    await persistState()

    // Emit event for UI
    events.emit("clarification_requested", {
      type: "clarification_requested",
      clarificationId,
      question: params.question,
    })

    return {
      content: [
        {
          type: "text",
          text: `Clarification requested: ${params.question}`,
        },
      ],
      details: {
        clarificationId,
        question: params.question,
        toolName: "askForClarification",
      },
    }
  },
)
