// Spotlight-style "go to file" palette. Triggered by ⌘K (Ctrl+K on
// non-mac) from any authenticated route. Searches file names across every
// collection the viewer can read and opens the chosen file in the standalone
// viewer route. Folders / collections aren't surfaced here yet — the v2
// product brief explicitly scopes this to file names first.
//
// Design notes
// - Top-aligned modal (mt-[18vh]) so the input lands near where the user's
//   eyes already are after pressing the shortcut, instead of mid-screen.
// - Single keyboard model: ↑/↓ move the highlight, ⏎ opens, Esc closes. No
//   mouse-only paths.
// - Debounced fetch (~140ms) so typing fast doesn't fire a request per
//   keystroke; an in-flight request that has been superseded is dropped via
//   a stale-token check (no AbortController to keep the wire shape simple).
// - Match highlight is computed in JS rather than dangerouslySetInnerHTML —
//   the query is unsanitised by definition, so we keep it in React nodes.

import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "@tanstack/react-router"
import { File, Loader2, Search, X } from "lucide-react"

import { searchFiles, type FileSearchHit } from "@/lib/kb"
import { extOf, formatDate } from "@/lib/files"
import { cn } from "@/lib/utils"

type Props = {
  open: boolean
  onClose: () => void
  initialQuery?: string
}

const DEBOUNCE_MS = 140
const MAX_RESULTS = 25

