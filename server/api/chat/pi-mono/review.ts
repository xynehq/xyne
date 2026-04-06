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

/**
 * Build a steering message from review result to inject into conversation
 * This makes review feedback more prominent in the agent's context
 */
export function buildReviewSteeringMessage(reviewResult: ReviewResult): string {
  const parts: string[] = ["<review_feedback>"]

  parts.push(`Status: ${reviewResult.status}`)
  parts.push(`Recommendation: ${reviewResult.recommendation || "proceed"}`)

  if (reviewResult.notes) {
    parts.push(`Notes: ${reviewResult.notes}`)
  }

  if (reviewResult.planChangeNeeded && reviewResult.planChangeReason) {
    parts.push(`Plan Change Required: ${reviewResult.planChangeReason}`)
  }

  if (reviewResult.anomalies && reviewResult.anomalies.length > 0) {
    parts.push("Anomalies Detected:")
    reviewResult.anomalies.forEach((anomaly) => {
      parts.push(`  - ${anomaly}`)
    })
  }

  if (
    reviewResult.clarificationQuestions &&
    reviewResult.clarificationQuestions.length > 0
  ) {
    parts.push("Clarifications Needed:")
    reviewResult.clarificationQuestions.forEach((q) => {
      parts.push(`  - ${q}`)
    })
  }

  if (
    reviewResult.unmetExpectations &&
    reviewResult.unmetExpectations.length > 0
  ) {
    parts.push("Unmet Expectations:")
    reviewResult.unmetExpectations.forEach((exp) => {
      parts.push(`  - ${exp}`)
    })
  }

  parts.push("</review_feedback>")
  parts.push("")

  // Tailor the instruction based on the recommendation
  const rec = reviewResult.recommendation || "proceed"
  if (rec === "proceed" || rec === "replan") {
    parts.push(
      "The review recommends proceeding. Call synthesizeFinalAnswer NOW to deliver the final answer using the evidence gathered so far. For analytical questions, reason from the available facts — do not search for explicit rationale that may not exist in the documents.",
    )
  } else if (rec === "gather_more") {
    parts.push(
      [
        "Please address the above review feedback.",
        "SEARCH HARDER — do not repeat the same queries. Try these strategies:",
        "1. Use DIFFERENT keywords: synonyms, related terms, broader/narrower concepts.",
        "2. Use `limit=15` (maximum) if you haven't already.",
        "3. Use `offset` to paginate deeper into results from a productive query.",
        "4. If fragments mention related sections, chapters, or cross-references, search for those directly.",
        "5. Try extracting key phrases from partial results to form new queries.",
        "Do NOT call synthesizeFinalAnswer until you have exhausted diverse search strategies.",
      ].join("\n"),
    )
  } else {
    parts.push("Please address the above review feedback before proceeding.")
  }

  return parts.join("\n")
}

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
 * Extract a JSON object from text using balanced-brace matching.
 * Handles cases where the LLM wraps valid JSON in prose commentary.
 * Finds the FIRST top-level `{...}` with balanced braces and attempts to parse it.
 */
function extractBalancedJson(text: string): Record<string, any> | null {
  const startIdx = text.indexOf("{")
  if (startIdx === -1) return null

  let depth = 0
  let inString = false
  let escape = false

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]

    if (escape) {
      escape = false
      continue
    }

    if (ch === "\\") {
      escape = true
      continue
    }

    if (ch === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) {
        const candidate = text.slice(startIdx, i + 1)
        try {
          const parsed = JSON.parse(candidate)
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed
          }
        } catch {
          // Not valid JSON at this boundary; keep searching
        }
        // If parse failed, try the next `{`
        const nextStart = text.indexOf("{", i + 1)
        if (nextStart === -1) return null
        i = nextStart - 1 // will be incremented by loop
        depth = 0
        continue
      }
    }
  }

  return null
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
    '- Set recommendation to "gather_more" when the gathered evidence is insufficient to fully answer the user\'s question AND there are still untried query strategies. In your notes, suggest concrete alternative queries or angles the agent should try next (e.g., different keywords, synonyms, broader/narrower terms, related concepts, or using offset to paginate deeper into results).',
    '- Do NOT recommend "proceed" just because 2 searches were done. Recommend "proceed" ONLY when: (a) the evidence already gathered is sufficient to answer comprehensively, OR (b) at least 4-5 diverse search strategies have been exhausted (different keywords, synonyms, broader terms, offset pagination) and no new relevant results are appearing.',
    '- For analytical or "why" questions: the factual data (the "what") must be found first. If factual data is found but explicit rationale is missing after 4+ diverse searches, recommend "proceed" with a note to reason from available evidence. But if even the factual data is sparse, keep recommending "gather_more" with specific query suggestions.',
    "- If the same query or very similar queries have been repeated, call this out as an anomaly and suggest genuinely different terms (synonyms, related regulatory concepts, broader category terms, specific clause/section numbers if known).",
    '- Set recommendation to "clarify_query" when ambiguity remains unresolved, and "replan" only when the current plan is no longer viable.',
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
 * Defaults to gather_more so parse failures don't prematurely stop searching.
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
    recommendation: "gather_more",
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

