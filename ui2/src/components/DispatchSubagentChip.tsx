// DispatchSubagentChip — specialised tool chip for the parent's
// dispatchSubagent calls.
//
// Wraps the look + status semantics of ToolCallChip but, on expand,
// loads the nested run from the M8 endpoint and renders the
// sub-agent's full execution (thinking / inner tool_uses /
// assistant text) as a compact indented timeline. The chip resolves
// "which nested run does this represent?" by index — the Nth
// dispatchSubagent in a parent run corresponds to the Nth nested
// run, both ordered by startedAt server-side.

import { useEffect, useState } from "react"
import {
  AlertTriangle,
  ChevronRight,
  Check,
  Loader2,
  Bot,
} from "lucide-react"

import { ToolCallChip } from "./ToolCallChip"
import {
  loadNestedTrace,
  useNestedTrace,
  type NestedRunEntry,
} from "@/lib/nested-trace"
import type { Block } from "@/lib/chat-store"

type Props = {
  /** Tool call args from the parent's dispatchSubagent call. */
  args: unknown
  /** Tool result from the parent — what the parent LLM ultimately
   *  saw as the dispatch output. Optional because the chip can
   *  render before the parent's tool_result block has arrived
   *  (during live streaming). */
  result?: { output: unknown; isError: boolean }
  /** Conversation and parent-run identifiers needed to fetch the
   *  nested trace. Required — without these the chip can't resolve
   *  which sub-agent execution it represents. */
  conversationId: string
  parentRunId: string
  /** Position of THIS dispatchSubagent block among all
   *  dispatchSubagent blocks in the parent message. Matches the
   *  same-ordinal nested run from the API response. */
  dispatchIndex: number
}

const stringify = (v: unknown): string => {
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

export function DispatchSubagentChip({
  args,
  result,
  conversationId,
  parentRunId,
  dispatchIndex,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const trace = useNestedTrace(conversationId, parentRunId)

  // Lazy load on first expand. Subsequent opens reuse the cached
  // entry without a refetch.
  useEffect(() => {
    if (!open) return
    if (trace && trace.status !== "error") return
    void loadNestedTrace(conversationId, parentRunId)
  }, [open, trace, conversationId, parentRunId])

  // Status icon — pulled from the parent's tool_result, same as the
  // generic ToolCallChip. The nested run's status is shown inside the
  // expanded panel.
  const status: "running" | "done" | "error" = result
    ? result.isError
      ? "error"
      : "done"
    : "running"

  // Sub-agent name — extracted from args so the chip header is
  // informative ("dispatchSubagent → researcher") rather than just
  // a generic tool name. Args shape is {name, query} from the M7 tool.
  const subAgentName =
    args && typeof args === "object" && args !== null && "name" in args
      ? String((args as { name?: unknown }).name ?? "")
      : ""

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
        <span className="font-mono text-[12px] text-foreground/85">
          dispatchSubagent
        </span>
        {subAgentName && (
          <>
            <span className="text-muted-foreground/60">→</span>
            <span className="inline-flex items-center gap-1 font-mono text-[12px] font-medium text-primary">
              <Bot
                className="h-3 w-3"
                aria-hidden
                strokeWidth={1.75}
              />
              {subAgentName}
            </span>
          </>
        )}
        <span className="ml-auto inline-flex items-center text-muted-foreground">
          {status === "running" && (
            <Loader2
              className="h-3 w-3 animate-spin"
              aria-hidden
            />
          )}
          {status === "done" && (
            <Check
              className="h-3 w-3 text-foreground/60"
              aria-hidden
              strokeWidth={2.5}
            />
          )}
          {status === "error" && (
            <AlertTriangle
              className="h-3 w-3 text-destructive"
              aria-hidden
            />
          )}
        </span>
      </button>

      {open && (
        <div className="border-t border-border/60 bg-surface-muted/30">
          <Section title="Dispatched query">
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-foreground/85">
              {stringify(args)}
            </pre>
          </Section>
          <div className="mx-3 h-px bg-border/60" />
          <NestedTracePanel
            trace={trace}
            dispatchIndex={dispatchIndex}
            fallbackResult={result}
          />
        </div>
      )}
    </div>
  )
}

// ── Nested timeline ─────────────────────────────────────────────────────────

function NestedTracePanel({
  trace,
  dispatchIndex,
  fallbackResult,
}: {
  trace: ReturnType<typeof useNestedTrace>
  dispatchIndex: number
  fallbackResult?: { output: unknown; isError: boolean }
}): JSX.Element {
  if (!trace || trace.status === "loading") {
    return (
      <Section title="Sub-agent execution">
        <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground/80">
          <Loader2
            className="h-3 w-3 animate-spin"
            aria-hidden
          />
          Loading nested trace…
        </div>
      </Section>
    )
  }
  if (trace.status === "error") {
    return (
      <Section title="Sub-agent execution">
        <p className="text-[11.5px] text-destructive">
          Couldn't load the nested trace: {trace.error}
        </p>
        {fallbackResult && (
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-foreground/85">
            {stringify(fallbackResult.output)}
          </pre>
        )}
      </Section>
    )
  }
  const entry = trace.nestedRuns[dispatchIndex]
  if (!entry) {
    return (
      <Section title="Sub-agent execution">
        <p className="text-[11.5px] text-muted-foreground/80">
          Nested run not found at index {dispatchIndex}. The parent's tool
          call may have failed before persistence; the result above is
          what the parent saw.
        </p>
      </Section>
    )
  }
  return (
    <>
      <Section title="Sub-agent run">
        <RunHeader entry={entry} />
      </Section>
      <div className="mx-3 h-px bg-border/60" />
      <Section title="Sub-agent timeline">
        <NestedTimeline entry={entry} />
      </Section>
    </>
  )
}

function RunHeader({ entry }: { entry: NestedRunEntry }): JSX.Element {
  const { run } = entry
  const durationMs =
    typeof run.endedAt === "number" ? run.endedAt - run.startedAt : undefined
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
      <Meta label="status">
        <span
          className={
            run.status === "completed"
              ? "text-foreground"
              : run.status === "errored"
                ? "text-destructive"
                : "text-muted-foreground"
          }
        >
          {run.status}
        </span>
      </Meta>
      <Meta label="model">
        <span className="font-mono text-foreground">{run.model}</span>
      </Meta>
      {typeof run.tokensIn === "number" && (
        <Meta label="tokens in">
          <span className="font-mono tabular-nums text-foreground">
            {run.tokensIn}
          </span>
        </Meta>
      )}
      {typeof run.tokensOut === "number" && (
        <Meta label="tokens out">
          <span className="font-mono tabular-nums text-foreground">
            {run.tokensOut}
          </span>
        </Meta>
      )}
      {durationMs !== undefined && (
        <Meta label="duration">
          <span className="font-mono tabular-nums text-foreground">
            {formatDuration(durationMs)}
          </span>
        </Meta>
      )}
      {run.error && (
        <Meta label="error">
          <span className="text-destructive">{run.error}</span>
        </Meta>
      )}
    </div>
  )
}

