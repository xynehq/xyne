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
  module: "docxChunks",
})

// Utility function to clean text consistent with PDF processing
const cleanText = (str: string): string => {
  const normalized = str.replace(/\r\n|\r/g, "\n")
  return normalized.replace(
    /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\uFDD0-\uFDEF\uFFFE\uFFFF]/g,
    "",
  )
}

/**
 * Post-processes the extracted text to normalize whitespace and handle newlines intelligently.
 * Reusing the same logic as Google Docs processing for consistency.
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
 * Reusing the same logic as PDF processing for consistency.
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

interface DocxContentItem {
  type: "text" | "image"
  content?: string
  relId?: string
  pos: number
}

interface DocxProcessingResult {
  text_chunks: string[]
  image_chunks: string[]
  text_chunk_pos: number[]
  image_chunk_pos: number[]
}

/**
 * Get heading prefix based on paragraph style (similar to Google Docs processing)
 */
function getHeadingPrefix(paragraph: any): string {
  const pStyle = paragraph["w:pPr"]?.["w:pStyle"]?.["@_w:val"]
  if (pStyle) {
    const headingMatch = pStyle.match(/[Hh]eading(\d+)/)
    if (headingMatch) {
      const level = parseInt(headingMatch[1])
      return "#".repeat(level) + " "
    }
  }
  return ""
}

/**
 * Helper to extract Office Math equations from a paragraph.
 * Returns a string with [MATH: ...] placeholders for each equation found.
 */
function extractMathFromParagraph(paragraph: any): string {
  let mathTexts: string[] = []
  if (!paragraph) return ""

  // Helper to serialize math block to a simplified string
  function serializeMathBlock(mathBlock: any): string {
    // Try to extract all text nodes under the math block
    let result = ""
    function traverse(node: any) {
      if (!node || typeof node !== "object") return
      // If it's a text node
      if (typeof node["w:t"] === "string") {
        result += node["w:t"]
      }
      if (typeof node["#text"] === "string") {
        result += node["#text"]
      }
      // Recursively traverse all children
      for (const key of Object.keys(node)) {
        if (typeof node[key] === "object") {
          traverse(node[key])
        }
        if (Array.isArray(node[key])) {
          for (const child of node[key]) {
            traverse(child)
          }
        }
      }
    }
    traverse(mathBlock)
    return result.trim()
  }

  // Look for <m:oMath> and <m:oMathPara> blocks directly in the paragraph
  // In DOCX XML, these are typically at the paragraph or run level
  if (paragraph["m:oMath"]) {
    const mathBlocks = Array.isArray(paragraph["m:oMath"])
      ? paragraph["m:oMath"]
      : [paragraph["m:oMath"]]
    for (const mathBlock of mathBlocks) {
      const mathString = serializeMathBlock(mathBlock)
      if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
    }
  }
  if (paragraph["m:oMathPara"]) {
    const mathParas = Array.isArray(paragraph["m:oMathPara"])
      ? paragraph["m:oMathPara"]
      : [paragraph["m:oMathPara"]]
    for (const mathPara of mathParas) {
      // m:oMathPara may contain m:oMath as children
      if (mathPara["m:oMath"]) {
        const mathBlocks = Array.isArray(mathPara["m:oMath"])
          ? mathPara["m:oMath"]
          : [mathPara["m:oMath"]]
        for (const mathBlock of mathBlocks) {
          const mathString = serializeMathBlock(mathBlock)
          if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
        }
      } else {
        // Or just serialize the whole oMathPara
        const mathString = serializeMathBlock(mathPara)
        if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
      }
    }
  }
  // Also look for math blocks inside runs
  const runs = paragraph["w:r"] || paragraph.r || []
  const runsArray = Array.isArray(runs) ? runs : [runs]
  for (const run of runsArray) {
    if (!run) continue
    if (run["m:oMath"]) {
      const mathBlocks = Array.isArray(run["m:oMath"])
        ? run["m:oMath"]
        : [run["m:oMath"]]
      for (const mathBlock of mathBlocks) {
        const mathString = serializeMathBlock(mathBlock)
        if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
      }
    }
    if (run["m:oMathPara"]) {
      const mathParas = Array.isArray(run["m:oMathPara"])
        ? run["m:oMathPara"]
        : [run["m:oMathPara"]]
      for (const mathPara of mathParas) {
        if (mathPara["m:oMath"]) {
          const mathBlocks = Array.isArray(mathPara["m:oMath"])
            ? mathPara["m:oMath"]
            : [mathPara["m:oMath"]]
          for (const mathBlock of mathBlocks) {
            const mathString = serializeMathBlock(mathBlock)
            if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
          }
        } else {
          const mathString = serializeMathBlock(mathPara)
          if (mathString) mathTexts.push(`[MATH: ${mathString}]`)
        }
      }
    }
  }
  return mathTexts.join(" ")
}

