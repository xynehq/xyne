import type { docs_v1 } from "googleapis"

/**
 * Cleans the input text by replacing multiple consecutive whitespace characters
 * (excluding newlines and carriage returns) with a single space.
 *
 * This preserves the formatting of newlines while normalizing spaces within lines.
 * Note: If the input is empty or only contains whitespace, it will return an empty string.
 *
 * @param text - The input string to clean.
 * @returns The cleaned string with normalized whitespace, or an empty string if the input is empty.
 */
const cleanText = (text: string): string => {
  return text.replace(/[^\S\r\n]+/g, " ") // Replace multiple spaces with a single space
}

/**
 * @param element - The ParagraphElement containing the textRun.
 * @returns The cleaned text content or an empty string if no content is present.
 */
const getText = (element: docs_v1.Schema$ParagraphElement): string => {
  return cleanText(element.textRun?.content || "")
}

/**
 * Retrieves image data from an inline object element within the document.
 * This function accesses the embedded image properties to extract the image source URL,
 * title, and alternative text, which can be used to represent the image in the extracted text.
 *
 * If the inline object or image properties are not available, it returns null.
 *
 * @param document - The Google Docs document object containing inline objects.
 * @param inlineObjectElement - The inline object element referencing the image.
 * @returns An object containing the image source URL, title, and alt text, or null if the inline object is not an image or is missing data.
 */
const getImageFromInlineObject = (
  document: docs_v1.Schema$Document,
  inlineObjectElement: docs_v1.Schema$InlineObjectElement,
): { source: string; title: string; alt: string } | null => {
  const inlineObjectId = inlineObjectElement.inlineObjectId
  if (inlineObjectId) {
    const embeddedObject =
      document.inlineObjects?.[inlineObjectId]?.inlineObjectProperties
        ?.embeddedObject
    const contentUri = embeddedObject?.imageProperties?.contentUri

    if (contentUri) {
      return {
        source: contentUri,
        title: embeddedObject.title || "",
        alt: embeddedObject.description || "",
      }
    }
  }
  return null
}

/**
 * Extracts the textual content from a paragraph, processing its elements
 * to handle text runs, footnote references, and inline images.
 *
 * - Text runs are cleaned and concatenated.
 * - Footnote references are converted to markdown-style footnotes.
 * - Inline images are represented using markdown image syntax.
 *
 * @param document - The Google Docs document object, needed for image retrieval.
 * @param paragraph - The paragraph from which to extract content.
 * @returns The concatenated string representing the paragraph's content.
 */
const extractParagraphContent = (
  document: docs_v1.Schema$Document,
  paragraph: docs_v1.Schema$Paragraph,
): string => {
  return (
    paragraph.elements
      ?.map((e: docs_v1.Schema$ParagraphElement) => {
        if (e.textRun) return getText(e)
        if (e.footnoteReference)
          return `[^${e.footnoteReference.footnoteNumber}]`
        if (e.inlineObjectElement) {
          const image = getImageFromInlineObject(
            document,
            e.inlineObjectElement,
          )
          return image ? `![${image.alt}](${image.source})` : ""
        }
        return ""
      })
      .join("") ?? ""
  )
}

/**
 * Determines the appropriate markdown heading prefix for a paragraph based on its style.
 * It checks if the paragraph style corresponds to a heading (e.g., HEADING_1),
 * and returns a string of '#' characters matching the heading level.
 *
 * For example, a HEADING_2 style will return '## ' as the prefix.
 *
 * @param paragraph - The paragraph whose style is to be evaluated.
 * @returns A string with '#' characters indicating the heading level, followed by a space, or an empty string if not a heading.
 */
const getHeadingPrefix = (paragraph: docs_v1.Schema$Paragraph): string => {
  const headingMatch =
    paragraph.paragraphStyle?.namedStyleType?.match(/HEADING_(\d+)/)
  const headingLevel = headingMatch ? parseInt(headingMatch[1]) : null
  return headingLevel ? "#".repeat(headingLevel) + " " : ""
}

/**
 * Recursively extracts text from a Google Docs StructuralElement, handling different types of elements:
 *
 * - **Paragraphs**: Processes both regular paragraphs and list items.
 *     - For list items, it adds appropriate indentation based on nesting level and uses '-' as bullet points.
 *     - For headings, it applies markdown heading prefixes determined by the paragraph style.
 *     - It extracts content using `extractParagraphContent`, which handles text runs, footnotes, and inline images.
 *
 * - **Tables**: Iterates through table rows and cells, extracting their content recursively.
 *     - Cells are separated by tabs, and rows by newlines to preserve table structure in the text.
 *
 * - **Table of Contents**: Extracts the content of the table of contents recursively.
 *
 * The function handles nesting by increasing the `nestLevel` parameter when recursing into nested elements.
 *
 * @param document - The Google Docs document object, required for image and footnote extraction.
 * @param element - The structural element to process.
 * @param nestLevel - The current nesting level, used for indenting list items.
 * @returns The extracted text representation of the element.
 */
