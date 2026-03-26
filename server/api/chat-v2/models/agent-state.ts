import type { Fragment } from "./fragment"
import type { Plan } from "./plan"
import type { ToolExecution } from "./tool-execution"
import type { Clarification } from "./clarification"

/**
 * Mutable state maintained during agent execution
 */
export interface AgentState {
  /** Current turn number */
  turnCount: number
  
  /** Execution plan */
  plan: Plan | null
  
  /** Currently active subtask */
  currentSubTask: string | null
  
  /** All collected fragments */
  fragments: Fragment[]
  
  /** Fragments organized by turn */
  fragmentsByTurn: Map<number, Fragment[]>
  
  /** All collected images */
  images: FragmentImageReference[]
  
  /** Images organized by turn */
  imagesByTurn: Map<number, FragmentImageReference[]>
  
  /** Recently used images (sliding window) */
  recentImages: FragmentImageReference[]
  
  /** History of tool executions */
  toolHistory: ToolExecution[]
  
  /** User clarifications */
  clarifications: Clarification[]
  
  /** Whether ambiguity has been resolved */
  ambiguityResolved: boolean
  
  /** Pending clarification ID */
  pendingClarificationId?: string
  
  /** Review state */
  review: ReviewState
  
  /** Final synthesis state */
  synthesis: SynthesisState
  
  /** Performance tracking */
  metrics: ExecutionMetrics
  
  /** Decision log for debugging */
  decisions: Decision[]
  
  /** Set of seen document IDs (for dedup) */
  seenDocuments: Set<string>
  
  /** Citation mapping */
  citationMapping: Map<number, string>
}

export interface FragmentImageReference {
  fileName: string
  addedAtTurn: number
  sourceFragmentId: string
  sourceToolName: string
  isUserAttachment: boolean
}

export interface ReviewState {
  lastReviewTurn: number | null
  reviewFrequency: number
  lastReviewedFragmentIndex: number
  outstandingAnomalies: string[]
  clarificationQuestions: string[]
  lastReviewResult: ReviewResult | null
  lockedByFinalSynthesis: boolean
  lockedAtTurn: number | null
  pendingReview?: Promise<void>
  cachedPlanSummary?: string
  cachedContextSummary?: string
}

export interface ReviewResult {
  status: "ok" | "needs_attention"
  notes: string
  toolFeedback: ToolFeedback[]
  unmetExpectations: string[]
  planChangeNeeded: boolean
  planChangeReason?: string
  anomaliesDetected: boolean
  anomalies: string[]
  recommendation: "proceed" | "gather_more" | "clarify_query" | "replan"
  ambiguityResolved: boolean
  clarificationQuestions?: string[]
}

export interface ToolFeedback {
  toolName: string
  outcome: "met" | "missed" | "error"
  summary: string
  expectationGoal?: string
  followUp?: string
}

export interface SynthesisState {
  requested: boolean
  completed: boolean
  suppressAssistantStreaming: boolean
  streamedText: string
  ackReceived: boolean
}

export interface ExecutionMetrics {
  totalLatency: number
  totalCost: number
  tokenUsage: {
    input: number
    output: number
  }
}

export interface Decision {
  timestamp: Date
  turn: number
  type: string
  description: string
  reasoning?: string
}

/**
 * Immutable snapshot of agent state
 */
export interface AgentStateSnapshot {
  timestamp: Date
  turn: number
  plan: Plan | null
  fragmentCount: number
  toolCallCount: number
  metrics: ExecutionMetrics
}
