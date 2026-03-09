/**
 * reasoning-steps.ts
 *
 * Typed factory functions for every reasoning event emitted over SSE.
 *
 * Design principles:
 *  - No freeform text matching or regex — each factory takes typed params and
 *    produces a pre-computed `displayText` + `stage`.
 *  - Pure functions: no I/O, no dependencies on Hono/SSE/context.
 *  - One function per semantic event → easy to find, change, and test.
 *  - `emitReasoningEvent` is the single thin wrapper that forwards to the SSE emitter.
 *
 * Usage:
 *   import { ReasoningSteps, emitReasoningEvent } from "./reasoning-steps"
 *   await emitReasoningEvent(emitter, ReasoningSteps.turnStarted(1))
 */

import {
  ReasoningEventType,
  XyneTools,
  type ReasoningEventPayload,
  type ReasoningStage,
  type PlanSubTask,
} from "@/shared/types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Chat)

// ─── Emitter type ─────────────────────────────────────────────────────────────

/** Thin async function that forwards a structured event to the SSE stream. */
export type ReasoningEmitter = (
  payload: ReasoningEventPayload
) => Promise<void>

// ─── Tool display map ─────────────────────────────────────────────────────────
// Centralised display names for every tool.  Replacing getToolIntentLabel /
// getToolResultLabel from message-agents.ts.

interface ToolDisplay {
  executing: string
  completed: string
}

const TOOL_DISPLAY: Record<string, ToolDisplay> = {
  [XyneTools.searchGlobal]:        { executing: "Searching across all connected data sources.", completed: "Found results from your data sources." },
  [XyneTools.searchKnowledgeBase]: { executing: "Searching internal knowledge base.", completed: "Found relevant documents." },
  [XyneTools.searchGmail]:         { executing: "Searching Gmail.", completed: "Found relevant emails." },
  [XyneTools.searchDriveFiles]:    { executing: "Searching Google Drive.", completed: "Found relevant files." },
  [XyneTools.searchCalendarEvents]:{ executing: "Searching calendar.", completed: "Found calendar events." },
  [XyneTools.searchGoogleContacts]:{ executing: "Searching contacts.", completed: "Found contacts." },
  [XyneTools.getSlackMessages]:    { executing: "Searching Slack conversations.", completed: "Found Slack messages." },
  [XyneTools.getSlackThreads]:     { executing: "Searching Slack threads.", completed: "Found Slack threads." },
  [XyneTools.getSlackUserProfile]: { executing: "Looking up Slack profile.", completed: "Found Slack profile." },
  [XyneTools.listCustomAgents]:    { executing: "Searching for specialized agents.", completed: "Agent search complete." },
  [XyneTools.runPublicAgent]:      { executing: "Consulting a specialized agent.", completed: "Specialist returned results." },
  [XyneTools.fallBack]:            { executing: "Trying fallback search.", completed: "Fallback search complete." },
  [XyneTools.toDoWrite]:           { executing: "Planning next steps.", completed: "Plan created." },
  [XyneTools.synthesizeFinalAnswer]:{ executing: "Composing your answer.", completed: "Answer ready." },
}

function toolExecutingText(toolName: string): string {
  return TOOL_DISPLAY[toolName]?.executing ?? "Searching for information."
}

function toolCompletedText(toolName: string): string {
  return TOOL_DISPLAY[toolName]?.completed ?? "Search complete."
}

function plural(n: number, singular: string, pluralForm?: string): string {
  return n === 1 ? singular : (pluralForm ?? `${singular}s`)
}

// ─── Factory functions ────────────────────────────────────────────────────────

