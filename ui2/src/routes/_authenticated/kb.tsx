import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import {
  ArrowLeft,
  ChevronRight,
  File,
  FolderOpen,
  FolderPlus,
  Loader2,
  Plus,
  RefreshCw,
  Upload,
} from "lucide-react"
import { Topbar } from "@/components/Topbar"
import {
  EntryGrid,
  EntryList,
  IngestStatusIndicator,
  SearchField,
  ViewToggle,
  type BrowserEntry,
  type ColumnDef,
  type ViewMode,
} from "@/components/file-browser"
import { toast } from "@/components/Toast"
import { NameDialog } from "@/components/NameDialog"
import { ApiError } from "@/lib/api"
import {
  collectionToFolderEntry,
  createCollection,
  createFolder,
  deleteCollection,
  deleteItem,
  getBreadcrumb,
  itemToEntry,
  listCollections,
  listItems,
  searchFiles,
  type CollectionRow,
  type FileSearchHit,
  type ItemRow,
} from "@/lib/kb"
import {
  UploadingGrid,
  UploadingList,
} from "@/components/file-browser/UploadingCard"
import { uploadStore, useUploadsFor } from "@/lib/upload-store"
import { extOf, formatDate } from "@/lib/files"
import { cn } from "@/lib/utils"

type KbSearch = {
  cl?: string
  parent?: string
  q?: string
}

export const Route = createFileRoute("/_authenticated/kb")({
  validateSearch: (raw: Record<string, unknown>): KbSearch => {
    const out: KbSearch = {}
    if (typeof raw["cl"] === "string" && raw["cl"] !== "") {
      out.cl = raw["cl"]
    }
    if (typeof raw["parent"] === "string" && raw["parent"] !== "") {
      out.parent = raw["parent"]
    }
    if (typeof raw["q"] === "string" && raw["q"] !== "") {
      out.q = raw["q"]
    }
    return out
  },
  component: KnowledgeRoute,
})

const KB_COLUMNS: ReadonlyArray<ColumnDef> = [
  { key: "kind", header: "Kind", width: "120px" },
  { key: "size", header: "Size", width: "120px" },
  { key: "updated", header: "Updated", width: "140px" },
]

