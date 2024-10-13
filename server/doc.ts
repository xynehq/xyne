// Helper function to clean text but preserve newlines and spaces within lines
const cleanText = (text) => {
  return text.replace(/[^\S\r\n]+/g, " ") // Replace multiple spaces with a single space
}

// Helper function to extract plain text from textRun
const getText = (element) => {
  let text = cleanText(element.textRun.content)
  return text
}

// Helper function to recursively extract text from various element types
export const extractText = (element, nestLevel = 0) => {
  let text = ""

  if (element.paragraph) {
    // Handle headings
    const headingLevel =
      element.paragraph.paragraphStyle?.namedStyleType?.match(/HEADING_(\d+)/)

    text +=
      element.paragraph.elements
        .map((e) => {
          if (e.textRun) return getText(e)
          if (e.footnoteReference)
            return `[^${e.footnoteReference.footnoteNumber}]`
          return ""
        })
        .join("") + "\n"
  } else if (element.table) {
    // Process table elements
    text += element.table.tableRows
      .map((row) => {
        return row.tableCells
          .map((cell) => {
            return cell.content
              .map((e) => extractText(e, nestLevel + 1))
              .join("")
          })
          .join("\t") // Tab-separated cells
      })
      .join("\n") // Newline-separated rows
  } else if (element.listItem) {
    // Process list items
    const bullet = "  ".repeat(nestLevel) + "- "
    text +=
      bullet +
      element.listItem.elements
        .map((e) => {
          return e.textRun ? getText(e) : ""
        })
        .join("") +
      "\n"
  } else if (element.inlineObjectElement) {
    // Handle inline images if needed
    const image = getImage(documentContent.data, element)
    text += image ? `![${image.alt}](${image.source})` : ""
  } else if (element.tableOfContents) {
    // Process table of contents
    text += element.tableOfContents.content
      .map((e) => extractText(e, nestLevel))
      .join("")
  }

  return text
}

// Helper function to get image data
function getImage(document, element) {
  const { inlineObjects } = document
  if (!inlineObjects || !element.inlineObjectElement) {
    return null
  }
  const inlineObject = inlineObjects[element.inlineObjectElement.inlineObjectId]
  const embeddedObject = inlineObject.inlineObjectProperties.embeddedObject
  if (embeddedObject && embeddedObject.imageProperties) {
    return {
      source: embeddedObject.imageProperties.contentUri,
      title: embeddedObject.title || "",
      alt: embeddedObject.description || "",
    }
  }
  return null
}

// Post-process the extracted text to handle newlines intelligently
export const postProcessText = (text) => {
  const lines = text.split("\n")
  const processedLines = []
  let previousLine = ""
  let consecutiveNewlines = 0

  lines.forEach((line, index) => {
    const trimmedLine = line.trim()

    if (trimmedLine === "") {
      consecutiveNewlines++
      if (consecutiveNewlines === 2) {
        processedLines.push("") // Keep paragraph break
      }
    } else {
      if (
        consecutiveNewlines >= 2 ||
        index === 0 ||
        trimmedLine.startsWith("#")
      ) {
        // Start of a new paragraph or heading
        processedLines.push(trimmedLine)
      } else if (previousLine !== "" && !previousLine.startsWith("-")) {
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
export const extractFootnotes = (document) => {
  let footnotes = ""
  if (document.footnotes) {
    Object.entries(document.footnotes).forEach(([id, footnote]) => {
      footnotes += `[^${footnote.footnoteId}]: ${extractText(footnote.content[0])}\n`
    })
  }
  return footnotes
}

// Extract headers and footers
export const extractHeadersAndFooters = (document) => {
  let headerFooter = ""
  if (document.headers) {
    Object.entries(document.headers).forEach(([key, header]) => {
      headerFooter += `Header (${key}):\n${extractText(header.content[0])}\n\n`
    })
  }
  if (document.footers) {
    Object.entries(document.footers).forEach(([key, footer]) => {
      headerFooter += `Footer (${key}):\n${extractText(footer.content[0])}\n\n`
    })
  }
  return headerFooter
}
