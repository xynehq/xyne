import { useEffect, useMemo, useState } from "react"
import { useLocation, useNavigate } from "@tanstack/react-router"
import {
  chatStore,
  useConversationList,
  type Conversation,
} from "@/lib/chat-store"
import { usePreferences } from "@/lib/preferences"

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
  const allChats = useConversationList()
  const { hideProjectChatsInRecents } = usePreferences()
  // When the user has opted in (default), chats already filed into a project
  // drop out of the Recents stream — the projects sidebar section + project
  // pages become the canonical surface for them. Toggle off in /account to
  // see every chat in one list.
  const chats = useMemo(
    () =>
      hideProjectChatsInRecents
        ? allChats.filter((c) => !c.folderId)
        : allChats,
    [allChats, hideProjectChatsInRecents],
  )
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
