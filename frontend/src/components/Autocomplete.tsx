import { getIcon } from "@/lib/common"
import type {
  Autocomplete,
  EventAutocomplete,
  FileAutocomplete,
  MailAttachmentAutocomplete,
  MailAutocomplete,
  UserAutocomplete,
  ChatUserAutocomplete,
  UserQueryHAutocomplete,
} from "shared/types"
import { ForwardedRef, forwardRef } from "react"
import { History } from "lucide-react"

export const FileAutocompleteElement = ({
  result,
}: { result: FileAutocomplete }) => {
  return (
    <div className="flex items-center">
      {getIcon(result.app, result.entity)}
      <p className="truncate">{result.title}</p>
    </div>
  )
}

export const MailAttachmentAutocompleteElement = ({
  result,
}: { result: MailAttachmentAutocomplete }) => {
  return (
    <div className="flex items-center">
      {getIcon(result.app, result.entity)}
      <p className="truncate">{result.filename}</p>
    </div>
  )
}

export const MailAutocompleteElement = ({
  result,
}: { result: MailAutocomplete }) => {
  return (
    <div className="flex items-center">
      {getIcon(result.app, result.entity)}
      <p className="truncate">{result.subject}</p>
    </div>
  )
}

export const EventAutocompleteElement = ({
  result,
}: { result: EventAutocomplete }) => {
  return (
    <div className="flex items-center">
      {getIcon(result.app, result.entity)}
      <p className="truncate">{result.name}</p>
    </div>
  )
}

export const UserAutocompleteElement = ({
  result,
}: { result: UserAutocomplete }) => {
  return (
    <div className="flex items-center">
      <img
        referrerPolicy="no-referrer"
        className="mr-2 w-[16px] h-[16px] rounded-full"
        src={result.photoLink}
      ></img>
      <p className="truncate">{result.name || result.email}</p>
    </div>
  )
}
export const ChatUserAutocompleteElement = ({
  result,
}: { result: ChatUserAutocomplete }) => {
  return (
    <div className="flex items-center">
      <img
        referrerPolicy="no-referrer"
        className="mr-2 w-[16px] h-[16px] rounded-full"
        src={result.image}
      ></img>
      <p className="truncate">{result.name || result.email}</p>
    </div>
  )
}
export const UserQueryHistoryAutocompleteElement = ({
  result,
  onClick,
}: { result: UserQueryHAutocomplete; onClick: () => void }) => {
  return (
    <div onClick={onClick} className="flex items-center">
      <History
        color="#AEBAD3"
        size={16}
        className="mr-[10px] dark:text-[#F1F3F4]"
      />
      <p>{result.query_text}</p>
    </div>
  )
}

export const AutocompleteElement = forwardRef(
  (
    { result, onClick }: { result: Autocomplete; onClick: any },
    ref: ForwardedRef<any>,
  ) => {
    let content
    if (result.type === "file") {
      content = <FileAutocompleteElement result={result} />
    } else if (result.type === "user") {
      content = <UserAutocompleteElement result={result} />
      return (
        <a
          href={`https://contacts.google.com/${result.email}`}
          ref={ref}
          onClick={onClick}
          className="flex cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 px-4 py-2 no-underline text-inherit"
        >
          {content}
        </a>
      )
    } else if (result.type === "mail") {
      content = <MailAutocompleteElement result={result} />
    } else if (result.type === "event") {
      content = <EventAutocompleteElement result={result} />
    } else if (result.type === "user_query") {
      content = (
        <UserQueryHistoryAutocompleteElement
          onClick={onClick}
          result={result}
        />
      )
    } else if (result.type === "mail_attachment") {
      content = <MailAttachmentAutocompleteElement result={result} />
    } else if (result.type === "chat_user") {
      content = <ChatUserAutocompleteElement result={result} />
    } else {
      throw new Error("invalid type")
    }
    return (
      <div
        ref={ref}
        onClick={onClick}
        // className="cursor-pointer hover:bg-gray-100 px-4 py-2"
        className="p-3 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
      >
        {content}
      </div>
    )
  },
)
