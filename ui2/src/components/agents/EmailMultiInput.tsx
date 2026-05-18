import { useEffect, useMemo, useRef, useState } from "react"
import {
  Check,
  ChevronDown,
  ChevronUp,
  Search,
  UserPlus,
  X,
} from "lucide-react"
import {
  type WorkspaceUser,
  searchWorkspaceUsers,
} from "@/lib/api"

// Designed for the "private agent has 100–200 viewers" case. Combines three
// flows so the same component handles the small (5 people) and large (200
// people) inputs without becoming clumsy at either:
//   1. Autocomplete by name/email — type-ahead against the workspace's
//      user directory; pick from a dropdown. Fast for "I know who they are".
//   2. Bulk paste — open a textarea, drop a CSV / column / line-separated
//      list, the component parses, dedupes, validates, and adds. Fast for
//      "I have a roster somewhere".
//   3. Manage the selected list — collapsed by default ("142 viewers") with
//      "Show all" expanding into a searchable list with per-row remove.

type Props = {
  label: string
  hint?: string
  emails: string[]
  onChange: (next: string[]) => void
  /** Emails already used elsewhere (e.g. co-owners when this is viewers). We
   *  surface them as warnings so the user understands what's blocked. */
  excludeEmails?: string[]
}

const isValidEmail = (s: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

/** Splits a paste blob on common separators and trims/filters. */
const parsePaste = (raw: string): string[] => {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function EmailMultiInput({
  label,
  hint,
  emails,
  onChange,
  excludeEmails = [],
}: Props): JSX.Element {
  const excludeSet = useMemo(
    () => new Set(excludeEmails.map((e) => e.toLowerCase())),
    [excludeEmails],
  )

  const [query, setQuery] = useState("")
  const [suggestions, setSuggestions] = useState<WorkspaceUser[]>([])
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [bulkMode, setBulkMode] = useState(false)
  const [bulkDraft, setBulkDraft] = useState("")
  const [bulkReport, setBulkReport] = useState<null | {
    added: number
    duplicates: number
    invalid: number
    blocked: number
  }>(null)
  const [chipFilter, setChipFilter] = useState("")

  const rootRef = useRef<HTMLDivElement | null>(null)

  // Click-outside collapses the autocomplete suggestion list.
  useEffect((): (() => void) => {
    const onDoc = (e: MouseEvent): void => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => {
      document.removeEventListener("mousedown", onDoc)
    }
  }, [])

  // Debounced workspace search. 180ms is short enough to feel responsive,
  // long enough to avoid hammering the API on every keystroke.
  // `cancelled` is scoped to the effect (not the timeout callback) so the
  // cleanup actually has a handle to flip it — otherwise a request that
  // started just before unmount could still write stale state.
  useEffect((): (() => void) => {
    const q = query.trim()
    if (q.length < 2) {
      setSuggestions([])
      setSearching(false)
      return () => {}
    }
    setSearching(true)
    let cancelled = false
    const handle = window.setTimeout(() => {
      searchWorkspaceUsers(q, 8)
        .then((res) => {
          if (cancelled) return
          setSuggestions(res)
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [query])

  const addOne = (raw: string): "added" | "duplicate" | "invalid" | "blocked" => {
    const email = raw.trim().toLowerCase()
    if (!email) return "invalid"
    if (!isValidEmail(email)) return "invalid"
    if (excludeSet.has(email)) return "blocked"
    if (emails.some((e) => e.toLowerCase() === email)) return "duplicate"
    onChange([...emails, email])
    return "added"
  }

  const addMany = (list: string[]): {
    added: number
    duplicates: number
    invalid: number
    blocked: number
  } => {
    const seen = new Set(emails.map((e) => e.toLowerCase()))
    const next: string[] = [...emails]
    let added = 0
    let duplicates = 0
    let invalid = 0
    let blocked = 0
    for (const raw of list) {
      const email = raw.trim().toLowerCase()
      if (!email) continue
      if (!isValidEmail(email)) {
        invalid += 1
        continue
      }
      if (excludeSet.has(email)) {
        blocked += 1
        continue
      }
      if (seen.has(email)) {
        duplicates += 1
        continue
      }
      seen.add(email)
      next.push(email)
      added += 1
    }
    if (added > 0) onChange(next)
    return { added, duplicates, invalid, blocked }
  }

  const removeOne = (email: string): void => {
    onChange(emails.filter((e) => e.toLowerCase() !== email.toLowerCase()))
  }

  const clearAll = (): void => {
    onChange([])
  }

  const handleBulkApply = (): void => {
    const parsed = parsePaste(bulkDraft)
    const report = addMany(parsed)
    setBulkReport(report)
    setBulkDraft("")
  }

  const handleManualSubmit = (): void => {
    const candidate = query.trim()
    if (!candidate) return
    const r = addOne(candidate)
    if (r === "added") {
      setQuery("")
      setSuggestions([])
    }
    // For invalid/blocked/duplicate, leave the query so the user sees what
    // they typed and can fix it.
  }

  const filteredChips = useMemo(() => {
    const q = chipFilter.trim().toLowerCase()
    if (!q) return emails
    return emails.filter((e) => e.toLowerCase().includes(q))
  }, [emails, chipFilter])

  const visiblePreview = emails.slice(0, 6)
  const hiddenCount = Math.max(0, emails.length - visiblePreview.length)

  return (
    <section ref={rootRef} className="flex flex-col gap-2">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h4 className="text-[12.5px] font-medium text-muted-foreground">
            {label}
          </h4>
          {hint && (
            <p className="mt-0.5 max-w-md text-[11.5px] text-muted-foreground/80">
              {hint}
            </p>
          )}
        </div>
        <span className="rounded-full bg-secondary/70 px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
          {emails.length}
        </span>
      </header>

      {/* Autocomplete input */}
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
          strokeWidth={1.75}
        />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => {
            setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              handleManualSubmit()
            } else if (e.key === "Escape") {
              setOpen(false)
            }
          }}
          placeholder="Search by name or email, paste a CSV with “Bulk add”…"
          className="h-10 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-[13.5px] text-foreground placeholder:text-muted-foreground/70 transition focus:border-ring focus:outline-none"
        />

        {open && (suggestions.length > 0 || searching || query.trim()) && (
          <div
            role="listbox"
            className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-border bg-surface-elevated shadow-2xl"
          >
            <ul className="max-h-72 overflow-y-auto py-1">
              {searching && (
                <li className="px-3 py-1.5 text-[12.5px] text-muted-foreground">
                  Searching workspace…
                </li>
              )}

              {!searching &&
                suggestions.length === 0 &&
                query.trim().length >= 2 && (
                  <li className="px-3 py-1.5 text-[12.5px] text-muted-foreground">
                    No matching workspace user. Press <Kbd>Enter</Kbd> to add{" "}
                    <span className="font-medium text-foreground">
                      {query.trim()}
                    </span>{" "}
                    anyway.
                  </li>
                )}

              {suggestions.map((u) => {
                const already = emails.some(
                  (e) => e.toLowerCase() === u.email.toLowerCase(),
                )
                const blocked = excludeSet.has(u.email.toLowerCase())
                return (
                  <li key={u.email}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={already}
                      disabled={blocked}
                      onClick={() => {
                        addOne(u.email)
                        setQuery("")
                        setSuggestions([])
                      }}
                      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition ${
                        blocked
                          ? "cursor-not-allowed opacity-50"
                          : "hover:bg-secondary/70"
                      }`}
                    >
                      <span
                        aria-hidden
                        className="grid h-7 w-7 flex-shrink-0 place-items-center overflow-hidden rounded-full bg-secondary text-[11px] font-medium text-foreground"
                      >
                        {u.photoLink ? (
                          <img
                            src={u.photoLink}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          initials(u.name ?? u.email)
                        )}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px] font-medium text-foreground">
                          {u.name ?? u.email}
                        </span>
                        <span className="truncate text-[11.5px] text-muted-foreground">
                          {u.email}
                          {blocked && " · already a co-owner"}
                          {!blocked && already && " · added"}
                        </span>
                      </span>
                      {already && !blocked && (
                        <Check
                          className="h-3.5 w-3.5 flex-shrink-0 text-foreground"
                          strokeWidth={2.25}
                          aria-hidden
                        />
                      )}
                    </button>
                  </li>
                )
              })}

              {query.trim() &&
                !searching &&
                isValidEmail(query.trim()) &&
                !suggestions.some(
                  (u) =>
                    u.email.toLowerCase() === query.trim().toLowerCase(),
                ) && (
                  <li className="border-t border-border">
                    <button
                      type="button"
                      onClick={() => {
                        handleManualSubmit()
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-muted-foreground transition hover:bg-secondary/70 hover:text-foreground"
                    >
                      <UserPlus
                        className="h-3.5 w-3.5"
                        aria-hidden
                        strokeWidth={1.75}
                      />
                      Add{" "}
                      <span className="font-medium text-foreground">
                        {query.trim()}
                      </span>
                    </button>
                  </li>
                )}
            </ul>
          </div>
        )}
      </div>

      {/* Bulk paste */}
      <div className="rounded-lg border border-dashed border-border bg-surface px-3 py-2.5">
        <button
          type="button"
          onClick={() => {
            setBulkMode((v) => !v)
            setBulkReport(null)
          }}
          className="flex w-full items-center justify-between gap-2 text-left text-[12.5px] font-medium text-muted-foreground transition hover:text-foreground"
          aria-expanded={bulkMode}
        >
          <span className="inline-flex items-center gap-1.5">
            <UserPlus className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
            Bulk add from a list
          </span>
          {bulkMode ? (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>

        {bulkMode && (
          <div className="mt-2 flex flex-col gap-2 animate-fade-up">
            <textarea
              value={bulkDraft}
              onChange={(e) => {
                setBulkDraft(e.target.value)
                setBulkReport(null)
              }}
              rows={4}
              placeholder={
                "alice@company.com, bob@company.com\nclara@company.com\ndan@company.com"
              }
              className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-foreground placeholder:text-muted-foreground/70 transition focus:border-ring focus:outline-none"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11.5px] text-muted-foreground/80">
                Paste comma-, space-, semicolon-, or newline-separated emails.
              </span>
              <button
                type="button"
                disabled={!bulkDraft.trim()}
                onClick={handleBulkApply}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-foreground px-3 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add
              </button>
            </div>

            {bulkReport && (
              <p className="rounded-md border border-border bg-surface-muted px-2.5 py-1.5 text-[11.5px] text-muted-foreground">
                <span className="font-medium text-foreground">
                  {bulkReport.added}
                </span>{" "}
                added
                {bulkReport.duplicates > 0 &&
                  ` · ${bulkReport.duplicates} duplicate${bulkReport.duplicates === 1 ? "" : "s"}`}
                {bulkReport.blocked > 0 &&
                  ` · ${bulkReport.blocked} blocked (in the other list)`}
                {bulkReport.invalid > 0 &&
                  ` · ${bulkReport.invalid} invalid skipped`}
                .
              </p>
            )}
          </div>
        )}
      </div>

      {/* Selected emails */}
      {emails.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2.5">
          {!expanded ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {visiblePreview.map((email) => (
                <Chip
                  key={email}
                  email={email}
                  onRemove={() => {
                    removeOne(email)
                  }}
                />
              ))}
              {hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setExpanded(true)
                  }}
                  className="inline-flex h-6 items-center rounded-full border border-dashed border-border px-2 text-[11.5px] font-medium text-muted-foreground transition hover:border-ring hover:text-foreground"
                >
                  +{hiddenCount} more
                </button>
              )}
              <span className="flex-1" />
              {emails.length > 1 && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-[11.5px] text-muted-foreground transition hover:text-destructive"
                >
                  Clear all
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="relative flex-1">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                    strokeWidth={1.75}
                  />
                  <input
                    type="search"
                    value={chipFilter}
                    onChange={(e) => {
                      setChipFilter(e.target.value)
                    }}
                    placeholder={`Filter ${emails.length} added…`}
                    className="h-7 w-full rounded-full border border-border bg-background pl-7 pr-2 text-[12px] text-foreground placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setExpanded(false)
                    setChipFilter("")
                  }}
                  className="inline-flex h-7 items-center gap-1 rounded-full border border-border px-2 text-[11.5px] text-muted-foreground transition hover:border-ring hover:text-foreground"
                >
                  <ChevronUp
                    className="h-3 w-3"
                    aria-hidden
                    strokeWidth={1.75}
                  />
                  Collapse
                </button>
              </div>

              <ul className="flex max-h-64 flex-wrap gap-1.5 overflow-y-auto pr-1">
                {filteredChips.map((email) => (
                  <li key={email}>
                    <Chip
                      email={email}
                      onRemove={() => {
                        removeOne(email)
                      }}
                    />
                  </li>
                ))}
                {filteredChips.length === 0 && (
                  <li className="px-1 py-0.5 text-[12px] italic text-muted-foreground/80">
                    Nothing matches “{chipFilter}”.
                  </li>
                )}
              </ul>

              <div className="flex items-center justify-end">
                {emails.length > 1 && (
                  <button
                    type="button"
                    onClick={clearAll}
                    className="text-[11.5px] text-muted-foreground transition hover:text-destructive"
                  >
                    Clear all
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}

// ── Bits ────────────────────────────────────────────────────────────────────

function Chip({
  email,
  onRemove,
}: {
  email: string
  onRemove: () => void
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-secondary/80 py-0.5 pl-2 pr-1 text-[12px] text-foreground">
      <span className="max-w-[18ch] truncate">{email}</span>
      <button
        type="button"
        aria-label={`Remove ${email}`}
        onClick={onRemove}
        className="grid h-4 w-4 place-items-center rounded-full text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"
      >
        <X className="h-2.5 w-2.5" strokeWidth={2} aria-hidden />
      </button>
    </span>
  )
}

function Kbd({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <kbd className="rounded border border-border bg-surface-muted px-1 py-0 font-mono text-[10.5px] text-foreground">
      {children}
    </kbd>
  )
}

function initials(text: string): string {
  const parts = text.split(/[\s._-]+/).filter(Boolean)
  const a = parts[0]?.[0] ?? "?"
  const b = parts[1]?.[0] ?? ""
  return (a + b).toUpperCase()
}
