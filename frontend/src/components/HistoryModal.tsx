import { api } from "@/api"
import ChatItem from "@/components/ChatItem"
import {
  InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { SelectPublicChat } from "shared/types"
import { X, Bookmark, List } from "lucide-react"
import { useNavigate, useRouter } from "@tanstack/react-router"

import { useEffect, useRef, useState } from "react"
import { LoaderContent } from "@/lib/common"
import { toast } from "@/hooks/use-toast"
import { updateChatBookmarkInCache } from "@/lib/chatCacheUtils"

export const pageSize = 21

export const fetchChats = async ({ pageParam = 0 }: { pageParam?: number }) => {
  let items = []
  const response = await api.chat.history.$get({
    query: {
      page: pageParam ?? 0,
    },
  })
  if (response.ok) {
    items = await response.json()
  }
  return items
}

export const renameChat = async (
  chatId: string,
  newTitle: string,
): Promise<{ chatId: string; title: string }> => {
  const res = await api.chat.rename.$post({
    json: { chatId, title: newTitle },
  })
  if (!res.ok) throw new Error(`Error renaming chat: ${res.status}`)
  return { chatId, title: newTitle }
}

// Add this mutation for toggling favourite
const toggleFavourite = async (chatId: string, bookmark: boolean) => {
  const res = await api.chat.bookmark.$post({
    json: { chatId, bookmark },
  })
    if (!res.ok) throw new Error(`Error updating favourite: ${res.status}`)
  return { chatId, bookmark }
}

const HistoryModal = ({
  onClose,
  pathname,
}: { onClose: () => void; pathname: string }) => {
  const queryClient = useQueryClient()
  const navigate = useNavigate({ from: "/" })

  const [isEditing, setIsEditing] = useState<boolean>(false)
  const [editedTitle, setEditedTitle] = useState<string>("")
  const [editedChatId, setEditedChatId] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)

  const historyRef = useRef<HTMLDivElement | null>(null)

  const favouriteMutation = useMutation<
    { chatId: string; bookmark: boolean },
    Error,
    { chatId: string; bookmark: boolean }
  >({
    mutationFn: ({ chatId, bookmark }) => toggleFavourite(chatId, bookmark),
    onSuccess: ({ chatId, bookmark }) => {
      queryClient.setQueryData<InfiniteData<SelectPublicChat[]>>(
         ["all-chats"],
      (oldData) => updateChatBookmarkInCache(oldData, chatId, bookmark)
    )
  },
   onError: (error: Error) => {
      toast({
        title: "Failed to update favourite",
        description: "Could not update favourite. Please try again.",
        variant: "destructive",
        duration: 2000,
      })
    },
  })

  const router = useRouter()
  const {
    isPending,
    error,
    data: historyItems,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery<
    SelectPublicChat[],
    Error,
    InfiniteData<SelectPublicChat[]>,
    ["all-chats"],
    number
  >({
    queryKey: ["all-chats"],
    queryFn: ({ pageParam = 0 }: { pageParam?: number }) =>
      fetchChats({ pageParam }),
    getNextPageParam: (lastPage, allPages) => {
      // lastPage?.length < pageSize becomes true, when there are no more pages
      if (lastPage?.length < pageSize) {
        return undefined
      }
      // Otherwise, next page = current number of pages fetched so far
      return allPages?.length
    },
    initialPageParam: 0,
  })

  const handleScroll = () => {
    if (!historyRef.current) return

    const { scrollTop, scrollHeight, clientHeight } = historyRef.current

    // If the user scrolled to bottom (or near bottom)
    if (scrollTop + clientHeight >= scrollHeight - 100 /* threshold */) {
      if (hasNextPage && !isFetchingNextPage) {
        fetchNextPage()
      }
    }
  }

  // Combine all pages of chats into a single array
  const chats = historyItems?.pages.flat() || []

  // Split chats into favourites and others
  const favouriteChats = chats.filter((chat) => chat.isBookmarked)
  const otherChats = chats.filter((chat) => !chat.isBookmarked)


  let existingChatId = ""
  if (pathname.startsWith("/chat/")) {
    existingChatId = pathname.substring(6)
  }

  useEffect(() => {
    // Only run if there's still more pages and we're not already fetching
    if (hasNextPage && !isFetchingNextPage) {
      const el = historyRef.current
      if (!el) return

      // Check if there's no scrollbar (meaning scrollHeight <= clientHeight)
      if (el.scrollHeight - 100 <= el.clientHeight) {
        fetchNextPage()
      }
    }
  }, [chats, hasNextPage, isFetchingNextPage, fetchNextPage])

  const deleteChat = async (chatId: string): Promise<string> => {
    const res = await api.chat.delete.$post({
      json: { chatId },
    })
    if (!res.ok) throw new Error("Error deleting chat")
    return chatId
  }

  const mutation = useMutation<string, Error, string>({
    mutationFn: deleteChat,
    onSuccess: (chatId: string) => {
      queryClient.setQueryData<InfiniteData<SelectPublicChat[]>>(
        ["all-chats"],
        (oldData) => {
          if (!oldData) return oldData

          const newPages = oldData.pages.map((page) =>
            page.filter((chat) => chat.externalId !== chatId),
          )
          return { ...oldData, pages: newPages }
        },
      )

      // If the deleted chat is opened and it's deleted, then user should be taken back to '/'
      if (existingChatId === chatId) {
        navigate({ to: "/" })
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to delete chat",
        description: "Could not delete chat. Please try again.",
        variant: "destructive",
        duration: 2000,
      })
    },
  })

  const renameChatMutation = useMutation<
    { chatId: string; title: string }, // The type of data returned from the mutation
    Error, // The type of error
    { chatId: string; newTitle: string } // The type of variables passed to the mutation
  >({
    mutationFn: async ({ chatId, newTitle }) => {
      return await renameChat(chatId, newTitle)
    },
    onSuccess: ({ chatId, title }) => {
      queryClient.setQueryData<InfiniteData<SelectPublicChat[]>>(
        ["all-chats"],
        (oldData) => {
          if (!oldData) return oldData

          let chatToUpdate: SelectPublicChat | undefined
          oldData.pages.forEach((page) => {
            const found = page.find((c) => c.externalId === chatId)
            if (found) chatToUpdate = found
          })

          if (!chatToUpdate) {
            return oldData
          }

          const updatedChat = { ...chatToUpdate, title }

          // Remove the old version from all pages
          const filteredPages = oldData.pages.map((page) =>
            page.filter((c) => c.externalId !== chatId),
          )

          // Insert the updated chat at the front of the first page
          const newPages = [
            [updatedChat, ...filteredPages[0]],
            ...filteredPages.slice(1),
          ]

          return {
            ...oldData,
            pages: newPages,
          }
        },
      )
      setIsEditing(false)
    },
  onError: (error: Error) => {
    setIsEditing(false)
    toast({
      title: "Failed to rename chat",
      description: "Could not rename chat. Please try again.",
      variant: "destructive",
      duration: 2000,
    })
  },
  })


  const handleKeyDown = async (
    e: React.KeyboardEvent<HTMLInputElement>,
    item: SelectPublicChat,
  ) => {
    if (e.key === "Enter") {
      e.preventDefault()
      if (editedTitle && editedTitle !== item.title) {
        renameChatMutation.mutate({
          chatId: item?.externalId,
          newTitle: editedTitle,
        })
      }
    } else if (e.key === "Escape") {
      e.preventDefault()
      setEditedTitle(item.title) // Revert to original title
      setIsEditing(false)
      if (titleRef.current) {
        titleRef.current.value = item.title // Revert UI to original title
      }
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEditedTitle(e.target.value) // Update state with edited content
  }

  const handleBlur = (item: SelectPublicChat) => {
    if (editedTitle !== item.title) {
      // Revert to original title if editing is canceled
      setEditedTitle(item.title)
      if (titleRef.current) {
        titleRef.current.value = item.title // Revert UI to original title
      }
    }
    setIsEditing(false) // Exit editing mode
  }

  return (
    <div className="fixed left-[52px] top-0 min-w-[200px] w-1/6 max-w-[300px] h-full border-r-[0.5px] border-[#D7E0E9] flex flex-col select-none bg-white">
      <div className="flex justify-between items-center ml-[18px] mt-[14px]">
        <p className="text-[#1C1D1F] font-medium text-[16px]">Chat History</p>
        <button
          onClick={onClose}
          className="flex items-center justify-center bg-[#F0F5F7] rounded-full w-[24px] h-[24px] mr-[14px] border-[0.5px] border-[#D7E0E9]"
        >
          <X stroke="#4A4F59" size={14} />
        </button>
      </div>
      <div
        ref={historyRef}
        className="flex-1 overflow-auto mt-[15px]"
        onScroll={handleScroll}
      >
        {error ? (
          <p className="text-center">Something went wrong...</p>
        ) : !chats.length && (isPending || isFetching) ? (
          <LoaderContent />
        ) : (
          <>
            {/* Favourites Section */}
            <div>
              <div className="flex items-center gap-1 px-[16px] mt-2 mb-1">
                <Bookmark size={14} className="text-[#929FBA]" />
                <p className="text-[#929FBA] font-semibold text-[12px] tracking-[0.05em] uppercase">Favourites</p>
              </div>

              <ul>
                {favouriteChats.length === 0 && (
                  <li className="text-[13px] text-[#B2C3D4] px-[16px] py-[6px]">No favourite chats</li>
                )}
                {favouriteChats.map((item) => (
                  <ChatItem 
                    key={`fav-${item.externalId}`} 
                    item={item} 
                    existingChatId={existingChatId} 
                    isEditing={isEditing} 
                    editedChatId={editedChatId} 
                    editedTitle={editedTitle} 
                    setEditedTitle={setEditedTitle} 
                    setEditedChatId={setEditedChatId} 
                    setIsEditing={setIsEditing} 
                    handleInput={handleInput} 
                    handleBlur={handleBlur} 
                    handleKeyDown={handleKeyDown} 
                    mutation={mutation} 
                    favouriteMutation={favouriteMutation} 
                    router={router} 
                    titleRef={titleRef} 
                  />
                ))}
              </ul>
            </div>

            {/* All Chats Section */}
            <div>
              <div className="flex items-center gap-1 px-[16px] mt-4 mb-1">
                <List size={14} className="text-[#929FBA]" />
                <p className="text-[#929FBA] font-semibold text-[12px] tracking-[0.05em] uppercase">All Chats</p>
              </div>
            </div>
            <ul>
              {otherChats.length === 0 && (
                <li className="text-[13px] text-[#B2C3D4] px-[16px] py-[6px]">No chats</li>
              )}
              {otherChats.map((item) => (
                <ChatItem 
                  key={item.externalId} 
                  item={item} 
                  existingChatId={existingChatId} 
                  isEditing={isEditing} 
                  editedChatId={editedChatId} 
                  editedTitle={editedTitle} 
                  setEditedTitle={setEditedTitle} 
                  setEditedChatId={setEditedChatId} 
                  setIsEditing={setIsEditing} 
                  handleInput={handleInput} 
                  handleBlur={handleBlur} 
                  handleKeyDown={handleKeyDown} 
                  mutation={mutation} 
                  favouriteMutation={favouriteMutation} 
                  router={router} 
                  titleRef={titleRef} 
                />
              ))}
            </ul>
            {isFetchingNextPage && <LoaderContent />}
          </>
        )}
      </div>
    </div>
  )
}

export default HistoryModal
