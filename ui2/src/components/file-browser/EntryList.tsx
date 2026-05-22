// Tabular list of folder + file entries. Columns are caller-provided so the
// list adapts to any feature (KB shows Kind/Size/Updated; Custom Agents
// could show Model/Author/Updated; etc.).

import { Trash2 } from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@/lib/utils"
import type { BrowserEntry, ColumnDef, LeadingRenderer } from "./types"
import { IngestStatusIndicator } from "./IngestStatusIndicator"
import { DEFAULT_COL_WIDTH, ROW_ESTIMATE_LIST_PX } from "./constants"
import { defaultLeading, isEntryDisabled, useScrollMargin } from "./utils"

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
  scrollParentRef: React.RefObject<HTMLElement | null>
}

export function EntryList({
  entries,
  columns = [],
  onOpen,
  nameHeader = "Name",
  renderLeading = defaultLeading,
  disableFiles = false,
  disableFolders = false,
  onDelete,
  scrollParentRef,
}: Props): JSX.Element {
  const template = [
    "1fr",
    ...columns.map((c) => c.width ?? DEFAULT_COL_WIDTH),
    ...(onDelete ? ["36px"] : []),
  ].join(" ")

  const { listRef, scrollMargin } = useScrollMargin(scrollParentRef)

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => ROW_ESTIMATE_LIST_PX,
    overscan: 6,
    scrollMargin,
    getItemKey: (i) => {
      const entry = entries[i]
      return entry ? `${entry.kind}-${entry.id}` : `i-${String(i)}`
    },
  })

  const virtualRows = virtualizer.getVirtualItems()

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
      <div
        ref={listRef}
        role="list"
        style={{
          height: `${String(virtualizer.getTotalSize())}px`,
          position: "relative",
        }}
      >
        {virtualRows.map((virtualRow) => {
          const e = entries[virtualRow.index]
          if (!e) {
            return null
          }
          const disabled = isEntryDisabled(e, disableFiles, disableFolders)
          return (
            <div
              key={virtualRow.key}
              role="listitem"
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className={cn(
                "group absolute left-0 right-0",
                virtualRow.index > 0 && "border-t border-border",
              )}
              style={{
                transform: `translateY(${String(virtualRow.start - virtualizer.options.scrollMargin)}px)`,
              }}
            >
              <div
                className={cn(
                  "grid w-full items-center gap-3 px-4 py-2 transition",
                  (e.status === "pending" || e.status === "processing") &&
                    "animate-pulse ring-1 ring-inset ring-ring/30",
                  disabled ? "cursor-default" : "hover:bg-secondary/60",
                )}
                style={{ gridTemplateColumns: template }}
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
                  <span className="flex-shrink-0 pr-1">
                    {renderLeading(e, "sm")}
                  </span>
                  <span className="truncate text-[13.5px] font-medium text-foreground">
                    {e.name}
                  </span>
                  <IngestStatusIndicator status={e.status} />
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
            </div>
          )
        })}
      </div>
    </div>
  )
}
