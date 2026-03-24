/**
 * synthesizeFinalAnswer tool - pi-mono version
 *
 * Makes a REAL LLM synthesis call with all fragments injected,
 * matching JAF's implementation. Streams the grounded answer
 * directly to the user via the runtime.streamAnswerText callback.
 */

import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"
import { buildFinalSynthesisPayload } from "../../message-agents"
import { getProviderByModel } from "@/ai/provider"
import config from "@/config"
import { Models } from "@/ai/types"
import type { ModelParams } from "@/ai/types"
import { ConversationRole } from "@aws-sdk/client-bedrock-runtime"
import { ReasoningSteps } from "@/api/chat/reasoning-steps"
import { getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"

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
    const { xyneState, persistState, runtime } = ctx
    const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

    try {
      // Check if already completed
      if (
        xyneState.finalSynthesis.requested &&
        xyneState.finalSynthesis.completed
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Final synthesis already completed for this run.",
            },
          ],
          isError: true,
          details: {
            toolName: "synthesizeFinalAnswer",
            error: "already_completed",
          },
        }
      }

      // Verify we have streaming capability
      if (!runtime?.streamAnswerText) {
        return {
          content: [
            {
              type: "text",
              text: "Streaming channel unavailable. Cannot deliver final answer.",
            },
          ],
          isError: true,
          details: { toolName: "synthesizeFinalAnswer", error: "no_stream" },
        }
      }

      // Mark final synthesis as requested
      xyneState.finalSynthesis.requested = true
      xyneState.finalSynthesis.suppressAssistantStreaming = true
      xyneState.finalSynthesis.completed = false

      // Lock review state
      xyneState.review.lockedByFinalSynthesis = true

      await persistState()

      // Build the full synthesis payload with fragments, plan, and context
      const { systemPrompt, userMessage } = buildFinalSynthesisPayload(
        xyneState as any,
        {
          insightsUsefulForAnswering: params.insightsUsefulForAnswering,
        },
      )

      const fragmentsCount = xyneState.allFragments.length
      loggerWithChild({ email: xyneState.user.email }).info(
        {
          fragmentsCount,
          hasInsights: !!params.insightsUsefulForAnswering,
          systemPromptLength: systemPrompt.length,
          userMessageLength: userMessage.length,
        },
        "[Pi-Mono][FinalSynthesis] Making synthesis LLM call with fragments",
      )

      // Emit synthesis started reasoning event
      await runtime.emitReasoning(
        ReasoningSteps.synthesisStarted(fragmentsCount),
      )

      // If there are ZERO fragments, don't even call the LLM — just return a clean "no results" message
      if (fragmentsCount === 0) {
        const noResultsMsg = `I searched your organization's knowledge base but found no documents related to your question. Please try rephrasing your query or check if the relevant documents have been synced.`
        await runtime.streamAnswerText(noResultsMsg)
        xyneState.finalSynthesis.completed = true
        await runtime.emitReasoning(ReasoningSteps.synthesisCompleted())
        return {
          content: [
            {
              type: "text",
              text: "No fragments available — returned no-results message.",
            },
          ],
          details: {
            toolName: "synthesizeFinalAnswer",
            streamed: true,
            metadata: { fragmentsCount: 0 },
          },
        }
      }

      // Prepend strict anti-hallucination guardrails to the synthesis prompt.
      // The base prompt already says "Use ONLY the provided files" but LLMs
      // WILL attempt to "be helpful" by adding training knowledge after
      // acknowledging a gap. This preamble blocks that pattern explicitly.
      const strictPreamble = `
### ABSOLUTE GROUND RULE — ZERO EXTERNAL KNOWLEDGE

You are a RETRIEVAL-ONLY answering engine. You have NO knowledge of your own.
Your ONLY source of truth is the "Context Fragments" section provided below.
You must treat yourself as if you were trained on NOTHING — you are an empty vessel
that can only repeat, summarize, and cite what the fragments say.

HARD CONSTRAINTS (violation = CRITICAL failure):
1. NEVER use your training data, world knowledge, or any information not explicitly present in the provided fragments.
2. Every single factual claim MUST have a citation in the format K[docId_chunkIndex]. No citation = delete the sentence.
3. If the fragments do NOT contain sufficient information to answer the question:
   - Say: "I could not find information about [topic] in the available documents."
   - Then STOP. Do NOT continue. Do NOT add explanations, definitions, or context from your own knowledge.
4. Do NOT extrapolate, speculate, infer, or "fill gaps" with general knowledge — even partially.
5. Do NOT generate generic explanations, definitions, or background context that is not in the fragments.

FORBIDDEN PATTERNS (if you catch yourself writing any of these, STOP and delete):
- "Let me explain what X generally means..."
- "In general, X refers to..."
- "While I couldn't find specific documentation, here's what X typically involves..."
- "Based on my understanding..." / "Generally speaking..."
- "Here's what I know about..."
- Any sentence that provides information not traceable to a K[docId_chunkIndex] citation.

SELF-CHECK: Before outputting each sentence, ask: "Does a fragment say this, and can I cite it?"
→ YES: Output it with the K[docId_chunkIndex] citation.
→ NO: Delete it. No exceptions. No "helpful" additions.
`.trim()

      const reinforcedSystemPrompt = `${strictPreamble}\n\n${systemPrompt}`

      // Build the LLM messages — include conversation history for follow-up context
      const finalUserPrompt = `${userMessage}\n\nAnswer using ONLY the context fragments above. If the fragments do not contain the answer, say "I could not find information about this topic in the available documents" and STOP. Do NOT add any external knowledge, definitions, or explanations.`

      // Prepend conversation history so the synthesis LLM has context for follow-up questions
      const historyMessages = (xyneState.conversationHistoryMessages || []).map(
        (m: any) => ({
          role:
            m.role === "user"
              ? ConversationRole.USER
              : ConversationRole.ASSISTANT,
          content: Array.isArray(m.content)
            ? m.content
            : [{ text: String(m.content || "") }],
        }),
      )

      const messages = [
        ...historyMessages,
        {
          role: ConversationRole.USER,
          content: [{ text: finalUserPrompt }],
        },
      ]

      // Use the standard best model for synthesis (NOT the LiteLLM agentic model).
      // The agentic model (e.g. "kimi-latest") is routed through LiteLLM for the agent loop,
      // but synthesis uses the standard Xyne provider system (e.g. GPT-4o).
      const modelId = (config.defaultBestModel as Models) || Models.Gpt_4o
      const modelParams: ModelParams = {
        modelId,
        systemPrompt: reinforcedSystemPrompt,
        stream: true,
        temperature: 0.1, // Low temperature for stricter grounding
        max_new_tokens: 8192,
      }

      const provider = getProviderByModel(modelId)
      let streamedCharacters = 0

      try {
        const iterator = provider.converseStream(messages, modelParams)
        for await (const chunk of iterator) {
          if (chunk.text) {
            streamedCharacters += chunk.text.length
            // Stream directly to the user via the SSE channel
            await runtime.streamAnswerText(chunk.text)
          }
        }

        xyneState.finalSynthesis.completed = true

        loggerWithChild({ email: xyneState.user.email }).info(
          {
            streamedCharacters,
            fragmentsCount,
          },
          "[Pi-Mono][FinalSynthesis] LLM synthesis call completed",
        )

        // Emit synthesis completed reasoning event
        await runtime.emitReasoning(ReasoningSteps.synthesisCompleted())

        return {
          content: [
            {
              type: "text",
              text: "Final answer streamed to user.",
            },
          ],
          details: {
            toolName: "synthesizeFinalAnswer",
            streamed: true,
            metadata: {
              fragmentsCount,
              textLength: streamedCharacters,
              hasInsights: !!params.insightsUsefulForAnswering,
            },
          },
        }
      } catch (llmError) {
        const errMsg =
          llmError instanceof Error ? llmError.message : String(llmError)
        loggerWithChild({ email: xyneState.user.email }).error(
          { error: errMsg },
          "[Pi-Mono][FinalSynthesis] LLM synthesis call failed",
        )

        // Reset synthesis state on LLM error
        xyneState.finalSynthesis.suppressAssistantStreaming = false
        xyneState.finalSynthesis.requested = false
        xyneState.finalSynthesis.completed = false

        return {
          content: [
            { type: "text", text: `Synthesis LLM call failed: ${errMsg}` },
          ],
          isError: true,
          details: { toolName: "synthesizeFinalAnswer", error: errMsg },
        }
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
