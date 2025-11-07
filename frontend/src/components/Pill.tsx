import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { getIcon } from "@/lib/common"
import { Reference } from "@/types"
import { parseHighlight, trimToHighlightHotspot } from "./Highlight"

function truncateWithHiTags(str: string, maxLen: number): string {
  let visibleLen = 0
  let result = ""
  let inTag = false
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "<" && str.slice(i, i + 4) === "<hi>") {
      inTag = true
      result += "<hi>"
      i += 3
      continue
    }
    if (str[i] === "<" && str.slice(i, i + 5) === "</hi>") {
      inTag = false
      result += "</hi>"
      i += 4
      continue
    }
    if (!inTag && visibleLen >= maxLen) break
    result += str[i]
    if (!inTag) visibleLen++
  }
  if (visibleLen >= maxLen) result += "..."
  // Close any unclosed <hi> tag
  if (inTag) result += "</hi>"
  return result
}

interface PillProps {
  newRef: Reference
}

export const Pill: React.FC<PillProps> = ({ newRef }) => {
  const pillRef = React.useRef<HTMLAnchorElement | null>(null)

  React.useEffect(() => {
    const currentPill = pillRef.current
    if (!currentPill) return

    const handleClick = (e: MouseEvent) => {
      if (currentPill.getAttribute("href") === "#") {
        e.preventDefault()
      }
      e.stopPropagation()
    }

    currentPill.addEventListener("click", handleClick)

    return () => {
      currentPill.removeEventListener("click", handleClick)
    }
  }, [newRef.url])

  let displayIcon: React.ReactNode = null

  if (
    (newRef.entity === "OtherContacts" || newRef.entity === "Contacts") &&
    newRef.photoLink
  ) {
    displayIcon = (
      <img
        src={newRef.photoLink}
        alt=""
        className="self-center inline-flex items-center w-[14px] h-[14px] mr-1 rounded-sm"
      />
    )
  } else {
    const iconNode =
      newRef.app && newRef.entity
        ? getIcon(newRef.app, newRef.entity, {
            w: 14,
            h: 14,
            mr: 4,
          })
        : null

    if (React.isValidElement(iconNode)) {
      displayIcon = (
        <span
          className="self-center inline-flex items-center"
          dangerouslySetInnerHTML={{ __html: renderToStaticMarkup(iconNode) }}
        />
      )
    } else if (
      typeof iconNode === "string" &&
      (iconNode as string).trim() !== ""
    ) {
      displayIcon = <span className="self-center mr-1">{iconNode}</span>
    } else if (newRef.app && newRef.entity) {
      displayIcon = <span className="self-center mr-1">▫️</span>
    }
  }

  return (
    <a
      ref={pillRef}
      href={newRef.url || "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="reference-pill bg-[#F1F5F9] dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-[#2074FA] dark:text-blue-400 text-sm font-semibold rounded px-0.5 inline-flex items-baseline cursor-pointer no-underline self-center"
      contentEditable={false}
      data-reference-id={newRef.id}
      {...(newRef.docId ? { "data-doc-id": newRef.docId } : {})}
      {...(newRef.mailId ? { "data-mail-id": newRef.mailId } : {})}
      {...(newRef.threadId ? { "data-thread-id": newRef.threadId } : {})}
      {...(newRef.parentThreadId
        ? { "data-parent-thread-id": newRef.parentThreadId }
        : {})}
      {...(newRef.app ? { "data-app": newRef.app } : {})}
      {...(newRef.entity ? { "data-entity": newRef.entity } : {})}
      {...(newRef.userMap
        ? { "user-map": JSON.stringify(newRef.userMap) }
        : {})} // Ensure userMap is serialized
      {...(newRef.wholeSheet !== undefined
        ? { "data-whole-sheet": String(newRef.wholeSheet) }
        : {})}
      title={newRef.title}
    >
      {displayIcon}
      <span className="truncate line-clamp-1">
        {parseHighlight(
          truncateWithHiTags(trimToHighlightHotspot(newRef.title), 15),
        )}
      </span>
    </a>
  )
}
