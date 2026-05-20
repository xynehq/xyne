import { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import {
  CheckSquare,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  Search,
  X,
} from "lucide-react"
import {
  type KbCollection,
  type KbItem,
  type KbSearchResult,
  listKbCollections,
  listKbItems,
  searchKb,
} from "@/lib/api"

// Each selected source serializes into the v1 `docIds` payload as a
// `fetchedDataSourceSchema` entry: { docId, name, app, entity }.
export type KbSelection = {
  docId: string
  name: string
  app: string
  entity: string
  /** Display-only path so the form can show "Collection / folder / file"
   *  next to the chip without re-fetching. Not part of the wire payload. */
  pathLabel: string
}

type Props = {
  open: boolean
  initial: KbSelection[]
  onClose: () => void
  onApply: (next: KbSelection[]) => void
}

type Crumb = { id: string | null; name: string }

// docId resolution for agent `appIntegrations.knowledge_base.itemIds`. The
// canonical format both v1 and v2 honor is `<prefix>-<PG row UUID>`:
//   - `clf-<uuid>` for a file
//   - `clfd-<uuid>` for a folder
//   - `cl-<uuid>` for a whole collection
// The server strips the prefix and looks up the bare UUID against the
// `collection_items` / `collections` UUID PKs (e.g. `getCollectionItemById`
// in server/db/knowledgeBase.ts). The KB item's `vespaDocId` is a CUID-shaped
// string (e.g. `clf-faqyenmgenqht7jmw1b5t3ly`) used for Vespa document IDs
// and is NOT interchangeable here — feeding it to the v1 create endpoint
// blows up with `invalid input syntax for type uuid`.
//
// `entity` is one of "file" / "folder" / "collection"; the latter only
// appears from search results, never from a folder drill-down.
const itemDocId = (i: {
  id: string
  type?: "folder" | "file" | "collection"
}): string => {
  if (i.type === "folder") return `clfd-${i.id}`
  if (i.type === "collection") return `cl-${i.id}`
  return `clf-${i.id}`
}

// Retrieval only honors KB IDs whose suffix is a real UUID — that's the
// PG primary key the server dereferences. Both prefix and suffix must check
// out; anything else is dropped at selection time rather than shipped into
// the saved agent (where v1's create endpoint would 500 on the lookup).
const KB_PREFIX_RE = /^(cl-|clfd-|clf-)/
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isSelectableDocId = (id: string): boolean => {
  if (!KB_PREFIX_RE.test(id)) return false
  return UUID_RE.test(id.replace(KB_PREFIX_RE, ""))
}

const KB_APP = "knowledge_base"

export function KbPickerModal({
  open,
  initial,
  onClose,
  onApply,
}: Props): JSX.Element | null {
  const [selected, setSelected] = useState<Map<string, KbSelection>>(
    () => new Map(initial.map((s) => [s.docId, s])),
  )

  // Tab between "Browse" (collection → folder drill-down) and "Search"
  // (a server-wide /cl/search). Search activates as soon as the user types.
  const [query, setQuery] = useState("")
  const [searchResults, setSearchResults] = useState<KbSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  // Browse state — collections list + current drill path within one.
  const [collections, setCollections] = useState<KbCollection[] | null>(null)
  const [collectionsError, setCollectionsError] = useState<string | null>(null)
  const [activeCollection, setActiveCollection] = useState<KbCollection | null>(
    null,
  )
  const [crumbs, setCrumbs] = useState<Crumb[]>([])
  const [items, setItems] = useState<KbItem[] | null>(null)
  const [itemsError, setItemsError] = useState<string | null>(null)


  // Reset when (re)opening so a fresh edit session starts from the agent's
  // currently saved selection, not whatever the user left mid-air last time.
  // We do NOT force-focus the close button — the search input below has
  // `autoFocus`, and stealing focus from it on every open is hostile to
  // anyone trying to start typing right away. Esc is handled by a global
  // keydown listener (below), so keyboard close works regardless of focus.
  useEffect(() => {
    if (!open) return
    setSelected(new Map(initial.map((s) => [s.docId, s])))
    setQuery("")
    setSearchResults([])
    setSearchError(null)
    setActiveCollection(null)
    setCrumbs([])
    setItems(null)
    setItemsError(null)
  }, [open, initial])

  // Load collections lazily on first open.
  useEffect(() => {
    if (!open) return
    if (collections !== null) return
    let cancelled = false
    setCollectionsError(null)
    listKbCollections()
      .then((res) => {
        if (!cancelled) setCollections(res)
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setCollections([])
          setCollectionsError(err.message || "Couldn't load collections.")
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, collections])

  // Drill into a collection / folder.
  useEffect(() => {
    if (!open) return
    if (!activeCollection) {
      setItems(null)
      return
    }
    let cancelled = false
    setItems(null)
    setItemsError(null)
    const parent = crumbs.length > 0 ? crumbs[crumbs.length - 1]!.id : null
    listKbItems(activeCollection.id, parent)
      .then((res) => {
        if (!cancelled) setItems(res)
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setItems([])
          setItemsError(err.message || "Couldn't load items.")
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, activeCollection, crumbs])

  // Debounced search. `cancelled` is scoped to the effect (not the timeout
  // callback) so the cleanup can actually flip it — otherwise a request
  // already in-flight could still overwrite state with stale results.
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 2) {
      setSearchResults([])
      setSearchLoading(false)
      setSearchError(null)
      return
    }
    setSearchLoading(true)
    setSearchError(null)
    let cancelled = false
    const handle = window.setTimeout(() => {
      searchKb(q, 30)
        .then((res) => {
          if (!cancelled) setSearchResults(res)
        })
        .catch((err: Error) => {
          if (!cancelled) {
            setSearchResults([])
            setSearchError(err.message || "Search failed.")
          }
        })
        .finally(() => {
          if (!cancelled) setSearchLoading(false)
        })
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [open, query])

  // Escape closes; click-outside on the backdrop closes too (handled inline).
  // Also lock the body scroll while open so the page underneath doesn't
  // continue to scroll under the dialog.
  useEffect((): (() => void) => {
    if (!open) return () => {}
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  const collectionPath = (collection: KbCollection): string => {
    return collection.name
  }

  const itemPathLabel = (
    collection: KbCollection,
    item: KbItem,
    extraCrumbs: Crumb[],
  ): string => {
    const inner = extraCrumbs
      .filter((c) => c.id !== null)
      .map((c) => c.name)
      .join(" / ")
    return inner
      ? `${collection.name} / ${inner} / ${item.name}`
      : `${collection.name} / ${item.name}`
  }

  const toggleItemSelection = (sel: KbSelection): void => {
    if (!isSelectableDocId(sel.docId)) {
      // The item exists in PG but doesn't have an indexable Vespa ID yet
      // (typical for a freshly uploaded file mid-ingest). Skip silently in
      // the UI — the row's hover affordance already prevents this in
      // BrowseView/SearchView, but the guard here makes the contract
      // explicit so a future caller can't bypass it.
      return
    }
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(sel.docId)) {
        next.delete(sel.docId)
      } else {
        next.set(sel.docId, sel)
      }
      return next
    })
  }

  const selectionList = useMemo(
    () => Array.from(selected.values()),
    [selected],
  )

  if (!open) return null

  const showingSearch = query.trim().length >= 2

  // Portal to <body> so the modal isn't trapped under the form's
  // `animate-fade-up` (which sets a transform on <main>, becoming the
  // containing block for any descendant `position: fixed`). Without the
  // portal the backdrop only covers the form area, not the full viewport.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="kb-picker-title"
      // Backdrop tone: a fixed dark wash is more reliable than the
      // `--foreground` token, which inverts in dark mode and leaves the
      // overlay nearly invisible. Black + blur reads correctly in both themes.
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-8 backdrop-blur-sm dark:bg-black/70"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {/* Height-capped so the modal never stretches taller than the viewport
          and so the inner body scroll region has a definite bound. */}
      <div className="flex max-h-[min(85vh,640px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl animate-fade-up dark:border-white/10 dark:bg-surface-elevated dark:shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)]">
        {/* Header */}
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <h3
            id="kb-picker-title"
            className="text-[15px] font-medium text-foreground"
          >
            Knowledge sources
          </h3>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </button>
        </header>

        {/* Search */}
        <div className="border-b border-border px-5 py-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
              strokeWidth={1.75}
            />
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
              }}
              placeholder="Search across all collections, folders, and docs…"
              autoFocus
              className="h-10 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-[13.5px] text-foreground placeholder:text-muted-foreground/70 transition focus:border-ring focus:outline-none"
            />
          </div>
        </div>

        {/* Sticky-by-position breadcrumb band. Renders only in browse mode
            (not search, not collections-root). Lives OUTSIDE the scroll
            container so it sits flush against the search band's bottom
            border — no negative margins, no hidden gutters. */}
        {activeCollection && !showingSearch ? (
          <nav
            aria-label="Knowledge path"
            className="flex flex-wrap items-center gap-1 border-b border-border bg-surface-elevated px-5 py-2 text-[12px] text-muted-foreground"
          >
            <button
              type="button"
              onClick={() => {
                setActiveCollection(null)
                setCrumbs([])
              }}
              className="rounded-md px-1.5 py-0.5 transition hover:bg-secondary hover:text-foreground"
            >
              Collections
            </button>
            <ChevronRight
              className="h-3 w-3 opacity-60"
              aria-hidden
              strokeWidth={2}
            />
            <button
              type="button"
              onClick={() => {
                setCrumbs([])
              }}
              className="rounded-md px-1.5 py-0.5 font-medium text-foreground transition hover:bg-secondary"
            >
              {collectionPath(activeCollection)}
            </button>
            {crumbs.map((c, idx) => (
              <span
                key={`${c.id ?? "root"}-${idx}`}
                className="flex items-center gap-1"
              >
                <ChevronRight
                  className="h-3 w-3 opacity-60"
                  aria-hidden
                  strokeWidth={2}
                />
                <button
                  type="button"
                  onClick={() => {
                    setCrumbs((prev) => prev.slice(0, idx + 1))
                  }}
                  className="rounded-md px-1.5 py-0.5 transition hover:bg-secondary hover:text-foreground"
                >
                  {c.name}
                </button>
              </span>
            ))}
          </nav>
        ) : null}

        {/* Body — switches between browse and search */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {showingSearch ? (
            <SearchView
              loading={searchLoading}
              error={searchError}
              results={searchResults}
              query={query}
              selected={selected}
              onToggle={(r) => {
                toggleItemSelection({
                  docId: itemDocId(r),
                  name: r.name,
                  app: KB_APP,
                  entity: r.type,
                  pathLabel: r.path
                    ? `${r.collectionName ?? "Collection"} / ${r.path}`
                    : (r.collectionName ?? "Collection") + " / " + r.name,
                })
              }}
            />
          ) : !activeCollection ? (
            <CollectionsView
              collections={collections}
              error={collectionsError}
              selected={selected}
              onPick={(c) => {
                setActiveCollection(c)
                setCrumbs([])
              }}
              onToggle={(c) => {
                // Scope the agent to the WHOLE collection. The backend
                // honors `cl-<uuid>` in collectionIds and pulls every
                // file inside; saves the user from drilling and picking
                // every folder.
                toggleItemSelection({
                  docId: itemDocId({ id: c.id, type: "collection" }),
                  name: c.name,
                  app: KB_APP,
                  entity: "collection",
                  pathLabel: c.name,
                })
              }}
            />
          ) : (
            <BrowseView
              items={items}
              itemsError={itemsError}
              selected={selected}
              onItemOpen={(item) => {
                if (item.type === "folder") {
                  setCrumbs((prev) => [
                    ...prev,
                    { id: item.id, name: item.name },
                  ])
                }
              }}
              onItemToggle={(item) => {
                toggleItemSelection({
                  docId: itemDocId(item),
                  name: item.name,
                  app: KB_APP,
                  entity: item.type,
                  pathLabel: itemPathLabel(activeCollection, item, crumbs),
                })
              }}
              pathFor={(item) =>
                itemPathLabel(activeCollection, item, crumbs)
              }
            />
          )}
        </div>

        {/* Footer with selection summary + Apply */}
        <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <div className="min-w-0 flex-1">
            {selectionList.length === 0 ? (
              <p className="text-[12.5px] text-muted-foreground">
                Pick documents or folders to scope this agent.
              </p>
            ) : (
              <p className="truncate text-[12.5px] text-muted-foreground">
                <span className="font-medium text-foreground">
                  {selectionList.length}
                </span>{" "}
                selected ·{" "}
                <span className="italic">
                  {selectionList
                    .slice(0, 2)
                    .map((s) => s.name)
                    .join(", ")}
                  {selectionList.length > 2 &&
                    ` and ${selectionList.length - 2} more`}
                </span>
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 items-center rounded-full border border-border bg-surface px-3.5 text-[13px] text-foreground transition hover:border-ring"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onApply(selectionList)
              }}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-[13px] font-medium text-primary-foreground transition hover:opacity-90"
            >
              {selectionList.length === 0
                ? "Done"
                : `Add ${selectionList.length} ${selectionList.length === 1 ? "source" : "sources"}`}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

// ── Sub-views ───────────────────────────────────────────────────────────────

function CollectionsView({
  collections,
  error,
  selected,
  onPick,
  onToggle,
}: {
  collections: KbCollection[] | null
  error: string | null
  // Live selection map keyed by docId (`cl-<uuid>` for collections).
  // Used to render the check state on each card so the user knows
  // whether the whole collection is already scoped.
  selected: Map<string, KbSelection>
  // Drill into the collection's contents (file/folder picker).
  onPick: (c: KbCollection) => void
  // Toggle "scope the agent to this whole collection" — independent of
  // the drill action so the user can do either from the card.
  onToggle: (c: KbCollection) => void
}): JSX.Element {
  if (error) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-[13px] text-destructive">
        {error}
      </div>
    )
  }
  if (collections === null) {
    return <RowsSkeleton />
  }
  if (collections.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface px-4 py-10 text-center">
        <Folder
          className="mx-auto h-7 w-7 text-muted-foreground/70"
          strokeWidth={1.4}
          aria-hidden
        />
        <h4 className="mt-3 text-[14px] font-medium text-foreground">
          No knowledge collections yet
        </h4>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          Create or join a collection in your workspace's knowledge base, then
          come back to scope this agent to it.
        </p>
      </div>
    )
  }
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {collections.map((c) => {
        const docId = `cl-${c.id}`
        const isWholeSelected = selected.has(docId)
        return (
          <li
            key={c.id}
            className={
              "group flex items-center gap-3 rounded-xl border bg-surface px-3.5 py-3 text-left transition hover:-translate-y-0.5 hover:border-ring hover:bg-surface-elevated " +
              (isWholeSelected ? "border-ring" : "border-border")
            }
          >
            {/* Toggle the whole-collection scope. Separate from the
                drill-into button so the user can pick either path. */}
            <label
              className="grid h-9 w-9 flex-shrink-0 cursor-pointer place-items-center rounded-xl bg-secondary text-foreground"
              title="Scope agent to this entire collection"
            >
              <input
                type="checkbox"
                className="peer sr-only"
                checked={isWholeSelected}
                onChange={() => onToggle(c)}
              />
              <FolderOpen
                className="h-4 w-4 peer-checked:hidden"
                strokeWidth={1.6}
                aria-hidden
              />
              <CheckSquare
                className="hidden h-4 w-4 text-primary peer-checked:block"
                strokeWidth={1.8}
                aria-hidden
              />
            </label>
            <button
              type="button"
              onClick={() => {
                onPick(c)
              }}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-foreground">
                  {c.name}
                </span>
                {c.description && (
                  <span className="line-clamp-1 text-[11.5px] text-muted-foreground">
                    {c.description}
                  </span>
                )}
                {isWholeSelected && (
                  <span className="mt-0.5 block text-[11px] font-medium text-primary">
                    Whole collection scoped
                  </span>
                )}
              </span>
              <ChevronRight
                className="h-3.5 w-3.5 text-muted-foreground transition group-hover:translate-x-0.5"
                aria-hidden
                strokeWidth={1.75}
              />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function BrowseView({
  items,
  itemsError,
  selected,
  onItemOpen,
  onItemToggle,
  pathFor,
}: {
  items: KbItem[] | null
  itemsError: string | null
  selected: Map<string, KbSelection>
  onItemOpen: (item: KbItem) => void
  onItemToggle: (item: KbItem) => void
  pathFor: (item: KbItem) => string
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {itemsError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
          {itemsError}
        </div>
      )}

      {items === null ? (
        <RowsSkeleton />
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-surface px-4 py-6 text-center text-[12.5px] text-muted-foreground">
          This folder is empty.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((item) => {
            const docId = itemDocId(item)
            const isSelected = selected.has(docId)
            // Rows whose id isn't a UUID (legacy / corrupted) can't be
            // dereferenced server-side and would 500 the create endpoint.
            // Surface them as disabled rather than letting the user pick
            // something that wouldn't take effect.
            const isPickable = isSelectableDocId(docId)
            return (
              <li key={item.id}>
                <ItemRow
                  item={item}
                  isSelected={isSelected}
                  isPickable={isPickable}
                  pathLabel={pathFor(item)}
                  onToggle={() => {
                    if (isPickable) onItemToggle(item)
                  }}
                  onOpen={() => {
                    onItemOpen(item)
                  }}
                />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function SearchView({
  loading,
  error,
  results,
  query,
  selected,
  onToggle,
}: {
  loading: boolean
  error: string | null
  results: KbSearchResult[]
  query: string
  selected: Map<string, KbSelection>
  onToggle: (r: KbSearchResult) => void
}): JSX.Element {
  if (error) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-[13px] text-destructive">
        {error}
      </div>
    )
  }
  if (loading) {
    return <RowsSkeleton />
  }
  if (results.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-surface px-4 py-10 text-center text-[12.5px] text-muted-foreground">
        No results for{" "}
        <span className="font-medium text-foreground">“{query}”</span>.
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-1">
      {results.map((r) => {
        const docId = itemDocId(r)
        const isSelected = selected.has(docId)
        const isPickable = isSelectableDocId(docId)
        return (
          <li key={`${r.collectionId}-${r.id}`}>
            <button
              type="button"
              onClick={() => {
                if (isPickable) onToggle(r)
              }}
              disabled={!isPickable}
              title={isPickable ? undefined : "Indexing in progress — not yet selectable."}
              className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${
                isSelected
                  ? "border-foreground/15 bg-surface-elevated"
                  : !isPickable
                    ? "cursor-not-allowed border-border bg-surface opacity-50"
                    : "border-border bg-surface hover:border-ring"
              }`}
            >
              <span
                aria-hidden
                className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg bg-secondary text-foreground"
              >
                {r.type === "collection" ? (
                  <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.6} />
                ) : r.type === "folder" ? (
                  <Folder className="h-3.5 w-3.5" strokeWidth={1.6} />
                ) : (
                  <File className="h-3.5 w-3.5" strokeWidth={1.6} />
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-medium text-foreground">
                  {r.name}
                </span>
                <span className="truncate text-[11.5px] text-muted-foreground">
                  {[r.collectionName, r.path].filter(Boolean).join(" / ") ||
                    "—"}
                </span>
              </span>
              <SelectMark selected={isSelected} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function ItemRow({
  item,
  isSelected,
  isPickable,
  pathLabel,
  onToggle,
  onOpen,
}: {
  item: KbItem
  isSelected: boolean
  isPickable: boolean
  pathLabel: string
  onToggle: () => void
  onOpen: () => void
}): JSX.Element {
  const disabledTitle = "Indexing in progress — not yet selectable."
  return (
    <div
      className={`group flex items-center gap-3 rounded-lg border px-3 py-2 transition ${
        isSelected
          ? "border-foreground/15 bg-surface-elevated"
          : !isPickable
            ? "border-border bg-surface opacity-50"
            : "border-border bg-surface hover:border-ring"
      }`}
      title={isPickable ? undefined : disabledTitle}
    >
      <button
        type="button"
        aria-label={isSelected ? "Deselect" : "Select"}
        disabled={!isPickable}
        onClick={onToggle}
        className={`flex h-6 w-6 flex-shrink-0 items-center justify-center ${
          isPickable ? "" : "cursor-not-allowed"
        }`}
      >
        <SelectMark selected={isSelected} />
      </button>
      <button
        type="button"
        onClick={item.type === "folder" ? onOpen : onToggle}
        disabled={item.type !== "folder" && !isPickable}
        className={`flex min-w-0 flex-1 items-center gap-2 text-left ${
          item.type !== "folder" && !isPickable ? "cursor-not-allowed" : ""
        }`}
      >
        <span
          aria-hidden
          className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md bg-secondary text-foreground"
        >
          {item.type === "folder" ? (
            <Folder className="h-3.5 w-3.5" strokeWidth={1.6} />
          ) : (
            <File className="h-3.5 w-3.5" strokeWidth={1.6} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] text-foreground">
            {item.name}
          </span>
          <span className="truncate text-[11px] text-muted-foreground/80">
            {pathLabel}
          </span>
        </span>
      </button>
      {item.type === "folder" && (
        <button
          type="button"
          aria-label={`Open ${item.name}`}
          onClick={onOpen}
          className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <ChevronRight
            className="h-3.5 w-3.5"
            aria-hidden
            strokeWidth={1.75}
          />
        </button>
      )}
    </div>
  )
}

function SelectMark({ selected }: { selected: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      className={`grid h-4 w-4 place-items-center rounded border transition ${
        selected
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-background"
      }`}
    >
      {selected && (
        <svg
          viewBox="0 0 12 12"
          className="h-2.5 w-2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <path d="M2 6.5l2.5 2.5L10 3.5" strokeLinecap="round" />
        </svg>
      )}
    </span>
  )
}

function RowsSkeleton(): JSX.Element {
  return (
    <ul className="flex flex-col gap-1">
      {Array.from({ length: 5 }).map((_, i) => (
        <li
          key={i}
          aria-hidden
          className="h-11 animate-breathe rounded-lg border border-border bg-surface"
        />
      ))}
    </ul>
  )
}
