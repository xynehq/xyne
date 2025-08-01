import { HighlightedText } from "@/components/Highlight"
import { getIcon } from "@/lib/common"
import { SearchResultDiscriminatedUnion } from "@/server/shared/types"
import { Mail } from "lucide-react"

const trimmedSubject = (subject: string): string => {
  if (subject.length > 60) {
    return subject.substring(0, 60) + "..."
  }
  return subject
}

const newLineToSpace = (text: string | undefined | null): string => {
  if (!text) return ""
  return text.replace(/\n/g, " ").replace(/\s\s+/g, " ").trim()
}

const formatDisplayDate = (
  dateInput: string | number | Date | undefined,
): string => {
  if (!dateInput) return ""
  const now = new Date()
  const dateToFormat = new Date(dateInput)

  const oneYearAgo = new Date(now)
  oneYearAgo.setFullYear(now.getFullYear() - 1)

  const isToday =
    now.getDate() === dateToFormat.getDate() &&
    now.getMonth() === dateToFormat.getMonth() &&
    now.getFullYear() === dateToFormat.getFullYear()
  const isYesterday =
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).valueOf() ===
    new Date(
      dateToFormat.getFullYear(),
      dateToFormat.getMonth(),
      dateToFormat.getDate(),
    ).valueOf()

  if (isToday) return "Today"
  if (isYesterday) return "Yesterday"

  if (dateToFormat < oneYearAgo) {
    return dateToFormat.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    })
  } else {
    return dateToFormat.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
    })
  }
}

const formatEmailDisplay = (fromString: string) => {
  let emailPart = ""
  let fallbackDisplay = fromString // Default to the full 'from' string

  const emailMatch = fromString.match(/<([^>]+)>/)
  if (emailMatch && emailMatch[1]) {
    // Format "Name <email@example.com>"
    emailPart = emailMatch[1]
  } else if (
    fromString.includes("@") &&
    !fromString.includes(" ") &&
    !fromString.includes("<")
  ) {
    // Format "email@example.com"
    emailPart = fromString
  }
  // If fromString is just "Name", emailPart remains "", fallbackDisplay is "Name".

  const textToDisplay = emailPart || fallbackDisplay
  const linkHref = emailPart ? `mailto:${emailPart}` : undefined

  if (linkHref) {
    return (
      <a
        target="_blank"
        className="text-[#2067F5] dark:text-blue-400"
        rel="noopener noreferrer"
        href={linkHref}
      >
        <p className="text-left text-sm text-[#464B53] dark:text-slate-300 leading-5">
          {textToDisplay}
        </p>
      </a>
    )
  } else {
    return (
      <p className="text-left text-sm text-[#464B53] dark:text-slate-300 leading-5">
        {textToDisplay}
      </p>
    )
  }
}

function slackTs(ts: string | number) {
  if (typeof ts === "number") ts = ts.toString()
  return ts.replace(".", "").padEnd(16, "0")
}

