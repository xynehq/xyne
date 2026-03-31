/**
 * Document-centric memory helpers.
 * See docs/memory-architecture-across-turns.md and agent-schemas (DocumentState, ToolRawDocument).
 *
 * Two-level memory:
 * - Current-turn: raw Vespa docs from tool calls this turn → used for filtering (reranking) → after ranking, merged into cross-turn.
 * - Cross-turn: accumulates reranked docs after each turn → used for synthesis and review.
 *
 * - Merge raw Vespa documents into document memory (chunk-level dedupe, signals).
 * - mergeDocumentStatesIntoDocumentMemory: merge current-turn docs (e.g. ranked subset) into cross-turn.
 * - Build MinimalAgentFragment on the fly from DocumentState (filter/review/synthesis).
 */

import type {
  AgentRunContext,
  ChunkState,
  DocumentState,
  ImageMemoryEntry,
  RawChunkWithScore,
  ToolOutputExtractedImage,
  ToolRawDocument,
} from "./agent-schemas"
import {
  DOCUMENT_MEMORY_MAX_CHUNKS_PER_DOC,
  DOCUMENT_MEMORY_MAX_DOCS,
  DOCUMENT_MEMORY_MAX_DOCS_FOR_LLM,
} from "./agent-schemas"
import type { Citation, ImageCitation, MinimalAgentFragment } from "./types"
import {
  answerContextMap,
  type AnswerContextRenderMetadata,
} from "@/ai/context"
import config, { IMAGE_CONTEXT_CONFIG } from "@/config"
import type { UserMetadataType } from "@/types"
import { getDateForAI } from "@/utils/index"
import { getChunkCountPerDoc } from "./chunk-selection"
import { Apps, dataSourceFileSchema, fileSchema, KbItemsSchema, mailAttachmentSchema } from "@xyne/vespa-ts/types"
import type { VespaSearchResults } from "@xyne/vespa-ts"
import { contextWithoutImageBlocksFromMatches, imageFileNamesBlockMatches } from "./utils"
import { AgentResponseConfidence } from "./utils"
import { MAX_QUERY_DOCS_PER_BASE_DOC } from "./agent-schemas"
import { getPrecomputedDbContextIfNeeded } from "@/lib/databaseContext"
import { randomUUID } from "crypto"
import { MIME_DATABASE_SCHEMA } from "@/integrations/database"

let syntheticLsDocSequence = 0
let syntheticDelegatedDocSequence = 0
let syntheticChatMemoryDocSequence = 0

/** Create an empty DocumentState. */
export function createDocumentState(docId: string, source: Citation): DocumentState {
  return {
    docId,
    source,
    chunks: new Map(),
    signals: [],
    maxScore: 0,
    relevanceScore: 0,
  }
}

/**
 * Recompute doc-level scores from signals.
 * Uses bounded recency so old docs don't dominate (latestTurn was previously unbounded).
 * @param currentTurn - when set, recency is 1/(1 + (currentTurn - latestTurn)); when omitted, uses max(signals.turn) as reference.
 */
function updateDocumentScores(doc: DocumentState, currentTurn?: number): void {
  if (doc.signals.length === 0) {
    doc.maxScore = 0
    doc.relevanceScore = 0
    return
  }
  const maxConf = Math.max(...doc.signals.map((s) => s.confidence))
  doc.maxScore = maxConf
  const uniqueQueries = new Set(doc.signals.map((s) => s.query)).size
  const multiQueryBonus = Math.min(0.1 * (uniqueQueries - 1), 0.2)
  const latestTurn = Math.max(...doc.signals.map((s) => s.turn), 0)
  const refTurn = currentTurn ?? Math.max(latestTurn, 1)
  const recencyBoost = 1 / (1 + Math.max(0, refTurn - latestTurn))
  doc.relevanceScore = maxConf + multiQueryBonus + 0.2 * recencyBoost
}

/** Chunk score for ordering: confidence + small recency boost (lastSeenTurn / refTurn). */
function chunkScoreForOrdering(
  c: ChunkState,
  refTurn: number,
): number {
  const recencyBoost = refTurn > 0 ? 0.1 * (c.lastSeenTurn / refTurn) : 0

  const norm = (v: string) => v.toLowerCase().trim()
  const uniqueChunkQueries = Array.from(new Set((c.queries ?? []).map(norm)))
  const frequency = uniqueChunkQueries.length

  return c.confidence + recencyBoost + 0.05 * frequency
}

