import { api } from "@/api"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { SelectPublicChat } from "shared/types"
import { Trash2, MoreHorizontal, X } from "lucide-react"
import { useRouter } from "@tanstack/react-router"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"

const fetchChats = async () => {
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

  const router = useRouter()
  const {
    isPending,
    error,
    data: historyItems,
  } = useQuery<SelectPublicChat[]>({
    queryKey: ["all-connectors"],
    queryFn: fetchChats,
  })

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
      // Update the UI by removing the deleted chat
      queryClient.setQueryData<SelectPublicChat[]>(
        ["all-connectors"],
        (oldChats) =>
          oldChats ? oldChats.filter((chat) => chat.externalId !== chatId) : [],
      )
    },
    onError: (error: Error) => {
      console.error("Failed to delete chat:", error)
    },
  })

  if (error) {
    return <p>Something went wrong...</p>
  }
  if (isPending) {
    return <p>Loading...</p>
  }
  let existingChatId = ""
  if (pathname.startsWith("/chat/")) {
    existingChatId = pathname.substring(6)
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
              <span
                className="text-[14px] pl-[10px] pr-[10px] truncate cursor-pointer"
                onClick={() => {
                  router.navigate({
                    to: "/chat/$chatId",
                    params: { chatId: item.externalId },
                  })
                  item.extenalId
                }}
              >
                {item.title}
              </span>
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
