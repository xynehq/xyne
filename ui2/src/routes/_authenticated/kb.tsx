import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import {
  ArrowLeft,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  Loader2,
  Plus,
  Upload,
} from "lucide-react"
import { Topbar } from "@/components/Topbar"
import {
  EntryGrid,
  EntryList,
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
  uploadFiles,
  type CollectionRow,
  type ItemRow,
} from "@/lib/kb"

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
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [dialog, setDialog] = useState<"collection" | "folder" | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

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
      Promise.all([
        listItems(currentCl, currentParent),
        currentParent ? getBreadcrumb(currentCl, currentParent) : Promise.resolve([]),
      ])
        .then(([rows, chain]): void => {
          if (cancelled) {
            return
          }
          setItems(rows)
          setBreadcrumb(chain)
          setCollections([])
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

  // Apply client-side search filter once we have the rows.
  const filteredItems = useMemo<ItemRow[]>(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) {
      return items
    }
    return items.filter((it) => it.name.toLowerCase().includes(needle))
  }, [items, query])

  const filteredCollections = useMemo<CollectionRow[]>(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) {
      return collections
    }
    return collections.filter((c) => c.name.toLowerCase().includes(needle))
  }, [collections, query])

  const entries: BrowserEntry[] = useMemo(
    () =>
      currentCl === null
        ? filteredCollections.map(collectionToFolderEntry)
        : filteredItems.map(itemToEntry),
    [currentCl, filteredCollections, filteredItems],
  )

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

  const doUpload = async (fileList: FileList | File[]): Promise<void> => {
    if (!currentCl) {
      return
    }
    const files = Array.from(fileList)
    if (files.length === 0) {
      return
    }
    setUploading(true)
    try {
      const res = await uploadFiles(currentCl, files, currentParent)
      if (res.summary.successful > 0) {
        toast.success(
          `Uploaded ${String(res.summary.successful)} of ${String(res.summary.total)} file${res.summary.total === 1 ? "" : "s"}`,
        )
      }
      for (const r of res.results) {
        if (!r.success) {
          toast.error(`${r.name} — ${r.error}`)
        }
      }
      refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed"
      toast.error(`Upload failed — ${msg}`)
    } finally {
      setUploading(false)
    }
  }

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    if (e.target.files) {
      void doUpload(e.target.files)
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
      void doUpload(e.dataTransfer.files)
    }
  }

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
                disabled={uploading}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[12px] text-foreground transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
              >
                {uploading ? (
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
                className="hidden"
                onChange={onFileInputChange}
              />
            </>
          )}
          <ViewToggle value={view} onChange={setView} />
          <SearchField
            value={query}
            onChange={setQuery}
            className="w-56"
            ariaLabel="Search knowledge"
            placeholder={isAtRoot ? "Search collections" : "Search in folder"}
          />
        </div>
      </div>

      <main className="relative flex-1 overflow-auto px-5 py-5">
        {dragging ? (
          <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-ring/60 bg-background/80 text-[14px] font-medium text-foreground">
            Drop files to upload
          </div>
        ) : null}
        <div className="mx-auto w-full max-w-7xl">
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

          {entries.length === 0 && !loading ? (
            <EmptyPane
              isRoot={isAtRoot}
              searching={query.trim().length > 0}
              query={query}
            />
          ) : view === "grid" ? (
            <EntryGrid
              entries={entries}
              onOpen={onOpenEntry}
              onDelete={(e): void => {
                void onDelete(e)
              }}
            />
          ) : (
            <EntryList
              entries={entries}
              columns={KB_COLUMNS}
              onOpen={onOpenEntry}
              onDelete={(e): void => {
                void onDelete(e)
              }}
            />
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

function EmptyPane({
  isRoot,
  searching,
  query,
}: {
  isRoot: boolean
  searching: boolean
  query: string
}): JSX.Element {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 py-24 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-muted text-muted-foreground">
        <FolderOpen className="h-5 w-5" aria-hidden strokeWidth={1.5} />
      </span>
      <p className="text-[14px] font-medium text-foreground">
        {searching ? "No matches" : isRoot ? "No collections yet" : "Nothing here yet"}
      </p>
      <p className="max-w-xs text-[12.5px] text-muted-foreground">
        {searching
          ? `We couldn't find anything matching "${query}". Try a broader term.`
          : isRoot
            ? "Create a collection to start organising and uploading documents."
            : "Drop files here or use the Upload button to add documents to this folder."}
      </p>
    </div>
  )
}