function parseChunkKeyToCitationIndex(chunkKey: string): number {
  // Deep reader uses `seq:<absIndex>`; other tools often use `i:<index>`.
  if (chunkKey.startsWith("seq:")) {
    const n = Number(chunkKey.slice("seq:".length))
    return Number.isFinite(n) ? n : 0
  }
  if (chunkKey.startsWith("i:")) {
    const n = Number(chunkKey.slice("i:".length))
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/**
 * Normalize a Vespa hit so `answerContextMap(...)` sees ONLY the chunk slice currently
 * stored in `doc.chunks`.
 *
 * Why:
 * - Eviction ordering is based on `doc.chunks` state.
 * - `answerContextMap` instead derives chunk ordering from `vespaHit.fields.matchfeatures`
 *   and `vespaHit.fields.chunks_summary`.
 * - If `vespaHit` still contains the original (pre-eviction) chunk set, we build the wrong
 *   context for the LLM (especially when chunk scores are 0).
 */
function normalizeVespaHitForDocumentChunks(
  doc: DocumentState & { vespaHit: VespaSearchResults },
  orderedBy: { refTurn: number },
): VespaSearchResults {
  const hit = doc.vespaHit

  const fieldsAny: any = hit.fields ?? {}

  const chunkEntries = Array.from(doc.chunks.entries())
  // Deterministic ordering even when all chunk scores are 0.
  const scoredEntries = chunkEntries
    .map(([chunkKey, chunk]) => {
      const score = chunkScoreForOrdering(
        chunk,
        orderedBy.refTurn,
      )
      return { index: parseChunkKeyToCitationIndex(chunkKey), chunk, score }
    })

  const chunks_summary = scoredEntries.map(({ chunk }) => chunk.content)
  const chunks_pos_summary = scoredEntries.map(({ index }) =>
    fieldsAny.chunks_pos_summary?.[index] ?? index
  )

  const chunk_scores_cells: Record<string, number> = {}
  for (let i = 0; i < scoredEntries.length; i++) {
    chunk_scores_cells[String(i)] = scoredEntries[i].score
  }

  const prevMatchfeatures: any = fieldsAny.matchfeatures ?? {}
  const normalizedMatchfeatures = {
    ...prevMatchfeatures,
    chunk_scores: {
      cells: chunk_scores_cells,
    },
  }

  // Shallow-clone the hit and overwrite the chunk-related fields used by answerContextMap.
  return {
    ...(hit as any),
    relevance: doc.relevanceScore,
    fields: {
      ...fieldsAny,
      chunks_summary,
      chunks_pos_summary,
      matchfeatures: normalizedMatchfeatures,
    },
  } as VespaSearchResults
}

/** Keep only top K chunks per doc by score; evict the rest. */
function evictChunksIfNeeded(doc: DocumentState, refTurn: number): void {
  if (doc.chunks.size <= DOCUMENT_MEMORY_MAX_CHUNKS_PER_DOC) return
  const entries = Array.from(doc.chunks.entries())
  const sorted = entries.sort(
    (a, b) =>
      chunkScoreForOrdering(b[1], refTurn) - chunkScoreForOrdering(a[1], refTurn),
  )
  const toKeep = sorted.slice(0, DOCUMENT_MEMORY_MAX_CHUNKS_PER_DOC)
  doc.chunks.clear()
  for (const [k, v] of toKeep) doc.chunks.set(k, v)
  doc.cachedFragment = undefined
}

/** Evict lowest-relevance docs when over MAX_DOCS. */
function evictDocumentMemoryIfNeeded(
  documentMemory: Map<string, DocumentState>,
): void {
  if (documentMemory.size <= DOCUMENT_MEMORY_MAX_DOCS) return
  const entries = Array.from(documentMemory.entries())
  const byScore = entries.sort((a, b) => {
    const docA = a[1]
    const docB = b[1]
    if (docB.relevanceScore !== docA.relevanceScore)
      return docA.relevanceScore - docB.relevanceScore
    const maxTurnA = Math.max(...docA.signals.map((s) => s.turn), 0)
    const maxTurnB = Math.max(...docB.signals.map((s) => s.turn), 0)
    return maxTurnA - maxTurnB
  })
  const toRemove = byScore.slice(0, documentMemory.size - DOCUMENT_MEMORY_MAX_DOCS)
  for (const [docId] of toRemove) documentMemory.delete(docId)
}

/**
 * Evict excess query-derived documents per base document.
 * Query docs are grouped by baseDocId and only the top MAX_QUERY_DOCS_PER_BASE_DOC are kept.
 */
function evictQueryDocsIfNeeded(
  documentMemory: Map<string, DocumentState>,
): void {
  // Group query docs by baseDocId
  const queryDocsByBase = new Map<string, DocumentState[]>()
  
  for (const doc of documentMemory.values()) {
    if (doc.isQueryDoc && doc.baseDocId) {
      const list = queryDocsByBase.get(doc.baseDocId) ?? []
      list.push(doc)
      queryDocsByBase.set(doc.baseDocId, list)
    }
  }
  
  // For each base doc, keep only top MAX_QUERY_DOCS_PER_BASE_DOC by relevanceScore, then recency
  for (const [_, queryDocs] of queryDocsByBase) {
    if (queryDocs.length <= MAX_QUERY_DOCS_PER_BASE_DOC) continue
    
    // Sort by relevanceScore desc, then by most recent turn desc
    const sorted = queryDocs.sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) {
        return b.relevanceScore - a.relevanceScore
      }
      const maxTurnA = Math.max(...a.signals.map((s) => s.turn), 0)
      const maxTurnB = Math.max(...b.signals.map((s) => s.turn), 0)
      return maxTurnB - maxTurnA
    })
    
    // Evict the excess
    const toEvict = sorted.slice(MAX_QUERY_DOCS_PER_BASE_DOC)
    for (const doc of toEvict) {
      documentMemory.delete(doc.docId)
    }
  }
}


/**
 * Check if a document is query-dependent (sheets, CSV, Excel, DB schemas).
 * These documents need query-based processing during tool execution.
 */
