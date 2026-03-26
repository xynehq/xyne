/**
 * Agent Registry - Internal Agent Configuration
 *
 * Centralized registry for built-in/internal agents. Each internal agent is
 * configured declaratively rather than scattered across if/else conditions.
 *
 * Benefits:
 * - Add new agents without modifying message-agents.ts
 * - Behavior is explicit (flags) rather than implicit (conditionals)
 * - Single source of truth for agent metadata and capabilities
 */

import type { Tool } from "@xynehq/jaf"
import type {
  AgentCapability,
  AgentRunContext,
} from "./agent-schemas"
import type { AgentBrief } from "./tool-schemas"
import type { UserConnectorState } from "./resource-access"
import { Apps, type VespaSearchResults } from "@xyne/vespa-ts/types"
import { DOCUMENT_ANALYSIS_AGENT_PROMPT } from "./tools/documentAnalysis/prompt"

// ============================================================================
// TYPES
// ============================================================================

export interface InternalAgentToolContext {
  allInternalTools: Tool<unknown, AgentRunContext>[]
  connectorState: UserConnectorState
  userEmail: string
}

// DocumentState is imported from agent-schemas (to avoid circular imports with document-memory)
import type { DocumentState } from "./agent-schemas"

export interface DelegationPayloadResult {
  query: string
  isValid: boolean
  error?: string
}

export interface InternalAgentConfig {
  /** Unique agent ID (matches what the orchestrator uses to delegate) */
  id: string
  name: string
  description: string

  // ─── Behavior Flags ───
  /**
   * If false, orchestrator can delegate without resolving ambiguity first.
   * Default: true
   */
  requiresAmbiguityResolution: boolean
  /**
   * If false, skip agentic filtering (LLM-based fragment ranking).
   * Default: true
   */
  enableAgenticFiltering: boolean
  /**
   * If false, skip auto-review LLM calls.
   * Default: true
   */
  enableReview: boolean
  /**
   * If false, skip DB agent lookup (agent is virtual, not in DB).
   * Default: true
   */
  requiresDbLookup: boolean
  /**
   * If false, don't rewrite query via buildDelegatedAgentQuery().
   * Default: true
   */
  rewriteQueryForDelegation: boolean
  /**
   * If false, don't fetch chat history for episodic memory.
   * Default: true
   */
  enableEpisodicMemory: boolean
  /**
   * If false, this agent cannot delegate to other agents.
   * Default: true
   */
  enableDelegation: boolean

  // ─── Capability (for list_custom_agents) ───
  capability: AgentCapability
  brief: AgentBrief

  // ─── Instruction Strategy ───
  /**
   * Builds the full system prompt for this agent when running as a delegatee.
   * Returns the dedicatedAgentSystemPrompt string.
   */
  buildDedicatedPrompt: (ctx: AgentRunContext) => string

  /**
   * Returns the synthetic "agentPromptForLLM" JSON that normally comes from DB.
   * For internal agents this is a hardcoded JSON structure.
   */
  buildAgentPromptForLLM: () => string

  // ─── Instruction Strategy ───
  /**
   * Builds the complete system instructions for this agent.
   * If provided, overrides the default buildAgentInstructions orchestrator logic.
   * This gives the agent full control over its instruction format and content.
   */
  buildInstructions?: (params: {
    context: AgentRunContext
    tools: string[]
    dateForAI: string
    agentPromptForLLM: string
  }) => string

  // ─── Tool Strategy ───
  /**
   * Declarative list of tool names this agent is allowed to use.
   * If undefined/empty, falls through to the default tool-building logic.
   */
  allowedTools?: string[]

  // ─── Query Handling ───
  /**
   * Optional custom query builder for delegation.
   * If provided, used instead of buildDelegatedAgentQuery().
   */
  buildDelegatedQuery?: (
    rawQuery: string,
    orchestratorContext: AgentRunContext,
  ) => string

  /**
   * Optional payload parser for delegation (e.g., deep doc agent's JSON parsing).
   * If provided, executeCustomAgent calls this before delegation.
   * Returns the parsed query or null if invalid.
   */
  parseDelegationPayload?: (
    query: string,
    documentMemory: Map<string, DocumentState>,
  ) => DelegationPayloadResult | null
}

