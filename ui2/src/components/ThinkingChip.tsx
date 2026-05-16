import { useState } from "react"
import { ChevronRight, Brain, Loader2 } from "lucide-react"

type Props = {
  text: string
  pending?: boolean
}

export function ThinkingChip({ text, pending = false }: Props): JSX.Element {
  // Open while streaming so the user sees reasoning happen; collapse on done.
  const [open, setOpen] = useState(pending)

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/60 text-[12.5px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-surface-muted/60"
      >
        <ChevronRight
          className={
            "h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform " +
            (open ? "rotate-90" : "")
          }
          aria-hidden
        />
        <Brain
          className="h-3 w-3 flex-shrink-0 text-muted-foreground"
          aria-hidden
          strokeWidth={1.75}
        />
        <span className="text-foreground/80">
          {pending ? "Thinking…" : "Thought"}
        </span>
        {pending && (
          <Loader2
            className="ml-auto h-3 w-3 animate-spin text-muted-foreground"
            aria-hidden
          />
        )}
      </button>

      {open && text.length > 0 && (
        <div className="border-t border-border/60 bg-surface-muted/30 px-3 py-2">
          <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted-foreground">
            {text}
          </div>
        </div>
      )}
    </div>
  )
}