export function isQueryDependentDoc(result: VespaSearchResults): boolean {
  const fields = result.fields as Record<string, unknown>
  
  // Check for spreadsheet types
  if (fields.sddocname === fileSchema || fields.sddocname === KbItemsSchema || fields.sddocname === mailAttachmentSchema || fields.sddocname === dataSourceFileSchema) {
    const mimeType = fields.sddocname === mailAttachmentSchema 
      ? fields.fileType 
      : fields.mimeType
    
    if (
      mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      mimeType === "application/vnd.ms-excel" ||
      mimeType === "text/csv"
    ) {
      return true
    }
    
    // Check for database schema
    if (fields.mimeType === MIME_DATABASE_SCHEMA) {
      return true
    }
  }
  
  return false
}

/**
 * Merge raw Vespa documents (doc + chunks + scores) into document memory.
 * Preserves chunk-level scores; stores vespaHit on doc for answerContextMap at filter/review/synthesis.
 * toolName is stored on each signal so we can pass (tool, query, confidence) for filtering.
 */
export function mergeRawDocumentsIntoDocumentMemory(
  documentMemory: Map<string, DocumentState>,
  rawDocuments: ToolRawDocument[],
  turnNumber: number,
  query: string,
  toolName: string,
  toolCallId: string = randomUUID()
): void {
  for (const raw of rawDocuments) {
    // Query-derived documents are never merged - they are immutable snapshots
    if (isQueryDependentDoc(raw.vespaHit)) {
      const docId = `${raw.docId}::q::${toolCallId}`
      const doc = createDocumentState(docId, raw.source)
      doc.isQueryDoc = true
      doc.baseDocId = raw.docId
      doc.vespaHit = raw.vespaHit

      for (const ch of raw.chunks) {
        doc.chunks.set(ch.chunkKey, {
          content: ch.content,
          firstSeenTurn: turnNumber,
          lastSeenTurn: turnNumber,
          confidence: ch.score,
          queries: query ? [query] : [],
        })
      }

      doc.signals.push({
        query,
        confidence: raw.relevance,
        turn: turnNumber,
        toolName,
      })
      updateDocumentScores(doc, turnNumber)
      documentMemory.set(raw.docId, doc)
      continue
    }

    // Regular documents: use existing merge logic
    let doc = documentMemory.get(raw.docId)
    if (!doc) {
      doc = createDocumentState(raw.docId, raw.source)
      documentMemory.set(raw.docId, doc)
    }
    doc.cachedFragment = undefined
    doc.vespaHit = raw.vespaHit

    for (const ch of raw.chunks) {
      const key = ch.chunkKey
      const existing = doc.chunks.get(key)
      if (existing) {
        existing.confidence = Math.max(existing.confidence, ch.score)
        existing.lastSeenTurn = turnNumber
        if (!existing.queries.includes(query)) existing.queries.push(query)
      } else {
        doc.chunks.set(key, {
          content: ch.content,
          firstSeenTurn: turnNumber,
          lastSeenTurn: turnNumber,
          confidence: ch.score,
          queries: query ? [query] : [],
        })
      }
    }
    evictChunksIfNeeded(doc, turnNumber)

    const duplicateSignal = doc.signals.some(
      (s) => s.query === query && s.turn === turnNumber,
    )
    if (!duplicateSignal) {
      doc.signals.push({
        query,
        confidence: raw.relevance,
        turn: turnNumber,
        toolName,
      })
    }
    updateDocumentScores(doc, turnNumber)
  }

  evictDocumentMemoryIfNeeded(documentMemory)
  evictQueryDocsIfNeeded(documentMemory)
}

/**
 * Merge DocumentStates from a source list into the target document memory (e.g. merge ranked
 * current-turn docs into cross-turn memory after filtering). Preserves chunks (by chunkKey)
 * and appends signals (deduped by query+turn); recomputes scores and runs eviction.
 * Query-derived documents are never merged - they are inserted as immutable snapshots.
 * @param currentTurn - The actual current turn number for accurate recency scoring.
 * @returns Number of new chunks added to the target memory (for stagnation tracking).
 */
