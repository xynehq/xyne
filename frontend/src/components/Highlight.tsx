import React, { ReactNode } from "react"

type HighlightText = { text: string; highlight: boolean }

const parseHighlight = (text: string): ReactNode[] => {
  // Split the text on <hi> and </hi>, including the tags in the result
  const parts: string[] = text.split(/(<hi>|<\/hi>)/)

  let isHighlight = false
  const segments: HighlightText[] = []

  parts.forEach((part) => {
    if (part === "<hi>") {
      isHighlight = true
    } else if (part === "</hi>") {
      isHighlight = false
    } else if (part) {
      segments.push({ text: part, highlight: isHighlight } as HighlightText)
    }
  })

  return segments.map((segment, index) =>
    segment.highlight ? (
      <span key={index} className="font-bold">
        {segment.text}
      </span>
    ) : (
      <React.Fragment key={index}>{segment.text}</React.Fragment>
    ),
  )
}

// Component that renders chunk summary with parsing
const HighlightedText = ({ chunk_summary }: { chunk_summary: string }) => (
  <p className="text-left text-sm mt-1 text-[#464B53] line-clamp-[2.5] text-ellipsis overflow-hidden">
    {chunk_summary ? parseHighlight(chunk_summary) : " "}
  </p>
)

export default HighlightedText
