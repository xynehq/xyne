// Card grid of folder + file entries. Feature-agnostic: takes neutral
// BrowserEntry shapes, a single open handler, and optional escape hatches
// for the leading visual / per-kind interactivity.

import { Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { BrowserEntry, LeadingRenderer } from "./types"
import { FileCard } from "./FileCard"
import { FolderCard } from "./FolderCard"

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
}: Props): JSX.Element {
  const isDisabled = (e: BrowserEntry): boolean =>
    (e.kind === "file" && disableFiles) ||
    (e.kind === "folder" && disableFolders)
  return (
    <ul
      role="list"
      className="grid animate-fade-up grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
    >
      {entries.map((e) => {
        const disabled = isDisabled(e)
        return (
          <li key={`${e.kind}-${e.id}`} className="group relative">
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
          </li>
        )
      })}
    </ul>
  )
}
