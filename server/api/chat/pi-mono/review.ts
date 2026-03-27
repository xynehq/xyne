/**
 * Review System for Pi-Mono
 *
 * Ported from JAF's expectation/review system:
 * - Extract expectations from assistant messages (<expected_results> XML)
 * - Assign expectations to tool calls
 * - Run automatic review at turn-end
 */

import { z } from "zod"
import { getModelValueFromLabel } from "@/ai/modelConfig"
import {
  extractBestDocumentIndexes,
  getProviderByModel,
  jsonParseLLMOutput,
} from "@/ai/provider"
import { Models, type ModelParams } from "@/ai/types"
import { ConversationRole, type Message } from "@aws-sdk/client-bedrock-runtime"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import type {
  XyneAgentState,
  ToolExpectation,
  ToolExpectationAssignment,
  ReviewResult,
} from "./adapter"
import type { ReasoningEmitter } from "../reasoning-steps"
import { ReasoningSteps, emitReasoningEvent } from "../reasoning-steps"

const Logger = getLogger(Subsystem.Chat)

const { defaultBestModel, defaultFastModel } = config

// ============================================================================
// EXPECTATION EXTRACTION
// ============================================================================

/**
 * Zod schema for validating tool expectations
 */
export const ToolExpectationSchema = z.object({
  goal: z.string().min(1),
  successCriteria: z.array(z.string()).min(1),
  failureSignals: z.array(z.string()).optional(),
  stopCondition: z.string().optional(),
  evidencePlan: z.string().optional(),
})

/**
 * Extract expected results from assistant message text
 * Looks for <expected_results> XML blocks containing JSON
 */
export function extractExpectedResults(
  text: string,
): ToolExpectationAssignment[] {
  const expectations: ToolExpectationAssignment[] = []
  if (!text) return expectations

  const expectationRegex = /<expected_results>([\s\S]*?)<\/expected_results>/gi
  let match: RegExpExecArray | null

  while ((match = expectationRegex.exec(text)) !== null) {
    const body = match[1]?.trim()
    if (!body) continue

    const parsed = safeJsonParse(body)
    const entries = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as any)?.toolExpectations)
        ? (parsed as any).toolExpectations
        : []

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue
      const toolName =
        typeof entry.toolName === "string" ? entry.toolName.trim() : ""
      if (!toolName) continue

      const expectationCandidate = {
        goal: (entry as any).goal,
        successCriteria: (entry as any).successCriteria,
        failureSignals: (entry as any).failureSignals,
        stopCondition: (entry as any).stopCondition,
        evidencePlan: (entry as any).evidencePlan,
      }

      const validation = ToolExpectationSchema.safeParse(expectationCandidate)
      if (!validation.success) {
        Logger.warn(
          { toolName, error: validation.error.format() },
          "Invalid expected_results entry emitted by agent",
        )
        continue
      }

      expectations.push({ toolName, expectation: validation.data })
    }
  }

  return expectations
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Consume a pending expectation for a tool
 * Matches by tool name (case-insensitive)
 */
export function consumePendingExpectation(
  queue: ToolExpectationAssignment[],
  toolName: string,
): ToolExpectationAssignment | undefined {
  if (!toolName) return undefined
  const idx = queue.findIndex(
    (entry) => entry.toolName.toLowerCase() === toolName.toLowerCase(),
  )
  if (idx === -1) {
    return undefined
  }
  return queue.splice(idx, 1)[0]
}

/**
 * Record expectations for a specific turn in history
 */
export function recordExpectationsForTurn(
  history: Map<number, ToolExpectationAssignment[]>,
  turn: number,
  expectations: ToolExpectationAssignment[],
): void {
  if (!expectations.length) {
    return
  }
  const existing = history.get(turn) || []
  existing.push(...expectations)
  history.set(turn, existing)
}

// ============================================================================
// REVIEW SYSTEM
// ============================================================================

/**
 * Build review system prompt
 */
