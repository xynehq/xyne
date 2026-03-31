/**
 * Simplified Runtime for Pi-Mono Agent Sessions
 *
 * Creates pi-mono sessions with Xyne extension and state.
 */

import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  AuthStorage,
  DefaultResourceLoader,
  type CreateAgentSessionOptions,
  type AgentSession as PiMonoAgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent"
import type { TSchema } from "@sinclair/typebox"
import type { XyneAgentState } from "../adapter"
import {
  setExtensionState,
  default as xyneExtension,
} from "../pi-mono-extension"
import type { ReasoningEmitter } from "@/api/chat/reasoning-steps"

export type Tool = ToolDefinition<TSchema, unknown, any>

export interface XyneRuntimeConfig {
  model: string
  systemPrompt: string
  tools: Tool[]
  baseUrl: string
  apiKey?: string
  xyneState: XyneAgentState
  currentTurn: { value: number }
  agenticModelId: string
  message: string
  email: string
  emitReasoningStep: ReasoningEmitter
}

/**
 * Create pi-mono runtime with Xyne extension
 */
export async function createXyneRuntime(config: XyneRuntimeConfig) {
  // Set extension state BEFORE creating session (required SDK pattern)
  setExtensionState({
    xyneState: config.xyneState,
    currentTurn: config.currentTurn,
    agenticModelId: config.agenticModelId,
    message: config.message,
    email: config.email,
    emitReasoningStep: config.emitReasoningStep,
  })

  // Configure auth
  const authStorage = AuthStorage.create()
  if (config.apiKey) {
    authStorage.set("litellm", { type: "api_key", key: config.apiKey })
  }

  // Create resource loader with Xyne extension
  const resourceLoader = new DefaultResourceLoader({
    systemPrompt: config.systemPrompt,
    extensionFactories: [xyneExtension],
  })
  await resourceLoader.reload()

  // Build model config
  const model = buildModel(config.model, config.baseUrl)

  // Create session with settings
  const { session } = await createAgentSession({
    model,
    customTools: config.tools,
    tools: [],
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: false },
    }),
  })

  session.agent.setSystemPrompt(config.systemPrompt)
  return { session, xyneState: config.xyneState }
}

function buildModel(modelId: string, baseUrl: string) {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions" as const,
    provider: "litellm",
    baseUrl,
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
}
