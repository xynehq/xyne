// Inline placeholder that takes the visual slot of a normal entry (card in
// grid view, row in list view) and presents an InlineRenameField for the
// user to name a new folder. Commits on Enter / blur, cancels on Escape.

import { InlineRenameField } from "@/components/InlineRenameField"
import { FolderCard, type ColumnDef } from "@/components/file-browser"

type Props = {
  mode: "grid" | "list"
  onCommit: (name: string) => void
  onCancel: () => void
  // For list view: must match the grid template used by the surrounding
  // EntryList so the row aligns with the data rows underneath it.
  listColumns?: ReadonlyArray<ColumnDef>
}

const DEFAULT_COL_WIDTH = "120px"

export function DraftFolder({
  mode,
  onCommit,
  onCancel,
  listColumns = [],
}: Props): JSX.Element {
  if (mode === "grid") {
    return (
      <div className="flex w-full flex-col items-start gap-3 rounded-2xl border border-ring/60 bg-surface-elevated p-4">
        <div className="pl-1 pt-1">
          <FolderCard size="md" />
        </div>
        <InlineRenameField
          initial="Untitled folder"
          placeholder="Untitled folder"
          onCommit={(next): void => {
            onCommit(next)
          }}
          onCancel={onCancel}
          className="w-full"
          inputClassName="h-8 w-full min-w-0 rounded-md border border-border bg-surface px-2 text-[13.5px] font-medium text-foreground focus:border-ring focus:outline-none"
        />
      </div>
    )
  }
  const template = [
    "1fr",
    ...listColumns.map((c) => c.width ?? DEFAULT_COL_WIDTH),
  ].join(" ")
  return (
    <div
      className="grid w-full items-center gap-3 bg-secondary/40 px-4 py-2"
      style={{ gridTemplateColumns: template }}
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className="flex-shrink-0 pr-1">
          <FolderCard size="sm" />
        </span>
        <InlineRenameField
          initial="Untitled folder"
          placeholder="Untitled folder"
          onCommit={(next): void => {
            onCommit(next)
          }}
          onCancel={onCancel}
          className="flex h-8 min-w-0 flex-1 items-center rounded-md bg-transparent px-1"
          inputClassName="h-7 w-full min-w-0 flex-1 rounded-md bg-surface px-1.5 text-[13.5px] font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </span>
      {listColumns.map((c) => (
        <span
          key={`d-${c.key}`}
          className={
            c.mdOnly === false
              ? "text-[12px] text-muted-foreground"
              : "hidden text-[12px] text-muted-foreground md:block"
          }
        >
          —
        </span>
      ))}
    </div>
  )
}
