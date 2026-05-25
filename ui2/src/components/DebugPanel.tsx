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

import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  Expand,
  Send,
  Wrench,
  X,
  Zap,
} from "lucide-react"

import {
  getDebugEvents,
  seedDebugEvents,
  useDebugEvents,
  type DebugEvent,
} from "@/lib/debug-store"
import {
  getConversationDump,
  // Aliased to avoid colliding with the debug-store's getDebugEvents
  // (the store one reads the in-memory bucket; this one hits the API).
  getDebugEvents as fetchPersistedDebugEvents,
} from "@/lib/api"
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
    case "mid_turn_stop":
    case "retry_attempt":
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
  // Only set on agent_end rows. Largest single-call context usage
  // (input + cacheRead) observed across this run. The agent_end's
  // own tokenUsage is the SUM across calls — that's billing input,
  // not the per-call window load.
  peakCallContext?: number
  llmCallCount?: number
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
    case "response": {
      // Per-call ctx = input + cacheRead — this is the context that
      // was fed to the model on THIS call. Each successive call sees
      // a bigger context as history grows, so this row-by-row value
      // is "context used at this point in the run".
      const u = e.tokenUsage
      const callCtx = u ? (u.input ?? 0) + (u.cacheRead ?? 0) : 0
      const parts: string[] = [e.stopReason ?? "response"]
      if (u) {
        if (callCtx > 0) parts.push(`ctx ${formatTokens(callCtx)}`)
        parts.push(`${formatTokens(u.output ?? 0)} out`)
      }
      return {
        Icon: Zap,
        label: `LLM call #${String(e.llmCall)} ← ${parts.join(" · ")}`,
        tone: "text-muted-foreground",
      }
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
      const out = u?.output ?? 0
      const failed = extra.failedTools?.length ?? 0
      const peak = extra.peakCallContext ?? 0
      const calls = extra.llmCallCount ?? 0
      const parts: string[] = []
      // max ctx = largest single-call (input + cacheRead) observed.
      // Per-call ctx is on each response row.
      if (peak > 0) parts.push(`max ctx ${formatTokens(peak)}`)
      parts.push(`out ${formatTokens(out)}`)
      if (calls > 0) parts.push(`${String(calls)} calls`)
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
    case "mid_turn_stop":
      return {
        Icon: Zap,
        label: `mid-turn stop · ctx ${formatTokens(e.contextTokens)} / ${formatTokens(e.contextWindow)} (reserve ${formatTokens(e.reserveTokens)})`,
        tone: "text-foreground",
      }
    case "retry_attempt": {
      if (e.phase === "start") {
        return {
          Icon: AlertTriangle,
          label: `retry start · attempt ${String(e.attempt)}${e.maxAttempts ? ` / ${String(e.maxAttempts)}` : ""}${e.errorMessage ? ` · ${e.errorMessage.slice(0, 60)}` : ""}`,
          tone: "text-destructive",
        }
      }
      const success = e.success ?? false
      return {
        Icon: success ? CheckCircle2 : AlertTriangle,
        label: `retry end · attempt ${String(e.attempt)}${success ? " · succeeded" : ` · failed${e.errorMessage ? ` · ${e.errorMessage.slice(0, 60)}` : ""}`}`,
        tone: success ? "text-foreground" : "text-destructive",
      }
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

// One key:value row inside a PrettyValue object. When the value is
// itself an object/array, the row gets a chevron toggle so it can
// be collapsed/expanded independently.
function PrettyEntry({
  label,
  value,
  depth,
}: {
  label: string
  value: unknown
  depth: number
}): JSX.Element {
  const collapsible = isPlainObject(value) || Array.isArray(value)
  const [open, setOpen] = useState(true)
  const summary = collapsible
    ? Array.isArray(value)
      ? `[${String(value.length)} item${value.length === 1 ? "" : "s"}]`
      : `{${String(Object.keys(value as Record<string, unknown>).length)} keys}`
    : null
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
      <div className="flex flex-shrink-0 items-baseline gap-1">
        {collapsible && (
          <button
            type="button"
            onClick={(): void => setOpen((v) => !v)}
            className="inline-flex h-3 w-3 items-center justify-center text-muted-foreground/70 hover:text-foreground"
            title={open ? "Collapse" : "Expand"}
          >
            <ChevronRight
              className={"h-3 w-3 transition-transform " + (open ? "rotate-90" : "")}
              aria-hidden
              strokeWidth={2}
            />
          </button>
        )}
        <span className="font-mono text-[10.5px] font-medium text-muted-foreground/80">
          {label}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        {collapsible && !open ? (
          <button
            type="button"
            onClick={(): void => setOpen(true)}
            className="font-mono text-[10.5px] text-muted-foreground/60 hover:text-foreground"
          >
            {summary}
          </button>
        ) : (
          <PrettyValue value={value} depth={depth + 1} />
        )}
      </div>
    </div>
  )
}

// Array with a chevron header so the whole list can be collapsed.
function PrettyArray({
  value,
  depth,
}: {
  value: unknown[]
  depth: number
}): JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={(): void => setOpen((v) => !v)}
        className="inline-flex items-baseline gap-1 font-mono text-[10.5px] text-muted-foreground/60 hover:text-foreground"
      >
        <ChevronRight
          className={"h-3 w-3 transition-transform " + (open ? "rotate-90" : "")}
          aria-hidden
          strokeWidth={2}
        />
        [{String(value.length)} item{value.length === 1 ? "" : "s"}]
      </button>
      {open && (
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
      )}
    </div>
  )
}

function PrettyValue({
  value,
  depth = 0,
}: {
  value: unknown
  depth?: number
}): JSX.Element {
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
          <PrettyEntry key={k} label={k} value={v} depth={depth} />
        ))}
      </div>
    )
  }
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
    return <PrettyArray value={value} depth={depth} />
  }
  return <PrettyScalar value={value} />
}