// ============================================================================
// REGISTRY
// ============================================================================

const INTERNAL_AGENTS: Record<string, InternalAgentConfig> = {}

/**
 * Register an internal agent configuration.
 * Called once at module initialization for each internal agent.
 */
export function registerInternalAgent(config: InternalAgentConfig): void {
  INTERNAL_AGENTS[config.id] = config
}

/**
 * Get the configuration for an internal agent by ID.
 * Returns null if not found (i.e., not an internal agent).
 */
export function getInternalAgentConfig(agentId: string): InternalAgentConfig | null {
  return INTERNAL_AGENTS[agentId] ?? null
}

/**
 * Check if an agent ID refers to an internal/built-in agent.
 */
export function isInternalAgent(agentId: string): boolean {
  return agentId in INTERNAL_AGENTS
}

/**
 * Get all internal agent briefs for list_custom_agents results.
 */
export function getAllInternalAgentBriefs(): AgentBrief[] {
  return Object.values(INTERNAL_AGENTS).map((a) => a.brief)
}

/**
 * Get all internal agent capabilities for list_custom_agents results.
 */
export function getAllInternalAgentCapabilities(): AgentCapability[] {
  return Object.values(INTERNAL_AGENTS).map((a) => a.capability)
}

/**
 * Format internal agents for inclusion in the system prompt.
 * Returns a structured string describing all internal agents and their capabilities.
 */
export function formatInternalAgentsForPrompt(): string {
  const agents = Object.values(INTERNAL_AGENTS)
  
  if (agents.length === 0) {
    return "No internal agents available."
  }
  
  const agentDescriptions = agents.map((agent) => {
    const inputFormat = getAgentInputFormat(agent.id)
    return `- agentId: ${agent.id}
  name: ${agent.name}
  capabilities: ${agent.capability.capabilities.join(", ")}
  when_to_use: ${agent.description}
  input_format: ${inputFormat}`
  })
  
  return agentDescriptions.join("\n\n")
}

/**
 * Get the expected input format for an internal agent.
 */
function getAgentInputFormat(agentId: string): string {
  switch (agentId) {
    case "deep_document_agent":
      return 'JSON { userQuery: string, docId: string, startingOffsets?: number[] }'
    default:
      return "string (agent-specific query)"
  }
}

/**
 * Returns true if the agent requires ambiguity resolution before delegation.
 * Falls back to true for unknown/external agents.
 */
export function requiresAmbiguityResolution(agentId: string): boolean {
  const config = getInternalAgentConfig(agentId)
  return config?.requiresAmbiguityResolution ?? true
}

// ============================================================================
// INTERNAL AGENT REGISTRATIONS
// ============================================================================

