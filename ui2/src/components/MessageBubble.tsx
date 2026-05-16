import { Copy, RefreshCcw, AlertTriangle } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { BrandMark } from "./BrandMark"
import { ToolCallChip } from "./ToolCallChip"
import { ThinkingChip } from "./ThinkingChip"
import type { Block } from "@/lib/chat-store"

export type ChatRole = "user" | "assistant"

type Props = {
  role: ChatRole
  blocks: Block[]
  pending?: boolean
  onCopy?: () => void
  onRetry?: () => void
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
}: Props): JSX.Element {
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

  const fullText = collectText(blocks)
  const hasAnyContent = blocks.length > 0

  return (
    <article className="group flex w-full gap-3 px-2 py-5 sm:px-4">
      <div className="mt-0.5 flex-shrink-0">
        <span className="relative inline-flex">
          <BrandMark withWordmark={false} />
          {pending && (
            <span
              aria-hidden
              className="absolute inset-[-5px] animate-spin rounded-full border-2 border-foreground/15 border-t-foreground/80"
            />
          )}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {hasAnyContent && (
          <div className="prose-chat text-[15px] leading-7 text-foreground">
            {blocks.map((b, i) => {
              if (b.kind === "text") {
                return (
                  <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>
                    {b.text}
                  </ReactMarkdown>
                )
              }
              if (b.kind === "thinking") {
                return <ThinkingChip key={i} text={b.text} />
              }
              if (b.kind === "tool_use") {
                return (
                  <ToolCallChip
                    key={i}
                    name={b.toolName}
                    args={b.args}
                    {...(resultById.has(b.toolCallId)
                      ? {
                          result: resultById.get(b.toolCallId) as {
                            output: unknown
                            isError: boolean
                          },
                        }
                      : {})}
                  />
                )
              }
              if (b.kind === "error") {
                return (
                  <div
                    key={i}
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
              // tool_result handled via pairing above; ignore here.
              return null
            })}
          </div>
        )}
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
    </article>
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