function buildReviewSystemPrompt(options: {
  isFirstReview: boolean
  delegationNote: string
}): string {
  const firstReviewGuidance = options.isFirstReview
    ? [
        "- If prior conversation history is provided as messages, use it only for continuity, intent, and prior commitments.",
        "- If memory context appears in the user prompt, treat it as supporting context.",
        "- Prioritize current turn tool outputs, expectations, clarifications, plan state, fragments, and images over older assistant statements in conversation history.",
      ]
    : []

  return [
    "You are a senior reviewer ensuring each agentic turn honors the agreed plan and tool expectations.",
    ...firstReviewGuidance,
    "- Context fragments are incremental: you may receive only new fragments since the last review, plus a high-level previous review summary for continuity; use that summary to avoid re-evaluating already-reviewed context.",
    '- The tool call section may cover a single turn or multiple turns (e.g. "last N turns"). Inspect every tool call in that section, compare the outputs with the expected results, and decide whether each tool met or missed expectations.',
    "- Evaluate the current plan to see if it still fits the evidence gathered from the tool calls; suggest plan changes when necessary.",
    "- Detect anomalies (unexpected behaviors, contradictory data, missing outputs, or unresolved ambiguities) and call them out explicitly. If intent remains unclear, set ambiguityResolved=false and include the ambiguity notes inside the anomalies array.",
    options.delegationNote,
    `- When the available context is already relevant and sufficient and it meets all the requirement of user's ask , set planChangeNeeded=true and use planChangeReason to state that the plan should pivot toward final synthesis because the evidence is complete.`,
    '- Set recommendation to "gather_more" when required evidence or data is missing, "clarify_query" when ambiguity remains unresolved, and "replan" only when the current plan is no longer viable.',
    "- If the user asked multiple questions or sub-questions, verify that the plan or gathered evidence addresses each; report incomplete coverage in anomalies and set recommendation or planChangeNeeded as appropriate.",
    "- Always set ambiguityResolved=false whenever outstanding clarifications exist or anomalies highlight missing/contradictory information; otherwise leave it true.",
  ].join("\n")
}

/**
 * Format expectations for review prompt
 */
function formatExpectationsForReview(
  expectations?: ToolExpectationAssignment[],
): string {
  if (!expectations || expectations.length === 0) {
    return "[]"
  }
  return JSON.stringify(expectations, null, 2)
}

/**
 * Format tool call history for review prompt
 */
function formatToolCallHistoryByTurn(
  records: Array<{
    toolName: string
    status: string
    error?: { message: string }
    arguments?: Record<string, unknown>
    turnNumber: number
  }>,
): string {
  if (!records || records.length === 0) {
    return "No tool calls in this window."
  }
  const byTurn = new Map<number, typeof records>()
  for (const r of records) {
    const list = byTurn.get(r.turnNumber) ?? []
    list.push(r)
    byTurn.set(r.turnNumber, list)
  }
  const turns = Array.from(byTurn.keys()).sort((a, b) => a - b)
  return turns
    .map((turnNum) => {
      const turnRecords = byTurn.get(turnNum)!
      const lines = turnRecords.map((r, idx) => {
        const args = r.arguments
          ? JSON.stringify(r.arguments).slice(0, 100)
          : "{}"
        const err = r.error ? ` Error: ${r.error.message}` : ""
        return `  ${idx + 1}. ${r.toolName} [${r.status}]${err}\n     Args: ${args}`
      })
      return `Turn ${turnNum}:\n${lines.join("\n")}`
    })
    .join("\n\n")
}

/**
 * Build default review payload
 */
export function buildDefaultReviewPayload(notes?: string): ReviewResult {
  return {
    status: "ok",
    notes: notes?.trim() || "Review completed with no notable findings.",
    toolFeedback: [],
    unmetExpectations: [],
    planChangeNeeded: false,
    planChangeReason: undefined,
    anomaliesDetected: false,
    anomalies: [],
    recommendation: "proceed",
    ambiguityResolved: true,
    clarificationQuestions: [],
  }
}

/**
 * Build review input for a turn range
 */
export interface AutoReviewInput {
  turnNumber: number
  toolCallHistory: Array<{
    toolName: string
    status: string
    error?: { message: string }
    arguments?: Record<string, unknown>
    turnNumber: number
    expectedResults?: ToolExpectation
  }>
  plan: any | null
  expectedResults?: ToolExpectationAssignment[]
  focus: "turn_end" | "tool_error" | "run_end"
}

export function buildTurnReviewInput(
  state: XyneAgentState,
  turn: number,
  reviewFreq: number,
  minTurnNumber: number = 0,
): AutoReviewInput {
  const lastReviewTurn = state.review.lastReviewTurn ?? -1
  const startTurn = Math.max(minTurnNumber, lastReviewTurn + 1)
  const toolHistory = state.toolCallHistory.filter(
    (record: any) =>
      record.turnNumber >= startTurn && record.turnNumber <= turn,
  )

  const expectedResults: ToolExpectationAssignment[] = []
  for (let t = startTurn; t <= turn; t++) {
    const turnExpectations = state.expectationHistory.get(t)
    if (turnExpectations) {
      expectedResults.push(...turnExpectations)
    }
  }

  return {
    focus: "turn_end",
    turnNumber: turn,
    toolCallHistory: toolHistory,
    plan: state.plan,
    expectedResults,
  }
}

