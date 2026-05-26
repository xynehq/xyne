import type { Model } from "@earendil-works/pi-ai"
import {
  type AgentSessionEvent,
  AuthStorage,
  calculateContextTokens,
  type CreateAgentSessionOptions,
  DefaultResourceLoader,
  ModelRegistry,
  type AgentSession as PiMonoAgentSession,
  SessionManager,
  SettingsManager,
  createAgentSession,
  estimateTokens,
  shouldCompact,
} from "@earendil-works/pi-coding-agent"

import { ragCompactionExtension } from "./rag-compaction-extension"
import type { RAGAgent, RAGAgentConfig, RAGEvent, RunOptions } from "./types"

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

export function resolveModel(
  modelInput: string | Model<any>,
  baseUrl?: string,
  options?: {
    maxTokens?: number
    contextWindow?: number
    reasoning?: boolean
    input?: ("text" | "image")[]
    cost?: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
    }
  },
): Model<"openai-completions"> {
  if (typeof modelInput !== "string") return modelInput

  return {
    id: modelInput,
    name: modelInput,
    api: "openai-completions",
    provider: "litellm",
    baseUrl: baseUrl ?? "",
    reasoning: options?.reasoning ?? false,
    input: options?.input ?? ["text", "image"],
    cost: options?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options?.contextWindow ?? 128000,
    maxTokens: options?.maxTokens ?? 4096,
    compat: {
      supportsStore: false,
      supportsStreaming: true,
      supportsToolStreaming: true,
    },
  } as Model<"openai-completions">
}

// Steering message we inject after the soft cap on mid-turn stops is hit.
// The text needs to be unambiguous to the model — vague phrasing (e.g.
// "consider answering") tends to be ignored in favour of "one more
// search". The wording below has been tuned to push the model off the
// tool path: it's framed as a hard constraint from the system, not a
// suggestion, and ends with explicit instructions on what NOT to do.
const FINAL_ANSWER_STEER_TEXT =
  "[system steering] You have reached the maximum number of search/tool iterations for this turn. " +
  "Do NOT issue any more tool calls. Using ONLY the Key findings already gathered in the compaction summary above, " +
  "produce the final answer for the user now. " +
  "If some specific sub-question can't be answered from what you already have, say so explicitly in the answer — " +
  "but do not search further. Synthesize a complete response from the existing findings."

/** Append the final-answer steering message to both the pi-mono session
 *  history (for persistence + the next compaction) and the in-memory
 *  agent state (so the very next `agent.continue()` LLM call sees it).
 *  Both writes are best-effort — if either path throws we still want
 *  the run to continue. */
function injectFinalAnswerSteer(
  piSession: PiMonoAgentSession,
  agent: { state: { messages?: unknown[] } },
  stopCount: number,
): void {
  const userMsg = {
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: `${FINAL_ANSWER_STEER_TEXT} (Triggered after ${stopCount} mid-turn compactions.)`,
      },
    ],
    timestamp: Date.now(),
  }
  try {
    ;(
      piSession.sessionManager as unknown as {
        appendMessage: (m: unknown) => unknown
      }
    ).appendMessage(userMsg)
  } catch {
    /* best-effort */
  }
  try {
    if (Array.isArray(agent.state.messages)) {
      agent.state.messages.push(userMsg)
    }
  } catch {
    /* best-effort */
  }
}

