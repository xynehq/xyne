// Headless wrapper around `runPiMonoTurn` for batch processing.
//
// Each row in a batch is an independent question — no shared session state
// between rows. We achieve isolation by passing a unique synthetic
// "conversationId" per question (so the per-conv SessionManager cache in
// runner.ts allocates a fresh session) and dropping it immediately after
// the run finishes. Storage layer (chat conversations, turns, messages,
// tool-calls) is bypassed entirely — pi-mono runs, we accumulate the text
// from its callbacks, return the final answer + telemetry.

import { runPiMonoTurn, dropSession } from "../pi-mono/runner"
import type { AgentScope } from "../agent-scope"
import { baseLogger, type Log } from "../log"

const Logger = baseLogger("backendv2/batch/runQuestion")

export type RunQuestionArgs = {
  batchId: string
  rowId: string
  ordinal: number
  question: string
  userEmail: string
  modelLabel?: string
  agentScope?: AgentScope
  systemPromptOverride?: string
  thinkingLevel?: "minimal" | "low" | "medium" | "high"
  signal?: AbortSignal
  /** Bound logger from the worker (batchId, rowId, ordinal). */
  logger?: Log
}

export type RunQuestionResult = {
  answer: string
  tokensIn: number
  tokensOut: number
  durationMs: number
  error?: string
}

export async function runQuestion(
  args: RunQuestionArgs,
): Promise<RunQuestionResult> {
  const log = args.logger ?? Logger
  // Synthetic key — `runPiMonoTurn` uses this to cache a SessionManager.
  // We drop it after the run so the global cache stays bounded by in-flight
  // questions only.
  const sessionKey = `batch:${args.batchId}:row:${args.rowId}`
  const startedAt = Date.now()

  // Buffer text deltas; we don't stream anything to a client for batch jobs.
  let text = ""
  try {
    const piResult = await runPiMonoTurn({
      conversationId: sessionKey,
      userEmail: args.userEmail,
      message: args.question,
      logger: log,
      ...(args.modelLabel ? { modelLabel: args.modelLabel } : {}),
      ...(args.agentScope ? { agentScope: args.agentScope } : {}),
      ...(args.systemPromptOverride
        ? { systemPrompt: args.systemPromptOverride }
        : args.agentScope?.prompt
          ? { systemPrompt: args.agentScope.prompt }
          : {}),
      ...(args.thinkingLevel ? { thinkingLevel: args.thinkingLevel } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
      onTextDelta: (delta) => {
        text += delta
      },
      // Thinking + tool events are accumulated only for the log, not in the
      // returned answer. The user only sees the final assistant text in the
      // result sheet.
    })
    const answer = text.trim().length > 0 ? text.trim() : piResult.text.trim()
    const durationMs = Date.now() - startedAt
    // Failure surfaces in two places — `error` (a string the runner sets when
    // the iteration threw or compaction failed) and `stopReason === "error"`
    // (pi-coding-agent's signal that the LLM call itself didn't produce a
    // valid response — e.g. upstream 401/4xx, model not allowed, network
    // error swallowed by the lib). Empty `answer` + zero tokens + no
    // diagnostic error string is the smoking-gun pattern; treat it as a
    // failure with a synthetic message so the row doesn't get a misleading
    // status="done".
    // Three distinct failure modes that all look like "row finished but the
    // answer is wrong" if we don't surface them:
    //
    //   1. `piResult.error` set — explicit error from the runner.
    //   2. `stopReason === "error"` — pi-coding-agent's signal that the LLM
    //      call didn't produce a valid response (e.g. provider 401, model
    //      not allowed). Token usage is zero in this case.
    //   3. Empty `answer` AND zero tokens — the LLM call never actually ran
    //      (e.g. agent setup failed silently).
    //   4. Empty `answer` BUT tokens were spent — the model did real work
    //      (reasoning + tool calls) but never produced a final text block.
    //      Happens with reasoning-heavy models that loop on tools until
    //      pi-coding-agent's internal turn cap stops the run. Common with
    //      Nemotron on retrieval-heavy questions.
    if (
      piResult.error ||
      piResult.stopReason === "error" ||
      answer.length === 0
    ) {
      const tokensSpent =
        piResult.stats.tokenUsage.input + piResult.stats.tokenUsage.output > 0
      const errMsg =
        piResult.error ??
        (piResult.stopReason === "error"
          ? "LLM call failed (stopReason=error) — usually means the upstream provider rejected the request. Check model access for the selected label."
          : tokensSpent
            ? `Model produced no final answer text after ${String(piResult.stats.tokenUsage.input)} input / ${String(piResult.stats.tokenUsage.output)} output tokens. Usually means the model looped on tool calls without synthesizing an answer — try a different model or a more specific question.`
            : "pi-mono returned no text and no token usage — the LLM call likely never executed. Check model configuration and LiteLLM access.")
      return {
        answer,
        tokensIn: piResult.stats.tokenUsage.input,
        tokensOut: piResult.stats.tokenUsage.output,
        durationMs,
        error: errMsg,
      }
    }
    return {
      answer,
      tokensIn: piResult.stats.tokenUsage.input,
      tokensOut: piResult.stats.tokenUsage.output,
      durationMs,
    }
  } catch (err) {
    const durationMs = Date.now() - startedAt
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err }, "runQuestion: pi-mono threw")
    return {
      answer: text.trim(),
      tokensIn: 0,
      tokensOut: 0,
      durationMs,
      error: message,
    }
  } finally {
    // Free the SessionManager so 5,000-row batches don't leak 5,000 sessions
    // in process memory.
    dropSession(sessionKey)
  }
}