/**
 * Extract text content from a paragraph element with enhanced formatting support
 * Now also extracts Office Math equations as [MATH: ...] placeholders.
 */
function extractTextFromParagraph(paragraph: any, documentData?: any): string {
  let text = ""
  if (!paragraph) return text

  // --- Removed explicit page break detection ---
  const runs = paragraph["w:r"] || paragraph.r || []
  const runsArray = Array.isArray(runs) ? runs : [runs]

  // Hyperlink handling
  if (paragraph["w:hyperlink"]) {
    const hyperlinks = Array.isArray(paragraph["w:hyperlink"])
      ? paragraph["w:hyperlink"]
      : [paragraph["w:hyperlink"]]
    return hyperlinks
      .map((hl) => {
        const relId = hl["@_r:id"]
        const hyperlinkRuns = hl["w:r"] || []
        const hyperlinkRunsArray = Array.isArray(hyperlinkRuns)
          ? hyperlinkRuns
          : [hyperlinkRuns]
        const hyperlinkText = hyperlinkRunsArray
          .map((r) => {
            const textEl = r["w:t"]
            return typeof textEl === "string" ? textEl : textEl?.["#text"] || ""
          })
          .join(" ")
        if (
          relId &&
          documentData?.__rels &&
          typeof documentData.__rels.get === "function" &&
          documentData.__rels.has(relId)
        ) {
          const href = documentData.__rels.get(relId)
          return `[${hyperlinkText}](${href})`
        }
        return hyperlinkText
      })
      .join(" ")
  }

  // Check for list formatting
  const numPr = paragraph["w:pPr"]?.["w:numPr"]
  let isListItem = false
  let listLevel = 0

  if (numPr) {
    isListItem = true
    listLevel = parseInt(numPr["w:ilvl"]?.["@_w:val"] || "0")
  }

  // Handle different paragraph structures
  for (const run of runsArray) {
    if (!run) continue

    // Extract text from run
    const textElement = run["w:t"] || run.t
    if (textElement) {
      if (typeof textElement === "string") {
        text += textElement
      } else if (textElement["#text"]) {
        text += textElement["#text"]
      }
    }

    // Handle footnote references
    const footnoteRef = run["w:footnoteReference"]
    if (footnoteRef) {
      const footnoteId = footnoteRef["@_w:id"]
      if (footnoteId) {
        text += `[^${footnoteId}]`
      }
    }

    // Handle comment references
    const commentRef = run["w:commentReference"]
    if (commentRef) {
      const commentId = commentRef["@_w:id"]
      if (commentId && documentData?.__comments?.has(commentId)) {
        text += ` [^comment-${commentId}]`
      }
    }

    // Handle tabs and breaks
    if (run["w:tab"] || run.tab) {
      text += "\t"
    }
    if (run["w:br"] || run.br) {
      text += "\n"
    }
  }

  // Extract math equations and append as placeholders
  const mathText = extractMathFromParagraph(paragraph)
  if (mathText) {
    if (text.trim()) {
      text += " " + mathText
    } else {
      text = mathText
    }
  }

  // Apply list formatting
  if (isListItem && text.trim()) {
    const indent = "  ".repeat(listLevel)
    text = indent + "- " + text.trim()
  }

  // Apply heading formatting
  if (!isListItem && text.trim()) {
    const headingPrefix = getHeadingPrefix(paragraph)
    text = headingPrefix + text.trim()
  }

  return text
}