function mapEvent(event: AgentSessionEvent): RAGEvent[] {
  const events: RAGEvent[] = []
  const e = event as any

  switch (e.type) {
    case "agent_start":
      events.push({ type: "agent_start" })
      break

    case "agent_end":
      events.push({ type: "agent_end" })
      break

    case "turn_start":
      events.push({ type: "turn_start", turnIndex: e.turnIndex ?? 0 })
      break

    case "turn_end":
      events.push({ type: "turn_end", turnIndex: e.turnIndex ?? 0 })
      break

    case "tool_execution_start":
      events.push({
        type: "tool_call",
        toolName: e.toolName,
        toolCallId: e.toolCallId ?? "",
        args: e.args,
      })
      break

    case "tool_execution_end":
      // pi-coding-agent only sets the top-level `isError` flag when the tool
      // *throws*. Tools that catch a 4xx/5xx and return a structured error
      // result via `textResult(text, details, true)` end up with
      // `e.isError === false` here — which renders as a tick in the UI. Read
      // the flag off the result body too so caught-and-returned errors still
      // surface as errors downstream.
      events.push({
        type: "tool_result",
        toolName: e.toolName,
        toolCallId: e.toolCallId ?? "",
        result: e.result,
        isError: e.isError || (e.result as { isError?: boolean })?.isError === true,
      })
      break

    case "message_update": {
      const assistantEvent = e.assistantMessageEvent
      if (assistantEvent?.type === "text_delta" && assistantEvent.delta) {
        events.push({ type: "text_delta", delta: assistantEvent.delta })
      } else if (
        assistantEvent?.type === "thinking_delta" &&
        assistantEvent.delta
      ) {
        events.push({
          type: "thinking_delta",
          delta: assistantEvent.delta,
          contentIndex: assistantEvent.contentIndex,
        })
      } else if (assistantEvent?.type === "thinking_start") {
        events.push({
          type: "thinking_start",
          contentIndex: assistantEvent.contentIndex,
        })
      } else if (assistantEvent?.type === "thinking_end") {
        events.push({
          type: "thinking_end",
          contentIndex: assistantEvent.contentIndex,
        })
      }
      break
    }

    case "thinking_start":
      events.push({
        type: "thinking_start",
        contentIndex: e.contentIndex,
      })
      break

    case "thinking_end":
      events.push({
        type: "thinking_end",
        contentIndex: e.contentIndex,
        contentSignature: e.contentSignature,
      })
      break

    case "message_end":
      events.push({
        type: "message_end",
        message: {
          role: e.message?.role ?? "assistant",
          content: e.message?.content,
          stopReason: e.message?.stopReason,
        },
      })
      break

    case "error":
      events.push({
        type: "error",
        error: { message: e.error?.message ?? String(e.error) },
      })
      break
  }

  // Always include the raw event for advanced consumers
  events.push({ type: "raw", event })

  return events
}

