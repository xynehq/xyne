import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { createCanvas, Image as CanvasImage, ImageData } from "canvas"
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs"
import path from "path"
import imageType from "image-type"
import { promises as fsPromises } from "fs"
import crypto from "crypto"
import {
  describeImageWithllm,
  withTempDirectory,
} from "./lib/describeImageWithllm"
import { DATASOURCE_CONFIG } from "./integrations/dataSource/config"

const openjpegWasmPath =
  path.join(__dirname, "../node_modules/pdfjs-dist/wasm/") + "/"
const qcmsWasmPath =
  path.join(__dirname, "../node_modules/pdfjs-dist/wasm/") + "/"
const seenHashDescriptions = new Map<string, string>()

const Logger = getLogger(Subsystem.Integrations).child({
  module: "pdfChunks",
})

const PDFJS = pdfjsLib

// Utility function to clean text consistent with chunkTextByParagraph
const cleanText = (str: string): string => {
  const normalized = str.replace(/\r\n|\r/g, "\n")
  return normalized.replace(
    /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\uFDD0-\uFDEF\uFFFE\uFFFF]/g,
    "",
  )
}

/**
 * Chunk text by paragraphs with byte-based sizing and overlap.
 * If a paragraph is too long, fallback to sentence splitting.
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

/**
 * Extract text from various PDF.js text operators
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
        if ("str" in item) {
          text += item.str
        } else if ("unicode" in item) {
          text += item.unicode
        }
      }
    }
  }

  return text
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
  overlapBytes: number = 128,
): string {
  if (paragraphs.length === 0) return ""

  const cleanedParagraphs = paragraphs
    .map(cleanText)
    .filter((p) => p.length > 0)
  if (cleanedParagraphs.length === 0) return ""

  const cleanedText = cleanedParagraphs.join("\n")
  const chunks = chunkTextByParagraph(cleanedText, 512, 128)

  for (const chunk of chunks) {
    text_chunks.push(chunk)
    text_chunk_pos.push(globalSeq.value)
    globalSeq.value++
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

  return overlapText
}

export async function extractTextAndImagesWithChunksFromPDF(
  pdfPath: string,
  docid: string = crypto.randomUUID(),
  extractImages: boolean = true,
): Promise<{
  text_chunks: string[]
  image_chunks: string[]
  text_chunk_pos: number[]
  image_chunk_pos: number[]
}> {
  return withTempDirectory(async (tempDir) => {
    Logger.info(`Starting PDF processing for: ${pdfPath}`)

    let data: Uint8Array
    try {
      const buffer = await fsPromises.readFile(pdfPath)
      data = new Uint8Array(buffer)
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
    const loadingTask = PDFJS.getDocument({
      data,
      wasmUrl: openjpegWasmPath,
      iccUrl: qcmsWasmPath,
    })
    const pdfDocument = await loadingTask.promise

    let text_chunks: string[] = []
    let image_chunks: string[] = []
    let text_chunk_pos: number[] = []
    let image_chunk_pos: number[] = []

    // Use object to pass by reference for sequence counter
    let globalSeq = { value: 0 }
    let crossImageOverlap = "" // Track overlap across images

    Logger.info(`PDF has ${pdfDocument.numPages} pages`)

    for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
      Logger.debug(`Processing page ${pageNum}`)

      const page = await pdfDocument.getPage(pageNum)
      const opList = await page.getOperatorList()

      // Hold paragraphs for current page
      let paragraphs: string[] = []
      let currentParagraph = ""
      let textOperatorCount = 0

      // Start with cross-image overlap if available
      if (crossImageOverlap && extractImages) {
        currentParagraph = crossImageOverlap + " "
        crossImageOverlap = "" // Clear after using
      }

      // Helper to flush currentParagraph into paragraphs array
      const flushParagraph = () => {
        if (currentParagraph.trim().length > 0) {
          paragraphs.push(currentParagraph.trim())
          currentParagraph = ""
        }
      }

      for (let i = 0; i < opList.fnArray.length; i++) {
        const fnId = opList.fnArray[i]
        const args = opList.argsArray[i]

        switch (fnId) {
          case PDFJS.OPS.showText:
          case PDFJS.OPS.showSpacedText: {
            const text = extractTextFromArgs(args)
            if (text) {
              currentParagraph += text + " "
              textOperatorCount++
            }
            break
          }
          // Handle line break operators
          case PDFJS.OPS.nextLine: {
            flushParagraph()
            break
          }
          case PDFJS.OPS.nextLineShowText:
          case PDFJS.OPS.nextLineSetSpacingShowText: {
            const text = extractTextFromArgs(args)
            if (text) {
              currentParagraph += text + " "
              textOperatorCount++
            }
            flushParagraph()
            break
          }
          // Handle matrix and positioning operators that might indicate paragraph breaks
          case PDFJS.OPS.transform:
          case PDFJS.OPS.setTextMatrix:
          case PDFJS.OPS.moveText: {
            // These might indicate significant positioning changes
            // For now, we'll be conservative and not flush, but this could be adjusted
            break
          }
          // Handle image operators
          case extractImages ? PDFJS.OPS.paintImageXObject : null:
          case extractImages ? PDFJS.OPS.paintImageXObjectRepeat : null:
          case extractImages ? PDFJS.OPS.paintInlineImageXObject : null:
          case extractImages ? PDFJS.OPS.paintImageMaskXObject : null: {
            // Flush any pending text paragraphs before image
            flushParagraph()

            // Process accumulated paragraphs and capture overlap
            const overlapText = processTextParagraphs(
              paragraphs,
              text_chunks,
              text_chunk_pos,
              globalSeq,
            )
            paragraphs = [] // Clear paragraphs after processing

            // Store overlap for continuation after image
            crossImageOverlap = overlapText

            // Extract image buffer
            const imageName = args[0]
            // Small delay to ensure image object has a chance to resolve
            let imageDict
            try {
              imageDict = page.objs.get(imageName)
            } catch (err) {
              Logger.debug(
                `Image ${imageName} not resolved or failed to decode on page ${pageNum}: ${err instanceof Error ? err.message : err}`,
              )
              continue
            }
            if (!imageDict || !imageDict.data) {
              Logger.debug(
                `No image data found for ${imageName} on page ${pageNum}`,
              )
              continue
            }

            try {
              const { width, height, kind, data } = imageDict

              if (!width || !height || width <= 0 || height <= 0) {
                Logger.debug(
                  `Invalid image dimensions for ${imageName}: ${width}x${height}`,
                )
                continue
              }

              if (
                data.length >
                DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024
              ) {
                Logger.warn(
                  `Skipping large image (${(data.length / (1024 * 1024)).toFixed(2)} MB): ${imageName}`,
                )
                continue
              }

              if (width < 250 || height < 250) continue // Skip small images

              let uint8Data: Uint8Array
              if (data instanceof Uint8Array) {
                uint8Data = data
              } else if (
                data &&
                typeof data === "object" &&
                data.length !== undefined
              ) {
                uint8Data = new Uint8Array(data)
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
                      const rgbaData = new Uint8ClampedArray(width * height * 4)
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

              if (imageProcessed) {
                const imgBuffer = new Uint8Array(uint8Data.buffer)
                const type = await imageType(imgBuffer)
                if (
                  !type ||
                  !DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES.has(type.mime)
                ) {
                  Logger.warn(
                    `Unsupported or unknown image MIME type: ${type?.mime}. Skipping image: ${imageName}`,
                  )
                  continue
                }

                const buffer = canvas.toBuffer(type.mime as any)
                const imageHash = crypto
                  .createHash("md5")
                  .update(new Uint8Array(buffer))
                  .digest("hex")

                let description: string

                if (seenHashDescriptions.has(imageHash)) {
                  description = seenHashDescriptions.get(imageHash)!
                  Logger.warn(
                    `Reusing description for repeated image ${imageName} on page ${pageNum}`,
                  )
                } else {
                  description = await describeImageWithllm(buffer, tempDir)
                  if (
                    description === "No description returned." ||
                    description === "Image is not worth describing."
                  ) {
                    Logger.warn(
                      `${description} ${imageName} on page ${pageNum}`,
                    )
                    continue
                  }
                  seenHashDescriptions.set(imageHash, description)
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
                crossImageOverlap += ` [[IMG#${globalSeq.value}]] `
                globalSeq.value++
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

      // End of page: flush remaining paragraph and process paragraphs
      flushParagraph()
      const overlapText = processTextParagraphs(
        paragraphs,
        text_chunks,
        text_chunk_pos,
        globalSeq,
      )

      // Update cross-image overlap - APPEND instead of REPLACE to preserve image placeholders
      if (overlapText.trim()) {
        crossImageOverlap = crossImageOverlap
          ? `${crossImageOverlap} ${overlapText}`
          : overlapText
      }

      Logger.debug(
        `Page ${pageNum} completed. Text operators found: ${textOperatorCount}, Current text chunks: ${text_chunks.length}, Current image chunks: ${image_chunks.length}`,
      )
    }

    Logger.info(
      `PDF processing completed. Total text chunks: ${text_chunks.length}, Total image chunks: ${image_chunks.length}`,
    )

    return {
      text_chunks,
      image_chunks,
      text_chunk_pos,
      image_chunk_pos,
    }
  })
}
