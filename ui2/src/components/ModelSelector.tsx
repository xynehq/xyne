import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown } from "lucide-react"
import { useModels } from "@/lib/models"

export function ModelSelector(): JSX.Element {
  const { models, selected, setSelected, groups, loading } = useModels()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect((): (() => void) => {
    const onDoc = (e: MouseEvent): void => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [])

  const label = loading
    ? "Loading…"
    : selected ?? models[0]?.labelName ?? "No models"

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v)
        }}
        disabled={loading || models.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors duration-150 hover:bg-secondary/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="max-w-[12rem] truncate">{label}</span>
        <ChevronDown
          className={
            "h-3.5 w-3.5 opacity-60 transition-transform duration-150 " +
            (open ? "rotate-180" : "")
          }
          aria-hidden
          strokeWidth={1.75}
        />
      </button>

      {open && groups.length > 0 && (
        <div
          role="listbox"
          aria-label="Model"
          className="animate-fade-up absolute bottom-full right-0 z-30 mb-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface-elevated p-1 shadow-lg shadow-foreground/[0.06]"
        >
          <ul className="max-h-[60vh] overflow-y-auto">
            {groups.map((group, gi) => (
              <li key={group.family}>
                {gi > 0 && <div className="my-1 h-px bg-border/60" />}
                <div className="px-2 pb-0.5 pt-1 text-[10.5px] font-medium text-muted-foreground/80">
                  {group.family}
                </div>
                <ul>
                  {group.items.map((m) => {
                    const active = selected === m.labelName
                    return (
                      <li key={m.labelName}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={active}
                          onClick={() => {
                            setSelected(m.labelName)
                            setOpen(false)
                          }}
                          className={
                            "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors duration-150 focus:outline-none " +
                            (active
                              ? "bg-secondary text-foreground"
                              : "text-foreground/90 hover:bg-secondary/60 focus:bg-secondary/60")
                          }
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {m.labelName}
                          </span>
                          {active ? (
                            <Check
                              className="h-3.5 w-3.5 flex-shrink-0 text-foreground"
                              aria-hidden
                              strokeWidth={2}
                            />
                          ) : null}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
