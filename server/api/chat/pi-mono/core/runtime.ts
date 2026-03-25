/**
 * Runtime Wrapper for Pi-Mono Agent Sessions
 *
 * Provides a clean abstraction over pi-mono's createAgentSession with
 * Xyne-compatible patterns. Handles model configuration, session creation,
 * and provides a unified interface for starting and managing agent sessions.
 */

import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent"
import type {
  AgentSessionConfig,
  AgentState,
  AgentSession,
  RuntimeConfig,
} from "./types"

/**
 * Extended configuration for Xyne-specific session creation
 */
export interface XyneSessionConfig<TState extends AgentState> {
  model: string
  systemPrompt: string
  tools: any[]
  state: TState
  baseUrl: string
  apiKey?: string
  resourceLoader?: any
}

/**
 * Create a pi-mono agent session with Xyne-compatible patterns
 *
 * @param config - Session configuration including model, tools, state
 * @param runtimeConfig - Runtime configuration for LLM backend connection
 * @returns Wrapped agent session with unified interface
 */
export async function createAgentSessionWrapper<TState extends AgentState>(
  config: AgentSessionConfig<TState>,
  runtimeConfig: RuntimeConfig,
): Promise<AgentSession<TState>> {
  // 1. Setup pi-mono model
  const piModel = {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: "litellm",
    baseUrl: runtimeConfig.baseUrl,
    reasoning: false,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    compat: {
      supportsStore: false,
      supportsStreaming: true,
      supportsToolStreaming: true,
    },
  }

  // 2. Create session
  const { session: piSession } = await createAgentSession({
    model: piModel,
    tools: [], // Disable default coding tools
    customTools: config.tools,
    resourceLoader: config.resourceLoader,
    authStorage: config.authStorage,
    modelRegistry: config.modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: false, maxRetries: 3, baseDelayMs: 1000 },
    }),
  })

  // 3. Set initial system prompt
  piSession.agent.setSystemPrompt(config.systemPrompt)

  // 4. Wrap in our interface
  const wrapper: AgentSession<TState> = {
    async start(message: string) {
      await piSession.prompt(message)
    },

    subscribe(handler) {
      return piSession.subscribe(handler)
    },

    stop() {
      // Pi-mono may have stop functionality
    },

    getUnderlyingSession() {
      return piSession
    },

    updateSystemPrompt(prompt: string) {
      piSession.agent.setSystemPrompt(prompt)
    },
  }

  return wrapper
}

/**
 * Create a complete Xyne agent session with all dependencies
 * This is a convenience function that sets up AuthStorage, ModelRegistry, and ResourceLoader
 */
export async function createXyneAgentSession<TState extends AgentState>(
  config: XyneSessionConfig<TState>,
): Promise<AgentSession<TState>> {
  // 1. Initialize AuthStorage and set API key
  const authStorage = AuthStorage.create()
  if (config.apiKey) {
    authStorage.set("litellm", {
      type: "api_key",
      key: config.apiKey,
    })
  }

  // 2. Create ModelRegistry
  const modelRegistry = new ModelRegistry(authStorage)

  // 3. Create ResourceLoader if not provided
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
  await resourceLoader.reload()

  // 4. Create session using the wrapper
  return createAgentSessionWrapper(
    {
      model: config.model,
      systemPrompt: config.systemPrompt,
      tools: config.tools,
      state: config.state,
      resourceLoader,
      authStorage,
      modelRegistry,
    },
    {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    },
  )
}
