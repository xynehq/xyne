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

export function normalizeText(input: string): string {
  if (!input) return ""

  let normalized = input.normalize("NFC")

  // Strip control chars except newline/tab
  normalized = normalized.replace(/[^\P{C}\n\t]/gu, "")

  // Normalize whitespace
  normalized = normalized.replace(/\u00A0/g, " ") // nbsp → space
  normalized = normalized.replace(/\u200B/g, "") // zero-width space
  normalized = normalized.replace(/\t+/g, " ") // tabs → single space

  return normalized.trim()
}

// 2. Smart letter-spacing collapse (per line)

function smartDespaceLine(line: string): string {
  if (!line) return line

  const parts = line.split(/(\s+)/)
  const out: string[] = []

  const isSingleAllowed = (s: string) =>
    s.length === 1 && /[\p{L}\p{N}'’]/u.test(s)

  const isSingleLowerLetter = (s: string) => s.length === 1 && /\p{Ll}/u.test(s)

  let i = 0
  while (i < parts.length) {
    const tok = parts[i]

    if (!/\s+/.test(tok) && isSingleAllowed(tok)) {
      const runTokens: string[] = [tok]
      let j = i + 1

      while (
        j + 1 < parts.length &&
        parts[j] === " " &&
        !/\s+/.test(parts[j + 1]) &&
        isSingleAllowed(parts[j + 1])
      ) {
        runTokens.push(parts[j + 1])
        j += 2
      }

      // Join spaced letters like "N A S A" -> "NASA"
      if (runTokens.length >= 3) {
        out.push(runTokens.join(""))
        i = j
        continue
      }

      // Join two-letter lowercase sequences like "i s" -> "is"
      if (
        runTokens.length === 2 &&
        isSingleLowerLetter(runTokens[0]) &&
        isSingleLowerLetter(runTokens[1])
      ) {
        out.push(runTokens.join(""))
        i = j
        continue
      }
    }

    out.push(tok)
    i += 1
  }

  return out.join("")
}

// 3. High-level text cleaner

export function cleanText(input: string): string {
  let s = normalizeText(input)

  // Fix hyphenation across line breaks
  s = s.replace(/(\p{L})-\n(\p{L})/gu, "$1$2")

  // Trim spaces around newlines
  s = s.replace(/[ \t]*\n[ \t]*/g, "\n")

  // Turn intra-paragraph newlines into spaces, preserve paragraph breaks
  // 1) Mark paragraph breaks with a unique placeholder
  const uniqueParaPlaceholder = `\uE000XYNE_PARA_BREAK_${Math.random().toString(36).substring(2)}\uE001`
  s = s.replace(/\n{2,}/g, uniqueParaPlaceholder)
  // 2) Collapse remaining newlines (soft wraps) into spaces
  s = s.replace(/\n+/g, " ")
  // 3) Restore paragraph breaks
  s = s.replace(
    new RegExp(
      uniqueParaPlaceholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "g",
    ),
    "\n\n",
  )

  // Apply line-wise despacing
  s = s
    .split("\n")
    .map((line) => smartDespaceLine(line))
    .join("\n")

  // Remove spaces before punctuation
  s = s.replace(/\s+([.,;:!?])/g, "$1")

  // Cap extreme space runs, preserve 2–4 spaces
  s = s.replace(/[ ]{5,}/g, "    ")

  // Trim lines & drop empties
  s = s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n")

  return s.trim()
}

// 4. Matrix transformation utilities

/**
 * Multiply two 2D transformation matrices
 * Each matrix is represented as [a, b, c, d, e, f] corresponding to:
 * [a  c  e]
 * [b  d  f]
 * [0  0  1]
 */
function multiplyMatrices(
  m1: number[],
  m2: number[],
): [number, number, number, number, number, number] {
  const [a1, b1, c1, d1, e1, f1] = m1 as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const [a2, b2, c2, d2, e2, f2] = m2 as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]
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
  Logger.debug("Processing paragraphs", { count: paragraphs.length })

  if (paragraphs.length === 0) {
    Logger.debug("No paragraphs to process")
    return ""
  }

  const cleanedParagraphs = paragraphs
    .map(cleanText)
    .filter((p) => p.length > 0)
  if (cleanedParagraphs.length === 0) {
    Logger.debug("No cleaned paragraphs after filtering")
    return ""
  }

  const cleanedText = cleanedParagraphs.join("\n")
  // console.log('TEXT DEBUG: Cleaned text length:', cleanedText.length)
  // console.log('TEXT DEBUG: Full cleaned text:', cleanedText)

  const chunks = chunkTextByParagraph(cleanedText, 512, 128)
  // console.log('TEXT DEBUG: Generated chunks count:', chunks.length)

  for (const chunk of chunks) {
    text_chunks.push(chunk)
    text_chunk_pos.push(globalSeq.value)
    // console.log('TEXT DEBUG: Added chunk at position', globalSeq.value, 'content:', chunk)
    globalSeq.value++
  }

  // Return overlap text for continuity across images
  // Take the last overlapBytes from the processed text
  let overlapText = ""
  let overlapLen = 0

  // Logger.info(`OVERLAP DEBUG: Calculating overlap text from cleanedText of length ${cleanedText.length}, target bytes: ${overlapBytes}`)
  // console.log('OVERLAP DEBUG: Full cleanedText for overlap calculation:', cleanedText)

  for (let i = cleanedText.length - 1; i >= 0; i--) {
    const charBytes = Buffer.byteLength(cleanedText[i], "utf8")
    if (overlapLen + charBytes > overlapBytes) {
      // console.log('OVERLAP DEBUG: Stopping overlap calculation at char', i, 'would exceed', overlapBytes, 'bytes (current:', overlapLen, 'char bytes:', charBytes, ')')
      break
    }
    overlapText = cleanedText[i] + overlapText
    overlapLen += charBytes
    // console.log('OVERLAP DEBUG: Added char', cleanedText[i], 'to overlap. Current overlap length:', overlapLen, 'bytes, text:', overlapText)
  }

  // console.log('OVERLAP DEBUG: Final calculated overlap text:', overlapText)
  // console.log('OVERLAP DEBUG: Final overlap length:', overlapLen, 'bytes')
  // Logger.info(`OVERLAP DEBUG: processTextParagraphs returning overlap text: "${overlapText}" (${overlapLen} bytes)`)

  return overlapText
}

