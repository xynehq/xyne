import type { Citation, MinimalAgentFragment } from "@/api/chat/types"
import type { CustomEntry, SessionEntry } from "@mariozechner/pi-coding-agent"
import type { XyneAgentState } from "./adapter"

export const CITATION_ENTRY_TYPE = "xyne_citation_state"

export interface PersistedFragmentSource {
  docId: string
  title?: string
  url?: string
  app: Citation["app"]
  entity: Citation["entity"]
  clId?: string
  itemId?: string
}

export interface PersistedFragment {
  id: string
  source: PersistedFragmentSource
}

export interface CitationMapping {
  citationDocId: number
  fragmentId: string
}

export interface CitationDelta {
  turnIndex: number
  newFragments: PersistedFragment[]
  newMappings: CitationMapping[]
  newSeenChunks: string[]
  newSeenDocIds: string[]
}

export function trackFragments(
  fragments: MinimalAgentFragment[],
  startIndex: number,
  xyneState: XyneAgentState,
): void {
  xyneState.allFragments.push(...fragments)

  for (let idx = 0; idx < fragments.length; idx++) {
    const fragment = fragments[idx]
    const citationDocId = startIndex + idx

    xyneState.citationDocIdMapping.set(citationDocId, fragment.id)

    const docId = fragment.source?.docId
    const returnedChunks = fragment.source?.returnedChunkIndices

    if (docId && returnedChunks && returnedChunks.length > 0) {
      for (const chunkIdx of returnedChunks) {
        xyneState.seenChunks.add(`${docId}_${chunkIdx}`)
      }
    }

    if (docId) {
      xyneState.seenDocIds.add(docId)
    }
  }
}

function toPersistedFragment(f: MinimalAgentFragment): PersistedFragment {
  return {
    id: f.id,
    source: {
      docId: f.source.docId,
      ...(f.source.title && { title: f.source.title }),
      ...(f.source.url && { url: f.source.url }),
      app: f.source.app,
      entity: f.source.entity,
      ...(f.source.clId && { clId: f.source.clId }),
      ...(f.source.itemId && { itemId: f.source.itemId }),
    },
  }
}

export function buildCitationDelta(
  xyneState: XyneAgentState,
  turnIndex: number,
): CitationDelta {
  // Get fragments from current turn only
  const turnFragments = xyneState.allFragments ?? []
  const newFragments: PersistedFragment[] =
    turnFragments.map(toPersistedFragment)
  const newMappings: CitationMapping[] = []

  // Build mappings from the citationDocIdMapping for this turn's range
  for (const [citationDocId, fragmentId] of xyneState.citationDocIdMapping) {
    // A mapping is "new" if it maps to a fragment from this turn
    const fragmentIndex = turnFragments.findIndex((f) => f.id === fragmentId)
    if (fragmentIndex >= 0) {
      newMappings.push({ citationDocId, fragmentId })
    }
  }

  const newSeenChunks: string[] = []
  const newSeenDocIds: string[] = []
  const processedDocIds = new Set<string>()

  for (const fragment of turnFragments) {
    const docId = fragment.source?.docId
    const returnedChunks = fragment.source?.returnedChunkIndices

    if (docId) {
      if (!processedDocIds.has(docId)) {
        newSeenDocIds.push(docId)
        processedDocIds.add(docId)
      }

      if (returnedChunks && returnedChunks.length > 0) {
        for (const chunkIdx of returnedChunks) {
          newSeenChunks.push(`${docId}_${chunkIdx}`)
        }
      }
    }
  }

  return {
    turnIndex,
    newFragments,
    newMappings,
    newSeenChunks,
    newSeenDocIds,
  }
}

function fromPersistedFragment(p: PersistedFragment): MinimalAgentFragment {
  return {
    id: p.id,
    content: "", // Not needed for citation resolution
    source: {
      docId: p.source.docId,
      title: p.source.title,
      url: p.source.url,
      app: p.source.app,
      entity: p.source.entity,
      clId: p.source.clId,
      itemId: p.source.itemId,
    },
    confidence: 0,
    visibleChunkIndices: [],
  }
}

export function restoreCitationState(
  entries: SessionEntry[],
  xyneState: XyneAgentState,
): void {
  const citationEntries = entries.filter(
    (e): e is CustomEntry<CitationDelta> =>
      e.type === "custom" && e.customType === CITATION_ENTRY_TYPE,
  )

  console.log(`Restoring citation state from ${citationEntries.length} entries`)
  if (citationEntries.length === 0) return

  // Track seen fragment IDs to avoid duplicates
  const seenFragmentIds = new Set<string>()

  for (const entry of citationEntries) {
    const delta = entry.data
    if (!delta) continue
    // Restore new fragments from this delta
    for (const pf of delta.newFragments) {
      if (!seenFragmentIds.has(pf.id)) {
        seenFragmentIds.add(pf.id)
        xyneState.allFragments.push(fromPersistedFragment(pf))
      }
    }

    for (const m of delta.newMappings) {
      xyneState.citationDocIdMapping.set(m.citationDocId, m.fragmentId)
    }

    // Restore seen sets
    for (const chunk of delta.newSeenChunks) {
      xyneState.seenChunks.add(chunk)
    }
    for (const docId of delta.newSeenDocIds) {
      xyneState.seenDocIds.add(docId)
    }
  }
}
