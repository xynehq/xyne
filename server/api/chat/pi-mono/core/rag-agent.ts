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

  // Apply per-model sampler params. temperature rides on
  // StreamOptions; top_p is spliced via onPayload (chained so any
  // existing extension handler still runs).
  if (
    config.streamOptions &&
    (config.streamOptions.temperature !== undefined ||
      config.streamOptions.topP !== undefined)
  ) {
    const wantedTemp = config.streamOptions.temperature
    const wantedTopP = config.streamOptions.topP
    const innerStreamFn = piSession.agent.streamFn
    piSession.agent.streamFn = async (model, context, options) => {
      const priorOnPayload = options?.onPayload
      const onPayload =
        wantedTopP !== undefined
          ? async (payload: unknown, m: unknown): Promise<unknown> => {
              const next = priorOnPayload
                ? await priorOnPayload(payload as never, m as never)
                : payload
              if (next && typeof next === "object") {
                ;(next as Record<string, unknown>)["top_p"] = wantedTopP
              }
              return next
            }
          : priorOnPayload
      return innerStreamFn(model, context, {
        ...options,
        ...(wantedTemp !== undefined ? { temperature: wantedTemp } : {}),
        ...(onPayload ? { onPayload } : {}),
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

        // Subscribe to pi-mono events
        const unsubscribe = piSession.subscribe((rawEvent) => {
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