export function mergeDocumentStatesIntoDocumentMemory(
  targetMemory: Map<string, DocumentState>,
  sourceDocs: DocumentState[],
  currentTurn?: number,
): number {
  let newChunksCount = 0
  for (const src of sourceDocs) {
    // Query-derived documents are never merged - they are immutable snapshots
    if (src.isQueryDoc) {
      if (!targetMemory.has(src.docId)) {
        // Create a deep copy of the query doc
        const queryDoc = createDocumentState(src.docId, src.source)
        queryDoc.isQueryDoc = true
        queryDoc.baseDocId = src.baseDocId
        queryDoc.vespaHit = src.vespaHit
        queryDoc.relevanceScore = src.relevanceScore
        queryDoc.maxScore = src.maxScore
        
        for (const [chunkKey, ch] of src.chunks) {
          queryDoc.chunks.set(chunkKey, {
            content: ch.content,
            firstSeenTurn: ch.firstSeenTurn,
            lastSeenTurn: ch.lastSeenTurn,
            confidence: ch.confidence,
            queries: [...ch.queries],
          })
          newChunksCount++
        }
        
        for (const sig of src.signals) {
          queryDoc.signals.push({
            query: sig.query,
            confidence: sig.confidence,
            turn: sig.turn,
            toolName: sig.toolName,
          })
        }
        
        targetMemory.set(src.docId, queryDoc)
      }
      continue
    }

    // Regular documents: use existing merge logic
    let doc = targetMemory.get(src.docId)
    if (!doc) {
      doc = createDocumentState(src.docId, src.source)
      targetMemory.set(src.docId, doc)
    }
    if (src.isSynthetic) {
      doc.isSynthetic = true
      if (src.lifecycle !== undefined) doc.lifecycle = src.lifecycle
      if (src.expiresAtTurn !== undefined) doc.expiresAtTurn = src.expiresAtTurn
    }
    doc.cachedFragment = undefined
    if (src.vespaHit) doc.vespaHit = src.vespaHit

    for (const [chunkKey, ch] of src.chunks) {
      const existing = doc.chunks.get(chunkKey)
      if (existing) {
        existing.confidence = Math.max(existing.confidence, ch.confidence)
        existing.lastSeenTurn = Math.max(existing.lastSeenTurn, ch.lastSeenTurn)
        for (const q of ch.queries) {
          if (!existing.queries.includes(q)) existing.queries.push(q)
        }
      } else {
        newChunksCount++
        doc.chunks.set(chunkKey, {
          content: ch.content,
          firstSeenTurn: ch.firstSeenTurn,
          lastSeenTurn: ch.lastSeenTurn,
          confidence: ch.confidence,
          queries: [...ch.queries],
        })
      }
    }
    // Use the provided currentTurn for accurate recency, fallback to current doc's latest
    const refTurn = currentTurn ?? Math.max(...doc.signals.map((s) => s.turn), 1)
    evictChunksIfNeeded(doc, refTurn)

    for (const sig of src.signals) {
      const duplicate = doc.signals.some(
        (s) => s.query === sig.query && s.turn === sig.turn,
      )
      if (!duplicate) {
        doc.signals.push({
          query: sig.query,
          confidence: sig.confidence,
          turn: sig.turn,
          toolName: sig.toolName,
        })
      }
    }
    updateDocumentScores(doc, currentTurn)
  }

  evictDocumentMemoryIfNeeded(targetMemory)
  evictQueryDocsIfNeeded(targetMemory)
  return newChunksCount
}

/** Same shape as formatSearchToolResponse searchContext for answerContextMap (precomputed DB, chunk counts). */
export interface GetFragmentsForSynthesisOptions {
  /** For answerContextMap and getPrecomputedDbContextIfNeeded when building from vespaHit. */
  email?: string
  userId?: number | null
  workspaceId?: number | null
  query?: string
  includeImageBlocks?: boolean
}

/**
 * Export document memory as ToolRawDocument[] for passing to parent (e.g. delegation).
 * Only includes docs that have vespaHit so parent can merge and use answerContextMap.
 */
export function documentMemoryToRawDocuments(
  documentMemory: Map<string, DocumentState>,
): ToolRawDocument[] {
  const out: ToolRawDocument[] = []
  for (const doc of documentMemory.values()) {
    if (!doc.vespaHit) continue
    const chunks: RawChunkWithScore[] = Array.from(doc.chunks.entries()).map(
      ([chunkKey, c]) => ({
        chunkKey,
        content: c.content,
        score: c.confidence,
      }),
    )
    out.push({
      docId: doc.docId,
      relevance: doc.relevanceScore,
      source: doc.source,
      chunks,
      vespaHit: doc.vespaHit,
    })
  }
  return out
}

/**
 * Get documents that have signals in the turn range [fromTurn, toTurn] (inclusive).
 * Used for review: gather docs from last review to current.
 */
export function getDocsWithSignalsInTurnRange(
  documentMemory: Map<string, DocumentState>,
  fromTurn: number,
  toTurn: number
): DocumentState[] {
  const docs = Array.from(documentMemory.values())
  return docs.filter((doc) =>
    doc.signals.some((s) => s.turn >= fromTurn && s.turn <= toTurn)
  )
}

/**
 * Create a synthetic DocumentState from chat memory fragments.
 * This is for derived conversational memory, not retrievable source documents.
 * Lifecycle: removed after the next review (cleanupSyntheticDocsAfterReview).
 */
export function createSyntheticDocFromChatMemory(
  fragments: { content: string; id: string; source: Citation; confidence?: number }[],
  options: {
    chatId: string
    turnNumber: number
    query?: string
    toolCallId?: string
  }
): DocumentState {
  const normalizedToolCallId =
    typeof options.toolCallId === "string" && options.toolCallId.trim().length > 0
      ? options.toolCallId.trim()
      : null
  const uniqueInvocationId =
    normalizedToolCallId ??
    `seq:${options.turnNumber}:${syntheticChatMemoryDocSequence++}`
  const docId = `chat-memory:${options.chatId}:${uniqueInvocationId}`
  const source: Citation = {
    docId,
    title: `Chat Memory for ${options.chatId}`,
    url: "",
    app: Apps.ChatMemory,
    entity: {
      type: "chat_memory",
      chatId: options.chatId,
    } as unknown as Citation["entity"],
  }

  const doc = createDocumentState(docId, source)
  doc.isSynthetic = true
  doc.lifecycle = "until_review"

  // Add all fragments as chunks
  for (let i = 0; i < fragments.length; i++) {
    const fragment = fragments[i]
    const chunkKey = `i:${i}`
    doc.chunks.set(chunkKey, {
      content: fragment.content,
      firstSeenTurn: options.turnNumber,
      lastSeenTurn: options.turnNumber,
      confidence: fragment.confidence ?? 0.7,
      queries: options.query ? [options.query] : [],
    })
  }

  // Add a signal for this retrieval
  doc.signals.push({
    query: options.query ?? "",
    confidence: 0.7,
    turn: options.turnNumber,
    toolName: "searchChatHistory",
  })

  updateDocumentScores(doc, options.turnNumber)
  return doc
}

