/**
 * JAF-Based Agentic Architecture Schemas
 * 
 * Core data structures for the agentic system with intelligent tool orchestration,
 * automatic review, and adaptive planning.
 */

import { z } from "zod"
import type { Message as JAFMessage } from "@xynehq/jaf"
import type {
  FragmentImageReference,
  MinimalAgentFragment,
} from "./types"

export interface ToolExecutionRecordWithResult {
  toolName: string
  arguments: Record<string, unknown>
  status: "success" | "error"
  resultSummary?: string
  fragments?: MinimalAgentFragment[]
}

export interface CurrentTurnArtifacts {
  fragments: MinimalAgentFragment[]
  expectations: ToolExpectationAssignment[]
  toolOutputs: ToolExecutionRecordWithResult[]
  images: FragmentImageReference[]
}

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
  goal: string
  subTasks: SubTask[]
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
  outstandingAnomalies: string[]
  clarificationQuestions: string[]
  lastReviewResult: ReviewResult | null
  lockedByFinalSynthesis: boolean
  lockedAtTurn: number | null
  pendingReview?: Promise<void>
  cachedPlanSummary?: {
    hash: string
    summary: string
  }
  cachedContextSummary?: {
    hash: string
    summary: string
  }
}

export interface AgentRuntimeCallbacks {
  streamAnswerText?: (text: string) => Promise<void>
  emitReasoning?: (payload: Record<string, unknown>) => Promise<void>
}

export type MCPToolDefinition = {
  toolName: string
  toolSchema?: string | null
  description?: string
}

export type MCPVirtualAgentRuntime = {
  agentId: string
  connectorId: string
  connectorName?: string
  description?: string
  tools: MCPToolDefinition[]
  client?: {
    callTool: (args: { name: string; arguments: unknown }) => Promise<unknown>
    close?: () => Promise<void>
  }
}

export interface FinalSynthesisState {
  requested: boolean
  completed: boolean
  suppressAssistantStreaming: boolean
  streamedText: string
  ackReceived: boolean
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
    id?: number
    externalId: string
    metadata: Record<string, unknown>
  }
  message: {
    text: string
    attachments: Array<{ fileId: string; isImage: boolean }>
    timestamp: string
  }
  modelId?: string

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
  seenDocuments: Set<string> // Prevent re-fetching
  allFragments: MinimalAgentFragment[]
  turnFragments: Map<number, MinimalAgentFragment[]>
  allImages: FragmentImageReference[]
  imagesByTurn: Map<number, FragmentImageReference[]>
  recentImages: FragmentImageReference[]
  currentTurnArtifacts: CurrentTurnArtifacts
  turnCount: number

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
  delegationEnabled: boolean
  mcpAgents?: MCPVirtualAgentRuntime[]

  // Error & retry tracking
  failedTools: Map<string, ToolFailureInfo>
  retryCount: number
  maxRetries: number

  // Review state
  review: ReviewState

  // Decision log (for debugging)
  decisions: Decision[]

  // Final synthesis tracking
  finalSynthesis: FinalSynthesisState
  runtime?: AgentRuntimeCallbacks
  maxOutputTokens?: number
  stopController?: AbortController
  stopSignal?: AbortSignal
  stopRequested: boolean
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
  turnNumber: number
  expectedResults?: ToolExpectation
  startedAt: Date
  durationMs: number
  estimatedCostUsd: number
  status: "success" | "error"
  error?: {
    code: string
    message: string
  }
}

// ============================================================================
// REVIEW SCHEMAS
// ============================================================================

export interface ToolReviewFinding {
  toolName: string
  outcome: "met" | "missed" | "error"
  summary: string
  expectationGoal?: string
  followUp?: string
}

/**
 * ReviewResult - Output from automatic turn-end review
 */
export interface ReviewResult {
  status: "ok" | "needs_attention"
  notes: string
  toolFeedback: ToolReviewFinding[]
  unmetExpectations: string[]
  planChangeNeeded: boolean
  planChangeReason?: string
  anomaliesDetected: boolean
  anomalies: string[]
  recommendation: "proceed" | "gather_more" | "clarify_query" | "replan"
  ambiguityResolved: boolean
  clarificationQuestions?: string[]
}

/**
 * AutoReviewInput - Input for automatic review function
 */
export interface AutoReviewInput {
  turnNumber: number
  toolCallHistory: ToolExecutionRecord[]
  plan: PlanState | null
  expectedResults?: ToolExpectationAssignment[]
  focus: "turn_end" | "tool_error" | "run_end"
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
export const ListCustomAgentsInputSchema = z.object({
  query: z.string().describe("User query to find relevant agents"),
  requiredCapabilities: z
    .array(z.string())
    .optional()
    .describe("Required agent capabilities"),
  maxAgents: z
    .number()
    .min(1)
    .max(10)
    .optional()
    .default(5)
    .describe("Maximum agents to return"),
})

export type ListCustomAgentsInput = z.infer<typeof ListCustomAgentsInputSchema>

// ============================================================================
// ZOD SCHEMAS FOR VALIDATION
// ============================================================================

export const SubTaskSchema = z.object({
  id: z.string(),
  description: z.string().describe("Clear description of what this sub-goal achieves"),
  status: z.enum(["pending", "in_progress", "completed", "blocked", "failed"]).default("pending"),
  toolsRequired: z.array(z.string()).describe("All tools needed to achieve this sub-goal"),
  result: z.string().optional(),
  completedAt: z.number().optional(),
  error: z.string().optional(),
})

export const PlanStateSchema = z.object({
  goal: z.string(),
  subTasks: z.array(SubTaskSchema),
})

export const RunPublicAgentInputSchema = z.object({
  agentId: z
    .string()
    .describe("Agent identifier returned by list_custom_agents"),
  query: z
    .string()
    .describe("Fully disambiguated, agent-specific instructions for this run"),
  context: z
    .string()
    .optional()
    .describe("Optional supporting context/snippets the agent should consider"),
  maxTokens: z
    .number()
    .optional()
    .describe("Optional upper bound on tokens/cost for the delegated agent output"),
})

export type RunPublicAgentInput = z.infer<typeof RunPublicAgentInputSchema>

export const ToolExpectationSchema = z.object({
  goal: z.string().min(1),
  successCriteria: z.array(z.string()).min(1),
  failureSignals: z.array(z.string()).optional(),
  stopCondition: z.string().optional(),
  evidencePlan: z.string().optional(),
})

export type ToolExpectation = z.infer<typeof ToolExpectationSchema>

export const ToolReviewFindingSchema = z.object({
  toolName: z.string(),
  outcome: z.enum(["met", "missed", "error"]),
  summary: z.string(),
  expectationGoal: z.string().optional(),
  followUp: z.string().optional(),
})

export const ReviewResultSchema = z.object({
  status: z.enum(["ok", "needs_attention"]),
  notes: z.string(),
  toolFeedback: z.array(ToolReviewFindingSchema),
  unmetExpectations: z.array(z.string()),
  planChangeNeeded: z.boolean(),
  planChangeReason: z.string().optional(),
  anomaliesDetected: z.boolean(),
  anomalies: z.array(z.string()),
  recommendation: z.enum(["proceed", "gather_more", "clarify_query", "replan"]),
  ambiguityResolved: z.boolean(),
  clarificationQuestions: z.array(z.string()).optional(),
})
