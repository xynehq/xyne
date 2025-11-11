/**
 * JAF-Based Agentic Architecture Schemas
 * 
 * Core data structures for the agentic system with intelligent tool orchestration,
 * automatic review, and adaptive planning.
 */

import { z } from "zod"
import type { MinimalAgentFragment } from "./types"

// ============================================================================
// CORE CONTEXT SCHEMAS
// ============================================================================

/**
 * SubTask represents a single sub-goal in the execution plan
 */
export interface SubTask {
  id: string
  description: string // The sub-goal this task achieves
  status: "pending" | "in_progress" | "completed" | "blocked" | "failed"
  toolsRequired: string[] // All tools needed to achieve this sub-goal
  result?: string
  completedAt?: number
  error?: string
}

/**
 * PlanState - Execution plan with task-based sequential execution
 */
export interface PlanState {
  id: string
  goal: string
  subTasks: SubTask[]
  chainOfThought: string
  needsClarification: boolean
  clarificationPrompt: string | null
  candidateAgents: string[]
  createdAt: number
  updatedAt: number
}

/**
 * Clarification tracking for ambiguous queries
 */
export interface Clarification {
  question: string
  answer: string
  timestamp: number
}

/**
 * Tool failure tracking for 3-strike removal
 */
export interface ToolFailureInfo {
  count: number
  lastError: string
  lastAttempt: number
}

/**
 * Decision log entry for debugging and analysis
 */
export interface Decision {
  id: string
  timestamp: number
  type: "tool_selection" | "plan_modification" | "strategy_change" | "error_recovery"
  reasoning: string
  outcome: "success" | "failure" | "pending"
  relatedToolCalls: string[]
}

/**
 * Review state for automatic turn-end review
 */
export interface ReviewState {
  lastReviewTurn: number | null
  reviewFrequency: number // Review every N turns
  lastReviewSummary: string | null
}

/**
 * AgentRunContext - Core state container for entire execution lifecycle
 */
export interface AgentRunContext {
  // Request metadata
  user: {
    email: string
    workspaceId: string
    id: string
    numericId?: number
    workspaceNumericId?: number
  }
  chat: {
    externalId: string
    metadata: Record<string, unknown>
  }
  message: {
    text: string
    attachments: Array<{ fileId: string; isImage: boolean }>
    timestamp: string
  }

  // Planning state
  plan: PlanState | null
  currentSubTask: string | null // Active substep ID
  userContext: string
  agentPrompt?: string

  // Clarification tracking
  clarifications: Clarification[]
  ambiguityResolved: boolean

  // Execution history
  toolCallHistory: ToolExecutionRecord[]
  contextFragments: MinimalAgentFragment[]
  seenDocuments: Set<string> // Prevent re-fetching

  // Performance metrics
  totalLatency: number
  totalCost: number
  tokenUsage: {
    input: number
    output: number
  }

  // Agent & tool tracking
  availableAgents: AgentCapability[]
  usedAgents: string[]
  enabledTools: Set<string>

  // Error & retry tracking
  failedTools: Map<string, ToolFailureInfo>
  retryCount: number
  maxRetries: number

  // Review state
  review: ReviewState

  // Decision log (for debugging)
  decisions: Decision[]
}

// ============================================================================
// TOOL EXECUTION SCHEMAS
// ============================================================================

/**
 * ToolExecutionRecord - Complete telemetry for each tool call
 */
export interface ToolExecutionRecord {
  toolName: string
  connectorId: string | null
  agentName: string
  arguments: Record<string, unknown>
  expectedResults?: ToolExpectation
  startedAt: Date
  durationMs: number
  estimatedCostUsd: number
  resultSummary: string
  fragmentsAdded: string[] // Fragment IDs
  status: "success" | "error" | "skipped"
  error?: {
    code: string
    message: string
  }
}

// ============================================================================
// REVIEW SCHEMAS
// ============================================================================

/**
 * ReviewAction - Suggested action from review agent
 */
