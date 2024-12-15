import { api } from "@/api"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { SelectPublicChat } from "shared/types"
import { Trash2, MoreHorizontal, X, Pencil } from "lucide-react"
import { useNavigate, useRouter } from "@tanstack/react-router"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { useRef, useState } from "react"

export const fetchChats = async () => {
  let items = []
  const response = await api.chat.history.$get({
    query: {
      page: 0,
    },
  })
  if (response.ok) {
    items = await response.json()
  }
  return items
}

const HistoryModal = ({
  onClose,
  pathname,
}: { onClose: () => void; pathname: string }) => {
  const queryClient = useQueryClient()
  const navigate = useNavigate({ from: "/" })

  const [isEditing, setIsEditing] = useState(false)
  const [editedTitle, setEditedTitle] = useState("")
  const [editedChatId, setEditedChatId] = useState(null)
  const spanRef = useRef(null)

  const router = useRouter()
  const {
    isPending,
    error,
    data: historyItems,
  } = useQuery<SelectPublicChat[]>({
    queryKey: ["all-connectors"],
    queryFn: fetchChats,
  })

  let existingChatId = ""
  if (pathname.startsWith("/chat/")) {
    existingChatId = pathname.substring(6)
  }

  const deleteChat = async (chatId: string): Promise<string> => {
    const res = await api.chat.delete.$post({
      json: { chatId },
    })
    if (!res.ok) throw new Error("Error deleting chat")
    return chatId
  }

  const renameChat = async (
    chatId: string,
    newTitle: string,
  ): Promise<{ chatId: string; title: string }> => {
    const res = await api.chat.rename.$post({
      json: { chatId, title: newTitle },
    })
    if (!res.ok) throw new Error("Error renaming chat")
    return { chatId, title: newTitle }
  }

  const mutation = useMutation<string, Error, string>({
    mutationFn: deleteChat,
    onSuccess: (chatId: string) => {
      // Update the UI by removing the deleted chat
      queryClient.setQueryData<SelectPublicChat[]>(
        ["all-connectors"],
        (oldChats) =>
          oldChats ? oldChats.filter((chat) => chat.externalId !== chatId) : [],
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
      // Update the UI by renaming the chat
      queryClient.setQueryData<SelectPublicChat[]>(
        ["all-connectors"],
        (oldChats) => {
          if (!oldChats) return []

          // Update the title of the targeted chat
          const updatedChats = oldChats.map((chat) =>
            chat.externalId === chatId ? { ...chat, title } : chat,
          )

          // Find the index of the renamed chat
          const index = updatedChats.findIndex(
            (chat) => chat.externalId === chatId,
          )
          if (index > -1) {
            // Remove it from its current position
            const [renamedChat] = updatedChats.splice(index, 1)
            // Place it at the front
            updatedChats.unshift(renamedChat)
          }

          return updatedChats
        },
      )
      setIsEditing(false)
    },
    onError: (error: Error) => {
      setIsEditing(false)
      console.error("Failed to rename chat:", error)
    },
  })

  if (error) {
    return <p>Something went wrong...</p>
  }
  if (isPending) {
    return <p>Loading...</p>
  }

  const handleKeyDown = async (e, item) => {
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
      if (spanRef.current) {
        spanRef.current.value = item.title // Revert UI to original title
      }
    }
  }

  const handleInput = (e) => {
    setEditedTitle(e.target.value) // Update state with edited content
  }

  const handleBlur = (item) => {
    if (editedTitle !== item.title) {
      // Revert to original title if editing is canceled
      setEditedTitle(item.title)
      if (spanRef.current) {
        spanRef.current.value = item.title // Revert UI to original title
      }
    }
    setIsEditing(false) // Exit editing mode
  }

  return (
    <div className="fixed left-[58px] top-0 max-w-sm w-[300px] h-[calc(100%-18px)] m-[6px] bg-[#F7FAFC] border-[0.5px] border-[#D7E0E9] rounded-[12px] flex flex-col select-none">
      <div className="flex justify-between items-center ml-[18px] mt-[14px]">
        <p className="text-lg text-[#1C1E1F] font-semibold text-[15px]">
          Chat History
        </p>
        <button
          onClick={onClose}
          className="flex items-center justify-center bg-white rounded-full w-[24px] h-[24px] mr-[14px] border-[0.5px] border-[#D7E0E9]"
        >
          <X stroke="#9EB6CE" size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-auto mt-[15px]">
        <ul>
          {historyItems.map((item, index) => (
            <li
              key={index}
              className={`group flex justify-between items-center ${item.externalId === existingChatId ? "bg-[#EBEFF2]" : ""} hover:bg-[#EBEFF2] rounded-[6px] pt-[8px] pb-[8px] ml-[8px] mr-[8px]`}
            >
              {isEditing && editedChatId === item.externalId ? (
                <input
                  ref={spanRef}
                  className="text-[14px] pl-[10px] pr-[10px] truncate cursor-pointer flex-grow"
                  type="text"
                  value={editedTitle}
                  onChange={(e) => handleInput(e)}
                  onBlur={() => handleBlur(item)}
                  onKeyDown={(e) => handleKeyDown(e, item)}
                  autoFocus
                />
              ) : (
                <span
                  className="text-[14px] pl-[10px] pr-[10px] truncate cursor-pointer"
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
                    key={"delete"}
                    className="flex text-[14px] py-[8px] px-[10px] hover:bg-[#EBEFF2] items-center"
                    onClick={() => {
                      mutation.mutate(item?.externalId)
                    }}
                  >
                    <Trash2 size={16} className="text-red-500" />
                    <span className="text-red-500">Delete</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    key={"rename"}
                    className="flex text-[14px] py-[8px] px-[10px] hover:bg-[#EBEFF2] items-center"
                    onClick={() => {
                      setEditedTitle(item.title) // Set the current title for editing
                      setEditedChatId(item.externalId) // Track the chat being edited
                      setIsEditing(true)
                      setTimeout(() => {
                        if (spanRef.current) {
                          spanRef.current.focus()
                        }
                      }, 0)
                    }}
                  >
                    <Pencil size={16} />
                    <span>Rename</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export default HistoryModal
