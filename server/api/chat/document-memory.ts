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
  ChunkState,
  DocumentImageReference,
  DocumentState,
  RawChunkWithScore,
  ToolRawDocument,
} from "./agent-schemas"
import {
  DOCUMENT_MEMORY_MAX_CHUNKS_PER_DOC,
  DOCUMENT_MEMORY_MAX_DOCS,
  DOCUMENT_MEMORY_MAX_DOCS_FOR_LLM,
} from "./agent-schemas"
import type { Citation, MinimalAgentFragment } from "./types"
import { answerContextMap } from "@/ai/context"
import config from "@/config"
import { getPrecomputedDbContextIfNeeded } from "@/lib/databaseContext"
import type { UserMetadataType } from "@/types"
import { getDateForAI } from "@/utils/index"
import { getChunkCountPerDoc } from "./chunk-selection"
import { Apps } from "@xyne/vespa-ts/types"
import type { VespaSearchResults } from "@xyne/vespa-ts"

/** Stable chunk key when not provided: hash of content. */
export function chunkKeyFromContent(content: string): string {
  let h = 0
  const s = content.trim()
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i)
    h |= 0
  }
  return `c:${h}`
}

/** Create an empty DocumentState. */
export function createDocumentState(docId: string, source: Citation): DocumentState {
  return {
    docId,
    source,
    chunks: new Map(),
    signals: [],
    maxScore: 0,
    relevanceScore: 0,
    images: [],
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
  targetQuery?: string,
): number {
  const recencyBoost = refTurn > 0 ? 0.1 * (c.lastSeenTurn / refTurn) : 0

  const norm = (v: string) => v.toLowerCase().trim()
  const target = targetQuery?.trim() ? norm(targetQuery) : ""
  const uniqueChunkQueries = Array.from(new Set((c.queries ?? []).map(norm)))
  const frequency = uniqueChunkQueries.length

  // Binary query match: boosts when any retrieved query overlaps the active query.
  const queryMatch =
    target.length > 0 &&
    uniqueChunkQueries.some((q) => q === target || q.includes(target) || target.includes(q))
      ? 1
      : 0

  return c.confidence + recencyBoost + 0.1 * queryMatch + 0.05 * frequency
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
  orderedBy: { refTurn: number; builtUserQuery: string },
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
        orderedBy.builtUserQuery,
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
 * Merge raw Vespa documents (doc + chunks + scores) into document memory.
 * Preserves chunk-level scores; stores vespaHit on doc for answerContextMap at filter/review/synthesis.
 * toolName is stored on each signal so we can pass (tool, query, confidence) for filtering.
 */
export function mergeRawDocumentsIntoDocumentMemory(
  documentMemory: Map<string, DocumentState>,
  rawDocuments: ToolRawDocument[],
  turnNumber: number,
  query: string,
  toolName: string
): void {
  for (const raw of rawDocuments) {
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
}

/**
 * Merge DocumentStates from a source list into the target document memory (e.g. merge ranked
 * current-turn docs into cross-turn memory after filtering). Preserves chunks (by chunkKey)
 * and appends signals (deduped by query+turn); recomputes scores and runs eviction.
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
  return newChunksCount
}

/** Same shape as formatSearchToolResponse searchContext for answerContextMap (precomputed DB, chunk counts). */
export interface GetFragmentsForSynthesisOptions {
  /** For answerContextMap and getPrecomputedDbContextIfNeeded when building from vespaHit. */
  email?: string
  userId?: number | null
  workspaceId?: number | null
  query?: string
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
  }
): DocumentState {
  const docId = `chat-memory:${options.chatId}:${options.turnNumber}`
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
  }
): DocumentState {
  const targetId = options.targetId ?? "root"
  const docId = `kb-ls:${targetId}:${options.turnNumber}`
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
  }
): DocumentState {
  const docId = `delegated_agent:${options.agentId}:turn:${options.turnNumber}`
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

  doc.chunks.set(chunkKeyFromContent(resultSummary), {
    content: resultSummary,
    firstSeenTurn: options.turnNumber,
    lastSeenTurn: options.turnNumber,
    confidence: 0.85,
    queries: options.toolQuery ? [options.toolQuery] : [],
  })

  doc.signals.push({
    query: options.toolQuery ?? "",
    confidence: 0.85,
    turn: options.turnNumber,
    toolName: "runPublicAgent",
  })

  doc.maxScore = 0.85
  doc.relevanceScore = 0.85

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
 */
async function buildFragmentsForDocList(
  docs: DocumentState[],
  options: GetFragmentsForSynthesisOptions
): Promise<MinimalAgentFragment[]> {
  const sorted = docs
    .slice()
    .sort((a, b) => b.relevanceScore - a.relevanceScore)

  const uncachedWithVespa = sorted.filter(
    (d): d is DocumentState & { vespaHit: NonNullable<DocumentState["vespaHit"]> } =>
      !d.cachedFragment && !!d.vespaHit,
  )
  const builtUserQuery =
    options.query?.trim() ??
    (uncachedWithVespa[0]?.signals[0]?.query ?? sorted[0]?.signals[0]?.query ?? "")

  // Normalize each hit so answerContextMap + getChunkCountPerDoc see the same chunk slice
  // that `doc.chunks` represents after eviction.
  const normalizedHitByDocId = new Map<string, VespaSearchResults>()
  const vespaHitsOrdered = uncachedWithVespa.map((d) => {
    const refTurn = Math.max(...d.signals.map((s) => s.turn), 1)
    const normalized = normalizeVespaHitForDocumentChunks(d, {
      refTurn,
      builtUserQuery,
    })
    normalizedHitByDocId.set(d.docId, normalized)
    return normalized
  })

  let precomputedDbContext: Map<string, string> = new Map()
  let chunksPerDocument: number[] = []

  if (vespaHitsOrdered.length > 0) {
    precomputedDbContext = await getPrecomputedDbContextIfNeeded(
      vespaHitsOrdered,
      builtUserQuery || undefined,
      options.userId,
      options.workspaceId,
    )
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

  for (const doc of sorted) {
    if (doc.cachedFragment) {
      out.push(doc.cachedFragment)
      continue
    }

    let content: string
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
      content = await answerContextMap(
        normalizedHit,
        metadataForContext,
        chunkCount,
        undefined,
        true,
        builtUserQuery || undefined,
        precomputedDbContext,
      )
      uncachedVespaIndex++
    } else {
      // Non-Vespa docs use default chunk budget (Vespa-specific budgets don't apply here)
      const refTurn = Math.max(...doc.signals.map((s) => s.turn), 1)
      const chunkEntries = Array.from(doc.chunks.entries())
      const maxChunks = config.maxDefaultSummary
      const topChunks = chunkEntries
        .sort(
          (a, b) =>
            chunkScoreForOrdering(b[1], refTurn, builtUserQuery) -
            chunkScoreForOrdering(a[1], refTurn, builtUserQuery),
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
    }
    doc.cachedFragment = fragment
    const extractedImages = extractImagesFromFragmentContent(
      fragment.content,
      doc.source.app === Apps.Attachment,
    )
    if (extractedImages.length > 0) {
      doc.images = extractedImages
    } else if (!Array.isArray(doc.images)) {
      doc.images = []
    }
    out.push(fragment)
  }

  return out
}

function extractImagesFromFragmentContent(
  content: string,
  isAttachment: boolean,
): DocumentImageReference[] {
  if (!content) return []

  // answerContextMap emits an "Image File Names:" section. We store raw file names
  // (without docIndex prefix); callers can map docId→index later when constructing
  // the model image list.
  const imageContentRegex =
    /Image File Names:\s*([\s\S]*?)(?=\n[A-Z][a-zA-Z ]*:|vespa relevance score:|$)/g
  const matches = [...content.matchAll(imageContentRegex)]

  const out: DocumentImageReference[] = []
  const seen = new Set<string>()

  for (const match of matches) {
    const imageContent = (match[1] ?? "").trim()
    if (!imageContent) continue

    const tokens =
      imageContent.match(/[A-Za-z0-9._-]+_\d+(?:\.[A-Za-z0-9]+)?/g) || []
    for (const fileName of tokens) {
      if (seen.has(fileName)) continue
      seen.add(fileName)
      out.push({ fileName, isAttachment })
    }
  }

  return out
}

export function getAllImagesFromDocumentMemory(
  documentMemory: Map<string, DocumentState>,
  options?: {
    /** Order docs by relevance for the current turn */
    docOrder?: string[]
    maxImages?: number
  },
): { imageFileNamesForModel: string[]; total: number; dropped: number } {
  const maxImages = options?.maxImages ?? Number.POSITIVE_INFINITY

  // Determine doc ordering: if provided, use it (usually synthesis doc order).
  // Otherwise fall back to relevanceScore desc.
  const docs: DocumentState[] = Array.from(documentMemory.values())
  let orderedDocs = docs
  if (options?.docOrder && options.docOrder.length > 0) {
    const byId = new Map(docs.map((d) => [d.docId, d]))
    orderedDocs = options.docOrder
      .map((id) => byId.get(id))
      .filter((d): d is DocumentState => d != null)
  } else {
    orderedDocs = docs.slice().sort((a, b) => b.relevanceScore - a.relevanceScore)
  }

  const seen = new Set<string>()
  const selected: string[] = []
  let total = 0

  for (let docIndex = 0; docIndex < orderedDocs.length; docIndex++) {
    const doc = orderedDocs[docIndex]
    for (const img of doc.images ?? []) {
      total++
      if (seen.has(img.fileName)) continue
      seen.add(img.fileName)
      if (selected.length < maxImages) {
        // Model expects docIndex-prefixed file name.
        selected.push(`${docIndex}_${img.fileName}`)
      }
    }
  }

  const dropped = Math.max(total - selected.length, 0)
  return { imageFileNamesForModel: selected, total, dropped }
}

/**
 * Build MinimalAgentFragment[] from document memory: one fragment per document (not per chunk).
 * Uses the same logic as formatSearchToolResponse: when doc.vespaHit is present, content is built
 * via answerContextMap(vespaHit, ...) with precomputed DB context and per-doc chunk counts.
 * When vespaHit is missing, falls back to joined top chunks by confidence.
 */
export async function getFragmentsForSynthesis(
  documentMemory: Map<string, DocumentState>,
  options: GetFragmentsForSynthesisOptions = {}
): Promise<MinimalAgentFragment[]> {
  if (!documentMemory || !(documentMemory instanceof Map)) {
    return []
  }
  const docs = Array.from(documentMemory.values())
  const sorted = docs
    .slice()
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, DOCUMENT_MEMORY_MAX_DOCS_FOR_LLM)
  return buildFragmentsForDocList(sorted, options)
}

/**
 * Build fragments only for the given list of docs (e.g. docs with signals in a turn range).
 * Use for review: "new context since last review" = docs with signals in (lastReviewTurn, currentTurn].
 */
export async function getFragmentsForSynthesisForDocs(
  documentMemory: Map<string, DocumentState>,
  docs: DocumentState[],
  options: GetFragmentsForSynthesisOptions = {}
): Promise<MinimalAgentFragment[]> {
  if (!documentMemory || !(documentMemory instanceof Map) || docs.length === 0) {
    return []
  }

  const sorted = docs
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
