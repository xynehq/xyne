import { useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { ArrowLeft, FolderOpen } from "lucide-react"
import { Topbar } from "@/components/Topbar"
import {
  EntryGrid,
  EntryList,
  PathBreadcrumb,
  SearchField,
  ViewToggle,
  type BrowserEntry,
  type ColumnDef,
  type ViewMode,
} from "@/components/file-browser"
import { splitPath } from "@/lib/files"
import {
  createFolder,
  enqueueUploads,
  useKbEntries,
  useKbSearch,
  type IncomingFile,
} from "@/lib/kb"
import { NewMenu } from "@/components/kb/NewMenu"
import { DropZone } from "@/components/kb/DropZone"
import { UploadTray } from "@/components/kb/UploadTray"
import { DraftFolder } from "@/components/kb/DraftFolder"

type KbSearch = {
  path?: string
  q?: string
}

export const Route = createFileRoute("/_authenticated/kb")({
  validateSearch: (raw: Record<string, unknown>): KbSearch => {
    const out: KbSearch = {}
    if (typeof raw["path"] === "string" && raw["path"] !== "") {
      out.path = raw["path"]
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
  const { path, q } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [view, setView] = useState<ViewMode>("grid")
  const [draftFolder, setDraftFolder] = useState(false)

  const currentPath = path ?? ""
  const query = q ?? ""

  const folderEntries = useKbEntries(currentPath)
  const searchResults = useKbSearch(currentPath, query)

  const isSearching = query.trim().length > 0
  const entries = isSearching ? searchResults : folderEntries

  const goToPath = (next: string): void => {
    setDraftFolder(false)
    void navigate({
      search: (): KbSearch => (next === "" ? {} : { path: next }),
    })
  }

  const setQuery = (next: string): void => {
    void navigate({
      replace: true,
      search: (prev: KbSearch): KbSearch => {
        const out: KbSearch = {}
        if (prev.path !== undefined) {
          out.path = prev.path
        }
        if (next !== "") {
          out.q = next
        }
        return out
      },
    })
  }

  const onOpenEntry = (entry: BrowserEntry): void => {
    if (entry.kind === "folder") {
      goToPath(entry.id)
    }
  }

  const goUp = (): void => {
    const segs = splitPath(currentPath)
    goToPath(segs.slice(0, -1).join("/"))
  }

  const handleUpload = (incoming: ReadonlyArray<IncomingFile>): void => {
    if (incoming.length === 0) {
      return
    }
    enqueueUploads(currentPath, incoming)
  }

  const handleNewFolder = (): void => {
    setDraftFolder(true)
  }

  const handleDraftCommit = (name: string): void => {
    createFolder(currentPath, name)
    setDraftFolder(false)
  }

  const segs = splitPath(currentPath)
  const folderCount = entries.filter((e) => e.kind === "folder").length
  const fileCount = entries.length - folderCount
  const lastSeg = segs[segs.length - 1]
  const destinationLabel = lastSeg ?? "Knowledge"

  const draftNode = draftFolder ? (
    <DraftFolder
      mode={view}
      listColumns={KB_COLUMNS}
      onCommit={handleDraftCommit}
      onCancel={(): void => {
        setDraftFolder(false)
      }}
    />
  ) : undefined

  return (
    <div className="flex h-full flex-col">
      <Topbar title="Knowledge" />

      <div className="relative z-20 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/70 px-5 py-2.5 backdrop-blur-md">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            aria-label="Up one level"
            disabled={segs.length === 0}
            onClick={goUp}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            title={segs.length === 0 ? undefined : "Up"}
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
          </button>
          <PathBreadcrumb
            path={currentPath}
            onNavigate={goToPath}
            rootLabel="Knowledge"
            ariaLabel="Knowledge path"
          />
        </div>

        <div className="flex items-center gap-2">
          <NewMenu
            onNewFolder={handleNewFolder}
            onFiles={handleUpload}
            onFolder={handleUpload}
          />
          <ViewToggle value={view} onChange={setView} />
          <SearchField
            value={query}
            onChange={setQuery}
            className="w-56"
            ariaLabel="Search knowledge"
            placeholder={
              lastSeg ? `Search in ${lastSeg}` : "Search knowledge"
            }
          />
        </div>
      </div>

      <DropZone
        className="flex-1 overflow-auto px-5 py-5"
        onDrop={handleUpload}
        destinationLabel={destinationLabel}
      >
        <div className="mx-auto w-full max-w-7xl">
          {isSearching ? (
            <p className="mb-3 text-[12px] text-muted-foreground">
              {entries.length === 0
                ? `No matches for "${query}"`
                : `${String(entries.length)} match${entries.length === 1 ? "" : "es"} for "${query}"`}
              {lastSeg ? (
                <>
                  {" "}
                  in <span className="text-foreground">{lastSeg}</span>
                </>
              ) : null}
            </p>
          ) : (
            <p className="mb-3 text-[12px] text-muted-foreground">
              {entries.length === 0 && !draftFolder
                ? "This folder is empty"
                : `${String(folderCount)} folder${folderCount === 1 ? "" : "s"} · ${String(fileCount)} file${fileCount === 1 ? "" : "s"}`}
            </p>
          )}

          {entries.length === 0 && !draftFolder ? (
            <EmptyPane searching={isSearching} query={query} />
          ) : view === "grid" ? (
            <EntryGrid
              entries={entries}
              onOpen={onOpenEntry}
              disableFiles
              {...(draftNode ? { leadingItem: draftNode } : {})}
            />
          ) : (
            <EntryList
              entries={entries}
              columns={KB_COLUMNS}
              onOpen={onOpenEntry}
              disableFiles
              {...(draftNode ? { leadingItem: draftNode } : {})}
            />
          )}
        </div>
      </DropZone>

      <UploadTray />
    </div>
  )
}

function EmptyPane({
  searching,
  query,
}: {
  searching: boolean
  query: string
}): JSX.Element {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 py-24 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-muted text-muted-foreground">
        <FolderOpen className="h-5 w-5" aria-hidden strokeWidth={1.5} />
      </span>
      <p className="text-[14px] font-medium text-foreground">
        {searching ? "No matches" : "Nothing here yet"}
      </p>
      <p className="max-w-xs text-[12.5px] text-muted-foreground">
        {searching
          ? `We couldn${"’"}t find anything matching "${query}" in this folder. Try a broader term or clear the search to browse.`
          : `Drop files here, or use ${"“"}+ New${"”"} to create a folder or upload.`}
      </p>
    </div>
  )
}
