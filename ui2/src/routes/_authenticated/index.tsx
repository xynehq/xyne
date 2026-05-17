import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Topbar } from "@/components/Topbar"
import { Composer } from "@/components/Composer"
import { EmptyState } from "@/components/EmptyState"
import { chatStore } from "@/lib/chat-store"
import { useModels } from "@/lib/models"

export const Route = createFileRoute("/_authenticated/")({
  component: NewChatRoute,
})

function NewChatRoute(): JSX.Element {
  const { me } = Route.useRouteContext()
  const navigate = useNavigate()
  const { selected } = useModels()

  const onSubmit = (text: string): void => {
    void (async (): Promise<void> => {
      // Placeholder title — backend replaces it with an AI-generated one
      // as soon as the first turn lands (via `conversation_renamed` SSE).
      const conv = await chatStore.createConv("New chat")
      void chatStore.sendMessage(
        conv.id,
        text,
        selected ? { model: selected } : {},
      )
      // Don't await — navigate immediately so the user sees the streaming UI.
      void navigate({ to: "/c/$chatId", params: { chatId: conv.id } })
    })()
  }

  return (
    <div className="flex h-full flex-col">
      <Topbar />
      <main className="flex flex-1 items-center justify-center px-6 pb-24 pt-8">
        <div className="flex w-full max-w-2xl flex-col">
          <EmptyState name={me.email} />
          <div className="mt-6">
            <Composer autoFocus onSubmit={onSubmit} hideDisclaimer />
          </div>
        </div>
      </main>
    </div>
  )
}
