import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown, Sparkles, Zap } from "lucide-react"
import { useModels, type ModelFamily } from "@/lib/models"

const familyIcon: Record<ModelFamily, typeof Sparkles> = {
  Claude: Sparkles,
  GPT: Sparkles,
  Gemini: Sparkles,
  Other: Zap,
}

export function ModelSelector(): JSX.Element {
  const { models, selected, setSelected, groups, loading } = useModels()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect((): (() => void) => {
    const onDoc = (e: MouseEvent): void => {
      if (!rootRef.current) {
        return
      }
      if (!rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onDoc)
    return () => {
      document.removeEventListener("mousedown", onDoc)
    }
  }, [])

  const label = loading
    ? "Loading…"
    : selected ?? (models[0]?.labelName ?? "No models")

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v)
        }}
        disabled={loading || models.length === 0}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 text-[12.5px] font-medium text-foreground transition hover:border-ring disabled:cursor-not-allowed disabled:opacity-60"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="max-w-[14rem] truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
      </button>

      {open && groups.length > 0 && (
        <div
          role="listbox"
          aria-label="Model"
          className="absolute bottom-full right-0 z-30 mb-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border bg-surface-elevated shadow-2xl"
        >
          <ul className="max-h-[60vh] overflow-y-auto py-1.5">
            {groups.map((group) => {
              const Icon = familyIcon[group.family]
              return (
                <li key={group.family}>
                  <div className="flex items-center gap-2 px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    <Icon
                      className="h-3 w-3"
                      aria-hidden
                      strokeWidth={1.75}
                    />
                    <span>{group.family}</span>
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
                            className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition hover:bg-secondary/70"
                          >
                            <span className="mt-[3px] inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-foreground">
                              {active && (
                                <Check
                                  className="h-3.5 w-3.5"
                                  aria-hidden
                                  strokeWidth={2.25}
                                />
                              )}
                            </span>
                            <span className="flex min-w-0 flex-col">
                              <span className="text-[13px] font-medium text-foreground">
                                {m.labelName}
                              </span>
                              {m.description && (
                                <span className="text-[11.5px] leading-snug text-muted-foreground">
                                  {m.description}
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
