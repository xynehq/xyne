import { useEffect, useState } from "react"
import { ChevronRight, Brain } from "lucide-react"

type Props = {
  text: string
  pending?: boolean
}

const BRAILLE_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const

function BrailleLoader(): JSX.Element {
  const [frame, setFrame] = useState(0)
  useEffect((): (() => void) => {
    const id = window.setInterval((): void => {
      setFrame((x): number => (x + 1) % BRAILLE_FRAMES.length)
    }, 90)
    return (): void => {
      window.clearInterval(id)
    }
  }, [])
  return (
    <span
      aria-hidden
      className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center font-mono text-[15px] leading-none"
      style={{ color: "#E63946" }}
    >
      {BRAILLE_FRAMES[frame]}
    </span>
  )
}

export function ThinkingChip({ text, pending = false }: Props): JSX.Element {
  const [open, setOpen] = useState(false)

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
        {pending ? (
          <BrailleLoader />
        ) : (
          <Brain
            className="h-3 w-3 flex-shrink-0 text-muted-foreground"
            aria-hidden
            strokeWidth={1.75}
          />
        )}
        <span
          className={
            "text-foreground/80 " + (pending ? "animate-breathe" : "")
          }
        >
          {pending ? "Thinking…" : "Thought"}
        </span>
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
