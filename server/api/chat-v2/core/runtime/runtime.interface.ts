/**
 * Runtime Interface
 * 
 * Abstracts different LLM runtimes (pi-mono, JAF, future alternatives)
 */

import type { Tool } from "../../plugins/tools/tool.interface"

export interface AgentRuntime {
  /**
   * Create a new session
   */
  createSession(config: SessionConfig): Promise<AgentSession>
}

export interface AgentSession {
  readonly id: string

  /**
   * Send a message to the agent
   */
  sendMessage(message: string): Promise<AgentResponse>

  /**
   * Subscribe to events
   */
  subscribe(handler: EventHandler): Unsubscribe

  /**
   * Stop the session
   */
  stop(): void
}

export interface SessionConfig {
  model: string
  systemPrompt?: string
  tools?: ToolConfig[]
  temperature?: number
  maxTokens?: number
}

export interface ToolConfig {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface AgentResponse {
  content?: string
  toolCalls?: ToolCallRequest[]
  finishReason: "stop" | "tool-calls" | "length" | "error"
}

export interface ToolCallRequest {
  id: string
  tool: string
  arguments: Record<string, unknown>
}

export type EventHandler = (event: RuntimeEvent) => void
export type Unsubscribe = () => void

export type RuntimeEvent =
  | { type: "token"; content: string }
  | { type: "tool-call"; call: ToolCallRequest }
  | { type: "tool-result"; callId: string; result: unknown }
  | { type: "error"; error: Error }
  | { type: "complete"; finishReason: string }
