import type { Model } from "@mariozechner/pi-ai"
import {
  type AgentSessionEvent,
  AuthStorage,
  type CreateAgentSessionOptions,
  DefaultResourceLoader,
  ModelRegistry,
  type AgentSession as PiMonoAgentSession,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@mariozechner/pi-coding-agent"

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

  let resourceLoader = config.resourceLoader
  if (!resourceLoader) {
    resourceLoader = new DefaultResourceLoader({
      cwd: "/tmp",
      systemPrompt: config.systemPrompt,
      appendSystemPrompt: config.appendSystemPrompt,
      extensionFactories: config.extensions ?? [],
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
  const sessionOptions: CreateAgentSessionOptions = {
    model: model,
    tools: [],
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
              const text = typeof content === "string" ? content : undefined
              const usage = e.message.usage
              debugSink.emitResponse({
                receivedAt: Date.now(),
                ...(e.message.stopReason
                  ? { stopReason: e.message.stopReason }
                  : {}),
                ...(text !== undefined ? { text } : {}),
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

            // Detect agent end
            if (evt.type === "agent_end") {
              done = true
            }
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
            done = true
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
              if (evt.type === "agent_end") {
                return
              }
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