/**
 * Create a synthetic DocumentState from KB ls (navigation) results.
 * This is for derived navigation info, not retrievable source documents.
 * Lifecycle: removed after the next review (cleanupSyntheticDocsAfterReview).
 */
export function createSyntheticDocFromLs(
  entries: { name: string; type: string; id?: string }[],
  options: {
    targetId?: string
    targetPath?: string
    turnNumber: number
    toolCallId?: string
  }
): DocumentState {
  const targetId = options.targetId ?? "root"
  const normalizedToolCallId =
    typeof options.toolCallId === "string" && options.toolCallId.trim().length > 0
      ? options.toolCallId.trim()
      : null
  const uniqueInvocationId =
    normalizedToolCallId ??
    `seq:${options.turnNumber}:${syntheticLsDocSequence++}`
  const docId = `kb-ls:${targetId}:${uniqueInvocationId}`
  const source: Citation = {
    docId,
    title: options.targetPath ?? "Knowledge Base Navigation",
    url: "",
    app: Apps.KnowledgeBase,
    entity: {
      type: "navigation",
      targetId,
    } as unknown as Citation["entity"],
  }

  const doc = createDocumentState(docId, source)
  doc.isSynthetic = true
  doc.lifecycle = "until_review"

  // Format entries as markdown-style list
  const content = entries
    .map((e) => `- ${e.type === "file" ? "📄" : "📁"} ${e.name}`)
    .join("\n")

  doc.chunks.set("i:0", {
    content: `Knowledge Base Contents:\n\n${content}`,
    firstSeenTurn: options.turnNumber,
    lastSeenTurn: options.turnNumber,
    confidence: 0.9,
    queries: [],
  })

  doc.signals.push({
    query: "",
    confidence: 0.9,
    turn: options.turnNumber,
    toolName: "ls",
  })

  updateDocumentScores(doc, options.turnNumber)
  return doc
}

/**
 * Create a synthetic DocumentState from delegated agent response.
 * This is for derived agent output, not retrievable source documents.
 * Lifecycle: persistent for the run (not removed by review cleanup).
 */
export function createSyntheticDocFromAgent(
  resultSummary: string,
  options: {
    agentId: string
    agentName: string
    turnNumber: number
    toolQuery?: string
    delegationRunId?: string
    toolCallId?: string
  }
): DocumentState {
  const normalizedDelegationRunId =
    typeof options.delegationRunId === "string" &&
    options.delegationRunId.trim().length > 0
      ? options.delegationRunId.trim()
      : null
  const normalizedToolCallId =
    typeof options.toolCallId === "string" && options.toolCallId.trim().length > 0
      ? options.toolCallId.trim()
      : null
  const uniqueInvocationId =
    normalizedDelegationRunId ??
    normalizedToolCallId ??
    `seq:${options.turnNumber}:${syntheticDelegatedDocSequence++}`
  const docId = `delegated_agent:${options.agentId}:${uniqueInvocationId}`
  const source: Citation = {
    docId,
    title: `Delegated agent (${options.agentName})`,
    url: "",
    app: Apps.Xyne,
    entity: {
      type: "agent",
      name: options.agentName,
    } as unknown as Citation["entity"],
  }

  const doc = createDocumentState(docId, source)
  doc.isSynthetic = true
  doc.lifecycle = "persistent"

  doc.chunks.set("i:0", {
    content: resultSummary,
    firstSeenTurn: options.turnNumber,
    lastSeenTurn: options.turnNumber,
    confidence: AgentResponseConfidence,
    queries: options.toolQuery ? [options.toolQuery] : [],
  })

  doc.signals.push({
    query: options.toolQuery ?? "",
    confidence: AgentResponseConfidence,
    turn: options.turnNumber,
    toolName: "runPublicAgent",
  })

  doc.maxScore = AgentResponseConfidence
  doc.relevanceScore = AgentResponseConfidence

  return doc
}

/** Default user metadata for answerContextMap when options do not provide userId/workspaceId. */
const defaultUserMetadata: UserMetadataType = {
  userTimezone: "Asia/Kolkata",
  dateForAI: getDateForAI({ userTimeZone: "Asia/Kolkata" }),
}

/**
 * Build MinimalAgentFragment[] for a given list of docs (shared logic for synthesis/review).
 * Uses doc.cachedFragment when set (invalidated on merge); otherwise builds via answerContextMap or joined chunks and caches.
 * Note: Query is NOT passed to answerContextMap during synthesis/review to avoid incorrect recomputation of query-dependent results.
 * Query-dependent docs should have been processed during tool execution and stored as immutable snapshots. except for attachments where query is present for the first time
 * in which case the query is passed to answerContextMap to build the context for the attachments.
 */
