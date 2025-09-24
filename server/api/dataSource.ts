import { randomUUID } from "crypto"
import { createId } from "@paralleldrive/cuid2"
import { mkdir, unlink } from "node:fs/promises"
import fs from "node:fs"
import path, { join } from "node:path"
import {
  insertDataSource,
  getDataSourceByNameAndCreator,
  fetchAllDataSourceFilesByName,
  getDataSourcesByCreator,
  GetDocument,
  getDocumentOrNull,
} from "@/search/vespa"
import { handleDataSourceFileUpload } from "@/integrations/dataSource"
import {
  type VespaDataSource,
  type VespaSearchResult,
  type VespaDataSourceFile,
  datasourceSchema,
  dataSourceFileSchema,
} from "@xyne/vespa-ts/types"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { type SelectUser } from "@/db/schema"
import { z } from "zod"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { UserRole } from "@/shared/types"
import { DeleteDocument } from "@/search/vespa"
import type { VespaSchema } from "@xyne/vespa-ts/types"
import config from "@/config"
import { getErrorMessage } from "@/utils"
import { isDataSourceError } from "@/integrations/dataSource/errors"
import {
  removeAppIntegrationFromAllAgents,
  getAgentsByDataSourceId,
} from "@/db/agent"
import { db } from "@/db/client"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { checkUserAgentAccessByExternalId } from "@/db/userAgentPermission"