export async function extractTextAndImagesWithChunksFromPDF(
  data: Uint8Array,
  docid: string = crypto.randomUUID(),
  extractImages: boolean = false,
  describeImages: boolean = true,
  includeImageMarkersInText: boolean = true,
): Promise<{
  text_chunks: string[]
  image_chunks: string[]
  text_chunk_pos: number[]
  image_chunk_pos: number[]
}> {
  Logger.debug("Starting processing with parameters", {
    docid,
    extractImages,
    describeImages,
    includeImageMarkersInText,
    dataSize: data.length,
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
    // Track overlap across pages to maintain continuity
    let pageOverlap = ""

    // Overlap is now tracked page-to-page only

    Logger.info(`PDF has ${pdfDocument.numPages} pages`)

    // Robust text extraction using PDF.js textContent API
    const buildParagraphsFromPage = async (
      page: pdfjsLib.PDFPageProxy,
    ): Promise<string[]> => {
      const textContent = await page.getTextContent({
        includeMarkedContent: false,
        disableNormalization: false,
      })

      // Build lines using hasEOL and Y-position changes (handles PPT/DOC exports)
      const lines: string[] = []
      let current = ""
      let prevY: number | null = null
      let prevH: number | null = null
      for (const item of textContent.items as any[]) {
        const str: string = item && typeof item.str === "string" ? item.str : ""
        if (!str) continue

        const tr = Array.isArray(item.transform) ? item.transform : []
        const y = typeof tr[5] === "number" ? tr[5] : null
        const h = typeof item.height === "number" ? item.height : null

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

      // Filter raw paragraphs - check trimmed length but don't apply full cleaning yet
      return paragraphs.filter((p) => p.trim().length > 0)
    }



    for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
      Logger.debug(`Processing page ${pageNum}`)

      const page = await pdfDocument.getPage(pageNum)
      try {
        const opList = await page.getOperatorList()

        // Use textContent-based paragraphs for this page as primary source
        let paragraphs: string[] = await buildParagraphsFromPage(page)

        

        let textOperatorCount = (await page.getTextContent()).items.length

        // Prepend previous page overlap to the first paragraph for continuity
        if (pageOverlap && paragraphs.length > 0) {
          paragraphs[0] = `${pageOverlap} ${paragraphs[0]}`
          pageOverlap = ""
        } else if (pageOverlap) {
          paragraphs = [pageOverlap]
          pageOverlap = ""
        }

        Logger.debug("Text extraction summary for page", {
          pageNum,
          primaryParagraphs: paragraphs.length,
         
          finalParagraphs: paragraphs.length,
          textOperatorCount,
          initialPageOverlap: pageOverlap,
        })

        // Helper: try to resolve image object by name directly from page.objs
        const resolveImageByName = async (
          name: string,
        ): Promise<any | null> => {
          try {
            // Some builds expose has method
            // @ts-ignore
            if (
              typeof (page.objs as any).has === "function" &&
              (page.objs as any).has(name)
            ) {
              // @ts-ignore
              return (page.objs as any).get(name)
            }
            const obj = (page.objs as any).get(name)
            return obj || null
          } catch (e) {
            return null
          }
        }

        // Track CTM to compute image bounds when image data is not directly retrievable
        let currentCTM: [number, number, number, number, number, number] = [
          1, 0, 0, 1, 0, 0,
        ]
        const ctmStack: [number, number, number, number, number, number][] = []

        let imagesOnPage = 0
        let vectorOpsDetected = false
        for (let i = 0; i < opList.fnArray.length; i++) {
          const fnId = opList.fnArray[i]
          const args = opList.argsArray[i]

          // Track vector drawing operators (paths, fills, form XObjects)
          const isVectorOp =
            fnId === PDFJS.OPS.constructPath ||
            fnId === PDFJS.OPS.stroke ||
            fnId === PDFJS.OPS.closeStroke ||
            fnId === PDFJS.OPS.fill ||
            fnId === PDFJS.OPS.eoFill ||
            fnId === PDFJS.OPS.fillStroke ||
            fnId === PDFJS.OPS.eoFillStroke ||
            fnId === PDFJS.OPS.closeFillStroke ||
            fnId === PDFJS.OPS.closeEOFillStroke ||
            fnId === PDFJS.OPS.clip ||
            fnId === PDFJS.OPS.eoClip ||
            fnId === PDFJS.OPS.rectangle ||
            fnId === PDFJS.OPS.shadingFill ||
            fnId === PDFJS.OPS.rawFillPath ||
            fnId === PDFJS.OPS.paintFormXObjectBegin ||
            fnId === PDFJS.OPS.paintFormXObjectEnd
          if (isVectorOp) vectorOpsDetected = true

          switch (fnId) {
            case PDFJS.OPS.showText:
            case PDFJS.OPS.showSpacedText:
            case PDFJS.OPS.nextLine:
            case PDFJS.OPS.nextLineShowText:
            case PDFJS.OPS.nextLineSetSpacingShowText: {
              // Text is now handled by combined extraction approach
              // Operator-level extraction happens in extractFallbackTextFromOperators
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
                  if (
                    Array.isArray(args) &&
                    args.length >= 6 &&
                    args.every((n: any) => typeof n === "number")
                  ) {
                    currentCTM = multiplyMatrices(currentCTM, args as number[])
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
              Logger.debug("Image operator detected", {
                pageNum,
                extractImages,
                operatorType: fnId,
                imageName: args[0],
              })

              // Extract image buffer
              const imageName =
                typeof args?.[0] === "string"
                  ? args[0]
                  : args?.[0] &&
                      typeof args[0] === "object" &&
                      typeof args[0].name === "string"
                    ? args[0].name
                    : args?.[0]
              Logger.debug("Processing image", { imageName })
              let imageDict: any | null = null
              let isInline = false
              // Inline image may directly carry data in args
              Logger.debug("Image operator details", {
                args: args.length,
                fnId,
                paintInlineImageXObject: PDFJS.OPS.paintInlineImageXObject,
              })
              if (fnId === PDFJS.OPS.paintInlineImageXObject) {
                Logger.debug("Detected inline image data in args")
                const candidate = Array.isArray(args)
                  ? args.find(
                      (a: any) =>
                        a &&
                        typeof a === "object" &&
                        ("data" in a || "imgData" in a) &&
                        "width" in a &&
                        "height" in a,
                    )
                  : null
                if (candidate) {
                  imageDict = candidate
                  isInline = true
                }
              }
              Logger.debug("Initial imageDict resolved", {
                hasImageDict: !!imageDict,
                isInline,
              })
              if (
                !imageDict &&
                (typeof imageName === "string" ||
                  (imageName &&
                    typeof imageName === "object" &&
                    typeof imageName.name === "string"))
              ) {
                const name =
                  typeof imageName === "string" ? imageName : imageName.name
                imageDict = await resolveImageByName(name)
              }

              // If we cannot get the raw image object, skip this image
              if (!imageDict) {
                Logger.debug(
                  `No image object available for ${imageName} on page ${pageNum} — skipping`,
                )
                continue
              }
              Logger.debug("Resolved imageDict", {
                hasImageDict: !!imageDict,
                isInline,
              })

              // Ensure imageDict is valid before processing
              if (!imageDict || typeof imageDict !== "object") {
                Logger.debug(
                  "imageDict is null or invalid, skipping to crop fallback",
                )
                // This will fall through to the crop fallback logic below
              } else {
                try {
                  const width: number = (imageDict.width ??
                    imageDict.w) as number
                  const height: number = (imageDict.height ??
                    imageDict.h) as number
                  const kind =
                    imageDict.kind ?? imageDict.imageKind ?? imageDict.ImageKind
                  // data may live in imageDict.data, imageDict.imgData.data, or imageDict.bytes
                  let rawData: any =
                    imageDict.data ??
                    imageDict.bytes ??
                    (imageDict.imgData ? imageDict.imgData.data : undefined)

                  Logger.debug("Full image details", {
                    imageName,
                    width,
                    height,
                    kind,
                    dataLength: rawData ? rawData.length : null,
                    dataSizeMB: rawData
                      ? (rawData.length / (1024 * 1024)).toFixed(2)
                      : null,
                    maxAllowedSizeMB: DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB,
                    minDimension: MIN_IMAGE_DIM_PX,
                    isValidDimensions: width > 0 && height > 0,
                    meetsMinSize:
                      width >= MIN_IMAGE_DIM_PX && height >= MIN_IMAGE_DIM_PX,
                    withinSizeLimit: rawData
                      ? rawData.length <=
                        DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024
                      : false,
                    isInline,
                  })

                  if (!width || !height || width <= 0 || height <= 0) {
                    Logger.debug("Skipped image with invalid dimensions", {
                      imageName,
                      width,
                      height,
                    })
                    continue
                  }

                  if (
                    rawData &&
                    rawData.length >
                      DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024
                  ) {
                    Logger.warn("Skipped large image", {
                      imageName,
                      actualSizeMB: (rawData.length / (1024 * 1024)).toFixed(2),
                      maxAllowedMB: DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB,
                    })
                    continue
                  }

                  if (width < MIN_IMAGE_DIM_PX || height < MIN_IMAGE_DIM_PX) {
                    Logger.debug("Skipped small image", {
                      imageName,
                      width,
                      height,
                      minRequired: MIN_IMAGE_DIM_PX,
                    })
                    continue // Skip small images
                  }

                  Logger.debug(
                    "Image passed all filters, proceeding with processing",
                    {
                      imageName,
                    },
                  )
                  // Fast paths for Canvas or Image-like objects returned by page.objs
                  const isCanvasLike = (obj: any) =>
                    obj &&
                    typeof obj.getContext === "function" &&
                    typeof obj.width === "number" &&
                    typeof obj.height === "number"
                  const isImageLike = (obj: any) =>
                    obj &&
                    typeof obj.width === "number" &&
                    typeof obj.height === "number" &&
                    typeof obj.getContext !== "function"

                  if (isCanvasLike(imageDict)) {
                    const c: any = imageDict
                    const width: number = c.width
                    const height: number = c.height
                    if (width < MIN_IMAGE_DIM_PX || height < MIN_IMAGE_DIM_PX) {
                      Logger.debug("Skipped small canvas image", {
                        imageName,
                        width,
                        height,
                        minRequired: MIN_IMAGE_DIM_PX,
                      })
                    } else {
                      const buffer = c.toBuffer("image/png")
                      // Run all filters BEFORE attempting LLM description
                      if (
                        buffer.length >
                        DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024
                      ) {
                        Logger.warn(
                          `Skipping objs/canvas image due to size ${(buffer.length / (1024 * 1024)).toFixed(2)} MB: ${imageName}`,
                        )
                      } else {
                        // @ts-ignore
                        let type = await imageType(buffer)
                        if (!type) type = { mime: "image/png", ext: "png" }
                        if (
                          DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES.has(type.mime)
                        ) {
                          const imageHash = crypto
                            .createHash("md5")
                            .update(new Uint8Array(buffer))
                            .digest("hex")
                          let description = "This is an image."
                          if (seenHashDescriptions.has(imageHash)) {
                            description = seenHashDescriptions.get(imageHash)!
                          } else {
                            try {
                              description = describeImages
                                ? await describeImageWithllm(buffer)
                                : description
                            } catch {
                              // ignore
                            }
                            // Check description quality after LLM call
                            if (
                              !description ||
                              description === "No description returned." ||
                              description === "Image is not worth describing."
                            ) {
                              Logger.warn(
                                `Skipping image with poor description: ${imageName} on page ${pageNum}`,
                              )
                              break
                            }
                            seenHashDescriptions.set(imageHash, description)
                          }
                          try {
                            const baseDir = path.resolve(
                              process.env.IMAGE_DIR ||
                                "downloads/xyne_images_db",
                            )
                            const outputDir = path.join(baseDir, docid)
                            await fsPromises.mkdir(outputDir, {
                              recursive: true,
                            })
                            const imageFilename = `${globalSeq.value}.${type.ext || "png"}`
                            const imagePath = path.join(
                              outputDir,
                              imageFilename,
                            )
                            await fsPromises.writeFile(
                              imagePath,
                              buffer as NodeJS.ArrayBufferView,
                            )
                            Logger.info(
                              `Saved image (objs/canvas) to: ${imagePath}`,
                            )
                          } catch (e) {
                            Logger.error(
                              `Failed to save objs/canvas image for ${imageName} on page ${pageNum}: ${e instanceof Error ? e.message : e}`,
                            )
                            // Skip on failure
                            break
                          }
                          image_chunks.push(description)
                          image_chunk_pos.push(globalSeq.value)
                          if (includeImageMarkersInText) {
                            text_chunks.push(`[[IMG#${globalSeq.value}]]`)
                            text_chunk_pos.push(globalSeq.value)
                          }
                          globalSeq.value++
                          imagesOnPage += 1
                          Logger.debug(
                            `Successfully processed objs/canvas image ${imageName} on page ${pageNum}`,
                          )
                          break
                        }
                      }
                    }
                  }

                  if (isImageLike(imageDict)) {
                    const imgLike: any = imageDict
                    const width: number = imgLike.width
                    const height: number = imgLike.height
                    if (width < MIN_IMAGE_DIM_PX || height < MIN_IMAGE_DIM_PX) {
                      Logger.debug("Skipped small image-like object", {
                        imageName,
                        width,
                        height,
                        minRequired: MIN_IMAGE_DIM_PX,
                      })
                    } else {
                      const cnv = createCanvas(width, height)
                      const cctx = cnv.getContext("2d")
                      
                      try {
                        
                        // @ts-ignore draw directly
                        cctx.drawImage(imgLike, 0, 0)
                        const buffer = cnv.toBuffer("image/png")
                        // Run all filters BEFORE attempting LLM description
                        if (
                          buffer.length >
                          DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024
                        ) {
                          Logger.warn(
                            `Skipping objs/image image due to size ${(buffer.length / (1024 * 1024)).toFixed(2)} MB: ${imageName}`,
                          )
                          break
                        }
                        // @ts-ignore
                        let type = await imageType(buffer)
                        if (!type) type = { mime: "image/png", ext: "png" }
                        if (
                          DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES.has(type.mime)
                        ) {
                          const imageHash = crypto
                            .createHash("md5")
                            .update(new Uint8Array(buffer))
                            .digest("hex")
                          let description = "This is an image."
                          if (seenHashDescriptions.has(imageHash)) {
                            description = seenHashDescriptions.get(imageHash)!
                          } else {
                            try {
                              description = describeImages
                                ? await describeImageWithllm(buffer)
                                : description
                            } catch {
                              // ignore
                            }
                            // Check description quality after LLM call
                            if (
                              !description ||
                              description === "No description returned." ||
                              description === "Image is not worth describing."
                            ) {
                              Logger.warn(
                                `Skipping image with poor description: ${imageName} on page ${pageNum}`,
                              )
                              break
                            }
                            seenHashDescriptions.set(imageHash, description)
                          }
                          try {
                            const baseDir = path.resolve(
                              process.env.IMAGE_DIR ||
                                "downloads/xyne_images_db",
                            )
                            const outputDir = path.join(baseDir, docid)
                            await fsPromises.mkdir(outputDir, {
                              recursive: true,
                            })
                            const imageFilename = `${globalSeq.value}.${type.ext || "png"}`
                            const imagePath = path.join(
                              outputDir,
                              imageFilename,
                            )
                            await fsPromises.writeFile(
                              imagePath,
                              buffer as NodeJS.ArrayBufferView,
                            )
                            Logger.info(
                              `Saved image (objs/image) to: ${imagePath}`,
                            )
                          } catch (e) {
                            Logger.error(
                              `Failed to save objs/image image for ${imageName} on page ${pageNum}: ${e instanceof Error ? e.message : e}`,
                            )
                            break
                          }
                          image_chunks.push(description)
                          image_chunk_pos.push(globalSeq.value)
                          if (includeImageMarkersInText) {
                            text_chunks.push(`[[IMG#${globalSeq.value}]]`)
                            text_chunk_pos.push(globalSeq.value)
                          }
                          globalSeq.value++
                          imagesOnPage += 1
                          Logger.debug(
                            `Successfully processed objs/image image ${imageName} on page ${pageNum}`,
                          )
                          break
                        }
                      } catch (e) {
                        Logger.debug(
                          `Drawing objs image failed for ${imageName} on page ${pageNum}: ${e instanceof Error ? e.message : e}`,
                        )
                      }
                    }
                  }

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
                      let expectedLength: number
                      if (kind === pdfjsLib.ImageKind.GRAYSCALE_1BPP) {
                        // 1 bit per pixel, packed into bytes
                        expectedLength = Math.ceil((width * height) / 8)
                      } else {
                        const bytesPerPixel =
                          kind === pdfjsLib.ImageKind.RGBA_32BPP ? 4 : 3 // RGB_24BPP
                        expectedLength = width * height * bytesPerPixel
                      }

                      if (uint8Data.length >= expectedLength) {
                        const rgbaData = new Uint8ClampedArray(
                          width * height * 4,
                        )

                        if (kind === pdfjsLib.ImageKind.GRAYSCALE_1BPP) {
                          // Handle 1 bit per pixel grayscale (bit-packed data)
                          let pixelIndex = 0
                          for (let y = 0; y < height; y++) {
                            for (let x = 0; x < width; x++) {
                              const byteIndex = Math.floor(pixelIndex / 8)
                              const bitIndex = 7 - (pixelIndex % 8) // MSB first
                              const bit =
                                byteIndex < uint8Data.length
                                  ? (uint8Data[byteIndex] >> bitIndex) & 1
                                  : 0
                              const gray = bit ? 255 : 0 // Convert bit to full pixel value

                              const dstIdx = pixelIndex * 4
                              rgbaData[dstIdx] = gray // R
                              rgbaData[dstIdx + 1] = gray // G
                              rgbaData[dstIdx + 2] = gray // B
                              rgbaData[dstIdx + 3] = 255 // A
                              pixelIndex++
                            }
                          }
                        } else {
                          // Handle RGB_24BPP and RGBA_32BPP (byte-per-channel data)
                          const bytesPerPixel =
                            kind === pdfjsLib.ImageKind.RGBA_32BPP ? 4 : 3
                          for (let i = 0; i < width * height; i++) {
                            const srcIdx = i * bytesPerPixel
                            const dstIdx = i * 4
                            if (kind === pdfjsLib.ImageKind.RGB_24BPP) {
                              rgbaData[dstIdx] =
                                srcIdx < uint8Data.length
                                  ? uint8Data[srcIdx]
                                  : 0 // R
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
                                srcIdx < uint8Data.length
                                  ? uint8Data[srcIdx]
                                  : 0 // R
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
                        }
                        const imageData = new ImageData(rgbaData, width, height)
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
                                srcIdx < uint8Data.length
                                  ? uint8Data[srcIdx]
                                  : 0 // R
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
                            const imageData = new ImageData(
                              rgbaData,
                              width,
                              height,
                            )
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

                  Logger.debug("Image processing result", {
                    imageName,
                    imageProcessed,
                    canvasWidth: canvas.width,
                    canvasHeight: canvas.height,
                  })

                  if (imageProcessed) {
                    Logger.debug("Converting to PNG buffer", { imageName })
                    const buffer = canvas.toBuffer("image/png")
                    if (
                      buffer.length >
                      DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024
                    ) {
                      Logger.warn(
                        `Skipping encoded image > ${DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB} MB (size ${(buffer.length / (1024 * 1024)).toFixed(2)} MB)`,
                      )
                      continue
                    }
                    Logger.debug("PNG buffer created", {
                      imageName,
                      size: buffer.length,
                    })

                    // @ts-ignore
                    let type = await imageType(buffer)
                    Logger.debug("Image type detection result", {
                      imageName,
                      type,
                    })

                    if (!type) {
                      Logger.debug(
                        "Could not determine MIME type, using default",
                        {
                          imageName,
                          default: "image/png",
                        },
                      )
                      Logger.warn(
                        `Could not determine MIME type for ${imageName}. Defaulting to image/png`,
                      )
                      type = { mime: "image/png", ext: "png" }
                    }

                    Logger.debug("Checking MIME type support", {
                      imageName,
                      detectedMime: type.mime,
                      supportedMimes: Array.from(
                        DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES,
                      ),
                      isSupported: DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES.has(
                        type.mime,
                      ),
                    })

                    if (
                      !type ||
                      !DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES.has(type.mime)
                    ) {
                      Logger.debug("Skipped image with unsupported MIME type", {
                        imageName,
                        detectedMime: type?.mime,
                        supportedMimes: Array.from(
                          DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES,
                        ),
                      })
                      Logger.warn(
                        `Unsupported or unknown image MIME type: ${type?.mime}. Skipping image: ${imageName}`,
                      )
                      continue
                    }

                    Logger.debug(
                      "All filters passed, proceeding with image description",
                      {
                        imageName,
                      },
                    )

                    // buffer already created above
                    const imageHash = crypto
                      .createHash("md5")
                      .update(new Uint8Array(buffer))
                      .digest("hex")

                    let description: string

                    if (seenHashDescriptions.has(imageHash)) {
                      description = seenHashDescriptions.get(imageHash)!
                      Logger.debug("Reusing cached description for image", {
                        imageName,
                        description,
                      })
                      Logger.warn(
                        `Reusing description for repeated image ${imageName} on page ${pageNum}`,
                      )
                    } else {
                      Logger.debug("Generating new description for image", {
                        imageName,
                        describeImages,
                      })
                      if (describeImages) {
                        try {
                          Logger.debug(
                            "Calling describeImageWithllm for image",
                            {
                              imageName,
                            },
                          )
                          description = await describeImageWithllm(buffer)
                          Logger.debug("Got description from AI for image", {
                            imageName,
                            description,
                          })
                        } catch (e) {
                          Logger.warn(
                            `describeImageWithllm failed for ${imageName}: ${e instanceof Error ? e.message : e}`,
                          )
                          description = "This is an image from the PDF."
                          Logger.debug(
                            "Using fallback description due to AI error",
                          )
                        }
                      } else {
                        description = "This is an image."
                        Logger.debug(
                          "Using default description (describeImages=false)",
                        )
                      }
                      
                      // Check description quality after LLM call
                      if (
                        !description ||
                        description === "No description returned." ||
                        description === "Image is not worth describing."
                      ) {
                        Logger.debug(
                          "Skipping image with insufficient description",
                          {
                            imageName,
                            previousDescription: description,
                          },
                        )
                        Logger.warn(
                          `Skipping image with poor description: ${imageName} on page ${pageNum}`,
                        )
                        continue
                      }
                      seenHashDescriptions.set(imageHash, description)
                      Logger.debug("Cached new description for image", {
                        imageName,
                        description,
                      })
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
                    if (includeImageMarkersInText) {
                      text_chunks.push(`[[IMG#${globalSeq.value}]]`)
                      text_chunk_pos.push(globalSeq.value)
                    }
                    // Removed cross-image overlap placeholder handling
                    Logger.debug("Added image chunk at position", {
                      position: globalSeq.value,
                      imageName,
                      description,
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
              }
              break
            }
            default:
              // For other operators, do nothing special
              break
          }
        }
        // End of page: process paragraphs
        const overlapText = processTextParagraphs(
          paragraphs,
          text_chunks,
          text_chunk_pos,
          globalSeq,
        )

        // Store overlap for continuity to the next page
        pageOverlap = overlapText.trim()

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

    Logger.debug("PDF processing completed for document", { docid })
    Logger.debug("Processing summary", {
      totalTextChunks: text_chunks.length,
      totalImageChunks: image_chunks.length,
      textChunkPositions: text_chunk_pos.length,
      imageChunkPositions: image_chunk_pos.length,
      extractImages,
      describeImages,
    })

    Logger.debug("All text chunks", { text_chunks })
    Logger.debug("All text chunks", { text_chunks })
    Logger.debug("All text chunk positions", { text_chunk_pos })
    Logger.debug("All image chunks", { image_chunks })
    Logger.debug("All image chunk positions", { image_chunk_pos })
    return {
      text_chunks,
      image_chunks,
      text_chunk_pos,
      image_chunk_pos,
    }
  } finally {
    Logger.debug("Calling PDF document destroy")
    await pdfDocument.destroy()
  }
}
