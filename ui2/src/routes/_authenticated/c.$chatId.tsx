import { useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Topbar } from "@/components/Topbar"
import { Composer } from "@/components/Composer"
import {
  MessageBubble,
  type FeedbackRating,
} from "@/components/MessageBubble"
import {
  FeedbackModal,
  type FeedbackSubmission,
} from "@/components/FeedbackModal"
import { CitationPanel } from "@/components/CitationPanel"
import { DebugDock } from "@/components/DebugDock"
import {
  setCollapsed as setCitationCollapsed,
  setScope as setCitationScope,
  useCitationStore,
} from "@/lib/citation-store"
import { ArrowDown, PanelRightOpen } from "lucide-react"
import { chatStore, useConversation, type Block } from "@/lib/chat-store"
import { useModels } from "@/lib/models"
import { useAgents } from "@/lib/agents"
import { useThinking, type ThinkingLevel } from "@/lib/thinking"

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
  const { level: thinkingLevel } = useThinking()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const tailRef = useRef<HTMLDivElement | null>(null)
  const isAtBottomRef = useRef(true)
  const [showJumpPill, setShowJumpPill] = useState(false)
  const [seed, setSeed] = useState<{ text: string; key: number } | undefined>()
  // Feedback modal — opened by a thumb click on an assistant message. We
  // store the target id + the rating the user clicked so the modal can
  // pre-select it. Null means closed.
  const [feedbackTarget, setFeedbackTarget] = useState<{
    messageId: string
    rating: FeedbackRating
  } | null>(null)

  useEffect((): (() => void) | void => {
    void chatStore.loadConv(chatId)
    isAtBottomRef.current = true
    setShowJumpPill(false)
    setCitationScope(chatId)
    return (): void => {
      chatStore.closeStream(chatId)
      setCitationScope(null)
    }
  }, [chatId])

  useEffect((): (() => void) | void => {
    const scroll = scrollRef.current
    const tail = tailRef.current
    if (!scroll || !tail) return

    const io = new IntersectionObserver(
      (entries): void => {
        const entry = entries[0]
        if (!entry) return
        isAtBottomRef.current = entry.isIntersecting
        setShowJumpPill(!entry.isIntersecting)
      },
      { root: scroll, rootMargin: "0px 0px 80px 0px", threshold: 0 },
    )
    io.observe(tail)

    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0) {
        isAtBottomRef.current = false
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") {
        isAtBottomRef.current = false
      }
    }
    let touchStartY: number | null = null
    const onTouchStart = (e: TouchEvent): void => {
      touchStartY = e.touches[0]?.clientY ?? null
    }
    const onTouchMove = (e: TouchEvent): void => {
      if (touchStartY === null) return
      const y = e.touches[0]?.clientY ?? null
      if (y === null) return
      if (y - touchStartY > 8) {
        isAtBottomRef.current = false
        touchStartY = null
      }
    }

    scroll.addEventListener("wheel", onWheel, { passive: true })
    scroll.addEventListener("keydown", onKey)
    scroll.addEventListener("touchstart", onTouchStart, { passive: true })
    scroll.addEventListener("touchmove", onTouchMove, { passive: true })

    return (): void => {
      io.disconnect()
      scroll.removeEventListener("wheel", onWheel)
      scroll.removeEventListener("keydown", onKey)
      scroll.removeEventListener("touchstart", onTouchStart)
      scroll.removeEventListener("touchmove", onTouchMove)
    }
  }, [chatId])

  useEffect((): void => {
    if (!isAtBottomRef.current) return
    const tail = tailRef.current
    if (!tail) return
    tail.scrollIntoView({ block: "end", behavior: "instant" as ScrollBehavior })
  }, [
    conv.messages.length,
    conv.streamingMessageId,
    conv.streamingText,
    conv.streamingThinking,
  ])

  const jumpToLatest = (): void => {
    isAtBottomRef.current = true
    setShowJumpPill(false)
    tailRef.current?.scrollIntoView({ block: "end", behavior: "smooth" })
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
      } else if (
        isStreaming &&
        m.blocks.length === 0 &&
        conv.streamingText.length === 0
      ) {
        synthetic.push({ kind: "thinking", text: "" })
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
        runId: m.runId,
        feedback: conv.feedbackByMessageId[m.id],
      }
    })
  }, [
    conv.messages,
    conv.streamingMessageId,
    conv.streamingText,
    conv.streamingThinking,
    conv.statsByMessageId,
    conv.feedbackByMessageId,
  ])

  const onSubmit = (text: string): void => {
    isAtBottomRef.current = true
    setShowJumpPill(false)
    const opts: {
      model?: string
      agentId?: string
      thinkingLevel?: ThinkingLevel
    } = {}
    if (selectedModel) opts.model = selectedModel
    if (selectedAgent) opts.agentId = selectedAgent
    opts.thinkingLevel = thinkingLevel
    void chatStore.sendMessage(chatId, text, opts)
  }

  const onRetry = (promptText: string): void => {
    setSeed({ text: promptText, key: Date.now() })
  }

  const onFeedbackClick = (messageId: string, rating: FeedbackRating): void => {
    setFeedbackTarget({ messageId, rating })
  }

  const onFeedbackSubmit = async (
    payload: FeedbackSubmission,
  ): Promise<void> => {
    if (!feedbackTarget) return
    await chatStore.submitFeedback(chatId, feedbackTarget.messageId, payload)
  }

  const title = conv.title ?? "New chat"
  const citationView = useCitationStore()
  // When tabs exist but the panel is hidden, surface a small "show panel"
  // affordance on the right side of the chat Topbar so the user can bring
  // the viewer back without losing the per-conversation tab state.
  const showPanelToggle =
    citationView.collapsed && citationView.tabs.length > 0

  return (
    <div className="flex h-full">
      {/* Chat column — shrinks to make room for the CitationPanel when a
          citation is open. min-w-0 lets the chat flex below its content
          intrinsic width so messages wrap inside the narrower column. */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
      <Topbar
        title={title}
        {...(showPanelToggle
          ? {
              rightSlot: (
                <button
                  type="button"
                  aria-label={`Show source panel (${String(citationView.tabs.length)} open)`}
                  onClick={(): void => {
                    setCitationCollapsed(false)
                  }}
                  className="ml-2 flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1 text-[11.5px] text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                >
                  <PanelRightOpen
                    className="h-3.5 w-3.5"
                    aria-hidden
                    strokeWidth={1.75}
                  />
                  <span className="font-medium">
                    Sources · {String(citationView.tabs.length)}
                  </span>
                </button>
              ),
            }
          : {})}
      />
      <main className="flex flex-1 flex-col overflow-hidden">
        <div
          ref={scrollRef}
          tabIndex={0}
          className="flex-1 overflow-y-auto focus:outline-none"
        >
          <div
            ref={contentRef}
            className="mx-auto w-full max-w-3xl px-2 pb-8 pt-4 sm:px-6"
          >
            {rendered.map((m) => (
              <MessageBubble
                key={m.id}
                role={m.role === "user" ? "user" : "assistant"}
                blocks={m.blocks}
                pending={m.pending}
                conversationId={chatId}
                {...(m.runId ? { runId: m.runId } : {})}
                {...(m.stats ? { stats: m.stats } : {})}
                {...(m.role === "assistant" && m.promptText
                  ? { onRetry: () => onRetry(m.promptText ?? "") }
                  : {})}
                {...(m.role === "assistant" && !m.pending
                  ? {
                      onFeedback: (rating: FeedbackRating) =>
                        onFeedbackClick(m.id, rating),
                      ...(m.feedback ? { feedback: m.feedback } : {}),
                    }
                  : {})}
              />
            ))}
            <div ref={tailRef} aria-hidden />
          </div>
        </div>
        <div className="relative bg-background/70 backdrop-blur-md">
          {showJumpPill ? (
            <button
              type="button"
              onClick={jumpToLatest}
              aria-label="Jump to latest"
              className="absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-full pb-2"
            >
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-elevated px-3 py-1 text-[11.5px] font-medium text-foreground shadow-md transition hover:bg-secondary">
                <ArrowDown className="h-3 w-3" aria-hidden strokeWidth={2} />
                Jump to latest
              </span>
            </button>
          ) : null}
          <div className="mx-auto w-full max-w-3xl px-4 pb-4">
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
      <CitationPanel />
      <DebugDock />
      <FeedbackModal
        open={feedbackTarget !== null}
        initialRating={feedbackTarget?.rating ?? "like"}
        onSubmit={onFeedbackSubmit}
        onClose={() => setFeedbackTarget(null)}
      />
    </div>
  )
}
