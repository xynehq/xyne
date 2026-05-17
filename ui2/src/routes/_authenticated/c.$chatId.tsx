import { useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Topbar } from "@/components/Topbar"
import { Composer } from "@/components/Composer"
import { MessageBubble } from "@/components/MessageBubble"
import { chatStore, useConversation, type Block } from "@/lib/chat-store"
import { useModels } from "@/lib/models"
import { useAgents } from "@/lib/agents"

export const Route = createFileRoute("/_authenticated/c/$chatId")({
  component: ChatThreadRoute,
})

const collectText = (blocks: Block[]): string => {
  const out: string[] = []
  for (const b of blocks) {
    if (b.kind === "text") {
      out.push(b.text)
    }
  }
  return out.join("")
}

function ChatThreadRoute(): JSX.Element {
  const { chatId } = Route.useParams()
  const conv = useConversation(chatId)
  const { selected: selectedModel } = useModels()
  const { selected: selectedAgent } = useAgents()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const tailRef = useRef<HTMLDivElement | null>(null)
  // True while the user is glued to the bottom of the scroll view. As soon as
  // they scroll up, we stop auto-following stream deltas so the view doesn't
  // fight their scroll position. Flips back on once they scroll near bottom.
  const stickToBottomRef = useRef(true)
  const [seed, setSeed] = useState<{ text: string; key: number } | undefined>()

  useEffect((): (() => void) | void => {
    void chatStore.loadConv(chatId)
    // Fresh route — assume they want to follow along.
    stickToBottomRef.current = true
    // On unmount (route change or close), tear down the SSE connection. The
    // resume cursor persists in sessionStorage, so coming back picks up
    // exactly where this user left off without a duplicate-replay.
    return (): void => {
      chatStore.closeStream(chatId)
    }
  }, [chatId])

  useEffect((): void => {
    if (!stickToBottomRef.current) return
    const el = scrollRef.current
    if (!el) return
    // Direct assignment instead of scrollIntoView({behavior:"smooth"}) so
    // rapid deltas don't queue overlapping smooth animations.
    el.scrollTop = el.scrollHeight
  }, [conv.messages.length, conv.streamingText, conv.streamingThinking])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    // 80px slack so small upward nudges don't break the stick.
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom < 80
  }

  const rendered = useMemo(() => {
    return conv.messages.map((m, idx) => {
      const isStreaming = m.id === conv.streamingMessageId
      // While streaming, splice in synthetic blocks for the live buffers so
      // the user sees them inline alongside any committed blocks. Thinking
      // comes BEFORE text because pi-mono always thinks first within a hop.
      const synthetic: Block[] = []
      if (isStreaming && conv.streamingThinking.length > 0) {
        synthetic.push({ kind: "thinking", text: conv.streamingThinking })
      }
      if (isStreaming && conv.streamingText.length > 0) {
        synthetic.push({
          kind: "text",
          text: conv.streamingText.replace(/^\s+/, ""),
        })
      }
      const blocks: Block[] = synthetic.length
        ? [...m.blocks, ...synthetic]
        : m.blocks
      // Find the user message that prompted this assistant message — the
      // closest preceding user msg in the list.
      let promptText: string | undefined
      if (m.role === "assistant") {
        for (let i = idx - 1; i >= 0; i--) {
          const prev = conv.messages[i]
          if (prev?.role === "user") {
            promptText = collectText(prev.blocks)
            break
          }
        }
      }
      return {
        id: m.id,
        role: m.role,
        blocks,
        pending: isStreaming,
        promptText,
        stats: conv.statsByMessageId[m.id],
      }
    })
  }, [
    conv.messages,
    conv.streamingMessageId,
    conv.streamingText,
    conv.streamingThinking,
    conv.statsByMessageId,
  ])

  const onSubmit = (text: string): void => {
    // Sending a new message means the user wants to see it land — even if
    // they had scrolled up to read earlier content.
    stickToBottomRef.current = true
    const opts: { model?: string; agentId?: string } = {}
    if (selectedModel) opts.model = selectedModel
    if (selectedAgent) opts.agentId = selectedAgent
    void chatStore.sendMessage(chatId, text, opts)
  }

  const onRetry = (promptText: string): void => {
    setSeed({ text: promptText, key: Date.now() })
  }

  const title = conv.title ?? "New chat"

  return (
    <div className="flex h-full flex-col">
      <Topbar title={title} />
      <main className="flex flex-1 flex-col overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto"
        >
          <div className="mx-auto w-full max-w-3xl px-2 pb-8 pt-4 sm:px-6">
            {rendered.map((m) => (
              <MessageBubble
                key={m.id}
                role={m.role === "user" ? "user" : "assistant"}
                blocks={m.blocks}
                pending={m.pending}
                {...(m.stats ? { stats: m.stats } : {})}
                {...(m.role === "assistant" && m.promptText
                  ? { onRetry: () => onRetry(m.promptText ?? "") }
                  : {})}
              />
            ))}
            <div ref={tailRef} aria-hidden />
          </div>
        </div>
        <div className="border-t border-border bg-background">
          <div className="mx-auto w-full max-w-3xl px-4 py-4">
            <Composer
              onSubmit={onSubmit}
              placeholder="Reply…"
              pending={Boolean(conv.streamingMessageId)}
              onStop={() => {
                void chatStore.interrupt(chatId)
              }}
              {...(seed ? { seed } : {})}
            />
          </div>
        </div>
      </main>
    </div>
  )
}
