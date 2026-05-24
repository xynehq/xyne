import { promises as fs } from "node:fs"
import path from "node:path"
import type { ImageContent } from "@earendil-works/pi-ai"
import { getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"

const mimeTypeMap: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

async function readImageFile(
  fileId: string,
  email: string,
): Promise<{ data: string; mimeType: string } | null> {
  const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

  try {
    const imageDir = process.env.IMAGE_DIR || "downloads/xyne_images_db"
    const imagePathDir = path.join(process.cwd(), imageDir, fileId)

    // Read the directory to find image files
    let files: string[]
    try {
      files = await fs.readdir(imagePathDir)
    } catch (dirError) {
      loggerWithChild({ email }).warn(
        "Image directory not found, skipping image",
        {
          fileId,
          directory: imagePathDir,
          error: getErrorMessage(dirError),
        },
      )
      return null
    }

    // Find the first valid image file (typically named "0", "1", etc.)
    const imageFile = files.find((file) => {
      const ext = path.parse(file).ext.toLowerCase()
      return mimeTypeMap[ext] !== undefined
    })

    if (!imageFile) {
      loggerWithChild({ email }).warn("No image files found in directory", {
        fileId,
        directory: imagePathDir,
        files,
      })
      return null
    }

    const imagePath = path.join(imagePathDir, imageFile)
    const ext = path.parse(imageFile).ext.toLowerCase()
    const mimeType = mimeTypeMap[ext] || "image/png"

    // Read the image file
    const imageBuffer = await fs.readFile(imagePath)
    const data = imageBuffer.toString("base64")

    loggerWithChild({ email }).info("Successfully loaded image attachment", {
      fileId,
      imagePath,
      mimeType,
      size: imageBuffer.length,
    })

    return { data, mimeType }
  } catch (error) {
    loggerWithChild({ email }).error("Error reading image file, skipping", {
      fileId,
      error: getErrorMessage(error),
    })
    return null
  }
}

export async function getImagesForAgent(
  imageFileIds: string[],
  email: string,
): Promise<ImageContent[]> {
  const images: ImageContent[] = []

  for (const fileId of imageFileIds) {
    const imageData = await readImageFile(fileId, email)
    if (imageData) {
      images.push({
        type: "image",
        data: imageData.data,
        mimeType: imageData.mimeType,
      })
    }
  }

  return images
}
