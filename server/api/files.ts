import type { Context } from "hono"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import {
  type DataSourceUploadResult,
  handleSingleFileUploadToDataSource,
} from "@/api/dataSource"
import { getUserByEmail } from "@/db/user"
import { db } from "@/db/client"
import {
  checkIfDataSourceFileExistsByNameAndId,
  getDataSourceByNameAndCreator,
} from "../search/vespa"
import { NoUserFound } from "@/errors"
import config from "@/config"
import { HTTPException } from "hono/http-exception"
import { unlink } from "node:fs/promises"

const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.Api).child({ module: "newApps" })
const loggerWithChild = getLoggerWithChild(Subsystem.Api, { module: "newApps" })

const DOWNLOADS_DIR = join(process.cwd(), "downloads")
await mkdir(DOWNLOADS_DIR, { recursive: true })

interface FileUploadToDataSourceResult extends DataSourceUploadResult {
  filename: string
}

const isValidFile = (file: File) => {
  // Accept only text, image, pdf, docs, sheets, ppts, and check size limits
  const maxSize = 15 * 1024 * 1024 // 15MB limit

  // Allowed MIME types
  const allowedTypes = [
    "text/plain",
    "text/csv",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ]

  // Allowed extensions (for fallback)
  const allowedExtensions = [
    ".txt",
    ".csv",
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
  ]

  // Check by MIME type or extension
  const isAllowedType =
    allowedTypes.includes(file.type) ||
    allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext))

  return file.size <= maxSize && isAllowedType
}

export const handleFileUpload = async (c: Context) => {
  let email = ""
  try {
    const { sub } = c.get(JwtPayloadKey)
    email = sub
    const userRes = await getUserByEmail(db, sub)
    if (!userRes || !userRes.length) {
      loggerWithChild({ email: email }).error(
        { sub },
        "No user found in file upload",
      )
      throw new NoUserFound({})
    }
    const [user] = userRes

    const formData = await c.req.formData()
    const files = formData.getAll("file") as File[]
    const datasourceName = formData.get("datasourceName") as string | null
    const flag = formData.get("flag") as "creation" | "addition" | null

    if (!datasourceName || datasourceName.trim() === "") {
      throw new HTTPException(400, { message: "Datasource name is required." })
    }

    let dataSourceId: string | undefined
    if (flag === "addition") {
      const dataSource = await getDataSourceByNameAndCreator(
        datasourceName,
        user.email,
      )
      if (!dataSource) {
        throw new HTTPException(404, {
          message: `Datasource "${datasourceName}" not found for user.`,
        })
      }
      dataSourceId = dataSource.docId
    }

    if (!flag || (flag !== "creation" && flag !== "addition")) {
      throw new HTTPException(400, {
        message: "Operation flag ('creation' or 'addition') is required.",
      })
    }

    if (!files.length) {
      throw new HTTPException(400, {
        message: "No files uploaded. Please upload at least one file",
      })
    }

    const invalidFiles = files.filter((file) => !isValidFile(file))
    if (invalidFiles.length > 0) {
      throw new HTTPException(400, {
        message: `${invalidFiles.length} file(s) rejected. Files must be under 15MB and of supported types.`,
      })
    }

    loggerWithChild({ email: email }).info(
      { fileCount: files.length, email: user.email },
      "Processing uploaded files for DataSource",
    )

    const dataSourceProcessingResults: FileUploadToDataSourceResult[] = []
    const successfullyProcessedFiles: string[] = []
    const erroredFiles: { name: string; error: string }[] = []

    for (const file of files) {
      try {
        if (flag === "addition" && dataSourceId) {
          const fileExists = await checkIfDataSourceFileExistsByNameAndId(
            file.name,
            dataSourceId,
            user.email,
          )
          if (fileExists) {
            loggerWithChild({ email: email }).warn(
              `File "${file.name}" already exists in DataSource ID "${dataSourceId}" for user ${user.email}. Skipping.`,
            )
            erroredFiles.push({
              name: file.name,
              error: "Document already exists in this datasource.",
            })
            continue
          }
        }

        loggerWithChild({ email: email }).info(
          `Processing file "${file.name}" for DataSource for user ${user.email}`,
        )
        const result = await handleSingleFileUploadToDataSource({
          file,
          user,
          dataSourceName: datasourceName,
          flag,
        })
        dataSourceProcessingResults.push({
          filename: file.name,
          ...result,
        })
        successfullyProcessedFiles.push(file.name)
        loggerWithChild({ email: email }).info(
          `File "${file.name}" processed successfully for DataSource. Result: ${result.message}`,
        )
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Unknown error during DataSource processing"
        loggerWithChild({ email: email }).error(
          error,
          `Error processing file "${file.name}" for DataSource`,
        )
        erroredFiles.push({ name: file.name, error: errorMessage })
      }
    }

    const allProcessed = successfullyProcessedFiles.length === files.length
    const partialSuccess =
      successfullyProcessedFiles.length > 0 &&
      successfullyProcessedFiles.length < files.length

    let message = ""
    if (allProcessed) {
      message = `Successfully processed ${successfullyProcessedFiles.length} file(s) for DataSource.`
    } else if (partialSuccess) {
      message = `Processed ${successfullyProcessedFiles.length} file(s) successfully for DataSource. ${erroredFiles.length} file(s) failed.`
    } else if (
      erroredFiles.length > 0 &&
      successfullyProcessedFiles.length === 0
    ) {
      message = `Failed to process all ${erroredFiles.length} file(s) for DataSource.`
    } else {
      message = "No files were processed."
    }

    return c.json({
      success: successfullyProcessedFiles.length > 0,
      message,
      processedFiles: successfullyProcessedFiles,
      failedFiles: erroredFiles,
      dataSourceResults: dataSourceProcessingResults,
    })
  } catch (error) {
    loggerWithChild({ email: email }).error(
      error,
      "Error in file upload handler",
    )
    throw error
  }
}
