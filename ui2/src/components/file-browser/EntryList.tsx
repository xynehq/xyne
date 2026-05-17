// Tabular list of folder + file entries. Columns are caller-provided so the
// list adapts to any feature (KB shows Kind/Size/Updated; Custom Agents
// could show Model/Author/Updated; etc.).

import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import type { BrowserEntry, ColumnDef, LeadingRenderer } from "./types"
import { FileCard } from "./FileCard"
import { FolderCard } from "./FolderCard"
import { StatusBadge } from "./StatusBadge"

type Props = {
  entries: ReadonlyArray<BrowserEntry>
  columns?: ReadonlyArray<ColumnDef>
  onOpen?: (entry: BrowserEntry) => void
  nameHeader?: string
  renderLeading?: LeadingRenderer
  disableFiles?: boolean
  disableFolders?: boolean
  // Optional caller-controlled row rendered as the FIRST row inside the
  // tabular body — used for things like the inline new-folder draft.
  leadingItem?: ReactNode
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
  leadingItem,
}: Props): JSX.Element {
  const template = [
    "1fr",
    ...columns.map((c) => c.width ?? DEFAULT_COL_WIDTH),
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
      </div>
      <ul className="divide-y divide-border">
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
                  "grid w-full items-center gap-3 px-4 py-2 text-left transition",
                  disabled ? "cursor-default" : "hover:bg-secondary/60",
                )}
                style={{ gridTemplateColumns: template }}
                title={e.name}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="flex-shrink-0 pr-1">
                    {renderLeading(e, "sm")}
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[13.5px] font-medium text-foreground">
                      {e.name}
                    </span>
                    {e.indicator ? (
                      <StatusBadge indicator={e.indicator} variant="inline" />
                    ) : null}
                  </span>
                </span>
                {columns.map((c) => (
                  <span
                    key={`c-${c.key}`}
                    className={cn(
                      c.mdOnly === false ? undefined : "hidden md:block",
                      "truncate tabular-nums text-[12px] text-muted-foreground",
                    )}
                  >
                    {c.render ? c.render(e) : (e.columns?.[c.key] ?? "—")}
                  </span>
                ))}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
