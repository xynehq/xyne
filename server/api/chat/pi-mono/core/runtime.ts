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
  return {
    async start(message: string) {
      await piSession.prompt(message)
    },

    subscribe(handler) {
      return piSession.subscribe(handler)
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

  const resourceLoader =
    config.resourceLoader ??
    new DefaultResourceLoader({
      cwd: "/tmp",
      systemPrompt: config.systemPrompt,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    })

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
