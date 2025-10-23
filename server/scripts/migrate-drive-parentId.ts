// File Processing with parentId enrichment for file.sd schema
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { Apps, fileSchema } from "@xyne/vespa-ts/types"
import { UpdateDocument } from "@/search/vespa"
import { db } from "@/db/client"
import pLimit from "p-limit"
import type { TxnOrClient, GoogleServiceAccount } from "@/types"
import { google } from "googleapis"
import { createJwtClient } from "@/integrations/google/utils"
import { getConnector, getConnectorByExternalId } from "@/db/connector"
import { serviceAccountConnectorId } from "@/scripts/googleConfig"
import { syncJobs } from "@/db/schema"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { sharedVespaService as vespa } from "@/search/vespaService"
import config, { NAMESPACE, CLUSTER } from "@/config"

const logger = getLogger(Subsystem.Api)

// Types
export interface FileEnrichmentStats {
  totalDocuments: number
  documentsUpdated: number
  documentsWithoutOwner: number
  documentsAlreadyHaveParentId: number
  errors: number
  skippedAlreadyProcessed: number
}

export interface FileEnrichmentOptions {
  batchSize?: number
  concurrency?: number
  skipProcessed?: boolean
  clearMapOnStart?: boolean
  initialContinuationToken?: string
}

interface DriveClientCache {
  driveClients: Map<string, any>
}

const userSchema = z.object({ email: z.string() })

// VespaClient with visit functionality
class FileVespaClient {
  private vespaEndpoint: string

