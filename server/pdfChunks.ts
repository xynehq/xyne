import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { createCanvas, Image as CanvasImage, ImageData } from "canvas"
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs"
import path from "path"
import imageType from "image-type"
import { promises as fsPromises } from "fs"
import crypto from "crypto"
import { describeImageWithllm } from "./lib/describeImageWithllm"
import { DATASOURCE_CONFIG } from "./integrations/dataSource/config"
import { chunkTextByParagraph } from "./chunks"

const openjpegWasmPath =
  path.join(__dirname, "../node_modules/pdfjs-dist/wasm/") + "/"
const qcmsWasmPath =
  path.join(__dirname, "../node_modules/pdfjs-dist/wasm/") + "/"
const seenHashDescriptions = new Map<string, string>()
const MIN_IMAGE_DIM_PX = parseInt(process.env.MIN_IMAGE_DIM_PX || "150", 10)

const Logger = getLogger(Subsystem.Integrations).child({
  module: "pdfChunks",
})

const PDFJS = pdfjsLib

// Utility function to clean text consistent with chunkTextByParagraph
// const cleanText = (str: string): string => {
//   console.log('CLEAN TEXT DEBUG: Input string length:', str.length)
//   console.log('CLEAN TEXT DEBUG: Input string:', str)
  
//   const normalized = str.replace(/\r\n|\r/g, "\n")
//   console.log('CLEAN TEXT DEBUG: After normalization length:', normalized.length)
//   console.log('CLEAN TEXT DEBUG: After normalization:', normalized)
  
//   const cleaned = normalized.replace(
//     /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\uFDD0-\uFDEF\uFFFE\uFFFF]/g,
//     "",
//   )
//   console.log('CLEAN TEXT DEBUG: After cleaning length:', cleaned.length)
//   console.log('CLEAN TEXT DEBUG: Cleaned string:', cleaned)
  
//   return cleaned
// }

//===

export function normalizeText(input: string): string {
  if (!input) return "";

  let normalized = input.normalize("NFC");

  // Strip control chars except newline/tab
  normalized = normalized.replace(/[^\P{C}\n\t]/gu, "");

  // Normalize whitespace
  normalized = normalized.replace(/\u00A0/g, " "); // nbsp → space
  normalized = normalized.replace(/\u200B/g, "");  // zero-width space
  normalized = normalized.replace(/\t+/g, " ");    // tabs → single space

  return normalized.trim();
}

