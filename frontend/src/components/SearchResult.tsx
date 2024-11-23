import HighlightedText from "@/components/Highlight"
import { getIcon } from "@/lib/common"
import { SearchResultDiscriminatedUnion } from "@/server/shared/types"

export const SearchResult = ({
  result,
  index,
}: { result: SearchResultDiscriminatedUnion; index: number }) => {
  let content = <></>
  let commonClassVals = "pr-[60px]"
  if (result.type === "file") {
    content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start space-x-2">
          <a
            href={result.url ?? ""}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-blue-800 space-x-2"
          >
            {getIcon(result.app, result.entity, { w: 24, h: 24, mr: 20 })}
            {result.title}
          </a>
        </div>
        <div className="flex flex-row items-center mt-1 ml-[44px]">
          <img
            referrerPolicy="no-referrer"
            className="mr-2 w-[16px] h-[16px] rounded-full"
            src={result.photoLink ?? ""}
          ></img>
          <a
            target="_blank"
            className="text-[#2067F5]"
            rel="noopener noreferrer"
            href={`https://contacts.google.com/${result.ownerEmail}`}
          >
            <p className="text-left text-sm pt-1 text-[#464B53]">
              {result.owner}
            </p>
          </a>
        </div>
        {result.chunks_summary &&
          result.chunks_summary?.length &&
          result.chunks_summary
            .slice(0, 1)
            .map((summary) => <HighlightedText chunk_summary={summary} />)}
      </div>
    )
  } else if (result.type === "user") {
    content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start">
          <a
            href={`https://contacts.google.com/${result.email}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-[#2067F5]"
          >
            {/* TODO: if photoLink doesn't exist then show icon */}
            <img
              referrerPolicy="no-referrer"
              className="mr-2 w-[16px] h-[16px] rounded-full"
              src={result.photoLink}
            ></img>
            {result.name || result.email}
          </a>
        </div>
      </div>
    )
  } else if (result.type === "mail") {
    content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start">
          {getIcon(result.app, result.entity, { w: 24, h: 24, mr: 20 })}
          <a
            href={`https://mail.google.com/mail/u/0/#inbox/${result.docId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-[#2067F5]"
          >
            {/* TODO: if photoLink doesn't exist then show icon */}
            {/* <img
              referrerPolicy="no-referrer"
              className="mr-2 w-[16px] h-[16px] rounded-full"
              src={result.photoLink}
            ></img> */}
            {result.subject}
          </a>
        </div>
        {result.chunks_summary &&
          result.chunks_summary?.length &&
          result.chunks_summary
            .slice(0, 1)
            .map((summary) => <HighlightedText chunk_summary={summary} />)}
      </div>
    )
  } else if (result.type === "event") {
    content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start">
          {getIcon(result.app, result.entity, { w: 24, h: 24, mr: 20 })}
          <a
            href={result.url ?? ""}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-[#2067F5]"
          >
            {/* TODO: if photoLink doesn't exist then show icon */}
            {/* <img
              referrerPolicy="no-referrer"
              className="mr-2 w-[16px] h-[16px] rounded-full"
              src={result.photoLink}
            ></img> */}
            {result.name}
          </a>
        </div>
        <p className="text-left text-sm mt-1 text-[#464B53] line-clamp-[2.5] text-ellipsis overflow-hidden ml-[44px]">
          {result.description ?? ""}
        </p>
      </div>
    )
  }
  return content
}