// Renders xyne's ToolReturn envelope { content, details, isError }
// as separated cards:
//   - the LLM-facing text ("model sees" — what was actually inlined
//     into the next user message)
//   - the structured details, with array-of-objects (search hits,
//     chunks) rendered as cards rather than a flat tree
// Anything that doesn't match the envelope falls back to PrettyValue.
function ToolResultPretty({ value }: { value: unknown }): JSX.Element {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return <PrettyValue value={value} />
  }
  const v = value as Record<string, unknown>
  const hasEnvelope = Array.isArray(v["content"]) || "details" in v
  if (!hasEnvelope) return <PrettyValue value={value} />

  const contentBlocks = Array.isArray(v["content"]) ? (v["content"] as unknown[]) : []
  const textParts: string[] = []
  for (const b of contentBlocks) {
    if (b && typeof b === "object" && "text" in b) {
      const t = (b as { text?: unknown }).text
      if (typeof t === "string") textParts.push(t)
    }
  }
  const modelText = textParts.join("\n")
  const details = v["details"]
  return (
    <div className="space-y-2">
      {modelText.length > 0 && <ModelSeesCard text={modelText} />}
      {details !== undefined && details !== null && (
        <DetailsCard value={details} />
      )}
    </div>
  )
}

function ModelSeesCard({ text }: { text: string }): JSX.Element {
  const [wrap, setWrap] = useState(true)
  const [dialog, setDialog] = useState(false)
  return (
    <>
      <CollapsibleCard
        label="model sees"
        tint="border-l-[hsl(45_80%_50%/0.7)] bg-[hsl(45_80%_50%/0.04)]"
        defaultOpen={false}
        summary={`${String(text.length)} chars`}
        controls={
          <CardControls
            wrap={wrap}
            setWrap={setWrap}
            onExpand={(): void => setDialog(true)}
          />
        }
      >
        <pre
          className={
            "max-h-48 overflow-auto font-mono text-[11px] leading-relaxed text-foreground/85 " +
            (wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")
          }
        >
          {text}
        </pre>
      </CollapsibleCard>
      {dialog && (
        <TextDialog
          text={text}
          title="What the model sees"
          onClose={(): void => setDialog(false)}
        />
      )}
    </>
  )
}

function DetailsCard({ value }: { value: unknown }): JSX.Element {
  const [wrap, setWrap] = useState(false)
  const [dialog, setDialog] = useState(false)
  return (
    <>
      <CollapsibleCard
        label="details"
        tint="border-l-[hsl(140_45%_42%/0.7)] bg-[hsl(140_45%_42%/0.04)]"
        defaultOpen={true}
        controls={
          <CardControls
            wrap={wrap}
            setWrap={setWrap}
            onExpand={(): void => setDialog(true)}
          />
        }
      >
        <div className={wrap ? "" : "max-h-72 overflow-auto"}>
          <PrettyValue value={value} />
        </div>
      </CollapsibleCard>
      {dialog && (
        <JsonDialog
          value={value}
          title="Tool result details"
          onClose={(): void => setDialog(false)}
        />
      )}
    </>
  )
}

function CollapsibleCard({
  label,
  tint,
  defaultOpen = true,
  summary,
  controls,
  children,
}: {
  label: string
  tint: string
  defaultOpen?: boolean
  summary?: string
  controls?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`rounded-md border border-border/40 border-l-2 ${tint}`}>
      <div className="flex items-center gap-2 px-2 py-1">
        <button
          type="button"
          onClick={(): void => setOpen((o) => !o)}
          className="flex flex-1 items-center gap-2 text-left transition hover:bg-secondary/20"
        >
          <ChevronRight
            className={
              "h-3 w-3 flex-shrink-0 text-muted-foreground/70 transition-transform " +
              (open ? "rotate-90" : "")
            }
            aria-hidden
            strokeWidth={2}
          />
          <span className="text-[9.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
            {label}
          </span>
          {summary && (
            <span className="font-mono text-[10.5px] text-muted-foreground/60">
              {summary}
            </span>
          )}
        </button>
        {controls && (
          <div className="flex flex-shrink-0 items-center gap-1">{controls}</div>
        )}
      </div>
      {open && <div className="border-t border-border/40 px-2 py-1.5">{children}</div>}
    </div>
  )
}

// Small shared wrap-toggle + expand-popup buttons used by the
// MODEL SEES / Tools / Messages cards. Each card owns its own
// (wrap, dialog) state and wires the body with the right styles.
function CardControls({
  wrap,
  setWrap,
  onExpand,
}: {
  wrap: boolean
  setWrap: (v: boolean) => void
  onExpand: () => void
}): JSX.Element {
  return (
    <>
      <button
        type="button"
        onClick={(): void => setWrap(!wrap)}
        aria-pressed={wrap}
        className={
          "inline-flex h-5 items-center rounded-md border border-border px-1.5 text-[10px] transition " +
          (wrap
            ? "bg-secondary text-foreground"
            : "bg-surface-elevated text-muted-foreground hover:text-foreground")
        }
        title={wrap ? "Disable line wrap" : "Wrap long lines"}
      >
        wrap
      </button>
      <button
        type="button"
        onClick={onExpand}
        className="inline-flex h-5 items-center gap-1 rounded-md border border-border bg-surface-elevated px-1.5 text-[10px] text-muted-foreground transition hover:text-foreground"
        title="Expand"
      >
        <Expand className="h-3 w-3" aria-hidden strokeWidth={1.75} />
      </button>
    </>
  )
}

