import { useEffect, useRef, useState } from "react"
import { AlertTriangle, Check, ChevronRight, Loader2 } from "lucide-react"
import { displayName } from "./ToolCallChip"

import { DispatchSubagentChip } from "./DispatchSubagentChip"

export type ReasoningItem =
  | { kind: "thought"; text: string }
  | {
      kind: "tool"
      name: string
      args: unknown
      result?: { output: unknown; isError: boolean }
    }
  | {
      kind: "dispatch"
      args: unknown
      result?: { output: unknown; isError: boolean }
      conversationId: string
      parentRunId: string
      dispatchIndex: number
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

// Minimum duration a phase label stays on screen before flipping to the
// next one. Below ~1s phase changes read as jitter; ~1.5s matches NN/g
// and what Claude / Perplexity hold each step at.
const MIN_LABEL_DISPLAY_MS = 1500

// Tool-name → live label formatter. When a tool is mid-flight (no result
// yet) the chip swaps the generic thinking word for what the formatter
// returns. Each formatter takes the same `args` blob pi-mono ships, so the
// label can include the query / docId / etc. Unmapped tools fall back to
// "Running <name>".
type ToolLabelFormatter = (args: unknown) => string

// Pull a trimmed string field out of an unknown JSON-ish args blob, capped
// at `max` chars (with an ellipsis when truncated). Returns null when the
// field is missing or non-string so the formatter can degrade gracefully.
const pickStr = (obj: unknown, key: string, max = 48): string | null => {
  if (!obj || typeof obj !== "object") return null
  const v = (obj as Record<string, unknown>)[key]
  if (typeof v !== "string") return null
  const t = v.trim()
  if (!t) return null
  return t.length > max ? t.slice(0, max - 1) + "…" : t
}

const TOOL_LIVE_LABEL: Record<string, ToolLabelFormatter> = {
  vespaSearch: (a) => {
    const q = pickStr(a, "query")
    return q ? `Searching: ${q}` : "Searching"
  },
  getChunks: (a) => {
    const d = pickStr(a, "docId", 28)
    return d ? `Reading ${d}` : "Reading document"
  },
  searchWithinDoc: (a) => {
    const q = pickStr(a, "query")
    return q ? `Searching in doc: ${q}` : "Searching in document"
  },
  metadataSearch: () => "Looking up records",
  calculator: (a) => {
    const e = pickStr(a, "expression", 32)
    return e ? `Calculating ${e}` : "Calculating"
  },
  lookupFact: (a) => {
    const k = pickStr(a, "key", 20)
    return k ? `Looking up ${k}` : "Looking up a fact"
  },
  currentTime: () => "Checking the time",
  delegateToWriter: () => "Drafting with a sub-agent",
}

// Derive the chip label from the current reasoning trail. Every branch maps
// to an actual pi-mono state, not a random word: empty trail = waiting for
// the first event, in-flight tool = tool-specific label, just-finished tool
// = synthesizing on top of the result, and a streaming thought block = the
// model is still reasoning. No "Pondering" — those were lies dressed up as
// dynamism.
const phaseLabelFromItems = (items: ReasoningItem[]): string => {
  if (items.length === 0) return "Thinking"
  const last = items[items.length - 1]
  if (last?.kind === "tool") {
    if (!last.result) {
      const fmt = TOOL_LIVE_LABEL[last.name]
      return fmt ? fmt(last.args) : `Running ${displayName(last.name)}`
    }
    return "Analyzing results"
  }
  if (last?.kind === "thought") return "Reasoning"
  return "Thinking"
}

// Hold each label on-screen for at least MIN_LABEL_DISPLAY_MS before
// flipping to the next desired value. Coalesces rapid changes (a tool that
// runs in 200ms + the post-tool thought + the next tool dispatch could
// all happen in <1s) so the chip doesn't strobe. The most-recent desired
// value always wins; intermediate values are dropped on the floor.
function useStableLabel(desired: string): string {
  const [display, setDisplay] = useState(desired)
  const lockedUntilRef = useRef(0)
  const pendingTimeoutRef = useRef<number | null>(null)
  const desiredRef = useRef(desired)

  useEffect((): (() => void) | undefined => {
    desiredRef.current = desired
    if (desired === display) return
    const now = Date.now()
    if (now >= lockedUntilRef.current) {
      setDisplay(desired)
      lockedUntilRef.current = now + MIN_LABEL_DISPLAY_MS
      return
    }
    if (pendingTimeoutRef.current !== null) {
      window.clearTimeout(pendingTimeoutRef.current)
    }
    const wait = lockedUntilRef.current - now
    pendingTimeoutRef.current = window.setTimeout((): void => {
      setDisplay(desiredRef.current)
      lockedUntilRef.current = Date.now() + MIN_LABEL_DISPLAY_MS
      pendingTimeoutRef.current = null
    }, wait)
    return (): void => {
      // Don't cancel on re-run — the timeout owns the latest desiredRef.
    }
  }, [desired, display])

  useEffect((): (() => void) => {
    return (): void => {
      if (pendingTimeoutRef.current !== null) {
        window.clearTimeout(pendingTimeoutRef.current)
      }
    }
  }, [])

  return display
}

// Push-up text swap, opencode-style. When `text` changes we keep the previous
// value mounted for one animation cycle so old + new slide together: old
// translates up + fades out, new enters from below. `overflow-hidden` on the
// shell clips the off-stage halves.
function AnimatedLabel({ text }: { text: string }): JSX.Element {
  const [current, setCurrent] = useState(text)
  const [exiting, setExiting] = useState<string | null>(null)

  useEffect((): (() => void) | undefined => {
    if (text === current) return
    setExiting(current)
    setCurrent(text)
    const t = window.setTimeout((): void => {
      setExiting(null)
    }, 280)
    return (): void => {
      window.clearTimeout(t)
    }
  }, [text, current])

  return (
    <span
      className="relative inline-block overflow-hidden align-middle"
      style={{ height: "1.15em", lineHeight: "1.15" }}
    >
      {exiting !== null && (
        <span
          key={"out-" + exiting}
          className="animate-slide-up-out absolute left-0 top-0 inline-block whitespace-nowrap font-medium"
        >
          {exiting}
        </span>
      )}
      <span
        key={"in-" + current}
        className="animate-slide-up-in relative inline-block whitespace-nowrap font-medium"
      >
        {current}
      </span>
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

  const liveLabel = aggregated ? streamingNow : pending

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  useEffect((): void => {
    if (open) {
      stickToBottomRef.current = true
    }
  }, [open])
  useEffect((): void => {
    if (!open) return
    if (!liveLabel) return
    const el = bodyRef.current
    if (!el) return
    if (!stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [open, liveLabel, items])

  const onBodyScroll = (): void => {
    const el = bodyRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom < 20
  }

  const renderable = items.filter((it): boolean =>
    it.kind === "thought" ? it.text.length > 0 : true,
  )
  const hasContent = renderable.length > 0

  // Throttled by useStableLabel so the chip doesn't strobe through phases
  // that resolve faster than a user can read them.
  const stablePhase = useStableLabel(phaseLabelFromItems(items))
  const liveText = liveLabel ? `${stablePhase}…` : "Reasoning"

  return (
    <div className="my-1 text-[12.5px]">
      <button
        type="button"
        onClick={(): void => setOpen((v): boolean => !v)}
        aria-expanded={open}
        aria-label={liveLabel ? liveText : "Show reasoning"}
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
        {liveLabel && <BrailleLoader />}
        <span className="select-none">
          <AnimatedLabel text={liveText} />
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
              ) : it.kind === "dispatch" ? (
                <DispatchSubagentChip
                  args={it.args}
                  {...(it.result ? { result: it.result } : {})}
                  conversationId={it.conversationId}
                  parentRunId={it.parentRunId}
                  dispatchIndex={it.dispatchIndex}
                />
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
          {displayName(name)}
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
