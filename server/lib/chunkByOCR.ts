import { promises as fsPromises } from "fs"
import path from "path"
import { getLogger } from "../logger"
import { Subsystem, type ChunkMetadata } from "../types"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "chunkByOCR",
})

const DEFAULT_MAX_CHUNK_BYTES = 1024
const DEFAULT_IMAGE_DIR = "downloads/xyne_images_db"
const DEFAULT_LAYOUT_PARSING_URL = "http://localhost:8000/v2/models/layout-parsing/infer"

export interface ProcessingResult {
  chunks: string[]
  chunks_pos: number[]
  image_chunks: string[]
  image_chunks_pos: number[]
  chunks_map: ChunkMetadata[]
  image_chunks_map: ChunkMetadata[]
}
``
type LayoutParsingBlock = {
  block_label?: string
  block_content?: string
  block_bbox?: number[]
}

type LayoutParsingMarkdown = {
  text?: string
  isStart?: boolean
  isEnd?: boolean
  images?: Record<string, string>
}

type LayoutParsingResult = {
  prunedResult?: {
    parsing_res_list?: LayoutParsingBlock[]
  }
  markdown?: LayoutParsingMarkdown
}

type LayoutParsingApiEnvelope = {
  outputs?: Array<{
    data?: string[]
  }>
}

type LayoutParsingApiPayload = {
  layoutParsingResults: LayoutParsingResult[]
  dataInfo?: unknown
}

type TritonRequestPayload = {
  inputs: Array<{
    name: string
    shape: number[]
    datatype: string
    data: string[]
  }>
  outputs: Array<{
    name: string
  }>
}

type ImageLookupEntry = {
  base64: string
  filePath: string
}

type ImageMetadata = {
  fileName?: string
  bboxKey?: string | null
  pageIndex: number
}

type ImageBufferMap = Record<number, Buffer>
type ImageMetadataMap = Record<number, ImageMetadata>

type OcrBlock = {
  block_label: string
  block_content: string
  block_bbox: number[]
  image_index?: number
}

type OcrResponse = Record<string, OcrBlock[]>

type GlobalSeq = {
  value: number
}

function getByteLength(str: string): number {
  return Buffer.byteLength(str, "utf8")
}

function splitText(text: string, maxBytes: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+|\S+/g) ?? []
  const chunks: string[] = []
  let currentChunk: string[] = []
  let currentBytes = 0

  for (const sentence of sentences) {
    const sentenceBytes = getByteLength(sentence) + 1

    if (currentBytes + sentenceBytes > maxBytes) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.join(" "))
      }
      currentChunk = [sentence]
      currentBytes = sentenceBytes
    } else {
      currentChunk.push(sentence)
      currentBytes += sentenceBytes
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(" "))
  }

  return chunks
}

function detectImageExtension(buffer: Buffer): string {
  if (buffer.length >= 4) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "jpg"
    }
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return "png"
    }
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return "gif"
    }
    if (
      buffer.slice(0, 4).toString("ascii") === "RIFF" &&
      buffer.slice(8, 12).toString("ascii") === "WEBP"
    ) {
      return "webp"
    }
  }
  return "jpg"
}

function sanitizeFileName(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9._-]/g, "_")
  return sanitized || "image"
}

function ensureUniqueFileName(name: string, usedNames: Set<string>): string {
  if (!usedNames.has(name)) {
    usedNames.add(name)
    return name
  }

  const parsed = path.parse(name)
  let counter = 1

  while (true) {
    const candidate = `${parsed.name}_${counter}${parsed.ext}`
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate)
      return candidate
    }
    counter += 1
  }
}

function normalizeBBox(bbox?: number[]): string | null {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    return null
  }
  try {
    return bbox.map((value) => Math.round(Number(value))).join("_")
  } catch {
    return null
  }
}

function parseBBoxKeyFromImagePath(imagePath: string): string | null {
  if (!imagePath) {
    return null
  }
  const cleaned = imagePath.replace(/\\/g, "/")
  const fileName = cleaned.split("/").pop()
  if (!fileName) {
    return null
  }
  const numbers = fileName.match(/\d+/g)
  if (!numbers || numbers.length < 4) {
    return null
  }
  return numbers.slice(-4).join("_")
}