export const ReasoningSteps = {
  // ── Lifecycle ────────────────────────────────────────────────────────────

  turnStarted(turnNumber: number): ReasoningEventPayload {
    return {
      type: ReasoningEventType.TurnStarted,
      displayText: turnNumber === 0 ? "Starting research." : `Starting search pass ${turnNumber + 1}.`,
      stage: "understanding",
      turnNumber,
      timestamp: Date.now(),
    }
  },

  turnCompleted(turnNumber: number): ReasoningEventPayload {
    return {
      type: ReasoningEventType.TurnCompleted,
      displayText: "Evaluating what's been found so far.",
      stage: "analyzing",
      turnNumber,
      timestamp: Date.now(),
    }
  },

  planCreated(
    goal: string,
    subTasks: Array<{ id: string; description: string; status: PlanSubTask["status"] }>,
  ): ReasoningEventPayload {
    const firstStep = subTasks[0]?.description
    return {
      type: ReasoningEventType.PlanCreated,
      displayText: firstStep
        ? `Planning: ${firstStep}`
        : "Planning next steps.",
      stage: "understanding",
      detail: goal,
      plan: { goal, subTasks },
      timestamp: Date.now(),
    }
  },

  synthesisStarted(fragmentCount: number): ReasoningEventPayload {
    return {
      type: ReasoningEventType.SynthesisStarted,
      displayText: "Preparing your answer.",
      stage: "preparing",
      count: fragmentCount,
      timestamp: Date.now(),
    }
  },

  synthesisCompleted(): ReasoningEventPayload {
    return {
      type: ReasoningEventType.SynthesisCompleted,
      displayText: "Answer composed successfully.",
      stage: "preparing",
      timestamp: Date.now(),
    }
  },

  // ── Tool lifecycle ───────────────────────────────────────────────────────

  toolExecuting(toolName: string, query?: string): ReasoningEventPayload {
    return {
      type: ReasoningEventType.ToolExecuting,
      displayText: toolExecutingText(toolName),
      stage: "gathering",
      toolName,
      ...(query ? { toolQuery: query } : {}),
      timestamp: Date.now(),
    }
  },

  toolCompleted(toolName: string, hadError: boolean = false): ReasoningEventPayload {
    return {
      type: ReasoningEventType.ToolCompleted,
      displayText: hadError
        ? `Search encountered an issue. Continuing with available results.`
        : toolCompletedText(toolName),
      stage: "gathering",
      toolName,
      timestamp: Date.now(),
    }
  },

  toolSelected(toolName: string, query?: string): ReasoningEventPayload {
    return {
      type: ReasoningEventType.ToolExecuting,
      displayText: toolExecutingText(toolName),
      stage: "gathering",
      toolName,
      ...(query ? { toolQuery: query } : {}),
      timestamp: Date.now(),
    }
  },

  toolSkippedDuplicate(toolName: string): ReasoningEventPayload {
    return {
      type: ReasoningEventType.ToolSkippedDuplicate,
      displayText: "Already searched this — skipping duplicate query.",
      stage: "gathering",
      toolName,
      timestamp: Date.now(),
    }
  },

  toolSkippedCooldown(toolName: string, turnsLeft: number): ReasoningEventPayload {
    return {
      type: ReasoningEventType.ToolSkippedCooldown,
      displayText: "Skipping this tool for now. Trying a different approach.",
      stage: "gathering",
      toolName,
      detail: `${turnsLeft} turn${plural(turnsLeft, "")} remaining in cooldown`,
      timestamp: Date.now(),
    }
  },

  toolValidationError(toolName: string, errorMessage?: string): ReasoningEventPayload {
    return {
      type: ReasoningEventType.ToolValidationError,
      displayText: "Skipping this step due to invalid input.",
      stage: "gathering",
      toolName,
      detail: errorMessage,
      timestamp: Date.now(),
    }
  },

  toolCooldownApplied(toolName: string, failCount: number, turnsLeft: number): ReasoningEventPayload {
    return {
      type: ReasoningEventType.ToolCooldownApplied,
      displayText: "Skipping this tool for now. Trying a different approach.",
      stage: "gathering",
      toolName,
      detail: `Failed ${failCount}x, cooling down for ${turnsLeft} turn${plural(turnsLeft, "")}`,
      timestamp: Date.now(),
    }
  },

  toolRecovered(recoveredTools: string[]): ReasoningEventPayload {
    return {
      type: ReasoningEventType.ToolRecovered,
      displayText: "Retrying previously unavailable tools.",
      stage: "gathering",
      detail: recoveredTools.join(", "),
      timestamp: Date.now(),
    }
  },

  // ── Document pipeline ────────────────────────────────────────────────────

  documentsFound(count: number, toolName?: string): ReasoningEventPayload {
    return {
      type: ReasoningEventType.DocumentsFound,
      displayText: `Found ${count} relevant ${plural(count, "document")}. Selecting the most useful ones for analysis.`,
      stage: "gathering",
      count,
      toolName,
      timestamp: Date.now(),
    }
  },

  documentsFiltered(count: number, toolName?: string): ReasoningEventPayload {
    return {
      type: ReasoningEventType.DocumentsFiltered,
      displayText: `Selected the ${count} most relevant ${plural(count, "document")} to analyze.`,
      stage: "analyzing",
      count,
      toolName,
      timestamp: Date.now(),
    }
  },

  documentsRanking(toolName?: string): ReasoningEventPayload {
    return {
      type: ReasoningEventType.DocumentsRanking,
      displayText: "Ranking results by relevance.",
      stage: "analyzing",
      toolName,
      timestamp: Date.now(),
    }
  },

  metadataFilterApplied(hasCompliantCandidates: boolean, toolName?: string): ReasoningEventPayload {
    return {
      type: ReasoningEventType.MetadataFilterApplied,
      displayText: hasCompliantCandidates
        ? "Applying your filters before ranking."
        : "Detected filters but found no clearly matching documents.",
      stage: "analyzing",
      toolName,
      timestamp: Date.now(),
    }
  },

  metadataNoMatch(toolName?: string): ReasoningEventPayload {
    return {
      type: ReasoningEventType.MetadataNoMatch,
      displayText: "No documents matched your filters.",
      stage: "analyzing",
      toolName,
      timestamp: Date.now(),
    }
  },

  rankingFailed(strictNoMatch: boolean, toolName?: string): ReasoningEventPayload {
    return {
      type: ReasoningEventType.RankingFailed,
      displayText: strictNoMatch
        ? "No documents matched your filters."
        : "Keeping all retrieved documents for analysis.",
      stage: "analyzing",
      toolName,
      timestamp: Date.now(),
    }
  },

  // ── Agent delegation ─────────────────────────────────────────────────────

  agentSearching(): ReasoningEventPayload {
    return {
      type: ReasoningEventType.AgentSearching,
      displayText: "Searching for specialized agents that can help.",
      stage: "consulting",
      timestamp: Date.now(),
    }
  },

  agentsFound(count: number, agentNames?: string[]): ReasoningEventPayload {
    return {
      type: ReasoningEventType.AgentsFound,
      displayText: count > 0
        ? `Found ${count} specialized ${plural(count, "agent")}. Evaluating options.`
        : "No specialized agents found. Continuing with built-in tools.",
      stage: "consulting",
      count,
      detail: agentNames?.join(", "),
      timestamp: Date.now(),
    }
  },

  agentNoMatch(): ReasoningEventPayload {
    return {
      type: ReasoningEventType.AgentNoMatch,
      displayText: "No specialized agents found. Continuing with built-in tools.",
      stage: "consulting",
      timestamp: Date.now(),
    }
  },

  agentDelegated(agentName: string, delegationRunId?: string): ReasoningEventPayload {
    return {
      type: ReasoningEventType.AgentDelegated,
      displayText: `Consulting ${agentName} for deeper analysis.`,
      stage: "consulting",
      agentName,
      // Place this event inside the delegation block when an ID is available so
      // the frontend renders it as the first step of the collapsible container.
      agent: delegationRunId ? agentName : undefined,
      delegationRunId,
      timestamp: Date.now(),
    }
  },

  agentCompleted(agentName: string, delegationRunId?: string): ReasoningEventPayload {
    return {
      type: ReasoningEventType.AgentCompleted,
      displayText: `${agentName} completed its analysis. Reviewing its findings.`,
      stage: "consulting",
      agentName,
      agent: delegationRunId ? agentName : undefined,
      delegationRunId,
      timestamp: Date.now(),
    }
  },

  // ── Attachments ──────────────────────────────────────────────────────────

  attachmentAnalyzing(): ReasoningEventPayload {
    return {
      type: ReasoningEventType.AttachmentAnalyzing,
      displayText: "Analyzing your attachments.",
      stage: "analyzing",
      timestamp: Date.now(),
    }
  },

  attachmentExtracted(count: number): ReasoningEventPayload {
    return {
      type: ReasoningEventType.AttachmentExtracted,
      displayText: `Using ${count} context ${plural(count, "snippet")} from your attachments.`,
      stage: "gathering",
      count,
      timestamp: Date.now(),
    }
  },

  // ── Review ────────────────────────────────────────────────────────────────

  reviewCompleted(recommendation: string, turnNumber?: number): ReasoningEventPayload {
    return {
      type: ReasoningEventType.ReviewCompleted,
      displayText: "Reviewing progress and results.",
      stage: "analyzing",
      detail: recommendation,
      turnNumber,
      timestamp: Date.now(),
    }
  },

  anomaliesDetected(anomalies: string[]): ReasoningEventPayload {
    return {
      type: ReasoningEventType.AnomaliesDetected,
      displayText: "Unexpected results detected — reassessing approach.",
      stage: "analyzing",
      detail: anomalies.join("; "),
      timestamp: Date.now(),
    }
  },

  // ── Fallback / recovery ──────────────────────────────────────────────────

  fallbackActivated(): ReasoningEventPayload {
    return {
      type: ReasoningEventType.FallbackActivated,
      displayText: "Trying a different approach to find an answer.",
      stage: "gathering",
      timestamp: Date.now(),
    }
  },

  fallbackCompleted(): ReasoningEventPayload {
    return {
      type: ReasoningEventType.FallbackCompleted,
      displayText: "Alternative search complete.",
      stage: "gathering",
      timestamp: Date.now(),
    }
  },

  // ── Generic escape hatch (use sparingly) ─────────────────────────────────

  /** Use only when no specific factory applies. Prefer adding a new factory. */
  logMessage(
    displayText: string,
    stage: ReasoningStage = "analyzing",
    detail?: string,
    toolName?: string,
  ): ReasoningEventPayload {
    return {
      type: ReasoningEventType.LogMessage,
      displayText,
      stage,
      detail,
      toolName,
      timestamp: Date.now(),
    }
  },

  // ── Tool-planning context ─────────────────────────────────────────────────

  /** Emitted when the assistant message has planned tool calls (no output yet). */
  toolPlanningMessage(modelContent: string): ReasoningEventPayload {
    // Model content is internal; show a neutral planning message instead
    return {
      type: ReasoningEventType.LogMessage,
      displayText: "Deciding which sources to search.",
      stage: "understanding",
      timestamp: Date.now(),
    }
  },

  /** Emitted when expectations are set before tool calls. */
  expectationsSet(): ReasoningEventPayload {
    return {
      type: ReasoningEventType.LogMessage,
      displayText: "Mapping out what to look for.",
      stage: "understanding",
      timestamp: Date.now(),
    }
  },

  /** Turn-end summary when tools were executed (internal summary, not shown). */
  turnToolSummary(turnNumber: number): ReasoningEventPayload {
    return {
      type: ReasoningEventType.TurnCompleted,
      displayText: "Evaluating what's been found so far.",
      stage: "analyzing",
      turnNumber,
      timestamp: Date.now(),
    }
  },

  /** Turn-end with no tools executed. */
  turnNoTools(turnNumber: number): ReasoningEventPayload {
    return {
      type: ReasoningEventType.TurnCompleted,
      displayText: "No further searches needed — moving to answer.",
      stage: "analyzing",
      turnNumber,
      timestamp: Date.now(),
    }
  },
}

// ─── Emitter wrapper ──────────────────────────────────────────────────────────

/**
 * Thin wrapper that forwards a structured ReasoningEventPayload to the SSE emitter.
 * This is the single call site for emitting reasoning events — no transformation,
 * no regex, just serialize + forward.
 */
export async function emitReasoningEvent(
  emitter: ReasoningEmitter | undefined,
  payload: ReasoningEventPayload
): Promise<void> {
  if (!emitter) return
  try {
    await emitter(payload)
  } catch (error) {
    Logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "Failed to emit reasoning event"
    )
  }
}
