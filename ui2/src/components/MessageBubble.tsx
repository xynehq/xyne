import { Copy, RefreshCcw, AlertTriangle, Layers, RotateCw } from "lucide-react"
import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"

// react-markdown 9 strips unknown URL schemes (`cite:`) via its default
// sanitizer, leaving the rendered `<a>` with an empty href. Allow `cite:`
// through verbatim and defer to the built-in sanitizer for everything else.
const passthroughCiteUrl = (url: string): string =>
  url.startsWith("cite:") ? url : defaultUrlTransform(url)
import { ToolCallChip } from "./ToolCallChip"
import { DispatchSubagentChip } from "./DispatchSubagentChip"
import { ThinkingChip, type ReasoningItem } from "./ThinkingChip"
import { CitationChip, CitationNumberProvider } from "./CitationChip"
import { remarkCitations } from "@/lib/remark-citations"
import type { Block, MessageStats } from "@/lib/chat-store"
import { usePreferences } from "@/lib/preferences"

// Shared between every assistant text block — react-markdown's `components`
// prop is reference-stable, so we declare it module-scope.
const MARKDOWN_PLUGINS = [remarkGfm, remarkCitations]

// Custom <a> renderer: the remarkCitations plugin rewrites `[clf-xxx#42]`
// tokens as <a href="cite:clf-xxx#42">…</a>. We detect the `cite:` scheme
// and replace the link with a CitationChip.
import type { Components } from "react-markdown"

const markdownComponents: Components = {
  a: (props): JSX.Element => {
    const { href, children, ...rest } = props
    if (typeof href === "string" && href.startsWith("cite:")) {
      const body = href.slice("cite:".length)
      const hash = body.indexOf("#")
      const docId = hash >= 0 ? body.slice(0, hash) : body
      const chunkRaw = hash >= 0 ? body.slice(hash + 1) : ""
      const chunkIndex = /^\d+$/.test(chunkRaw) ? Number(chunkRaw) : 0
      return <CitationChip docId={docId} chunkIndex={chunkIndex} />
    }
    return (
      // eslint-disable-next-line react/jsx-no-target-blank
      <a href={href} target="_blank" rel="noreferrer" {...rest}>
        {children}
      </a>
    )
  },
}

export type ChatRole = "user" | "assistant"

type Props = {
  role: ChatRole
  blocks: Block[]
  pending?: boolean
  onCopy?: () => void
  onRetry?: () => void
  /** Per-turn telemetry from backendv2; rendered as a tabular-numeric footer
   *  under the action icons when present. Absent for in-flight messages and
   *  for historical messages from before backendv2 started emitting stats. */
  stats?: MessageStats
  /** M8 — needed to fetch the sub-agent's nested trace when a
   *  dispatchSubagent tool chip is expanded. The chip queries
   *  /v2/chat/conversations/:convId/runs/:runId/nested and matches
   *  the Nth dispatch block to the Nth nested run. Both are
   *  required for dispatch chips to render with their nested
   *  timeline; otherwise the chip degrades to the plain ToolCallChip. */
  conversationId?: string
  runId?: string
}

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s - m * 60)
  return `${m}m ${rem}s`
}

