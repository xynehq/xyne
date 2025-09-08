import { mkdir } from "node:fs/promises"
import path from "node:path"
import sharp from "sharp"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Api).child({ module: "imageUtils" })

export const THUMBNAIL_SIZE = 200
export const THUMBNAIL_QUALITY = 80

export interface ThumbnailOptions {
  width?: number
  height?: number
  quality?: number
}

export const generateThumbnail = async (
  inputBuffer: Buffer,
  outputPath: string,
  options: ThumbnailOptions = {},
): Promise<void> => {
  const {
    width = THUMBNAIL_SIZE,
    height = THUMBNAIL_SIZE,
    quality = THUMBNAIL_QUALITY,
  } = options

  try {
    // Ensure output directory exists
    await mkdir(path.dirname(outputPath), { recursive: true })

    // Generate thumbnail using sharp
    await sharp(inputBuffer)
      .resize(width, height, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .toFormat("jpeg", { quality })
      .toFile(outputPath)

    Logger.info(`Thumbnail generated successfully at ${outputPath}`)
  } catch (error) {
    Logger.error(error, `Failed to generate thumbnail at ${outputPath}`)
    throw error
  }
}

export const getThumbnailPath = (baseDir: string, fileId: string): string => {
  return path.join(baseDir, `${fileId}_thumbnail.jpeg`)
}