export const SearchResult = ({
  result,
  index,
  showDebugInfo,
}: {
  result: SearchResultDiscriminatedUnion
  index: number
  showDebugInfo?: boolean
}) => {
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
            className="flex items-center text-blue-800 dark:text-blue-400 space-x-2"
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
          />
          <div className="flex items-center">
            <a
              target="_blank"
              className="text-[#2067F5] dark:text-blue-400"
              rel="noopener noreferrer"
              href={`https://contacts.google.com/${result.ownerEmail}`}
            >
              <p className="text-left text-sm text-[#464B53] dark:text-slate-300 leading-5">
                {result.owner}
              </p>
            </a>
            <span className="text-[#999] dark:text-gray-500 mx-1.5">•</span>
            <span className="text-sm text-gray-600 dark:text-gray-400 leading-5">
              {formatDisplayDate(result.updatedAt)}
            </span>
          </div>
        </div>
        {Array.isArray(result.chunks_summary) &&
          result.chunks_summary.length > 0 &&
          result.chunks_summary.map((summary, idx) => (
            <HighlightedText
              key={idx}
              chunk_summary={newLineToSpace(summary.chunk)}
            />
          ))}
        {/* Debug Info Display (Features Only) */}
        {showDebugInfo && (result.matchfeatures || result.rankfeatures) && (
          <details className="mt-2 ml-[44px] text-xs">
            <summary className="text-gray-500 dark:text-gray-400 cursor-pointer">
              {`Debug Info: ${index} : ${result.relevance}`}
            </summary>
            <pre className="text-xs bg-gray-100 dark:bg-slate-800 dark:text-slate-200 p-2 rounded overflow-auto max-h-60">
              {JSON.stringify(
                {
                  matchfeatures: result.matchfeatures,
                  rankfeatures: result.rankfeatures,
                  relevance: result.relevance,
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
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
            className="flex items-center text-[#2067F5] dark:text-blue-400"
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
        {/* Debug Info Display (Features Only) */}
        {showDebugInfo && (result.matchfeatures || result.rankfeatures) && (
          <details className="mt-2 ml-[44px] text-xs">
            <summary className="text-gray-500 dark:text-gray-400 cursor-pointer">
              {`Debug Info: ${index} : ${result.relevance}`}
            </summary>
            <pre className="text-xs bg-gray-100 dark:bg-slate-800 dark:text-slate-200 p-2 rounded overflow-auto max-h-60">
              {JSON.stringify(
                {
                  matchfeatures: result.matchfeatures,
                  rankfeatures: result.rankfeatures,
                  relevance: result.relevance,
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
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
            className="flex items-center text-[#2067F5] dark:text-blue-400"
          >
            {trimmedSubject(result.subject)}
          </a>
        </div>
        <div className="flex flex-row items-center mt-1 ml-[44px]">
          <Mail className="mr-2 w-[16px] h-[16px] text-gray-500 dark:text-gray-400" />
          <div className="flex items-center">
            {formatEmailDisplay(result.from)}
            <span className="text-[#999] dark:text-gray-500 mx-1.5">•</span>
            <span className="text-sm text-gray-600 dark:text-gray-400 leading-5">
              {formatDisplayDate(result.timestamp)}
            </span>
          </div>
        </div>
        {Array.isArray(result.chunks_summary) &&
          result.chunks_summary.length > 0 &&
          result.chunks_summary.map((summary, idx) => (
            <HighlightedText
              key={idx}
              chunk_summary={newLineToSpace(summary.chunk)}
            />
          ))}
        {/* Debug Info Display (Features Only) */}
        {showDebugInfo && (result.matchfeatures || result.rankfeatures) && (
          <details className="mt-2 ml-[44px] text-xs">
            <summary className="text-gray-500 dark:text-gray-400 cursor-pointer">
              {`Debug Info: ${index} : ${result.relevance}`}
            </summary>
            <pre className="text-xs bg-gray-100 dark:bg-slate-800 dark:text-slate-200 p-2 rounded overflow-auto max-h-60">
              {JSON.stringify(
                {
                  matchfeatures: result.matchfeatures,
                  rankfeatures: result.rankfeatures,
                  relevance: result.relevance,
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
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
            className="flex items-center text-[#2067F5] dark:text-blue-400"
          >
            {result.name}
          </a>
        </div>
        <div className="flex flex-row items-center mt-1 ml-[44px]">
          {/* Placeholder for event owner/creator if available in the future */}
          {/* <img referrerPolicy="no-referrer" className="mr-2 w-[16px] h-[16px] rounded-full" src={""} /> */}
          {/* <div className="flex items-center"> */}
          {/*   <p className="text-left text-sm text-[#464B53] dark:text-slate-300 leading-5">Event Creator</p> */}
          {/*   <span className="text-[#999] dark:text-gray-500 mx-1.5">•</span> */}
          {/* </div> */}
          <span className="text-sm text-gray-600 dark:text-gray-400 leading-5">
            {formatDisplayDate(result.updatedAt)}
          </span>
        </div>
        <p className="text-left text-sm mt-1 text-[#464B53] dark:text-slate-300 line-clamp-[2.5] text-ellipsis overflow-hidden ml-[44px]">
          {Array.isArray(result.chunks_summary) &&
            !!result.chunks_summary.length &&
            result.chunks_summary.map((summary, idx) => (
              <HighlightedText
                chunk_summary={newLineToSpace(summary)}
                key={idx}
              />
            ))}
        </p>
        {/* Debug Info Display (Features Only) */}
        {showDebugInfo && (result.matchfeatures || result.rankfeatures) && (
          <details className="mt-2 ml-[44px] text-xs">
            <summary className="text-gray-500 dark:text-gray-400 cursor-pointer">
              {`Debug Info: ${index} : ${result.relevance}`}
            </summary>
            <pre className="text-xs bg-gray-100 dark:bg-slate-800 dark:text-slate-200 p-2 rounded overflow-auto max-h-60">
              {JSON.stringify(
                {
                  matchfeatures: result.matchfeatures,
                  rankfeatures: result.rankfeatures,
                  relevance: result.relevance,
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
      </div>
    )
  } else if (result.type === "mail_attachment") {
    content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start">
          {getIcon(result.app, result.entity, { w: 24, h: 24, mr: 20 })}
          <a
            href={`https://mail.google.com/mail/u/0/#inbox/${result.mailId}?projector=1&messagePartId=0.${result.partId}&disp=safe&zw`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-[#2067F5] dark:text-blue-400"
          >
            {result.filename}
          </a>
        </div>
        {Array.isArray(result.chunks_summary) &&
          result.chunks_summary.length > 0 &&
          result.chunks_summary.map((summary, idx) => (
            <HighlightedText
              key={idx}
              chunk_summary={newLineToSpace(summary.chunk)}
            />
          ))}
        {/* Debug Info Display (Features Only) */}
        {showDebugInfo && (result.matchfeatures || result.rankfeatures) && (
          <details className="mt-2 ml-[44px] text-xs">
            <summary className="text-gray-500 dark:text-gray-400 cursor-pointer">
              {`Debug Info: ${index} : ${result.relevance}`}
            </summary>
            <pre className="text-xs bg-gray-100 dark:bg-slate-800 dark:text-slate-200 p-2 rounded overflow-auto max-h-60">
              {JSON.stringify(
                {
                  matchfeatures: result.matchfeatures,
                  rankfeatures: result.rankfeatures,
                  relevance: result.relevance,
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
      </div>
    )
  } else if (result.type === "chat_message") {
    // Slack message link logic
    let slackUrl = ""
    if (result.threadId) {
      // Thread message format
      slackUrl = `https://${result.domain}.slack.com/archives/${result.channelId}/p${slackTs(result.createdAt)}?thread_ts=${result.threadId}&cid=${result.channelId}`
    } else {
      // Normal message format
      slackUrl = `https://${result.domain}.slack.com/archives/${result.channelId}/p${slackTs(result.createdAt)}`
    }
    content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start space-x-2">
          <a
            href={slackUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-blue-800 dark:text-blue-400 space-x-2"
          >
            {getIcon(result.app, result.entity, { w: 24, h: 24, mr: 20 })}
          </a>
        </div>
        <div className="flex flex-row items-center mt-1 ml-[44px]">
          <img
            referrerPolicy="no-referrer"
            className="mr-2 w-[16px] h-[16px] rounded-full"
            src={result.image}
          ></img>
          <a
            target="_blank"
            className="text-[#2067F5] dark:text-blue-400"
            rel="noopener noreferrer"
            href={`https://${result.domain}.slack.com/team/${result.userId}`}
          >
            <p className="text-left text-sm pt-1 text-[#464B53] dark:text-slate-300">
              {result.name}
            </p>
          </a>
        </div>
        {result.text && (
          <HighlightedText chunk_summary={newLineToSpace(result.text)} />
        )}
        {/* Debug Info Display (Features Only) */}
        {showDebugInfo && (result.matchfeatures || result.rankfeatures) && (
          <details className="mt-2 ml-[44px] text-xs">
            <summary className="text-gray-500 dark:text-gray-400 cursor-pointer">
              {`Debug Info: ${index} : ${result.relevance}`}
            </summary>
            <pre className="text-xs bg-gray-100 dark:bg-slate-800 dark:text-slate-200 p-2 rounded overflow-auto max-h-60">
              {JSON.stringify(
                {
                  matchfeatures: result.matchfeatures,
                  rankfeatures: result.rankfeatures,
                  relevance: result.relevance,
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
      </div>
    )
  }
  return content
}
