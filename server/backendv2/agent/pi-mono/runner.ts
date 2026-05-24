// Pi-mono runner — thin wrapper around `createRAGAgent` for backendv2.
//
// Owns: per-conversation `SessionManager.inMemory()` cache, model resolution,
// system prompt, and the event loop that turns pi-mono's RAGEvent stream
// into per-event callbacks. Does NOT touch MessageRepo or StreamBus — the
// caller does, so storage concerns stay in ChatService.
//
// Storage: in-memory only (Phase 1). History/compaction summaries live in
// process memory keyed by conversationId; they die with the process. A
// DB-backed SessionStore is the next phase and will plug in here.

import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent"

import { createRAGAgent, type RAGAgent } from "@/api/chat/pi-mono/core"
import type { AgentScope, DispatchableSubAgent } from "../agent-scope"
import { buildToolsForRun } from "./tools/registry"
import {
  buildDispatchSubagentTool,
  type NestedRunPersistence,
} from "./tools/dispatch-subagent"
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt"
import {
  getActualNameFromEnum,
  getModelConfiguration,
  getModelValueFromLabel,
} from "@/ai/modelConfig"
import { Models } from "@/ai/types"
import config from "@/config"
import { baseLogger, type Log } from "../log"

const Logger = baseLogger("backendv2/pi-mono")

// Per-conversation SessionManager cache. Each SessionManager holds the full
// pi-mono session tree (messages + compaction summaries) for one conv.
const sessions = new Map<string, SessionManager>()

const getOrCreateSession = (conversationId: string): SessionManager => {
  let sm = sessions.get(conversationId)
  if (!sm) {
    sm = SessionManager.inMemory()
    sessions.set(conversationId, sm)
  }
  return sm
}

// Exported so other modules / tests can drop a session (e.g., conversation
// archive, or test cleanup).
export const dropSession = (conversationId: string): void => {
  sessions.delete(conversationId)
}

const resolveModelId = (label: string | undefined): string => {
  if (!label) {
    return config.defaultBestModel
  }
  const resolved = getModelValueFromLabel(label)
  if (resolved) {
    return resolved
  }
  if (label in Models) {
    return label
  }
  Logger.warn(
    { label, fallback: config.defaultBestModel },
    "pi-mono: model label did not resolve; using default",
  )
  return config.defaultBestModel
}

export type PiMonoToolCall = {
  toolName: string
  toolCallId: string
  args: unknown
}

export type PiMonoToolResult = {
  toolName: string
  toolCallId: string
  result: unknown
  isError: boolean
}

export type RunPiMonoTurnArgs = {
  conversationId: string
  userEmail: string
  message: string
  modelLabel?: string
  systemPrompt?: string
  signal?: AbortSignal
  /** Optional custom-agent scope. When set, RAG tools query the agent's
   *  allowlist (apps, docIds, KB collections) instead of the user-owned KB.
   *  Loaded by the chat service via `loadAgentScope`. */
  agentScope?: AgentScope
  /** Reasoning effort for the turn. Maps directly to pi-ai's ThinkingLevel.
   *  Defaults to "medium" if unset. */
  thinkingLevel?: "minimal" | "low" | "medium" | "high"
  /** Pi-mono registry tool names this turn may call. Taken literally —
   *  `undefined` (default) and `[]` both mean "no tools registered".
   *  Callers (chat service) sourced from the agent row's `tools` column.
   *  Validated by the caller before reaching the runner. */
  toolNames?: ReadonlyArray<string>
  /** M7 — sub-agents the parent can dispatch to via the dispatchSubagent
   *  tool. When non-empty AND `dispatchPersistence` is supplied, the
   *  runner appends dispatchSubagent to the toolset; otherwise the
   *  parent cannot dispatch. Sub-agents themselves never receive
   *  dispatchSubagent (flat hierarchy enforced at the runner). */
  dispatchableSubAgents?: ReadonlyArray<DispatchableSubAgent>
  /** Callbacks the dispatch tool uses to persist nested-run rows +
   *  the sub-agent's tool_call / message trace. Implemented by the
   *  chat service. Required for dispatch to be enabled. */
  dispatchPersistence?: NestedRunPersistence
  /**
   * Logger bound to the turn (conversationId, userId, turnId, runId, …).
   * If omitted, falls back to the module-level logger — useful for tests.
   */
  logger?: Log
  // Live callbacks — caller maps these to StreamBus/MessageRepo writes.
  onTextDelta?: (delta: string) => Promise<void> | void
  onThinkingDelta?: (delta: string) => Promise<void> | void
  /** Fires when a thinking block opens or closes — caller flushes pending. */
  onThinkingStart?: () => Promise<void> | void
  onThinkingEnd?: () => Promise<void> | void
  onToolCall?: (call: PiMonoToolCall) => Promise<void> | void
  onToolResult?: (result: PiMonoToolResult) => Promise<void> | void
  /** Optional per-turn debug sink. When set, the runner forwards
   *  tool-call boundaries + compaction events + agent_end totals into
   *  it; rag-agent does the same for outbound requests + per-chunk
   *  responses. The sink itself decides which events to drop based
   *  on its verbosity setting. */
  debug?: import("./debug/capture").DebugCapture
}

