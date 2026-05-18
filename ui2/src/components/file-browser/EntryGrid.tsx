// Card grid of folder + file entries. Feature-agnostic: takes neutral
// BrowserEntry shapes, a single open handler, and optional escape hatches
// for the leading visual / per-kind interactivity.

import { Trash2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@/lib/utils"
import type { BrowserEntry, LeadingRenderer } from "./types"
import { FileCard } from "./FileCard"
import { FolderCard } from "./FolderCard"
import { GRID_ROW_GAP, GRID_ROW_HEIGHT_ESTIMATE } from "./constants"
import { columnCountForWidth } from "./utils"

type Props = {
  entries: ReadonlyArray<BrowserEntry>
  onOpen?: (entry: BrowserEntry) => void
  renderLeading?: LeadingRenderer
  disableFiles?: boolean
  disableFolders?: boolean
  onDelete?: (entry: BrowserEntry) => void
  scrollElement?: HTMLElement | null
}

const defaultLeading: LeadingRenderer = (entry, size) =>
  entry.kind === "folder" ? (
    <FolderCard size={size} />
  ) : (
    <FileCard format={entry.format || "txt"} size={size} />
  )

export function EntryGrid({
  entries,
  onOpen,
  renderLeading = defaultLeading,
  disableFiles = false,
  disableFolders = false,
  onDelete,
  scrollElement,
}: Props): JSX.Element {
  const isDisabled = (e: BrowserEntry): boolean =>
    (e.kind === "file" && disableFiles) ||
    (e.kind === "folder" && disableFolders)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [cols, setCols] = useState<number>(5)

  useEffect((): (() => void) | undefined => {
    if (!containerRef.current) {
      return undefined
    }
    const el = containerRef.current
    const update = (w: number): void => {
      const next = columnCountForWidth(w)
      setCols((prev) => (prev === next ? prev : next))
    }
    update(el.getBoundingClientRect().width)
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) {
        update(entry.contentRect.width)
      }
    })
    ro.observe(el)
    return (): void => {
      ro.disconnect()
    }
  }, [])

  const rowCount = Math.max(1, Math.ceil(entries.length / cols))

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollElement ?? null,
    estimateSize: () => GRID_ROW_HEIGHT_ESTIMATE + GRID_ROW_GAP,
    overscan: 3,
    measureElement: (el): number => el.getBoundingClientRect().height,
  })

  const renderCard = (e: BrowserEntry): JSX.Element => {
    const disabled = isDisabled(e)
    return (
      <div key={`${e.kind}-${e.id}`} className="group relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            onOpen?.(e)
          }}
          className={cn(
            "flex w-full flex-col items-start gap-3 rounded-2xl border border-border bg-surface-elevated p-4 text-left transition",
            disabled
              ? "cursor-default"
              : "hover:border-ring/40 hover:bg-secondary/60 active:scale-[0.99]",
          )}
          title={e.name}
        >
          <div className="pl-1 pt-1">{renderLeading(e, "md")}</div>
          <span className="flex w-full min-w-0 flex-col gap-0.5">
            <span className="truncate text-[13.5px] font-medium text-foreground">
              {e.name}
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
  }

  if (!scrollElement) {
    return (
      <div
        ref={containerRef}
        role="list"
        className="grid animate-fade-up grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
      >
        {entries.map((e) => (
          <div role="listitem" key={`${e.kind}-${e.id}`}>
            {renderCard(e)}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      role="list"
      aria-rowcount={rowCount}
      className="animate-fade-up"
      style={{
        height: `${String(virtualizer.getTotalSize())}px`,
        position: "relative",
      }}
    >
      {virtualizer.getVirtualItems().map((v) => {
        const start = v.index * cols
        const slice = entries.slice(start, start + cols)
        return (
          <div
            key={v.key}
            data-index={v.index}
            ref={virtualizer.measureElement}
            className="absolute inset-x-0 grid gap-3"
            style={{
              transform: `translateY(${String(v.start)}px)`,
              gridTemplateColumns: `repeat(${String(cols)}, minmax(0, 1fr))`,
              paddingBottom: `${String(GRID_ROW_GAP)}px`,
            }}
          >
            {slice.map((e) => (
              <div role="listitem" key={`${e.kind}-${e.id}`}>
                {renderCard(e)}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
