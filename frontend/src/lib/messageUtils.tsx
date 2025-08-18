import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Pill } from "../components/Pill"
import { Reference } from "../types"

// Define the structure for parsed message parts, including app, entity, and pillType for pills
export type ParsedMessagePart =
  | { type: "text"; value: string }
  | {
      type: "pill"
      value: {
        docId: string
        url: string | null
        title: string | null
        app?: string
        entity?: string
        pillType?: "citation" | "global"
        imgSrc?: string | null
      }
    }
  | { type: "link"; value: string }

// Helper function to convert JSON message parts back to HTML using Pill component
export const jsonToHtmlMessage = (jsonString: string): string => {
  try {
    const parts = JSON.parse(jsonString) as Array<ParsedMessagePart>
    if (!Array.isArray(parts)) {
      // If not our specific JSON structure, treat as plain HTML/text string
      return jsonString
    }

    return parts
      .map((part, index) => {
        let htmlPart = ""
        if (part.type === "text") {
          htmlPart = part.value
        } else if (
          part.type === "pill" &&
          part.value &&
          typeof part.value === "object"
        ) {
          const { docId, url, title, app, entity, pillType, imgSrc } =
            part.value

          const referenceForPill: Reference = {
            id: docId,
            docId: docId,
            title: title || docId,
            url: url || undefined,
            app: app,
            entity: entity,
            type: pillType || "global",
            // Include imgSrc if available, mapping it to photoLink for the Reference type.
            ...(imgSrc && { photoLink: imgSrc }),
          }
          htmlPart = renderToStaticMarkup(
            React.createElement(Pill, { newRef: referenceForPill }),
          )
        } else if (part.type === "link" && typeof part.value === "string") {
          const url = part.value
          // Create a simple anchor tag string for links
          htmlPart = `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-blue-600 dark:text-blue-400 underline hover:text-blue-800 dark:hover:text-blue-300 cursor-pointer">${url}</a>`
        }
        // Add a space only if the part is not the last one
        if (htmlPart.length > 0 && index < parts.length - 1) {
          htmlPart += " "
        }
        return htmlPart
      })
      .join("")
      .trimEnd()
  } catch (error) {
    // If JSON parsing fails, return the original string as-is
    return jsonString
  }
}

// Helper component to render message content with pills
export const MessageContent: React.FC<{
  content: string
  className?: string
}> = ({ content, className = "" }) => {
  const processedContent = jsonToHtmlMessage(content)

  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: processedContent }}
    />
  )
}