export type RunPiMonoTokenUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type RunPiMonoContextUsage = {
  tokens?: number
  contextWindow?: number
  percent?: number
}

export type RunPiMonoTurnResult = {
  text: string
  stopReason?: string
  error?: string
  /** Per-turn telemetry — same numbers that go into the run-completed log. */
  stats: {
    tokenUsage: RunPiMonoTokenUsage
    /** cacheRead / (cacheRead + input). 0 when nothing cached. */
    cacheHitRatio: number
    contextUsage?: RunPiMonoContextUsage
    compactionRounds: number
    retryAttempts: number
    durationMs: number
  }
}

export async function runPiMonoTurn(
  args: RunPiMonoTurnArgs,
): Promise<RunPiMonoTurnResult> {
  const log = args.logger ?? Logger
  const modelId = resolveModelId(args.modelLabel)
  const llmModelName = getActualNameFromEnum(modelId) ?? modelId

  const baseUrl = config.LiteLLMBaseUrl?.endsWith("/v1")
    ? config.LiteLLMBaseUrl
    : `${config.LiteLLMBaseUrl ?? ""}/v1`
  const apiKey = config.LiteLLMApiKey ?? ""

  const sessionManager = getOrCreateSession(args.conversationId)

  log.info(
    {
      modelLabel: args.modelLabel,
      resolvedModelId: modelId,
      llmModelName,
      messageChars: args.message.length,
    },
    "pi-mono: run starting",
  )
  const startedAt = Date.now()

  // Precedence: env override → modelConfig → global default.
  const modelCfg = getModelConfiguration(modelId)
  const contextWindow = Number(
    process.env["BACKENDV2_PI_CONTEXT_WINDOW"] ??
      String(modelCfg?.contextWindow ?? 250_000),
  )
  const reserveTokens = Number(
    process.env["BACKENDV2_PI_RESERVE_TOKENS"] ??
      String(modelCfg?.reserveTokens ?? 40_192),
  )
  const keepRecentTokens = Number(
    process.env["BACKENDV2_PI_KEEP_RECENT_TOKENS"] ??
      String(modelCfg?.keepRecentTokens ?? 50_000),
  )

  const agent: RAGAgent<unknown> = await createRAGAgent({
    model: llmModelName,
    baseUrl,
    apiKey,
    // Per-turn tool list comes from the agent row's `tools` column. The
    // builder takes the names literally — [] means "no tools". Callers
    // that need the full registry (e.g. create-time defaulting) use
    // `allRegisteredToolNames()` to materialise it explicitly.
    tools: (() => {
      const buildCtx = {
        userEmail: args.userEmail,
        logger: log,
        ...(args.agentScope ? { agentScope: args.agentScope } : {}),
      }
      const base = buildToolsForRun(args.toolNames ?? [], buildCtx)
      // M7: append the dispatch tool when the parent has ≥1 sub-agent
      // AND the chat service handed us the persistence callbacks. Both
      // are required — without persistence the nested run can't be
      // recorded and we'd silently lose the trace.
      const subs = args.dispatchableSubAgents ?? []
      if (subs.length > 0 && args.dispatchPersistence) {
        base.push(
          buildDispatchSubagentTool({
            userEmail: args.userEmail,
            logger: log,
            ...(args.agentScope ? { agentScope: args.agentScope } : {}),
            subAgents: subs,
            llm: { model: llmModelName, baseUrl, apiKey },
            // `thinkingLevel` is no longer threaded through here —
            // each sub-agent carries its own value on the
            // DispatchableSubAgent record (sub_agents.thinking_level)
            // and dispatch reads it off the resolved sub-agent.
            maxTokens: 64000,
            contextWindow,
            reserveTokens,
            keepRecentTokens,
            timeoutMs: 10 * 60 * 1000,
            persistence: args.dispatchPersistence,
          }),
        )
      }
      return base
    })(),
    systemPrompt: args.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens,
        keepRecentTokens,
      },
      retry: { enabled: true, maxRetries: 2 },
    }),
    modelOptions: {
      contextWindow,
      maxTokens: 64000,
      reasoning: true,
    },
    // Per-model sampler params from modelConfig (e.g. Nemotron-120B
    // gets temp 1.0 / top_p 0.95 per NVIDIA's card).
    ...(() => {
      const cfg = getModelConfiguration(modelId)
      return cfg?.streamOptions
        ? { streamOptions: cfg.streamOptions }
        : {}
    })(),
    // Forward the per-turn debug sink so rag-agent can record outbound
    // requests + raw provider chunks. The runner's own tool-call wraps
    // below feed the same sink.
    ...(args.debug ? { debug: args.debug } : {}),
    thinkingLevel: args.thinkingLevel ?? "medium",
    extensions: [],
    timeoutMs: 10 * 60 * 1000,
  })

  let text = ""
  let stopReason: string | undefined
  let error: string | undefined
  // Token usage accumulated across all internal turns within this run. Pi-mono
  // surfaces this on each `message_end` (under the upstream AgentSessionEvent),
  // but our RAGEvent wrapper drops it — so we read it via the raw event.
  // `cacheRead`/`cacheWrite` are the definitive prompt-cache hit signals from
  // the inference engine; previously invisible to us.
  const tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let compactionRounds = 0
  let retryAttempts = 0
  // Per-toolCallId start timestamp so the debug sink can report
  // `durationMs` on the tool_result side without each call having to
  // carry its own timer.
  const toolStartByCallId = new Map<string, number>()
  const runStartedAt = Date.now()

  const onAbort = (): void => {
    agent.stop().catch(() => {})
  }
  args.signal?.addEventListener("abort", onAbort)

  try {
    for await (const event of agent.run(args.message)) {
      // `raw` carries the original AgentSessionEvent — our RAGEvent mapper
      // doesn't forward usage stats or lifecycle events like compaction/
      // retry, so we tap into the raw stream for those. Everything else is
      // still handled via the mapped events below.
      if (event.type === "raw") {
        const e = event.event as {
          type?: string
          message?: {
            role?: string
            usage?: {
              input?: number
              output?: number
              cacheRead?: number
              cacheWrite?: number
            }
          }
          reason?: string
          aborted?: boolean
          willRetry?: boolean
          errorMessage?: string
          attempt?: number
          maxAttempts?: number
          // auto_retry_end fields
          success?: boolean
          finalError?: string
          // Compaction events carry pre/post token counts on some
          // providers; absent on others. Optional so we degrade gracefully.
          tokensBefore?: number
          tokensAfter?: number
        }
        if (
          e.type === "message_end" &&
          e.message?.role === "assistant" &&
          e.message.usage
        ) {
          const u = e.message.usage
          tokenUsage.input += u.input ?? 0
          tokenUsage.output += u.output ?? 0
          tokenUsage.cacheRead += u.cacheRead ?? 0
          tokenUsage.cacheWrite += u.cacheWrite ?? 0
        } else if (e.type === "auto_compaction_start") {
          compactionRounds++
          log.info({ reason: e.reason }, "pi-mono: auto_compaction_start")
          if (args.debug) {
            args.debug.emitCompactionStart({
              reason: e.reason ?? "threshold",
              ...(typeof e.tokensBefore === "number"
                ? { tokensBefore: e.tokensBefore }
                : {}),
              at: Date.now(),
            })
          }
        } else if (e.type === "auto_compaction_end") {
          log.info(
            {
              aborted: e.aborted,
              willRetry: e.willRetry,
              errorMessage: e.errorMessage?.slice(0, 300),
            },
            "pi-mono: auto_compaction_end",
          )
          if (args.debug) {
            args.debug.emitCompactionEnd({
              ...(typeof e.tokensAfter === "number"
                ? { tokensAfter: e.tokensAfter }
                : {}),
              at: Date.now(),
              aborted: !!e.aborted,
            })
            // An aborted compaction is a real failure — the summary
            // didn't write and the next LLM call will retry with the
            // same large context. Surface as a top-level error.
            if (e.aborted) {
              args.debug.emitError({
                message: e.errorMessage ?? "compaction aborted",
              })
            }
          }
        } else if (e.type === "auto_retry_start") {
          retryAttempts++
          log.warn(
            {
              attempt: e.attempt,
              maxAttempts: e.maxAttempts,
              errorMessage: e.errorMessage?.slice(0, 300),
            },
            "pi-mono: auto_retry_start",
          )
          if (args.debug) {
            args.debug.emitRetryAttempt({
              phase: "start",
              attempt: e.attempt ?? retryAttempts,
              ...(typeof e.maxAttempts === "number"
                ? { maxAttempts: e.maxAttempts }
                : {}),
              ...(typeof e.errorMessage === "string"
                ? { errorMessage: e.errorMessage }
                : {}),
              at: Date.now(),
            })
          }
        } else if (e.type === "auto_retry_end") {
          log.info(
            {
              attempt: e.attempt,
              success: e.success,
              finalError: e.finalError?.slice(0, 300),
            },
            "pi-mono: auto_retry_end",
          )
          if (args.debug) {
            args.debug.emitRetryAttempt({
              phase: "end",
              attempt: e.attempt ?? retryAttempts,
              ...(typeof e.success === "boolean" ? { success: e.success } : {}),
              ...(typeof e.finalError === "string"
                ? { errorMessage: e.finalError }
                : {}),
              at: Date.now(),
            })
          }
        }
        continue
      }
      switch (event.type) {
        case "text_delta": {
          if (!event.delta) {
            break
          }
          text += event.delta
          if (args.onTextDelta) {
            await args.onTextDelta(event.delta)
          }
          break
        }
        case "thinking_start": {
          if (args.onThinkingStart) {
            await args.onThinkingStart()
          }
          break
        }
        case "thinking_delta": {
          if (!event.delta) {
            break
          }
          if (args.onThinkingDelta) {
            await args.onThinkingDelta(event.delta)
          }
          break
        }
        case "thinking_end": {
          if (args.onThinkingEnd) {
            await args.onThinkingEnd()
          }
          break
        }
        case "tool_call": {
          if (args.debug) {
            toolStartByCallId.set(event.toolCallId, Date.now())
            args.debug.emitToolCallStart({
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              args: event.args,
              startedAt: Date.now(),
            })
          }
          if (args.onToolCall) {
            await args.onToolCall({
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              args: event.args,
            })
          }
          break
        }
        case "tool_result": {
          if (args.debug) {
            const startedAt = toolStartByCallId.get(event.toolCallId)
            const durationMs =
              startedAt !== undefined ? Date.now() - startedAt : 0
            toolStartByCallId.delete(event.toolCallId)
            args.debug.emitToolCallEnd({
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              durationMs,
              isError: event.isError,
              result: event.result,
            })
            // Tool errors fire as a separate `error` event in addition
            // to `tool_call_end` so the debug timeline highlights them
            // visually (the panel renders errors in red) without
            // requiring the user to expand the tool_call_end row to
            // discover the failure.
            if (event.isError) {
              const msg =
                event.result &&
                typeof event.result === "object" &&
                "error" in event.result &&
                typeof (event.result as { error?: unknown }).error === "string"
                  ? ((event.result as { error: string }).error)
                  : `${event.toolName} returned isError=true`
              args.debug.emitError({
                message: msg,
                toolName: event.toolName,
              })
            }
          }
          if (args.onToolResult) {
            await args.onToolResult({
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              result: event.result,
              isError: event.isError,
            })
          }
          break
        }
        case "message_end": {
          if (event.message.role === "assistant" && event.message.stopReason) {
            stopReason = event.message.stopReason
          }
          // Pi-mono sometimes only fills the full content on message_end (no
          // text_delta events seen) — pick it up if we didn't stream anything.
          if (
            event.message.role === "assistant" &&
            !text.trim() &&
            event.message.content
          ) {
            const content = event.message.content
            const final = typeof content === "string" ? content.trim() : ""
            if (final) {
              text = final
              if (args.onTextDelta) {
                await args.onTextDelta(final)
              }
            }
          }
          break
        }
        case "error": {
          // Previously we just stashed the message into a local — meaning
          // upstream stream errors (LiteLLM timeouts, parse failures, etc.)
          // were silently swallowed. Surface them in the run log so a stuck
          // turn has a debuggable footprint.
          error = event.error.message
          log.error(
            { errorMessage: event.error.message, code: event.error.code },
            "pi-mono: error event",
          )
          if (args.debug) {
            args.debug.emitError({ message: event.error.message })
          }
          break
        }
        default:
          break
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    log.error({ err }, "pi-mono run failed")
    if (args.debug) {
      args.debug.emitError({ message: error })
    }
  } finally {
    args.signal?.removeEventListener("abort", onAbort)
  }

  // Snapshot context usage BEFORE disposing the session — pi-mono surfaces it
  // via piSession.getContextUsage(), reachable through agent.getSession().
  // Gives a preemptive view of how close we are to the compaction threshold.
  let contextUsage:
    | { tokens?: number; contextWindow?: number; percent?: number }
    | undefined
  try {
    const sess = (
      agent as unknown as {
        getSession?: () => {
          getContextUsage?: () =>
            | { tokens?: number; contextWindow?: number; percent?: number }
            | undefined
        }
      }
    ).getSession?.()
    const usage = sess?.getContextUsage?.()
    if (usage) {
      // Build via conditional spreads — exactOptionalPropertyTypes rejects
      // explicit `: undefined` assignments to optional fields.
      contextUsage = {
        ...(usage.tokens !== undefined ? { tokens: usage.tokens } : {}),
        ...(usage.contextWindow !== undefined
          ? { contextWindow: usage.contextWindow }
          : {}),
        ...(usage.percent !== undefined ? { percent: usage.percent } : {}),
      }
    }
  } catch {
    // best-effort, never block run completion on telemetry
  }
  agent.dispose()

  const durationMs = Date.now() - startedAt
  // cacheHitRatio = cacheRead / (input + cacheRead) — the practical signal
  // of whether prompt caching is firing upstream.
  const cacheHitRatio =
    tokenUsage.cacheRead + tokenUsage.input > 0
      ? Number(
          (
            tokenUsage.cacheRead /
            (tokenUsage.cacheRead + tokenUsage.input)
          ).toFixed(3),
        )
      : 0
  const stats: RunPiMonoTurnResult["stats"] = {
    tokenUsage,
    cacheHitRatio,
    ...(contextUsage ? { contextUsage } : {}),
    compactionRounds,
    retryAttempts,
    durationMs,
  }

  log.info(
    { stopReason, error, textChars: text.length, ...stats },
    error ? "pi-mono: run errored" : "pi-mono: run completed",
  )

  if (args.debug) {
    if (error) {
      args.debug.emitError({ message: error })
    }
    args.debug.emitAgentEnd({
      stopReason: stopReason ?? (error ? "error" : "stop"),
      tokenUsage,
      durationMs: Date.now() - runStartedAt,
    })
  }

  return error
    ? { text, stopReason, error, stats }
    : { text, stopReason, stats }
}