// Deep Document Agent
// Specialized agent for deep, sequential reading of documents
registerInternalAgent({
  id: "deep_document_agent",
  name: "Deep Document Agent",
  description:
    "Explores a single document intelligently using structured sampling and targeted reading to build a comprehensive understanding.",

  // Behavior flags - this agent runs without many orchestration features
  requiresAmbiguityResolution: false,
  enableAgenticFiltering: false,
  enableReview: false,
  requiresDbLookup: false,
  rewriteQueryForDelegation: false,
  enableEpisodicMemory: false,
  enableDelegation: false,

  capability: {
    agentId: "deep_document_agent",
    agentName: "Deep Document Agent",
    description:
      "Explores a single document using structured exploration (sampling + focused reading) to generate accurate summaries and insights.",
    capabilities: [
      "deep_document_analysis",
      "document_summary",
      "long_context_reading",
    ],
    domains: ["xyne_documents"],
    suitabilityScore: 1,
    confidence: 1,
    estimatedCost: "medium",
    averageLatency: 4000,
  },

  brief: {
    agentId: "deep_document_agent",
    agentName: "Deep Document Agent",
    description:
      "Specialist for intelligent document exploration using structured sampling and focused reading when fragments are insufficient.",
    capabilities: [
      "deep_document_analysis",
      "document_summary",
      "long_context_reading",
    ],
    domains: ["xyne_documents"],
    estimatedCost: "medium",
    averageLatency: 4000,
    isPublic: true,
    resourceAccess: [
      {
        app: Apps.Xyne,
        status: "available",
      },
    ],
  },

  buildDedicatedPrompt: () => DOCUMENT_ANALYSIS_AGENT_PROMPT,

  buildAgentPromptForLLM: () =>
    JSON.stringify({
      externalId: "deep_document_agent",
      name: "Deep Document Agent",
      appIntegrations: [Apps.Xyne],
      tags: ["read_document"],
    }),

  // Deep document agent has its own instruction strategy - not orchestrator-driven
  // Combines base prompt with runtime context, avoiding redundancy
  buildInstructions: ({ context, dateForAI }) => {
    return `${context.dedicatedAgentSystemPrompt}

---

## Runtime Task Context

**Current Date:** ${dateForAI}
**User:** ${context.user.email}
**Task:** ${context.message.text || "Analyze the provided document"}

**REMEMBER:** Follow the 3-phase exploration strategy in your base prompt. You MUST NOT skip the planning step.`
  },

  // Only gets the get_chunks tool (schema name: "read_document")
  allowedTools: ["read_document"],

  // Custom payload parsing for the document analysis tool
  parseDelegationPayload: (query, documentMemory) => {
    const payload = parseDeepDocumentDelegationPayload(query, documentMemory)
    if (!payload.docId) {
      return {
        query,
        isValid: false,
        error:
          'deep_document_agent requires `docId` in query JSON. Expected shape: {"userQuery":"...","docId":"...","startingOffsets":[...]}',
      }
    }
    return {
      query: buildDeepDocumentDelegatedQuery(payload),
      isValid: true,
    }
  },
})


// ============================================================================
// Deep Document Agent utilities and types
// ============================================================================

export interface DeepDocumentDelegationPayload {
  userQuery: string
  docId?: string
  totalChunks?: number
  startingOffsets?: number[]
}

/**
 * Parse deep document delegation payload from JSON query string.
 * Exported so the registry can use it for the deep document agent.
 */
export function parseDeepDocumentDelegationPayload(
  query: string,
  documentMemory: Map<string, DocumentState>,
): DeepDocumentDelegationPayload {
  const fallback: DeepDocumentDelegationPayload = { userQuery: query.trim() }

  try {
    const parsed = JSON.parse(query) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object") return fallback

    const userQuery =
      typeof parsed.userQuery === "string" && parsed.userQuery.trim().length > 0
        ? parsed.userQuery.trim()
        : fallback.userQuery
    const docId =
      typeof parsed.docId === "string" && parsed.docId.trim().length > 0
        ? parsed.docId.trim()
        : undefined
    const fields = documentMemory.get(docId ?? "")?.vespaHit?.fields
    const totalChunks =
      fields && "chunks_summary" in fields && Array.isArray(fields.chunks_summary)
        ? fields.chunks_summary.length
        : 10 // default to 10 chunks
      const startingOffsets = Array.isArray(parsed.startingOffsets)
      ? parsed.startingOffsets
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value >= 0)
          .map((value) => Math.floor(value))
          .slice(0, 10)
      : undefined

    return {
      userQuery,
      docId,
      totalChunks,
      startingOffsets:
        startingOffsets && startingOffsets.length > 0 ? startingOffsets : undefined,
    }
  } catch {
    return fallback
  }
}

/**
 * Build the delegated query for the deep document agent.
 */
export function buildDeepDocumentDelegatedQuery(
  payload: DeepDocumentDelegationPayload,
  contextSnippet?: string,
): string {
  const offsets =
    payload.startingOffsets && payload.startingOffsets.length > 0
      ? payload.startingOffsets.join(", ")
      : "none"
  const totalChunksStr =
    payload.totalChunks !== undefined
      ? `\nTotal chunks: ${payload.totalChunks}`
      : ""
  const extraContext =
    typeof contextSnippet === "string" && contextSnippet.trim().length > 0
      ? `\n\nAdditional context:\n${contextSnippet.trim()}`
      : ""

  return [
    `Document ID: ${payload.docId}`,
    totalChunksStr,
    "",
    `Task: ${payload.userQuery}`,
    "",
    `Starting offsets: ${offsets}`,
    extraContext,
  ].join("\n")
}
