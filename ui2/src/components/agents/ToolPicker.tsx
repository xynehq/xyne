import { useMemo } from "react"

import type { AgentToolDescriptor } from "@/lib/api"

/** Tool allowlist picker — a grid of toggleable tiles, one per registry
 *  entry. An empty selection ("All tools") is the canonical default and
 *  lets the agent pick up new tools added to the registry without an
 *  edit. Shared between the parent agent form (Behaviour section) and
 *  the sub-agent inline form. */
export function ToolPicker({
  tools,
  selected,
  onChange,
  label = "Tools",
}: {
  tools: AgentToolDescriptor[]
  selected: string[]
  onChange: (next: string[]) => void
  /** Header text. Defaults to "Tools"; sub-agent form overrides to make
   *  the section distinct from the parent's. */
  label?: string
}): JSX.Element {
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const noneMode = selectedSet.size === 0
  const allMode = selectedSet.size === tools.length && tools.length > 0
  const toggle = (name: string): void => {
    const next = new Set(selectedSet)
    if (next.has(name)) {
      next.delete(name)
    } else {
      next.add(name)
    }
    onChange(Array.from(next))
  }
  const selectAll = (): void => {
    onChange(tools.map((t) => t.name))
  }
  const clearAll = (): void => {
    onChange([])
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium text-muted-foreground">
          {label}
        </span>
        <div className="flex items-center gap-2 text-[11.5px] font-medium text-muted-foreground">
          {!allMode && (
            <button
              type="button"
              onClick={selectAll}
              title="Enable every tool currently in the registry"
              className="transition hover:text-foreground"
            >
              Select all
            </button>
          )}
          {!noneMode && (
            <button
              type="button"
              onClick={clearAll}
              title="Clear the tool list — the agent will have no tools at run time"
              className="transition hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      <div
        className={`rounded-md border px-2 py-1.5 text-[11.5px] ${noneMode ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-border bg-surface-elevated text-muted-foreground"}`}
        role="status"
      >
        {noneMode
          ? "No tools selected — the agent will have nothing to call at run time. Select at least one tool above."
          : `${selectedSet.size} of ${tools.length} tools selected. Unselected tools are not callable.`}
      </div>
      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {tools.map((t) => {
          const on = selectedSet.has(t.name)
          return (
            <li key={t.name}>
              <button
                type="button"
                onClick={() => toggle(t.name)}
                className={`flex w-full flex-col items-start gap-0.5 rounded-md border px-2.5 py-2 text-left transition ${
                  on
                    ? "border-primary/60 bg-primary/5"
                    : "border-border bg-surface-elevated hover:border-border/80"
                }`}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="font-mono text-[12px] font-medium text-foreground">
                    {t.name}
                  </span>
                  <span
                    aria-hidden
                    className={`grid h-3.5 w-3.5 place-items-center rounded-sm border ${
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background"
                    }`}
                  >
                    {on ? "✓" : ""}
                  </span>
                </span>
                <span className="text-[11.5px] text-muted-foreground/90">
                  {t.label}
                </span>
                <span className="text-[11.5px] leading-snug text-muted-foreground/80">
                  {t.description}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