const loggerWithChild = getLoggerWithChild(Subsystem.Api, {
  module: "dataSourceService",
})
const { JwtPayloadKey } = config
const DOWNLOADS_DIR_DATASOURCE = join(
  process.cwd(),
  "downloads",
  "datasources_temp_for_processing",
)
;(async () => {
  try {
    await mkdir(DOWNLOADS_DIR_DATASOURCE, { recursive: true })
    loggerWithChild().info(
      `DataSource processing temp directory ensured: ${DOWNLOADS_DIR_DATASOURCE}`,
    )
  } catch (error) {
    loggerWithChild().error(
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

  loggerWithChild({ email: user.email }).debug(
    `Processing file for DataSource: "${dataSourceName}", operation: ${flag}, file: "${file.name}", user: ${user.email}`,
  )

  const tempFileName = `${Date.now()}_${randomUUID()}_${file.name}`
  const filePath = join(DOWNLOADS_DIR_DATASOURCE, tempFileName)

  let existingDataSource: VespaDataSource | null = null
  let dataSourceVespaId: string

  try {
    await Bun.write(filePath, file)
    loggerWithChild({ email: user.email }).debug(
      `File temporarily saved for DataSource processing: ${filePath}`,
    )

    const now = Date.now()

    if (flag === "creation") {
      existingDataSource = await getDataSourceByNameAndCreator(
        dataSourceName,
        user.email,
      )
      if (existingDataSource) {
        loggerWithChild({ email: user.email }).warn(
          `Data source named "${dataSourceName}" already exists for user ${user.email}. Proceeding to add file to this existing data source.`,
        )
        dataSourceVespaId = existingDataSource.docId
      } else {
        loggerWithChild({ email: user.email }).debug(
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
        loggerWithChild({ email: user.email }).debug(
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
        loggerWithChild({ email: user.email }).warn(
          `Attempt to add file to non-existent DataSource: "${dataSourceName}" for user ${user.email}`,
        )
        throw new Error(
          `Data source named "${dataSourceName}" not found for adding files.`,
        )
      }
      loggerWithChild({ email: user.email }).debug(
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
    loggerWithChild({ email: user.email }).error(
      "Error during DataSource file processing:",
      {
        error,
        dataSourceName,
        fileName: file.name,
        flag,
      },
    )
    if (isDataSourceError(error)) {
      // Preserve DataSourceError so UI can display error.userMessage
      throw error
    }
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
      loggerWithChild({ email: user.email }).debug(
        `Cleaned up temporary file from DataSource processing: ${filePath}`,
      )
    } catch (cleanupError) {
      loggerWithChild({ email: user.email }).error(
        cleanupError,
        `Error cleaning up temporary file from DataSource processing: ${filePath}`,
      )
    }
  }
}

export const deleteDocumentSchema = z.object({
  docId: z.string().min(1),
  schema: z.string().min(1),
})

export const DeleteImages = async (docId: string) => {
  const imageDir = path.resolve(
    process.env.IMAGE_DIR || "downloads/xyne_images_db",
  )
  const dirPath = path.join(imageDir, docId)

  try {
    await fs.promises.rm(dirPath, { recursive: true, force: true })
    loggerWithChild().debug(`Successfully deleted image directory: ${dirPath}`)
  } catch (error) {
    // Only log as warning if file doesn't exist, error for other issues
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      loggerWithChild().debug(
        `Image directory not found (already deleted?): ${dirPath}`,
      )
    } else {
      loggerWithChild().error(
        error,
        `Failed to delete image directory: ${dirPath}`,
      )
      throw error
    }
  }
}

export const DeleteDocumentApi = async (c: Context) => {
  try {
    const { sub: userEmail } = c.get(JwtPayloadKey)

    const rawData = await c.req.json()
    const validatedData = deleteDocumentSchema.parse(rawData)
    const { docId, schema: rawSchema } = validatedData
    const validSchemas = [datasourceSchema, dataSourceFileSchema]
    if (!validSchemas.includes(rawSchema)) {
      throw new HTTPException(400, {
        message: `Invalid schema type. Expected 'datasource' or 'datasourceFile', got '${rawSchema}'`,
      })
    }
    const schema = rawSchema as VespaSchema

    const documentData = await GetDocument(schema, docId)

    if (!documentData || !("fields" in documentData) || !documentData.fields) {
      loggerWithChild({ email: userEmail }).warn(
        `Document not found or fields missing for docId: ${docId}, schema: ${schema} during delete operation by ${userEmail}`,
      )
      throw new HTTPException(404, { message: "Document not found." })
    }

    const fields = documentData.fields as Record<string, any>
    let ownerEmail: string

    if (schema === datasourceSchema) {
      ownerEmail = fields.createdBy as string
    } else if (schema === dataSourceFileSchema) {
      ownerEmail = fields.uploadedBy as string
    } else {
      loggerWithChild({ email: userEmail }).error(
        `Unsupported schema type for document deletion: ${schema}. Only dataSource and dataSourceFile schemas are supported.`,
      )
      throw new HTTPException(400, {
        message: "Unsupported schema type for document deletion.",
      })
    }

    if (!ownerEmail) {
      loggerWithChild({ email: userEmail }).error(
        `Ownership field (createdBy/uploadedBy) missing for document ${docId} of schema ${schema}. Cannot verify ownership for user ${userEmail}.`,
      )
      throw new HTTPException(500, {
        message:
          "Internal server error: Cannot verify document ownership due to missing data.",
      })
    }
    if (ownerEmail !== userEmail) {
      loggerWithChild({ email: userEmail }).warn(
        `User ${userEmail} attempt to delete document ${docId} (schema: ${schema}) owned by ${ownerEmail}. Access denied.`,
      )
      throw new HTTPException(403, {
        message:
          "Forbidden: You do not have permission to delete this document.",
      })
    }
    loggerWithChild({ email: userEmail }).info(
      `User ${userEmail} authorized to delete document ${docId} (schema: ${schema}) owned by ${ownerEmail}.`,
    )

    //
    if (schema === datasourceSchema) {
      const dataSourceName = fields.name as string
      if (!dataSourceName) {
        loggerWithChild({ email: userEmail }).error(
          `DataSource name not found for docId: ${docId}`,
        )
        throw new HTTPException(500, {
          message: "Internal Server Error: DataSource name missing.",
        })
      }
      let hasMore = true
      while (hasMore) {
        const filesResponse = await fetchAllDataSourceFilesByName(
          dataSourceName,
          userEmail,
        )
        if (!filesResponse) {
          hasMore = false
          break
        }
        const filesToDelete: VespaDataSourceFile[] = filesResponse.map(
          (child: VespaSearchResult) => child.fields as VespaDataSourceFile,
        )

        loggerWithChild({ email: userEmail }).info(
          `Found ${filesToDelete.length} files to delete for datasource ${dataSourceName}`,
        )
        if (filesToDelete.length === 0) {
          hasMore = false
          break
        }
        await Promise.all(
          filesToDelete.map((file: VespaDataSourceFile) => {
            if (file.docId) {
              loggerWithChild({ email: userEmail }).info(
                `Queueing deletion for file: ${file.fileName} (${file.docId})`,
              )
              return Promise.all([
                DeleteImages(file.docId),
                DeleteDocument(file.docId, dataSourceFileSchema),
              ])
            }
            return Promise.resolve()
          }),
        )
        loggerWithChild({ email: userEmail }).info(
          `All files associated with datasource ${dataSourceName} have been deleted.`,
        )
      }
      loggerWithChild({ email: userEmail }).info(
        `Deleting files for datasource: ${dataSourceName} (${docId})`,
      )
      await removeAppIntegrationFromAllAgents(db, docId)
      loggerWithChild({ email: userEmail }).info(
        `Removed datasource integration ${docId} from all agents if it existed.`,
      )
    }

    // Also delete images for individual file deletions
    if (schema === dataSourceFileSchema) {
      await DeleteImages(docId)
    }

    await DeleteDocument(docId, schema)
    loggerWithChild({ email: userEmail }).info(
      `Successfully deleted document ${docId} with schema ${schema}`,
    )
    return c.json({ success: true })
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessage = JSON.stringify(error)
      loggerWithChild().warn(
        `Validation error in DeleteDocumentApi: ${errorMessage}`,
      )
      throw new HTTPException(400, {
        message: `Invalid request data: ${errorMessage}`,
      })
    }

    if (error instanceof HTTPException) {
      const causeMessage =
        error.cause instanceof Error ? error.cause.message : String(error.cause)
      loggerWithChild().warn(
        `HTTPException in DeleteDocumentApi: ${error.status} ${error.message}${error.cause ? ` - Cause: ${causeMessage}` : ""}`,
      )
      throw error
    }

    const errMsg = getErrorMessage(error)
    loggerWithChild().error(
      error,
      `Delete Document Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not delete document due to an internal server error.",
    })
  }
}

export const GetAgentsForDataSourceApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const dataSourceId = c.req.param("dataSourceId")

  if (!dataSourceId) {
    throw new HTTPException(400, { message: "Data source ID is required." })
  }

  try {
    const agents = await getAgentsByDataSourceId(db, dataSourceId)
    return c.json(agents)
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({
      email: userEmail,
    }).error(
      error,
      `Failed to get agents for data source ${dataSourceId}: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to retrieve agents for the data source.",
    })
  }
}

export const ListDataSourcesApi = async (c: Context) => {
  const jwtPayload = c.var.jwtPayload
  if (!jwtPayload || typeof jwtPayload.sub !== "string") {
    loggerWithChild().error(
      "JWT payload or sub is missing/invalid in ListDataSourcesApi",
    )
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
    loggerWithChild({ email: email }).error(
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
  const email = jwtPayload.sub ?? ""

  if (!dataSourceName) {
    loggerWithChild({ email: email }).error(
      "dataSourceName path parameter is missing in ListDataSourceFilesApi",
    )
    return c.json(
      { error: "Bad Request", message: "dataSourceName is required." },
      400,
    )
  }

  if (!jwtPayload || typeof jwtPayload.sub !== "string") {
    loggerWithChild().error(
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
    const vespaResponse = await fetchAllDataSourceFilesByName(
      dataSourceName,
      email,
    )
    if (!vespaResponse) {
      return c.json([])
    }
    const files = vespaResponse.map((child: VespaSearchResult) => child.fields)
    return c.json(files)
  } catch (error) {
    loggerWithChild({ email: email }).error(
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

export const GetDataSourceFile = async (c: Context) => {
  const jwtPayload = c.var.jwtPayload
  const docId = c.req.param("docId")
  const email = jwtPayload.sub ?? ""

  if (!docId) {
    loggerWithChild({ email: email }).error(
      "docId path parameter is missing in GetDataSourceFile",
    )
    return c.json({ error: "Bad Request", message: "docId is required." }, 400)
  }

  if (!jwtPayload || typeof jwtPayload.sub !== "string") {
    loggerWithChild().error(
      "JWT payload or sub is missing/invalid in GetDataSourceFile",
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
    const vespaResponse = await getDocumentOrNull(dataSourceFileSchema, docId)

    if (!vespaResponse || !vespaResponse.fields) {
      loggerWithChild({ email: email }).warn(
        `Data source file not found: ${docId}`,
      )
      return c.json(
        { error: "Not Found", message: "Data source file not found." },
        404,
      )
    }

    const dataSourceFile = vespaResponse.fields as VespaDataSourceFile
    const dataSourceRefId = dataSourceFile.dataSourceRef.split("::").pop()
    const uploadedBy = dataSourceFile.uploadedBy

    // Combine and sort chunks and image_chunks by their respective positions
    const {
      chunks = [],
      image_chunks = [],
      chunks_pos = [],
      image_chunks_pos = [],
    } = dataSourceFile

    const combinedChunks: {
      content: string
      type: "text" | "image"
      pos: number
    }[] = [
      ...chunks.map((content, i) => ({
        content,
        type: "text" as const,
        pos: chunks_pos[i] ?? i,
      })),
      ...image_chunks.map((content, i) => ({
        content,
        type: "image" as const,
        pos: image_chunks_pos[i] ?? i,
      })),
    ].sort((a, b) => a.pos - b.pos)

    // Update vespaResponse.fields.chunks based on presence of chunks
    if (
      "chunks" in vespaResponse.fields &&
      Array.isArray(vespaResponse.fields.chunks)
    ) {
      vespaResponse.fields.chunks = combinedChunks.map((chunk) => chunk.content)
    } else if (
      "image_chunks" in vespaResponse.fields &&
      Array.isArray(vespaResponse.fields.image_chunks)
    ) {
      vespaResponse.fields.chunks = vespaResponse.fields.image_chunks
      delete vespaResponse.fields.image_chunks
    }

    // if user is the original uploader
    if (uploadedBy === email) {
      loggerWithChild({ email: email }).info(
        `User ${email} is the original uploader of data source file ${docId}`,
      )
      return c.json(vespaResponse)
    }

    const workspaceExternalId = jwtPayload.workspaceId
    const userWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceExternalId,
      email,
    )
    const userId = userWorkspace.user.id
    const workspaceId = userWorkspace.workspace.id

    const agentsWithDataSource = await getAgentsByDataSourceId(
      db,
      dataSourceRefId as string,
    )

    if (!agentsWithDataSource || agentsWithDataSource.length === 0) {
      loggerWithChild({ email: email }).warn(
        `No agents found using data source ${dataSourceRefId} for file ${docId}`,
      )
      return c.json(
        {
          error: "Forbidden",
          message: "Access denied to this data source file.",
        },
        403,
      )
    }

    // if user has access to any of the agents that use this data source
    let hasAccess = false
    for (const agent of agentsWithDataSource) {
      const permission = await checkUserAgentAccessByExternalId(
        db,
        userId,
        agent.externalId,
        workspaceId,
      )

      if (permission) {
        hasAccess = true
        loggerWithChild({ email: email }).info(
          `User ${email} has access to data source file ${docId} via agent ${agent.externalId}`,
        )
        break
      }
    }

    if (!hasAccess) {
      loggerWithChild({ email: email }).warn(
        `User ${email} does not have access to any agents using data source ${dataSourceRefId}`,
      )
      return c.json(
        {
          error: "Forbidden",
          message: "Access denied to this data source file.",
        },
        403,
      )
    }

    return c.json(vespaResponse)
  } catch (error) {
    loggerWithChild({ email: email }).error(
      error,
      `Error fetching data source file "${docId}" for user ${email} in GetDataSourceFile`,
    )
    return c.json(
      {
        error: "Failed to fetch data source file",
        message: "An internal error occurred.",
      },
      500,
    )
  }
}