/**
 * Run the review LLM
 */
export async function performAutomaticReview(
  input: AutoReviewInput,
  state: XyneAgentState,
  modelId?: string,
): Promise<ReviewResult> {
  const effectiveModelId = modelId || defaultFastModel || defaultBestModel

  const delegationNote =
    state.delegationEnabled === false
      ? "- Delegation tools (list_custom_agents/run_public_agent) were disabled for this run; do not flag their absence."
      : "- If delegation tools are available, ensure list_custom_agents precedes run_public_agent when delegation is appropriate."

  const isFirstReview = state.review.lastReviewResult === null

  const systemPrompt = `${buildReviewSystemPrompt({
    isFirstReview,
    delegationNote,
  })}
Respond strictly in JSON matching this schema: ${JSON.stringify({
    status: "ok",
    notes: "Summary of overall findings",
    toolFeedback: [
      {
        toolName: "Tool that ran",
        outcome: "met|missed|error",
        summary: "What happened and whether expectation was satisfied",
        expectationGoal: "Expectation or success criteria that applies",
        followUp: "Specific follow-up if needed",
      },
    ],
    unmetExpectations: ["List of expectation goals still open"],
    planChangeNeeded: false,
    planChangeReason: "Why plan needs updating if true",
    anomaliesDetected: false,
    anomalies: ["Description of anomalies or ambiguities"],
    recommendation: "proceed",
    ambiguityResolved: true,
  })}
- Use native JSON booleans (true/false) for every yes/no field.
- Only emit keys defined in the schema; do not add prose outside the JSON object.`

  const toolOutputsSection = formatToolCallHistoryByTurn(input.toolCallHistory)
  const expectationsSection = formatExpectationsForReview(input.expectedResults)

  // Build context from gathered fragments
  const fragmentsSection =
    state.allFragments?.length > 0
      ? `Retrieved Context Fragments:\n${state.allFragments
          .map(
            (f: any, i: number) =>
              `[${i}] ${f.source?.title || "Unknown"} (${f.source?.app || "Unknown"})\n${f.content?.substring(0, 500) || "No content"}...`,
          )
          .join("\n\n")}`
      : "No context fragments retrieved yet."

  const userPrompt = [
    `User Question:\n${state.message.text}`,
    state.plan
      ? `Execution Plan Snapshot:\n${JSON.stringify(state.plan, null, 2)}`
      : "",
    `Recent Tool Activity:\n${toolOutputsSection}`,
    fragmentsSection,
    `Expectations:\n${expectationsSection}`,
    `Review Focus: ${input.focus} (evaluating through turn ${input.turnNumber})`,
  ]
    .filter(Boolean)
    .join("\n\n")

  const messages: Message[] = [
    ...(isFirstReview && state.conversationHistoryMessages
      ? state.conversationHistoryMessages
      : []),
    {
      role: ConversationRole.USER,
      content: [{ text: userPrompt }],
    },
  ]

  const params: ModelParams = {
    modelId: effectiveModelId as Models,
    json: true,
    stream: false,
    temperature: 0,
    max_new_tokens: 800,
    systemPrompt,
  }

  try {
    const { text } = await getProviderByModel(
      effectiveModelId as Models,
    ).converse(messages, params)

    if (!text) {
      throw new Error("LLM returned empty review response")
    }

    // DEBUG: Log the raw LLM response before parsing
    Logger.debug(
      {
        rawResponse: text,
        responseLength: text.length,
        turn: input.turnNumber,
      },
      "[Pi-Mono Review] Raw LLM response received",
    )

    // Try to extract JSON from the response (handles prose-wrapped JSON)
    let parsed = jsonParseLLMOutput(text)

    // If parsing failed or returned non-object, try to extract JSON from prose
    if (!parsed || typeof parsed !== "object") {
      Logger.warn(
        { originalText: text.substring(0, 500) },
        "[Pi-Mono Review] Initial parse failed, attempting JSON extraction from prose",
      )

      // Try to find JSON object/array in the text
      const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0])
          Logger.info(
            { extractedJson: jsonMatch[0].substring(0, 200) },
            "[Pi-Mono Review] Extracted JSON from prose",
          )
        } catch (extractErr) {
          Logger.warn(
            { error: extractErr },
            "[Pi-Mono Review] JSON extraction from prose failed",
          )
        }
      }
    }

    // DEBUG: Log parsing result
    Logger.debug(
      {
        parsedType: typeof parsed,
        parsedIsArray: Array.isArray(parsed),
        parsedKeys:
          parsed && typeof parsed === "object" ? Object.keys(parsed) : null,
        parsedValue: parsed,
      },
      "[Pi-Mono Review] Parsed LLM response",
    )

    if (!parsed || typeof parsed !== "object") {
      Logger.error(
        {
          raw: parsed,
          originalText: text.substring(0, 1000), // First 1000 chars
          originalTextLength: text.length,
        },
        "[Pi-Mono Review] Invalid review payload - parsing failed",
      )
      return buildDefaultReviewPayload(
        `Review model returned invalid payload for turn ${input.turnNumber}`,
      )
    }

    // Validate against schema with defaults for missing fields
    // Pre-process to filter out empty toolFeedback items and normalize status
    const processedParsed = {
      ...parsed,
      status: parsed.status === "error" ? "needs_attention" : parsed.status,
      toolFeedback: (parsed.toolFeedback || [])
        .filter(
          (item: any) =>
            item &&
            typeof item === "object" &&
            (item.toolName || item.outcome || item.summary),
        )
        .map((item: any) => ({
          toolName: item.toolName || "unknown",
          outcome: item.outcome || "error",
          summary: item.summary || "No summary provided",
          expectationGoal: item.expectationGoal,
          followUp: item.followUp,
        })),
    }

    const expectedSchema = z.object({
      status: z.enum(["ok", "needs_attention"]).default("ok"),
      notes: z.string().default("Review completed"),
      toolFeedback: z
        .array(
          z.object({
            toolName: z.string(),
            outcome: z.enum(["met", "missed", "error", "unknown"]),
            summary: z.string(),
            expectationGoal: z.string().optional(),
            followUp: z.string().optional(),
          }),
        )
        .default([]),
      unmetExpectations: z.array(z.string()).default([]),
      planChangeNeeded: z.boolean().default(false),
      planChangeReason: z.string().optional(),
      anomaliesDetected: z.boolean().default(false),
      anomalies: z.array(z.string()).default([]),
      recommendation: z
        .enum(["proceed", "gather_more", "clarify_query", "replan"])
        .default("proceed"),
      ambiguityResolved: z.boolean().default(true),
      clarificationQuestions: z.array(z.string()).optional(),
    })

    const validation = expectedSchema.safeParse(processedParsed)
    if (!validation.success) {
      Logger.error(
        { error: validation.error.format(), raw: parsed },
        "[Pi-Mono Review] Review result does not match schema",
      )
      return buildDefaultReviewPayload(
        `Review model response failed validation for turn ${input.turnNumber}`,
      )
    }

    return validation.data as ReviewResult
  } catch (error) {
    Logger.error(error, "[Pi-Mono Review] Automatic review failed")
    return buildDefaultReviewPayload(
      `Automatic review fallback for turn ${input.turnNumber}: ${getErrorMessage(error)}`,
    )
  }
}

