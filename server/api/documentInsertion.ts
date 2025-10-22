import { type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { getLogger } from "@/logger"
import { Subsystem, ProcessingJobType } from "@/types"
import { getErrorMessage } from "@/utils"
import { db } from "@/db/client"
import { getUserByEmail } from "@/db/user"
import { getAuth, safeGet } from "./agent"
import { ApiKeyScopes } from "@/shared/types"
import { getCollectionById, getCollectionItemById } from "@/db/knowledgeBase"
import { processJob, type ProcessingJob } from "@/queue/fileProcessor"

const Logger = getLogger(Subsystem.Api)

// No request body schema needed - fileId comes from URL

// Helper function to process any document type using existing worker logic
async function processDocumentDirect(jobData: ProcessingJob) {
  const startTime = Date.now()

  try {
    // Use the existing processJob function from the worker
    await processJob({ data: jobData })

    const endTime = Date.now()
    const processingTime = endTime - startTime

    Logger.info(
      `Successfully processed ${jobData.type || "file"} job in ${processingTime}ms`,
    )

    return {
      success: true,
      message: "Document processed successfully",
      processingTime,
      status: "completed",
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    Logger.error(error, `Failed to process document: ${errorMessage}`)

    return {
      success: false,
      message: `Processing failed: ${errorMessage}`,
      status: "failed",
    }
  }
}

// API Handler

// Insert a single file document into Vespa
export const InsertFileDocumentApi = async (c: Context) => {
  const { email: userEmail, via_apiKey } = getAuth(c)

  if (via_apiKey) {
    const apiKeyScopes =
      safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
    if (!apiKeyScopes.includes(ApiKeyScopes.UPLOAD_FILES)) {
      return c.json(
        { message: "API key does not have scope to insert/upload files" },
        403,
      )
    }
  }

  try {
    // Get fileId from URL parameter
    const fileId = c.req.param("fileId")

    // Validate fileId format
    if (
      !fileId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        fileId,
      )
    ) {
      throw new HTTPException(400, { message: "Invalid fileId format" })
    }

    // Get user and file details in parallel to optimize database queries
    const [users, fileItem] = await Promise.all([
      getUserByEmail(db, userEmail),
      getCollectionItemById(db, fileId),
    ])
    
    if (!users || users.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const user = users[0]
    
    if (!fileItem || fileItem.type !== "file") {
      throw new HTTPException(404, { message: "File not found" })
    }

    // Get the collection to verify user owns it
    const collection = await getCollectionById(db, fileItem.collectionId)
    if (!collection) {
      throw new HTTPException(404, { message: "Collection not found" })
    }

    // Check ownership
    if (collection.ownerId !== user.id) {
      throw new HTTPException(403, {
        message: "You don't have access to this file",
      })
    }

    // Use existing worker logic
    const result = await processDocumentDirect({
      fileId: fileId,
      type: ProcessingJobType.FILE,
    })

    Logger.info(`File document inserted via API: ${fileId} by ${userEmail}`)

    return c.json({
      fileId: fileId,
      fileName: fileItem.name,
      collectionId: fileItem.collectionId,
      collectionName: collection.name,
      ...result,
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    Logger.error(error, `Failed to insert file document: ${errMsg}`)
    throw new HTTPException(500, {
      message: `Failed to insert file document: ${errMsg}`,
    })
  }
}