function buildImageLookup(images: Record<string, string>): Map<string, ImageLookupEntry> {
  const lookup = new Map<string, ImageLookupEntry>()

  for (const [imgPath, base64Data] of Object.entries(images)) {
    if (!base64Data) {
      continue
    }
    const bboxKey = parseBBoxKeyFromImagePath(imgPath)
    if (!bboxKey) {
      continue
    }
    if (!lookup.has(bboxKey)) {
      lookup.set(bboxKey, {
        base64: base64Data,
        filePath: imgPath,
      })
    }
  }

  return lookup
}

function transformBlockContent(label: string, content: string): string {
  switch (label) {
    case "header":
    case "doc_title":
      return content ? `# ${content}` : content
    case "paragraph_title":
      return content ? `## ${content}` : content
    case "formula":
      return content ? `$$${content}$$` : content
    case "figure_title":
      return content ? `<div style="text-align: center;">${content}</div>` : content
    default:
      return content
  }
}

function normalizeBlockContent(block: OcrBlock): string {
  const content = block.block_content ?? ""
  if (!content.trim()) {
    return ""
  }

  // if (block.block_label === "table") {
  //   return content
  //     .replace(/<\/(td|th)>/gi, " ")
  //     .replace(/<\/tr>/gi, " \n ")
  //     .replace(/<[^>]+>/g, " ")
  //     .replace(/\s+/g, " ")
  //     .trim()
  // }

  if (block.block_label === "figure_title") {
    return content.trim()
  }

  return content.replace(/\s+/g, " ").trim()
}

function deriveImageFileName(
  preferredName: string | undefined,
  bboxKey: string | null | undefined,
  buffer: Buffer,
  imageIndex: number,
  pageIndex: number,
): string {
  const ext = detectImageExtension(buffer)

  if (preferredName) {
    const sanitized = sanitizeFileName(preferredName)
    const parsed = path.parse(sanitized)

    if (parsed.ext) {
      const normalizedExt = parsed.ext.replace(/\./, "")
      if (normalizedExt.toLowerCase() !== ext) {
        return `${parsed.name || `image_${imageIndex}`}.${ext}`
      }
      return sanitized
    }

    return `${parsed.name || `image_${imageIndex}`}.${ext}`
  }

  if (bboxKey) {
    return `img_in_image_box_${bboxKey}.${ext}`
  }

  return `page_${pageIndex + 1}_image_${imageIndex}.${ext}`
}

async function callLayoutParsingApi(buffer: Buffer, fileName: string): Promise<LayoutParsingApiPayload> {
  const apiUrl = process.env.LAYOUT_PARSING_URL || DEFAULT_LAYOUT_PARSING_URL
  const fileType = Number.parseInt(process.env.LAYOUT_PARSING_FILE_TYPE ?? "0", 10) || 0
  const visualize = process.env.LAYOUT_PARSING_VISUALIZE === "true"
  const timeoutMs = Number.parseInt(process.env.LAYOUT_PARSING_TIMEOUT_MS ?? "120000", 10)

  Logger.info("Calling layout parsing API", {
    apiUrl,
    fileName,
    fileSize: buffer.length,
  })

  const inputPayload = {
    file: buffer.toString("base64"),
    fileType,
    visualize,
  }

  const requestPayload: TritonRequestPayload = {
    inputs: [
      {
        name: "input",
        shape: [1, 1],
        datatype: "BYTES",
        data: [JSON.stringify(inputPayload)],
      },
    ],
    outputs: [
      {
        name: "output",
      },
    ],
  }

  const controller = new AbortController()
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload),
      signal: controller.signal,
    })

    if (!response.ok) {
      const responseText = await response.text().catch(() => "")
      throw new Error(
        `Layout parsing API request failed (${response.status}): ${responseText.slice(0, 200)}`,
      )
    }

    const envelope = (await response.json()) as LayoutParsingApiEnvelope

    const outputPayload = envelope.outputs?.[0]?.data?.[0]
    if (!outputPayload) {
      throw new Error("Layout parsing API payload missing expected output data")
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(outputPayload)
    } catch (error) {
      throw new Error(`Failed to JSON.parse layout parsing payload: ${(error as Error).message}`)
    }

    const result = (parsed as { result?: LayoutParsingApiPayload }).result
    if (!result) {
      throw new Error("Layout parsing API response missing result field")
    }

    return result
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function transformLayoutParsingResults(
  layoutParsingResults: LayoutParsingResult[],
): {
  ocrResponse: OcrResponse
  images: ImageBufferMap
  imageMetadata: ImageMetadataMap
} {
  const ocrResponse: OcrResponse = {}
  const images: ImageBufferMap = {}
  const imageMetadata: ImageMetadataMap = {}
  let nextImageIndex = 0

  layoutParsingResults.forEach((layout, pageIndex) => {
    const parsingResList = layout.prunedResult?.parsing_res_list ?? []
    const markdownImages = layout.markdown?.images ?? {}
    const imageLookup = buildImageLookup(markdownImages)
    const usedImagePaths = new Set<string>()
    const transformedBlocks: OcrBlock[] = []

    for (const rawBlock of parsingResList) {
      const blockLabel = rawBlock.block_label ?? "text"
      const rawContent = rawBlock.block_content ?? ""
      const transformedContent = transformBlockContent(blockLabel, rawContent)
      const blockBBox = Array.isArray(rawBlock.block_bbox) ? [...rawBlock.block_bbox] : []

      const transformedBlock: OcrBlock = {
        block_label: blockLabel,
        block_content: transformedContent,
        block_bbox: blockBBox,
      }

      if (blockLabel === "image") {
        const bboxKey = normalizeBBox(blockBBox)
        const matchedImage = bboxKey ? imageLookup.get(bboxKey) : undefined

        if (matchedImage && !usedImagePaths.has(matchedImage.filePath)) {
          try {
            const imageBuffer = Buffer.from(matchedImage.base64, "base64")
            const imageIndex = nextImageIndex
            nextImageIndex += 1

            transformedBlock.image_index = imageIndex
            images[imageIndex] = imageBuffer
            imageMetadata[imageIndex] = {
              fileName: path.basename(matchedImage.filePath),
              bboxKey,
              pageIndex,
            }
            usedImagePaths.add(matchedImage.filePath)
          } catch (error) {
            console.log("Failed to decode image from layout parsing result", {
              error: (error as Error).message,
              pageIndex,
              bboxKey,
            })
          }
        } else {
          console.log("No matching image found for block", {
            pageIndex,
            bboxKey,
          })
        }
      }

      transformedBlocks.push(transformedBlock)
    }

    ocrResponse[String(pageIndex)] = transformedBlocks
  })

  return { ocrResponse, images, imageMetadata }
}