function NestedTimeline({ entry }: { entry: NestedRunEntry }): JSX.Element {
  // Pair tool_use / tool_result for inner tool calls, same shape as
  // the parent's MessageBubble. Sub-agents are leaves so their
  // assistant messages don't contain dispatchSubagent calls.
  const items: Array<
    | { kind: "thinking"; text: string; key: string }
    | { kind: "text"; text: string; key: string }
    | {
        kind: "tool"
        toolName: string
        args: unknown
        result?: { output: unknown; isError: boolean }
        key: string
      }
  > = []
  for (const msg of entry.messages) {
    if (msg.role !== "assistant") continue
    const resultById = new Map<
      string,
      { output: unknown; isError: boolean }
    >()
    for (const b of msg.blocks) {
      if (b.kind === "tool_result") {
        resultById.set(b.toolCallId, { output: b.output, isError: b.isError })
      }
    }
    let i = 0
    for (const b of msg.blocks) {
      const key = `${msg.id}:${i++}`
      if (b.kind === "thinking") {
        items.push({ kind: "thinking", text: b.text, key })
      } else if (b.kind === "text") {
        items.push({ kind: "text", text: b.text, key })
      } else if (b.kind === "tool_use") {
        const r = resultById.get(b.toolCallId)
        items.push({
          kind: "tool",
          toolName: b.toolName,
          args: b.args,
          ...(r ? { result: r } : {}),
          key,
        })
      }
    }
  }
  if (items.length === 0) {
    return (
      <p className="text-[11.5px] italic text-muted-foreground/80">
        Sub-agent produced no recorded output.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2 border-l-2 border-border/70 pl-3">
      {items.map((it) => {
        if (it.kind === "thinking") {
          return (
            <div
              key={it.key}
              className="rounded-md bg-surface-muted/40 px-2 py-1.5 text-[11.5px] italic text-muted-foreground/90"
            >
              <div className="mb-0.5 text-[9.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                Thought
              </div>
              <div className="whitespace-pre-wrap leading-relaxed">
                {it.text}
              </div>
            </div>
          )
        }
        if (it.kind === "text") {
          return (
            <div
              key={it.key}
              className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/90"
            >
              {it.text}
            </div>
          )
        }
        return (
          <ToolCallChip
            key={it.key}
            name={it.toolName}
            args={it.args}
            {...(it.result ? { result: it.result } : {})}
          />
        )
      })}
    </div>
  )
}

// ── Tiny presentational helpers ─────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="px-3 py-2">
      <div className="pb-1 text-[9.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
        {title}
      </div>
      {children}
    </div>
  )
}

function Meta({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
        {label}
      </span>
      <span className="flex-1 text-right">{children}</span>
    </div>
  )
}

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s - m * 60)
  return `${m}m ${rem}s`
}

// Re-used for the args section.
const _ = stringify
