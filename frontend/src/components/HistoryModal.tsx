import { api } from "@/api"
import {
  InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { SelectPublicChat } from "shared/types"
import { Trash2, MoreHorizontal, X, Pencil, Bot, Bookmark } from "lucide-react"
import { useNavigate, useRouter } from "@tanstack/react-router"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"
import { useTheme } from "@/components/ThemeContext"
import { LoaderContent } from "@/lib/common"
import { CLASS_NAMES } from "../lib/constants"

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

export const fetchFavoriteChats = async ({
  pageParam = 0,
}: {
  pageParam?: number
}) => {
  let items = []
  const response = await api.chat.favorites.$get({
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

export const bookmarkChat = async (
  chatId: string,
  isBookmarked: boolean,
): Promise<{ chatId: string; isBookmarked: boolean }> => {
  const res = await api.chat.bookmark.$post({
    json: { chatId, bookmark: isBookmarked },
  })
  if (!res.ok) throw new Error("Error bookmarking chat")
  return { chatId, isBookmarked }
}

const HistoryModal = ({
  onClose,
  pathname,
}: { onClose: () => void; pathname: string }) => {
  const { theme } = useTheme()
  const queryClient = useQueryClient()
  const navigate = useNavigate({ from: "/" })

  const [isEditing, setIsEditing] = useState<boolean>(false)
  const [editedTitle, setEditedTitle] = useState<string>("")
  const [editedChatId, setEditedChatId] = useState<string | null>(null)
  const [showAllFavorites, setShowAllFavorites] = useState(false)
  const titleRef = useRef<HTMLInputElement | null>(null)

  const historyRef = useRef<HTMLDivElement | null>(null)
  const favoriteHistoryRef = useRef<HTMLDivElement | null>(null)

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
      if (lastPage?.length < pageSize) {
        return undefined
      }
      return allPages?.length
    },
    initialPageParam: 0,
  })

  const {
    data: favoriteChatsData,
    fetchNextPage: fetchNextFavoritePage,
    hasNextPage: hasNextFavoritePage,
    isFetchingNextPage: isFetchingNextFavoritePage,
  } = useInfiniteQuery<
    SelectPublicChat[],
    Error,
    InfiniteData<SelectPublicChat[]>,
    ["favorite-chats"],
    number
  >({
    queryKey: ["favorite-chats"],
    queryFn: ({ pageParam = 0 }: { pageParam?: number }) =>
      fetchFavoriteChats({ pageParam }),
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage?.length < pageSize) {
        return undefined
      }
      return allPages?.length
    },
    initialPageParam: 0,
  })

  const handleScroll = () => {
    if (!historyRef.current) return

    const { scrollTop, scrollHeight, clientHeight } = historyRef.current

    if (scrollTop + clientHeight >= scrollHeight - 100) {
      if (hasNextPage && !isFetchingNextPage) {
        fetchNextPage()
      }
    }
  }

  const handleFavoriteScroll = () => {
    if (!favoriteHistoryRef.current) return

    const { scrollTop, scrollHeight, clientHeight } = favoriteHistoryRef.current

    if (scrollTop + clientHeight >= scrollHeight - 100) {
      if (hasNextFavoritePage && !isFetchingNextFavoritePage) {
        fetchNextFavoritePage()
      }
    }
  }

  const otherChats = historyItems?.pages.flat() || []
  const favouriteChats = favoriteChatsData?.pages.flat() || []
  const displayedFavouriteChats = showAllFavorites
    ? favouriteChats
    : favouriteChats.slice(0, 7)

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
  }, [otherChats, hasNextPage, isFetchingNextPage, fetchNextPage])

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
      queryClient.invalidateQueries({ queryKey: ["all-chats"] })
      queryClient.invalidateQueries({ queryKey: ["favorite-chats"] })

      if (existingChatId === chatId) {
        navigate({ to: "/" })
      }
    },
    onError: (error: Error) => {
      console.error("Failed to delete chat:", error)
    },
  })

  const bookmarkChatMutation = useMutation<
    { chatId: string; isBookmarked: boolean },
    Error,
    { chatId: string; isBookmarked: boolean },
    {
      previousAllChats: InfiniteData<SelectPublicChat[]> | undefined
      previousFavoriteChats: InfiniteData<SelectPublicChat[]> | undefined
    }
  >({
    mutationFn: async ({ chatId, isBookmarked }) => {
      return await bookmarkChat(chatId, isBookmarked)
    },
    onMutate: async ({ chatId, isBookmarked }) => {
      await queryClient.cancelQueries({ queryKey: ["all-chats"] })
      await queryClient.cancelQueries({ queryKey: ["favorite-chats"] })

      const previousAllChats = queryClient.getQueryData<
        InfiniteData<SelectPublicChat[]>
      >(["all-chats"])
      const previousFavoriteChats = queryClient.getQueryData<
        InfiniteData<SelectPublicChat[]>
      >(["favorite-chats"])

      queryClient.setQueryData<InfiniteData<SelectPublicChat[]>>(
        ["all-chats"],
        (oldData) => {
          if (!oldData) return oldData
          const newPages = oldData.pages.map((page) =>
            page.map((chat) =>
              chat.externalId === chatId ? { ...chat, isBookmarked } : chat,
            ),
          )
          return { ...oldData, pages: newPages }
        },
      )

      queryClient.setQueryData<InfiniteData<SelectPublicChat[]>>(
        ["favorite-chats"],
        (oldData) => {
          if (!oldData) return oldData

          let chat: SelectPublicChat | undefined
          if (previousAllChats) {
            for (const page of previousAllChats.pages) {
              const found = page.find((c) => c.externalId === chatId)
              if (found) {
                chat = { ...found, isBookmarked }
                break
              }
            }
          }

          if (isBookmarked) {
            // Add to favorites
            const newPages = [...oldData.pages]
            if (chat) {
              const isAlreadyFavorite = newPages.some((page) =>
                page.some((c) => c.externalId === chatId),
              )
              if (!isAlreadyFavorite) {
                newPages[0] = [chat, ...newPages[0]]
              }
            }
            return { ...oldData, pages: newPages }
          } else {
            // Remove from favorites
            const newPages = oldData.pages.map((page) =>
              page.filter((c) => c.externalId !== chatId),
            )
            return { ...oldData, pages: newPages }
          }
        },
      )

      return { previousAllChats, previousFavoriteChats }
    },
    onError: (err, variables, context) => {
      if (context?.previousAllChats) {
        queryClient.setQueryData(["all-chats"], context.previousAllChats)
      }
      if (context?.previousFavoriteChats) {
        queryClient.setQueryData(
          ["favorite-chats"],
          context.previousFavoriteChats,
        )
      }
      console.error("Failed to bookmark chat:", err)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["all-chats"] })
      queryClient.invalidateQueries({ queryKey: ["favorite-chats"] })
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
      queryClient.invalidateQueries({ queryKey: ["favorite-chats"] })
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

  const renderChatList = (list: SelectPublicChat[]) => {
    return (
      <ul className="space-y-[4px]">
        {list.map((item, index) => (
          <li
            key={index}
            className={`group flex justify-between items-center ${
              item.externalId === existingChatId
                ? "bg-[#EBEFF2] dark:bg-slate-700"
                : ""
            } ${item.externalId === existingChatId ? "" : "hover:bg-[#EBEFF2] dark:hover:bg-slate-500"} rounded-md py-2 mx-2 mb-1`}
          >
            {isEditing && editedChatId === item.externalId ? (
              <input
                ref={titleRef}
                className="text-[14px] dark:text-gray-100 dark:bg-transparent pl-[10px] pr-[10px] truncate cursor-pointer flex-grow max-w-[250px] outline-none"
                type="text"
                value={editedTitle}
                onChange={(e) => handleInput(e)}
                onBlur={() => handleBlur(item)}
                onKeyDown={(e) => handleKeyDown(e, item)}
                autoFocus
              />
            ) : (
              <span
                className="text-[14px] dark:text-gray-200 pl-[10px] pr-[10px] truncate cursor-pointer flex-grow max-w-[250px]"
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
            <div className="flex items-center">
              {item.agentId && (
                <Bot
                  size={16}
                  className="mr-2 text-[#1C1D1F] dark:text-gray-300"
                />
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
                    key={"bookmark"}
                    role="button"
                    className="flex text-[14px] py-[8px] px-[10px] hover:bg-[#EBEFF2] dark:hover:bg-slate-600 items-center"
                    onClick={() => {
                      bookmarkChatMutation.mutate({
                        chatId: item.externalId,
                        isBookmarked: !item.isBookmarked,
                      })
                    }}
                  >
                    <Bookmark
                      size={16}
                      fill={
                        item.isBookmarked
                          ? theme === "dark"
                            ? "#A0AEC0"
                            : "#4A4F59"
                          : "none"
                      }
                      stroke={theme === "dark" ? "#A0AEC0" : "#4A4F59"}
                    />
                    <span>{item.isBookmarked ? "Remove" : "Favourite"}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    key={"rename"}
                    role="button"
                    className="flex text-[14px] py-[8px] px-[10px] hover:bg-[#EBEFF2] dark:hover:bg-slate-600 items-center"
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
                    role="button"
                    className="flex text-[14px] py-[8px] px-[10px] hover:bg-[#EBEFF2] dark:hover:bg-slate-600 items-center"
                    onClick={() => {
                      mutation.mutate(item?.externalId)
                    }}
                  >
                    <Trash2
                      size={16}
                      className="text-red-500 dark:text-red-400"
                    />
                    <span className="text-red-500 dark:text-red-400">
                      Delete
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <div
      className={`fixed left-[52px] top-0 min-w-[200px] w-1/6 max-w-[300px] h-full border-r-[0.5px] border-[#D7E0E9] dark:border-gray-700 flex flex-col select-none bg-white dark:bg-[#1E1E1E] ${CLASS_NAMES.HISTORY_MODAL_CONTAINER}`}
    >
      <div className="flex justify-between items-center ml-[18px] mt-[14px]">
        <p className="text-[#1C1D1F] dark:text-gray-100 font-medium text-[16px]">
          Chat History
        </p>
        <button
          onClick={onClose}
          className="flex items-center justify-center bg-[#F0F5F7] dark:bg-slate-700 rounded-full w-[24px] h-[24px] mr-[14px] border-[0.5px] border-[#D7E0E9] dark:border-gray-700"
        >
          <X stroke="#4A4F59" className="dark:stroke-gray-300" size={14} />
        </button>
      </div>
      <div
        ref={historyRef}
        className="flex-1 overflow-auto mt-[15px]"
        onScroll={handleScroll}
      >
        {error ? (
          <p className="text-center dark:text-gray-300">
            Something went wrong...
          </p>
        ) : !otherChats.length && (isPending || isFetching) ? (
          <LoaderContent />
        ) : (
          <>
            <div
              ref={favoriteHistoryRef}
              className="overflow-auto"
              onScroll={handleFavoriteScroll}
            >
              <p className="text-[#1C1D1F] dark:text-gray-100 font-medium text-[14px] ml-[18px] mt-[10px]">
                Favourite Chats
              </p>
              {favouriteChats.length > 0 ? (
                <>
                  {renderChatList(displayedFavouriteChats)}
                  {favouriteChats.length > 7 && (
                    <div className="flex justify-end pr-[10px] mr-2 mt-2">
                      <button
                        onClick={() => setShowAllFavorites(!showAllFavorites)}
                        className="flex items-center text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 px-2 py-1 rounded-md border"
                      >
                        {showAllFavorites ? (
                          <>
                            Show Less
                            <ChevronUp size={16} className="ml-1" />
                          </>
                        ) : (
                          <>
                            Show More
                            <ChevronDown size={16} className="ml-1" />
                          </>
                        )}
                      </button>
                    </div>
                  )}
                  {isFetchingNextFavoritePage && <LoaderContent />}
                </>
              ) : (
                <p className="ml-[18px] text-sm text-gray-500 dark:text-gray-400 mt-2">
                  No favourite chat
                </p>
              )}
            </div>
            <p className="text-[#1C1D1F] dark:text-gray-100 font-medium text-[14px] ml-[18px] mt-[10px]">
              All Chats
            </p>
            {renderChatList(otherChats)}
            {isFetchingNextPage && <LoaderContent />}
          </>
        )}
      </div>
    </div>
  )
}

export default HistoryModal
