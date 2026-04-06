/**
 * Runtime Wrapper for Pi-Mono Agent Sessions
 *
 * Provides a clean abstraction over pi-mono's createAgentSession with
 * proper type safety using pi-coding-agent's exported types.
 */

import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  type CreateAgentSessionOptions,
  type AgentSession as PiMonoAgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent"
import type { TSchema } from "@sinclair/typebox"
import type { AgentSession } from "./types"
import type { XyneAgentState } from "../adapter"
import {
  setExtensionState,
  default as piMonoTurnProcessor,
} from "../pi-mono-extension"
import type { ReasoningEmitter } from "@/api/chat/reasoning-steps"
import type { SelectMessage } from "@/db/schema"
import { MessageRole } from "@/types"
import * as fs from "fs"
import * as path from "path"

// Define AgentMessage type locally based on pi-mono SDK structure
type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "toolResult"; toolCallId: string; content: unknown }

/**
 * SDK Tool type using pi-coding-agent's ToolDefinition
 */
export type Tool = ToolDefinition<TSchema, unknown, any>

export interface AgentSessionWrapperConfig
  extends Omit<CreateAgentSessionOptions, "model" | "customTools"> {
  model: CreateAgentSessionOptions["model"] | string
  systemPrompt: string
  customTools?: Tool[]
  state?: XyneAgentState
  baseUrl?: string
  apiKey?: string
  // Extension state for pi-mono turn processor
  xyneState?: XyneAgentState
  agenticModelId?: string
  message?: string
  email?: string
  emitReasoningStep?: ReasoningEmitter
  // Initial conversation history to inject into the session
  initialMessages?: AgentMessage[]
}

/**
 * Convert SelectMessage array to pi-mono AgentMessage format
 * This enables conversation history to be injected into the session
 */
export function convertToAgentMessages(
  messages: SelectMessage[],
): AgentMessage[] {
  return messages
    .filter((msg) => !msg?.errorMessage)
    .filter(
      (msg) =>
        msg.messageRole === MessageRole.User ||
        msg.messageRole === MessageRole.Assistant,
    )
    .map((msg) => ({
      role:
        msg.messageRole === MessageRole.User
          ? ("user" as const)
          : ("assistant" as const),
      content: msg.message || "",
    }))
}

/**
 * Create an agent session with full SDK configuration support
 *
 * @param config - Session configuration
 * @returns Wrapped agent session with unified interface
 */
export async function createAgentSessionWrapper(
  config: AgentSessionWrapperConfig,
): Promise<AgentSession> {
  const model = resolveModel(config.model, config.baseUrl)

  const sessionOptions: CreateAgentSessionOptions = {
    model,
    tools: [],
    customTools: config.customTools ?? config.tools,
    resourceLoader: config.resourceLoader,
    authStorage: config.authStorage,
    modelRegistry: config.modelRegistry,
    sessionManager: config.sessionManager ?? SessionManager.inMemory(),
    settingsManager:
      config.settingsManager ??
      SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: false, maxRetries: 3, baseDelayMs: 1000 },
      }),
    thinkingLevel: config.thinkingLevel,
    scopedModels: config.scopedModels,
  }

  const { session: piSession } = await createAgentSession(sessionOptions)

  if (config.systemPrompt) {
    piSession.agent.setSystemPrompt(config.systemPrompt)
  }

  // Inject initial conversation history if provided
  // This is critical for multi-turn conversations to have context
  if (
    config.initialMessages &&
    config.initialMessages.length > 0 &&
    piSession.agent?.state?.messages
  ) {
    ;(piSession.agent.state.messages as AgentMessage[]) = [
      ...config.initialMessages,
    ]
  }

  return wrapSession(piSession, config.state)
}

function resolveModel(
  modelInput: CreateAgentSessionOptions["model"] | string,
  baseUrl?: string,
): CreateAgentSessionOptions["model"] {
  if (typeof modelInput === "string") {
    // Return a Model-compatible object
    return {
      id: modelInput,
      name: modelInput,
      api: "openai-completions",
      provider: "litellm",
      baseUrl: baseUrl ?? "",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
      compat: {
        supportsStore: false,
        supportsStreaming: true,
        supportsToolStreaming: true,
      },
    } as CreateAgentSessionOptions["model"]
  }
  return modelInput
}

