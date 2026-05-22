// Card grid of folder + file entries. Feature-agnostic: takes neutral
// BrowserEntry shapes, a single open handler, and optional escape hatches
// for the leading visual / per-kind interactivity.

import { Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@/lib/utils"
import type { BrowserEntry, LeadingRenderer } from "./types"
import { IngestStatusIndicator } from "./IngestStatusIndicator"
import { ROW_ESTIMATE_GRID_PX } from "./constants"
import { defaultLeading, isEntryDisabled, useScrollMargin } from "./utils"

type Props = {
  entries: ReadonlyArray<BrowserEntry>
  // Called when the user activates an entry. When `disableFiles` /
  // `disableFolders` is set the corresponding entry kind won't reach this
  // handler.
  onOpen?: (entry: BrowserEntry) => void
  // Override the leading visual. Defaults to FileCard / FolderCard at "md".
  renderLeading?: LeadingRenderer
  // Show file entries as non-actionable (no hover affordance, click is a
  // no-op). Useful while file preview / open is still being wired up so the
  // UI doesn't look broken on click.
  disableFiles?: boolean
  disableFolders?: boolean
  // Optional per-card delete affordance. Renders a small trash button in the
  // top-right that's revealed on hover; click bubbling is stopped so it
  // doesn't trigger `onOpen`.
  onDelete?: (entry: BrowserEntry) => void
  scrollParentRef: React.RefObject<HTMLElement | null>
}

function colsFor(width: number): number {
  if (width >= 1280) {
    return 5
  }
  if (width >= 1024) {
    return 4
  }
  if (width >= 640) {
    return 3
  }
  return 2
}

function useResponsiveCols(): number {
  const [cols, setCols] = useState<number>(() =>
    typeof window === "undefined" ? 2 : colsFor(window.innerWidth),
  )
  useEffect((): (() => void) => {
    const update = (): void => {
      setCols(colsFor(window.innerWidth))
    }
    update()
    window.addEventListener("resize", update)
    return (): void => {
      window.removeEventListener("resize", update)
    }
  }, [])
  return cols
}

export function EntryGrid({
  entries,
  onOpen,
  renderLeading = defaultLeading,
  disableFiles = false,
  disableFolders = false,
  onDelete,
  scrollParentRef,
}: Props): JSX.Element {
  const cols = useResponsiveCols()
  const rowCount = Math.ceil(entries.length / cols)

  const { listRef: gridRef, scrollMargin } = useScrollMargin(scrollParentRef)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => ROW_ESTIMATE_GRID_PX,
    overscan: 3,
    scrollMargin,
    getItemKey: (i) => `row-${String(i)}-c${String(cols)}`,
  })

  return (
    <div
      ref={gridRef}
      role="list"
      className="animate-fade-up"
      style={{
        height: `${String(virtualizer.getTotalSize())}px`,
        position: "relative",
      }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const start = virtualRow.index * cols
        const rowEntries = entries.slice(start, start + cols)
        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 right-0 grid gap-3 pb-3"
            style={{
              transform: `translateY(${String(virtualRow.start - virtualizer.options.scrollMargin)}px)`,
              gridTemplateColumns: `repeat(${String(cols)}, minmax(0, 1fr))`,
            }}
          >
            {rowEntries.map((e) => {
              const disabled = isEntryDisabled(e, disableFiles, disableFolders)
              return (
                <div
                  key={`${e.kind}-${e.id}`}
                  role="listitem"
                  className="group relative"
                >
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      onOpen?.(e)
                    }}
                    className={cn(
                      "flex w-full flex-col items-start gap-3 rounded-2xl border bg-surface-elevated p-4 text-left transition",
                      // Pulsing ring while ingestion is still in flight so
                      // the row clearly reads as "not ready yet" at a
                      // glance. Uses the theme's `ring` token so the
                      // indicator picks up the right colour in both light
                      // + dark mode.
                      e.status === "pending" || e.status === "processing"
                        ? "animate-pulse border-ring/60 ring-1 ring-ring/25"
                        : "border-border",
                      disabled
                        ? "cursor-default"
                        : "hover:border-ring/40 hover:bg-secondary/60 active:scale-[0.99]",
                    )}
                    title={e.name}
                  >
                    <div className="pl-1 pt-1">{renderLeading(e, "md")}</div>
                    <span className="flex w-full min-w-0 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[13.5px] font-medium text-foreground">
                          {e.name}
                        </span>
                        <IngestStatusIndicator status={e.status} />
                      </span>
                      {e.caption ? (
                        <span className="truncate text-[11.5px] text-muted-foreground">
                          {e.caption}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  {onDelete ? (
                    <button
                      type="button"
                      aria-label={`Delete ${e.name}`}
                      title="Delete"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        onDelete(e)
                      }}
                      className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md bg-background/80 text-muted-foreground opacity-0 shadow-sm ring-1 ring-border backdrop-blur-sm transition group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 focus:opacity-100 dark:hover:bg-red-950/40"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                  ) : null}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