// Full-screen overlay for plain text (e.g. the "MODEL SEES" body).
function TextDialog({
  text,
  title,
  onClose,
}: {
  text: string
  title: string
  onClose: () => void
}): JSX.Element {
  const [wrap, setWrap] = useState(true)
  const [copied, setCopied] = useState(false)
  useEffect((): (() => void) => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return (): void => {
      window.removeEventListener("keydown", onKey)
    }
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-background/70 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl"
        onClick={(e): void => e.stopPropagation()}
      >
        <div className="flex h-10 items-center gap-2 border-b border-border bg-surface-muted/40 px-3">
          <span className="text-[12.5px] font-medium text-foreground">{title}</span>
          <span className="font-mono text-[10.5px] text-muted-foreground/60">
            {String(text.length)} chars
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={(): void => setWrap((v) => !v)}
              aria-pressed={wrap}
              className={
                "inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] transition " +
                (wrap
                  ? "bg-secondary text-foreground"
                  : "bg-surface-elevated text-muted-foreground hover:text-foreground")
              }
            >
              wrap
            </button>
            <button
              type="button"
              onClick={(): void => {
                void navigator.clipboard.writeText(text).then((): void => {
                  setCopied(true)
                  window.setTimeout((): void => setCopied(false), 1400)
                })
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[11px] text-muted-foreground transition hover:text-foreground"
            >
              <Copy className="h-3 w-3" aria-hidden strokeWidth={1.75} />
              {copied ? "copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <X className="h-4 w-4" aria-hidden strokeWidth={1.75} />
            </button>
          </div>
        </div>
        <pre
          className={
            "flex-1 overflow-auto bg-surface-muted/20 px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground/85 " +
            (wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")
          }
        >
          {text}
        </pre>
      </div>
    </div>
  )
}

// Section + Pretty/Raw toggle combined: header label and the toggle
// sit on the SAME row so the body block starts immediately below.
// `flavor="result"` switches the Pretty body to ToolResultPretty
// (envelope-aware) instead of the generic PrettyValue tree.
function ValueSection({
  title,
  value,
  flavor,
}: {
  title: string
  value: unknown
  flavor?: "result" | "args"
}): JSX.Element {
  const [raw, setRaw] = useState(false)
  const right = (
    <button
      type="button"
      onClick={(): void => setRaw((v) => !v)}
      className="inline-flex h-5 items-center rounded-md border border-border bg-surface-elevated px-1.5 text-[10px] text-muted-foreground transition hover:text-foreground"
      title={raw ? "Pretty tree view" : "Raw JSON view"}
    >
      {raw ? "Pretty" : "Raw JSON"}
    </button>
  )
  const pretty =
    flavor === "result" ? (
      <ToolResultPretty value={value} />
    ) : (
      <PrettyValue value={value} />
    )
  return (
    <Section title={title} right={right}>
      {raw ? <CodeBlock value={value} /> : pretty}
    </Section>
  )
}

// Syntax-highlighted JSON renderer with collapsible objects/arrays.
// Token classes:
//   key       — muted blue
//   string    — green
//   number    — amber
//   boolean   — purple
//   null      — destructive
//   punctuation (brackets, commas, colons) — muted-foreground
function JsonNode({
  value,
  indent = 0,
  trailingComma = false,
}: {
  value: unknown
  indent?: number
  trailingComma?: boolean
}): JSX.Element {
  const comma = trailingComma ? "," : ""
  if (value === null) {
    return (
      <>
        <span className="text-destructive">null</span>
        {comma && <span className="text-muted-foreground/60">{comma}</span>}
      </>
    )
  }
  if (typeof value === "boolean") {
    return (
      <>
        <span className="text-[hsl(280_60%_55%)]">{value ? "true" : "false"}</span>
        {comma && <span className="text-muted-foreground/60">{comma}</span>}
      </>
    )
  }
  if (typeof value === "number") {
    return (
      <>
        <span className="text-[hsl(30_85%_50%)] tabular-nums">{String(value)}</span>
        {comma && <span className="text-muted-foreground/60">{comma}</span>}
      </>
    )
  }
  if (typeof value === "string") {
    return (
      <>
        <span className="text-[hsl(140_45%_42%)]">
          {JSON.stringify(value)}
        </span>
        {comma && <span className="text-muted-foreground/60">{comma}</span>}
      </>
    )
  }
  if (Array.isArray(value)) {
    return (
      <JsonArrayNode value={value} indent={indent} trailingComma={trailingComma} />
    )
  }
  if (typeof value === "object") {
    return (
      <JsonObjectNode
        value={value as Record<string, unknown>}
        indent={indent}
        trailingComma={trailingComma}
      />
    )
  }
  return <span className="text-muted-foreground">{String(value)}</span>
}

// Chevron prefix for collapsible nodes. Shown inline before the
// opening brace so the user can see at a glance that the row
// expands. Compact (10px) so it doesn't push the brace too far.
function JsonChevron({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mr-0.5 inline-block align-middle text-muted-foreground/70 hover:text-foreground"
      title={collapsed ? "Expand" : "Collapse"}
    >
      <ChevronRight
        className={"inline h-3 w-3 transition-transform " + (collapsed ? "" : "rotate-90")}
        aria-hidden
        strokeWidth={2}
      />
    </button>
  )
}

function JsonObjectNode({
  value,
  indent,
  trailingComma,
}: {
  value: Record<string, unknown>
  indent: number
  trailingComma: boolean
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const entries = Object.entries(value)
  if (entries.length === 0) {
    return (
      <>
        <span className="text-muted-foreground/60">{"{}"}</span>
        {trailingComma && <span className="text-muted-foreground/60">,</span>}
      </>
    )
  }
  const PAD = "  "
  const childIndent = PAD.repeat(indent + 1)
  const closeIndent = PAD.repeat(indent)
  if (collapsed) {
    return (
      <>
        <JsonChevron collapsed onToggle={(): void => setCollapsed(false)} />
        <button
          type="button"
          onClick={(): void => setCollapsed(false)}
          className="text-muted-foreground/70 hover:text-foreground"
          title="Expand"
        >
          {`{ … ${String(entries.length)} keys }`}
        </button>
        {trailingComma && <span className="text-muted-foreground/60">,</span>}
      </>
    )
  }
  return (
    <>
      <JsonChevron collapsed={false} onToggle={(): void => setCollapsed(true)} />
      <button
        type="button"
        onClick={(): void => setCollapsed(true)}
        className="text-muted-foreground/70 hover:text-foreground"
        title="Collapse"
      >
        {"{"}
      </button>
      {entries.map(([k, v], i) => (
        <div key={k}>
          <span className="text-muted-foreground/60">{childIndent}</span>
          <span className="text-[hsl(210_55%_50%)]">{JSON.stringify(k)}</span>
          <span className="text-muted-foreground/60">: </span>
          <JsonNode value={v} indent={indent + 1} trailingComma={i < entries.length - 1} />
        </div>
      ))}
      <div>
        <span className="text-muted-foreground/60">{closeIndent}</span>
        <span className="text-muted-foreground/60">{"}"}</span>
        {trailingComma && <span className="text-muted-foreground/60">,</span>}
      </div>
    </>
  )
}

function JsonArrayNode({
  value,
  indent,
  trailingComma,
}: {
  value: unknown[]
  indent: number
  trailingComma: boolean
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  if (value.length === 0) {
    return (
      <>
        <span className="text-muted-foreground/60">[]</span>
        {trailingComma && <span className="text-muted-foreground/60">,</span>}
      </>
    )
  }
  const PAD = "  "
  const childIndent = PAD.repeat(indent + 1)
  const closeIndent = PAD.repeat(indent)
  if (collapsed) {
    return (
      <>
        <JsonChevron collapsed onToggle={(): void => setCollapsed(false)} />
        <button
          type="button"
          onClick={(): void => setCollapsed(false)}
          className="text-muted-foreground/70 hover:text-foreground"
          title="Expand"
        >
          {`[ … ${String(value.length)} items ]`}
        </button>
        {trailingComma && <span className="text-muted-foreground/60">,</span>}
      </>
    )
  }
  return (
    <>
      <JsonChevron collapsed={false} onToggle={(): void => setCollapsed(true)} />
      <button
        type="button"
        onClick={(): void => setCollapsed(true)}
        className="text-muted-foreground/70 hover:text-foreground"
        title="Collapse"
      >
        {"["}
      </button>
      {value.map((v, i) => (
        <div key={i}>
          <span className="text-muted-foreground/60">{childIndent}</span>
          <JsonNode value={v} indent={indent + 1} trailingComma={i < value.length - 1} />
        </div>
      ))}
      <div>
        <span className="text-muted-foreground/60">{closeIndent}</span>
        <span className="text-muted-foreground/60">{"]"}</span>
        {trailingComma && <span className="text-muted-foreground/60">,</span>}
      </div>
    </>
  )
}

// Full-screen overlay that re-renders the same content with more
// breathing room. Triggered by the Expand button on CodeBlock /
// LlmRequestView. ESC closes; click-outside closes.
function JsonDialog({
  value,
  title,
  onClose,
}: {
  value: unknown
  title: string
  onClose: () => void
}): JSX.Element {
  const text = useMemo(() => STRINGIFY(value), [value])
  const [copied, setCopied] = useState(false)
  const [wrap, setWrap] = useState(false)
  const isPlainText = typeof value === "string"
  const isStructured =
    !isPlainText && value !== null && typeof value === "object"
  useEffect((): (() => void) => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return (): void => {
      window.removeEventListener("keydown", onKey)
    }
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-background/70 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl"
        onClick={(e): void => e.stopPropagation()}
      >
        <div className="flex h-10 items-center gap-2 border-b border-border bg-surface-muted/40 px-3">
          <span className="text-[12.5px] font-medium text-foreground">{title}</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={(): void => setWrap((v) => !v)}
              className={
                "inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] transition " +
                (wrap
                  ? "bg-secondary text-foreground"
                  : "bg-surface-elevated text-muted-foreground hover:text-foreground")
              }
              aria-pressed={wrap}
              title={wrap ? "Disable line wrap" : "Wrap long lines"}
            >
              wrap
            </button>
            <button
              type="button"
              onClick={(): void => {
                void navigator.clipboard.writeText(text).then((): void => {
                  setCopied(true)
                  window.setTimeout((): void => setCopied(false), 1400)
                })
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[11px] text-muted-foreground transition hover:text-foreground"
              title="Copy JSON"
            >
              <Copy className="h-3 w-3" aria-hidden strokeWidth={1.75} />
              {copied ? "copied" : "Copy JSON"}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <X className="h-4 w-4" aria-hidden strokeWidth={1.75} />
            </button>
          </div>
        </div>
        <div
          className={
            "flex-1 overflow-auto bg-surface-muted/20 px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground/85 " +
            (wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")
          }
        >
          {isStructured ? (
            <JsonNode value={value} indent={0} />
          ) : (
            <pre className={wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}>{text}</pre>
          )}
        </div>
      </div>
    </div>
  )
}

function CodeBlock({
  value,
  expandTitle,
}: {
  value: unknown
  expandTitle?: string
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [wrap, setWrap] = useState(false)
  const text = useMemo(() => STRINGIFY(value), [value])
  const isPlainText = typeof value === "string"
  const isStructured =
    !isPlainText && value !== null && typeof value === "object"
  const wrapClass = wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"
  return (
    <div className="relative">
      <div
        className={`max-h-72 overflow-auto rounded-md border border-border/50 bg-surface-muted/40 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/85 ${wrapClass}`}
      >
        {isStructured ? (
          <JsonNode value={value} indent={0} />
        ) : (
          <pre className={wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}>{text}</pre>
        )}
      </div>
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
        <button
          type="button"
          onClick={(): void => setWrap((v) => !v)}
          className={
            "inline-flex h-6 items-center gap-1 rounded-md border border-border px-1.5 text-[10px] transition " +
            (wrap
              ? "bg-secondary text-foreground"
              : "bg-background/80 text-muted-foreground hover:text-foreground")
          }
          aria-pressed={wrap}
          title={wrap ? "Disable line wrap" : "Wrap long lines"}
        >
          wrap
        </button>
        <button
          type="button"
          onClick={(): void => setDialog(true)}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background/80 px-1.5 text-[10px] text-muted-foreground transition hover:text-foreground"
          aria-label="Expand to full screen"
          title="Expand"
        >
          <Expand className="h-3 w-3" aria-hidden strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={(): void => {
            void navigator.clipboard.writeText(text).then((): void => {
              setCopied(true)
              window.setTimeout((): void => setCopied(false), 1400)
            })
          }}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background/80 px-1.5 text-[10px] text-muted-foreground transition hover:text-foreground"
          aria-label="Copy JSON"
          title="Copy JSON"
        >
          <Copy className="h-3 w-3" aria-hidden strokeWidth={1.75} />
          {copied ? "copied" : "copy"}
        </button>
      </div>
      {dialog && (
        <JsonDialog
          value={value}
          title={expandTitle ?? "JSON"}
          onClose={(): void => setDialog(false)}
        />
      )}
    </div>
  )
}

// Structured view of an LLM request payload + the Section
// wrapping. Combined into one component so the "Raw payload"
// button can live INSIDE the section header (same row as the
// "REQUEST" label) instead of taking its own row below.
function LlmRequestSection({ value }: { value: unknown }): JSX.Element {
  const [dialog, setDialog] = useState(false)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return (
      <Section title="Request">
        <CodeBlock value={value} expandTitle="Request payload" />
      </Section>
    )
  }
  const obj = value as Record<string, unknown>
  const system = typeof obj["system"] === "string" ? (obj["system"] as string) : null
  const messages = Array.isArray(obj["messages"])
    ? (obj["messages"] as unknown[])
    : null
  const tools = Array.isArray(obj["tools"]) ? (obj["tools"] as unknown[]) : null
  const sampler = {
    ...(typeof obj["temperature"] === "number" ? { temperature: obj["temperature"] } : {}),
    ...(typeof obj["top_p"] === "number" ? { top_p: obj["top_p"] } : {}),
    ...(typeof obj["max_tokens"] === "number" ? { max_tokens: obj["max_tokens"] } : {}),
    ...(typeof obj["model"] === "string" ? { model: obj["model"] } : {}),
  }
  if (!system && !messages && !tools && Object.keys(sampler).length === 0) {
    return (
      <Section title="Request">
        <CodeBlock value={value} expandTitle="Request payload" />
      </Section>
    )
  }
  const rawBtn = (
    <button
      type="button"
      onClick={(): void => setDialog(true)}
      className="inline-flex h-5 items-center gap-1 rounded-md border border-border bg-surface-elevated px-1.5 text-[10px] text-muted-foreground transition hover:text-foreground"
      title="Show raw payload"
    >
      <Expand className="h-3 w-3" aria-hidden strokeWidth={1.75} />
      Raw payload
    </button>
  )
  return (
    <Section title="Request" right={rawBtn}>
      <div className="space-y-2">
        {Object.keys(sampler).length > 0 && (
          <Subsection label="Sampler" tone="sampler">
            <PrettyValue value={sampler} />
          </Subsection>
        )}
        {tools && tools.length > 0 && <ToolListSection tools={tools} />}
        {system && <SystemPromptSection text={system} />}
        {messages && messages.length > 0 && <MessagesSection messages={messages} />}
      </div>
      {dialog && (
        <JsonDialog
          value={value}
          title="Request payload"
          onClose={(): void => setDialog(false)}
        />
      )}
    </Section>
  )
}

// Subsection tones — each LLM-request panel gets its own subtle
// border + background tint so the four blocks are visually distinct.
type SectionTone = "sampler" | "tools" | "system" | "messages"
const SECTION_TONE_CLASS: Record<SectionTone, string> = {
  sampler: "border-l-2 border-l-[hsl(30_85%_50%/0.7)] bg-[hsl(30_85%_50%/0.05)]",
  tools: "border-l-2 border-l-[hsl(140_45%_42%/0.7)] bg-[hsl(140_45%_42%/0.05)]",
  system: "border-l-2 border-l-[hsl(45_80%_50%/0.7)] bg-[hsl(45_80%_50%/0.05)]",
  messages: "border-l-2 border-l-[hsl(210_55%_50%/0.7)] bg-[hsl(210_55%_50%/0.05)]",
}

function Subsection({
  label,
  tone,
  children,
}: {
  label: string
  tone?: SectionTone
  children: React.ReactNode
}): JSX.Element {
  const toneClass = tone ? SECTION_TONE_CLASS[tone] : "border-border/40 bg-surface-muted/20"
  return (
    <div className={`rounded-md border border-border/40 ${toneClass} px-2 py-1.5`}>
      <div className="mb-1 text-[9.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
        {label}
      </div>
      {children}
    </div>
  )
}

function SystemPromptSection({ text }: { text: string }): JSX.Element {
  const [wrap, setWrap] = useState(true)
  const [dialog, setDialog] = useState(false)
  return (
    <>
      <CollapsibleCard
        label="System prompt"
        tint={SECTION_TONE_CLASS.system}
        defaultOpen={false}
        summary={`${String(text.length)} chars`}
        controls={
          <CardControls
            wrap={wrap}
            setWrap={setWrap}
            onExpand={(): void => setDialog(true)}
          />
        }
      >
        <pre
          className={
            "max-h-72 overflow-auto font-mono text-[11px] leading-relaxed text-foreground/80 " +
            (wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")
          }
        >
          {text}
        </pre>
      </CollapsibleCard>
      {dialog && (
        <TextDialog
          text={text}
          title="System prompt"
          onClose={(): void => setDialog(false)}
        />
      )}
    </>
  )
}

function ToolListSection({ tools }: { tools: unknown[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [dialog, setDialog] = useState(false)
  const names = tools
    .map((t): string => {
      if (!t || typeof t !== "object") return "?"
      const o = t as Record<string, unknown>
      return typeof o["name"] === "string" ? (o["name"] as string) : "?"
    })
    .filter((n) => n !== "?")
  return (
    <div className={`rounded-md border border-border/40 ${SECTION_TONE_CLASS.tools}`}>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={(): void => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left transition hover:bg-secondary/30"
        >
          <ChevronRight
            className={
              "h-3 w-3 flex-shrink-0 text-muted-foreground/70 transition-transform " +
              (open ? "rotate-90" : "")
            }
            aria-hidden
            strokeWidth={2}
          />
          <span className="text-[9.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
            Tools available
          </span>
          <span className="font-mono text-[10.5px] text-muted-foreground/60 tabular-nums">
            {String(tools.length)}
          </span>
        </button>
        <CardControls
          wrap={wrap}
          setWrap={setWrap}
          onExpand={(): void => setDialog(true)}
        />
      </div>
      <div className="flex flex-wrap gap-1 px-2 pb-2">
        {names.map((n) => (
          <span
            key={n}
            className="inline-flex items-center rounded-md border border-border/50 bg-background/60 px-1.5 py-0.5 font-mono text-[10.5px] text-foreground/85"
          >
            {n}
          </span>
        ))}
      </div>
      {open && (
        <div
          className={
            "max-h-72 overflow-auto border-t border-border/40 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/85 " +
            (wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")
          }
        >
          <JsonNode value={tools} indent={0} />
        </div>
      )}
      {dialog && (
        <JsonDialog
          value={tools}
          title="Tools available"
          onClose={(): void => setDialog(false)}
        />
      )}
    </div>
  )
}

function MessagesSection({ messages }: { messages: unknown[] }): JSX.Element {
  const [dialog, setDialog] = useState(false)
  return (
    <>
      <div className={`rounded-md border border-border/40 ${SECTION_TONE_CLASS.messages} px-2 py-1.5`}>
        <div className="mb-1 flex items-center gap-2">
          <span className="flex-1 text-[9.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
            Messages ({String(messages.length)})
          </span>
          <button
            type="button"
            onClick={(): void => setDialog(true)}
            className="inline-flex h-5 items-center gap-1 rounded-md border border-border bg-surface-elevated px-1.5 text-[10px] text-muted-foreground transition hover:text-foreground"
            title="Expand"
          >
            <Expand className="h-3 w-3" aria-hidden strokeWidth={1.75} />
          </button>
        </div>
        <div className="space-y-1.5">
          {messages.map((m, i) => (
            <MessageRow key={i} value={m} index={i} />
          ))}
        </div>
      </div>
      {dialog && (
        <JsonDialog
          value={messages}
          title="Messages"
          onClose={(): void => setDialog(false)}
        />
      )}
    </>
  )
}

const ROLE_TONE: Record<string, string> = {
  system: "bg-muted text-muted-foreground",
  user: "bg-[hsl(210_55%_50%/0.15)] text-[hsl(210_55%_50%)]",
  assistant: "bg-[hsl(280_60%_55%/0.15)] text-[hsl(280_60%_55%)]",
  tool: "bg-[hsl(140_45%_42%/0.15)] text-[hsl(140_45%_42%)]",
}

// Renders one Anthropic-style content block (text / thinking /
// tool_use / tool_result) as a labelled card. Anything we don't
// recognise falls back to PrettyValue. Used by MessageRow when the
// row is expanded so an assistant message's reasoning is obvious.
function MessageContentBlock({
  block,
}: {
  block: unknown
}): JSX.Element {
  if (typeof block === "string") {
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-foreground/85">
        {block}
      </pre>
    )
  }
  if (!block || typeof block !== "object") {
    return <PrettyValue value={block} />
  }
  const b = block as Record<string, unknown>
  const type = typeof b["type"] === "string" ? (b["type"] as string) : "?"
  const wrap = (label: string, tint: string, body: React.ReactNode): JSX.Element => (
    <div className={`rounded-md border border-border/40 border-l-2 ${tint} px-2 py-1.5`}>
      <div className="mb-1 text-[9.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
        {label}
      </div>
      {body}
    </div>
  )
  if (type === "text" && typeof b["text"] === "string") {
    return wrap(
      "text",
      "border-l-foreground/40",
      <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-foreground/85">
        {b["text"] as string}
      </pre>,
    )
  }
  if (type === "thinking" && typeof b["thinking"] === "string") {
    return wrap(
      "reasoning",
      "border-l-[hsl(280_60%_55%/0.7)] bg-[hsl(280_60%_55%/0.04)]",
      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/75">
        {b["thinking"] as string}
      </pre>,
    )
  }
  if (type === "tool_use") {
    const name = typeof b["name"] === "string" ? (b["name"] as string) : "?"
    return wrap(
      `tool_use → ${name}`,
      "border-l-[hsl(140_45%_42%/0.7)] bg-[hsl(140_45%_42%/0.04)]",
      <PrettyValue value={b["input"] ?? {}} />,
    )
  }
  if (type === "tool_result") {
    return wrap(
      "tool_result",
      "border-l-[hsl(30_85%_50%/0.7)] bg-[hsl(30_85%_50%/0.04)]",
      <PrettyValue value={b["content"] ?? b} />,
    )
  }
  return wrap(type, "border-l-border/50", <PrettyValue value={b} />)
}

function MessageRow({
  value,
  index,
}: {
  value: unknown
  index: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  if (!value || typeof value !== "object") {
    return (
      <div className="rounded-md border border-border/40 px-2 py-1">
        <PrettyValue value={value} />
      </div>
    )
  }
  const m = value as Record<string, unknown>
  const role = typeof m["role"] === "string" ? (m["role"] as string) : "?"
  const content = m["content"]
  const tone = ROLE_TONE[role] ?? "bg-secondary text-foreground"
  // Preview picks first text, then reasoning, then a block count.
  // Counts every block type so reasoning-heavy assistant turns are
  // visible at a glance without expanding.
  const { previewText, blockTypes } = (() => {
    if (typeof content === "string") {
      return { previewText: content.slice(0, 120), blockTypes: {} as Record<string, number> }
    }
    if (Array.isArray(content)) {
      const types: Record<string, number> = {}
      let firstText = ""
      let firstThinking = ""
      for (const c of content as unknown[]) {
        if (!c || typeof c !== "object") continue
        const o = c as Record<string, unknown>
        const t = typeof o["type"] === "string" ? (o["type"] as string) : "?"
        types[t] = (types[t] ?? 0) + 1
        if (!firstText && t === "text" && typeof o["text"] === "string") {
          firstText = o["text"] as string
        }
        if (!firstThinking && t === "thinking" && typeof o["thinking"] === "string") {
          firstThinking = o["thinking"] as string
        }
      }
      const text = firstText || (firstThinking ? `💭 ${firstThinking}` : "")
      return {
        previewText: text ? text.slice(0, 120) : `[${String(content.length)} blocks]`,
        blockTypes: types,
      }
    }
    return { previewText: "", blockTypes: {} as Record<string, number> }
  })()
  return (
    <div className="rounded-md border border-border/40 bg-background/40">
      <button
        type="button"
        onClick={(): void => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition hover:bg-secondary/30"
      >
        <ChevronRight
          className={
            "h-3 w-3 flex-shrink-0 text-muted-foreground/70 transition-transform " +
            (open ? "rotate-90" : "")
          }
          aria-hidden
          strokeWidth={2}
        />
        <span className="flex-shrink-0 font-mono text-[10px] text-muted-foreground/60 tabular-nums">
          {String(index)}
        </span>
        <span
          className={
            "flex-shrink-0 rounded px-1.5 py-0 font-mono text-[10px] " + tone
          }
        >
          {role}
        </span>
        <span className="truncate font-mono text-[11px] text-muted-foreground/85">
          {previewText}
        </span>
        {Object.keys(blockTypes).length > 1 && (
          <span className="ml-auto flex-shrink-0 font-mono text-[9.5px] text-muted-foreground/60">
            {Object.entries(blockTypes)
              .map(([t, n]) => `${t}×${String(n)}`)
              .join(" ")}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-border/40 px-2 py-1.5">
          {Array.isArray(content) ? (
            content.map((b, i) => <MessageContentBlock key={i} block={b} />)
          ) : (
            <MessageContentBlock block={content} />
          )}
        </div>
      )}
    </div>
  )
}

// One row in the timeline. Click to expand → renders any payload-shaped
// fields as code blocks below the header line.
function EventRow({
  event,
  offset,
  extra,
  open,
  onToggle,
}: {
  event: DebugEvent
  offset: number
  extra?: RowExtra
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const rowExtra = extra ?? {}
  const { Icon, label, tone } = headerFor(event, rowExtra)
  const expandable = hasDetails(event)
  return (
    <div className="rounded-md border border-border/40 border-l-2 border-l-border/70 bg-surface-muted/40 px-2 py-1">
      <button
        type="button"
        onClick={(): void => {
          if (expandable) onToggle()
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
    case "mid_turn_stop":
      return true
    case "retry_attempt":
      return true
  }
}

const renderDetails = (e: DebugEvent, extra: RowExtra = {}): JSX.Element[] => {
  const out: JSX.Element[] = []
  if (e.kind === "request") {
    if (e.payload !== undefined) {
      out.push(
        <LlmRequestSection key="payload" value={e.payload} />,
      )
    } else {
      out.push(
        <Section key="meta" title="Metadata">
          <PrettyValue
            value={{
              model: e.model,
              sampler: e.sampler,
              systemPromptChars: e.systemPromptChars,
            }}
          />
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
    if (e.thinking && e.thinking.length > 0) {
      out.push(
        <Section key="thinking" title="Reasoning">
          <CodeBlock value={e.thinking} />
        </Section>,
      )
    }
    if (e.text && e.text.length > 0) {
      out.push(
        <Section key="text" title="Response text">
          <CodeBlock value={e.text} />
        </Section>,
      )
    }
  } else if (e.kind === "tool_call_start") {
    out.push(
      <ValueSection key="args" title="Args" value={e.args} />,
    )
  } else if (e.kind === "tool_call_end" && e.result !== undefined) {
    out.push(
      <ValueSection
        key="result"
        title={e.isError ? "Error" : "Result"}
        value={e.result}
        flavor="result"
      />,
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
  } else if (e.kind === "mid_turn_stop") {
    const threshold = e.contextWindow - e.reserveTokens
    out.push(
      <Section key="reason" title="Mid-turn stop">
        <PrettyValue
          value={{
            reason: e.reason,
            contextTokens: e.contextTokens,
            contextWindow: e.contextWindow,
            reserveTokens: e.reserveTokens,
            thresholdTokens: threshold,
            overage: e.contextTokens - threshold,
          }}
        />
      </Section>,
    )
  } else if (e.kind === "retry_attempt") {
    out.push(
      <Section key="retry" title={e.phase === "start" ? "Retry start" : "Retry end"}>
        <PrettyValue value={e} />
      </Section>,
    )
  }
  return out
}

function Section({
  title,
  right,
  children,
}: {
  title: string
  right?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <div>
      <div className="mb-0.5 flex items-center gap-2 pl-1">
        <span className="text-[9.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
          {title}
        </span>
        {right && <div className="ml-auto">{right}</div>}
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

  // Re-seed the in-memory store from server-persisted events once on
  // mount. After a page reload the SSE stream and the client store are
  // both empty, so without this the captured timeline is lost. We only
  // fetch when the store currently has NO events for this run (a fresh
  // load) and a conversationId is available to scope the request — for
  // an in-flight run the live SSE events are already accumulating and
  // seedDebugEvents would no-op anyway, so we skip the network call.
  // Keyed on runId/conversationId; an unmount/runId-change flag guards
  // against a late response seeding a panel that's no longer mounted.
  useEffect(() => {
    if (!conversationId) return
    if (getDebugEvents(runId).length > 0) return
    let cancelled = false
    void fetchPersistedDebugEvents(conversationId, runId)
      .then((res) => {
        if (cancelled) return
        if (res.events.length === 0) return
        // seedDebugEvents itself no-ops if live events arrived while
        // the request was in flight, so this can't clobber the stream.
        seedDebugEvents(runId, res.events as DebugEvent[])
      })
      .catch(() => {
        // Best-effort re-seed — a failed fetch just leaves the panel
        // empty (same as today's no-persistence behaviour).
      })
    return (): void => {
      cancelled = true
    }
  }, [runId, conversationId])

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
  // Per-row open state lifted out of EventRow so the sticky header
  // can drive Expand all / Collapse all. Keyed by row index — the
  // event store is append-only so an event's index is stable for
  // the lifetime of the run. Default missing = collapsed.
  const [openByIndex, setOpenByIndex] = useState<Record<number, boolean>>({})
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
    let peakCallContext = 0
    let llmCallCount = 0
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
      } else if (e.kind === "response" && e.tokenUsage) {
        llmCallCount++
        const callCtx = (e.tokenUsage.input ?? 0) + (e.tokenUsage.cacheRead ?? 0)
        if (callCtx > peakCallContext) peakCallContext = callCtx
      }
    })
    if (agentEndIdx >= 0) {
      extras[agentEndIdx] = {
        ...extras[agentEndIdx],
        ...(failedTools.length > 0 ? { failedTools } : {}),
        ...(peakCallContext > 0 ? { peakCallContext } : {}),
        ...(llmCallCount > 0 ? { llmCallCount } : {}),
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
  // Count expandable rows so the header chip can show
  // "N / M expanded" without re-walking on every render.
  let expandableTotal = 0
  let expandableOpen = 0
  // Latest per-call context = input+cacheRead of the most recent
  // response event. That's the size of the prompt the model is
  // currently working with — "context used so far".
  let latestCallCtx = 0
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (ev && hasDetails(ev)) {
      expandableTotal++
      if (openByIndex[i]) expandableOpen++
    }
    if (ev && ev.kind === "response" && ev.tokenUsage) {
      latestCallCtx = (ev.tokenUsage.input ?? 0) + (ev.tokenUsage.cacheRead ?? 0)
    }
  }

  const expandAll = (): void => {
    const next: Record<number, boolean> = {}
    events.forEach((ev, i) => {
      if (ev && hasDetails(ev)) next[i] = true
    })
    setOpenByIndex(next)
  }
  const collapseAll = (): void => {
    setOpenByIndex({})
  }

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex-1 overflow-y-auto">
        {/* Sticky header — pins to the top of the scroll container so
            it stays visible as the user scrolls down a long timeline.
            Hosts the Expand all / Collapse all bulk actions plus a
            running "N / M expanded" indicator so the user knows where
            they are. */}
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-3 py-1.5 backdrop-blur-sm">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground/70">
            Timeline
          </span>
          <span className="font-mono text-[10.5px] text-muted-foreground/60 tabular-nums">
            {String(events.length)} event{events.length === 1 ? "" : "s"}
          </span>
          {latestCallCtx > 0 && (
            <span className="font-mono text-[10.5px] text-muted-foreground/60 tabular-nums">
              · ctx now {formatTokens(latestCallCtx)}
            </span>
          )}
          {expandableTotal > 0 && (
            <span className="font-mono text-[10.5px] text-muted-foreground/60 tabular-nums">
              · {String(expandableOpen)} / {String(expandableTotal)} expanded
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={expandAll}
              disabled={expandableTotal === 0 || expandableOpen === expandableTotal}
              className="inline-flex h-6 items-center rounded-md border border-border bg-surface-elevated px-1.5 text-[10.5px] text-muted-foreground transition hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:text-muted-foreground"
              title="Expand every row that has details"
            >
              Expand all
            </button>
            <button
              type="button"
              onClick={collapseAll}
              disabled={expandableOpen === 0}
              className="inline-flex h-6 items-center rounded-md border border-border bg-surface-elevated px-1.5 text-[10.5px] text-muted-foreground transition hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:text-muted-foreground"
              title="Collapse every row"
            >
              Collapse all
            </button>
          </div>
        </div>
        <div className="space-y-1.5 px-3 py-3">
          {events.map((e, i) => (
            <EventRow
              key={i}
              event={e}
              offset={Math.max(0, eventTimestamp(e) - firstAt)}
              open={openByIndex[i] ?? false}
              onToggle={(): void => {
                setOpenByIndex((m) => ({ ...m, [i]: !(m[i] ?? false) }))
              }}
              {...(extras[i] && Object.keys(extras[i]).length > 0
                ? { extra: extras[i] }
                : {})}
            />
          ))}
        </div>
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