CRITICAL OUTPUT FORMAT REQUIREMENT:
Your response MUST be a single JSON object and NOTHING else.
Do NOT include any text, commentary, markdown, or explanation before or after the JSON.
Do NOT wrap the JSON in code fences or backticks.
Do NOT include thinking tags.
Output ONLY the JSON object matching this schema:
${JSON.stringify({
  status: "ok",
  notes: "Summary of overall findings",
  toolFeedback: [
    {
      toolName: "Tool that ran",
      outcome: "met|partial|missed|error",
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
- Only emit keys defined in the schema; do not add prose outside the JSON object.
- Your ENTIRE response must be parseable by JSON.parse().`

  const toolOutputsSection = formatToolCallHistoryByTurn(input.toolCallHistory)
  const expectationsSection = formatExpectationsForReview(input.expectedResults)

  // Build context from gathered fragments — cap to most recent 30 to avoid token explosion
  const MAX_REVIEW_FRAGMENTS = 30
  const fragmentsForReview =
    state.allFragments?.length > MAX_REVIEW_FRAGMENTS
      ? state.allFragments.slice(-MAX_REVIEW_FRAGMENTS)
      : state.allFragments || []
  const fragmentsSection =
    fragmentsForReview.length > 0
      ? `Retrieved Context Fragments (showing ${fragmentsForReview.length} of ${state.allFragments?.length || 0} total):\n${fragmentsForReview
          .map(
            (f: any, i: number) =>
              `[${i}] ${f.source?.title || "Unknown"} (${f.source?.app || "Unknown"})\n${f.content?.substring(0, 300) || "No content"}...`,
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
    max_new_tokens: 1200,
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

    // Step 1: Strip thinking tags (some models wrap output in <thinking>...</thinking>)
    let cleanedText = text
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
      .replace(/<\/?thinking>/gi, "")
      .trim()

    // Step 2: Try direct parse first
    let parsed = jsonParseLLMOutput(cleanedText)

    // Step 3: If parsing failed, try balanced-brace JSON extraction
    if (!parsed || typeof parsed !== "object") {
      Logger.warn(
        { originalText: cleanedText.substring(0, 500) },
        "[Pi-Mono Review] Initial parse failed, attempting balanced-brace JSON extraction",
      )

      parsed = extractBalancedJson(cleanedText)

      if (parsed) {
        Logger.info(
          "[Pi-Mono Review] Extracted JSON via balanced-brace extraction",
        )
      }
    }

    // Step 4: Fallback — greedy regex match for any JSON-like block
    if (!parsed || typeof parsed !== "object") {
      const jsonMatch = cleanedText.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0])
          Logger.info(
            { extractedJson: jsonMatch[0].substring(0, 200) },
            "[Pi-Mono Review] Extracted JSON from prose via regex",
          )
        } catch (extractErr) {
          Logger.warn(
            { error: extractErr },
            "[Pi-Mono Review] Regex JSON extraction failed",
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
      // Step 5: Retry — send the LLM's prose back and demand JSON
      Logger.warn(
        {
          originalTextLength: text.length,
        },
        "[Pi-Mono Review] All parse attempts failed, retrying with JSON enforcement",
      )
      try {
        const retryMessages: Message[] = [
          ...messages,
          { role: ConversationRole.ASSISTANT, content: [{ text }] },
          {
            role: ConversationRole.USER,
            content: [
              {
                text: "Your response above was not valid JSON. Output ONLY a single JSON object with these fields: status, notes, recommendation (one of: proceed, gather_more, clarify_query, replan), planChangeNeeded, planChangeReason, anomalies, ambiguityResolved. No other text.",
              },
            ],
          },
        ]
        const retryResult = await getProviderByModel(
          effectiveModelId as Models,
        ).converse(retryMessages, { ...params, max_new_tokens: 600 })

        if (retryResult.text) {
          const retryClean = retryResult.text
            .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
            .replace(/<\/?thinking>/gi, "")
            .trim()
          parsed = jsonParseLLMOutput(retryClean)
          if (!parsed) parsed = extractBalancedJson(retryClean)
          if (!parsed) {
            const retryMatch = retryClean.match(/\{[\s\S]*\}/)
            if (retryMatch) {
              try {
                parsed = JSON.parse(retryMatch[0])
              } catch {}
            }
          }
          if (parsed && typeof parsed === "object") {
            Logger.info("[Pi-Mono Review] Retry parse succeeded")
          }
        }
      } catch (retryErr) {
        Logger.warn({ error: retryErr }, "[Pi-Mono Review] Retry failed")
      }
    }

    if (!parsed || typeof parsed !== "object") {
      Logger.error(
        {
          raw: parsed,
          originalText: text.substring(0, 1000),
          originalTextLength: text.length,
        },
        "[Pi-Mono Review] Invalid review payload - all parsing attempts failed",
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
            outcome: z.enum(["met", "partial", "missed", "error", "unknown"]),
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
