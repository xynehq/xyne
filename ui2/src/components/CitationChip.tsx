// Inline footnote-style chip that replaces a `[clf-xxx#42]` token in
// assistant markdown. Click opens the CitationPanel (slide-over PDF viewer)
// at the cited chunk's resolved page number.
//
// Numbering is per-message and stable: a small CitationCounter keyed on
// `${docId}#${chunkIndex}` assigns "[1]", "[2]" in first-seen order. The
// counter is reset by the parent (MessageBubble) before each render via
// CitationNumberProvider so streaming text doesn't keep growing the numbers.

import { createContext, useContext, useRef } from "react"
import { openCitation } from "@/lib/citation-store"

// ── Numbering ──────────────────────────────────────────────────────────────
//
// Each docId gets a "major" number from the order it first appears in the
// assistant message; each chunkIndex within that doc gets a "minor". So
// the first cited chunk of the first doc is "1.1", the second chunk from
// the same doc is "1.2", and the first chunk of the next doc is "2.1".
// Assignment is lazy on first render of each chip — render order matches
// text order, which matches the order the LLM placed citations in.

class CitationNumberer {
  private readonly docs = new Map<
    string,
    { major: number; chunks: Map<number, number> }
  >()

  next(docId: string, chunkIndex: number): { major: number; minor: number } {
    let entry = this.docs.get(docId)
    if (!entry) {
      entry = { major: this.docs.size + 1, chunks: new Map() }
      this.docs.set(docId, entry)
    }
    let minor = entry.chunks.get(chunkIndex)
    if (minor === undefined) {
      minor = entry.chunks.size + 1
      entry.chunks.set(chunkIndex, minor)
    }
    return { major: entry.major, minor }
  }
}

const CitationNumberContext = createContext<CitationNumberer | null>(null)

export function CitationNumberProvider({
  children,
}: {
  children: React.ReactNode
}): JSX.Element {
  // useRef keeps the numberer stable across re-renders of the same message.
  // We reset by creating a fresh numberer per *message instance*, which is
  // what happens because each MessageBubble mounts its own provider.
  const ref = useRef<CitationNumberer | null>(null)
  if (ref.current === null) {
    ref.current = new CitationNumberer()
  }
  return (
    <CitationNumberContext.Provider value={ref.current}>
      {children}
    </CitationNumberContext.Provider>
  )
}

// ── Chip ───────────────────────────────────────────────────────────────────

export function CitationChip({
  docId,
  chunkIndex,
}: {
  docId: string
  chunkIndex: number
}): JSX.Element {
  const numberer = useContext(CitationNumberContext)
  const label = numberer
    ? (() => {
        const { major, minor } = numberer.next(docId, chunkIndex)
        return `${String(major)}.${String(minor)}`
      })()
    : `${docId.slice(-4)}#${String(chunkIndex)}`
  return (
    <button
      type="button"
      onClick={(): void => {
        void openCitation(docId, chunkIndex)
      }}
      title={`Open source · ${docId} · chunk ${String(chunkIndex)}`}
      className="mx-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md border border-border bg-secondary/60 px-1 align-baseline text-[11px] font-medium tabular-nums text-foreground/80 no-underline transition hover:border-primary/50 hover:bg-primary/10 hover:text-primary"
    >
      {label}
    </button>
  )
}
