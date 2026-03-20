/**
 * JAF-Based Agentic Architecture Schemas
 * 
 * Core data structures for the agentic system with intelligent tool orchestration,
 * automatic review, and adaptive planning.
 */

import { z } from "zod"
import type { Message as JAFMessage } from "@xynehq/jaf"
import type { Message } from "@aws-sdk/client-bedrock-runtime"
import type {
  Citation,
  FragmentImageReference,
  MinimalAgentFragment,
} from "./types"
import type { ReasoningEventPayload } from "@/shared/types"
import type { VespaSearchResults } from "@xyne/vespa-ts"

// ============================================================================
// RAW HITS & DOCUMENT-CENTRIC MEMORY (see docs/memory-architecture-across-turns.md)
// ============================================================================

/**
 * One chunk with its BM25/retrieval score. Raw from Vespa (chunks_summary + matchfeatures).
 * No answerContextMap — use only when merging and when building display via answerContextMap at filter/review/synthesis.
 */
export interface RawChunkWithScore {
  /** Stable key for dedupe (e.g. index or hash). */
  chunkKey: string
  /** Raw chunk text from Vespa. */
  content: string
  /** Chunk-level score from Vespa (e.g. bm25(chunks)). */
  score: number
}

/**
 * Raw Vespa document: one doc with all its chunks and scores. No expanded/truncated content.
 * answerContextMap is used only when building MinimalAgentFragment for filtering, review, synthesis.
 */
export interface ToolRawDocument {
  docId: string
  /** Document-level relevance from Vespa. */
  relevance: number
  source: Citation
  /** All chunks for this doc with their scores (from chunks_summary + matchfeatures). */
  chunks: RawChunkWithScore[]
  /** Original Vespa hit; required for answerContextMap when building fragment content at filter/review/synthesis. */
  vespaHit: VespaSearchResults
}

/**
 * State for a single chunk within a document. Chunks are deduplicated by chunkKey across turns.
 */
export interface ChunkState {
  content: string
  firstSeenTurn: number
  lastSeenTurn: number
  confidence: number
  /** Queries that retrieved this chunk (for scoring and provenance). */
  queries: string[]
}

/**
 * Retrieval signal: one (tool, query, confidence, turn) that contributed to this document.
 * Used for filtering (show which tools/queries found this doc) and for ranking.
 */
export interface RetrievalSignal {
  query: string
  confidence: number
  turn: number
  /** Tool that produced this hit (e.g. searchGlobal). */
  toolName?: string
}

export interface DocumentImageReference {
  /** Raw image file name stored on disk (without docIndex prefix). */
  fileName: string
  /** True when the source document is an attachment document. */
  isAttachment: boolean
}

/**
 * Document-centric state: one per docId, accumulated across turns.
 * Used for review, synthesis, and stagnation; MinimalAgentFragment[] are built on demand from this.
 */
export interface DocumentState {
  docId: string
  /** Citation for this document (from first hit). Used when building MinimalAgentFragment from chunks. */
  source: Citation
  /** All chunks seen across turns; key = chunkKey (hash(content) or chunkId). */
  chunks: Map<string, ChunkState>
  /** Every (query, confidence, turn) that produced a hit for this doc. */
  signals: RetrievalSignal[]
  /** Max confidence across signals (derived). */
  maxScore: number
  /** Aggregated relevance (e.g. max + multi-query bonus + recency). */
  relevanceScore: number
  /** Image references extracted from the document fragment content. */
  images: DocumentImageReference[]
  /** Last Vespa hit for this doc; used to build fragment content via answerContextMap at filter/review/synthesis. */
  vespaHit?: VespaSearchResults
  /** Cached fragment (built via answerContextMap or joined chunks). Invalidated when doc is updated by merge. */
  cachedFragment?: MinimalAgentFragment
}

