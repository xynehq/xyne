/**
 * Pi-Mono Extension for Xyne
 *
 * Handles tool interception, fragment processing, and review execution.
 * Uses pi-mono's ExtensionAPI for blocking/modifying tool calls.
 */

import { ReasoningSteps, emitReasoningEvent } from "@/api/chat/reasoning-steps"
import type { ReasoningEmitter } from "@/api/chat/reasoning-steps"
import type { MinimalAgentFragment } from "@/api/chat/types"
import { getLogger } from "@/logger"
import { XyneTools } from "@/shared/types"
import { Subsystem } from "@/types"
import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent"
import type { XyneAgentState } from "./adapter"

const Logger = getLogger(Subsystem.Chat)

// Stop words to remove during keyword extraction
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "in",
  "of",
  "for",
  "to",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "can",
  "need",
  "ought",
  "shall",
  "with",
  "by",
  "from",
  "at",
  "on",
  "as",
  "or",
  "and",
  "but",
  "if",
  "then",
  "than",
  "so",
  "yet",
  "nor",
  "when",
  "where",
  "why",
  "how",
  "what",
  "who",
  "which",
  "whose",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
])

/**
 * Normalize query string for comparison
 */
function normalizeQuery(query: string): string {
  return query.toLowerCase().trim()
}

/**
 * Extract keywords from query, handling quoted phrases as single units
 * and removing stop words from non-quoted terms
 */
function extractKeywords(query: string): string[] {
  const keywords: string[] = []
  const quotedRegex = /"([^"]+)"/g
  let match

  // Extract quoted phrases as single keywords
  while ((match = quotedRegex.exec(query)) !== null) {
    const phrase = match[1].trim().toLowerCase()
    if (phrase.length > 0) {
      keywords.push(`"${phrase}"`)
    }
  }

  // Remove quoted phrases and process remaining text
  const withoutQuotes = query.replace(quotedRegex, " ")
  const words = withoutQuotes.split(/\s+/)

  for (const word of words) {
    const normalized = word.toLowerCase().trim()
    if (normalized.length > 0 && !STOP_WORDS.has(normalized)) {
      keywords.push(normalized)
    }
  }

  return keywords
}

/**
 * Calculate keyword overlap between two keyword arrays
 * Returns the count of common keywords
 */
function calculateKeywordOverlap(
  keywords1: string[],
  keywords2: string[],
): number {
  const set1 = new Set(keywords1)
  const set2 = new Set(keywords2)
  let overlap = 0
  for (const keyword of set1) {
    if (set2.has(keyword)) {
      overlap++
    }
  }
  return overlap
}

function normalizeKBFilters(filters: any): string {
  if (!filters || !filters.targets || filters.targets.length === 0) {
    return ""
  }

  const sortedTargets = [...filters.targets].sort((a: any, b: any) => {
    const aKey = `${a.type}:${a.collectionId || ""}:${a.folderId || ""}:${a.fileId || ""}:${a.path || ""}`
    const bKey = `${b.type}:${b.collectionId || ""}:${b.folderId || ""}:${b.fileId || ""}:${b.path || ""}`
    return aKey.localeCompare(bKey)
  })

  return sortedTargets
    .map(
      (t: any) =>
        `${t.type}:${t.collectionId || ""}:${t.folderId || ""}:${t.fileId || ""}:${t.path || ""}`,
    )
    .join("|")
}

/**
 * State passed from the main session to the extension
 */
interface ExtensionState {
  xyneState: XyneAgentState
  currentTurn: { value: number }
  agenticModelId: string
  message: string
  email: string
  emitReasoningStep: ReasoningEmitter
}

// Global state ref - required because extensions are factory functions
let extensionStateRef: ExtensionState | null = null

export function setExtensionState(state: ExtensionState): void {
  extensionStateRef = state
}

export function getExtensionState(): ExtensionState | null {
  return extensionStateRef
}

export function clearExtensionState(): void {
  extensionStateRef = null
}

