import { ReasoningSteps } from "@/api/chat/reasoning-steps"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type {
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent"

import {
  buildDedupSteerMessage,
  calculateKeywordOverlap,
  extractKeywords,
  normalizeKBFilters,
  normalizeQuery,
  trackSearchQuery,
} from "../query-utils"
import type { SearchKBDetails, ToolCallContext, ToolHandler } from "../types"

const Logger = getLogger(Subsystem.Chat)

/** Minimum keyword overlap ratio (0-1) to consider a query a duplicate. */
const DEDUP_OVERLAP_THRESHOLD = 0.8

export const searchKBHandler: ToolHandler = {
  toolName: "searchKnowledgeBase",

  async onToolCall(
    event: ToolCallEvent,
    context: ToolCallContext,
  ): Promise<ToolCallEventResult | undefined> {
    const input = event.input as Record<string, unknown> | undefined
    const query = input?.query as string | undefined
    const filters = input?.filters
    if (!query) return undefined

    const normalizedQuery = normalizeQuery(query)
    const currentKeywords = extractKeywords(normalizedQuery)
    const currentFilters = normalizeKBFilters(filters)

    for (const historyEntry of context.xyneState.searchQueryHistory) {
      const overlap = calculateKeywordOverlap(
        currentKeywords,
        historyEntry.keywords,
      )
      const overlapPct =
        overlap / Math.max(currentKeywords.length, historyEntry.keywords.length)
      const filtersAreDifferent = currentFilters !== historyEntry.filters

      if (overlapPct >= DEDUP_OVERLAP_THRESHOLD && !filtersAreDifferent) {
        const pctRounded = Math.round(overlapPct * 100)

        // Emit reasoning event for visibility
        context
          .emitReasoningStep(
            ReasoningSteps.toolSkippedDuplicateSearch(
              query,
              historyEntry.query,
              pctRounded,
            ),
          )
          .catch(() => {})

        // Steer the agent toward a different strategy
        context.sendSteerMessage?.(
          buildDedupSteerMessage(
            pctRounded,
            historyEntry.query,
            historyEntry.keywords,
          ),
        )

        return {
          block: true,
          reason: `Duplicate search detected: This query is ${pctRounded}% similar to a recent search. Please try different keywords or a different angle.`,
        }
      }
    }

    Logger.debug(
      `[KB-DEDUP] ALLOWING "${query}" - keywords: [${currentKeywords.join(", ")}]`,
    )
    return undefined
  },

  async onToolResult(
    event: ToolResultEvent,
    context: ToolCallContext,
  ): Promise<void> {
    const details = (event.details ?? {}) as SearchKBDetails
    const { query, filters } = details

    if (typeof query === "string") {
      trackSearchQuery(context.xyneState, query, filters)
    }
    await context.emitReasoningStep(
      ReasoningSteps.searchCompleted(
        query || JSON.stringify(filters) || "unknown",
        details?.fragments?.length || 0,
        details?.topFragmentSummary || "",
        event.toolName,
      ),
    )
  },
}