/**
 * Extract text from table elements
 */
function extractTextFromTable(table: any, documentData?: any): string {
  if (!table) return ""

  const rows = table["w:tr"] || []
  const rowsArray = Array.isArray(rows) ? rows : [rows]

  return (
    rowsArray
      .map((row) => {
        const cells = row["w:tc"] || []
        const cellsArray = Array.isArray(cells) ? cells : [cells]

        return cellsArray
          .map((cell) => {
            const paragraphs = cell["w:p"] || []
            const paragraphsArray = Array.isArray(paragraphs)
              ? paragraphs
              : [paragraphs]

            return paragraphsArray
              .map((p) => extractTextFromParagraph(p, documentData))
              .join("\n")
          })
          .join("\t") // Tab-separated cells
      })
      .join("\n") + "\n\n"
  ) // Newline-separated rows with extra spacing
}

/**
 * Extract relationship ID from drawing/picture elements
 */
function extractImageRelId(element: any): string | null {
  // Enhanced search function to handle namespaced XML elements
  const searchForEmbed = (obj: any): string | null => {
    if (!obj || typeof obj !== "object") return null

    // Direct r:embed attribute (different namespace variations)
    if (obj["r:embed"]) return obj["r:embed"]
    if (obj["@_r:embed"]) return obj["@_r:embed"]
    if (obj.embed) return obj.embed

    // Search for blip elements with various namespaces
    for (const key in obj) {
      if (
        key.includes("blip") ||
        key.includes("Blip") ||
        key === "a:blip" ||
        key === "pic:blipFill"
      ) {
        const blip = obj[key]
        if (blip) {
          // Check for r:embed in the blip
          if (blip["r:embed"]) return blip["r:embed"]
          if (blip["@_r:embed"]) return blip["@_r:embed"]
          if (blip.embed) return blip.embed

          // Check nested blip elements
          const result = searchForEmbed(blip)
          if (result) return result
        }
      }

      // Recursive search for all objects
      if (typeof obj[key] === "object") {
        const result = searchForEmbed(obj[key])
        if (result) return result
      }
    }

    return null
  }

  // Handle w:drawing elements at paragraph level
  if (element["w:drawing"] || element.drawing) {
    const drawing = element["w:drawing"] || element.drawing
    return searchForEmbed(drawing)
  }

  // Handle w:pict elements at paragraph level (older format)
  if (element["w:pict"] || element.pict) {
    const pict = element["w:pict"] || element.pict
    return searchForEmbed(pict)
  }

  // Check in runs for drawing/pict elements
  const runs = element["w:r"] || []
  const runsArray = Array.isArray(runs) ? runs : [runs]

  for (const run of runsArray) {
    if (!run) continue

    // Handle w:drawing in runs
    if (run["w:drawing"] || run.drawing) {
      const drawing = run["w:drawing"] || run.drawing
      const result = searchForEmbed(drawing)
      if (result) return result
    }

    // Handle w:pict in runs (older format)
    if (run["w:pict"] || run.pict) {
      const pict = run["w:pict"] || run.pict
      const result = searchForEmbed(pict)
      if (result) return result
    }
  }

  return null
}

/**
 * Process DOCX content and extract text/image items in order with enhanced support
 */
