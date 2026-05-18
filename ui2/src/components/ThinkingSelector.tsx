import { useEffect, useRef, useState } from "react"
import { Brain, Check, ChevronDown } from "lucide-react"
import { THINKING_LEVELS, useThinking } from "@/lib/thinking"

export function ThinkingSelector(): JSX.Element {
  const { level, setLevel } = useThinking()
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

  const current = THINKING_LEVELS.find((l) => l.value === level)

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v)
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Thinking: ${current?.label ?? level}`}
        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors duration-150 hover:bg-secondary/60 hover:text-foreground"
      >
        <Brain className="h-3.5 w-3.5 opacity-80" aria-hidden strokeWidth={1.75} />
        <span>{current?.label ?? "Medium"}</span>
        <ChevronDown
          className={
            "h-3.5 w-3.5 opacity-60 transition-transform duration-150 " +
            (open ? "rotate-180" : "")
          }
          aria-hidden
          strokeWidth={1.75}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Thinking level"
          className="animate-fade-up absolute bottom-full right-0 z-30 mb-2 w-44 overflow-hidden rounded-xl border border-border bg-surface-elevated p-1 shadow-lg shadow-foreground/[0.06]"
        >
          <div className="px-2 pb-0.5 pt-1 text-[10.5px] font-medium text-muted-foreground/80">
            Thinking effort
          </div>
          <ul>
            {THINKING_LEVELS.map((l) => {
              const active = l.value === level
              return (
                <li key={l.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      setLevel(l.value)
                      setOpen(false)
                    }}
                    className={
                      "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors duration-150 focus:outline-none " +
                      (active
                        ? "bg-secondary text-foreground"
                        : "text-foreground/90 hover:bg-secondary/60 focus:bg-secondary/60")
                    }
                  >
                    <span className="min-w-0 flex-1 truncate">{l.label}</span>
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
        </div>
      )}
    </div>
  )
}
