/**
 * Image processing for Docling documents
 * Handles extraction, saving, and description of images within the semantic stream
 */

import { promises as fsPromises } from "fs"
import path from "path"
import type { DoclingPictureItem } from "./types"
import {
  DeferredImageDescriptionBatch,
  md5ImageBuffer,
} from "../../deferredImageDescription"
import { DATASOURCE_CONFIG } from "../../../integrations/dataSource/config"
import { logger } from "@azure/identity"

const MIN_IMAGE_DIM_PX = parseInt(process.env.MIN_IMAGE_DIM_PX || "150", 10)

export interface ProcessedImage {
  description: string
  imageHash: string
}

export interface ImageProcessingContext {
  docId: string
  describeImages: boolean
  batch: DeferredImageDescriptionBatch
}

export interface ImageInput {
  seq: number
  imageUri: string
  mimetype?: string
  width?: number
  height?: number
}

/**
 * Extract base64 data from data URI
 */
function extractBase64FromUri(
  uri: string,
): { mime: string; data: Buffer } | null {
  const match = uri.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  const [, mime, base64] = match
  return { mime, data: Buffer.from(base64, "base64") }
}

/**
 * Process a single image node
 * Returns the processed image info or null if filtered out
 */
export async function processImageNode(
  input: ImageInput,
  context: ImageProcessingContext,
): Promise<ProcessedImage | null> {
  const { docId, describeImages, batch } = context

  if (!input.imageUri) {
    return null
  }

  const width = input.width
  const height = input.height
  const uri = input.imageUri

  if (width !== undefined && height !== undefined) {
    if (width < MIN_IMAGE_DIM_PX || height < MIN_IMAGE_DIM_PX) {
      return null
    }
  }

  const extracted = extractBase64FromUri(uri)
  if (!extracted) {
    return null
  }

  const { mime, data: buffer } = extracted

  if (buffer.length > DATASOURCE_CONFIG.MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024) {
    return null
  }

  if (!DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES.has(mime)) {
    return null
  }

  const ext = mime.split("/")[1] || "png"
  let imagePath: string
  try {
    const baseDir = path.resolve(
      process.env.IMAGE_DIR || "downloads/xyne_images_db",
    )
    const outputDir = path.join(baseDir, docId)
    await fsPromises.mkdir(outputDir, { recursive: true })
    const imageFilename = `${input.seq}.${ext}`
    imagePath = path.join(outputDir, imageFilename)
    await fsPromises.writeFile(
      imagePath,
      buffer as NodeJS.ArrayBufferView,
    )
    logger.info(`Saved image to: ${imagePath}`)
  } catch (e) {
    logger.error(
      `Failed to save image: ${e instanceof Error ? e.message : e}`,
    )

    return null
  }

  const imageHash = md5ImageBuffer(buffer)
  const description = batch.registerImagePathForLaterDescribe(
    imageHash,
    path.resolve(imagePath),
    describeImages,
  )

  return {
    description,
    imageHash,
  }
}

/**
 * Extract captions for a picture node
 */
export function extractCaptions(
  node: DoclingPictureItem,
  lookup: Map<string, any>,
): string {
  const captionTexts: string[] = []

  // Docling stores caption refs in the 'captions' field
  const captionRefs = (node as any).captions || []

  for (const captionRef of captionRefs) {
    const captionNode = lookup.get(captionRef.$ref)
    if (captionNode && captionNode.text) {
      captionTexts.push(captionNode.text)
    }
  }

  return captionTexts.join(" ")
}