/**
 * Handle review outcome - update state and emit events
 */
export async function handleReviewOutcome(
  state: XyneAgentState,
  reviewResult: ReviewResult,
  turn: number,
  focus: AutoReviewInput["focus"],
  reasoningEmitter?: ReasoningEmitter,
): Promise<void> {
  // Update state
  state.review.lastReviewResult = reviewResult
  state.review.lastReviewTurn = turn
  state.ambiguityResolved = reviewResult.ambiguityResolved
  state.review.outstandingAnomalies = reviewResult.anomalies?.length
    ? reviewResult.anomalies
    : []
  state.review.clarificationQuestions = reviewResult.clarificationQuestions
    ?.length
    ? reviewResult.clarificationQuestions
    : []

  const hasAnomalies =
    reviewResult.anomaliesDetected || (reviewResult.anomalies?.length ?? 0) > 0
  const recommendation = reviewResult.recommendation ?? "proceed"

  Logger.debug(
    {
      turn,
      focus,
      recommendation,
      reviewStatus: reviewResult.status,
      ambiguityResolved: reviewResult.ambiguityResolved,
      anomaliesDetected: reviewResult.anomaliesDetected,
    },
    "[Pi-Mono Review] Review outcome applied",
  )

  // Emit events
  if (reasoningEmitter) {
    await emitReasoningEvent(
      reasoningEmitter,
      ReasoningSteps.reviewCompleted(recommendation, turn),
    )

    if (hasAnomalies) {
      await emitReasoningEvent(
        reasoningEmitter,
        ReasoningSteps.anomaliesDetected(reviewResult.anomalies ?? []),
      )
    }
  }
}