/** Limits for document memory eviction (see memory-architecture-across-turns.md). */
export const DOCUMENT_MEMORY_MAX_DOCS = 30
/** Max chunks to keep per document; excess evicted by score (confidence + recency). */
export const DOCUMENT_MEMORY_MAX_CHUNKS_PER_DOC = 10
/** Max documents to pass to LLM (context budget). */
export const DOCUMENT_MEMORY_MAX_DOCS_FOR_LLM = 10

// ============================================================================
// TOOL OUTPUTS & TURN ARTIFACTS
// ============================================================================

export interface ToolExecutionRecordWithResult {
  toolName: string
  arguments: Record<string, unknown>
  status: "success" | "error"
  resultSummary?: string
  /** Query string for this invocation (e.g. search term). Used for ranking provenance. */
  query?: string
  /** Raw Vespa documents (doc + chunks + scores + vespaHit). Used for merge and for building fragments via answerContextMap at filter/review/synthesis. */
  rawDocuments?: ToolRawDocument[]
}

export interface CurrentTurnArtifacts {
  expectations: ToolExpectationAssignment[]
  toolOutputs: ToolExecutionRecordWithResult[]
  /** Synthetic non-Vespa docs (e.g. delegated agent responses without citations). */
  syntheticDocs: DocumentState[]
  /** Number of execution tools (non-toDoWrite) called this turn */
  executionToolsCalled: number
  /** Whether toDoWrite was called this turn (plan-only turn detection) */
  todoWriteCalled: boolean
  /** Timestamp when this turn started (for latency tracking) */
  turnStartedAt: number
}

/** Fragment + tool context (used when we build MinimalAgentFragment from DocumentState for ranking). */
export interface UnrankedFragmentWithToolContext {
  fragment: MinimalAgentFragment
  toolName: string
  toolQuery: string
  /** All retrieval signals that contributed to this document (tool/query/confidence/turn). */
  signals: RetrievalSignal[]
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
 * Tool failure tracking for 3-strike removal with turn-based cooldown
 */
export interface ToolFailureInfo {
  count: number
  lastError: string
  lastAttempt: number
  cooldownUntilTurn: number
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
  /** Incremental review checkpoint (e.g. number of docs/chunks already reviewed when using document memory). */
  lastReviewedFragmentIndex: number
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
  emitReasoning?: (payload: ReasoningEventPayload) => Promise<void>
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
  dedicatedAgentSystemPrompt?: string

  // Four-layer memory: injected at request start (episodic + retrieved chat memory)
  conversationHistoryMessages: Message[]
  episodicMemoriesText?: string
  chatMemoryText?: string

  // Clarification tracking
  clarifications: Clarification[]
  ambiguityResolved: boolean

  // Execution history
  toolCallHistory: ToolExecutionRecord[]
  /** Cross-turn document memory: accumulates reranked docs after each turn; used for synthesis and review. */
  documentMemory: Map<string, DocumentState>
  /** Current-turn document memory: raw Vespa docs from tool calls this turn only; used for filtering (reranking); merged into documentMemory after ranking, then cleared. */
  currentTurnDocumentMemory: Map<string, DocumentState>
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
  /** Per-turn count of fragments selected by ranker (used for stagnation detection). */
  turnRankedCount: Map<number, number>
  /** Per-turn count of new chunks merged into cross-turn document memory (for stagnation: no new info). */
  turnNewChunksCount: Map<number, number>

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
  status: z.enum(["ok", "needs_attention"]).default("needs_attention"),
  notes: z.string().default(""),
  toolFeedback: z.array(ToolReviewFindingSchema).default([]),
  unmetExpectations: z.array(z.string()).default([]),
  planChangeNeeded: z.boolean().default(false),
  planChangeReason: z.string().optional(),
  anomaliesDetected: z.boolean().default(false),
  anomalies: z.array(z.string()).default([]),
  recommendation: z
    .enum(["proceed", "gather_more", "clarify_query", "replan"])
    .default("proceed"),
  ambiguityResolved: z.boolean().default(false),
  clarificationQuestions: z.array(z.string()).default([]),
})
