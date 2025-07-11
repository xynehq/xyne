import type { AttachmentMetadata } from "@/shared/types"
import { HTTPException } from "hono/http-exception"
import type { Context } from "hono"
import { Subsystem } from "@/types"
import { getLogger } from "@/logger"
import { attachmentMetadataSchema } from "@/shared/types"

const logger = getLogger(Subsystem.Utils).child({ module: "attachment" })

export const parseAttachmentMetadata = (c: Context): AttachmentMetadata[] => {
  const attachmentMetadataQuery = c.req.query("attachmentMetadata")

  if (!attachmentMetadataQuery) {
    return []
  }

  try {
    const parsed = JSON.parse(attachmentMetadataQuery)

    // Validate that the parsed result is an array
    if (!Array.isArray(parsed)) {
      logger.warn("attachmentMetadata query parameter is not an array", {
        type: typeof parsed,
        value: parsed,
      })
      throw new HTTPException(400, {
        message: "attachmentMetadata must be an array",
      })
    }

    // Validate each item against the schema
    const validatedItems = parsed.map((item, index) => {
      try {
        return attachmentMetadataSchema.parse(item)
      } catch (error) {
        logger.warn(`Invalid attachment metadata at index ${index}`, {
          item,
          error,
        })
        throw new HTTPException(400, {
          message: `Invalid attachment metadata format at index ${index}`,
        })
      }
    })

    return validatedItems
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error // Re-throw our own HTTPExceptions
    }

    // Handle JSON parsing errors
    logger.error("Failed to parse attachmentMetadata JSON", {
      error: error instanceof Error ? error.message : String(error),
      queryValue: attachmentMetadataQuery,
    })

    throw new HTTPException(400, {
      message: "Invalid JSON format in attachmentMetadata parameter",
    })
  }
}
