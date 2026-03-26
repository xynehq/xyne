/**
 * Chat V2 - New Architecture
 * 
 * Phase 4: Complete implementation with Orchestrator, Strategies, and API layer
 * 
 * @module chat-v2
 */

import config from "@/config"

// Feature flag
export const CHAT_V2_ENABLED = config.features?.chatV2 === true || process.env.CHAT_V2_ENABLED === "true"

// Re-export types for consumption
export type { ChatRequest } from "./models/chat-request"
export type { ChatEvent } from "./shared/events"
export { ChatMode } from "./core/strategies/chat-mode-strategy"
export type { RequestContextLike as RequestContext, JWTPayload, RequestId } from "./core/orchestrator/request-context.types"
export { RequestContext as RequestContextClass } from "./core/orchestrator/request-context"
export type { Tool, ToolExecutionContext } from "./plugins/tools/tool.interface"

// Phase 1 exports - Interfaces and registries
export { ToolRegistry } from "./plugins/tools/tool-registry"
export { ChatModeStrategyRegistry } from "./core/strategies/chat-mode-strategy"

// Phase 4 exports - Orchestrator
export { ChatOrchestrator } from "./core/orchestrator/chat-orchestrator"
export { createOrchestrator, getGlobalOrchestrator, resetGlobalOrchestrator } from "./core/orchestrator/orchestrator-factory"

// Models
export * from "./models"

// Shared
export * from "./shared"

// Core
export type { DependencyContainer, ChatConfig } from "./core/orchestrator/dependency-container.types"
export { createDependencyContainer } from "./core/orchestrator/dependency-container"
export type { AgentRuntime, AgentSession, SessionConfig, AgentResponse } from "./core/runtime/runtime.interface"

// Runtime adapters
export { PiMonoRuntime } from "./core/runtime/pi-mono-runtime"

// Strategies
export type { ChatModeStrategy } from "./core/strategies/chat-mode-strategy"
export { NormalChatStrategy } from "./core/strategies/normal-chat.strategy"
export { AgenticChatStrategy } from "./core/strategies/agentic-chat.strategy"
export { AttachmentChatStrategy } from "./core/strategies/attachment-chat.strategy"
export { KnowledgeBaseChatStrategy } from "./core/strategies/knowledge-base-chat.strategy"

// API exports
export { default as chatV2Routes } from "./api/routes"
export { chatHandler } from "./api/handlers/chat.handler"

// Legacy bridge
export { executeLegacy } from "./legacy/bridge"
