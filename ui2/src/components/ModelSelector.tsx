import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { Check, ChevronDown, Search } from "lucide-react"
import { useModels } from "@/lib/models"

type Row =
  | { kind: "header"; family: string }
  | { kind: "item"; labelName: string; description?: string; flatIdx: number }

export function ModelSelector(): JSX.Element {
  const { models, selected, setSelected, groups, loading } = useModels()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [focusIdx, setFocusIdx] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  // Filter by query (case-insensitive, substring match on labelName).
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      return groups
    }
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter((m) => m.labelName.toLowerCase().includes(q)),
      }))
      .filter((g) => g.items.length > 0)
  }, [groups, query])

  // Build the rendered row list. Group headers are only shown when there are
  // multiple visible families — otherwise they're noise.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const showHeaders = filteredGroups.length > 1
    let flatIdx = 0
    for (const g of filteredGroups) {
      if (showHeaders) {
        out.push({ kind: "header", family: g.family })
      }
      for (const m of g.items) {
        out.push({
          kind: "item",
          labelName: m.labelName,
          ...(m.description ? { description: m.description } : {}),
          flatIdx,
        })
        flatIdx++
      }
    }
    return out
  }, [filteredGroups])

  const flatItems = useMemo(
    () => rows.filter((r): r is Extract<Row, { kind: "item" }> => r.kind === "item"),
    [rows],
  )

  // Open: focus search input + pre-position the focused index on the currently
  // selected model so Enter (no typing) is a no-op confirm.
  useEffect((): void => {
    if (!open) {
      setQuery("")
      return
    }
    requestAnimationFrame((): void => {
      searchRef.current?.focus()
    })
    const idx = flatItems.findIndex((m) => m.labelName === selected)
    setFocusIdx(idx >= 0 ? idx : 0)
  }, [open, flatItems, selected])

  // Reset focus when filter changes; keep within bounds.
  useEffect((): void => {
    setFocusIdx((i) => Math.min(i, Math.max(flatItems.length - 1, 0)))
  }, [flatItems.length])

  // Scroll the focused row into view.
  useEffect((): void => {
    if (!open) {
      return
    }
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-flat-idx="${String(focusIdx)}"]`,
    )
    el?.scrollIntoView({ block: "nearest" })
  }, [focusIdx, open])

  // Outside click closes.
  useEffect((): (() => void) => {
    const onDoc = (e: MouseEvent): void => {
      if (!rootRef.current) {
        return
      }
      if (!rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onDoc)
    return (): void => {
      document.removeEventListener("mousedown", onDoc)
    }
  }, [])

  const commit = (labelName: string): void => {
    setSelected(labelName)
    setOpen(false)
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault()
      setOpen(false)
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setFocusIdx((i) =>
        flatItems.length === 0 ? 0 : (i + 1) % flatItems.length,
      )
      return
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setFocusIdx((i) =>
        flatItems.length === 0 ? 0 : (i - 1 + flatItems.length) % flatItems.length,
      )
      return
    }
    if (e.key === "Enter") {
      e.preventDefault()
      const item = flatItems[focusIdx]
      if (item) {
        commit(item.labelName)
      }
    }
  }

  const label = loading
    ? "Loading…"
    : selected ?? models[0]?.labelName ?? "No models"

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={(): void => {
          setOpen((v) => !v)
        }}
        disabled={loading || models.length === 0}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 text-[12.5px] font-medium text-foreground transition hover:border-ring disabled:cursor-not-allowed disabled:opacity-60"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="max-w-[14rem] truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Select model"
          className="absolute bottom-full right-0 z-30 mb-2 w-64 overflow-hidden rounded-2xl border border-border bg-surface-elevated shadow-2xl shadow-foreground/10"
        >
          {/* Search */}
          <div className="relative border-b border-border/60 p-2">
            <Search
              aria-hidden
              strokeWidth={1.75}
              className="pointer-events-none absolute left-[18px] top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e): void => {
                setQuery(e.target.value)
              }}
              onKeyDown={onKey}
              placeholder="Search models…"
              aria-label="Search models"
              className="h-8 w-full rounded-lg bg-surface pl-8 pr-2 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>

          {/* List */}
          <ul
            ref={listRef}
            role="listbox"
            aria-label="Models"
            className="max-h-72 overflow-y-auto py-1"
          >
            {rows.length === 0 ? (
              <li className="px-3 py-4 text-center text-[12px] text-muted-foreground">
                No models match “{query}”
              </li>
            ) : (
              rows.map((row) =>
                row.kind === "header" ? (
                  <li
                    key={`h-${row.family}`}
                    className="select-none px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground"
                  >
                    {row.family}
                  </li>
                ) : (
                  <RowItem
                    key={row.labelName}
                    labelName={row.labelName}
                    {...(row.description ? { description: row.description } : {})}
                    flatIdx={row.flatIdx}
                    active={selected === row.labelName}
                    focused={focusIdx === row.flatIdx}
                    onSelect={commit}
                    onHover={setFocusIdx}
                  />
                ),
              )
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

type ItemProps = {
  labelName: string
  description?: string
  flatIdx: number
  active: boolean
  focused: boolean
  onSelect: (labelName: string) => void
  onHover: (flatIdx: number) => void
}

function RowItem({
  labelName,
  description,
  flatIdx,
  active,
  focused,
  onSelect,
  onHover,
}: ItemProps): JSX.Element {
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={active}
        data-flat-idx={flatIdx}
        title={description ?? labelName}
        onMouseEnter={(): void => {
          onHover(flatIdx)
        }}
        onClick={(): void => {
          onSelect(labelName)
        }}
        className={
          "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] transition-colors " +
          (focused
            ? "bg-secondary text-foreground"
            : "text-foreground/90 hover:bg-secondary/60")
        }
      >
        <span className={"truncate " + (active ? "font-medium" : "")}>
          {labelName}
        </span>
        {active && (
          <Check
            className="h-3.5 w-3.5 flex-shrink-0 text-foreground"
            aria-hidden
            strokeWidth={2.25}
          />
        )}
      </button>
    </li>
  )
}