export default function xyneExtension(pi: ExtensionAPI) {
  const pendingFragments: MinimalAgentFragment[] = []
  const toolExecutions: any[] = []

  pi.on(
    "tool_call",
    async (event: ToolCallEvent): Promise<ToolCallEventResult | undefined> => {
      const state = extensionStateRef
      if (!state) return

      // Only apply deduplication to searchKnowledgeBase tool
      if (event.toolName !== "searchKnowledgeBase") return

      const query = (event.input as any)?.query as string | undefined
      const filters = (event.input as any)?.filters as any
      if (!query) return
      const normalizedQuery = normalizeQuery(query)
      const currentKeywords = extractKeywords(normalizedQuery)
      const currentFilters = normalizeKBFilters(filters)
      // Check for similar queries in history
      for (const historyEntry of state.xyneState.searchQueryHistory) {
        const overlap = calculateKeywordOverlap(
          currentKeywords,
          historyEntry.keywords,
        )
        const overlapPercentage =
          overlap /
          Math.max(currentKeywords.length, historyEntry.keywords.length)
        const filtersAreDifferent = currentFilters !== historyEntry.filters

        if (overlapPercentage >= 0.8 && !filtersAreDifferent) {
          // Emit reasoning event for visibility
          const reasoningPayload = ReasoningSteps.toolSkippedDuplicateSearch(
            query,
            historyEntry.query,
            Math.round(overlapPercentage * 100),
          )
          state.emitReasoningStep(reasoningPayload).catch(() => {})

          // Block this tool call and steer the agent
          pi.sendUserMessage(
            `This search is ${Math.round(overlapPercentage * 100)}% similar to a previous query: "${historyEntry.query}".

Before making the next search, reflect:
- What information have I already gathered?
- What is still missing?
- Can I narrow or redirect the search instead of repeating it?

Then choose ONE of these strategies:

1. Keyword Strategy
- Use NEW keywords (avoid: ${historyEntry.keywords.join(", ")})
- Use synonyms or alternative terminology from retrieved documents
- Focus on a different aspect (cause, impact, exception, comparison)

2. Filter Strategy (HIGH VALUE)
- Narrow the search using filters:
  - specific file, folder, or collection
  - paths discovered via previous \`ls\` or results
- Target only the most relevant documents instead of broad search

3. Exploration Strategy
- Search a related concept not directly mentioned in the query
- Follow entities, definitions, or references found in previous results

Important:
- Do NOT rephrase the same query
- If relevant documents are already identified, prefer using filters over rewriting the query

The best next step may not be a new query — it may be a more precise search scope.`,
            { deliverAs: "steer" },
          )

          return {
            block: true,
            reason: `Duplicate search detected: This query is ${Math.round(overlapPercentage * 100)}% similar to a recent search. Please try different keywords or a different angle.`,
          }
        }
      }

      // eslint-disable-next-line no-console
      console.log(
        `[KB-DEDUP] ALLOWING "${query}" - keywords: [${currentKeywords.join(", ")}]`,
      )
    },
  )

  pi.on("tool_result", async (event: ToolResultEvent) => {
    const state = extensionStateRef
    if (!state) return
    // Track search queries in history for deduplication
    if (event.toolName === "searchKnowledgeBase") {
      const args = (event as any).input as Record<string, unknown> | undefined
      const query = args?.query as string | undefined
      const filters = args?.filters as any
      if (query) {
        const normalizedQuery = normalizeQuery(query)
        const keywords = extractKeywords(normalizedQuery)
        const normalizedFilters = normalizeKBFilters(filters)
        state.xyneState.searchQueryHistory.push({
          query,
          keywords,
          filters: normalizedFilters,
          timestamp: Date.now(),
        })
      }
    }

    const details = event.details as Record<string, unknown> | undefined

    if (details?.fragments && Array.isArray(details.fragments)) {
      const fragments = details.fragments as MinimalAgentFragment[]
      state.xyneState.allFragments.push(...fragments)

      const startIndex = (details.startIndex as number) || 1
      fragments.forEach((fragment, idx) => {
        const docId = fragment.source?.docId
        const returnedChunks = fragment.source?.returnedChunkIndices

        if (docId && returnedChunks && returnedChunks.length > 0) {
          // Track the specific chunks that were actually returned in the content
          returnedChunks.forEach((chunkIdx) => {
            const chunkKey = `${docId}_${chunkIdx}`
            state.xyneState.seenChunks.add(chunkKey)
          })
        }

        const citationDocId = startIndex + idx
        state.xyneState.citationDocIdMapping.set(citationDocId, fragment.id)
      })
    }

    // Track tool execution for review
    toolExecutions.push({
      toolName: event.toolName,
      status: event.isError ? "error" : "success",
      arguments: (event as any).args || {},
      error: event.isError ? { message: "Tool execution failed" } : undefined,
    })

    // Return modified result
    return {
      content: event.content,
      details: event.details,
      isError: event.isError,
    }
  })

  // === TURN END PROCESSING ===
  pi.on("turn_end", async (event) => {})
  /**
   * Cleanup function - mirrors JAF's cleanup
   */
  function cleanupTurn(context: XyneAgentState, turn: number): void {
    // Clear attachment phase metadata
    const metadata = context.chat.metadata as any
    if (metadata?.initialAttachmentPhase) {
      context.chat.metadata = { ...metadata, initialAttachmentPhase: false }
    }

    // Finalize images from this turn
    const imagesToFinalize = context.currentTurnArtifacts.images.filter(
      (img) => img.addedAtTurn === turn,
    )
    imagesToFinalize.forEach((img) => {
      if (
        !context.allImages.some(
          (existing) => existing.fileName === img.fileName,
        )
      ) {
        context.allImages.push(img)
      }
    })

    // Flush pending expectations
    context.pendingExpectations.length = 0

    // Reset turn artifacts
    context.currentTurnArtifacts.unrankedFragmentsByTool.clear()
    context.currentTurnArtifacts.toolOutputs = []
    context.currentTurnArtifacts.executionToolsCalled = 0
    context.currentTurnArtifacts.todoWriteCalled = false
    context.currentTurnArtifacts.images = []
    context.currentTurnArtifacts.fragments = []
    context.currentTurnArtifacts.expectations = []

    // Clear extension-local accumulators
    pendingFragments.length = 0
    toolExecutions.length = 0
    Logger.debug({ turn }, "[Pi-Mono Extension] Cleanup completed")
  }

  // Clear search query history when agent completes (answer is yielded)
  pi.on("agent_end", async () => {
    const state = extensionStateRef
    if (state) {
      state.xyneState.searchQueryHistory = []
      Logger.debug(
        "[Pi-Mono Extension] Search query history cleared on agent_end",
      )
    }
  })

  Logger.info("[Pi-Mono Extension] Registered")
}