  constructor() {
    this.vespaEndpoint = config.vespaEndpoint
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries = 3,
  ): Promise<Response> {
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, options)
        return response
      } catch (error) {
        lastError = error as Error
        logger.warn(`Fetch attempt ${attempt} failed: ${lastError.message}`)

        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000)
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    throw lastError || new Error("Max retries exceeded")
  }

  async visit(options: {
    namespace?: string
    schema?: string
    continuation?: string
    wantedDocumentCount?: number
  }): Promise<{ documents: any[]; continuation?: string }> {
    const {
      namespace = NAMESPACE,
      schema = fileSchema,
      continuation,
      wantedDocumentCount = 100,
    } = options

    const params = new URLSearchParams({
      wantedDocumentCount: wantedDocumentCount.toString(),
      cluster: CLUSTER || "search",
      selection: schema,
      ...(continuation ? { continuation } : {}),
    })

    const url = `${this.vespaEndpoint}/document/v1/${namespace}/${schema}/docid?${params.toString()}`

    try {
      logger.info(`Visiting documents: ${url}`)
      if (continuation) {
        logger.info(`Using continuation token: ${continuation}`)
      }

      const response = await this.fetchWithRetry(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `Visit failed: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }

      const data = await response.json()

      // Log the continuation token for recovery purposes
      if (data.continuation) {
        logger.info(`Received continuation token: ${data.continuation}`)
      } else {
        logger.info(
          "No continuation token received - this might be the last batch",
        )
      }

      return {
        documents: data.documents || [],
        continuation: data.continuation,
      }
    } catch (error) {
      const errMessage = (error as Error).message
      logger.error(error, `Error visiting documents: ${errMessage}`)
      throw new Error(`Error visiting documents: ${errMessage}`)
    }
  }
}

const fileVespaClient = new FileVespaClient()

// Fetch documents with continuation using custom vespa client
export const fetchFileDocumentsWithContinuation = async (
  limit: number = 100,
  continuation?: string,
): Promise<{ documents: any[]; continuation?: string }> => {
  return await fileVespaClient.visit({
    namespace: NAMESPACE,
    schema: fileSchema,
    continuation: continuation,
    wantedDocumentCount: limit,
  })
}

// Database Operations
async function getUsersWithSyncJobs(
  trx: TxnOrClient,
  app: Apps,
): Promise<Set<string>> {
  const jobs = await trx
    .select({ email: syncJobs.email })
    .from(syncJobs)
    .where(eq(syncJobs.app, app))

  const users = z.array(userSchema).parse(jobs)
  return new Set(users.map((user) => user.email))
}

async function getServiceAccountCredentials(): Promise<GoogleServiceAccount> {
  const serviceConnector = await getConnector(db, serviceAccountConnectorId)
  if (!serviceConnector) {
    throw new Error(
      `Service account connector not found: ${serviceAccountConnectorId}`,
    )
  }

  const connector = await getConnectorByExternalId(
    db,
    serviceConnector.externalId,
    serviceConnector.userId,
  )

  if (!connector?.credentials) {
    throw new Error(
      `Credentials not found for connector: ${serviceAccountConnectorId}`,
    )
  }

  return JSON.parse(connector.credentials as string)
}

// Google Drive Client Management
class DriveClientManager {
  private cache: DriveClientCache = {
    driveClients: new Map(),
  }

  async initialize(
    userEmails: Set<string>,
    serviceAccount: GoogleServiceAccount,
  ): Promise<void> {
    logger.info(
      { userCount: userEmails.size },
      "Initializing Google Drive clients",
    )

    for (const email of userEmails) {
      try {
        const jwtClient = createJwtClient(serviceAccount, email)
        const driveClient = google.drive({ version: "v3", auth: jwtClient })

        this.cache.driveClients.set(email, driveClient)
      } catch (error) {
        logger.warn({ email, error }, "Failed to create Drive client for user")
      }
    }

    logger.info(
      {
        clientsCreated: this.cache.driveClients.size,
      },
      "Google Drive clients initialized",
    )
  }

  // Get parent folder information from Google Drive API
  async getFileParentId(
    userEmail: string,
    fileId: string,
  ): Promise<string | null> {
    const driveClient = this.cache.driveClients.get(userEmail)
    if (!driveClient) {
      logger.warn({ userEmail }, "Google Drive client not found")
      return null
    }

    try {
      const response = await driveClient.files.get({
        fileId: fileId,
        fields: "parents",
      })

      const parents = response.data.parents
      if (parents && parents.length > 0) {
        // Return the first parent (files can have multiple parents in Google Drive)
        return parents[0]
      }

      return null
    } catch (error) {
      logger.error(
        { userEmail, fileId, error },
        "Failed to get file parent from Google Drive API",
      )
      return null
    }
  }

  clear(): void {
    this.cache.driveClients.clear()
  }
}

// Main function to process file documents and add parentId
async function processFileParentIdUpdate(
  doc: any,
  validUsers: Set<string>,
  clientManager: DriveClientManager,
): Promise<{
  updated: boolean
  error?: Error
  reason?: string
}> {
  const docId = doc.fields.docId

  try {
    // Skip if document already has parentId
    if (doc.fields.parentId) {
      logger.info({ docId }, "Document already has parentId, skipping")
      return { updated: false, reason: "already_has_parentId" }
    }

    // Get owner email from the document
    const ownerEmail = doc.fields.ownerEmail
    if (!ownerEmail) {
      logger.warn({ docId }, "Document has no owner email, skipping")
      return { updated: false, reason: "no_owner_email" }
    }

    // Check if the owner is in our valid users list
    if (!validUsers.has(ownerEmail)) {
      logger.warn(
        { docId, ownerEmail },
        "Owner not in valid users list, skipping",
      )
      return { updated: false, reason: "owner_not_valid" }
    }

    // Get parentId from Google Drive API
    const parentId = await clientManager.getFileParentId(ownerEmail, docId)

    if (!parentId) {
      logger.warn({ docId, ownerEmail }, "No parent folder found for file")
      return { updated: false, reason: "no_parent_found" }
    }

    // Update document with parentId
    await UpdateDocument(fileSchema, docId, {
      parentId: parentId,
    })

    logger.info(
      {
        docId,
        ownerEmail,
        parentId,
      },
      "Updated document with parentId",
    )

    return { updated: true }
  } catch (error) {
    logger.error({ docId, error }, "Failed to process file parentId update")
    return { updated: false, error: error as Error }
  }
}

// Main Function to Add Parent IDs to File Documents
export async function addParentIdsToFileDocuments(
  app: Apps = Apps.GoogleDrive,
  options: FileEnrichmentOptions = {},
): Promise<FileEnrichmentStats> {
  const {
    batchSize = 100,
    concurrency = 5,
    skipProcessed = true,
    clearMapOnStart = false,
    initialContinuationToken,
  } = options

  logger.info(
    {
      app,
      batchSize,
      concurrency,
      skipProcessed,
      clearMapOnStart,
      initialContinuationToken: initialContinuationToken ? "PROVIDED" : "NONE",
    },
    "Starting file parentId enrichment process",
  )

  if (initialContinuationToken) {
    logger.info("=== RESUMING FROM CONTINUATION TOKEN ===")
    logger.info("Initial continuation token:", initialContinuationToken)
    logger.info("==========================================")
    logger.info(
      { initialContinuationToken },
      "Resuming from provided continuation token",
    )
  }

  const stats: FileEnrichmentStats = {
    totalDocuments: 0,
    documentsUpdated: 0,
    documentsWithoutOwner: 0,
    documentsAlreadyHaveParentId: 0,
    errors: 0,
    skippedAlreadyProcessed: 0,
  }

  const clientManager = new DriveClientManager()
  let continuation: string | undefined = initialContinuationToken

  try {
    // Setup
    const [serviceAccount, validUsers] = await Promise.all([
      getServiceAccountCredentials(),
      getUsersWithSyncJobs(db, app),
    ])

    await clientManager.initialize(validUsers, serviceAccount)

    const processLimit = pLimit(concurrency)
    let batchCounter = 0

    // Process in batches using vespa.visit
    do {
      batchCounter++
      const batchId = `batch-${batchCounter}-${Date.now()}`

      logger.info(`=== BATCH ${batchCounter} CONTINUATION TOKEN ===`)
      logger.info("Current continuation token:", continuation || "NONE")
      logger.info("=========================================")

      const { documents, continuation: nextContinuation } =
        await fetchFileDocumentsWithContinuation(batchSize, continuation)

      logger.info(`=== BATCH ${batchCounter} NEXT CONTINUATION TOKEN ===`)
      logger.info("Next continuation token:", nextContinuation || "NONE")
      logger.info("===============================================")

      continuation = nextContinuation

      if (documents.length === 0) break

      // Filter out documents that already have parentId
      const documentsToProcess = skipProcessed
        ? documents.filter((doc) => {
            const hasParentId = doc?.fields?.parentId

            if (hasParentId) stats.documentsAlreadyHaveParentId++

            return !hasParentId
          })
        : documents

      stats.totalDocuments += documentsToProcess.length

      if (documentsToProcess.length === 0) {
        logger.info(
          {
            batchId,
            totalDocuments: documents.length,
            skipped: documents.length,
          },
          "All documents in batch already processed, skipping",
        )
        continue
      }

      logger.info(
        {
          batchId,
          totalDocuments: documents.length,
          processingDocuments: documentsToProcess.length,
          skipped: documents.length - documentsToProcess.length,
          continuationToken: continuation ? "HAS_TOKEN" : "NO_TOKEN",
        },
        "Processing batch",
      )

      // Process documents concurrently
      const results = await Promise.allSettled(
        documentsToProcess.map((doc: any) =>
          processLimit(() =>
            processFileParentIdUpdate(doc, validUsers, clientManager),
          ),
        ),
      )

      // Update statistics
      results.forEach((result) => {
        if (result.status === "fulfilled") {
          const { updated, error, reason } = result.value
          if (updated) {
            stats.documentsUpdated++
          } else if (reason === "no_owner_email") {
            stats.documentsWithoutOwner++
          }
          if (error) stats.errors++
        } else {
          stats.errors++
          logger.error(result.reason, "Processing failed")
        }
      })

      logger.info(
        {
          batchId,
          processed: documentsToProcess.length,
          ...stats,
        },
        "Batch completed",
      )

      if (continuation) {
        logger.info(`=== BATCH ${batchCounter} COMPLETED - SAVE THIS TOKEN ===`)
        logger.info("Continuation token for next run:", continuation)
        logger.info("=================================================")
      }
    } while (continuation)

    logger.info(
      {
        ...stats,
      },
      "File parentId enrichment completed",
    )

    return stats
  } catch (error) {
    logger.info("=== ERROR OCCURRED - SAVE THIS TOKEN FOR RECOVERY ===")
    logger.info("Last continuation token:", continuation || "NONE")
    logger.info("====================================================")

    logger.error(
      { error, lastContinuationToken: continuation },
      "Fatal error during file parentId enrichment",
    )
    throw error
  } finally {
    clientManager.clear()
  }
}

// Single entry point function
export async function runFileParentIdMigration(
  continuationToken?: string,
): Promise<void> {
  logger.info(
    continuationToken
      ? `Resuming file parentId enrichment from token: ${continuationToken}`
      : "Starting file parentId enrichment from the beginning",
  )

  const stats = await addParentIdsToFileDocuments(Apps.GoogleDrive, {
    batchSize: 100,
    concurrency: 4,
    skipProcessed: true,
    clearMapOnStart: false,
    initialContinuationToken: continuationToken,
  })

  logger.info("File parentId enrichment completed:", stats)
  logger.info("Documents updated:", stats.documentsUpdated)
}

// Run the migration if this file is executed directly
if (require.main === module) {
  runFileParentIdMigration()
    .then(() => {
      logger.info("File parentId migration completed successfully")
      process.exit(0)
    })
    .catch((error) => {
      logger.error({ error }, "File parentId migration failed")
      process.exit(1)
    })
}
