import { InfiniteData } from "@tanstack/react-query"
import { SelectPublicChat } from "shared/types"

export function updateChatBookmarkInCache(
  oldData: InfiniteData<SelectPublicChat[]> | undefined,
  chatId: string,
  bookmark: boolean
): InfiniteData<SelectPublicChat[]> | undefined {
  if (!oldData) return oldData
  const newPages = oldData.pages.map((page) =>
    page.map((chat) =>
      chat.externalId === chatId
        ? { ...chat, isBookmarked: bookmark }
        : chat,
    ),
  )
  return { ...oldData, pages: newPages }
}