export async function chunkByOCRFromBuffer(
  buffer: Buffer,
  fileName: string,
  docId: string,
): Promise<ProcessingResult> {
  console.log("🚀 chunkByOCRFromBuffer: Starting processing", {
    fileName,
    docId,
    bufferSize: buffer.length
  })
  
  const apiResult = await callLayoutParsingApi(buffer, fileName)
  console.log("📡 chunkByOCRFromBuffer: API result received", {
    layoutResultsCount: apiResult.layoutParsingResults?.length || 0
  })
  
  const layoutResults = apiResult.layoutParsingResults ?? []
  if (layoutResults.length === 0) {
    Logger.warn("Layout parsing API returned no results", { fileName })
    console.log("⚠️ chunkByOCRFromBuffer: No layout results returned")
  }

  const { ocrResponse, images, imageMetadata } = transformLayoutParsingResults(layoutResults)
  console.log("🔄 chunkByOCRFromBuffer: Transformed layout results", {
    ocrResponsePages: Object.keys(ocrResponse).length,
    imagesCount: Object.keys(images).length,
    imageMetadataCount: Object.keys(imageMetadata).length
  })
  
  return chunkByOCR(docId, ocrResponse, images, imageMetadata)
}

export async function chunkByOCR(
  docId: string,
  ocrResponse: OcrResponse,
  images: ImageBufferMap,
  imageMetadata: ImageMetadataMap = {},
): Promise<ProcessingResult> {
  const chunks: string[] = []
  const chunks_map: ChunkMetadata[] = []
  const image_chunks: string[] = []
  const image_chunks_map: ChunkMetadata[] = []

  const globalSeq: GlobalSeq = { value: 0 }
  const maxChunkBytes = Number.parseInt(process.env.OCR_MAX_CHUNK_BYTES ?? "", 1024)
  const chunkSizeLimit = Number.isFinite(maxChunkBytes) && maxChunkBytes > 0 ? maxChunkBytes : DEFAULT_MAX_CHUNK_BYTES

  let currentTextBuffer = ""
  let currentBlockLabels: string[] = []
  let lastPageNumber = -1

  const imageBaseDir = path.resolve(process.env.IMAGE_DIR || DEFAULT_IMAGE_DIR)
  const docImageDir = path.join(imageBaseDir, docId)
  await fsPromises.mkdir(docImageDir, { recursive: true })
  const savedImages = new Set<number>()
  const usedFileNames = new Set<string>()

  const addChunk = () => {
    if (!currentTextBuffer.trim()) {
      currentTextBuffer = ""
      currentBlockLabels = []
      return
    }

    const subChunks = splitText(currentTextBuffer, chunkSizeLimit)

    for (let index = 0; index < subChunks.length; index += 1) {
      let chunkContent = subChunks[index]
      if (index > 0) {
        chunkContent = `(continued) ${chunkContent}`
      }

      chunks.push(chunkContent)
      chunks_map.push({
        chunk_index: globalSeq.value,
        page_number: lastPageNumber,
        block_labels: [...new Set(currentBlockLabels)],
      })

      globalSeq.value += 1
    }

    currentTextBuffer = ""
    currentBlockLabels = []
  }

  const pageKeys = Object.keys(ocrResponse)
    .map((key) => Number.parseInt(key, 10))
    .filter((value) => !Number.isNaN(value))
    .sort((a, b) => a - b)

  for (const pageNumber of pageKeys) {
    const blocks = ocrResponse[String(pageNumber)] ?? []
    lastPageNumber = pageNumber

    for (const block of blocks) {
      if (block.block_label === "image") {
        if (typeof block.image_index !== "number") {
          Logger.warn("Image block missing image_index", {
            docId,
            pageNumber,
          })
          continue
        }

        const imageBuffer = images[block.image_index]
        if (!imageBuffer) {
          Logger.warn("No image buffer found for index", {
            docId,
            pageNumber,
            imageIndex: block.image_index,
          })
          continue
        }

        const metadata = imageMetadata[block.image_index] ?? {
          bboxKey: normalizeBBox(block.block_bbox),
          pageIndex: pageNumber,
        }

        // const fileName = deriveImageFileName(
        //   metadata.fileName,
        //   metadata.bboxKey ?? normalizeBBox(block.block_bbox),
        //   imageBuffer,
        //   block.image_index,
        //   metadata.pageIndex ?? pageNumber,
        // )
        const fileName = String(globalSeq.value) + ".png"

        const uniqueFileName = ensureUniqueFileName(fileName, usedFileNames)
        const imagePath = path.join(docImageDir, uniqueFileName)

        if (!savedImages.has(block.image_index)) {
          try {
            await fsPromises.writeFile(imagePath, imageBuffer)
            savedImages.add(block.image_index)
            Logger.info("Saved OCR image", {
              docId,
              pageNumber,
              imageIndex: block.image_index,
              imagePath,
            })
          } catch (error) {
            Logger.error("Failed to save OCR image", {
              docId,
              pageNumber,
              imageIndex: block.image_index,
              error: (error as Error).message,
            })
          }
        }

        const description = block.block_content || "Image from document"
        image_chunks.push(description)
        image_chunks_map.push({
          chunk_index: globalSeq.value,
          page_number: pageNumber,
          block_labels: ["image"],
        })
        globalSeq.value += 1

        currentTextBuffer += `${currentTextBuffer ? " " : ""}[IMG#${block.image_index}]`
      } else {
        const normalizedText = normalizeBlockContent(block)
        if (!normalizedText) {
          console.log("No normlaize text found")
          continue
        }

        const projectedSize =
          getByteLength(currentTextBuffer) + (currentTextBuffer ? 1 : 0) + getByteLength(normalizedText)

        if (projectedSize > chunkSizeLimit) {
          addChunk()
        }

        currentTextBuffer += (currentTextBuffer ? " " : "") + normalizedText
        currentBlockLabels.push(block.block_label)
      }
    }
  }

  if (currentTextBuffer.trim()) {
    console.log("🔚 chunkByOCR: Adding final text chunk")
    addChunk()
  }

  const chunks_pos = chunks_map.map((metadata) => metadata.chunk_index)
  const image_chunks_pos = image_chunks_map.map((metadata) => metadata.chunk_index)

  console.log("🎉 chunkByOCR: Processing completed", {
    totalTextChunks: chunks.length,
    totalImageChunks: image_chunks.length,
    totalChunksMetadata: chunks_map.length,
    totalImageChunksMetadata: image_chunks_map.length,
    finalGlobalSeq: globalSeq.value
  })

  return {
    chunks,
    chunks_pos,
    image_chunks,
    image_chunks_pos,
    chunks_map,
    image_chunks_map,
  }
}
