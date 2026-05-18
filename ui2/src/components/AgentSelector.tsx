import { useEffect, useRef, useState } from "react"
import { Bot, Check, ChevronDown } from "lucide-react"
import { useAgents } from "@/lib/agents"

// Mirrors ModelSelector's shape so the composer's footer feels uniform. The
// "General agent" option is first-class — it puts vespa search back into
// KB-only mode (the user's own items, no shared docs).
export function AgentSelector(): JSX.Element {
  const { agents, selected, setSelected, loading } = useAgents()
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

  const active = selected
    ? (agents.find((a) => a.externalId === selected) ?? null)
    : null
  const label = loading ? "Loading…" : (active?.name ?? "General agent")

  // Hide the picker entirely when the workspace has no agents — there's
  // nothing meaningful to choose and the chip just adds noise.
  if (!loading && agents.length === 0) {
    return <span className="hidden" aria-hidden />
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v)
        }}
        disabled={loading}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          active?.description ||
          (active ? active.name : "General agent — KB-only mode")
        }
        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors duration-150 hover:bg-secondary/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Bot className="h-3.5 w-3.5 opacity-80" aria-hidden strokeWidth={1.75} />
        <span className="max-w-[14rem] truncate">{label}</span>
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
          aria-label="Agent"
          className="absolute bottom-full right-0 z-30 mb-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border bg-surface-elevated shadow-2xl"
        >
          <ul className="max-h-[40vh] overflow-y-auto py-1.5">
            <li>
              <button
                type="button"
                role="option"
                aria-selected={selected === null}
                onClick={() => {
                  setSelected(null)
                  setOpen(false)
                }}
                className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition hover:bg-secondary/70"
              >
                <span className="mt-[3px] inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-foreground">
                  {selected === null && (
                    <Check
                      className="h-3.5 w-3.5"
                      aria-hidden
                      strokeWidth={2.25}
                    />
                  )}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-[13px] font-medium text-foreground">
                    General agent
                  </span>
                  <span className="text-[11.5px] leading-snug text-muted-foreground">
                    Query only your own knowledge-base items.
                  </span>
                </span>
              </button>
            </li>
            {agents.map((a) => {
              const isActive = selected === a.externalId
              return (
                <li key={a.externalId}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onClick={() => {
                      setSelected(a.externalId)
                      setOpen(false)
                    }}
                    className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition hover:bg-secondary/70"
                  >
                    <span className="mt-[3px] inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-foreground">
                      {isActive && (
                        <Check
                          className="h-3.5 w-3.5"
                          aria-hidden
                          strokeWidth={2.25}
                        />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                        <span className="truncate">{a.name}</span>
                        {a.isPublic && (
                          <span className="rounded-full bg-secondary/70 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                            Public
                          </span>
                        )}
                      </span>
                      {a.description && (
                        <span className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
                          {a.description}
                        </span>
                      )}
                    </span>
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
