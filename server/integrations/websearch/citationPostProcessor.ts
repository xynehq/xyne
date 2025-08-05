/**
 * Citation Post-Processor for Web Search Results
 *
 * Cleans up and enhances citations in web search responses,
 * replacing generic references with proper webpage titles.
 */

import { getLogger } from "../../logger/index.js"
import { Subsystem } from "../../types.js"
import type { UrlWithMetadata } from "./types.js"

const Logger = getLogger(Subsystem.Search).child({
  module: "citationPostProcessor",
})

/**
 * Post-process web search response to clean up generic citations
 */
export function postProcessWebSearchResponse(
  answer: string,
  urlsWithMetadata: UrlWithMetadata[],
): string {
  if (!answer || !urlsWithMetadata || urlsWithMetadata.length === 0) {
    return answer
  }

  let processedAnswer = answer

  try {
    // Replace generic patterns that Gemini might generate
    const genericPatterns = [
      /\*{2,6}\s*Vertexaisearch\s*-\s*Web\s*Content\s*\*{0,6}/gi,
      /\*{2,6}\s*Web\s*Content\s*\*{0,6}/gi,
      /\*{2,6}\s*Source\s*\d+\s*\*{0,6}/gi,
      /\*{2,6}\s*Reference\s*\d+\s*\*{0,6}/gi,
    ]

    genericPatterns.forEach((pattern) => {
      processedAnswer = processedAnswer.replace(pattern, (match) => {
        // Try to find a relevant citation to replace with
        if (urlsWithMetadata.length > 0) {
          const firstCitation = urlsWithMetadata[0]
          const title = firstCitation.title || "Web Source"
          const siteName = firstCitation.siteName

          let displayText = title
          if (
            siteName &&
            !title.toLowerCase().includes(siteName.toLowerCase())
          ) {
            displayText = `${title} - ${siteName}`
          }

          return `**${displayText}**`
        }
        return match
      })
    })

    // Clean up any remaining asterisk formatting issues
    processedAnswer = processedAnswer
      .replace(/\*{4,}/g, "**") // Reduce excessive asterisks
      .replace(/\*{3}/g, "**") // Fix triple asterisks
      .replace(/\*\s*\*/g, "") // Remove empty bold formatting

    // Improve source section formatting if present
    if (
      processedAnswer.includes("📚 Sources") ||
      processedAnswer.includes("Sources:")
    ) {
      processedAnswer = enhanceSourcesSection(processedAnswer, urlsWithMetadata)
    }

    Logger.debug("Successfully post-processed web search response")
    return processedAnswer
  } catch (error) {
    Logger.warn(`Failed to post-process web search response: ${error}`)
    return answer
  }
}

/**
 * Enhance the sources section with proper titles
 */
function enhanceSourcesSection(
  text: string,
  urlsWithMetadata: UrlWithMetadata[],
): string {
  let enhancedText = text

  // Replace numbered source entries in the sources section
  urlsWithMetadata.forEach((urlMeta, index) => {
    const sourceNumber = index + 1
    const title = urlMeta.title || `Source ${sourceNumber}`
    const siteName = urlMeta.siteName

    let displayText = title
    if (siteName && !title.toLowerCase().includes(siteName.toLowerCase())) {
      displayText = `${title} - ${siteName}`
    }

    // Replace patterns like [1] URL or **[1]** URL
    const patterns = [
      new RegExp(
        `\\*{0,2}\\[${sourceNumber}\\]\\*{0,2}\\s*${escapeRegex(urlMeta.url)}`,
        "gi",
      ),
      new RegExp(
        `\\*{0,2}\\[${sourceNumber}\\]\\*{0,2}\\s*\\*{0,4}[^\\n]*\\*{0,4}`,
        "gi",
      ),
    ]

    patterns.forEach((pattern) => {
      enhancedText = enhancedText.replace(
        pattern,
        `**[${sourceNumber}]** [${displayText}](${urlMeta.url})`,
      )
    })
  })

  return enhancedText
}

/**
 * Escape special regex characters
 */
function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Clean up response for better readability
 */
export function cleanWebSearchResponse(response: string): string {
  return (
    response
      // Fix common formatting issues
      .replace(/\n{3,}/g, "\n\n") // Reduce excessive line breaks
      .replace(/\s{3,}/g, " ") // Reduce excessive spaces
      .replace(/\*{5,}/g, "**") // Fix excessive asterisks

      // Improve citation formatting
      .replace(/\[\s*(\d+)\s*\]/g, "[$1]") // Clean up spaced citations
      .replace(/\(\s*\[/g, "([") // Fix spacing in citation groups
      .replace(/\]\s*\)/g, "])") // Fix spacing in citation groups

      // Clean up common artifacts
      .replace(/\*{2,4}\s*\*{2,4}/g, "") // Remove empty bold sections
      .replace(/\n\s*\n\s*\n/g, "\n\n") // Normalize paragraph spacing
      .trim()
  )
}