async function buildFragmentsForDocList(
  docs: DocumentState[],
  options: GetFragmentsForSynthesisOptions
): Promise<MinimalAgentFragment[]> {
  const uncachedWithVespa = docs.filter(
    (d): d is DocumentState & { vespaHit: NonNullable<DocumentState["vespaHit"]> } =>
      !d.cachedFragment && !!d.vespaHit,
  )
  const builtUserQuery = options.query?.trim()
  // Normalize each hit so answerContextMap + getChunkCountPerDoc see the same chunk slice
  // that `doc.chunks` represents after eviction.
  const normalizedHitByDocId = new Map<string, VespaSearchResults>()
  const vespaHitsOrdered = uncachedWithVespa.map((d) => {
    const refTurn = Math.max(...d.signals.map((s) => s.turn), 1)
    const normalized = d.isQueryDoc ? d.vespaHit : normalizeVespaHitForDocumentChunks(d, {
      refTurn,
    })
    normalizedHitByDocId.set(d.docId, normalized)
    return normalized
  })

  let precomputedDbContext: Map<string, string> | undefined = undefined
  let chunksPerDocument: number[] = []

  if (vespaHitsOrdered.length > 0) {
    if(builtUserQuery) {
      precomputedDbContext = await getPrecomputedDbContextIfNeeded(
        vespaHitsOrdered,
        builtUserQuery,
        options.userId,
        options.workspaceId,
      )
    }
    chunksPerDocument = await getChunkCountPerDoc(
      vespaHitsOrdered,
      config.maxChunksPerTool,
      options.email ?? "",
    )
  }

  const metadataForContext: UserMetadataType = {
    ...defaultUserMetadata,
    userId: options.userId ?? undefined,
    workspaceId: options.workspaceId ?? undefined,
  }

  const out: MinimalAgentFragment[] = []
  let uncachedVespaIndex = 0

  for (const doc of docs) {
    if (doc.cachedFragment) {
      out.push(doc.cachedFragment)
      continue
    }

    let content: string
    let visibleChunkIndices: number[] = []
    const confidence =
      doc.chunks.size > 0
        ? Math.max(...Array.from(doc.chunks.values()).map((c) => c.confidence))
        : doc.maxScore

    if (doc.vespaHit) {
      const normalizedHit = normalizedHitByDocId.get(doc.docId) ?? doc.vespaHit
      const chunkCount =
        uncachedVespaIndex < chunksPerDocument.length
          ? chunksPerDocument[uncachedVespaIndex]
          : config.maxDefaultSummary
      const renderMetadata: AnswerContextRenderMetadata = {
        visibleChunkIndices: [],
      }
      // Note: query is NOT passed here - query-dependent processing should have happened during tool execution
      // and results stored as query docs with processed content in chunks except for attachments where query is present for the first time
      content = await answerContextMap(
        normalizedHit,
        metadataForContext,
        chunkCount,
        undefined,
        true,
        builtUserQuery, // query is present for attachments only as this is first time we are building the context for the attachments
        precomputedDbContext, // only for attachments when query is present
        renderMetadata,
        options.includeImageBlocks ?? false,
      )
      visibleChunkIndices = renderMetadata.visibleChunkIndices
      uncachedVespaIndex++
    } else {
      // Non-Vespa docs use default chunk budget (Vespa-specific budgets don't apply here)
      const refTurn = Math.max(...doc.signals.map((s) => s.turn), 1)
      const chunkEntries = Array.from(doc.chunks.entries())
      const maxChunks = config.maxDefaultSummary
      const topChunks = chunkEntries
        .sort(
          (a, b) =>
            chunkScoreForOrdering(b[1], refTurn) -
            chunkScoreForOrdering(a[1], refTurn),
        )
        .slice(0, maxChunks)
      content =
        topChunks.length > 0
          ? topChunks.map(([, c]) => c.content).join("\n\n")
          : ""
    }

    const fragment: MinimalAgentFragment = {
      id: doc.docId,
      content,
      source: doc.source,
      confidence,
      visibleChunkIndices,
    }
    doc.cachedFragment = fragment
    out.push(fragment)
  }

  return out
}

/** Position suffix in labels from answerContextMap: `{docId}_{image_chunks_pos[i]}` (optional extension). */
function imageChunkPosFromContextFileName(fileName: string): number | undefined {
  const m = fileName.match(/_(\d+)(?:\.[A-Za-z0-9]+)?$/)
  return m ? Number(m[1]) : undefined
}

export function extractImagesFromFragmentContent(
  fragment: MinimalAgentFragment,
  vespaHit: VespaSearchResults | undefined,
  isUserAttachment: boolean,
): { images: ToolOutputExtractedImage[], fragmentWithoutImageBlocks: MinimalAgentFragment } {
  if (!fragment.content || !vespaHit) return { images: [], fragmentWithoutImageBlocks: fragment }

  const content = fragment.content

  const matches = imageFileNamesBlockMatches(content)

  const fields = vespaHit.fields as Record<string, unknown> & {
    matchfeatures?: typeof vespaHit.fields.matchfeatures
  }
  const imageChunksPos = (fields.image_chunks_pos_summary as number[]) || []
  const matchfeatures = fields.matchfeatures
  const imageChunkScores =
    matchfeatures &&
    "image_chunk_scores" in matchfeatures &&
    "cells" in
      (
        matchfeatures as {
          image_chunk_scores: { cells: Record<string, number> }
        }
      ).image_chunk_scores
      ? (
          matchfeatures as {
            image_chunk_scores: { cells: Record<string, number> }
          }
        ).image_chunk_scores.cells
      : {}

  const out: ToolOutputExtractedImage[] = []
  const seen = new Set<string>()

  for (const match of matches) {
    const imageContent = (match[1] ?? "").trim()
    if (!imageContent) continue

    const tokens =
      imageContent.match(/[A-Za-z0-9._-]+_\d+(?:\.[A-Za-z0-9]+)?/g) || []
    for (const fileName of tokens) {
      if (seen.has(fileName)) continue
      const pos = imageChunkPosFromContextFileName(fileName)
      if (pos === undefined) continue
      const chunkIndex = imageChunksPos.findIndex((p) => p === pos)
      if (chunkIndex !== -1) {
        seen.add(fileName)
        out.push({
          fileName,
          isUserAttachment,
          vespaImageScore: imageChunkScores[chunkIndex] ?? 0,
          docId: fragment.source.docId ?? fragment.id,
        })
      }
    }
  }

  const contentWithoutImageBlocks = contextWithoutImageBlocksFromMatches(
    content,
    matches,
  )

  const fragmentWithoutImageBlocks: MinimalAgentFragment = {
    ...fragment,
    content: contentWithoutImageBlocks,
  }

  return { images: out, fragmentWithoutImageBlocks }
}