function wrapSession(
  piSession: PiMonoAgentSession,
  userState?: XyneAgentState,
): AgentSession {
  // Store all events for debugging
  const eventHistory: Array<{
    type: string
    timestamp: number
    data: unknown
  }> = []

  return {
    async start(message: string) {
      await piSession.prompt(message)
    },

    subscribe(handler) {
      // Wrap handler to capture events for debugging
      const wrappedHandler = (event: any) => {
        eventHistory.push({
          type: event.type,
          timestamp: Date.now(),
          data: event,
        })
        // Keep last 1000 events to prevent memory bloat
        if (eventHistory.length > 1000) {
          eventHistory.shift()
        }
        return handler(event)
      }
      return piSession.subscribe(wrappedHandler)
    },

    stop() {
      // Check for stop method using type-safe approach
      const sessionWithStop = piSession as unknown as {
        stop?: () => void
      }
      if (typeof sessionWithStop.stop === "function") {
        sessionWithStop.stop()
      }
    },

    getUnderlyingSession() {
      return piSession
    },

    updateSystemPrompt(prompt: string) {
      piSession.agent.setSystemPrompt(prompt)
    },

    getState() {
      return userState
    },

    // Debug methods
    getEventHistory() {
      return [...eventHistory]
    },

    getSessionStats() {
      const stats = (piSession as any).getSessionStats?.()
      return (
        stats || {
          userMessages: eventHistory.filter((e) => e.type === "user_message")
            .length,
          assistantMessages: eventHistory.filter(
            (e) => e.type === "assistant_message",
          ).length,
          toolCalls: eventHistory.filter(
            (e) => e.type === "tool_execution_start",
          ).length,
          turns: eventHistory.filter((e) => e.type === "turn_start").length,
        }
      )
    },

    getAgentState() {
      return {
        messages: (piSession.agent.state as any)?.messages,
        model: (piSession.agent.state as any)?.model,
        thinkingLevel: (piSession.agent.state as any)?.thinkingLevel,
        pendingToolCalls: (piSession.agent.state as any)?.pendingToolCalls,
      }
    },

    getContextUsage() {
      return (
        (piSession as any).getContextUsage?.() || {
          tokens: 0,
          contextWindow: 128000,
          percent: 0,
        }
      )
    },

    exportToJson(): string {
      // Get pi-mono agent state
      const piMonoAgentState = {
        messages: (piSession.agent.state as any)?.messages,
        model: (piSession.agent.state as any)?.model,
        thinkingLevel: (piSession.agent.state as any)?.thinkingLevel,
        pendingToolCalls: (piSession.agent.state as any)?.pendingToolCalls,
        systemPrompt: (piSession.agent.state as any)?.systemPrompt,
      }

      // Get pi-mono session stats if available
      const piMonoSessionStats = (piSession as any).getSessionStats?.() || null

      // Custom replacer to handle Set and Map serialization
      // JSON.stringify(new Set()) → "{}" which loses all data
      const replacer = (_key: string, value: any) => {
        if (value instanceof Set) {
          return { __type: "Set", values: Array.from(value) }
        }
        if (value instanceof Map) {
          return { __type: "Map", entries: Array.from(value.entries()) }
        }
        return value
      }

      return JSON.stringify(
        {
          events: eventHistory,
          xyneState: userState,
          piMonoAgentState,
          piMonoSessionStats,
          timestamp: new Date().toISOString(),
        },
        replacer,
        2,
      )
    },

    saveToFile(filePath?: string): string {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-")

      // Default to /tmp/xyne-debug/ for easy access and cleanup
      const debugDir = process.env.XYNE_DEBUG_DIR || "/tmp/xyne-debug"
      const defaultPath = path.join(debugDir, `debug-session-${timestamp}.json`)
      const targetPath = filePath || defaultPath

      const data = this.exportToJson()

      try {
        // Ensure directory exists
        const dir = path.dirname(targetPath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }

        fs.writeFileSync(targetPath, data, "utf-8")
        console.log(`[DEBUG] Session data saved to: ${targetPath}`)
        return targetPath
      } catch (error) {
        console.error(`[DEBUG] Failed to save session data:`, error)
        throw error
      }
    },
  }
}

export async function createXyneAgentSession(
  config: AgentSessionWrapperConfig,
): Promise<AgentSession> {
  // Initialize AuthStorage
  const authStorage = config.authStorage ?? AuthStorage.create()
  if (config.apiKey && !config.authStorage) {
    authStorage.set("litellm", {
      type: "api_key",
      key: config.apiKey,
    })
  }

  // Create ModelRegistry
  const modelRegistry = config.modelRegistry ?? new ModelRegistry(authStorage)

  // Create a ResourceLoader that injects our Xyne prompt as the base systemPrompt.
  // This is critical: pi-mono's AgentSession._rebuildSystemPrompt() calls
  // resourceLoader.getSystemPrompt() and routes it through the `customPrompt`
  // path in buildSystemPrompt(), which REPLACES the default coding-agent identity.
  // Without this, the session resets to "You are an expert coding assistant..."
  // before every LLM call.
  const resourceLoader =
    config.resourceLoader ??
    new DefaultResourceLoader({
      cwd: "/tmp", // Irrelevant for search agent, prevents CWD leak
      systemPrompt: config.systemPrompt,
      noExtensions: false, // Enable extensions
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }), // Don't load AGENTS.md/CLAUDE.md
      extensionFactories: [piMonoTurnProcessor], // Register the turn-end extension
    })

  // Set up extension state BEFORE creating session (if all required fields are present)
  // if (
  //   config.xyneState &&
  //   config.agenticModelId &&
  //   config.message &&
  //   config.email &&
  //   config.emitReasoningStep
  // ) {
  //   setExtensionState({
  //     xyneState: config.xyneState,
  //     agenticModelId: config.agenticModelId,
  //     message: config.message,
  //     email: config.email,
  //     emitReasoningStep: config.emitReasoningStep,
  //   })
  // }

  if (!config.resourceLoader) {
    await resourceLoader.reload()
  }

  // Create session with all dependencies
  return createAgentSessionWrapper({
    ...config,
    authStorage,
    modelRegistry,
    resourceLoader,
  })
}