export interface ReviewAction {
  type: "clarify" | "reorder" | "add_step" | "remove_step" | "stop"
  target?: string // substep ID
  prompt?: string // for clarifications
  reason: string
}

/**
 * ReviewResult - Output from automatic turn-end review
 */
export interface ReviewResult {
  status: "ok" | "error"
  qualityScore: number // 0-1
  completeness: number // 0-1
  relevance: number // 0-1
  needsMoreData: boolean
  gaps: string[]
  suggestedActions: ReviewAction[]
  recommendation: "proceed" | "gather_more" | "clarify_query" | "replan"
  updatedPlan?: PlanState
  notes: string
}

/**
 * AutoReviewInput - Input for automatic review function
 */
export interface AutoReviewInput {
  turnNumber: number
  contextFragments: MinimalAgentFragment[]
  toolCallHistory: ToolExecutionRecord[]
  plan: PlanState | null
  expectedResults?: ToolExpectationAssignment[]
}

export interface ToolExpectationAssignment {
  toolName: string
  expectation: ToolExpectation
}

// ============================================================================
// CUSTOM AGENT SCHEMAS
// ============================================================================

/**
 * AgentCapability - Information about a suitable custom agent
 */
export interface AgentCapability {
  agentId: string
  agentName: string
  description: string
  capabilities: string[]
  domains: string[] // gmail, slack, drive, etc.
  suitabilityScore: number // 0-1
  confidence: number // 0-1
  estimatedCost: "low" | "medium" | "high"
  averageLatency: number // ms
}

/**
 * ListCustomAgentsInput - Input for listing suitable agents
 */
export interface ListCustomAgentsInput {
  query: string
  workspaceId: string
  requiredCapabilities?: string[]
  maxAgents?: number
}

/**
 * RunPublicAgentInput - Input for executing a custom agent
 */
export interface RunPublicAgentInput {
  agentId: string
  query: string // Modified query specific to this agent
  context?: string
  maxTokens?: number
}

// ============================================================================
// ZOD SCHEMAS FOR VALIDATION
// ============================================================================

export const SubTaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "blocked", "failed"]),
  toolsRequired: z.array(z.string()),
  result: z.string().optional(),
  completedAt: z.number().optional(),
  error: z.string().optional(),
})

export const PlanStateSchema = z.object({
  id: z.string(),
  goal: z.string(),
  subTasks: z.array(SubTaskSchema),
  chainOfThought: z.string(),
  needsClarification: z.boolean(),
  clarificationPrompt: z.string().nullable(),
  candidateAgents: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export const ListCustomAgentsInputSchema = z.object({
  query: z.string(),
  workspaceId: z.string(),
  requiredCapabilities: z.array(z.string()).optional(),
  maxAgents: z.number().default(5),
})

export const RunPublicAgentInputSchema = z.object({
  agentId: z.string(),
  query: z.string().describe("Detailed, specific query for this agent"),
  context: z.string().optional(),
  maxTokens: z.number().optional(),
})

export const ToolExpectationSchema = z.object({
  goal: z.string().min(1),
  successCriteria: z.array(z.string()).min(1),
  failureSignals: z.array(z.string()).optional(),
  stopCondition: z.string().optional(),
  evidencePlan: z.string().optional(),
})

export type ToolExpectation = z.infer<typeof ToolExpectationSchema>

export const ReviewActionSchema = z.object({
  type: z.enum(["clarify", "reorder", "add_step", "remove_step", "stop"]),
  target: z.string().optional(),
  prompt: z.string().optional(),
  reason: z.string(),
})

export const ReviewResultSchema = z.object({
  status: z.enum(["ok", "error"]),
  qualityScore: z.number().min(0).max(1),
  completeness: z.number().min(0).max(1),
  relevance: z.number().min(0).max(1),
  needsMoreData: z.boolean(),
  gaps: z.array(z.string()),
  suggestedActions: z.array(ReviewActionSchema),
  recommendation: z.enum(["proceed", "gather_more", "clarify_query", "replan"]),
  updatedPlan: PlanStateSchema.optional(),
  notes: z.string(),
})
