import type { Citation, MinimalAgentFragment } from "@/api/chat/types"
import type { XyneAgentState } from "./adapter"
import type { SessionEntry, CustomEntry } from "@mariozechner/pi-coding-agent"

export const CITATION_ENTRY_TYPE = "xyne_citation_state"

// ── Persisted types ────────────────────────────────────────────────────

/** Minimal source fields required for citation rendering. */
export interface PersistedFragmentSource {
  docId: string
  title?: string
  url?: string
  app: Citation["app"]
  entity: Citation["entity"]
  clId?: string
  itemId?: string
}

/** Minimal fragment stored in the session entry. */
export interface PersistedFragment {
  id: string
  source: PersistedFragmentSource
}

/** A single citationDocId → fragmentId mapping. */
export interface CitationMapping {
  citationDocId: number
  fragmentId: string
}

/** Shape of the data persisted via appendCustomEntry. */
export interface PersistedCitationState {
  fragments: PersistedFragment[]
  mappings: CitationMapping[]
  seenChunks: string[]
  seenDocIds: string[]
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

export function buildCitationSnapshot(
  xyneState: XyneAgentState,
): PersistedCitationState {
  // Deduplicate fragments by id
  const seen = new Set<string>()
  const uniqueFragments: PersistedFragment[] = []

  for (const f of xyneState.allFragments) {
    if (!seen.has(f.id)) {
      seen.add(f.id)
      uniqueFragments.push(toPersistedFragment(f))
    }
  }

  const mappings: CitationMapping[] = []
  for (const [citationDocId, fragmentId] of xyneState.citationDocIdMapping) {
    mappings.push({ citationDocId, fragmentId })
  }

  return {
    fragments: uniqueFragments,
    mappings,
    seenChunks: Array.from(xyneState.seenChunks),
    seenDocIds: Array.from(xyneState.seenDocIds),
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
  // Collect all citation state entries (there may be one per prior turn)
  const citationEntries = entries.filter(
    (e): e is CustomEntry<PersistedCitationState> =>
      e.type === "custom" && e.customType === CITATION_ENTRY_TYPE,
  )

  console.log(`Restoring citation state from ${citationEntries.length} entries`)
  if (citationEntries.length === 0) return

  // Use a Map to deduplicate fragments across turns
  const fragmentById = new Map<string, MinimalAgentFragment>()
  const allMappings = new Map<number, string>()

  for (const entry of citationEntries) {
    const data = entry.data
    if (!data) continue

    // Restore fragments
    for (const pf of data.fragments) {
      if (!fragmentById.has(pf.id)) {
        fragmentById.set(pf.id, fromPersistedFragment(pf))
      }
    }

    // Restore mappings — later entries win on conflicts
    for (const m of data.mappings) {
      allMappings.set(m.citationDocId, m.fragmentId)
    }

    // Restore seen sets
    for (const chunk of data.seenChunks) {
      xyneState.seenChunks.add(chunk)
    }
    for (const docId of data.seenDocIds) {
      xyneState.seenDocIds.add(docId)
    }
  }

  // Merge into state
  xyneState.allFragments.push(...fragmentById.values())
  for (const [citationDocId, fragmentId] of allMappings) {
    xyneState.citationDocIdMapping.set(citationDocId, fragmentId)
  }
}