// =========================================
// 2. Smart letter-spacing collapse (per line)
// =========================================
function smartDespaceLine(line: string): string {
  if (!line) return line;

  const parts = line.split(/(\s+)/);
  const out: string[] = [];

  const isSingleAllowed = (s: string) =>
    s.length === 1 && /[\p{L}\p{N}'’]/u.test(s);

  const isSingleLowerLetter = (s: string) => s.length === 1 && /\p{Ll}/u.test(s);

  let i = 0;
  while (i < parts.length) {
    const tok = parts[i];

    if (!/\s+/.test(tok) && isSingleAllowed(tok)) {
      const runTokens: string[] = [tok];
      let j = i + 1;

      while (
        j + 1 < parts.length &&
        parts[j] === " " &&
        !/\s+/.test(parts[j + 1]) &&
        isSingleAllowed(parts[j + 1])
      ) {
        runTokens.push(parts[j + 1]);
        j += 2;
      }

      // Join spaced letters like "N A S A" -> "NASA"
      if (runTokens.length >= 3) {
        out.push(runTokens.join(""));
        i = j;
        continue;
      }

      // Join two-letter lowercase sequences like "i s" -> "is"
      if (
        runTokens.length === 2 &&
        isSingleLowerLetter(runTokens[0]) &&
        isSingleLowerLetter(runTokens[1])
      ) {
        out.push(runTokens.join(""));
        i = j;
        continue;
      }
    }

    out.push(tok);
    i += 1;
  }

  return out.join("");
}

// =============================
// 3. High-level text cleaner
// =============================
export function cleanText(input: string): string {
  let s = normalizeText(input);

  // Fix hyphenation across line breaks
  s = s.replace(/(\p{L})-\n(\p{L})/gu, "$1$2");

  // Trim spaces around newlines
  s = s.replace(/[ \t]*\n[ \t]*/g, "\n");

  // Turn intra-paragraph newlines into spaces, preserve paragraph breaks
  // 1) Mark paragraph breaks
  s = s.replace(/\n{2,}/g, "[[PARA]]");
  // 2) Collapse remaining newlines (soft wraps) into spaces
  s = s.replace(/\n+/g, " ");
  // 3) Restore paragraph breaks
  s = s.replace(/\[\[PARA\]\]/g, "\n\n");

  // Apply line-wise despacing
  s = s
    .split("\n")
    .map((line) => smartDespaceLine(line))
    .join("\n");

  // Remove spaces before punctuation
  s = s.replace(/\s+([.,;:!?])/g, "$1");

  // Cap extreme space runs, preserve 2–4 spaces
  s = s.replace(/[ ]{5,}/g, "    ");

  // Trim lines & drop empties
  s = s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");

  return s.trim();
}

//===


/**
 * Validate text item
 */
function validateTextItem(item: any): boolean {
  return (
    item &&
    typeof item === "object" &&
    "str" in item &&
    typeof item.str === "string" &&
    item.str.length > 0
  )
}

/**
 * Extract text from various PDF.js text operators with enhanced validation
 */
function extractTextFromArgs(args: any[]): string {
  let text = ""

  if (!args || args.length === 0) {
    return text
  }

  const firstArg = args[0]

  if (typeof firstArg === "string") {
    text = firstArg
  } else if (Array.isArray(firstArg)) {
    for (const item of firstArg) {
      if (typeof item === "string") {
        text += item
      } else if (typeof item === "number") {
        // Skip spacing numbers in text arrays
        continue
      } else if (item && typeof item === "object") {
        // Enhanced validation using validateTextItem function
        if (validateTextItem(item)) {
          text += item.str
        } else if ("unicode" in item && typeof item.unicode === "string") {
          text += item.unicode
        }
      }
    }
  }

  // Additional validation: ensure we return clean, valid text
  const result = typeof text === "string" ? text : ""
  console.log('EXTRACT TEXT DEBUG: Final extracted text:', result)
  return result
}

/**
 * Process collected paragraphs into chunks and add to results
 * Returns the overlap text to maintain continuity across images
 */
function processTextParagraphs(
  paragraphs: string[],
  text_chunks: string[],
  text_chunk_pos: number[],
  globalSeq: { value: number },
  overlapBytes: number = 32,
): string {
  console.log('TEXT DEBUG: Processing paragraphs count:', paragraphs.length)
  
  if (paragraphs.length === 0) {
    console.log('TEXT DEBUG: No paragraphs to process')
    return ""
  }

  const cleanedParagraphs = paragraphs
    .map(cleanText)
    .filter((p) => p.length > 0)
  if (cleanedParagraphs.length === 0) {
    console.log('TEXT DEBUG: No cleaned paragraphs after filtering')
    return ""
  }

  const cleanedText = cleanedParagraphs.join("\n")
  console.log('TEXT DEBUG: Cleaned text length:', cleanedText.length)
  console.log('TEXT DEBUG: Full cleaned text:', cleanedText)
  
  const chunks = chunkTextByParagraph(cleanedText, 512, 128)
  console.log('TEXT DEBUG: Generated chunks count:', chunks.length)

  for (const chunk of chunks) {
    text_chunks.push(chunk)
    text_chunk_pos.push(globalSeq.value)
    console.log('TEXT DEBUG: Added chunk at position', globalSeq.value, 'content:', chunk)
    globalSeq.value++
  }

  // Return overlap text for continuity across images
  // Take the last overlapBytes from the processed text
  let overlapText = ""
  let overlapLen = 0
  
  Logger.info(`OVERLAP DEBUG: Calculating overlap text from cleanedText of length ${cleanedText.length}, target bytes: ${overlapBytes}`)
  console.log('OVERLAP DEBUG: Full cleanedText for overlap calculation:', cleanedText)
  
  for (let i = cleanedText.length - 1; i >= 0; i--) {
    const charBytes = Buffer.byteLength(cleanedText[i], "utf8")
    if (overlapLen + charBytes > overlapBytes) {
      console.log('OVERLAP DEBUG: Stopping overlap calculation at char', i, 'would exceed', overlapBytes, 'bytes (current:', overlapLen, 'char bytes:', charBytes, ')')
      break
    }
    overlapText = cleanedText[i] + overlapText
    overlapLen += charBytes
    // console.log('OVERLAP DEBUG: Added char', cleanedText[i], 'to overlap. Current overlap length:', overlapLen, 'bytes, text:', overlapText)
  }

  console.log('OVERLAP DEBUG: Final calculated overlap text:', overlapText)
  console.log('OVERLAP DEBUG: Final overlap length:', overlapLen, 'bytes')
  Logger.info(`OVERLAP DEBUG: processTextParagraphs returning overlap text: "${overlapText}" (${overlapLen} bytes)`)
  
  return overlapText
}

export async function extractTextAndImagesWithChunksFromPDF(
  data: Uint8Array,
  docid: string = crypto.randomUUID(),
  extractImages: boolean = false,
  describeImages: boolean = true,
): Promise<{
  text_chunks: string[]
  image_chunks: string[]
  text_chunk_pos: number[]
  image_chunk_pos: number[]
}> {
  Logger.info(`Starting PDF processing for: ${docid}`)
  console.log('PDF DEBUG: Starting processing with parameters:', {
    docid,
    extractImages,
    describeImages,
    dataSize: data.length
  })

  const loadingTask = PDFJS.getDocument({
    data,
    wasmUrl: openjpegWasmPath,
    iccUrl: qcmsWasmPath,
    verbosity: PDFJS.VerbosityLevel.ERRORS, // Only show errors, suppress warnings
  })
  let pdfDocument: pdfjsLib.PDFDocumentProxy
  try {
    pdfDocument = await loadingTask.promise
  } catch (error) {
    const { name, message } = error as Error
    if (
      message.includes("PasswordException") ||
      name.includes("PasswordException")
    ) {
      Logger.warn("Password protected PDF, skipping")
    } else {
      Logger.error(error, `PDF load error: ${error}`)
    }
    return {
      text_chunks: [],
      image_chunks: [],
      text_chunk_pos: [],
      image_chunk_pos: [],
    }
  }

  try {
    let text_chunks: string[] = []
    let image_chunks: string[] = []
    let text_chunk_pos: number[] = []
    let image_chunk_pos: number[] = []

    // Use object to pass by reference for sequence counter
    let globalSeq = { value: 0 }
    let crossImageOverlap = "" // Track overlap across images

    Logger.info("OVERLAP DEBUG: Initialized crossImageOverlap as empty string")
    console.log('OVERLAP DEBUG: Starting PDF processing with initial crossImageOverlap:', crossImageOverlap)

    Logger.info(`PDF has ${pdfDocument.numPages} pages`)

    // Robust text extraction using PDF.js textContent API
    const buildParagraphsFromPage = async (
      page: pdfjsLib.PDFPageProxy,
    ): Promise<string[]> => {
      const textContent = await page.getTextContent({
        normalizeWhitespace: true,
        disableCombineTextItems: false,
      })

      // Build lines using hasEOL and Y-position changes (handles PPT/DOC exports)
      const lines: string[] = []
      let current = ""
      let prevY: number | null = null
      let prevH: number | null = null
      for (const item of textContent.items as any[]) {
        const str: string = (item && typeof item.str === 'string') ? item.str : ''
        if (!str) continue

        const tr = Array.isArray(item.transform) ? item.transform : []
        const y = typeof tr[5] === 'number' ? tr[5] : null
        const h = typeof item.height === 'number' ? item.height : null

        let newLine = false
        if (prevY != null && y != null) {
          const tol = Math.max(prevH || 0, h || 0, 10) * 0.4 // dynamic tolerance
          if (Math.abs(y - prevY) > tol) newLine = true
        }

        if (newLine || (item as any).hasEOL) {
          if (current.length > 0) lines.push(current)
          current = str
        } else {
          current += str
        }

        prevY = y
        prevH = h
      }
      if (current.trim().length > 0) lines.push(current)

      // Group lines into paragraphs separated by blank lines
      const paragraphs: string[] = []
      let buf: string[] = []
      const pushPara = () => {
        if (buf.length === 0) return
        paragraphs.push(buf.join("\n"))
        buf = []
      }
      for (const ln of lines) {
        if (ln.trim().length === 0) pushPara()
        else buf.push(ln)
      }
      pushPara()

      // Clean and filter
      return paragraphs.map(cleanText).filter((p) => p.length > 0)
    }

    for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
      Logger.debug(`Processing page ${pageNum}`)

      const page = await pdfDocument.getPage(pageNum)
      try {
        const opList = await page.getOperatorList()

        // Use textContent-based paragraphs for this page
        let paragraphs: string[] = await buildParagraphsFromPage(page)
        let currentParagraph = "" // kept for image-flow flush, but not used for text
        let textOperatorCount = (await page.getTextContent()).items.length

        // Helper: try to resolve image object by name; render page once if needed
        let pageRenderedForImages = false
        const resolveImageByName = async (name: string): Promise<any | null> => {
          try {
            // Some builds expose has method
            // @ts-ignore
            if (typeof (page.objs as any).has === 'function' && (page.objs as any).has(name)) {
              // @ts-ignore
              return (page.objs as any).get(name)
            }
            const obj = (page.objs as any).get(name)
            if (obj) return obj
          } catch {}

          // Force a low-scale render to populate image cache once
          if (!pageRenderedForImages) {
            try {
              const viewport = page.getViewport({ scale: 0.5 })
              const canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)))
              const ctx = canvas.getContext('2d')
              // Render without annotations to reduce work
              await page.render({ canvasContext: ctx as any, viewport }).promise
              pageRenderedForImages = true
            } catch (e) {
              Logger.debug(`Image cache render failed on page ${pageNum}: ${e instanceof Error ? e.message : e}`)
            }
          }

          try {
            // Try again after render
            // @ts-ignore
            return (page.objs as any).get(name) || null
          } catch (e) {
            return null
          }
        }

        // Track CTM to compute image bounds when image data is not directly retrievable
        let currentCTM: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0]
        const ctmStack: [number, number, number, number, number, number][] = []

        const mul = (m1: number[], m2: number[]): [number, number, number, number, number, number] => {
          const [a1, b1, c1, d1, e1, f1] = m1 as [number, number, number, number, number, number]
          const [a2, b2, c2, d2, e2, f2] = m2 as [number, number, number, number, number, number]
          return [
            a1 * a2 + c1 * b2,
            b1 * a2 + d1 * b2,
            a1 * c2 + c1 * d2,
            b1 * c2 + d1 * d2,
            a1 * e2 + c1 * f2 + e1,
            b1 * e2 + d1 * f2 + f1,
          ]
        }

        const applyToPoint = (m: number[], x: number, y: number): { x: number; y: number } => {
          const [a, b, c, d, e, f] = m as [number, number, number, number, number, number]
          return { x: a * x + c * y + e, y: b * x + d * y + f }
        }

        let fullPageCanvas: ReturnType<typeof createCanvas> | null = null
        let fullPageViewport: pdfjsLib.PageViewport | null = null
        const ensureFullPageRender = async () => {
          if (fullPageCanvas) return
          const scaleForCrop = 2
          fullPageViewport = page.getViewport({ scale: scaleForCrop })
          fullPageCanvas = createCanvas(
            Math.max(1, Math.floor(fullPageViewport.width)),
            Math.max(1, Math.floor(fullPageViewport.height)),
          )
          const ctx = fullPageCanvas.getContext('2d')
          await page.render({ canvasContext: ctx as any, viewport: fullPageViewport }).promise
        }

        // Do not inject crossImageOverlap into text paragraphs here
        console.log('OVERLAP DEBUG: Page', pageNum, 'crossImageOverlap at start:', crossImageOverlap)

        // Helper to flush currentParagraph into paragraphs array
        const flushParagraph = () => {
          if (currentParagraph.trim().length > 0) {
            paragraphs.push(currentParagraph.trim())
            currentParagraph = ""
          }
        }

        let imagesOnPage = 0
        for (let i = 0; i < opList.fnArray.length; i++) {
          const fnId = opList.fnArray[i]
          const args = opList.argsArray[i]

          switch (fnId) {
            case PDFJS.OPS.showText:
            case PDFJS.OPS.showSpacedText:
            case PDFJS.OPS.nextLine:
            case PDFJS.OPS.nextLineShowText:
            case PDFJS.OPS.nextLineSetSpacingShowText: {
              // Text handled via getTextContent; ignore operator-driven text
              break
            }
            // Handle matrix and positioning operators that might indicate paragraph breaks
            case PDFJS.OPS.transform:
            case PDFJS.OPS.setTextMatrix:
            case PDFJS.OPS.moveText: {
              // These might indicate significant positioning changes
              // For now, we'll be conservative and not flush, but this could be adjusted
              if (fnId === PDFJS.OPS.transform) {
                try {
                  if (Array.isArray(args) && args.length >= 6 && args.every((n: any) => typeof n === 'number')) {
                    currentCTM = mul(currentCTM, args as number[])
                  }
                } catch {}
              }
              break
            }
            case PDFJS.OPS.save: {
              ctmStack.push([...currentCTM])
              break
            }
            case PDFJS.OPS.restore: {
              if (ctmStack.length) currentCTM = ctmStack.pop()!
              break
            }
            // Handle image operators
            case extractImages ? PDFJS.OPS.paintImageXObject : null:
            case extractImages ? PDFJS.OPS.paintImageXObjectRepeat : null:
            case extractImages ? PDFJS.OPS.paintInlineImageXObject : null:
            case extractImages ? PDFJS.OPS.paintImageMaskXObject : null: {
              console.log('IMAGE DEBUG: Image operator detected on page', pageNum, {
                extractImages,
                operatorType: fnId,
                imageName: args[0]
              })
              
              // Do not process text per-image anymore; text is processed once per page.
              // Maintain crossImageOverlap continuity by keeping placeholders only.
              flushParagraph()

              // Extract image buffer
              const imageName = args[0]
              console.log('IMAGE DEBUG: Processing image:', imageName)
              let imageDict: any | null = null
              let isInline = false
              // Inline image may directly carry data in args
              console.log('IMAGE DEBUG: Initial args for image operator:', args)
              console.log('IMAGE DEBUG: fnId for image operator:', fnId)
              if (fnId === PDFJS.OPS.paintInlineImageXObject) {
                console.log('IMAGE DEBUG: Detected inline image data in args')
                const candidate = Array.isArray(args) ? args.find((a: any) => a && typeof a === 'object' && ('data' in a || 'imgData' in a) && 'width' in a && 'height' in a) : null
                if (candidate) {
                  imageDict = candidate
                  isInline = true
                }
              }
              console.log('IMAGE DEBUG: Initial imageDict resolved from args:', imageDict)
              if (!imageDict && typeof imageName === 'string') {
                imageDict = await resolveImageByName(imageName)
              }

              // Fallback: if we cannot get the raw image object, crop the region from a high-res full-page render
              if (!imageDict) {
                Logger.debug(`No image object available for ${imageName} on page ${pageNum} — attempting crop fallback via CTM`)
                try {
                  await ensureFullPageRender()
                  if (!fullPageCanvas || !fullPageViewport) {
                    Logger.debug(`Crop fallback unavailable: full page render not ready on page ${pageNum}`)
                    continue
                  }

                  // Compute device space matrix = viewport.transform * currentCTM
                  const deviceM = mul((fullPageViewport as any).transform, currentCTM)
                  const p0 = applyToPoint(deviceM, 0, 0)
                  const p1 = applyToPoint(deviceM, 1, 0)
                  const p2 = applyToPoint(deviceM, 0, 1)
                  const p3 = applyToPoint(deviceM, 1, 1)
                  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x, p3.x)))
                  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y, p3.y)))
                  const maxX = Math.min(fullPageCanvas.width, Math.ceil(Math.max(p0.x, p1.x, p2.x, p3.x)))
                  const maxY = Math.min(fullPageCanvas.height, Math.ceil(Math.max(p0.y, p1.y, p2.y, p3.y)))
                  const cropW = Math.max(0, maxX - minX)
                  const cropH = Math.max(0, maxY - minY)

                  console.log('IMAGE DEBUG: Crop fallback box for', imageName, { minX, minY, maxX, maxY, cropW, cropH })

                  if (cropW < MIN_IMAGE_DIM_PX || cropH < MIN_IMAGE_DIM_PX) {
                    Logger.debug(`Crop fallback too small for ${imageName} on page ${pageNum}: ${cropW}x${cropH}`)
                    continue
                  }

                  const cropCanvas = createCanvas(cropW, cropH)
                  const cropCtx = cropCanvas.getContext('2d')
                  cropCtx.drawImage(fullPageCanvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH)

                  // Proceed with standard pipeline using the cropped buffer
                  const buffer = cropCanvas.toBuffer('image/png')
                  // @ts-ignore
                  let type = await imageType(buffer)
                  if (!type) type = { mime: 'image/png', ext: 'png' }
                  if (!DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES.has(type.mime)) {
                    Logger.warn(`Unsupported or unknown image MIME type (crop): ${type?.mime}. Skipping image: ${imageName}`)
                    continue
                  }

                  const imageHash = crypto.createHash('md5').update(new Uint8Array(buffer)).digest('hex')
                  let description: string
                  if (seenHashDescriptions.has(imageHash)) {
                    description = seenHashDescriptions.get(imageHash)!
                  } else {
                    try {
                      description = describeImages ? await describeImageWithllm(buffer) : 'This is an image.'
                    } catch {
                      description = 'Image extracted from PDF page.'
                    }
                    if (
                      !description ||
                      description === 'No description returned.' ||
                      description === 'Image is not worth describing.'
                    ) {
                      description = 'Image extracted from PDF page.'
                    }
                    seenHashDescriptions.set(imageHash, description)
                  }

                  try {
                    const baseDir = path.resolve(process.env.IMAGE_DIR || 'downloads/xyne_images_db')
                    const outputDir = path.join(baseDir, docid)
                    await fsPromises.mkdir(outputDir, { recursive: true })
                    const imageFilename = `${globalSeq.value}.${type.ext || 'png'}`
                    const imagePath = path.join(outputDir, imageFilename)
                    await fsPromises.writeFile(imagePath, buffer as NodeJS.ArrayBufferView)
                    Logger.info(`Saved image (crop) to: ${imagePath}`)
                  } catch (e) {
                    Logger.error(`Failed to save cropped image for ${imageName} on page ${pageNum}: ${e instanceof Error ? e.message : e}`)
                    continue
                  }

                  image_chunks.push(description)
                  image_chunk_pos.push(globalSeq.value)
                  crossImageOverlap += ` [[IMG#${globalSeq.value}]] `
                  globalSeq.value++
                  imagesOnPage += 1
                  Logger.debug(`Successfully processed image ${imageName} on page ${pageNum} via crop fallback`)
                } catch (e) {
                  Logger.warn(`Crop fallback failed for ${imageName} on page ${pageNum}: ${e instanceof Error ? e.message : e}`)
                }
                // Move on to next operator
                break
              }
              console.log('IMAGE DEBUG: Resolved imageDict:', {imageDict, isInline})
              try {
                const width: number = (imageDict.width ?? imageDict.w) as number
                const height: number = (imageDict.height ?? imageDict.h) as number
                const kind = imageDict.kind ?? imageDict.imageKind ?? imageDict.ImageKind
                // data may live in imageDict.data, imageDict.imgData.data, or imageDict.bytes
                let rawData: any = imageDict.data ?? imageDict.bytes ?? (imageDict.imgData ? imageDict.imgData.data : undefined)

                console.log('IMAGE DEBUG: Full image details for', imageName, {
                  width,
                  height,
                  kind,
                  dataLength: rawData ? rawData.length : null,
                  dataSizeMB: rawData ? (rawData.length / (1024 * 1024)).toFixed(2) : null,
                  maxAllowedSizeMB: DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB,
                  minDimension: MIN_IMAGE_DIM_PX,
                  isValidDimensions: width > 0 && height > 0,
                  meetsMinSize: width >= MIN_IMAGE_DIM_PX && height >= MIN_IMAGE_DIM_PX,
                  withinSizeLimit: rawData ? rawData.length <= DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024 : false,
                  isInline
                })

                if (!width || !height || width <= 0 || height <= 0) {
                  console.log('IMAGE DEBUG: SKIPPED - Invalid dimensions for', imageName, 'width:', width, 'height:', height)
                  Logger.debug(
                    `Invalid image dimensions for ${imageName}: ${width}x${height}`,
                  )
                  continue
                }

                if (rawData && rawData.length > DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024) {
                  console.log('IMAGE DEBUG: SKIPPED - Large file size for', imageName, {
                    actualSizeMB: (rawData.length / (1024 * 1024)).toFixed(2),
                    maxAllowedMB: DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB,
                    actualBytes: rawData.length,
                    maxAllowedBytes: DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024
                  })
                  Logger.warn(
                    `Skipping large image (${(rawData.length / (1024 * 1024)).toFixed(2)} MB): ${imageName}`,
                  )
                  continue
                }

                if (width < MIN_IMAGE_DIM_PX || height < MIN_IMAGE_DIM_PX) {
                  console.log('IMAGE DEBUG: SKIPPED - Small dimensions for', imageName, {
                    width,
                    height,
                    minRequired: MIN_IMAGE_DIM_PX,
                    widthTooSmall: width < MIN_IMAGE_DIM_PX,
                    heightTooSmall: height < MIN_IMAGE_DIM_PX
                  })
                  continue // Skip small images
                }

                console.log('IMAGE DEBUG: Image passed all filters, proceeding with processing for', imageName)

                let uint8Data: Uint8Array
                if (rawData instanceof Uint8Array) {
                  uint8Data = rawData
                } else if (
                  rawData &&
                  typeof rawData === "object" &&
                  rawData.length !== undefined
                ) {
                  uint8Data = new Uint8Array(rawData)
                } else {
                  Logger.debug(`Invalid image data format for ${imageName}`)
                  continue
                }

                const canvas = createCanvas(width, height)
                const ctx = canvas.getContext("2d")
                let imageProcessed = false

                switch (kind) {
                  case pdfjsLib.ImageKind.GRAYSCALE_1BPP:
                  case pdfjsLib.ImageKind.RGB_24BPP:
                  case pdfjsLib.ImageKind.RGBA_32BPP: {
                    const bytesPerPixel =
                      kind === pdfjsLib.ImageKind.RGBA_32BPP
                        ? 4
                        : kind === pdfjsLib.ImageKind.RGB_24BPP
                          ? 3
                          : 1
                    const expectedLength = width * height * bytesPerPixel

                    if (uint8Data.length >= expectedLength) {
                      const rgbaData = new Uint8ClampedArray(width * height * 4)
                      for (let i = 0; i < width * height; i++) {
                        const srcIdx = i * bytesPerPixel
                        const dstIdx = i * 4
                        if (kind === pdfjsLib.ImageKind.GRAYSCALE_1BPP) {
                          const gray =
                            srcIdx < uint8Data.length ? uint8Data[srcIdx] : 0
                          rgbaData[dstIdx] = gray // R
                          rgbaData[dstIdx + 1] = gray // G
                          rgbaData[dstIdx + 2] = gray // B
                          rgbaData[dstIdx + 3] = 255 // A
                        } else if (kind === pdfjsLib.ImageKind.RGB_24BPP) {
                          rgbaData[dstIdx] =
                            srcIdx < uint8Data.length ? uint8Data[srcIdx] : 0 // R
                          rgbaData[dstIdx + 1] =
                            srcIdx + 1 < uint8Data.length
                              ? uint8Data[srcIdx + 1]
                              : 0 // G
                          rgbaData[dstIdx + 2] =
                            srcIdx + 2 < uint8Data.length
                              ? uint8Data[srcIdx + 2]
                              : 0 // B
                          rgbaData[dstIdx + 3] = 255 // A
                        } else {
                          // RGBA_32BPP
                          rgbaData[dstIdx] =
                            srcIdx < uint8Data.length ? uint8Data[srcIdx] : 0 // R
                          rgbaData[dstIdx + 1] =
                            srcIdx + 1 < uint8Data.length
                              ? uint8Data[srcIdx + 1]
                              : 0 // G
                          rgbaData[dstIdx + 2] =
                            srcIdx + 2 < uint8Data.length
                              ? uint8Data[srcIdx + 2]
                              : 0 // B
                          rgbaData[dstIdx + 3] =
                            srcIdx + 3 < uint8Data.length
                              ? uint8Data[srcIdx + 3]
                              : 255 // A
                        }
                      }
                      const imageData = new ImageData(rgbaData, width)
                      ctx.putImageData(imageData, 0, 0)
                      imageProcessed = true
                    }
                    break
                  }
                  default: {
                    try {
                      const imgBuffer = Buffer.from(uint8Data.buffer)
                      const img = new CanvasImage()
                      await new Promise<void>((resolve, reject) => {
                        img.onload = () => resolve()
                        img.onerror = (err) => reject(err)
                        img.src = imgBuffer
                      })
                      ctx.drawImage(img, 0, 0)
                      imageProcessed = true
                    } catch (err) {
                      try {
                        const rgbaData = new Uint8ClampedArray(
                          width * height * 4,
                        )
                        const bytesPerPixel = Math.floor(
                          uint8Data.length / (width * height),
                        )

                        if (bytesPerPixel >= 3) {
                          for (let i = 0; i < width * height; i++) {
                            const srcIdx = i * bytesPerPixel
                            const dstIdx = i * 4
                            rgbaData[dstIdx] =
                              srcIdx < uint8Data.length ? uint8Data[srcIdx] : 0 // R
                            rgbaData[dstIdx + 1] =
                              srcIdx + 1 < uint8Data.length
                                ? uint8Data[srcIdx + 1]
                                : 0 // G
                            rgbaData[dstIdx + 2] =
                              srcIdx + 2 < uint8Data.length
                                ? uint8Data[srcIdx + 2]
                                : 0 // B
                            rgbaData[dstIdx + 3] = 255 // A
                          }
                          const imageData = new ImageData(rgbaData, width)
                          ctx.putImageData(imageData, 0, 0)
                          imageProcessed = true
                        }
                      } catch {
                        Logger.debug(
                          `Failed to process image ${imageName} with fallback method`,
                        )
                      }
                    }
                  }
                }

                console.log('IMAGE DEBUG: Image processing result for', imageName, {
                  imageProcessed,
                  canvasWidth: canvas.width,
                  canvasHeight: canvas.height
                })

                if (imageProcessed) {
                  console.log('IMAGE DEBUG: Converting to PNG buffer for', imageName)
                  const buffer = canvas.toBuffer("image/png")
                  console.log('IMAGE DEBUG: PNG buffer created for', imageName, 'size:', buffer.length, 'bytes')
                  
                  // @ts-ignore
                  let type = await imageType(buffer)
                  console.log('IMAGE DEBUG: Image type detection result for', imageName, type)
                  
                  if (!type) {
                    console.log('IMAGE DEBUG: Could not determine MIME type for', imageName, 'using default image/png')
                    Logger.warn(
                      `Could not determine MIME type for ${imageName}. Defaulting to image/png`,
                    )
                    type = { mime: "image/png", ext: "png" }
                  }
                  
                  console.log('IMAGE DEBUG: Checking MIME type support for', imageName, {
                    detectedMime: type.mime,
                    supportedMimes: Array.from(DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES),
                    isSupported: DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES.has(type.mime)
                  })
                  
                  if (
                    !type ||
                    !DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES.has(type.mime)
                  ) {
                    console.log('IMAGE DEBUG: SKIPPED - Unsupported MIME type for', imageName, {
                      detectedMime: type?.mime,
                      supportedMimes: Array.from(DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES)
                    })
                    Logger.warn(
                      `Unsupported or unknown image MIME type: ${type?.mime}. Skipping image: ${imageName}`,
                    )
                    continue
                  }

                  console.log('IMAGE DEBUG: MIME type check passed for', imageName, 'proceeding with hash and description')

                  // buffer already created above
                  const imageHash = crypto
                    .createHash("md5")
                    .update(new Uint8Array(buffer))
                    .digest("hex")

                  let description: string

                  if (seenHashDescriptions.has(imageHash)) {
                    description = seenHashDescriptions.get(imageHash)!
                    console.log('IMAGE DEBUG: Reusing cached description for', imageName, 'description:', description)
                    Logger.warn(
                      `Reusing description for repeated image ${imageName} on page ${pageNum}`,
                    )
                  } else {
                    console.log('IMAGE DEBUG: Generating new description for', imageName, 'describeImages:', describeImages)
                    if (describeImages) {
                      try {
                        console.log('AI DEBUG: Calling describeImageWithllm for image', imageName)
                        description = await describeImageWithllm(buffer)
                        console.log('AI DEBUG: Got description from AI for', imageName, 'description:', description)
                      } catch (e) {
                        Logger.warn(`describeImageWithllm failed for ${imageName}: ${e instanceof Error ? e.message : e}`)
                        description = "This is an image from the PDF."
                        console.log('IMAGE DEBUG: Fallback description used due to AI error')
                      }
                    } else {
                      description = "This is an image."
                      console.log('IMAGE DEBUG: Using default description (describeImages=false)')
                    }
                    if (
                      description === "No description returned." ||
                      description === "Image is not worth describing."
                    ) {
                      console.log('IMAGE DEBUG: Replacing insufficient description for', imageName, 'previous:', description)
                      Logger.warn(
                        `${description} ${imageName} on page ${pageNum}`,
                      )
                      description = 'Image extracted from PDF page.'
                    }
                    seenHashDescriptions.set(imageHash, description)
                    console.log('IMAGE DEBUG: Cached new description for', imageName, 'description:', description)
                  }

                  try {
                    // Save image to Downloads/xyne_images_db with improved error handling
                    const baseDir = path.resolve(
                      process.env.IMAGE_DIR || "downloads/xyne_images_db",
                    )
                    const outputDir = path.join(baseDir, docid)
                    await fsPromises.mkdir(outputDir, { recursive: true })

                    const imageFilename = `${globalSeq.value}.${type.ext || "png"}`
                    const imagePath = path.join(outputDir, imageFilename)

                    await fsPromises.writeFile(
                      imagePath,
                      buffer as NodeJS.ArrayBufferView,
                    )
                    Logger.info(`Saved image to: ${imagePath}`)
                  } catch (saveError) {
                    Logger.error(
                      `Failed to save image for ${imageName} on page ${pageNum}: ${saveError instanceof Error ? saveError.message : saveError}`,
                    )
                    // Skip adding to chunks if save failed
                    continue
                  }

                  image_chunks.push(description)
                  image_chunk_pos.push(globalSeq.value)
                  Logger.info(`OVERLAP DEBUG: Adding image placeholder to crossImageOverlap. Before: "${crossImageOverlap}"`)
                  console.log('OVERLAP DEBUG: crossImageOverlap before adding image placeholder:', crossImageOverlap)
                  crossImageOverlap += ` [[IMG#${globalSeq.value}]] `
                  Logger.info(`OVERLAP DEBUG: Added image placeholder to crossImageOverlap. After: "${crossImageOverlap}"`)
                  console.log('OVERLAP DEBUG: crossImageOverlap after adding image placeholder:', crossImageOverlap)
                  console.log('IMAGE DEBUG: Added image chunk at position', globalSeq.value, {
                    imageName,
                    description,
                    crossImageOverlap
                  })
                  globalSeq.value++
                  imagesOnPage += 1
                  Logger.debug(
                    `Successfully processed image ${imageName} on page ${pageNum}`,
                  )
                }
              } catch (error) {
                Logger.warn(
                  `Failed to process image ${imageName} on page ${pageNum}: ${(error as Error).message}`,
                )
              }
              break
            }
            default:
              // For other operators, do nothing special
              break
          }
        }

        // Fallback: if extractImages enabled but no images found in operators, capture full-page snapshot
        if (extractImages && imagesOnPage === 0) {
          try {
            console.log('IMAGE DEBUG: No XObject images found on page', pageNum, '- capturing full-page snapshot as fallback')
            const viewport = page.getViewport({ scale: 2 })
            const canvasSnap = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)))
            const ctxSnap = canvasSnap.getContext('2d')
            await page.render({ canvasContext: ctxSnap as any, viewport }).promise
            const snapBuffer = canvasSnap.toBuffer('image/png')

            if (snapBuffer.length <= DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024) {
              console.log("snapBuffer")
              let description = 'This is a page snapshot.'
              if (describeImages) {
                try {
                  description = await describeImageWithllm(snapBuffer)
                } catch {}
              }
              if (!description || description === 'Image is not worth describing.' || description === 'No description returned.') {
                description = 'PDF page snapshot.'
              }
                const baseDir = path.resolve(process.env.IMAGE_DIR || 'downloads/xyne_images_db')
                const outputDir = path.join(baseDir, docid)
                await fsPromises.mkdir(outputDir, { recursive: true })
                const imageFilename = `${globalSeq.value}.png`
                const imagePath = path.join(outputDir, imageFilename)
                await fsPromises.writeFile(imagePath, snapBuffer as NodeJS.ArrayBufferView)
                Logger.info(`Saved page snapshot to: ${imagePath}`)
                console.log('IMAGE DEBUG: Page snapshot saved to', imagePath)

                image_chunks.push(description)
                image_chunk_pos.push(globalSeq.value)
                crossImageOverlap += ` [[IMG#${globalSeq.value}]] `
                globalSeq.value++
                imagesOnPage += 1
            }else{
              console.log('IMAGE DEBUG: SKIPPED - Page snapshot too large on page', pageNum, {
                sizeMB: (snapBuffer.length / (1024 * 1024)).toFixed(2),
                maxAllowedMB: DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB
              })
              Logger.warn(`Skipping page snapshot on page ${pageNum} due to size: ${(snapBuffer.length / (1024 * 1024)).toFixed(2)} MB`)  
            }
          } catch (e) {
            Logger.debug(`Page snapshot failed for page ${pageNum}: ${e instanceof Error ? e.message : e}`)
          }
        }

        // End of page: flush remaining paragraph and process paragraphs
        flushParagraph()
        const overlapText = processTextParagraphs(
          paragraphs,
          text_chunks,
          text_chunk_pos,
          globalSeq,
        )

        // Update cross-image overlap - APPEND instead of REPLACE to preserve image placeholders
        Logger.info(`OVERLAP DEBUG: End of page ${pageNum} - processing final overlap update`)
        console.log('OVERLAP DEBUG: Page', pageNum, 'end - overlapText from processTextParagraphs:', overlapText)
        console.log('OVERLAP DEBUG: Page', pageNum, 'end - crossImageOverlap before final update:', crossImageOverlap)
        if (overlapText.trim()) {
          Logger.info(`OVERLAP DEBUG: Page ${pageNum} - overlapText has content, updating crossImageOverlap`)
          const previousCrossImageOverlap = crossImageOverlap
          crossImageOverlap = crossImageOverlap
            ? `${crossImageOverlap} ${overlapText}`
            : overlapText
          Logger.info(`OVERLAP DEBUG: Page ${pageNum} - crossImageOverlap updated from "${previousCrossImageOverlap}" to "${crossImageOverlap}"`)
          console.log('OVERLAP DEBUG: Page', pageNum, 'end - crossImageOverlap after final update:', crossImageOverlap)
        } else {
          Logger.info(`OVERLAP DEBUG: Page ${pageNum} - overlapText is empty, no update to crossImageOverlap`)
          console.log('OVERLAP DEBUG: Page', pageNum, 'end - no update to crossImageOverlap (overlapText empty)')
        }

        Logger.debug(
          `Page ${pageNum} completed. Text operators found: ${textOperatorCount}, Current text chunks: ${text_chunks.length}, Current image chunks: ${image_chunks.length}`,
        )
      } finally {
        // Clean up page resources
        page.cleanup()
      }
    }

    Logger.info(
      `PDF processing completed. Total text chunks: ${text_chunks.length}, Total image chunks: ${image_chunks.length}`,
    )

    console.log('FINAL DEBUG: PDF processing completed for', docid)
    console.log('FINAL DEBUG: Processing summary:', {
      totalTextChunks: text_chunks.length,
      totalImageChunks: image_chunks.length,
      textChunkPositions: text_chunk_pos.length,
      imageChunkPositions: image_chunk_pos.length,
      extractImages,
      describeImages
    })
    
    console.log('FINAL DEBUG: All text chunks:', text_chunks)
    console.log('FINAL DEBUG: All text chunk positions:', text_chunk_pos)
    console.log('FINAL DEBUG: All image chunks:', image_chunks)
    console.log('FINAL DEBUG: All image chunk positions:', image_chunk_pos)
    return {
      text_chunks,
      image_chunks,
      text_chunk_pos,
      image_chunk_pos,
    }
  } finally {
    console.log("Calling destroy")
    await pdfDocument.destroy()
  }
}
