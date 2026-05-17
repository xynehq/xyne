import { LayoutGrid, List } from "lucide-react"

export type ViewMode = "grid" | "list"

type Props = {
  value: ViewMode
  onChange: (mode: ViewMode) => void
}

export function ViewToggle({ value, onChange }: Props): JSX.Element {
  return (
    <div
      role="group"
      aria-label="View mode"
      className="inline-flex items-center rounded-full border border-border bg-surface-elevated p-0.5"
    >
      <button
        type="button"
        aria-label="Grid view"
        aria-pressed={value === "grid"}
        onClick={() => {
          onChange("grid")
        }}
        className={
          value === "grid"
            ? "inline-flex h-7 w-7 items-center justify-center rounded-full bg-secondary text-foreground"
            : "inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition hover:text-foreground"
        }
      >
        <LayoutGrid className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
      </button>
      <button
        type="button"
        aria-label="List view"
        aria-pressed={value === "list"}
        onClick={() => {
          onChange("list")
        }}
        className={
          value === "list"
            ? "inline-flex h-7 w-7 items-center justify-center rounded-full bg-secondary text-foreground"
            : "inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition hover:text-foreground"
        }
      >
        <List className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
      </button>
    </div>
  )
}
