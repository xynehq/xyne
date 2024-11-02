import { getIcon } from "@/lib/common"
import type {
  Autocomplete,
  FileAutocomplete,
  MailAutocomplete,
  UserAutocomplete,
} from "shared/types"
import { ForwardedRef, forwardRef } from "react"

export const FileAutocompleteElement = ({
  result,
}: { result: FileAutocomplete }) => {
  return (
    <div className="flex items-center">
      {getIcon(result.app, result.entity)}
      <p>{result.title}</p>
    </div>
  )
}

export const MailAutocompleteElement = ({
  result,
}: { result: MailAutocomplete }) => {
  return (
    <div className="flex items-center">
      {getIcon(result.app, result.entity)}
      <p>{result.subject}</p>
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
      <p>{result.name || result.email}</p>
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
          className="flex cursor-pointer hover:bg-gray-100 px-4 py-2 no-underline text-inherit"
        >
          {content}
        </a>
      )
    } else if (result.type === "mail") {
      content = <MailAutocompleteElement result={result} />
    } else {
      throw new Error("invalid type")
    }
    return (
      <div
        ref={ref}
        onClick={onClick}
        // className="cursor-pointer hover:bg-gray-100 px-4 py-2"
        className="p-3 hover:bg-gray-100 cursor-pointer"
      >
        {content}
      </div>
    )
  },
)
