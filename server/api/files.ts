import type { Context } from "hono"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { handleTranscriptUpload } from "@/integrations/transcript"
import { getUserByEmail } from "@/db/user"
import { db } from "@/db/client"
import { NoUserFound } from "@/errors"
import config from "@/config"
import { HTTPException } from "hono/http-exception"
import { unlink } from "node:fs/promises"

const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.Api).child({ module: "newApps" })
const DOWNLOADS_DIR = join(process.cwd(), "downloads")

// Create downloads directory if it doesn't exist
await mkdir(DOWNLOADS_DIR, { recursive: true })

const isTxtFile = (file: File) => {
  return file.type === 'text/plain' || file.name.toLowerCase().endsWith('.txt')
}

export const handleFileUpload = async (c: Context) => {
  try {
    // Get user authentication
    const { sub } = c.get(JwtPayloadKey)
    const userRes = await getUserByEmail(db, sub)
    if (!userRes || !userRes.length) {
      Logger.error({ sub }, "No user found in file upload")
      throw new NoUserFound({})
    }
    const [user] = userRes

    const formData = await c.req.formData()
    const files = formData.getAll("file") as File[]
    
    if (!files.length) {
      throw new HTTPException(400, {
        message: "No files uploaded. Please upload at least one file"
      })
    }

    // Validate file types
    const invalidFiles = files.filter(file => !isTxtFile(file))
    if (invalidFiles.length > 0) {
      throw new HTTPException(400, {
        message: `${invalidFiles.length} file(s) ignored. Only .txt files are allowed.`
      })
    }

    Logger.info({ fileCount: files.length, email: user.email }, "Processing uploaded files")
    
    const savedFiles = []
    const results = []

    for (const file of files) {
      const filePath = join(DOWNLOADS_DIR, file.name)
      try {
        // Save the file
        await Bun.write(filePath, file)
        savedFiles.push(file.name)

        // Process the transcript
        const result = await handleTranscriptUpload(file, user.email)
        results.push({
          filename: file.name,
          ...result
        })
      } catch (error) {
        Logger.error(error, `Error processing file ${file.name}`)
        results.push({
          filename: file.name,
          error: error instanceof Error ? error.message : "Unknown error"
        })
      } finally {
        // Clean up the file after processing
        try {
          await unlink(filePath)
          Logger.debug(`Cleaned up file: ${filePath}`)
        } catch (cleanupError) {
          Logger.error(cleanupError, `Error cleaning up file ${filePath}`)
        }
      }
    }

    return c.json({
      success: true,
      message: `Successfully uploaded ${savedFiles.length} files`,
      files: savedFiles,
      results
    })
  } catch (error) {
    Logger.error(error, "Error in file upload handler")
    throw error
  }
}