function KnowledgeRoute(): JSX.Element {
  const { cl, parent, q } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [view, setView] = useState<ViewMode>("grid")

  const currentCl = cl ?? null
  const currentParent = parent ?? null
  const query = q ?? ""

  const [collections, setCollections] = useState<CollectionRow[]>([])
  const [items, setItems] = useState<ItemRow[]>([])
  const [breadcrumb, setBreadcrumb] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [dialog, setDialog] = useState<"collection" | "folder" | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const mainRef = useRef<HTMLElement | null>(null)

  // App-wide uploads scoped to this folder. Survives unmount: navigating
  // away and back leaves the placeholders + XHRs intact.
  const uploadsHere = useUploadsFor(currentCl, currentParent)
  const hasUploading = uploadsHere.some(
    (u) => u.status === "uploading" || u.status === "processing",
  )
  // Tracks itemIds we've already triggered a refresh for, so the
  // "post-upload one-shot" effect below doesn't re-fire on every render
  // while the placeholder lingers waiting for the listing.
  const seenProcessingRef = useRef<Set<string>>(new Set())

  const refresh = useCallback((): void => {
    setReloadKey((k) => k + 1)
  }, [])

  // Load collections at root, items inside a collection.
  useEffect((): (() => void) | void => {
    let cancelled = false
    setLoading(true)
    if (currentCl === null) {
      listCollections()
        .then((rows): void => {
          if (!cancelled) {
            setCollections(rows)
            setItems([])
            setBreadcrumb([])
          }
        })
        .catch((err: unknown): void => {
          if (cancelled) {
            return
          }
          const msg = err instanceof Error ? err.message : "Failed to load"
          toast.error(`Could not load collections — ${msg}`)
        })
        .finally((): void => {
          if (!cancelled) {
            setLoading(false)
          }
        })
    } else {
      // Fetch the collections list alongside items so the breadcrumb
      // can resolve the active collection's display name even when the
      // user deep-links straight into /kb?cl=<id>. Cheap call — keeps
      // the lookup robust without a dedicated single-collection fetch.
      Promise.all([
        listItems(currentCl, currentParent),
        currentParent ? getBreadcrumb(currentCl, currentParent) : Promise.resolve([]),
        listCollections(),
      ])
        .then(([rows, chain, cols]): void => {
          if (cancelled) {
            return
          }
          setItems(rows)
          setBreadcrumb(chain)
          setCollections(cols)
          // Any row present in the server listing means the upload bytes
          // landed — drop the matching placeholder. We don't wait on
          // uploadStatus because the processor worker isn't necessarily
          // running (e.g. backendv2 standalone on DGX) and we'd never
          // see "completed".
          for (const row of rows) {
            uploadStore.markSeen(row.id)
          }
        })
        .catch((err: unknown): void => {
          if (cancelled) {
            return
          }
          if (err instanceof ApiError && err.status === 404) {
            toast.error("Collection not found")
            void navigate({ search: (): KbSearch => ({}) })
            return
          }
          const msg = err instanceof Error ? err.message : "Failed to load"
          toast.error(`Could not load items — ${msg}`)
        })
        .finally((): void => {
          if (!cancelled) {
            setLoading(false)
          }
        })
    }
    return (): void => {
      cancelled = true
    }
  }, [currentCl, currentParent, reloadKey, navigate])

  // Map rows → BrowserEntry for the browse view. When the search input has
  // a non-empty query we switch the main pane to inline search results
  // (see `searchHits` below), so this only needs to handle the unfiltered
  // case.
  const entries: BrowserEntry[] = useMemo(
    () =>
      currentCl === null
        ? collections.map(collectionToFolderEntry)
        : items.map(itemToEntry),
    [currentCl, collections, items],
  )

  // ── Inline file search ────────────────────────────────────────────────
  //
  // The top-right field calls `searchFiles` (same endpoint the ⌘K palette
  // hits) and renders the hits inside the page instead of swapping to a
  // modal. Search is global on purpose — it isn't scoped to the current
  // collection / folder. If the brief later needs an "only-here" toggle we
  // can add a server-side `clId` filter and a chip in the input.
  const [searchHits, setSearchHits] = useState<FileSearchHit[]>([])
  const [searchLoading, setSearchLoading] = useState<boolean>(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const searchTokenRef = useRef(0)
  const trimmedQuery = query.trim()
  const searching = trimmedQuery.length > 0

  useEffect((): (() => void) | undefined => {
    if (!searching) {
      setSearchHits([])
      setSearchLoading(false)
      setSearchError(null)
      return undefined
    }
    setSearchLoading(true)
    setSearchError(null)
    const myToken = ++searchTokenRef.current
    const handle = window.setTimeout((): void => {
      searchFiles(trimmedQuery, 40)
        .then((rows): void => {
          if (myToken !== searchTokenRef.current) {
            return
          }
          setSearchHits(rows)
        })
        .catch((err: unknown): void => {
          if (myToken !== searchTokenRef.current) {
            return
          }
          const msg = err instanceof Error ? err.message : "Search failed"
          setSearchError(msg)
          setSearchHits([])
        })
        .finally((): void => {
          if (myToken !== searchTokenRef.current) {
            return
          }
          setSearchLoading(false)
        })
    }, 160)
    return (): void => {
      window.clearTimeout(handle)
    }
  }, [searching, trimmedQuery])

  const openHit = (hit: FileSearchHit): void => {
    void navigate({
      to: "/kb/file/$itemId",
      params: { itemId: hit.id },
      search: { cl: hit.collectionId },
    })
  }

  // ── Navigation helpers ───────────────────────────────────────────────────

  const goToCollections = (): void => {
    void navigate({ search: (): KbSearch => ({}) })
  }
  const goToCollection = (clId: string): void => {
    void navigate({ search: (): KbSearch => ({ cl: clId }) })
  }
  const goToFolder = (parentId: string): void => {
    if (!currentCl) {
      return
    }
    void navigate({ search: (): KbSearch => ({ cl: currentCl, parent: parentId }) })
  }
  const goToParent = (parentId: string | null): void => {
    if (!currentCl) {
      return
    }
    void navigate({
      search: (): KbSearch =>
        parentId ? { cl: currentCl, parent: parentId } : { cl: currentCl },
    })
  }
  const goUp = (): void => {
    if (!currentCl) {
      return
    }
    if (breadcrumb.length <= 1) {
      goToParent(null)
      return
    }
    const next = breadcrumb[breadcrumb.length - 2]
    goToParent(next ? next.id : null)
  }

  const setQuery = (next: string): void => {
    void navigate({
      replace: true,
      search: (prev: KbSearch): KbSearch => {
        const out: KbSearch = {}
        if (prev.cl !== undefined) {
          out.cl = prev.cl
        }
        if (prev.parent !== undefined) {
          out.parent = prev.parent
        }
        if (next !== "") {
          out.q = next
        }
        return out
      },
    })
  }

  // ── Open / interact ──────────────────────────────────────────────────────

  const onOpenEntry = (entry: BrowserEntry): void => {
    if (currentCl === null) {
      // Root view: every entry is a collection.
      goToCollection(entry.id)
      return
    }
    if (entry.kind === "folder") {
      goToFolder(entry.id)
      return
    }
    // Files navigate to the viewer route.
    void navigate({
      to: "/kb/file/$itemId",
      params: { itemId: entry.id },
      search: { cl: currentCl },
    })
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  const submitNewCollection = async (name: string): Promise<void> => {
    const c = await createCollection(name)
    toast.success(`Created "${c.name}"`)
    setDialog(null)
    refresh()
  }

  const submitNewFolder = async (name: string): Promise<void> => {
    if (!currentCl) {
      return
    }
    await createFolder(currentCl, name, currentParent)
    toast.success(`Created folder "${name}"`)
    setDialog(null)
    refresh()
  }

  const onPickFiles = (): void => {
    fileInputRef.current?.click()
  }

  const doUpload = (fileList: FileList | File[]): void => {
    if (!currentCl) {
      return
    }
    const files = Array.from(fileList)
    if (files.length === 0) {
      return
    }
    // Hand off to the store: per-file XHR with onprogress, parallel.
    // Placeholders render via UploadingGrid/List below.
    uploadStore.start(currentCl, currentParent, files)
  }

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    if (e.target.files) {
      doUpload(e.target.files)
    }
    // Reset so picking the same file twice still triggers a change event.
    e.target.value = ""
  }

  const onDrop = (e: React.DragEvent<HTMLElement>): void => {
    e.preventDefault()
    setDragging(false)
    if (!currentCl) {
      toast.error("Open a collection before uploading")
      return
    }
    if (e.dataTransfer.files.length > 0) {
      doUpload(e.dataTransfer.files)
    }
  }

  // One-shot refresh the moment any placeholder transitions from
  // "uploading" → "processing" (i.e. its XHR just completed). The backend's
  // upload handler returns only after createFileItem commits the row, so a
  // single subsequent listItems() is guaranteed to see it — no need for an
  // interval. `seenProcessingRef` ensures we don't re-fire while the
  // placeholder lingers a render or two before markSeen drops it.
  useEffect((): void => {
    const stillHere = new Set<string>()
    for (const u of uploadsHere) {
      if (u.itemId !== undefined) {
        stillHere.add(u.itemId)
      }
    }
    for (const id of seenProcessingRef.current) {
      if (!stillHere.has(id)) {
        seenProcessingRef.current.delete(id)
      }
    }
    let needsRefresh = false
    for (const u of uploadsHere) {
      if (
        u.status === "processing" &&
        u.itemId !== undefined &&
        !seenProcessingRef.current.has(u.itemId)
      ) {
        seenProcessingRef.current.add(u.itemId)
        needsRefresh = true
      }
    }
    if (needsRefresh) {
      refresh()
    }
  }, [uploadsHere, refresh])

  const onDelete = async (entry: BrowserEntry): Promise<void> => {
    if (currentCl === null) {
      // Collection delete from root.
      const ok = window.confirm(
        `Delete collection "${entry.name}"? This removes all its files.`,
      )
      if (!ok) {
        return
      }
      try {
        await deleteCollection(entry.id)
        toast.success(`Deleted "${entry.name}"`)
        refresh()
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Delete failed"
        toast.error(msg)
      }
      return
    }
    const what = entry.kind === "folder" ? "folder" : "file"
    const ok = window.confirm(`Delete ${what} "${entry.name}"?`)
    if (!ok) {
      return
    }
    try {
      await deleteItem(currentCl, entry.id)
      toast.success(`Deleted "${entry.name}"`)
      refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Delete failed"
      toast.error(msg)
    }
  }

  // ── Header derivations ───────────────────────────────────────────────────

  const currentCollection: CollectionRow | undefined = useMemo(() => {
    if (!currentCl) {
      return undefined
    }
    // We don't keep collections in state once we navigate in; fall back to
    // showing the id in the breadcrumb if needed. We could fetch by id but
    // breadcrumb covers folder names already.
    return collections.find((c) => c.id === currentCl)
  }, [currentCl, collections])

  const rootLabel = currentCl
    ? currentCollection?.name ?? "Collection"
    : "Knowledge"

  const folderCount = entries.filter((e) => e.kind === "folder").length
  const fileCount = entries.length - folderCount
  const isAtRoot = currentCl === null
  const isAtCollectionRoot = currentCl !== null && currentParent === null

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        e.preventDefault()
        if (currentCl) {
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if ((e.target as HTMLElement) === e.currentTarget) {
          setDragging(false)
        }
      }}
      onDrop={onDrop}
    >
      <Topbar title={isAtRoot ? "Knowledge" : rootLabel} />

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/70 px-5 py-2.5 backdrop-blur-md">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            aria-label={isAtCollectionRoot ? "Back to collections" : "Up one level"}
            disabled={isAtRoot}
            onClick={(): void => {
              if (currentCl && currentParent === null) {
                // At collection root → back up to the collections list.
                goToCollections()
              } else {
                goUp()
              }
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            title={isAtRoot ? undefined : isAtCollectionRoot ? "Back to collections" : "Up"}
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
          </button>

          {isAtRoot ? (
            <span className="text-[13px] font-medium text-foreground">
              Knowledge
            </span>
          ) : (
            <Crumbs
              currentCl={currentCl}
              currentParent={currentParent}
              collectionName={rootLabel}
              chain={breadcrumb}
              onGoToCollections={goToCollections}
              onGoToParent={goToParent}
            />
          )}
        </div>

        <div className="flex items-center gap-2">
          {isAtRoot ? (
            <button
              type="button"
              onClick={(): void => {
                setDialog("collection")
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[12px] text-foreground transition hover:bg-secondary"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              New collection
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={(): void => {
                  setDialog("folder")
                }}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[12px] text-foreground transition hover:bg-secondary"
              >
                <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
                New folder
              </button>
              <button
                type="button"
                onClick={onPickFiles}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[12px] text-foreground transition hover:bg-secondary"
              >
                {hasUploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                ) : (
                  <Upload className="h-3.5 w-3.5" strokeWidth={1.75} />
                )}
                Upload
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                // `sr-only` (not `hidden`) — Firefox and some Chrome
                // security contexts refuse a programmatic .click() on a
                // display:none input. Keep the element in the layout
                // but offscreen so the file picker opens reliably.
                className="sr-only"
                onChange={onFileInputChange}
              />
            </>
          )}
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            aria-label="Refresh"
            title="Refresh"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface-elevated text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw
              className={cn(
                "h-3.5 w-3.5",
                loading && "animate-spin",
              )}
              strokeWidth={1.75}
            />
          </button>
          <ViewToggle value={view} onChange={setView} />
          <SearchField
            value={query}
            onChange={setQuery}
            className="w-64"
            ariaLabel="Search files"
            placeholder="Search files by name"
          />
        </div>
      </div>

      <main ref={mainRef} className="relative flex-1 overflow-auto px-5 py-5">
        {dragging ? (
          <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-ring/60 bg-background/80 text-[14px] font-medium text-foreground">
            Drop files to upload
          </div>
        ) : null}
        <div className="mx-auto w-full max-w-7xl">
          {searching ? (
            <SearchResultsView
              query={trimmedQuery}
              loading={searchLoading}
              error={searchError}
              hits={searchHits}
              onOpen={openHit}
            />
          ) : (
            <>
              <p className="mb-3 text-[12px] text-muted-foreground">
                {loading
                  ? "Loading…"
                  : isAtRoot
                    ? entries.length === 0
                      ? "No collections yet"
                      : `${String(entries.length)} collection${entries.length === 1 ? "" : "s"}`
                    : entries.length === 0
                      ? "This folder is empty"
                      : `${String(folderCount)} folder${folderCount === 1 ? "" : "s"} · ${String(fileCount)} file${fileCount === 1 ? "" : "s"}`}
              </p>

              {view === "grid" ? (
                <UploadingGrid
                  uploads={uploadsHere}
                  onCancel={uploadStore.cancel}
                  onRetry={uploadStore.retry}
                  onDismiss={uploadStore.dismiss}
                />
              ) : (
                <UploadingList
                  uploads={uploadsHere}
                  onCancel={uploadStore.cancel}
                  onRetry={uploadStore.retry}
                  onDismiss={uploadStore.dismiss}
                />
              )}

              {entries.length === 0 && !loading && uploadsHere.length === 0 ? (
                <EmptyPane isRoot={isAtRoot} />
              ) : entries.length === 0 ? null : view === "grid" ? (
                <EntryGrid
                  entries={entries}
                  onOpen={onOpenEntry}
                  onDelete={(e): void => {
                    void onDelete(e)
                  }}
                  scrollParentRef={mainRef}
                />
              ) : (
                <EntryList
                  entries={entries}
                  columns={KB_COLUMNS}
                  onOpen={onOpenEntry}
                  onDelete={(e): void => {
                    void onDelete(e)
                  }}
                  scrollParentRef={mainRef}
                />
              )}
            </>
          )}
        </div>
      </main>

      <NameDialog
        open={dialog === "collection"}
        title="New collection"
        description="Collections are top-level groups of folders and files. You can upload documents once it's created."
        label="Name"
        placeholder="e.g. Research papers"
        helper="Up to 255 characters."
        submitLabel="Create collection"
        onSubmit={submitNewCollection}
        onClose={(): void => {
          setDialog(null)
        }}
      />

      <NameDialog
        open={dialog === "folder"}
        title="New folder"
        description={
          currentParent
            ? "Adds a folder inside the current folder."
            : "Adds a folder at the top of this collection."
        }
        label="Folder name"
        placeholder="e.g. Drafts"
        helper="Up to 255 characters."
        submitLabel="Create folder"
        onSubmit={submitNewFolder}
        onClose={(): void => {
          setDialog(null)
        }}
      />
    </div>
  )
}

// Single-source breadcrumb rendered inline so every segment uses the same
// `>` separator, hover, and current-page styling. Builds:
//   Knowledge > <Collection> > <folder>… > <current>
// The last segment is unclickable (aria-current=page); everything else
// navigates back up the tree.
function Crumbs({
  currentCl,
  currentParent,
  collectionName,
  chain,
  onGoToCollections,
  onGoToParent,
}: {
  currentCl: string
  currentParent: string | null
  collectionName: string
  chain: { id: string; name: string }[]
  onGoToCollections: () => void
  onGoToParent: (parentId: string | null) => void
}): JSX.Element {
  void currentCl
  const atCollectionRoot = currentParent === null
  return (
    <nav
      aria-label="Knowledge path"
      className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground"
    >
      <button
        type="button"
        onClick={onGoToCollections}
        className="inline-flex items-center rounded-md px-1.5 py-0.5 transition hover:bg-secondary hover:text-foreground"
      >
        Knowledge
      </button>
      <Sep />
      {atCollectionRoot ? (
        <span
          aria-current="page"
          className="max-w-[28ch] truncate rounded-md px-1.5 py-0.5 font-medium text-foreground"
          title={collectionName}
        >
          {collectionName}
        </span>
      ) : (
        <button
          type="button"
          onClick={(): void => {
            onGoToParent(null)
          }}
          className="max-w-[20ch] truncate rounded-md px-1.5 py-0.5 transition hover:bg-secondary hover:text-foreground"
          title={collectionName}
        >
          {collectionName}
        </button>
      )}
      {chain.map((seg, i) => {
        const isLast = i === chain.length - 1
        return (
          <span key={seg.id} className="flex min-w-0 items-center gap-1">
            <Sep />
            {isLast ? (
              <span
                aria-current="page"
                className="max-w-[28ch] truncate rounded-md px-1.5 py-0.5 font-medium text-foreground"
                title={seg.name}
              >
                {seg.name}
              </span>
            ) : (
              <button
                type="button"
                onClick={(): void => {
                  onGoToParent(seg.id)
                }}
                className="max-w-[20ch] truncate rounded-md px-1.5 py-0.5 transition hover:bg-secondary hover:text-foreground"
                title={seg.name}
              >
                {seg.name}
              </button>
            )}
          </span>
        )
      })}
    </nav>
  )
}

function Sep(): JSX.Element {
  return (
    <ChevronRight
      className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60"
      aria-hidden
      strokeWidth={1.75}
    />
  )
}

function EmptyPane({ isRoot }: { isRoot: boolean }): JSX.Element {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 py-24 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-muted text-muted-foreground">
        <FolderOpen className="h-5 w-5" aria-hidden strokeWidth={1.5} />
      </span>
      <p className="text-[14px] font-medium text-foreground">
        {isRoot ? "No collections yet" : "Nothing here yet"}
      </p>
      <p className="max-w-xs text-[12.5px] text-muted-foreground">
        {isRoot
          ? "Create a collection to start organising and uploading documents."
          : "Drop files here or use the Upload button to add documents to this folder."}
      </p>
    </div>
  )
}

// ── Inline search results ──────────────────────────────────────────────────
//
// Shown in the main pane whenever the top-right search field has a non-empty
// query. The hits are global (same `searchFiles` endpoint the ⌘K palette
// hits) — the user said the modal shouldn't open from /kb's field, so we
// render the list inline instead. Visually richer than the palette row
// because we have the whole page width to play with.

function SearchResultsView({
  query,
  loading,
  error,
  hits,
  onOpen,
}: {
  query: string
  loading: boolean
  error: string | null
  hits: FileSearchHit[]
  onOpen: (hit: FileSearchHit) => void
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-muted-foreground">
        {loading
          ? "Searching…"
          : error
            ? "Search failed"
            : hits.length === 0
              ? `No files match "${query}"`
              : `${String(hits.length)} match${hits.length === 1 ? "" : "es"} for "${query}"`}
      </p>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-[12.5px] text-destructive">
          {error}
        </div>
      ) : null}

      {loading && hits.length === 0 ? (
        <ul aria-busy="true" aria-label="Loading results" className="flex flex-col gap-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <li
              key={i}
              aria-hidden
              className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-2.5"
            >
              <div className="h-7 w-7 flex-shrink-0 animate-breathe rounded-md bg-surface-elevated" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="h-2.5 w-1/2 animate-breathe rounded-full bg-surface-elevated" />
                <div className="h-2 w-1/3 animate-breathe rounded-full bg-surface-elevated" />
              </div>
            </li>
          ))}
        </ul>
      ) : hits.length === 0 && !error ? (
        <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 py-16 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-muted text-muted-foreground">
            <File className="h-5 w-5" aria-hidden strokeWidth={1.5} />
          </span>
          <p className="text-[14px] font-medium text-foreground">No matches</p>
          <p className="max-w-xs text-[12.5px] text-muted-foreground">
            Nothing matched <span className="font-medium text-foreground">"{query}"</span>.
            Try a shorter or different term.
          </p>
        </div>
      ) : (
        <ul role="list" aria-label="Search results" className="flex flex-col gap-1">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                onClick={(): void => {
                  onOpen(hit)
                }}
                className="group flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-left transition hover:border-ring hover:bg-surface-elevated"
              >
                <ResultBadge name={hit.name} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[13.5px] leading-tight text-foreground">
                      {highlightMatch(hit.name, query)}
                    </span>
                    <IngestStatusIndicator status={hit.uploadStatus} />
                  </span>
                  <span className="truncate text-[11.5px] leading-tight text-muted-foreground">
                    {hitBreadcrumb(hit)}
                  </span>
                </div>
                <span className="hidden flex-shrink-0 text-[11px] text-muted-foreground/80 md:inline">
                  {formatDate(hit.updatedAt)}
                </span>
                <ChevronRight
                  className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition group-hover:translate-x-0.5"
                  aria-hidden
                  strokeWidth={1.75}
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ResultBadge({ name }: { name: string }): JSX.Element {
  // Tiny coloured square keyed off the extension. Mirrors the palette tag so
  // the two views feel like the same feature.
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

function highlightMatch(name: string, q: string): React.ReactNode {
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

function hitBreadcrumb(hit: FileSearchHit): string {
  const collection = hit.collectionName || "Collection"
  const inner = hit.path.replace(/^\/|\/$/g, "")
  return inner.length === 0
    ? collection
    : `${collection} / ${inner.split("/").join(" / ")}`
}
