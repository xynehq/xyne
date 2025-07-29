import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import JSZip from "jszip"
import { XMLParser } from "fast-xml-parser"
import { promises as fsPromises } from "fs"
import crypto from "crypto"
import path from "path"
import { describeImageWithllm } from "./lib/describeImageWithllm"
import { DATASOURCE_CONFIG } from "./integrations/dataSource/config"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "pptChunks",
})

// Utility function to clean text consistent with PDF and DOCX processing
const cleanText = (str: string): string => {
  const normalized = str.replace(/\r\n|\r/g, "\n")
  return normalized.replace(
    /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\uFDD0-\uFDEF\uFFFE\uFFFF]/g,
    "",
  )
}

/**
 * Post-processes the extracted text to normalize whitespace and handle newlines intelligently.
 * Reusing the same logic as DOCX processing for consistency.
 */
const postProcessText = (text: string): string => {
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

/**
 * Chunk text by paragraphs with byte-based sizing and overlap.
 * Reusing the same logic as DOCX and PDF processing for consistency.
 */
function chunkTextByParagraph(
  text: string,
  maxChunkBytes = 512,
  overlapBytes = 128,
): string[] {
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  const chunks: string[] = []

  for (let p of paragraphs) {
    const pBytes = Buffer.byteLength(p, "utf8")
    if (pBytes <= maxChunkBytes) {
      chunks.push(p)
    } else {
      // Fallback to sentences
      const sentences = p.match(/[^\.!\?]+[\.!\?]+(\s|$)/g) || [p]
      let buffer = ""
      for (let sentence of sentences) {
        const sentenceTrim = sentence.trim()
        if (!sentenceTrim) continue
        const sentenceBytes = Buffer.byteLength(sentenceTrim, "utf8")
        const bufferBytes = Buffer.byteLength(buffer, "utf8")
        if (bufferBytes + sentenceBytes + 1 <= maxChunkBytes) {
          buffer = buffer ? buffer + " " + sentenceTrim : sentenceTrim
        } else {
          if (buffer) {
            chunks.push(buffer)
            // Overlap: take last overlapBytes from buffer as start for next chunk
            let overlapStr = ""
            let overlapLen = 0
            for (let i = buffer.length - 1; i >= 0; i--) {
              const charBytes = Buffer.byteLength(buffer[i], "utf8")
              if (overlapLen + charBytes > overlapBytes) break
              overlapStr = buffer[i] + overlapStr
              overlapLen += charBytes
            }
            buffer = overlapStr + " " + sentenceTrim
          } else {
            // Sentence longer than maxChunkBytes, push as is
            chunks.push(sentenceTrim)
            buffer = ""
          }
        }
      }
      if (buffer) {
        chunks.push(buffer)
      }
    }
  }

  return chunks
}

interface PptxContentItem {
  type: "text" | "image" | "title" | "table" | "notes"
  content?: string
  relId?: string
  pos: number
  slideNumber: number
}

interface PptxProcessingResult {
  text_chunks: string[]
  image_chunks: string[]
  text_chunk_pos: number[]
  image_chunk_pos: number[]
}

/**
 * Extract text content from PowerPoint text elements
 * Looks for <a:t> elements within text shapes
 */
function extractTextFromTextElements(element: any): string {
  let text = ""
  if (!element) return text

  // Helper function to recursively search for <a:t> elements
  const searchForText = (obj: any): string[] => {
    const textElements: string[] = []
    if (!obj || typeof obj !== "object") return textElements

    // Check if this is a text element
    if (obj["a:t"]) {
      const textContent = obj["a:t"]
      if (typeof textContent === "string") {
        textElements.push(textContent)
      } else if (textContent["#text"]) {
        textElements.push(textContent["#text"])
      }
    }

    // Recursively search all properties
    for (const key in obj) {
      if (typeof obj[key] === "object") {
        if (Array.isArray(obj[key])) {
          for (const item of obj[key]) {
            textElements.push(...searchForText(item))
          }
        } else {
          textElements.push(...searchForText(obj[key]))
        }
      }
    }

    return textElements
  }

  const textElements = searchForText(element)
  return textElements.join(" ")
}

/**
 * Extract slide title from title placeholders
 */
function extractSlideTitle(slideData: any): string {
  if (!slideData?.["p:sld"]?.["p:cSld"]?.["p:spTree"]) return ""

  const spTree = slideData["p:sld"]["p:cSld"]["p:spTree"]
  const shapes = []

  // Collect all shapes
  if (spTree["p:sp"]) {
    const textShapes = Array.isArray(spTree["p:sp"])
      ? spTree["p:sp"]
      : [spTree["p:sp"]]
    shapes.push(...textShapes)
  }

  // Look for title placeholder
  for (const shape of shapes) {
    if (!shape) continue

    // Check if this is a title placeholder
    const nvSpPr = shape["p:nvSpPr"]
    const ph = nvSpPr?.["p:nvPr"]?.["p:ph"]

    if (ph && (ph["@_type"] === "title" || ph["@_type"] === "ctrTitle")) {
      const titleText = extractTextFromTextElements(shape)
      if (titleText.trim()) {
        return titleText.trim()
      }
    }
  }

  return ""
}

/**
 * Extract table content from PowerPoint table elements
 */
function extractTableContent(element: any): string {
  if (!element || !element["a:tbl"]) return ""

  const table = element["a:tbl"]
  const rows: string[] = []

  // Extract table rows
  const tableRows = table["a:tr"] || []
  const rowsArray = Array.isArray(tableRows) ? tableRows : [tableRows]

  for (const row of rowsArray) {
    if (!row) continue

    const cells: string[] = []
    const tableCells = row["a:tc"] || []
    const cellsArray = Array.isArray(tableCells) ? tableCells : [tableCells]

    for (const cell of cellsArray) {
      if (!cell) continue
      const cellText = extractTextFromTextElements(cell)
      cells.push(cellText.trim() || "")
    }

    if (cells.some((cell) => cell.length > 0)) {
      rows.push(cells.join(" | "))
    }
  }

  return rows.length > 0 ? `\n**Table:**\n${rows.join("\n")}\n` : ""
}

/**
 * Extract chart text content (basic text elements from charts)
 */
function extractChartContent(element: any): string {
  if (!element) return ""

  // Look for chart references and extract any text
  const chartTexts: string[] = []

  // Helper to search for chart text elements
  const searchForChartText = (obj: any): void => {
    if (!obj || typeof obj !== "object") return

    // Look for chart title, axis labels, etc.
    if (obj["c:tx"] || obj["c:rich"] || obj["c:strRef"]) {
      const textContent = extractTextFromTextElements(obj)
      if (textContent.trim()) {
        chartTexts.push(textContent.trim())
      }
    }

    // Recursively search
    for (const key in obj) {
      if (typeof obj[key] === "object") {
        if (Array.isArray(obj[key])) {
          for (const item of obj[key]) {
            searchForChartText(item)
          }
        } else {
          searchForChartText(obj[key])
        }
      }
    }
  }

  searchForChartText(element)

  return chartTexts.length > 0 ? `\n**Chart:** ${chartTexts.join(", ")}\n` : ""
}

/**
 * Extract image relationship IDs from PowerPoint slide elements
 * Looks for <a:blip r:embed="rIdX"> elements
 */
function extractImageRelIds(element: any): string[] {
  const relIds: string[] = []
  if (!element) return relIds

  // Helper function to recursively search for image references
  const searchForImages = (obj: any): string[] => {
    const imageRels: string[] = []
    if (!obj || typeof obj !== "object") return imageRels

    // Check for blip elements with r:embed attributes
    if (obj["a:blip"]) {
      const blip = obj["a:blip"]
      if (blip["@_r:embed"]) {
        imageRels.push(blip["@_r:embed"])
      } else if (blip["r:embed"]) {
        imageRels.push(blip["r:embed"])
      }
    }

    // Also check for pic:blipFill elements
    if (obj["pic:blipFill"]) {
      const blipFill = obj["pic:blipFill"]
      const result = searchForImages(blipFill)
      imageRels.push(...result)
    }

    // Recursively search all properties
    for (const key in obj) {
      if (typeof obj[key] === "object") {
        if (Array.isArray(obj[key])) {
          for (const item of obj[key]) {
            imageRels.push(...searchForImages(item))
          }
        } else {
          imageRels.push(...searchForImages(obj[key]))
        }
      }
    }

    return imageRels
  }

  return searchForImages(element)
}

/**
 * Extract speaker notes from notes slide
 */
async function extractSpeakerNotes(
  zip: JSZip,
  parser: XMLParser,
  slideNumber: number,
): Promise<string> {
  try {
    const notesFile = `ppt/notesSlides/notesSlide${slideNumber}.xml`
    const notesXml = await zip.file(notesFile)?.async("text")

    if (!notesXml) return ""

    const notesData = parser.parse(notesXml)

    if (!notesData?.["p:notes"]?.["p:cSld"]?.["p:spTree"]) return ""

    const spTree = notesData["p:notes"]["p:cSld"]["p:spTree"]
    const shapes = []

    // Collect all shapes from notes
    if (spTree["p:sp"]) {
      const textShapes = Array.isArray(spTree["p:sp"])
        ? spTree["p:sp"]
        : [spTree["p:sp"]]
      shapes.push(...textShapes)
    }

    const notesTexts: string[] = []

    for (const shape of shapes) {
      if (!shape) continue

      // Check if this is a notes placeholder (not the slide thumbnail)
      const nvSpPr = shape["p:nvSpPr"]
      const ph = nvSpPr?.["p:nvPr"]?.["p:ph"]

      // Skip slide image placeholder, focus on body/notes placeholders
      if (
        ph &&
        (ph["@_type"] === "body" || ph["@_type"] === "obj" || !ph["@_type"])
      ) {
        const notesText = extractTextFromTextElements(shape)
        if (notesText.trim()) {
          notesTexts.push(notesText.trim())
        }
      }
    }

    return notesTexts.length > 0 ? notesTexts.join("\n") : ""
  } catch (error) {
    Logger.debug(
      `Could not extract speaker notes for slide ${slideNumber}: ${error instanceof Error ? error.message : error}`,
    )
    return ""
  }
}

/**
 * Parse slide relationships file to map relationship IDs to image paths
 */
function parseSlideRelationships(relsData: any): Map<string, string> {
  const relationships = new Map<string, string>()

  if (!relsData?.Relationships?.Relationship) {
    return relationships
  }

  const rels = relsData.Relationships.Relationship
  const relsArray = Array.isArray(rels) ? rels : [rels]

  for (const rel of relsArray) {
    if (rel["@_Id"] && rel["@_Target"]) {
      // Handle relative paths in PowerPoint
      let target = rel["@_Target"]
      if (target.startsWith("../")) {
        target = target.substring(3) // Remove ../ prefix
      }
      relationships.set(rel["@_Id"], target)
    }
  }

  return relationships
}

/**
 * Process slide content and extract text/image items in order
 */
function processSlideContent(
  slideData: any,
  slideNumber: number,
): PptxContentItem[] {
  const items: PptxContentItem[] = []
  let globalSeq = 0

  if (!slideData?.["p:sld"]?.["p:cSld"]?.["p:spTree"]) {
    Logger.warn(`No slide content found in slide ${slideNumber}`)
    return items
  }

  // Extract slide title first
  const slideTitle = extractSlideTitle(slideData)
  if (slideTitle) {
    items.push({
      type: "title",
      content: `## ${slideTitle}`,
      pos: globalSeq++,
      slideNumber: slideNumber,
    })
  }

  const spTree = slideData["p:sld"]["p:cSld"]["p:spTree"]

  // Get all shape elements (text boxes, images, etc.)
  const shapes = []

  // Collect different types of shapes
  if (spTree["p:sp"]) {
    const textShapes = Array.isArray(spTree["p:sp"])
      ? spTree["p:sp"]
      : [spTree["p:sp"]]
    shapes.push(...textShapes)
  }

  if (spTree["p:pic"]) {
    const pictures = Array.isArray(spTree["p:pic"])
      ? spTree["p:pic"]
      : [spTree["p:pic"]]
    shapes.push(...pictures)
  }

  if (spTree["p:grpSp"]) {
    const groupShapes = Array.isArray(spTree["p:grpSp"])
      ? spTree["p:grpSp"]
      : [spTree["p:grpSp"]]
    for (const grpSp of groupShapes) {
      // Process shapes within groups
      if (grpSp["p:sp"]) {
        const groupTextShapes = Array.isArray(grpSp["p:sp"])
          ? grpSp["p:sp"]
          : [grpSp["p:sp"]]
        shapes.push(...groupTextShapes)
      }
      if (grpSp["p:pic"]) {
        const groupPictures = Array.isArray(grpSp["p:pic"])
          ? grpSp["p:pic"]
          : [grpSp["p:pic"]]
        shapes.push(...groupPictures)
      }
    }
  }

  // Also check for graphic frames (tables, charts)
  if (spTree["p:graphicFrame"]) {
    const graphicFrames = Array.isArray(spTree["p:graphicFrame"])
      ? spTree["p:graphicFrame"]
      : [spTree["p:graphicFrame"]]
    shapes.push(...graphicFrames)
  }

  Logger.debug(`Found ${shapes.length} shapes in slide ${slideNumber}`)

  // Process each shape
  for (const shape of shapes) {
    if (!shape) continue

    // Check for tables first
    const tableContent = extractTableContent(shape)
    if (tableContent) {
      items.push({
        type: "table",
        content: cleanText(tableContent),
        pos: globalSeq++,
        slideNumber: slideNumber,
      })
    }

    // Check for charts
    const chartContent = extractChartContent(shape)
    if (chartContent) {
      items.push({
        type: "text",
        content: cleanText(chartContent),
        pos: globalSeq++,
        slideNumber: slideNumber,
      })
    }

    // Check for images
    const imageRelIds = extractImageRelIds(shape)
    for (const relId of imageRelIds) {
      Logger.debug(
        `Found image with relationship ID: ${relId} in slide ${slideNumber}`,
      )
      items.push({
        type: "image",
        relId: relId,
        pos: globalSeq++,
        slideNumber: slideNumber,
      })
    }

    // Extract text content (skip if it's a title placeholder since we already handled it)
    const nvSpPr = shape["p:nvSpPr"]
    const ph = nvSpPr?.["p:nvPr"]?.["p:ph"]
    const isTitle =
      ph && (ph["@_type"] === "title" || ph["@_type"] === "ctrTitle")

    if (!isTitle && !tableContent && !chartContent) {
      const textContent = extractTextFromTextElements(shape)
      if (textContent.trim()) {
        items.push({
          type: "text",
          content: cleanText(textContent),
          pos: globalSeq++,
          slideNumber: slideNumber,
        })
      }
    }
  }

  Logger.debug(
    `Processed ${items.length} content items from slide ${slideNumber}`,
  )
  return items
}

/**
 * Process text items into chunks and add to results
 * Returns the overlap text to maintain continuity across images
 */
function processTextItems(
  textItems: string[],
  text_chunks: string[],
  text_chunk_pos: number[],
  startPos: number,
  overlapBytes: number = 32,
): { nextPos: number; overlapText: string } {
  if (textItems.length === 0) return { nextPos: startPos, overlapText: "" }

  const cleanedText = textItems.join("\n")
  const chunks = chunkTextByParagraph(cleanedText, 512, 128)

  let currentPos = startPos
  for (const chunk of chunks) {
    text_chunks.push(chunk)
    text_chunk_pos.push(currentPos++)
  }

  // Return overlap text for continuity across images
  // Take the last overlapBytes from the processed text, but respect word boundaries
  let overlapText = ""
  if (cleanedText.trim()) {
    const words = cleanedText.trim().split(/\s+/)
    let overlapLen = 0

    // Build overlap from the end, word by word
    for (let i = words.length - 1; i >= 0; i--) {
      const word = words[i]
      const wordBytes = Buffer.byteLength(word + " ", "utf8")

      if (overlapLen + wordBytes > overlapBytes && overlapText) break

      overlapText = word + (overlapText ? " " + overlapText : "")
      overlapLen += wordBytes
    }
  }

  return { nextPos: currentPos, overlapText }
}

export async function extractTextAndImagesWithChunksFromPptx(
  data: Uint8Array,
  docid: string = crypto.randomUUID(),
  extractImages: boolean = false,
): Promise<PptxProcessingResult> {
  Logger.info(`Starting PPTX processing for document: ${docid}`)
  let totalTextLength = 0
  // Load the PPTX data directly
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(data)
  } catch (error) {
    const { name, message } = error as Error
    if (
      message.includes("PasswordException") ||
      name.includes("PasswordException")
    ) {
      Logger.warn("Password protected PPTX, skipping")
    } else {
      Logger.error(error, `PPTX load error: ${error}`)
    }
    return {
      text_chunks: [],
      image_chunks: [],
      text_chunk_pos: [],
      image_chunk_pos: [],
    }
  }

  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
    })

    let text_chunks: string[] = []
    let image_chunks: string[] = []
    let text_chunk_pos: number[] = []
    let image_chunk_pos: number[] = []

    let globalSeq = 0
    let crossImageOverlap = "" // Track overlap across images

    // Initialize a Set for duplicate image detection
    const seenHashDescriptions = new Map<string, string>()

    // Find all slide files
    const slideFiles = Object.keys(zip.files).filter(
      (filename) =>
        filename.startsWith("ppt/slides/slide") && filename.endsWith(".xml"),
    )

    Logger.info(`Found ${slideFiles.length} slides to process`)

    // Process slides in order
    slideFiles.sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] || "0")
      const numB = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] || "0")
      return numA - numB
    })

    for (const slideFile of slideFiles) {
      const slideNumber = parseInt(
        slideFile.match(/slide(\d+)\.xml$/)?.[1] || "0",
      )
      Logger.debug(`Processing slide ${slideNumber}`)

      // Parse slide content
      const slideXml = await zip.file(slideFile)?.async("text")
      if (!slideXml) {
        Logger.warn(`Could not read slide file: ${slideFile}`)
        continue
      }

      const slideData = parser.parse(slideXml)

      // Parse slide relationships
      const relsFile = slideFile
        .replace(".xml", ".xml.rels")
        .replace("ppt/slides/", "ppt/slides/_rels/")
      let relationships: Map<string, string> = new Map()

      const relsXml = await zip.file(relsFile)?.async("text")
      if (relsXml) {
        const relsData = parser.parse(relsXml)
        relationships = parseSlideRelationships(relsData)
      }

      // Extract content items from slide
      const contentItems = processSlideContent(slideData, slideNumber)

      // Extract speaker notes
      const speakerNotes = await extractSpeakerNotes(zip, parser, slideNumber)
      if (speakerNotes) {
        contentItems.push({
          type: "notes",
          content: `\n**Speaker Notes:**\n${speakerNotes}`,
          pos: contentItems.length,
          slideNumber: slideNumber,
        })
      }

      // Process items sequentially, handling overlap properly
      let textBuffer: string[] = []
      let textStartPos = globalSeq

      const flushTextBuffer = () => {
        if (textBuffer.length > 0) {
          // Only apply crossImageOverlap if we actually have images being processed
          let textToProcess = textBuffer
          if (crossImageOverlap && extractImages) {
            textToProcess = [crossImageOverlap + " " + textBuffer.join("\n")]
            crossImageOverlap = "" // Clear after using
          }

          const { nextPos, overlapText } = processTextItems(
            textToProcess,
            text_chunks,
            text_chunk_pos,
            textStartPos,
          )
          textBuffer = []
          textStartPos = nextPos
          globalSeq = nextPos
          // Only store overlap for continuation if we're extracting images
          if (extractImages) {
            crossImageOverlap = overlapText
          }
        }
      }

      for (const item of contentItems) {
        if (
          (item.type === "text" ||
            item.type === "title" ||
            item.type === "table" ||
            item.type === "notes") &&
          item.content
        ) {
          if (
            totalTextLength + item.content.length <=
            DATASOURCE_CONFIG.MAX_PPTX_TEXT_LEN
          ) {
            textBuffer.push(item.content)
            totalTextLength += item.content.length
          } else {
            Logger.info(
              `Text Length exceeded for ${docid}, indexing with incomplete content`,
            )
            break
          }
        } else if (item.type === "image" && item.relId && extractImages) {
          // Flush any pending text before processing image
          flushTextBuffer()

          // Process image
          const imagePath = relationships.get(item.relId)
          if (imagePath) {
            try {
              const fullImagePath = `ppt/${imagePath}`
              const imageFile = zip.file(fullImagePath)

              if (imageFile) {
                const imageBuffer = await imageFile.async("nodebuffer")

                // Skip small images
                if (imageBuffer.length < 10000) {
                  Logger.debug(`Skipping small image: ${imagePath}`)
                  continue
                }

                if (
                  imageBuffer.length >
                  DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024
                ) {
                  Logger.warn(
                    `Skipping large image (${(imageBuffer.length / (1024 * 1024)).toFixed(2)} MB): ${imagePath}`,
                  )
                  continue
                }

                const imageExtension = path.extname(imagePath).toLowerCase()
                if (
                  !DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES.has(
                    `image/${imageExtension.slice(1)}`,
                  )
                ) {
                  Logger.warn(
                    `Unsupported image format: ${imageExtension}. Skipping image: ${imagePath}`,
                  )
                  continue
                }

                const imageHash = crypto
                  .createHash("md5")
                  .update(new Uint8Array(imageBuffer))
                  .digest("hex")

                let description: string

                if (seenHashDescriptions.has(imageHash)) {
                  description = seenHashDescriptions.get(imageHash)!
                  Logger.warn(
                    `Reusing description for repeated image ${imagePath} in slide ${slideNumber}`,
                  )
                } else {
                  description = await describeImageWithllm(imageBuffer)
                  if (
                    description === "No description returned." ||
                    description === "Image is not worth describing."
                  ) {
                    Logger.warn(
                      `${description} ${imagePath} in slide ${slideNumber}`,
                    )
                    continue
                  }
                  seenHashDescriptions.set(imageHash, description)
                }

                // Save image to disk
                try {
                  const baseDir = path.resolve(
                    process.env.IMAGE_DIR || "downloads/xyne_images_db",
                  )
                  const outputDir = path.join(baseDir, docid)
                  await fsPromises.mkdir(outputDir, { recursive: true })

                  const imageExtension = path.extname(imagePath) || ".png"
                  const imageFilename = `${globalSeq}${imageExtension}`
                  const outputPath = path.join(outputDir, imageFilename)

                  await fsPromises.writeFile(
                    outputPath,
                    new Uint8Array(imageBuffer),
                  )
                  Logger.info(`Saved image to: ${outputPath}`)
                } catch (saveError) {
                  Logger.error(
                    `Failed to save image ${imagePath}: ${saveError instanceof Error ? saveError.message : saveError}`,
                  )
                  continue
                }

                image_chunks.push(description)
                image_chunk_pos.push(globalSeq)
                // Add image placeholder to existing overlap text for continuity
                crossImageOverlap += ` [[IMG#${globalSeq}]] `
                globalSeq++

                Logger.debug(
                  `Successfully processed image: ${imagePath} from slide ${slideNumber}`,
                )
              } else {
                Logger.warn(`Could not find image file: ${fullImagePath}`)
              }
            } catch (error) {
              Logger.warn(
                `Failed to process image ${imagePath} from slide ${slideNumber}: ${error instanceof Error ? error.message : error}`,
              )
            }
          } else {
            Logger.warn(
              `Could not resolve relationship ID: ${item.relId} in slide ${slideNumber}`,
            )
          }
        }
      }

      // Flush any remaining text from this slide
      flushTextBuffer()
    }

    // Flush any remaining text with cross-image overlap (only if we were extracting images)
    if (crossImageOverlap && extractImages) {
      const { nextPos, overlapText } = processTextItems(
        [crossImageOverlap],
        text_chunks,
        text_chunk_pos,
        globalSeq,
      )
      globalSeq = nextPos
      crossImageOverlap = "" // Clear after using
    }

    Logger.info(
      `PPTX processing completed. Total text chunks: ${text_chunks.length}, Total image chunks: ${image_chunks.length}`,
    )

    return {
      text_chunks,
      image_chunks,
      text_chunk_pos,
      image_chunk_pos,
    }
  } finally {
    //@ts-ignore
    zip = null
  }
}