function mergeExtractedImagesByFileName(
  entries: ToolOutputExtractedImage[],
): ToolOutputExtractedImage[] {
  const byName = new Map<string, ToolOutputExtractedImage>()
  for (const e of entries) {
    const prev = byName.get(e.fileName)
    if (!prev || e.vespaImageScore > prev.vespaImageScore) {
      byName.set(e.fileName, e)
    }
  }
  return [...byName.values()]
}

/**
 * Collect images for one tool invocation: Vespa-scored names from fragment text plus any
 * `fragment.images` (e.g. delegation) and optional citation paths.
 */
export function gatherToolOutputExtractedImages(
  rawDocuments: ToolRawDocument[],
  toolFragments: MinimalAgentFragment[],
  imageCitations: ImageCitation[] | undefined,
): { images: ToolOutputExtractedImage[], fragmentsWithoutImageBlocks: MinimalAgentFragment[] } {
  if (!toolFragments && !imageCitations) return { images: [], fragmentsWithoutImageBlocks: [] }
  const rawById = new Map(rawDocuments.map((d) => [d.docId, d]))
  const out: ToolOutputExtractedImage[] = []
  const fragmentsWithoutImageBlocks: MinimalAgentFragment[] = []

  for (const fragment of toolFragments) {
    const raw = rawById.get(fragment.id)
    const fromVespa = extractImagesFromFragmentContent(
      fragment,
      raw?.vespaHit,
      fragment.source.app === Apps.Attachment,
    )
    out.push(...fromVespa.images)
    fragmentsWithoutImageBlocks.push(fromVespa.fragmentWithoutImageBlocks)
  }

  for (const ic of imageCitations ?? []) {
    if (!ic.imagePath) continue
    const docId = ic.item?.docId
    out.push({
      fileName: ic.imagePath,
      vespaImageScore: AgentResponseConfidence,
      isUserAttachment: false,
      docId,
    })
  }

  return { images: mergeExtractedImagesByFileName(out), fragmentsWithoutImageBlocks }
}

/**
 * Seed image memory directly from ToolOutputExtractedImage entries.
 * Used for initial attachment bootstrap where images are extracted from fragments
 * but not yet in toolOutputs (since they predate the tool execution phase).
 */
export function seedImageMemoryFromImages(
  imageMemory: Map<string, ImageMemoryEntry>,
  images: ToolOutputExtractedImage[],
  turn: number,
): void {
  for (const img of images) {
    const prev = imageMemory.get(img.fileName)
    if (!prev) {
      imageMemory.set(img.fileName, {
        fileName: img.fileName,
        vespaImageScore: img.vespaImageScore,
        isUserAttachment: img.isUserAttachment,
        docId: img.docId,
        lastMergedTurn: turn,
      })
      continue
    }

    imageMemory.set(img.fileName, {
      ...prev,
      ...(img.vespaImageScore > prev.vespaImageScore
        ? {
            vespaImageScore: img.vespaImageScore,
            isUserAttachment: img.isUserAttachment,
            docId: img.docId,
          }
        : {}),
      lastMergedTurn: turn,
    })
  }
}

/** Persist this turn's tool-extracted images into cross-turn image memory (best score wins). */
export function mergeCurrentTurnToolOutputImagesIntoImageMemory(
  context: AgentRunContext,
): void {
  const turn = context.turnCount ?? 0
  for (const out of context.currentTurnArtifacts.toolOutputs) {
    for (const img of out.extractedImages ?? []) {
      const prev = context.imageMemory.get(img.fileName)
      if (!prev) {
        context.imageMemory.set(img.fileName, {
          fileName: img.fileName,
          vespaImageScore: img.vespaImageScore,
          isUserAttachment: img.isUserAttachment,
          docId: img.docId,
          lastMergedTurn: turn,
        })
        continue
      }

      context.imageMemory.set(img.fileName, {
        ...prev,
        ...(img.vespaImageScore > prev.vespaImageScore
          ? {
              vespaImageScore: img.vespaImageScore,
              isUserAttachment: img.isUserAttachment,
              docId: img.docId,
            }
          : {}),
        lastMergedTurn: turn,
      })
    }
  }
}

export interface GetImageFileNamesForLlmOptions {
  /**
   * Doc ids in display/relevance order (e.g. fragment ids from synthesis/review).
   * When set, model paths are `{index}_{fileName}` where `index` is this doc's position in the list.
   */
  docOrder?: string[]
  maxImages?: number
}

function docIndexPrefix(
  entry: ImageMemoryEntry,
  docOrder: string[] | undefined,
): number {
  if (!docOrder?.length || !entry.docId) return 0
  const i = docOrder.indexOf(entry.docId)
  return i >= 0 ? i : 0
}

