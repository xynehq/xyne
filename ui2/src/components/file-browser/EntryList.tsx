// Tabular list of folder + file entries. Columns are caller-provided so the
// list adapts to any feature (KB shows Kind/Size/Updated; Custom Agents
// could show Model/Author/Updated; etc.).

import { Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { BrowserEntry, ColumnDef, LeadingRenderer } from "./types"
import { FileCard } from "./FileCard"
import { FolderCard } from "./FolderCard"

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
}

const DEFAULT_COL_WIDTH = "120px"

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
}: Props): JSX.Element {
  const template = [
    "1fr",
    ...columns.map((c) => c.width ?? DEFAULT_COL_WIDTH),
    ...(onDelete ? ["36px"] : []),
  ].join(" ")
  const isDisabled = (e: BrowserEntry): boolean =>
    (e.kind === "file" && disableFiles) ||
    (e.kind === "folder" && disableFolders)
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
      <ul role="list" className="divide-y divide-border">
        {entries.map((e) => {
          const disabled = isDisabled(e)
          return (
            <li key={`${e.kind}-${e.id}`} className="group relative">
              <div
                className={cn(
                  "grid w-full items-center gap-3 px-4 py-2 transition",
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
            </li>
          )
        })}
      </ul>
    </div>
  )
}
