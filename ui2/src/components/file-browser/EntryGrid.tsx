// Card grid of folder + file entries. Feature-agnostic: takes neutral
// BrowserEntry shapes, a single open handler, and optional escape hatches
// for the leading visual / per-kind interactivity.

import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import type { BrowserEntry, LeadingRenderer } from "./types"
import { FileCard } from "./FileCard"
import { FolderCard } from "./FolderCard"
import { StatusBadge } from "./StatusBadge"

type Props = {
  entries: ReadonlyArray<BrowserEntry>
  onOpen?: (entry: BrowserEntry) => void
  renderLeading?: LeadingRenderer
  disableFiles?: boolean
  disableFolders?: boolean
  // Optional caller-controlled cell rendered as the FIRST grid item — used
  // for things like the inline new-folder draft. Receives no props; the
  // caller supplies a fully-styled card matching the grid cell shape.
  leadingItem?: ReactNode
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
  leadingItem,
}: Props): JSX.Element {
  const isDisabled = (e: BrowserEntry): boolean =>
    (e.kind === "file" && disableFiles) ||
    (e.kind === "folder" && disableFolders)
  return (
    <ul className="grid animate-fade-up grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {leadingItem ? <li>{leadingItem}</li> : null}
      {entries.map((e) => {
        const disabled = isDisabled(e)
        return (
          <li key={`${e.kind}-${e.id}`}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                onOpen?.(e)
              }}
              className={cn(
                "group relative flex w-full flex-col items-start gap-3 rounded-2xl border border-border bg-surface-elevated p-4 text-left transition",
                disabled
                  ? "cursor-default"
                  : "hover:border-ring/40 hover:bg-secondary/60 active:scale-[0.99]",
              )}
              title={e.name}
            >
              {e.indicator ? (
                <StatusBadge indicator={e.indicator} variant="card" />
              ) : null}
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
          </li>
        )
      })}
    </ul>
  )
}