/**
 * Vespa-ranked image list for LLM: merges `imageMemory` with `toolOutputs[].extractedImages`,
 * dedupes by fileName (max vespaImageScore), sorts by score desc.
 * Paths are `{docIndex}_{fileName}` for `buildLanguageModelImageParts` (docIndex from `docOrder`, or 0).
 */
export function getImageFileNamesForLlmFromStores(
  imageMemory: Map<string, ImageMemoryEntry>,
  options?: GetImageFileNamesForLlmOptions,
): { imageFileNamesForModel: string[]; total: number; dropped: number } {
  const maxImages = options?.maxImages ?? IMAGE_CONTEXT_CONFIG.maxImagesPerCall
  const docOrder = options?.docOrder

  const all = [...imageMemory.values()].sort(
    (a, b) => b.vespaImageScore - a.vespaImageScore,
  )
  const total = all.length
  const selected = all.slice(0, maxImages)
  const imageFileNamesForModel = selected.map(
    (e) => `${docIndexPrefix(e, docOrder)}_${e.fileName}`,
  )
  const dropped = Math.max(total - selected.length, 0)
  return { imageFileNamesForModel, total, dropped }
}

/**
 * Filters out raw documents that have query-derived variants.
 * When a query doc exists for a base document, the raw doc is suppressed to avoid duplication.
 */
function filterOutRawDocsWithQueryVariants(docs: DocumentState[]): DocumentState[] {
  // Collect all base doc IDs that have query variants
  const baseDocsWithQueries = new Set<string>()
  for (const doc of docs) {
    if (doc.isQueryDoc && doc.baseDocId) {
      baseDocsWithQueries.add(doc.baseDocId)
    }
  }
  
  // Filter: keep query docs and raw docs that don't have query variants
  return docs.filter((doc) => {
    if (doc.isQueryDoc) return true // Always keep query docs
    // For raw docs, suppress if there's a query variant
    return !baseDocsWithQueries.has(doc.docId)
  })
}

/**
 * Build MinimalAgentFragment[] from document memory: one fragment per document (not per chunk).
 * Uses the same logic as formatSearchToolResponse: when doc.vespaHit is present, content is built
 * via answerContextMap(vespaHit, ...) with per-doc chunk counts.
 * When vespaHit is missing, falls back to joined top chunks by confidence.
 * Raw documents with query-derived variants are filtered out to avoid duplication.
 */
export async function getFragmentsForSynthesis(
  documentMemory: Map<string, DocumentState>,
  options: GetFragmentsForSynthesisOptions = {}
): Promise<MinimalAgentFragment[]> {
  if (!documentMemory || !(documentMemory instanceof Map)) {
    return []
  }
  const docs = Array.from(documentMemory.values())
  // Filter out raw docs that have query variants to avoid duplication
  const filteredDocs = filterOutRawDocsWithQueryVariants(docs)
  const sorted = filteredDocs
    .slice()
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, DOCUMENT_MEMORY_MAX_DOCS_FOR_LLM)
  return buildFragmentsForDocList(sorted, options)
}

/**
 * Build fragments only for the given list of docs (e.g. docs with signals in a turn range).
 * Use for review: "new context since last review" = docs with signals in (lastReviewTurn, currentTurn].
 * Raw documents with query-derived variants are filtered out to avoid duplication.
 */
export async function getFragmentsForSynthesisForDocs(
  documentMemory: Map<string, DocumentState>,
  docs: DocumentState[],
  options: GetFragmentsForSynthesisOptions = {}
): Promise<MinimalAgentFragment[]> {
  if (!documentMemory || !(documentMemory instanceof Map) || docs.length === 0) {
    return []
  }

  // Filter out raw docs that have query variants to avoid duplication
  const filteredDocs = filterOutRawDocsWithQueryVariants(docs)
  const sorted = filteredDocs
    .slice()
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, DOCUMENT_MEMORY_MAX_DOCS_FOR_LLM)
  return buildFragmentsForDocList(sorted, options)
}

/**
 * Clean up synthetic documents with `lifecycle: "ttl"` once `expiresAtTurn <= currentTurn`.
 */
export function cleanupExpiredSyntheticDocs(
  documentMemory: Map<string, DocumentState>,
  currentTurn: number
): number {
  let removedCount = 0
  const docsToRemove: string[] = []

  for (const [docId, doc] of documentMemory.entries()) {
    if (
      doc.isSynthetic &&
      doc.lifecycle === "ttl" &&
      doc.expiresAtTurn !== undefined &&
      doc.expiresAtTurn <= currentTurn
    ) {
      docsToRemove.push(docId)
    }
  }

  for (const docId of docsToRemove) {
    documentMemory.delete(docId)
    removedCount++
  }

  return removedCount
}

/**
 * After a review completes, drop synthetic docs with `lifecycle: "until_review"`.
 * `persistent` and `ttl` synthetics are not removed here.
 */
export function cleanupSyntheticDocsAfterReview(
  documentMemory: Map<string, DocumentState>,
): number {
  let removed = 0
  const ids: string[] = []
  for (const [docId, doc] of documentMemory.entries()) {
    if (!doc.isSynthetic || doc.lifecycle !== "until_review") continue
    ids.push(docId)
  }
  for (const docId of ids) {
    documentMemory.delete(docId)
    removed++
  }
  return removed
}
