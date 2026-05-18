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

import { SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent"

import { createRAGAgent, type RAGAgent } from "@/api/chat/pi-mono/core"
import type { AgentScope } from "../agent-scope"
import { mathTool } from "./tools/math"
import { buildVespaTools } from "./tools/vespa"
import { getActualNameFromEnum, getModelValueFromLabel } from "@/ai/modelConfig"
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

const DEFAULT_SYSTEM_PROMPT = `You are Xyne SEBI Research, a research assistant for the Securities and Exchange Board of India (SEBI) corpus. The user's questions are typically about SEBI Acts, Regulations, Circulars, Master Circulars, Notifications, DRHPs, RHPs, and filings.

## Tools
You have three retrieval tools over the ingested SEBI corpus:
- \`vespaSearch\` — semantic search across the full corpus. Use this FIRST. Issue several varied queries (synonyms, regulation/circular numbers, section names) to maximise recall.
- \`getChunks\` — read a contiguous chunk range from a specific document (by \`docId\` + \`startChunkIndex\` + \`limit\`). Use this AFTER \`vespaSearch\` to read full context around a hit. Paginate by bumping \`startChunkIndex\`.
- \`searchWithinDoc\` — semantic search constrained to a single \`docId\`. Use to find OTHER passages (definitions, exceptions, cross-references) inside a known document.

## Research methodology — accuracy over speed
Accuracy matters more than latency. Be thorough.

1. **Decompose** the question into sub-questions before searching.
2. **Discover** candidate documents with \`vespaSearch\` — run multiple varied queries; don't trust a single search.
3. **Read** — for each promising hit, use \`getChunks\` to read surrounding context (typically 5–15 chunks around the hit). Don't answer from a snippet.
4. **Follow references** — when a chunk cites another regulation/circular/section, search for that reference and verify the cross-reference resolves correctly.
5. **Check dates** — every SEBI document has an effective date. Always identify when a rule was issued, amended, or superseded. Flag if multiple versions might apply.
6. **Synthesise** — produce a concise answer grounded entirely in retrieved text.

## Citations
Every factual statement must cite its source. Cite inline using the EXACT format \`[<docId>#<chunk_index>]\` — **plain ASCII square brackets** \`[\` and \`]\`, the document's \`docId\` (e.g. \`clf-agzja79pabewihgzkfe9pa97\`) returned in the tool output, a literal \`#\`, and the chunk index. Example: \`[clf-agzja79pabewihgzkfe9pa97#14]\`.

Do NOT use:
- Document titles, file names, or paths in citations.
- The old \`chunk:N\` syntax.
- Fullwidth brackets \`【\` \`】\` or any other bracket-like character — only \`[\` and \`]\` from ASCII.

The UI rewrites \`[docId#chunk]\` tokens into clickable citation chips that open the source document. Anything that doesn't match the regex \`\\[clf-[a-z0-9-]+#\\d+\\]\` will not render as a citation.

When the same passage supports multiple consecutive sentences, place a single citation at the end of the group. Use multiple citations only when sentences cite distinct chunks.

## When the corpus is silent
If retrieval returns nothing relevant after at least 2–3 varied queries, say so clearly. Do not fabricate regulations, dates, or section numbers.

Format final answers in clear, readable markdown.`

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

  // Compaction is env-overridable so we can rehearse it cheaply in dev.
  // Defaults are realistic production values.
  const contextWindow = Number(
    process.env["BACKENDV2_PI_CONTEXT_WINDOW"] ?? "250000",
  )
  const reserveTokens = Number(
    process.env["BACKENDV2_PI_RESERVE_TOKENS"] ?? String(32000 + 8192),
  )
  const keepRecentTokens = Number(
    process.env["BACKENDV2_PI_KEEP_RECENT_TOKENS"] ?? "50000",
  )

  const agent: RAGAgent<unknown> = await createRAGAgent({
    model: llmModelName,
    baseUrl,
    apiKey,
    tools: [
      ...buildVespaTools({
        userEmail: args.userEmail,
        logger: log,
        ...(args.agentScope ? { agentScope: args.agentScope } : {}),
      }),
      mathTool,
    ],
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
      maxTokens: 32000,
      reasoning: true,
    },
    thinkingLevel: "medium",
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
        } else if (e.type === "auto_compaction_end") {
          log.info(
            {
              aborted: e.aborted,
              willRetry: e.willRetry,
              errorMessage: e.errorMessage?.slice(0, 300),
            },
            "pi-mono: auto_compaction_end",
          )
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
          break
        }
        default:
          break
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    log.error({ err }, "pi-mono run failed")
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
  return error
    ? { text, stopReason, error, stats }
    : { text, stopReason, stats }
}