export const extractText = (
  document: docs_v1.Schema$Document,
  element: docs_v1.Schema$StructuralElement,
  nestLevel: number = 0,
): string => {
  let text = ""

  if (element.paragraph) {
    const paragraph = element.paragraph
    let paragraphContent = ""

    if (paragraph.bullet) {
      // Process list items
      const bullet = "  ".repeat(paragraph.bullet.nestingLevel || 0) + "- "
      paragraphContent =
        bullet + extractParagraphContent(document, paragraph) + "\n"
    } else {
      const headingPrefix = getHeadingPrefix(paragraph)
      paragraphContent =
        headingPrefix + extractParagraphContent(document, paragraph) + "\n"
    }

    text += paragraphContent
  } else if (element.table) {
    // Process table elements
    text +=
      element.table.tableRows
        ?.map((row) => {
          return row.tableCells
            ?.map((cell) => {
              return cell.content
                ?.map((e) => extractText(document, e, nestLevel + 1))
                .join("")
            })
            .join("\t") // Tab-separated cells
        })
        .join("\n") + "\n\n" // Newline-separated rows
  } else if (element.tableOfContents) {
    // Process table of contents
    text +=
      element.tableOfContents.content
        ?.map((e) => extractText(document, e, nestLevel))
        .join("") + "\n\n"
  }

  return text
}

/**
 * Post-processes the extracted text to normalize whitespace and handle newlines intelligently.
 *
 * The function aims to:
 * - Merge lines that are part of the same paragraph into a single line, separated by spaces.
 * - Preserve empty lines between paragraphs (up to two consecutive newlines).
 * - Keep headings and list items on their own lines.
 *
 * **Algorithm Details:**
 * - Splits the text into lines and iterates over them.
 * - Counts consecutive empty lines to determine paragraph breaks.
 * - Uses a helper function `isListItem` to detect list item lines based on a regex pattern.
 * - Combines lines that are part of the same paragraph unless they are headings (start with '#') or list items.
 *
 * This processing helps to produce cleaner, more readable text output, suitable for further processing or display.
 *
 * @param text - The input text to post-process.
 * @returns The post-processed text with normalized newlines and paragraphs.
 */
export const postProcessText = (text: string): string => {
  const lines = text.split("\n")
  const processedLines: string[] = []
  let previousLine = ""
  let consecutiveNewlines = 0

  const isListItem = (line: string): boolean => /^[\s]*[-*+] /.test(line)

  lines.forEach((line, index) => {
    const trimmedLine = line.trim()

    if (trimmedLine === "") {
      consecutiveNewlines++
      if (consecutiveNewlines <= 2) {
        processedLines.push("") // Keep up to two empty lines
      }
    } else {
      if (
        consecutiveNewlines >= 2 ||
        index === 0 ||
        trimmedLine.startsWith("#")
      ) {
        // Start of a new paragraph or heading
        processedLines.push(trimmedLine)
      } else if (previousLine !== "" && !isListItem(previousLine)) {
        // Continuation of the previous paragraph (not a list item)
        processedLines[processedLines.length - 1] += " " + trimmedLine
      } else {
        // Single line paragraph or list item
        processedLines.push(trimmedLine)
      }
      consecutiveNewlines = 0
    }

    previousLine = trimmedLine
  })

  return processedLines.join("\n")
}

// Extract footnotes
export const extractFootnotes = (document: docs_v1.Schema$Document): string => {
  let footnotes = ""
  if (document.footnotes) {
    Object.entries(document.footnotes).forEach(([id, footnote]) => {
      footnotes += `[^${footnote.footnoteId}]: ${footnote.content
        ?.map((e) => extractText(document, e))
        .join("")}\n`
    })
  }
  return footnotes
}

// Extract headers and footers
export const extractHeadersAndFooters = (
  document: docs_v1.Schema$Document,
): string => {
  let headerFooter = ""
  if (document.headers) {
    Object.entries(document.headers).forEach(([key, header]) => {
      headerFooter += `Header (${key}):\n${header.content
        ?.map((e) => extractText(document, e))
        .join("")}\n\n`
    })
  }
  if (document.footers) {
    Object.entries(document.footers).forEach(([key, footer]) => {
      headerFooter += `Footer (${key}):\n${footer.content
        ?.map((e) => extractText(document, e))
        .join("")}\n\n`
    })
  }
  return headerFooter
}