function processDocumentContent(documentData: any): DocxContentItem[] {
  const items: DocxContentItem[] = []
  let globalSeq = 0

  if (!documentData?.["w:document"]?.["w:body"]) {
    Logger.warn("No document body found in DOCX")
    return items
  }

  const body = documentData["w:document"]["w:body"]

  // Process paragraphs first
  const paragraphs = body["w:p"] || []
  const paragraphsArray = Array.isArray(paragraphs) ? paragraphs : [paragraphs]

  // Process tables
  const tables = body["w:tbl"] || []
  const tablesArray = Array.isArray(tables) ? tables : [tables]

  Logger.debug(
    `Found ${paragraphsArray.length} paragraphs and ${tablesArray.length} tables to process`,
  )

  // Process paragraphs (which may contain images and math)
  for (const element of paragraphsArray) {
    if (!element) continue

    // Check for images first
    const imageRelId = extractImageRelId(element)
    if (imageRelId) {
      Logger.debug(`Found image with relationship ID: ${imageRelId}`)
      items.push({
        type: "image",
        relId: imageRelId,
        pos: globalSeq++,
      })
      continue
    }

    // Extract text content (including math equations)
    const textContent = extractTextFromParagraph(element, documentData)
    // Removed explicit page break marker logic
    if (textContent.trim()) {
      items.push({
        type: "text",
        content: cleanText(textContent),
        pos: globalSeq++,
      })
    }
  }

  // Process tables
  for (const table of tablesArray) {
    if (!table) continue
    const tableText = extractTextFromTable(table, documentData)
    if (tableText.trim()) {
      items.push({
        type: "text",
        content: cleanText(tableText),
        pos: globalSeq++,
      })
    }
  }

  Logger.debug(
    `Processed ${items.length} content items, ${items.filter((i) => i.type === "image").length} images`,
  )
  return items
}

/**
 * Extract footnotes from DOCX document
 */
async function extractFootnotes(
  zip: JSZip,
  parser: XMLParser,
): Promise<string> {
  try {
    const footnotesXml = zip.file("word/footnotes.xml")
    if (!footnotesXml) return ""

    const footnotesText = await footnotesXml.async("text")
    const footnotesData = parser.parse(footnotesText)
    if (!footnotesData?.["w:footnotes"]?.["w:footnote"]) return ""

    const footnotes = footnotesData["w:footnotes"]["w:footnote"]
    const footnotesArray = Array.isArray(footnotes) ? footnotes : [footnotes]

    return footnotesArray
      .map((footnote) => {
        const id = footnote["@_w:id"]
        if (!id || id === "-1" || id === "0") return "" // Skip separator and continuation footnotes

        const paragraphs = footnote["w:p"] || []
        const paragraphsArray = Array.isArray(paragraphs)
          ? paragraphs
          : [paragraphs]

        const content = paragraphsArray
          .map((p) => extractTextFromParagraph(p))
          .join(" ")
          .trim()

        return content ? `[^${id}]: ${content}` : ""
      })
      .filter((f) => f)
      .join("\n")
  } catch (error) {
    Logger.warn(
      `Could not extract footnotes: ${error instanceof Error ? error.message : error}`,
    )
    return ""
  }
}

/**
 * Extract headers and footers from DOCX document
 */
async function extractHeadersAndFooters(
  zip: JSZip,
  parser: XMLParser,
): Promise<string> {
  let headerFooter = ""

  try {
    // Extract headers
    for (let i = 1; i <= 3; i++) {
      const headerFile = zip.file(`word/header${i}.xml`)
      if (headerFile) {
        const headerText = await headerFile.async("text")
        const headerData = parser.parse(headerText)
        if (headerData?.["w:hdr"]?.["w:p"]) {
          const paragraphs = headerData["w:hdr"]["w:p"]
          const paragraphsArray = Array.isArray(paragraphs)
            ? paragraphs
            : [paragraphs]

          const content = paragraphsArray
            .map((p) => extractTextFromParagraph(p))
            .join(" ")
            .trim()

          if (content) {
            headerFooter += `Header (${i}):\n${content}\n\n`
          }
        }
      }
    }

    // Extract footers
    for (let i = 1; i <= 3; i++) {
      const footerFile = zip.file(`word/footer${i}.xml`)
      if (footerFile) {
        const footerText = await footerFile.async("text")
        const footerData = parser.parse(footerText)
        if (footerData?.["w:ftr"]?.["w:p"]) {
          const paragraphs = footerData["w:ftr"]["w:p"]
          const paragraphsArray = Array.isArray(paragraphs)
            ? paragraphs
            : [paragraphs]

          const content = paragraphsArray
            .map((p) => extractTextFromParagraph(p))
            .join(" ")
            .trim()

          if (content) {
            headerFooter += `Footer (${i}):\n${content}\n\n`
          }
        }
      }
    }
  } catch (error) {
    Logger.warn(
      `Could not extract headers/footers: ${error instanceof Error ? error.message : error}`,
    )
  }

  return headerFooter
}

