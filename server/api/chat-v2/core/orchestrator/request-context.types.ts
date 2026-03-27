/**
 * RequestContext Types
 * 
 * Separated to avoid circular dependencies
 */

import type { ChatRequest, UserContext, ChatContext } from "../../models"
import type { AgentState } from "../../models/agent-state"

/**
 * Unique request identifier
 */
export type RequestId = string

/**
 * JWT payload structure
 */
export interface JWTPayload {
  sub: string // email (standard JWT claim)
  userId: number
  workspaceId: number
  workspaceNumericId?: number
  timeZone?: string
}

/**
 * Minimal RequestContext interface for type hints
 * Used by modules that need to accept RequestContext but don't need implementation details
 */
export interface RequestContextLike {
  readonly requestId: RequestId
  readonly user: UserContext
  readonly chat: ChatContext
  readonly request: ChatRequest
  readonly isAborted: boolean
  readonly elapsedMs: number
  readonly dependencies: any
  
  getAgentState(): AgentState
  setAgentState(state: AgentState): void
  setMetadata(key: string, value: unknown): void
  getMetadata(key: string): unknown | undefined
  
  // Registry accessors
  readonly tools: any
  readonly retrievers: any
  readonly citations: any
  readonly memory: any
  readonly persistence: any
  readonly promptBuilder: any
  readonly config: any
}
