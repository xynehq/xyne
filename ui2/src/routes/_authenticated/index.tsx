import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Composer } from "@/components/Composer"
import { EmptyState } from "@/components/EmptyState"
import { chatStore } from "@/lib/chat-store"
import { useModels } from "@/lib/models"
import { useAgents } from "@/lib/agents"
import { useThinking, type ThinkingLevel } from "@/lib/thinking"

export const Route = createFileRoute("/_authenticated/")({
  component: NewChatRoute,
})

function NewChatRoute(): JSX.Element {
  const { me } = Route.useRouteContext()
  const navigate = useNavigate()
  const { selected: selectedModel } = useModels()
  const { selected: selectedAgent } = useAgents()
  const { level: thinkingLevel } = useThinking()

  const onSubmit = (text: string): void => {
    void (async (): Promise<void> => {
      const conv = await chatStore.createConv("New chat")
      const opts: {
        model?: string
        agentId?: string
        thinkingLevel?: ThinkingLevel
      } = {}
      if (selectedModel) opts.model = selectedModel
      if (selectedAgent) opts.agentId = selectedAgent
      opts.thinkingLevel = thinkingLevel
      void chatStore.sendMessage(conv.id, text, opts)
      void navigate({ to: "/c/$chatId", params: { chatId: conv.id } })
    })()
  }

  return (
    <main className="flex h-full flex-1 items-center justify-center px-6 py-8">
      <div className="flex w-full max-w-2xl flex-col">
        <EmptyState name={me.email} />
        <div className="mt-6">
          <Composer autoFocus onSubmit={onSubmit} hideDisclaimer />
        </div>
      </div>
    </main>
  )
}