const formatTokens = (n: number): string => {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

const collectText = (blocks: Block[]): string => {
  const out: string[] = []
  for (const b of blocks) {
    if (b.kind === "text") {
      out.push(b.text)
    }
  }
  return out.join("")
}

export function MessageBubble({
  role,
  blocks,
  pending = false,
  onCopy,
  onRetry,
  stats,
  conversationId,
  runId,
}: Props): JSX.Element {
  const { collapseTools } = usePreferences()
  if (role === "user") {
    const body = collectText(blocks)
    return (
      <div className="flex w-full justify-end px-2 py-3 sm:px-4">
        <div className="max-w-[78%] rounded-3xl bg-bubble-user px-4 py-2.5 text-[14.5px] leading-relaxed text-foreground">
          {body}
        </div>
      </div>
    )
  }

  // Pair tool_use blocks with their tool_result counterparts by id, then
  // render the assistant's content (text + tool calls + errors) in order.
  const resultById = new Map<string, { output: unknown; isError: boolean }>()
  for (const b of blocks) {
    if (b.kind === "tool_result") {
      resultById.set(b.toolCallId, { output: b.output, isError: b.isError })
    }
  }

  // Pre-compute the dispatch index for each dispatchSubagent tool_use
  // block: each one gets a 0-based position among the message's
  // dispatchSubagent blocks. The Nth dispatch block matches the Nth
  // nested run on the backend (server sorts by startedAt ASC). This
  // ordering is stable per message.
  const dispatchIndexByCallId = new Map<string, number>()
  {
    let n = 0
    for (const b of blocks) {
      if (b.kind === "tool_use" && b.toolName === "dispatchSubagent") {
        dispatchIndexByCallId.set(b.toolCallId, n++)
      }
    }
  }

  const reasoningItems: ReasoningItem[] = []
  const renderBlocks: Array<{ block: Block; key: number; isLastBlock: boolean }> = []
  let isReasoningActive = false
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (!b) continue
    if (b.kind === "tool_result") continue
    const isLast = i === blocks.length - 1
    if (collapseTools && b.kind === "thinking") {
      reasoningItems.push({ kind: "thought", text: b.text })
      if (pending && isLast) isReasoningActive = true
    } else if (collapseTools && b.kind === "tool_use") {
      const result = resultById.get(b.toolCallId)
      // dispatchSubagent gets the rich nested-trace chip even inside
      // the Thoughts accordion — the user expects the expand-to-see-
      // sub-agent UX wherever the dispatch lands.
      if (
        b.toolName === "dispatchSubagent" &&
        conversationId &&
        runId
      ) {
        reasoningItems.push({
          kind: "dispatch",
          args: b.args,
          ...(result ? { result } : {}),
          conversationId,
          parentRunId: runId,
          dispatchIndex: dispatchIndexByCallId.get(b.toolCallId) ?? 0,
        })
      } else {
        reasoningItems.push({
          kind: "tool",
          name: b.toolName,
          args: b.args,
          ...(result ? { result } : {}),
        })
      }
      if (pending && isLast) isReasoningActive = true
    } else {
      renderBlocks.push({ block: b, key: i, isLastBlock: isLast })
    }
  }
  const trailing = blocks[blocks.length - 1]
  if (
    collapseTools &&
    pending &&
    trailing?.kind === "tool_result"
  ) {
    isReasoningActive = true
  }
  const showReasoning = collapseTools && reasoningItems.length > 0

  const fullText = collectText(blocks)
  const hasAnyContent = blocks.length > 0

  return (
    <article className="group w-full px-2 py-5 sm:px-4">
      <CitationNumberProvider>
      <div className="flex min-w-0 flex-col gap-2">
        {hasAnyContent && (
          <div className="prose-chat text-[15px] leading-7 text-foreground">
            {showReasoning && (
              <ThinkingChip
                items={reasoningItems}
                pending={isReasoningActive}
                streaming={pending}
              />
            )}
            {renderBlocks.map(({ block: b, key, isLastBlock }) => {
              if (b.kind === "text") {
                return (
                  <ReactMarkdown
                    key={key}
                    remarkPlugins={MARKDOWN_PLUGINS}
                    components={markdownComponents}
                    // react-markdown 9.x's default `urlTransform` strips
                    // unknown schemes, which wipes out our `cite:docId#chunk`
                    // hrefs before the `components.a` override can see them.
                    // Pass-through for `cite:` URLs; defer to the default for
                    // anything else so http:// / https:// stay sanitized.
                    urlTransform={passthroughCiteUrl}
                  >
                    {b.text}
                  </ReactMarkdown>
                )
              }
              if (b.kind === "thinking") {
                const isLive = pending && isLastBlock
                return (
                  <ThinkingChip
                    key={key}
                    items={[{ kind: "thought", text: b.text }]}
                    pending={isLive}
                  />
                )
              }
              if (b.kind === "tool_use") {
                const result = resultById.get(b.toolCallId)
                // M8 — dispatchSubagent blocks render with the
                // specialised chip that loads the nested trace on
                // expand. Plain tools (vespaSearch etc.) keep using
                // ToolCallChip. The dispatch chip degrades to the
                // plain chip if MessageBubble wasn't given the
                // (conversationId, runId) pair needed to fetch the
                // trace — that happens for historical messages from
                // before M7 / messages rendered outside the chat
                // view.
                if (
                  b.toolName === "dispatchSubagent" &&
                  conversationId &&
                  runId
                ) {
                  const dispatchIndex =
                    dispatchIndexByCallId.get(b.toolCallId) ?? 0
                  return (
                    <DispatchSubagentChip
                      key={key}
                      args={b.args}
                      {...(result ? { result } : {})}
                      conversationId={conversationId}
                      parentRunId={runId}
                      dispatchIndex={dispatchIndex}
                    />
                  )
                }
                return (
                  <ToolCallChip
                    key={key}
                    name={b.toolName}
                    args={b.args}
                    {...(result ? { result } : {})}
                  />
                )
              }
              if (b.kind === "error") {
                return (
                  <div
                    key={key}
                    className="my-2 flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
                  >
                    <AlertTriangle
                      className="mt-0.5 h-3.5 w-3.5 flex-shrink-0"
                      aria-hidden
                    />
                    <span>{b.message}</span>
                  </div>
                )
              }
              return null
            })}
          </div>
        )}
        {!pending && stats && <StatsFooter stats={stats} />}
        {!pending && fullText.length > 0 && (
          <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
            <ActionIcon
              icon={Copy}
              label="Copy"
              onClick={
                onCopy ??
                ((): void => {
                  void navigator.clipboard.writeText(fullText)
                })
              }
            />
            {onRetry && (
              <ActionIcon icon={RefreshCcw} label="Retry" onClick={onRetry} />
            )}
          </div>
        )}
      </div>
      </CitationNumberProvider>
    </article>
  )
}

