import { api } from "@/api"
import {
  InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { SelectPublicChat } from "shared/types"
import { Trash2, MoreHorizontal, X, Pencil } from "lucide-react"
import { useNavigate, useRouter } from "@tanstack/react-router"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { useEffect, useRef, useState } from "react"
import { LoaderContent } from "@/routes/_authenticated/admin/integrations"

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
  if (!res.ok) throw new Error("Error renaming chat")
  return { chatId, title: newTitle }
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
      console.error("Failed to delete chat:", error)
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
      console.error("Failed to rename chat:", error)
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
    <div className="fixed left-[52px] top-0 max-w-sm w-[300px] h-full border-[0.5px] border-[#D7E0E9] flex flex-col select-none bg-white">
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
            <ul>
              {chats.map((item, index) => (
                <li
                  key={index}
                  className={`group flex justify-between items-center ${item.externalId === existingChatId ? "bg-[#EBEFF2]" : ""} hover:bg-[#EBEFF2] rounded-[6px] pt-[8px] pb-[8px] ml-[8px] mr-[8px]`}
                >
                  {isEditing && editedChatId === item.externalId ? (
                    <input
                      ref={titleRef}
                      className="text-[14px] pl-[10px] pr-[10px] truncate cursor-pointer flex-grow max-w-[250px]"
                      type="text"
                      value={editedTitle}
                      onChange={(e) => handleInput(e)}
                      onBlur={() => handleBlur(item)}
                      onKeyDown={(e) => handleKeyDown(e, item)}
                      autoFocus
                    />
                  ) : (
                    <span
                      className="text-[14px] pl-[10px] pr-[10px] truncate cursor-pointer flex-grow max-w-[250px]"
                      onClick={() => {
                        router.navigate({
                          to: "/chat/$chatId",
                          params: { chatId: item.externalId },
                        })
                      }}
                    >
                      {item.title}
                    </span>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <MoreHorizontal
                        size={16}
                        className={
                          "invisible group-hover:visible mr-[10px] cursor-pointer"
                        }
                      />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem
                        key={"rename"}
                        className="flex text-[14px] py-[8px] px-[10px] hover:bg-[#EBEFF2] items-center"
                        onClick={() => {
                          setEditedTitle(item.title) // Set the current title for editing
                          setEditedChatId(item.externalId) // Track the chat being edited
                          setIsEditing(true)
                          setTimeout(() => {
                            if (titleRef.current) {
                              titleRef.current.focus()
                            }
                          }, 0)
                        }}
                      >
                        <Pencil size={16} />
                        <span>Rename</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        key={"delete"}
                        className="flex text-[14px] py-[8px] px-[10px] hover:bg-[#EBEFF2] items-center"
                        onClick={() => {
                          mutation.mutate(item?.externalId)
                        }}
                      >
                        <Trash2 size={16} className="text-red-500" />
                        <span className="text-red-500">Delete</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
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
