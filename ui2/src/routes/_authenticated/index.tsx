import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Topbar } from "@/components/Topbar"
import { Composer } from "@/components/Composer"
import { EmptyState } from "@/components/EmptyState"
import { chatStore } from "@/lib/chat-store"
import { useModels } from "@/lib/models"
import { useAgents } from "@/lib/agents"

export const Route = createFileRoute("/_authenticated/")({
  component: NewChatRoute,
})

function NewChatRoute(): JSX.Element {
  const { me } = Route.useRouteContext()
  const navigate = useNavigate()
  const { selected: selectedModel } = useModels()
  const { selected: selectedAgent } = useAgents()

  const onSubmit = (text: string): void => {
    void (async (): Promise<void> => {
      // Placeholder title — backend replaces it with an AI-generated one
      // as soon as the first turn lands (via `conversation_renamed` SSE).
      const conv = await chatStore.createConv("New chat")
      const opts: { model?: string; agentId?: string } = {}
      if (selectedModel) opts.model = selectedModel
      if (selectedAgent) opts.agentId = selectedAgent
      void chatStore.sendMessage(conv.id, text, opts)
      // Don't await — navigate immediately so the user sees the streaming UI.
      void navigate({ to: "/c/$chatId", params: { chatId: conv.id } })
    })()
  }

  return (
    <div className="flex h-full flex-col">
      <Topbar title="New chat" />
      <main className="flex flex-1 flex-col">
        <div className="flex flex-1 items-center justify-center px-6 py-8">
          <EmptyState name={me.email} />
        </div>
        <div className="border-t border-border bg-background/70 backdrop-blur-md">
          <div className="mx-auto w-full max-w-3xl px-4 py-4">
            <Composer autoFocus onSubmit={onSubmit} />
          </div>
        </div>
      </main>
    </div>
  )
}
