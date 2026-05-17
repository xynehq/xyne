import { useEffect, useState } from "react"
import { useLocation, useNavigate } from "@tanstack/react-router"
import {
  chatStore,
  useConversationList,
  type Conversation,
} from "@/lib/chat-store"

// Bundles every wiring the sidebar's chat history needs: the live list, the
// in-flight load flag, the active-route detection from the URL, and the four
// callbacks (create / select / rename / delete). The return shape lines up
// with Sidebar's chat-related props so the route can spread it directly.
type Result = {
  chats: Conversation[]
  activeChatId: string | undefined
  chatsLoading: boolean
  onCreateChat: () => void
  onSelectChat: (id: string) => void
  onRenameChat: (id: string, title: string) => Promise<void>
  onDeleteChat: (id: string) => Promise<void>
}

export function useChatHistory(): Result {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const chats = useConversationList()
  const [listLoaded, setListLoaded] = useState(false)
  const activeChatId = pathname.match(/^\/c\/([^/?#]+)/)?.[1]

  useEffect((): (() => void) => {
    let cancelled = false
    void chatStore.loadList().finally((): void => {
      if (!cancelled) setListLoaded(true)
    })
    return (): void => {
      cancelled = true
    }
  }, [])

  return {
    chats,
    activeChatId,
    chatsLoading: !listLoaded,
    onCreateChat: (): void => {
      void navigate({ to: "/" })
    },
    onSelectChat: (id: string): void => {
      void navigate({ to: "/c/$chatId", params: { chatId: id } })
    },
    onRenameChat: (id: string, title: string): Promise<void> =>
      chatStore.renameConv(id, title),
    onDeleteChat: async (id: string): Promise<void> => {
      await chatStore.deleteConv(id)
      if (id === activeChatId) {
        void navigate({ to: "/" })
      }
    },
  }
}