export function CommandPalette({
  open,
  onClose,
  initialQuery = "",
}: Props): JSX.Element | null {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  const [query, setQuery] = useState("")
  const [results, setResults] = useState<FileSearchHit[]>([])
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  useEffect((): void => {
    if (!open) {
      return
    }
    setQuery(initialQuery)
    setResults([])
    setActive(0)
    setLoading(false)
    setError(null)
    setTouched(false)
  }, [open, initialQuery])

  useEffect((): (() => void) | undefined => {
    if (!open) {
      return undefined
    }
    const t = window.setTimeout((): void => {
      inputRef.current?.focus()
    }, 10)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return (): void => {
      window.clearTimeout(t)
      document.body.style.overflow = prevOverflow
    }
  }, [open])

  // Debounced fetch. `token` is closed over by the timeout callback so a
  // request that resolves after the user types again (and bumps the token)
  // is dropped before it can overwrite state.
  const tokenRef = useRef(0)
  useEffect((): (() => void) | undefined => {
    if (!open) {
      return undefined
    }
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      setResults([])
      setLoading(false)
      setError(null)
      return undefined
    }
    setLoading(true)
    setError(null)
    const myToken = ++tokenRef.current
    const handle = window.setTimeout((): void => {
      searchFiles(trimmed, MAX_RESULTS)
        .then((rows): void => {
          if (myToken !== tokenRef.current) {
            return
          }
          setResults(rows)
          setActive(0)
          setTouched(true)
        })
        .catch((err: unknown): void => {
          if (myToken !== tokenRef.current) {
            return
          }
          const msg = err instanceof Error ? err.message : "Search failed"
          setError(msg)
          setResults([])
        })
        .finally((): void => {
          if (myToken !== tokenRef.current) {
            return
          }
          setLoading(false)
        })
    }, DEBOUNCE_MS)
    return (): void => {
      window.clearTimeout(handle)
    }
  }, [open, query])

  // Move the highlight + scroll it into view. Keep this in one helper so
  // the keyboard handler and the index reset on new results share logic.
  const focusIndex = useCallback((next: number): void => {
    setActive(next)
    const ul = listRef.current
    if (!ul) {
      return
    }
    const item = ul.querySelector<HTMLElement>(
      `[data-result-index="${String(next)}"]`,
    )
    if (item) {
      // `block: "nearest"` avoids the abrupt center-scroll most palettes
      // do — feels less twitchy when the list is short.
      item.scrollIntoView({ block: "nearest" })
    }
  }, [])

  const openHit = useCallback(
    (hit: FileSearchHit): void => {
      onClose()
      void navigate({
        to: "/kb/file/$itemId",
        params: { itemId: hit.id },
        search: { cl: hit.collectionId },
      })
    },
    [navigate, onClose],
  )

  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
        return
      }
      if (results.length === 0) {
        return
      }
      if (e.key === "ArrowDown") {
        e.preventDefault()
        focusIndex((active + 1) % results.length)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        focusIndex((active - 1 + results.length) % results.length)
        return
      }
      if (e.key === "Home") {
        e.preventDefault()
        focusIndex(0)
        return
      }
      if (e.key === "End") {
        e.preventDefault()
        focusIndex(results.length - 1)
        return
      }
      if (e.key === "Enter") {
        e.preventDefault()
        const hit = results[active]
        if (hit) {
          openHit(hit)
        }
      }
    },
    [active, focusIndex, onClose, openHit, results],
  )

  const trimmed = query.trim()
  const showEmpty = !loading && touched && trimmed.length > 0 && results.length === 0 && !error

  if (!open || typeof document === "undefined") {
    return null
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh] sm:pt-[18vh]"
      role="presentation"
      onMouseDown={(e): void => {
        if (e.target === e.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        aria-hidden
        className="absolute inset-0 bg-black/55 backdrop-blur-sm animate-fade-in"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search files"
        className={cn(
          "relative z-10 flex w-full max-w-[640px] flex-col overflow-hidden",
          "rounded-2xl border border-border bg-surface-elevated shadow-2xl",
          "animate-scale-in",
        )}
        onMouseDown={(e): void => {
          e.stopPropagation()
        }}
      >
        {/* Search bar — mimics the rest of ui2's input affordances but sized
            larger so a palette feels like one. */}
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
          <Search
            className="h-4 w-4 flex-shrink-0 text-muted-foreground"
            aria-hidden
            strokeWidth={1.75}
          />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e): void => {
              setQuery(e.target.value)
            }}
            onKeyDown={onKey}
            placeholder="Search files by name across every collection…"
            aria-label="Search files"
            aria-autocomplete="list"
            aria-controls="command-palette-results"
            aria-activedescendant={
              results.length > 0
                ? `command-palette-row-${String(active)}`
                : undefined
            }
            className="h-9 flex-1 bg-transparent text-[14px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
          />
          {loading ? (
            <Loader2
              className="h-3.5 w-3.5 animate-spin text-muted-foreground"
              aria-hidden
              strokeWidth={1.75}
            />
          ) : null}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
          </button>
        </div>

        {/* Body — fixed max-height so a long result list scrolls inside the
            modal instead of pushing the footer off-screen. */}
        <div className="max-h-[min(60vh,420px)] overflow-y-auto">
          {error ? (
            <ErrorPane message={error} />
          ) : trimmed.length === 0 ? (
            <HintPane />
          ) : showEmpty ? (
            <EmptyPane query={trimmed} />
          ) : results.length === 0 && loading ? (
            <LoadingPane />
          ) : (
            <ul
              id="command-palette-results"
              ref={listRef}
              role="listbox"
              aria-label="File results"
              className="py-1"
            >
              {results.map((hit, idx): JSX.Element => {
                const isActive = idx === active
                return (
                  <li
                    key={hit.id}
                    id={`command-palette-row-${String(idx)}`}
                    data-result-index={idx}
                    role="option"
                    aria-selected={isActive}
                    onMouseEnter={(): void => {
                      setActive(idx)
                    }}
                    onMouseDown={(e): void => {
                      // mousedown rather than click so we win the focus
                      // race against the input's blur on backdrop clicks.
                      e.preventDefault()
                      openHit(hit)
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 px-3.5 py-2 transition-colors",
                      isActive
                        ? "bg-secondary text-foreground"
                        : "text-foreground hover:bg-secondary/60",
                    )}
                  >
                    <ResultIcon name={hit.name} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13.5px] leading-tight">
                        {highlight(hit.name, trimmed)}
                      </span>
                      <span className="truncate text-[11.5px] leading-tight text-muted-foreground">
                        {breadcrumb(hit)}
                      </span>
                    </div>
                    <span className="hidden flex-shrink-0 text-[11px] text-muted-foreground/80 sm:inline">
                      {formatDate(hit.updatedAt)}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Footer hint band — keyboard affordances live here so we don't
            have to surface a help affordance separately. */}
        <div className="flex items-center justify-between gap-2 border-t border-border bg-surface px-3.5 py-2 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <KeyHint keys={["↑", "↓"]} label="navigate" />
            <KeyHint keys={["↵"]} label="open" />
            <KeyHint keys={["esc"]} label="close" />
          </div>
          <span className="hidden sm:inline">
            {results.length > 0
              ? `${String(results.length)} result${results.length === 1 ? "" : "s"}`
              : ""}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── Sub-views ──────────────────────────────────────────────────────────────

function HintPane(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-surface text-muted-foreground">
        <Search className="h-4 w-4" aria-hidden strokeWidth={1.5} />
      </span>
      <p className="text-[13px] font-medium text-foreground">
        Find any file by name
      </p>
      <p className="max-w-xs text-[12px] leading-snug text-muted-foreground">
        Start typing — we'll search every collection you can read. You don't
        need to be in the right folder.
      </p>
    </div>
  )
}

function LoadingPane(): JSX.Element {
  return (
    <ul className="py-1" aria-busy="true" aria-label="Loading">
      {Array.from({ length: 5 }).map((_, i) => (
        <li
          key={i}
          aria-hidden
          className="mx-3.5 my-1 flex items-center gap-3"
        >
          <div className="h-7 w-7 flex-shrink-0 animate-breathe rounded-md bg-surface" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="h-2 w-2/3 animate-breathe rounded-full bg-surface" />
            <div className="h-2 w-1/3 animate-breathe rounded-full bg-surface" />
          </div>
        </li>
      ))}
    </ul>
  )
}

function EmptyPane({ query }: { query: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-surface text-muted-foreground">
        <File className="h-4 w-4" aria-hidden strokeWidth={1.5} />
      </span>
      <p className="text-[13px] font-medium text-foreground">No matches</p>
      <p className="max-w-xs text-[12px] leading-snug text-muted-foreground">
        Nothing matched <span className="font-medium text-foreground">"{query}"</span>.
        Try a shorter or different term.
      </p>
    </div>
  )
}

function ErrorPane({ message }: { message: string }): JSX.Element {
  return (
    <div className="px-4 py-6 text-center">
      <p className="text-[12.5px] text-red-600 dark:text-red-400">{message}</p>
    </div>
  )
}

function ResultIcon({ name }: { name: string }): JSX.Element {
  // Cheap visual cue rather than full FileCard — the palette is dense and a
  // tiny coloured square reads faster than a paper-mock card. The colour
  // bucket is keyed off extension so it stays consistent with the KB grid.
  const ext = extOf(name) || "file"
  const tone = TONE_FOR_EXT[ext] ?? "bg-zinc-500 text-white"
  const label = ext.toUpperCase().slice(0, 4)
  return (
    <span
      aria-hidden
      className={cn(
        "grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-[8.5px] font-semibold uppercase tracking-wide",
        tone,
      )}
    >
      {label}
    </span>
  )
}

const TONE_FOR_EXT: Record<string, string> = {
  pdf: "bg-red-500 text-white",
  doc: "bg-blue-500 text-white",
  docx: "bg-blue-500 text-white",
  md: "bg-neutral-600 text-white",
  txt: "bg-gray-500 text-white",
  csv: "bg-teal-700 text-white",
  xls: "bg-emerald-600 text-white",
  xlsx: "bg-emerald-600 text-white",
  ppt: "bg-orange-500 text-white",
  pptx: "bg-orange-500 text-white",
  json: "bg-yellow-500 text-white",
  png: "bg-pink-500 text-white",
  jpg: "bg-pink-600 text-white",
  jpeg: "bg-pink-600 text-white",
  gif: "bg-pink-600 text-white",
  webp: "bg-pink-500 text-white",
  mp4: "bg-green-700 text-white",
  mov: "bg-green-700 text-white",
}

function KeyHint({
  keys,
  label,
}: {
  keys: string[]
  label: string
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k, i) => (
        <kbd
          key={`${k}-${String(i)}`}
          className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded border border-border bg-surface px-1 font-sans text-[10px] text-muted-foreground"
        >
          {k}
        </kbd>
      ))}
      <span>{label}</span>
    </span>
  )
}

// Render `name` with the first occurrence of `q` highlighted. Case-insensitive.
// Returns plain text when q is empty or not found.
function highlight(name: string, q: string): React.ReactNode {
  if (q === "") {
    return name
  }
  const lower = name.toLowerCase()
  const idx = lower.indexOf(q.toLowerCase())
  if (idx < 0) {
    return name
  }
  const before = name.slice(0, idx)
  const match = name.slice(idx, idx + q.length)
  const after = name.slice(idx + q.length)
  return (
    <>
      {before}
      <span className="rounded-sm bg-foreground/10 px-[1px] font-medium text-foreground">
        {match}
      </span>
      {after}
    </>
  )
}

function breadcrumb(hit: FileSearchHit): string {
  const collection = hit.collectionName || "Collection"
  // path is "/" for files at collection root or "/Drafts/sub/" for nested.
  // Strip leading & trailing slash and replace with " / " separators for
  // display. Empty inner path → just the collection name.
  const inner = hit.path.replace(/^\/|\/$/g, "")
  return inner.length === 0 ? collection : `${collection} / ${inner.split("/").join(" / ")}`
}