function StatsFooter({ stats }: { stats: MessageStats }): JSX.Element {
  const ctxPct =
    typeof stats.contextUsage?.percent === "number"
      ? Math.round(stats.contextUsage.percent)
      : undefined
  // cacheHitRatio comes in 0–1; surface as a percentage like the others.
  const cachePct = Math.round(stats.cacheHitRatio * 100)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 font-mono text-[11px] tabular-nums text-muted-foreground/80">
      <span>{formatDuration(stats.durationMs)}</span>
      <span aria-hidden>·</span>
      <span title="Input tokens (uncached)">
        {formatTokens(stats.tokenUsage.input)} in
      </span>
      <span aria-hidden>·</span>
      <span title="Output tokens">
        {formatTokens(stats.tokenUsage.output)} out
      </span>
      {ctxPct !== undefined && (
        <>
          <span aria-hidden>·</span>
          <span title="Context window utilisation">ctx {ctxPct}%</span>
        </>
      )}
      <span aria-hidden>·</span>
      <span
        title="Prompt-cache hit ratio (cacheRead / (cacheRead + input))"
        className={cachePct >= 30 ? "text-foreground/70" : ""}
      >
        cache {cachePct}%
      </span>
      {stats.compactionRounds > 0 && (
        <span
          title="Pi-mono auto-compaction fired this many times during the run"
          className="inline-flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-foreground/70"
        >
          <Layers className="h-3 w-3" aria-hidden strokeWidth={1.75} />
          {stats.compactionRounds}
        </span>
      )}
      {stats.retryAttempts > 0 && (
        <span
          title="Pi-mono retried the upstream call this many times"
          className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-300"
        >
          <RotateCw className="h-3 w-3" aria-hidden strokeWidth={1.75} />
          {stats.retryAttempts}
        </span>
      )}
    </div>
  )
}

function ActionIcon({
  icon,
  label,
  onClick,
}: {
  icon: typeof Copy
  label: string
  onClick?: () => void
}): JSX.Element {
  const Glyph = icon
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
    >
      <Glyph className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
    </button>
  )
}
