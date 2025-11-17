import { createFileRoute } from "@tanstack/react-router"
import { ChatPage } from "@/routes/_authenticated/chat"
import { api } from "@/api"
import { errorComponent } from "@/components/error"

function ChatPageWrapper() {
  const { user, workspace, agentWhiteList } = Route.useRouteContext()
  return (
    <ChatPage
      user={user}
      workspace={workspace}
      agentWhiteList={agentWhiteList}
    />
  )
}

export const Route = createFileRoute("/_authenticated/chat/$chatId")({
  component: ChatPageWrapper,
  loader: async ({ params }) => {
    try {
      const res = await api.chat.$post({
        json: {
          chatId: params.chatId,
        },
      })

      return await res.json()
    } catch (error) {
      return { error }
    }
  },
  errorComponent: errorComponent,
})
