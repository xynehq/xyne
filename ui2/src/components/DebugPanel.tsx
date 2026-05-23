// Collapsible "Debug" panel under each assistant message. Mirrors the
// Thoughts chip aesthetic so it sits naturally below the answer
// without adding a second visual language to the chat.
//
// Mounted only when the user's debugMode preference is on AND the
// assistant message has a runId. Lazy-renders the timeline body —
// the panel header (event count, LLM call count) is always cheap; the
// row list only realizes when the user expands it.
//
// Events arrive over the conversation's SSE stream and accumulate in
// the module-level debug-store. Refresh loses them: by design — no
// persistence.

import { useMemo, useState } from "react"
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  Send,
  Wrench,
  Zap,
} from "lucide-react"

import {
  getDebugEvents,
  useDebugEvents,
  type DebugEvent,
} from "@/lib/debug-store"
import { getConversationDump } from "@/lib/api"
import {
  openDebugDock,
  useDebugDock,
} from "@/lib/debug-dock-store"

type Props = {
  runId: string
  // Optional — when set, the panel renders a "Download conversation
  // dump" footer that pulls the full DB-backed snapshot from
  // /v2/chat/conversations/:id/dump.
  conversationId?: string
}

const STRINGIFY = (v: unknown): string => {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

// Pretty-print the time delta from the first event in the bucket so
// rows align in a tabular feel without absolute timestamps eating
// width. Returns "0.0s" / "1.2s" / "12.4s" / "1m 32s".
// Triggers a browser download of the full conversation dump fetched
// from /v2/chat/conversations/:id/dump. Kept module-local because
// the panel is the only caller — moving it into api.ts would split
// the URL.createObjectURL ceremony across files.
const downloadConversationDump = async (
  conversationId: string,
): Promise<void> => {
  try {
    const dump = await getConversationDump(conversationId)
    const blob = new Blob([JSON.stringify(dump, null, 2)], {
      type: "application/json",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `conversation-${conversationId}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch {
    // Best-effort UX — surfacing a toast here would couple the
    // panel to the toast module. The caller can re-click if needed.
  }
}

const formatOffset = (ms: number): string => {
  if (ms < 1000) return `${(ms / 1000).toFixed(2)}s`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s - m * 60)
  return `${String(m)}m ${String(rem)}s`
}

const eventTimestamp = (e: DebugEvent): number => {
  switch (e.kind) {
    case "request":
      return e.sentAt
    case "response":
      return e.receivedAt
    case "tool_call_start":
      return e.startedAt
    case "tool_call_end":
      // Best we can do without a separate `endedAt` — the start
      // event landed first; this row only ever follows it.
      return 0
    case "compaction_start":
    case "compaction_end":
      return e.at
    default:
      return 0
  }
}

// Short inline preview of a tool's args, shown next to the tool name in
// the row header so the operator can scan the timeline without
// expanding every row. We pick the most distinctive 1-2 fields:
//   - "query" / "q" / "text" / "name" / "id" / "url" — string scalars
//   - first string scalar otherwise
//   - then a numeric scalar (limit / topK / pageNumber / etc.)
// Long strings get ellipsized at 40 chars. Returns empty when the args
// aren't an object or have nothing scannable.
const PREFERRED_STRING_KEYS = [
  "query",
  "q",
  "text",
  "prompt",
  "name",
  "id",
  "url",
  "path",
  "itemId",
  "messageId",
  "toolName",
]
const PREFERRED_NUMBER_KEYS = [
  "topK",
  "limit",
  "pageNumber",
  "page",
  "maxResults",
  "n",
]

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : s.slice(0, n - 1) + "…"

const formatArgsInline = (args: unknown): string => {
  if (!args || typeof args !== "object" || Array.isArray(args)) return ""
  const obj = args as Record<string, unknown>
  const parts: string[] = []
  // First, scan preferred string keys in order so the most useful one
  // wins. Fallback to the first string scalar encountered.
  let firstString: { k: string; v: string } | null = null
  for (const k of PREFERRED_STRING_KEYS) {
    const v = obj[k]
    if (typeof v === "string" && v.length > 0) {
      firstString = { k, v }
      break
    }
  }
  if (!firstString) {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && v.length > 0) {
        firstString = { k, v }
        break
      }
    }
  }
  if (firstString) {
    parts.push(`${firstString.k}: "${truncate(firstString.v, 40)}"`)
  }
  for (const k of PREFERRED_NUMBER_KEYS) {
    const v = obj[k]
    if (typeof v === "number") {
      parts.push(`${k}=${String(v)}`)
      break
    }
  }
  return parts.join(", ")
}

// Side data attached per-row by DebugTimeline so a row can show
// information that requires looking at sibling events. Right now this
// is only used to pair compaction_end with its preceding
// compaction_start so we can render `tokensBefore → tokensAfter (Δ)`
// in both the header chip and the expanded section.
type RowExtra = {
  compactionPairedStart?: {
    tokensBefore?: number
    at: number
    reason: string
  }
  // Only set on agent_end rows. Lets the row render a roll-up of
  // failed tools at the bottom of the timeline without re-walking
  // the events list at render time.
  failedTools?: { toolName: string; toolCallId: string }[]
}

// Format a token count compactly: 1234 → "1.2k", 12345 → "12.3k",
// 1234567 → "1.23M". Sub-thousands stay as plain integers.
const formatTokens = (n: number): string => {
  if (!Number.isFinite(n)) return String(n)
  if (Math.abs(n) < 1000) return String(n)
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

// Heuristic: probe a tool result for a chunk/hit count we can surface
// in the row label. xyne's tools wrap their structured output as
// `{ content, details: {...} }`, so we look inside `details` first.
// Falls back to scanning the top level if the envelope isn't there.
//
// Order matters — `hits` wins over `results` so `vespaSearch` reports
// "8 hits" instead of the generic "8 results", and `total_chunks`
// (the full doc length) wins over `returned` (the slice we got back)
// only when no array key matched.
const CHUNK_ARRAY_KEYS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "hits", label: "hits" },
  { key: "chunks", label: "chunks" },
  { key: "results", label: "results" },
  { key: "documents", label: "docs" },
  { key: "items", label: "items" },
  { key: "matches", label: "matches" },
]
const CHUNK_COUNT_KEYS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "returned", label: "returned" },
  { key: "total_chunks", label: "chunks" },
  { key: "count", label: "results" },
  { key: "total", label: "total" },
]

const countChunks = (
  result: unknown,
): { count: number; label: string } | null => {
  if (Array.isArray(result)) {
    return { count: result.length, label: "items" }
  }
  if (!result || typeof result !== "object") return null
  const obj = result as Record<string, unknown>
  // Pi-mono ToolReturn envelope. `details` carries the structured
  // result; the top-level only has `content` (text) + `isError`.
  const inner =
    obj["details"] && typeof obj["details"] === "object"
      ? (obj["details"] as Record<string, unknown>)
      : obj
  for (const { key, label } of CHUNK_ARRAY_KEYS) {
    const v = inner[key]
    if (Array.isArray(v)) return { count: v.length, label }
  }
  for (const { key, label } of CHUNK_COUNT_KEYS) {
    const v = inner[key]
    if (typeof v === "number") return { count: v, label }
  }
  return null
}

// Picks the row's leading glyph + a short label. Color is muted by
// default so the chip stays calm; only failures / agent_end pop.
const headerFor = (
  e: DebugEvent,
  extra: RowExtra = {},
): { Icon: typeof Bug; label: string; tone: string } => {
  switch (e.kind) {
    case "request":
      return {
        Icon: Send,
        label: `LLM call #${String(e.llmCall)} → ${e.model}`,
        tone: "text-muted-foreground",
      }
    case "response":
      return {
        Icon: Zap,
        label: `LLM call #${String(e.llmCall)} ← ${e.stopReason ?? "response"}${e.tokenUsage ? ` · ${String(e.tokenUsage.output)} out` : ""}`,
        tone: "text-muted-foreground",
      }
    case "tool_call_start": {
      const preview = formatArgsInline(e.args)
      return {
        Icon: Wrench,
        label: preview
          ? `${e.toolName}(${preview})`
          : `${e.toolName}()`,
        tone: "text-muted-foreground",
      }
    }
    case "tool_call_end": {
      const chunks = e.isError ? null : countChunks(e.result)
      const chunkSuffix = chunks
        ? ` · ${String(chunks.count)} ${chunks.label}`
        : ""
      return {
        Icon: Wrench,
        label: `${e.toolName} ← ${e.isError ? "errored" : `done in ${formatOffset(e.durationMs)}`}${chunkSuffix}`,
        tone: e.isError ? "text-destructive" : "text-muted-foreground",
      }
    }
    case "compaction_start": {
      const before =
        e.tokensBefore !== undefined ? ` · ${formatTokens(e.tokensBefore)} in ctx` : ""
      return {
        Icon: Zap,
        label: `compaction start · ${e.reason}${before}`,
        tone: "text-foreground",
      }
    }
    case "compaction_end": {
      if (e.aborted) {
        return {
          Icon: Zap,
          label: "compaction end · aborted",
          tone: "text-destructive",
        }
      }
      const before = extra.compactionPairedStart?.tokensBefore
      const after = e.tokensAfter
      if (typeof before === "number" && typeof after === "number") {
        const delta = after - before
        const sign = delta <= 0 ? "−" : "+"
        const deltaStr = `${sign}${formatTokens(Math.abs(delta))}`
        return {
          Icon: Zap,
          label: `compaction end · ${formatTokens(before)} → ${formatTokens(after)} (${deltaStr})`,
          tone: "text-foreground",
        }
      }
      if (typeof after === "number") {
        return {
          Icon: Zap,
          label: `compaction end · ${formatTokens(after)} in ctx`,
          tone: "text-foreground",
        }
      }
      return {
        Icon: Zap,
        label: "compaction end",
        tone: "text-foreground",
      }
    }
    case "agent_end": {
      const u = e.tokenUsage
      // Total context delivered to the model across all LLM calls of
      // the run = uncached input + cache-read (what the model
      // actually saw). cacheWrite is creation tokens, billed
      // separately, so it goes in its own slot.
      const ctx = (u?.input ?? 0) + (u?.cacheRead ?? 0)
      const out = u?.output ?? 0
      const cacheW = u?.cacheWrite ?? 0
      const failed = extra.failedTools?.length ?? 0
      const parts = [
        `ctx ${formatTokens(ctx)}`,
        `out ${formatTokens(out)}`,
      ]
      if (cacheW > 0) parts.push(`cache+ ${formatTokens(cacheW)}`)
      if (failed > 0) parts.push(`${String(failed)} failed`)
      return {
        Icon: CheckCircle2,
        label: `agent end · ${e.stopReason} · ${formatOffset(e.durationMs)} · ${parts.join(" · ")}`,
        tone: failed > 0 ? "text-destructive" : "text-foreground",
      }
    }
    case "error":
      return {
        Icon: AlertTriangle,
        label: `error · ${e.message.slice(0, 80)}`,
        tone: "text-destructive",
      }
  }
}

// Structured renderer for arbitrary args/results. Renders an object as
// a vertical list of `key: value` rows with type-aware formatting:
//   - strings: quoted, multi-line if they contain newlines, "Show all"
//     toggle past 200 chars
//   - numbers / booleans / null: inline accent color
//   - arrays: "[N items]" header, items inlined when small primitives,
//     nested PrettyValue for objects
//   - objects: nested indent, collapsible past 6 keys
// The goal is a JSON-shaped view that's actually scannable — the raw
// JSON toggle remains for when you need the exact bytes.

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

function PrettyString({ value }: { value: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const multiline = value.includes("\n")
  const long = value.length > 200
  if (multiline || long) {
    const shown = expanded || !long ? value : value.slice(0, 200) + "…"
    return (
      <span>
        <pre className="mt-0.5 whitespace-pre-wrap break-words rounded-md border border-border/40 bg-surface-muted/30 px-2 py-1 font-mono text-[11px] leading-relaxed text-foreground/85">
          {shown}
        </pre>
        {long && (
          <button
            type="button"
            onClick={(): void => setExpanded((v) => !v)}
            className="mt-0.5 inline-flex h-5 items-center rounded-md px-1.5 text-[10.5px] text-muted-foreground transition hover:text-foreground"
          >
            {expanded ? "Show less" : `Show all (${String(value.length)} chars)`}
          </button>
        )}
      </span>
    )
  }
  return (
    <span className="font-mono text-[11px] text-foreground/85">
      &quot;{value}&quot;
    </span>
  )
}

function PrettyScalar({ value }: { value: unknown }): JSX.Element {
  if (value === null) {
    return <span className="font-mono text-[11px] text-muted-foreground/70">null</span>
  }
  if (typeof value === "boolean") {
    return (
      <span className="font-mono text-[11px] text-[hsl(var(--primary))]">
        {value ? "true" : "false"}
      </span>
    )
  }
  if (typeof value === "number") {
    return (
      <span className="font-mono text-[11px] text-[hsl(var(--primary))] tabular-nums">
        {String(value)}
      </span>
    )
  }
  if (typeof value === "string") {
    return <PrettyString value={value} />
  }
  return (
    <span className="font-mono text-[11px] text-muted-foreground">
      {STRINGIFY(value)}
    </span>
  )
}

function PrettyValue({
  value,
  depth = 0,
}: {
  value: unknown
  depth?: number
}): JSX.Element {
  // Object — render as definition list. Many small keys → collapse.
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) {
      return (
        <span className="font-mono text-[11px] text-muted-foreground/70">{"{}"}</span>
      )
    }
    return (
      <div className={depth === 0 ? "space-y-1" : "ml-2 space-y-0.5 border-l border-border/40 pl-2"}>
        {entries.map(([k, v]) => (
          <div
            key={k}
            className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2"
          >
            <span className="flex-shrink-0 font-mono text-[10.5px] font-medium text-muted-foreground/80">
              {k}
            </span>
            <div className="min-w-0 flex-1">
              <PrettyValue value={v} depth={depth + 1} />
            </div>
          </div>
        ))}
      </div>
    )
  }
  // Array — count + each item indented.
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <span className="font-mono text-[11px] text-muted-foreground/70">[]</span>
      )
    }
    const allScalar = value.every(
      (v): boolean =>
        v === null ||
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean",
    )
    if (allScalar && value.length <= 12) {
      // Render as inline comma-separated.
      return (
        <div className="flex flex-wrap items-baseline gap-1.5">
          <span className="font-mono text-[10.5px] text-muted-foreground/60">
            [{String(value.length)}]
          </span>
          {value.map((v, i) => (
            <PrettyScalar key={i} value={v} />
          ))}
        </div>
      )
    }
    return (
      <div className="space-y-1">
        <div className="font-mono text-[10.5px] text-muted-foreground/60">
          [{String(value.length)} items]
        </div>
        <div className="space-y-1 border-l border-border/40 pl-2">
          {value.map((v, i) => (
            <div key={i} className="flex items-baseline gap-2">
              <span className="flex-shrink-0 font-mono text-[10px] text-muted-foreground/50 tabular-nums">
                {String(i)}
              </span>
              <div className="min-w-0 flex-1">
                <PrettyValue value={v} depth={depth + 1} />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }
  return <PrettyScalar value={value} />
}

// Wraps PrettyValue with a "raw" toggle so the operator can switch to
// exact JSON when something looks wrong in the structured view.
function ValueWithRawToggle({ value }: { value: unknown }): JSX.Element {
  const [raw, setRaw] = useState(false)
  return (
    <div>
      <div className="mb-1 flex justify-end">
        <button
          type="button"
          onClick={(): void => setRaw((v) => !v)}
          className="inline-flex h-5 items-center rounded-md px-1.5 text-[10px] text-muted-foreground transition hover:text-foreground"
        >
          {raw ? "Pretty" : "Raw JSON"}
        </button>
      </div>
      {raw ? <CodeBlock value={value} /> : <PrettyValue value={value} />}
    </div>
  )
}

// Tiny inline JSON viewer that copies its contents to the clipboard on
// click. No syntax highlighting — chat is already busy enough; the
// monospace block is enough to scan structures.
function CodeBlock({ value }: { value: unknown }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const text = useMemo(() => STRINGIFY(value), [value])
  return (
    <div className="relative">
      <pre className="max-h-72 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-surface-muted/40 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/85">
        {text}
      </pre>
      <button
        type="button"
        onClick={(): void => {
          void navigator.clipboard.writeText(text).then((): void => {
            setCopied(true)
            window.setTimeout((): void => setCopied(false), 1400)
          })
        }}
        className="absolute right-1.5 top-1.5 inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background/80 px-1.5 text-[10px] text-muted-foreground transition hover:text-foreground"
        aria-label="Copy JSON"
        title="Copy JSON"
      >
        <Copy className="h-3 w-3" aria-hidden strokeWidth={1.75} />
        {copied ? "copied" : "copy"}
      </button>
    </div>
  )
}

// One row in the timeline. Click to expand → renders any payload-shaped
// fields as code blocks below the header line.
function EventRow({
  event,
  offset,
  extra,
}: {
  event: DebugEvent
  offset: number
  extra?: RowExtra
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const rowExtra = extra ?? {}
  const { Icon, label, tone } = headerFor(event, rowExtra)
  const expandable = hasDetails(event)
  return (
    <div className="border-l-2 border-border/60 pl-2.5">
      <button
        type="button"
        onClick={(): void => {
          if (expandable) setOpen((v) => !v)
        }}
        aria-expanded={open}
        className={
          "flex w-full items-center gap-2 rounded-md py-1 text-left transition " +
          (expandable
            ? "cursor-pointer hover:bg-secondary/40"
            : "cursor-default")
        }
      >
        {expandable ? (
          <ChevronRight
            className={
              "h-3 w-3 flex-shrink-0 text-muted-foreground/70 transition-transform " +
              (open ? "rotate-90" : "")
            }
            aria-hidden
            strokeWidth={2}
          />
        ) : (
          <span aria-hidden className="h-3 w-3 flex-shrink-0" />
        )}
        <Icon
          className={"h-3 w-3 flex-shrink-0 " + tone}
          aria-hidden
          strokeWidth={1.75}
        />
        <span className={"truncate font-mono text-[11.5px] " + tone}>
          {label}
        </span>
        <span className="ml-auto flex-shrink-0 font-mono text-[10.5px] text-muted-foreground/60">
          +{formatOffset(offset)}
        </span>
      </button>
      {open && expandable && (
        <div className="mt-1 space-y-1.5 pb-1">{renderDetails(event, rowExtra)}</div>
      )}
    </div>
  )
}

const hasDetails = (e: DebugEvent): boolean => {
  switch (e.kind) {
    case "request":
      return e.payload !== undefined || true // sampler + systemPromptChars always there
    case "response":
      return e.text !== undefined || e.tokenUsage !== undefined
    case "tool_call_start":
      return true
    case "tool_call_end":
      return e.result !== undefined || e.isError
    case "compaction_start":
    case "compaction_end":
      return true
    case "agent_end":
      return true
    case "error":
      return true
  }
}

const renderDetails = (e: DebugEvent, extra: RowExtra = {}): JSX.Element[] => {
  const out: JSX.Element[] = []
  if (e.kind === "request") {
    out.push(
      <Section key="meta" title="Metadata">
        <CodeBlock
          value={{
            model: e.model,
            sampler: e.sampler,
            systemPromptChars: e.systemPromptChars,
          }}
        />
      </Section>,
    )
    if (e.payload !== undefined) {
      out.push(
        <Section key="payload" title="Request payload">
          <CodeBlock value={e.payload} />
        </Section>,
      )
    }
  } else if (e.kind === "response") {
    if (e.tokenUsage) {
      out.push(
        <Section key="usage" title="Tokens">
          <CodeBlock
            value={{
              ...(e.stopReason ? { stopReason: e.stopReason } : {}),
              tokenUsage: e.tokenUsage,
            }}
          />
        </Section>,
      )
    }
    if (e.text !== undefined) {
      out.push(
        <Section key="text" title="Response text">
          <CodeBlock value={e.text} />
        </Section>,
      )
    }
  } else if (e.kind === "tool_call_start") {
    out.push(
      <Section key="args" title="Args">
        <ValueWithRawToggle value={e.args} />
      </Section>,
    )
  } else if (e.kind === "tool_call_end" && e.result !== undefined) {
    out.push(
      <Section key="result" title={e.isError ? "Error" : "Result"}>
        <ValueWithRawToggle value={e.result} />
      </Section>,
    )
  } else if (e.kind === "compaction_start") {
    out.push(
      <Section key="summary" title="Compaction trigger">
        <PrettyValue
          value={{
            reason: e.reason,
            ...(e.tokensBefore !== undefined
              ? { tokensBefore: e.tokensBefore }
              : {}),
          }}
        />
      </Section>,
    )
  } else if (e.kind === "compaction_end") {
    const before = extra.compactionPairedStart?.tokensBefore
    const after = e.tokensAfter
    const durationMs = extra.compactionPairedStart
      ? Math.max(0, e.at - extra.compactionPairedStart.at)
      : undefined
    const summary: Record<string, unknown> = { aborted: e.aborted }
    if (typeof before === "number") summary["tokensBefore"] = before
    if (typeof after === "number") summary["tokensAfter"] = after
    if (typeof before === "number" && typeof after === "number") {
      summary["tokensFreed"] = before - after
    }
    if (durationMs !== undefined) summary["durationMs"] = durationMs
    out.push(
      <Section key="summary" title="Compaction result">
        <PrettyValue value={summary} />
      </Section>,
    )
  } else if (e.kind === "agent_end") {
    const u = e.tokenUsage
    const totalContext = (u?.input ?? 0) + (u?.cacheRead ?? 0)
    const totalBilled =
      (u?.input ?? 0) +
      (u?.cacheRead ?? 0) +
      (u?.cacheWrite ?? 0) +
      (u?.output ?? 0)
    out.push(
      <Section key="totals" title="Run totals">
        <PrettyValue
          value={{
            stopReason: e.stopReason,
            durationMs: e.durationMs,
            inputTokens: u?.input ?? 0,
            cacheReadTokens: u?.cacheRead ?? 0,
            cacheWriteTokens: u?.cacheWrite ?? 0,
            outputTokens: u?.output ?? 0,
            totalContextFilled: totalContext,
            totalTokensBilled: totalBilled,
          }}
        />
      </Section>,
    )
    if (extra.failedTools && extra.failedTools.length > 0) {
      out.push(
        <Section key="failed" title={`Failed tools (${String(extra.failedTools.length)})`}>
          <div className="flex flex-wrap gap-1.5">
            {extra.failedTools.map((t) => (
              <span
                key={t.toolCallId}
                className="inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-0.5 font-mono text-[11px] text-destructive"
                title={t.toolCallId}
              >
                <AlertTriangle className="h-3 w-3" aria-hidden strokeWidth={1.75} />
                {t.toolName}
              </span>
            ))}
          </div>
        </Section>,
      )
    }
  } else if (e.kind === "error") {
    out.push(
      <Section key="error" title="Error">
        <CodeBlock value={e} />
      </Section>,
    )
  }
  return out
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div>
      <div className="mb-0.5 pl-1 text-[9.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
        {title}
      </div>
      {children}
    </div>
  )
}

// Inline summary chip that lives under an assistant message. Renders a
// "Debug · N LLM calls · M events" pill which, when clicked, opens the
// right-side DebugDock pinned to this run. No timeline body here — the
// dock owns the body now so the chat column stays narrow.
export function DebugChip({
  runId,
  conversationId,
}: Props): JSX.Element | null {
  const events = useDebugEvents(runId)
  const dock = useDebugDock()
  const summary = useMemo(() => {
    let llmCalls = 0
    for (const e of events) {
      if (e.kind === "request" && e.llmCall > llmCalls) {
        llmCalls = e.llmCall
      }
    }
    return { llmCalls, count: events.length }
  }, [events])

  if (events.length === 0) return null

  const active = dock.runId === runId && !dock.collapsed
  return (
    <div className="my-1 text-[12.5px]">
      <button
        type="button"
        onClick={(): void => {
          openDebugDock(runId, conversationId ?? null)
        }}
        aria-pressed={active}
        aria-label={active ? "Debug panel open" : "Open debug panel"}
        className={
          "-ml-1 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background " +
          (active
            ? "bg-secondary text-foreground"
            : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground")
        }
      >
        <Bug className="h-3 w-3 flex-shrink-0" aria-hidden strokeWidth={1.75} />
        <span className="select-none font-medium">Debug</span>
        <span className="text-muted-foreground/60">
          · {String(summary.llmCalls)} LLM call{summary.llmCalls === 1 ? "" : "s"}
          {" · "}
          {String(summary.count)} event{summary.count === 1 ? "" : "s"}
        </span>
      </button>
    </div>
  )
}

// Body of the dock — pure timeline. Pulled out so the panel chrome
// (header, resize handle) is decoupled from the event rendering.
export function DebugTimeline({
  runId,
  conversationId,
}: Props): JSX.Element {
  const events = useDebugEvents(runId)
  if (events.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[12.5px] text-muted-foreground">
        Waiting for events…
      </div>
    )
  }
  const firstAt = eventTimestamp(events[0]!) || Date.now()
  // Pair each compaction_end with its preceding unmatched
  // compaction_start so the row can render `before → after (Δ)`.
  // Walk once; index by event position. Out-of-order or
  // unmatched events get an empty extra and fall back to the
  // single-event header.
  const extras: RowExtra[] = events.map(() => ({}))
  {
    const pendingStarts: number[] = []
    const failedTools: { toolName: string; toolCallId: string }[] = []
    let agentEndIdx = -1
    events.forEach((e, i) => {
      if (e.kind === "compaction_start") {
        pendingStarts.push(i)
      } else if (e.kind === "compaction_end") {
        const startIdx = pendingStarts.pop()
        if (startIdx !== undefined) {
          const start = events[startIdx]
          if (start && start.kind === "compaction_start") {
            extras[i] = {
              compactionPairedStart: {
                ...(start.tokensBefore !== undefined
                  ? { tokensBefore: start.tokensBefore }
                  : {}),
                at: start.at,
                reason: start.reason,
              },
            }
          }
        }
      } else if (e.kind === "tool_call_end" && e.isError) {
        failedTools.push({ toolName: e.toolName, toolCallId: e.toolCallId })
      } else if (e.kind === "agent_end") {
        agentEndIdx = i
      }
    })
    if (agentEndIdx >= 0 && failedTools.length > 0) {
      extras[agentEndIdx] = {
        ...extras[agentEndIdx],
        failedTools,
      }
    }
  }
  const downloadEvents = (): void => {
    const snapshot = getDebugEvents(runId)
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: "application/json",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `debug-${runId}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
        {events.map((e, i) => (
          <EventRow
            key={i}
            event={e}
            offset={Math.max(0, eventTimestamp(e) - firstAt)}
            {...(extras[i] && Object.keys(extras[i]).length > 0
              ? { extra: extras[i] }
              : {})}
          />
        ))}
      </div>
      <div className="flex justify-end gap-2 border-t border-border bg-surface-muted/30 px-3 py-2">
        {conversationId && (
          <button
            type="button"
            onClick={(): void => {
              void downloadConversationDump(conversationId)
            }}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[11px] text-muted-foreground transition hover:text-foreground"
            title="Full DB snapshot: conversation + every message (incl. sub-agent runs) + every run + every tool call"
          >
            <Download className="h-3 w-3" aria-hidden strokeWidth={1.75} />
            Conversation dump
          </button>
        )}
        <button
          type="button"
          onClick={downloadEvents}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[11px] text-muted-foreground transition hover:text-foreground"
        >
          <Download className="h-3 w-3" aria-hidden strokeWidth={1.75} />
          events.json
        </button>
      </div>
    </div>
  )
}

// Kept as an alias for any older imports — DebugChip is the new name.
export const DebugPanel = DebugChip
