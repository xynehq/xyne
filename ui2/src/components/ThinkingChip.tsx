import { useEffect, useRef, useState } from "react"
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Loader2,
  Sparkles,
} from "lucide-react"

export type ReasoningItem =
  | { kind: "thought"; text: string }
  | {
      kind: "tool"
      name: string
      args: unknown
      result?: { output: unknown; isError: boolean }
    }

type Props = {
  items: ReasoningItem[]
  pending?: boolean
  streaming?: boolean
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
      className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center font-mono text-[14px] leading-none text-foreground/70"
    >
      {BRAILLE_FRAMES[frame]}
    </span>
  )
}

export function ThinkingChip({
  items,
  pending = false,
  streaming,
}: Props): JSX.Element {
  const aggregated = streaming !== undefined
  const streamingNow = streaming ?? false
  const [open, setOpen] = useState(pending || streamingNow)
  const prevPending = useRef(pending)
  const prevStreaming = useRef(streamingNow)
  useEffect((): void => {
    if (pending && !prevPending.current) {
      setOpen(true)
    }
    if (aggregated) {
      if (prevStreaming.current && !streamingNow) {
        setOpen(false)
      }
    } else {
      if (prevPending.current && !pending) {
        setOpen(false)
      }
    }
    prevPending.current = pending
    prevStreaming.current = streamingNow
  }, [pending, streamingNow, aggregated])

  // While live, pin the panel to the latest tokens.
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  useEffect((): void => {
    if (!pending) return
    const el = bodyRef.current
    if (!el) return
    if (!stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [pending, items])

  const onBodyScroll = (): void => {
    const el = bodyRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom < 20
  }

  const renderable = items.filter((it): boolean =>
    it.kind === "tool" ? true : it.text.length > 0,
  )
  const hasContent = renderable.length > 0
  
  const liveLabel = aggregated ? streamingNow : pending

  return (
    <div className="my-1 text-[12.5px]">
      <button
        type="button"
        onClick={(): void => setOpen((v): boolean => !v)}
        aria-expanded={open}
        aria-label={liveLabel ? "Thinking" : "Show thoughts"}
        className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        <ChevronRight
          className={
            "h-3 w-3 flex-shrink-0 transition-transform duration-200 " +
            (open ? "rotate-90" : "")
          }
          aria-hidden
          strokeWidth={2}
        />
        {liveLabel ? (
          <BrailleLoader />
        ) : (
          <Sparkles
            className="h-3 w-3 flex-shrink-0"
            aria-hidden
            strokeWidth={1.75}
          />
        )}
        <span
          className={
            "select-none font-medium " + (liveLabel ? "animate-breathe" : "")
          }
        >
          {liveLabel ? "Thinking…" : "Thoughts"}
        </span>
      </button>

      {open && hasContent && (
        <div
          ref={bodyRef}
          onScroll={onBodyScroll}
          className="animate-fade-in ml-2 mt-1.5 max-h-80 overflow-y-auto overscroll-contain border-l-2 border-border/70 pl-3 pr-1"
        >
          {renderable.map((it, i): JSX.Element => (
            <div key={i}>
              {i > 0 && (
                <div
                  aria-hidden
                  className="my-3 h-px w-full bg-border/40"
                />
              )}
              {it.kind === "thought" ? (
                <div className="whitespace-pre-wrap leading-relaxed text-muted-foreground/90">
                  {it.text}
                </div>
              ) : (
                <ReasoningToolRow
                  name={it.name}
                  args={it.args}
                  {...(it.result ? { result: it.result } : {})}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

type ToolRowProps = {
  name: string
  args: unknown
  result?: { output: unknown; isError: boolean }
}

// Slim variant of ToolCallChip for use inside the Thoughts accordion. The
// outer accordion already provides the visual container (left border, padding,
// scroll), so this strips the bordered card treatment that the inline chip
// uses — otherwise we end up with box-in-box nesting that fights the panel.
function ReasoningToolRow({ name, args, result }: ToolRowProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const status: "running" | "done" | "error" = result
    ? result.isError
      ? "error"
      : "done"
    : "running"

  return (
    <div>
      <button
        type="button"
        onClick={(): void => setOpen((v): boolean => !v)}
        aria-expanded={open}
        className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        <ChevronRight
          className={
            "h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-200 " +
            (open ? "rotate-90" : "")
          }
          aria-hidden
          strokeWidth={2}
        />
        <span className="font-mono text-[11.5px] text-foreground/85">
          {name}
        </span>
        {status === "running" && (
          <Loader2
            className="h-3 w-3 animate-spin text-muted-foreground"
            aria-hidden
          />
        )}
        {status === "done" && (
          <Check
            className="h-3 w-3 text-foreground/50"
            aria-hidden
            strokeWidth={2.5}
          />
        )}
        {status === "error" && (
          <AlertTriangle className="h-3 w-3 text-destructive" aria-hidden />
        )}
      </button>

      {open && (
        <div className="ml-4 mt-1 overflow-hidden rounded-md border border-border/50 bg-surface-muted/40">
          <ToolSection label="Arguments">
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/85">
              {stringify(args)}
            </pre>
          </ToolSection>
          {result && (
            <>
              <div className="mx-2 h-px bg-border/50" />
              <ToolSection label="Result">
                <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/85">
                  {stringify(result.output)}
                </pre>
              </ToolSection>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ToolSection({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="px-2 py-1.5">
      <div className="pb-0.5 text-[9.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
        {label}
      </div>
      {children}
    </div>
  )
}

const stringify = (v: unknown): string => {
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
