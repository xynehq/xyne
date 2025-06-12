import { randomUUID } from "crypto"
import { createId } from "@paralleldrive/cuid2"
import { mkdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import {
  insertDataSource,
  getDataSourceByNameAndCreator,
  NAMESPACE,
  getDataSourceFilesByName,
  getDataSourcesByCreator,
} from "@/search/vespa"
import { handleDataSourceFileUpload } from "@/integrations/dataSource"
import { type VespaDataSource, type VespaSearchResult } from "@/search/types"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { type SelectUser } from "@/db/schema"
import { z } from "zod"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { UserRole } from "@/shared/types"

const Logger = getLogger(Subsystem.Api)
const log = getLogger(Subsystem.Api).child({  })
const loggerWithChild  = getLoggerWithChild(Subsystem.Api, {module: "dataSourceService"})
const DOWNLOADS_DIR_DATASOURCE = join(
  process.cwd(),
  "downloads",
  "datasources_temp_for_processing",
)
;(async () => {
  try {
    await mkdir(DOWNLOADS_DIR_DATASOURCE, { recursive: true })
    log.info(
      `DataSource processing temp directory ensured: ${DOWNLOADS_DIR_DATASOURCE}`,
    )
  } catch (error) {
    log.error(
      error,
      `Failed to create DataSource processing temp directory: ${DOWNLOADS_DIR_DATASOURCE}`,
    )
  }
})()

interface HandleDataSourceFileUploadOptions {
  file: File
  user: SelectUser
  description?: string
  dataSourceName: string
  flag: "creation" | "addition"
}

interface FileProcessingResult {
  success: boolean
  message: string
  docId: string
  fileName: string
}

export interface DataSourceUploadResult {
  message: string
  dataSourceUserSpecificId: string
  fileProcessingResult: FileProcessingResult
}

export async function handleSingleFileUploadToDataSource(
  options: HandleDataSourceFileUploadOptions,
): Promise<DataSourceUploadResult> {
  const { file, user, description, dataSourceName, flag } = options

  if (
    !dataSourceName ||
    typeof dataSourceName !== "string" ||
    dataSourceName.trim() === ""
  ) {
    throw new Error("Valid dataSourceName is required.")
  }
  if (!flag || (flag !== "creation" && flag !== "addition")) {
    throw new Error("Valid flag ('creation' or 'addition') is required.")
  }
  if (!file || !file.name || file.size === 0) {
    throw new Error("Valid file object is required for DataSource processing.")
  }

  loggerWithChild({email: user.email}).debug(
    `Processing file for DataSource: "${dataSourceName}", operation: ${flag}, file: "${file.name}", user: ${user.email}`,
  )

  const tempFileName = `${Date.now()}_${randomUUID()}_${file.name}`
  const filePath = join(DOWNLOADS_DIR_DATASOURCE, tempFileName)

  let existingDataSource: VespaDataSource | null = null
  let dataSourceVespaId: string

  try {
    await Bun.write(filePath, file)
    loggerWithChild({email: user.email}).debug(`File temporarily saved for DataSource processing: ${filePath}`)

    const now = Date.now()

    if (flag === "creation") {
      existingDataSource = await getDataSourceByNameAndCreator(
        dataSourceName,
        user.email,
      )
      if (existingDataSource) {
        loggerWithChild({email: user.email}).warn(
          `Data source named "${dataSourceName}" already exists for user ${user.email}. Proceeding to add file to this existing data source.`,
        )
        dataSourceVespaId = existingDataSource.docId
      } else {
        loggerWithChild({email: user.email}).debug(
          `Creating new DataSource "${dataSourceName}" for user ${user.email}`,
        )
        dataSourceVespaId = `ds-${createId()}`
        const newDataSourceDoc: VespaDataSource = {
          docId: dataSourceVespaId,
          name: dataSourceName,
          createdBy: user.email,
          createdAt: now, // 'now' is defined before this block in the original code
          updatedAt: now, // 'now' is defined before this block in the original code
        }
        await insertDataSource(newDataSourceDoc)
        loggerWithChild({email: user.email}).debug(
          `New DataSource "${dataSourceName}" created with ID: ${dataSourceVespaId}`,
        )
      }
    } else {
      // flag === "addition"
      existingDataSource = await getDataSourceByNameAndCreator(
        dataSourceName,
        user.email,
      )
      if (!existingDataSource || !existingDataSource.docId) {
        loggerWithChild({email: user.email}).warn(
          `Attempt to add file to non-existent DataSource: "${dataSourceName}" for user ${user.email}`,
        )
        throw new Error(
          `Data source named "${dataSourceName}" not found for adding files.`,
        )
      }
      loggerWithChild({email: user.email}).debug(
        `Adding file to existing DataSource "${dataSourceName}": ${existingDataSource.docId} for user ${user.email}`,
      )
      dataSourceVespaId = existingDataSource.docId
    }

    const fileFromPath = Bun.file(filePath)
    const fileObjectForIntegration = {
      name: file.name,
      size: fileFromPath.size,
      type: file.type || "application/octet-stream",
      text: async () => await fileFromPath.text(),
      arrayBuffer: async () => await fileFromPath.arrayBuffer(),
    } as File

    const fileProcessingResult = await handleDataSourceFileUpload(
      fileObjectForIntegration,
      user.email,
      dataSourceVespaId,
      description,
    )

    return {
      message: `File processed and stored in DataSource "${dataSourceName}" successfully.`,
      dataSourceUserSpecificId: dataSourceVespaId,
      fileProcessingResult,
    }
  } catch (error) {
    loggerWithChild({email: user.email}).error("Error during DataSource file processing:", {
      error,
      dataSourceName,
      fileName: file.name,
      flag,
    })
    if (
      error instanceof Error &&
      (error.message.includes("already exists") ||
        error.message.includes("not found"))
    ) {
      throw error
    }
    throw new Error(
      `Failed to process file for DataSource "${dataSourceName}". Cause: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    try {
      await unlink(filePath)
      loggerWithChild({email: user.email}).debug(
        `Cleaned up temporary file from DataSource processing: ${filePath}`,
      )
    } catch (cleanupError) {
      loggerWithChild({email: user.email}).error(
        cleanupError,
        `Error cleaning up temporary file from DataSource processing: ${filePath}`,
      )
    }
  }
}

export const ListDataSourcesApi = async (c: Context) => {
  const jwtPayload = c.var.jwtPayload
  if (!jwtPayload || typeof jwtPayload.sub !== "string") {
    Logger.error("JWT payload or sub is missing/invalid in ListDataSourcesApi")
    return c.json(
      {
        error: "Unauthorized",
        message: "User email not found or invalid in token",
      },
      401,
    )
  }
  const email = jwtPayload.sub

  try {
    const vespaResponse = await getDataSourcesByCreator(email)
    const dataSources =
      vespaResponse.root.children?.map(
        (child: VespaSearchResult) => child.fields,
      ) || []
    return c.json(dataSources)
  } catch (error) {
    loggerWithChild({email: email}).error(
      error,
      `Error fetching datasources for user ${email} in ListDataSourcesApi`,
    )
    return c.json(
      {
        error: "Failed to fetch datasources",
        message: "An internal error occurred.",
      },
      500,
    )
  }
}

export const ListDataSourceFilesApi = async (c: Context) => {
  const jwtPayload = c.var.jwtPayload
  const dataSourceName = c.req.param("dataSourceName")
  const email = jwtPayload.sub;

  if (!dataSourceName) {
    loggerWithChild({email: email}).error(
      "dataSourceName path parameter is missing in ListDataSourceFilesApi",
    )
    return c.json(
      { error: "Bad Request", message: "dataSourceName is required." },
      400,
    )
  }

  if (!jwtPayload || typeof jwtPayload.sub !== "string") {
    Logger.error(
      "JWT payload or sub is missing/invalid in ListDataSourceFilesApi",
    )
    return c.json(
      {
        error: "Unauthorized",
        message: "User email not found or invalid in token",
      },
      401,
    )
  }

  try {
    const vespaResponse = await getDataSourceFilesByName(dataSourceName, email)
    const files =
      vespaResponse.root.children?.map(
        (child: VespaSearchResult) => child.fields,
      ) || []
    return c.json(files)
  } catch (error) {
    loggerWithChild({email: email}).error(
      error,
      `Error fetching files for datasource "${dataSourceName}" for user ${email} in ListDataSourceFilesApi`,
    )
    return c.json(
      {
        error: "Failed to fetch files for datasource",
        message: "An internal error occurred.",
      },
      500,
    )
  }
}
