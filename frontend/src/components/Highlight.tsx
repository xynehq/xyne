import { replaceLinks } from "@/lib/utils"
import React, { ReactNode } from "react"

type HighlightText = { text: string; highlight: boolean }

const cleanDocs = (text: string): string => {
  const urlPattern =
    /!\[.*?\]\(https:\/\/lh7-rt\.googleusercontent\.com\/docsz\/[a-zA-Z0-9-_?=&]+\)/g
  let cleanedText = text.replace(urlPattern, "")

  // ........
  const extendedEllipsisPattern = /[…\.\s]{2,}/g
  cleanedText = cleanedText.replace(extendedEllipsisPattern, " ")
  // .0.0.0.0.0.0.0.0
  const repetitiveDotZeroPattern = /(?:\.0)+(\.\d+)?/g
  cleanedText = cleanedText.replace(repetitiveDotZeroPattern, "")

  // Remove control characters
  const controlCharsPattern = /[\x00-\x1F\x7F-\x9F]/g
  cleanedText = cleanedText.replace(controlCharsPattern, "")
  // Remove invalid or incomplete UTF characters
  //  and �
  const invalidUtfPattern = /[\uE907\uFFFD]/g
  cleanedText = cleanedText.replace(invalidUtfPattern, "")

  return cleanedText
}

const parseHighlight = (text: string): ReactNode[] => {
  // Split the text on <hi> and </hi>, including the tags in the result
  const parts: string[] = text.split(/(<hi>|<\/hi>)/)

  let isHighlight = false
  let addSpace = true
  const segments: HighlightText[] = []

  parts.forEach((part, index) => {
    if (part === "<hi>") {
      // if it's "<hi>text</hi>" then we don't add any spaces
      // as original text would be "text" and we don't want " text "
      if (
        index - 1 > 0 &&
        parts[index - 1][parts[index - 1].length - 1] === '"'
      ) {
        addSpace = false
      }
      isHighlight = true
    } else if (part === "</hi>") {
      isHighlight = false
    } else if (part) {
      segments.push({
        text: addSpace ? ` ${part} ` : part,
        highlight: isHighlight,
      } as HighlightText)
    }
  })

  return segments.map((segment, index) =>
    segment.highlight ? (
      <span key={index} className="font-bold">
        {segment.text}
      </span>
    ) : (
      <React.Fragment key={index}>
        {replaceLinks(cleanDocs(segment.text))}
      </React.Fragment>
    ),
  )
}

// Component that renders chunk summary with parsing
const HighlightedText = ({ chunk_summary }: { chunk_summary: string }) => (
  <p className="text-left text-sm mt-1 text-[#464B53] line-clamp-[2.5] text-ellipsis overflow-hidden ml-[44px]">
    {chunk_summary ? parseHighlight(chunk_summary) : " "}
  </p>
)

export default HighlightedText