export async function createRAGAgent<TState = unknown>(
  config: RAGAgentConfig<TState>,
): Promise<RAGAgent<TState>> {
  // --- Auth ---
  const authStorage = config.authStorage ?? AuthStorage.create()
  if (config.apiKey && !config.authStorage) {
    authStorage.set("litellm", { type: "api_key", key: config.apiKey })
  }
  const modelRegistry =
    config.modelRegistry ?? ModelRegistry.inMemory(authStorage)

  const model = resolveModel(config.model, config.baseUrl, config.modelOptions)

  // Always register the RAG-flavored compaction summarizer. Pi-coding-agent's
  // built-in template ("Goal / Done / Next Steps / file paths") is wrong for
  // search-based research turns and produces empty `(none)` summaries, which
  // strands the model with zero context after compaction. The extension
  // returns `{compaction: {summary, ...}}` so pi-mono uses our summary
  // instead of running its own compact(). See rag-compaction-extension.ts.
  const ragCompactionFactory = ragCompactionExtension({
    model,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.thinkingLevel !== undefined && config.thinkingLevel !== "off"
      ? { thinkingLevel: config.thinkingLevel }
      : {}),
  })

  let resourceLoader = config.resourceLoader
  if (!resourceLoader) {
    resourceLoader = new DefaultResourceLoader({
      // `agentDir` became a required field in 0.74.x — it's where
      // pi-coding-agent looks for on-disk extensions / skills / themes.
      // We disable all of those with `noExtensions/noSkills/noThemes/
      // noPromptTemplates` below, so the directory never actually has
      // to exist; /tmp is a safe always-present sentinel.
      cwd: "/tmp",
      agentDir: "/tmp",
      noExtensions: true,
      systemPrompt: config.systemPrompt,
      appendSystemPrompt:
        config.appendSystemPrompt === undefined
          ? undefined
          : Array.isArray(config.appendSystemPrompt)
            ? config.appendSystemPrompt
            : [config.appendSystemPrompt],
      extensionFactories: [
        ragCompactionFactory,
        ...(config.extensions ?? []),
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    })
    await resourceLoader.reload()
  }

  // --- Session ---
  const sessionManager = config.sessionManager ?? SessionManager.inMemory()

  // --- Settings ---
  const settingsManager =
    config.settingsManager ??
    SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    })

  // --- Create pi-mono session ---
  // `tools: []` in 0.74+ is an empty *allowlist* that suppresses
  // every tool including customTools. `noTools: "builtin"` disables
  // pi's defaults (read/bash/edit/write) but leaves customTools
  // registered.
  const sessionOptions: CreateAgentSessionOptions = {
    model: model,
    noTools: "builtin",
    customTools: config.tools,
    resourceLoader,
    authStorage,
    modelRegistry,
    sessionManager,
    settingsManager,
    thinkingLevel: config.thinkingLevel,
    scopedModels: config.scopedModels,
  }

  const { session: piSession } = await createAgentSession(sessionOptions)

  // Mid-turn compaction workaround for earendil-works/pi#4325.
  //
  // Pi-mono's auto-compaction only fires after a full agent_end. In a
  // tool loop with many LLM calls, the context can balloon well past
  // contextWindow before any compaction check runs — the provider may
  // then reject the request, or pi-mono's silent-overflow path strips
  // a valid response and retries (#2871). The upstream fix is to wire
  // pi-agent-core's `shouldStopAfterTurn` hook into the coding-agent
  // layer's compaction trigger; that primitive exists in 0.74+ but is
  // not exposed on `Agent` and not yet wired by coding-agent.
  //
  // We work around it by monkey-patching `agent.createLoopConfig` to
  // inject `shouldStopAfterTurn` ourselves. When it returns true the
  // loop emits `agent_end` cleanly; pi-coding-agent's existing
  // `_runAgentPrompt → _handlePostAgentRun → _checkCompaction →
  // agent.continue()` machinery (agent-session.js:642) then runs
  // compaction and resumes the loop on the compacted history.
  //
  // Kill-switch: `BACKENDV2_PI_MID_TURN_COMPACTION=false` skips the
  // patch entirely so we can disable instantly without redeploying.
  if (process.env["BACKENDV2_PI_MID_TURN_COMPACTION"] !== "false") {
    type ShouldStopCtx = {
      message: { stopReason?: string; usage?: unknown }
      toolResults?: unknown[]
    }
    type LoopCfg = { shouldStopAfterTurn?: (ctx: ShouldStopCtx) => boolean }
    const agent = piSession.agent as unknown as {
      createLoopConfig: (opts?: unknown) => LoopCfg
      state: { model?: { contextWindow?: number } }
    }
    const origCreateLoopConfig = agent.createLoopConfig.bind(agent)
    const debugSink = config.debug

    // Stashed between shouldStopAfterTurn and the patched
    // _checkCompaction: the trailing tool-results token estimate from
    // the just-finished turn. Set when our hook decides to halt,
    // consumed (and cleared) by _checkCompaction so its threshold
    // math agrees with ours. Cleared on read.
    let pendingTrailingTokens = 0
    // Soft-cap on how many times our hook is allowed to fire mid-turn
    // stops within a single `prompt()` call. After the cap the model
    // tends to be in a tool-spamming loop (re-searching the same regs
    // with slight rewordings) and another compaction just feeds it more
    // tokens to chew on. Once we cross the cap, _checkCompaction below
    // still runs compaction one last time AND injects a "produce final
    // answer now" steering user message so the next turn is forced to
    // synthesize instead of search.
    // Configurable via `BACKENDV2_PI_MAX_MID_TURN_STOPS`; default 4.
    const maxMidTurnStops = Math.max(
      1,
      Number(process.env["BACKENDV2_PI_MAX_MID_TURN_STOPS"] ?? "4"),
    )
    let midTurnStopCount = 0
    agent.createLoopConfig = (opts?: unknown): LoopCfg => {
      const cfg = origCreateLoopConfig(opts)
      cfg.shouldStopAfterTurn = (ctx): boolean => {
        const settings = piSession.settingsManager.getCompactionSettings()
        if (!settings.enabled) return false
        const { message } = ctx
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          return false
        }
        const ctxWindow = agent.state.model?.contextWindow ?? 0
        if (ctxWindow <= 0) return false
        if (!message.usage) return false
        const baseTokens = calculateContextTokens(
          message.usage as Parameters<typeof calculateContextTokens>[0],
        )
        const toolResults = Array.isArray(ctx.toolResults) ? ctx.toolResults : []
        let trailing = 0
        for (const t of toolResults) {
          trailing += estimateTokens(t as Parameters<typeof estimateTokens>[0])
        }
        const contextTokens = baseTokens + trailing
        const stop = shouldCompact(contextTokens, ctxWindow, settings)
        if (stop) {
          midTurnStopCount += 1
          pendingTrailingTokens = trailing
          if (debugSink) {
            debugSink.emitMidTurnStop({
              contextTokens,
              contextWindow: ctxWindow,
              reserveTokens: settings.reserveTokens,
              at: Date.now(),
            })
          }
        }
        return stop
      }
      return cfg
    }

    // Patch _checkCompaction to agree with our hook. Pi-mono's
    // default uses assistantMessage.usage only — that misses tool
    // results that landed AFTER the assistant call. When our hook
    // forced agent_end with a trailing-tokens > 0, fold those into
    // the threshold check here so compaction actually fires. See
    // earendil-works/pi#4550 (auto-closed) for the equivalent
    // upstream fix.
    const session = piSession as unknown as {
      _checkCompaction: (
        msg: { stopReason?: string; usage?: unknown },
        skipAbortedCheck?: boolean,
      ) => Promise<boolean>
      _runAutoCompaction: (
        reason: string,
        willRetry: boolean,
      ) => Promise<boolean>
      settingsManager: typeof piSession.settingsManager
    }
    // Track whether the most recent _runAutoCompaction succeeded — pi-mono
    // returns `hasQueuedMessages()` after a successful threshold compaction
    // (agent-session.js:1580), which is false when nothing is queued, so we
    // can't tell success-vs-failure from the return value alone. Watch the
    // `compaction_end` event the run emits and read it back below.
    let lastCompactionSucceeded = false
    piSession.subscribe((evt: { type: string; aborted?: boolean; result?: unknown }) => {
      if (evt.type === "compaction_start") {
        lastCompactionSucceeded = false
      } else if (
        evt.type === "compaction_end" &&
        !evt.aborted &&
        evt.result !== undefined
      ) {
        lastCompactionSucceeded = true
      }
    })
    const origCheckCompaction = session._checkCompaction.bind(session)
    session._checkCompaction = async (msg, skipAbortedCheck = true): Promise<boolean> => {
      const trailing = pendingTrailingTokens
      pendingTrailingTokens = 0
      // First try the native path. If it triggers compaction, done.
      const ranNative = await origCheckCompaction(msg, skipAbortedCheck)
      if (ranNative) return ranNative
      // Native skipped. If our hook had stashed trailing tokens,
      // re-evaluate with the combined estimate.
      if (trailing <= 0) return false
      const settings = session.settingsManager.getCompactionSettings()
      if (!settings.enabled) return false
      if (msg.stopReason === "error" || msg.stopReason === "aborted") return false
      if (!msg.usage) return false
      const ctxWindow = agent.state.model?.contextWindow ?? 0
      if (ctxWindow <= 0) return false
      const base = calculateContextTokens(
        msg.usage as Parameters<typeof calculateContextTokens>[0],
      )
      if (!shouldCompact(base + trailing, ctxWindow, settings)) return false
      const r = await session._runAutoCompaction("threshold", false)
      // When OUR hook triggered the mid-turn stop, the model hasn't yet had
      // a chance to respond to the (now compacted) tool result. Pi-mono's
      // _runAutoCompaction returns `hasQueuedMessages()` on success — false
      // when nothing's queued — which makes `_handlePostAgentRun` skip the
      // follow-up `agent.continue()`. That's correct for the natural
      // post-agent_end compaction (the model already produced its final
      // answer), but wrong for us: without a continue, the run ends with
      // tool_result as the final block and no text. Force a continue here
      // when we know compaction wrote a summary.
      if (lastCompactionSucceeded) {
        // Once we've hit the soft cap on mid-turn stops, inject a steering
        // user message telling the model to compose the final answer
        // instead of doing more searches. Without this the model tends to
        // get stuck in a search loop — re-searching the same regulations
        // with slight rewordings, even after the compaction summary tells
        // it those searches have been done. The injected message lands on
        // the (compacted) context the next `agent.continue()` sends to
        // the LLM, so the loop's last LLM call is forced to synthesize.
        if (midTurnStopCount >= maxMidTurnStops) {
          injectFinalAnswerSteer(piSession, agent, midTurnStopCount)
        }
        return true
      }
      return r
    }
  }

  // Wrap streamFn for per-model sampler params (`temperature` /
  // `topP`) AND per-turn debug capture. Both are optional; if neither
  // is set, we skip the wrapper entirely so there's zero overhead on
  // the default path. When both are set the chain is:
  //   inject temperature → mutate payload with top_p → emit request
  //   event into the debug sink → forward to the inner streamFn.
  const wantedTemp = config.streamOptions?.temperature
  const wantedTopP = config.streamOptions?.topP
  const debug = config.debug
  if (wantedTemp !== undefined || wantedTopP !== undefined || debug) {
    const innerStreamFn = piSession.agent.streamFn
    piSession.agent.streamFn = async (model, context, options) => {
      const priorOnPayload = options?.onPayload
      const onPayload = async (
        payload: unknown,
        m: unknown,
      ): Promise<unknown> => {
        // Chain the upstream extension hook first (pi-coding-agent
        // dispatches to before_provider_request handlers there).
        const next = priorOnPayload
          ? await priorOnPayload(payload as never, m as never)
          : payload
        // Inject top_p (pi-ai's StreamOptions doesn't expose it; the
        // openai-completions provider reads it from the final body).
        if (wantedTopP !== undefined && next && typeof next === "object") {
          ;(next as Record<string, unknown>)["top_p"] = wantedTopP
        }
        // Debug capture — recorded post-mutation so what the sink
        // shows matches what hits the wire. Scrubbing happens inside
        // the capture itself.
        if (debug) {
          const payloadObj =
            next && typeof next === "object" ? (next as Record<string, unknown>) : {}
          const msgs = payloadObj["messages"]
          const systemPromptChars = Array.isArray(msgs)
            ? msgs.reduce((acc: number, msg: unknown): number => {
                if (!msg || typeof msg !== "object") return acc
                const role = (msg as Record<string, unknown>)["role"]
                if (role !== "system") return acc
                const content = (msg as Record<string, unknown>)["content"]
                return acc + (typeof content === "string" ? content.length : 0)
              }, 0)
            : 0
          const modelId =
            typeof (model as { id?: unknown })?.id === "string"
              ? ((model as { id: string }).id)
              : "unknown"
          debug.emitRequest({
            sentAt: Date.now(),
            model: modelId,
            sampler: {
              ...(wantedTemp !== undefined ? { temperature: wantedTemp } : {}),
              ...(wantedTopP !== undefined ? { topP: wantedTopP } : {}),
              ...(typeof payloadObj["max_tokens"] === "number"
                ? { maxTokens: payloadObj["max_tokens"] as number }
                : typeof payloadObj["max_completion_tokens"] === "number"
                  ? { maxTokens: payloadObj["max_completion_tokens"] as number }
                  : {}),
            },
            systemPromptChars,
            payload: next,
          })
        }
        return next
      }
      return innerStreamFn(model, context, {
        ...options,
        ...(wantedTemp !== undefined ? { temperature: wantedTemp } : {}),
        onPayload,
      })
    }
  }

  // --- State ---
  let userState = config.state

  const agent: RAGAgent<TState> = {
    run(message: string, options?: RunOptions): AsyncIterable<RAGEvent> {
      return (async function* () {
        const timeoutMs =
          options?.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS

        // Set up event buffering via async queue
        const eventQueue: RAGEvent[] = []
        let done = false
        let resolveWaiting: (() => void) | null = null
        let rejectWaiting: ((err: Error) => void) | null = null

        function push(event: RAGEvent) {
          eventQueue.push(event)
          if (resolveWaiting) {
            const r = resolveWaiting
            resolveWaiting = null
            rejectWaiting = null
            r()
          }
        }

        // Subscribe to pi-mono events. When a debug sink is wired,
        // tee `message_end` (assistant role) into the sink as a
        // single `response` event so the panel pairs each request
        // with its full response. Per-chunk streaming is intentionally
        // not surfaced — it was too noisy in practice.
        const debugSink = config.debug
        const unsubscribe = piSession.subscribe((rawEvent) => {
          if (debugSink) {
            const e = rawEvent as {
              type?: string
              message?: {
                role?: string
                content?: unknown
                stopReason?: string
                usage?: {
                  input?: number
                  output?: number
                  cacheRead?: number
                  cacheWrite?: number
                }
              }
            }
            if (
              e.type === "message_end" &&
              e.message?.role === "assistant"
            ) {
              const content = e.message.content
              // Anthropic-style content: string OR array of blocks like
              //   { type: "text", text }
              //   { type: "thinking", thinking }
              //   { type: "tool_use", ... }
              // Sum text + thinking from blocks; fall back to plain
              // string for non-block content shapes.
              let text: string | undefined
              let thinking: string | undefined
              if (typeof content === "string") {
                text = content
              } else if (Array.isArray(content)) {
                const textParts: string[] = []
                const thinkingParts: string[] = []
                for (const b of content as Array<{
                  type?: string
                  text?: string
                  thinking?: string
                }>) {
                  if (b && typeof b === "object") {
                    if (b.type === "text" && typeof b.text === "string") {
                      textParts.push(b.text)
                    } else if (
                      b.type === "thinking" &&
                      typeof b.thinking === "string"
                    ) {
                      thinkingParts.push(b.thinking)
                    }
                  }
                }
                if (textParts.length > 0) text = textParts.join("\n")
                if (thinkingParts.length > 0) thinking = thinkingParts.join("\n")
              }
              const usage = e.message.usage
              debugSink.emitResponse({
                receivedAt: Date.now(),
                ...(e.message.stopReason
                  ? { stopReason: e.message.stopReason }
                  : {}),
                ...(text !== undefined && text.length > 0 ? { text } : {}),
                ...(thinking !== undefined && thinking.length > 0
                  ? { thinking }
                  : {}),
                ...(usage
                  ? {
                      tokenUsage: {
                        input: usage.input ?? 0,
                        output: usage.output ?? 0,
                        cacheRead: usage.cacheRead ?? 0,
                        cacheWrite: usage.cacheWrite ?? 0,
                      },
                    }
                  : {}),
              })
            }
          }
          const mapped = mapEvent(rawEvent as AgentSessionEvent)
          for (const evt of mapped) {
            push(evt)
            // NOTE: `agent_end` is intentionally NOT treated as terminal here.
            // The mid-turn compaction workaround above makes pi-coding-agent
            // emit `agent_end` mid-run (to trigger compaction + `continue()`),
            // after which more turns — including the final answer — follow. The
            // run is only truly over when `promptPromise` settles, which marks
            // `done` (see `.finally` below). Marking `done` on `agent_end` here
            // would make the generator return on the compaction signal and drop
            // the post-compaction answer (blank turn).
          }
        })

        const promptPromise = piSession
          .prompt(
            message,
            options?.images && options.images.length > 0
              ? { images: options.images }
              : undefined,
          )
          .catch((err: any) => {
            push({
              type: "error",
              error: { message: err?.message ?? String(err) },
            })
          })
          .finally(() => {
            // The run is complete only once `prompt()` settles — i.e. after
            // every mid-turn compaction cycle and its follow-up turns. Mark
            // `done` and wake any pending waiter so the generator drains all
            // remaining events (including the post-compaction final answer)
            // before it ends.
            done = true
            if (resolveWaiting) {
              const r = resolveWaiting
              resolveWaiting = null
              rejectWaiting = null
              r()
            }
          })

        // Timeout timer
        const timeoutId = setTimeout(() => {
          push({
            type: "error",
            error: { message: `Agent timed out after ${timeoutMs}ms` },
          })
          done = true
          if (rejectWaiting) {
            rejectWaiting(new Error("timeout"))
            resolveWaiting = null
            rejectWaiting = null
          }
        }, timeoutMs)

        try {
          // Yield events as they arrive
          while (true) {
            // Drain buffered events
            while (eventQueue.length > 0) {
              const evt = eventQueue.shift()!
              yield evt
              // Do NOT return on `agent_end` — under mid-turn compaction it is
              // followed by more turns (the post-compaction answer). The
              // generator ends below via `done`, set when `promptPromise`
              // settles, after every remaining event has been drained.
            }

            if (done) return

            // Wait for next event
            await new Promise<void>((resolve, reject) => {
              resolveWaiting = resolve
              rejectWaiting = reject
            })
          }
        } finally {
          clearTimeout(timeoutId)
          unsubscribe()
          // Ensure prompt completes
          await promptPromise.catch(() => {})
        }
      })()
    },

    async stop() {
      await piSession.abort()
    },

    getSession() {
      return piSession
    },

    getState() {
      return userState
    },

    dispose() {
      piSession.dispose()
    },
  }

  return agent
}
