import { useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Topbar } from "@/components/Topbar"
import { Composer } from "@/components/Composer"
import { MessageBubble } from "@/components/MessageBubble"
import { chatStore, useConversation, type Block } from "@/lib/chat-store"
import { useModels } from "@/lib/models"

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
  const { selected } = useModels()
  const tailRef = useRef<HTMLDivElement | null>(null)
  const [seed, setSeed] = useState<{ text: string; key: number } | undefined>()

  useEffect((): void => {
    void chatStore.loadConv(chatId)
  }, [chatId])

  useEffect((): void => {
    tailRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [conv.messages.length, conv.streamingText, conv.streamingThinking])

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
      }
    })
  }, [
    conv.messages,
    conv.streamingMessageId,
    conv.streamingText,
    conv.streamingThinking,
  ])

  const onSubmit = (text: string): void => {
    void chatStore.sendMessage(chatId, text, selected ? { model: selected } : {})
  }

  const onRetry = (promptText: string): void => {
    setSeed({ text: promptText, key: Date.now() })
  }

  const title = conv.title ?? "New chat"

  return (
    <div className="flex h-full flex-col">
      <Topbar title={title} />
      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-2 pb-6 pt-4 sm:px-6">
            {rendered.map((m) => (
              <MessageBubble
                key={m.id}
                role={m.role === "user" ? "user" : "assistant"}
                blocks={m.blocks}
                pending={m.pending}
                {...(m.role === "assistant" && m.promptText
                  ? { onRetry: () => onRetry(m.promptText ?? "") }
                  : {})}
              />
            ))}
            <div ref={tailRef} aria-hidden />
          </div>
        </div>
        <div className="border-t border-border bg-background/70 backdrop-blur-md">
          <div className="mx-auto w-full max-w-3xl px-4 py-4">
            <Composer onSubmit={onSubmit} placeholder="Reply…" seed={seed} />
          </div>
        </div>
      </main>
    </div>
  )
}