/**
 * Parse relationships file to map relationship IDs to file paths
 */
function parseRelationships(relsData: any): Map<string, string> {
  const relationships = new Map<string, string>()

  if (!relsData?.Relationships?.Relationship) {
    return relationships
  }

  const rels = relsData.Relationships.Relationship
  const relsArray = Array.isArray(rels) ? rels : [rels]

  for (const rel of relsArray) {
    if (rel["@_Id"] && rel["@_Target"]) {
      // Remove leading slash and word/ prefix if present
      let target = rel["@_Target"]
      if (target.startsWith("/")) target = target.substring(1)
      if (target.startsWith("word/")) target = target.substring(5)

      relationships.set(rel["@_Id"], target)
    }
  }

  return relationships
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
  // Take the last overlapBytes from the processed text
  let overlapText = ""
  let overlapLen = 0
  for (let i = cleanedText.length - 1; i >= 0; i--) {
    const charBytes = Buffer.byteLength(cleanedText[i], "utf8")
    if (overlapLen + charBytes > overlapBytes) break
    overlapText = cleanedText[i] + overlapText
    overlapLen += charBytes
  }

  return { nextPos: currentPos, overlapText }
}

export async function extractTextAndImagesWithChunksFromDocx(
  data: Uint8Array,
  docid: string = crypto.randomUUID(),
  extractImages: boolean = false,
): Promise<DocxProcessingResult> {
  Logger.info(`Starting DOCX processing for document: ${docid}`)

  // Load the DOCX data directly
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(data)
  } catch (error) {
    const { name, message } = error as Error
    if (
      message.includes("PasswordException") ||
      name.includes("PasswordException")
    ) {
      Logger.warn("Password protected DOCX, skipping")
    } else {
      Logger.error(error, `DOCX load error: ${error}`)
    }
    return {
      text_chunks: [],
      image_chunks: [],
      text_chunk_pos: [],
      image_chunk_pos: [],
    }
  }

  try {
    // Parse the main document
    const documentXml = await zip.file("word/document.xml")?.async("text")
    if (!documentXml) {
      throw new Error("Could not find word/document.xml in DOCX file")
    }

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
    })

    const documentData = parser.parse(documentXml)

    let relationships: Map<string, string> | null = null
    // Always parse relationships for hyperlinks
    const relsXml = await zip
      .file("word/_rels/document.xml.rels")
      ?.async("text")
    if (relsXml) {
      const relsData = parser.parse(relsXml)
      relationships = parseRelationships(relsData)
      // Store into documentData to access during hyperlink extraction
      documentData.__rels = relationships
    }

    // Parse comments.xml
    let commentsMap: Map<string, string> = new Map()
    const commentsXml = await zip.file("word/comments.xml")?.async("text")
    if (commentsXml) {
      const commentsData = parser.parse(commentsXml)
      const comments = commentsData?.["w:comments"]?.["w:comment"]
      const commentsArray = Array.isArray(comments) ? comments : [comments]
      for (const comment of commentsArray) {
        const id = comment["@_w:cid"]
        const commentParas = comment["w:p"] || []
        const commentParasArray = Array.isArray(commentParas)
          ? commentParas
          : [commentParas]
        const text = commentParasArray
          .map((p) => extractTextFromParagraph(p))
          .join(" ")
          .trim()
        if (id && text) {
          commentsMap.set(id, text)
        }
      }
    }
    documentData.__comments = commentsMap

    // Extract content items in order
    const contentItems = processDocumentContent(documentData)

    // Extract footnotes, headers, and footers
    const footnotes = await extractFootnotes(zip, parser)
    const headerFooter = await extractHeadersAndFooters(zip, parser)

    let text_chunks: string[] = []
    let image_chunks: string[] = []
    let text_chunk_pos: number[] = []
    let image_chunk_pos: number[] = []

    let globalSeq = 0
    let crossImageOverlap = "" // Track overlap across images

    // Initialize a Set for duplicate image detection
    const seenHashDescriptions = new Map<string, string>()

    // Process items sequentially, handling overlap properly
    let textBuffer: string[] = []
    let textStartPos = globalSeq

    const flushTextBuffer = () => {
      if (textBuffer.length > 0) {
        // If we have crossImageOverlap, prepend it to the text buffer
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
      if (item.type === "text" && item.content) {
        textBuffer.push(item.content)
      } else if (
        item.type === "image" &&
        item.relId &&
        extractImages &&
        relationships
      ) {
        // Flush any pending text before processing image
        flushTextBuffer()

        // Process image
        const imagePath = relationships.get(item.relId)
        if (imagePath) {
          // 5MB limit
          try {
            const fullImagePath = `word/${imagePath}`
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
                  `Reusing description for repeated image ${imagePath}`,
                )
              } else {
                description = await describeImageWithllm(imageBuffer)
                if (
                  description === "No description returned." ||
                  description === "Image is not worth describing."
                ) {
                  Logger.warn(`${description} ${imagePath}`)
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

              Logger.debug(`Successfully processed image: ${imagePath}`)
            } else {
              Logger.warn(`Could not find image file: ${fullImagePath}`)
            }
          } catch (error) {
            Logger.warn(
              `Failed to process image ${imagePath}: ${error instanceof Error ? error.message : error}`,
            )
          }
        } else {
          Logger.warn(`Could not resolve relationship ID: ${item.relId}`)
        }
      }
    }

    // Flush any remaining text with cross-image overlap
    if (textBuffer.length > 0 || crossImageOverlap) {
      // Combine any remaining text with accumulated image placeholders
      const textContent = textBuffer.length > 0 ? textBuffer.join("\n") : ""
      const combinedText = crossImageOverlap
        ? crossImageOverlap + " " + textContent
        : textContent

      if (combinedText.trim()) {
        const { nextPos, overlapText } = processTextItems(
          [combinedText],
          text_chunks,
          text_chunk_pos,
          textStartPos,
        )
        globalSeq = nextPos
        crossImageOverlap = "" // Clear after using
      }
    }

    // Add footnotes and headers/footers to the end if they exist
    if (footnotes || headerFooter) {
      const additionalContent = [footnotes, headerFooter]
        .filter(Boolean)
        .join("\n\n")
      if (additionalContent.trim()) {
        const postProcessedContent = postProcessText(additionalContent)
        const finalContent = crossImageOverlap
          ? crossImageOverlap + " " + postProcessedContent
          : postProcessedContent
        const { nextPos, overlapText } = processTextItems(
          [finalContent],
          text_chunks,
          text_chunk_pos,
          globalSeq,
        )
        globalSeq = nextPos
        crossImageOverlap = "" // Clear after final processing
      }
    }

    // Add comments as footnotes
    if (commentsMap.size > 0) {
      const commentFootnotes = Array.from(commentsMap.entries()).map(
        ([id, text]) => `[^comment-${id}]: ${text}`,
      )
      const postProcessed = postProcessText(commentFootnotes.join("\n"))
      const finalContent = crossImageOverlap
        ? crossImageOverlap + " " + postProcessed
        : postProcessed
      const { nextPos, overlapText } = processTextItems(
        [finalContent],
        text_chunks,
        text_chunk_pos,
        globalSeq,
      )
      globalSeq = nextPos
      //   crossImageOverlap = "" // Clear after final processing
    }

    Logger.info(
      `DOCX processing completed. Total text chunks: ${text_chunks.length}, Total image chunks: ${image_chunks.length}`,
    )

    return {
      text_chunks,
      image_chunks,
      text_chunk_pos,
      image_chunk_pos,
    }
  } finally {
    // @ts-ignore
    zip = null
  }
}
