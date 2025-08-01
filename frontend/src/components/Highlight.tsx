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

  const extraUnderscores = /_{3,}/g
  cleanedText = cleanedText.replace(extraUnderscores, "")

  const extraEquals = /={3,}/g
  cleanedText = cleanedText.replace(extraEquals, "")

  return cleanedText
}

export const parseHighlight = (text: string): ReactNode[] => {
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

/**
 * Trims text to show the area with highest highlight density
 * Only trims when first few lines don't have highlights
 */
export function trimToHighlightHotspot(text: string): string {
  // Constants for estimation
  const CHARS_PER_LINE = 80
  const INITIAL_LINES_TO_CHECK = 2
  const WINDOW_SIZE_LINES = 4
  const WINDOW_SIZE_CHARS = WINDOW_SIZE_LINES * CHARS_PER_LINE

  // Find all highlight positions (both start and end)
  const highlightPositions: Array<{ start: number; end: number }> = []
  let pos = -1

  // Get all highlight start and end positions
  while ((pos = text.indexOf("<hi>", pos + 1)) !== -1) {
    const endPos = text.indexOf("</hi>", pos)
    if (endPos !== -1) {
      highlightPositions.push({
        start: pos,
        end: endPos + 5, // +5 for the "</hi>" tag length
      })
    }
  }

  // If no highlights, return original text
  if (highlightPositions.length === 0) {
    return text
  }

  // Check if first few lines have highlights
  const firstLinesChars = INITIAL_LINES_TO_CHECK * CHARS_PER_LINE
  const hasHighlightsInFirstLines = highlightPositions.some(
    (h) => h.start < firstLinesChars,
  )

  // If first few lines already have highlights, don't trim
  if (hasHighlightsInFirstLines) {
    return text
  }

  // Find the window with maximum highlight density
  let bestStartPos = 0
  let maxHighlightCount = 0

  // Scan through text with a sliding window to find area with most highlights
  for (
    let windowStart = 0;
    windowStart < text.length - WINDOW_SIZE_CHARS;
    windowStart += CHARS_PER_LINE / 2
  ) {
    const windowEnd = windowStart + WINDOW_SIZE_CHARS

    // Count highlights in this window
    const highlightsInWindow = highlightPositions.filter(
      (h) =>
        (h.start >= windowStart && h.start < windowEnd) ||
        (h.end > windowStart && h.end <= windowEnd) ||
        (h.start < windowStart && h.end > windowEnd),
    ).length

    if (highlightsInWindow > maxHighlightCount) {
      maxHighlightCount = highlightsInWindow
      bestStartPos = windowStart
    }
  }

  // If we found a good window with highlights
  if (maxHighlightCount > 0) {
    // Try to start at a clean word boundary
    const spaceBeforeStart = text.lastIndexOf(" ", bestStartPos)
    if (spaceBeforeStart > bestStartPos - 20) {
      bestStartPos = spaceBeforeStart + 1
    }

    // Calculate end position
    const endPos = Math.min(text.length, bestStartPos + WINDOW_SIZE_CHARS)

    // Create result with ellipsis if trimmed
    let result = text.substring(bestStartPos, endPos)

    // Add ellipsis if we trimmed the text
    if (bestStartPos > 0) {
      result = "..." + result
    }

    if (endPos < text.length) {
      result = result + "..."
    }

    return result
  }

  // Fallback to original text if something went wrong
  return text
}

// Component that renders chunk summary with parsing
const HighlightedText = ({ chunk_summary }: { chunk_summary: string }) => {
  return (
    <p className="text-left text-sm mt-1 text-[#464B53] dark:text-slate-300 text-ellipsis ml-[44px] line-clamp-3">
      {chunk_summary
        ? parseHighlight(trimToHighlightHotspot(chunk_summary))
        : " "}
    </p>
  )
}
const HighlightedTextForAtMention = ({
  chunk_summary,
}: { chunk_summary: string }) => {
  return (
    <span className="text-left text-sm text-[#464B53] dark:text-slate-300">
      {chunk_summary
        ? parseHighlight(trimToHighlightHotspot(chunk_summary))
        : " "}
    </span>
  )
}

export { HighlightedText, HighlightedTextForAtMention }
