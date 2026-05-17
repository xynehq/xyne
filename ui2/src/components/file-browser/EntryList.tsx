// Tabular list of folder + file entries. Columns are caller-provided so the
// list adapts to any feature (KB shows Kind/Size/Updated; Custom Agents
// could show Model/Author/Updated; etc.).

import { Trash2 } from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@/lib/utils"
import type { BrowserEntry, ColumnDef, LeadingRenderer } from "./types"
import { FileCard } from "./FileCard"
import { FolderCard } from "./FolderCard"
import { LIST_DEFAULT_COL_WIDTH, LIST_ROW_HEIGHT_ESTIMATE } from "./constants"

type Props = {
  entries: ReadonlyArray<BrowserEntry>
  columns?: ReadonlyArray<ColumnDef>
  onOpen?: (entry: BrowserEntry) => void
  // Header label for the leading (primary) column. Defaults to "Name".
  nameHeader?: string
  // Override the leading visual. Defaults to FileCard / FolderCard at "sm".
  renderLeading?: LeadingRenderer
  disableFiles?: boolean
  disableFolders?: boolean
  // Optional per-row delete affordance. Renders a trash button in the right
  // gutter (visible on hover); reserves a 36px trailing column when set.
  onDelete?: (entry: BrowserEntry) => void
  // Scroll container that contains this list. When provided, rows are
  // virtualized against it. Omit to render every row (fine for small lists
  // or contexts where the parent isn't a scroller).
  scrollElement?: HTMLElement | null
}

const defaultLeading: LeadingRenderer = (entry, size) =>
  entry.kind === "folder" ? (
    <FolderCard size={size} />
  ) : (
    <FileCard format={entry.format || "txt"} size={size} />
  )

export function EntryList({
  entries,
  columns = [],
  onOpen,
  nameHeader = "Name",
  renderLeading = defaultLeading,
  disableFiles = false,
  disableFolders = false,
  onDelete,
  scrollElement,
}: Props): JSX.Element {
  const template = [
    "1fr",
    ...columns.map((c) => c.width ?? LIST_DEFAULT_COL_WIDTH),
    ...(onDelete ? ["36px"] : []),
  ].join(" ")
  const isDisabled = (e: BrowserEntry): boolean =>
    (e.kind === "file" && disableFiles) ||
    (e.kind === "folder" && disableFolders)

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollElement ?? null,
    estimateSize: () => LIST_ROW_HEIGHT_ESTIMATE,
    overscan: 8,
    measureElement: (el): number => el.getBoundingClientRect().height,
  })

  const renderRow = (e: BrowserEntry, virtualStart?: number): JSX.Element => {
    const disabled = isDisabled(e)
    return (
      <div
        className={cn(
          "group relative grid w-full items-center gap-3 px-4 py-2 transition",
          disabled ? "cursor-default" : "hover:bg-secondary/60",
          virtualStart !== undefined ? "absolute inset-x-0" : "",
        )}
        style={{
          gridTemplateColumns: template,
          ...(virtualStart !== undefined
            ? { transform: `translateY(${String(virtualStart)}px)` }
            : {}),
        }}
        title={e.name}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            onOpen?.(e)
          }}
          className="flex min-w-0 items-center gap-3 text-left disabled:cursor-default"
        >
          <span className="flex-shrink-0 pr-1">{renderLeading(e, "sm")}</span>
          <span className="truncate text-[13.5px] font-medium text-foreground">
            {e.name}
          </span>
        </button>
        {columns.map((c) => (
          <button
            key={`c-${c.key}`}
            type="button"
            disabled={disabled}
            onClick={() => {
              onOpen?.(e)
            }}
            className={cn(
              c.mdOnly === false ? undefined : "hidden md:block",
              "truncate text-left tabular-nums text-[12px] text-muted-foreground disabled:cursor-default",
            )}
          >
            {c.render ? c.render(e) : (e.columns?.[c.key] ?? "—")}
          </button>
        ))}
        {onDelete ? (
          <button
            type="button"
            aria-label={`Delete ${e.name}`}
            title="Delete"
            onClick={(ev) => {
              ev.stopPropagation()
              onDelete(e)
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 focus:opacity-100 dark:hover:bg-red-950/40"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="animate-fade-up overflow-hidden rounded-2xl border border-border bg-surface-elevated">
      <div
        className="grid items-center gap-3 border-b border-border bg-surface-muted/60 px-4 py-2 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground"
        style={{ gridTemplateColumns: template }}
      >
        <span>{nameHeader}</span>
        {columns.map((c) => (
          <span
            key={`h-${c.key}`}
            className={c.mdOnly === false ? undefined : "hidden md:block"}
          >
            {c.header}
          </span>
        ))}
        {onDelete ? <span aria-hidden /> : null}
      </div>

      {scrollElement ? (
        <div
          role="list"
          aria-rowcount={entries.length}
          style={{
            height: `${String(virtualizer.getTotalSize())}px`,
            position: "relative",
          }}
          className="divide-y divide-border"
        >
          {virtualizer.getVirtualItems().map((v) => {
            const e = entries[v.index]
            if (!e) {
              return null
            }
            return (
              <div
                key={`${e.kind}-${e.id}`}
                role="listitem"
                data-index={v.index}
                ref={virtualizer.measureElement}
              >
                {renderRow(e, v.start)}
              </div>
            )
          })}
        </div>
      ) : (
        <ul role="list" className="divide-y divide-border">
          {entries.map((e) => (
            <li key={`${e.kind}-${e.id}`}>{renderRow(e)}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
