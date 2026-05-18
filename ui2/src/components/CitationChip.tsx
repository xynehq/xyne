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

class CitationNumberer {
  private readonly map = new Map<string, number>()
  next(key: string): number {
    const existing = this.map.get(key)
    if (existing !== undefined) return existing
    const n = this.map.size + 1
    this.map.set(key, n)
    return n
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
  const key = `${docId}#${String(chunkIndex)}`
  const n = numberer ? numberer.next(key) : 0
  const label = n > 0 ? String(n) : `${docId.slice(-4)}#${String(chunkIndex)}`
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
