import { SelectPublicChat } from "shared/types"
import { Trash2, MoreHorizontal, Pencil, Bookmark } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { MutableRefObject } from "react"
import { UseMutationResult } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router" 

interface ChatItemProps {
  item: SelectPublicChat
  existingChatId: string
  isEditing: boolean
  editedChatId: string | null
  editedTitle: string
  setEditedTitle: (title: string) => void
  setEditedChatId: (id: string | null) => void
  setIsEditing: (isEditing: boolean) => void
  handleInput: (e: React.ChangeEvent<HTMLInputElement>) => void
  handleBlur: (item: SelectPublicChat) => void
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>, item: SelectPublicChat) => void
  mutation: UseMutationResult<string, Error, string>
  favouriteMutation: UseMutationResult<
    { chatId: string; bookmark: boolean },
    Error,
    { chatId: string; bookmark: boolean }
  >
  router: ReturnType<typeof useRouter>  
  titleRef: MutableRefObject<HTMLInputElement | null>
}

const ChatItem = ({
  item,
  existingChatId,
  isEditing,
  editedChatId,
  editedTitle,
  setEditedTitle,
  setEditedChatId,
  setIsEditing,
  handleInput,
  handleBlur,
  handleKeyDown,
  mutation,
  favouriteMutation,
  router,
  titleRef,
}: ChatItemProps) => {
  return (
    <li
      className={`group flex justify-between items-center ${
        item.externalId === existingChatId ? "bg-[#EBEFF2]" : ""
      } hover:bg-[#EBEFF2] rounded-[6px] pt-[8px] pb-[8px] ml-[8px] mr-[8px]`}
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
              setEditedTitle(item.title)
              setEditedChatId(item.externalId)
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
          {item.isBookmarked ? (
            <DropdownMenuItem
              key={"unmark-fav"}
              className="flex text-[14px] py-[8px] px-[10px] hover:bg-[#EBEFF2] items-center"
              onClick={() => {
                favouriteMutation.mutate({
                  chatId: item.externalId,
                  bookmark: false,
                })
              }}
            >
              <Bookmark className="text-[#1C1D1F] fill-[#1C1D1F]" size={16} />
              <span>Unmark Favourite</span>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              key={"mark-fav"}
              className="flex text-[14px] py-[8px] px-[10px] hover:bg-[#EBEFF2] items-center"
              onClick={() => {
                favouriteMutation.mutate({
                  chatId: item.externalId,
                  bookmark: true,
                })
              }}
            >
              <Bookmark size={16} />
              <span>Mark Favourite</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

export default ChatItem
