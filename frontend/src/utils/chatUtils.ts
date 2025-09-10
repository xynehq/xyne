import { splitGroupedCitationsWithSpaces } from "@/lib/utils"

// Helper function to generate UUID
export const generateUUID = () => crypto.randomUUID()

export const textToCitationIndex = /\[(\d+)\]/g
export const textToImageCitationIndex = /\[(\d+_\d+)\]/g

export const processMessage = (text: string, citationMap: Record<number, number> | undefined, citationUrls: string[]) => {
    text = splitGroupedCitationsWithSpaces(text)
    text = text.replace(
      /(\[\d+_\d+\])/g,
      (fullMatch, capturedCitation, offset, string) => {
        // Check if this image citation appears earlier in the string
        const firstIndex = string.indexOf(fullMatch)
        if (firstIndex < offset) {
          // remove duplicate image citations
          return ""
        }
        return capturedCitation
      },
    )
    text = text.replace(
      textToImageCitationIndex,
      (match, citationKey, offset, string) => {
        // Check if this image citation appears earlier in the string
        const firstIndex = string.indexOf(match)
        if (firstIndex < offset) {
          // remove duplicate image citations
          return ""
        }
        return `![image-citation:${citationKey}](image-citation:${citationKey})`
      },
    )
  
    if (citationMap) {
      return text.replace(textToCitationIndex, (match, num) => {
        const index = citationMap[num]
        const url = citationUrls[index]
        return typeof index === "number" && url ? `[${index + 1}](${url})` : ""
      })
    } else {
      return text.replace(textToCitationIndex, (match, num) => {
        const url = citationUrls[num - 1]
        return url ? `[${num}](${url})` : ""
      })
    }
  }