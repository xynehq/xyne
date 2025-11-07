// Document Processing with threadId-based approach
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { UpdateDocument } from "@/search/vespa"
import { db } from "@/db/client"
import pLimit from "p-limit"
import type { TxnOrClient, GoogleServiceAccount } from "@/types"
import { google } from "googleapis"
import { createJwtClient } from "@/integrations/google/utils"
import { getConnector, getConnectorByExternalId } from "@/db/connector"
import { serviceAccountConnectorId } from "./googleConfig"
import { syncJobs } from "../db/schema"
import { eq } from "drizzle-orm"
import { z } from "zod"
import config from "@/config"
import { Apps, mailSchema } from "@xyne/vespa-ts"
import vespa from "@/search/vespa" // Import the default vespa service

const logger = getLogger(Subsystem.Api)

export const NAMESPACE = "namespace" // Replace with your actual namespace

// Global map to track processed mailIds
const processedMailIds = new Map<string, boolean>()

// Helper functions for global map management
export function getProcessedMailIds(): Map<string, boolean> {
  return processedMailIds
}

export function clearProcessedMailIds(): void {
  processedMailIds.clear()
  logger.info("Cleared processed mailIds map")
}

export function addProcessedMailId(mailId: string): void {
  processedMailIds.set(mailId, true)
}

export function isMailIdProcessed(mailId: string): boolean {
  return processedMailIds.get(mailId) === true
}

// Vespa Visit Types
export interface VisitOptions {
  namespace: string
  schema: any // VespaSchema type
  continuation?: string
  wantedDocumentCount?: number
  fieldSet?: string
  concurrency?: number
  cluster?: string
}

export interface VisitResponse {
  documents: any[] // VespaGetResult[]
  continuation?: string
  documentCount: number
}

// Types
export interface EnrichmentStats {
  totalDocuments: number
  documentsUpdated: number
  threadsProcessed: number
  rootMessages: number
  errors: number
  skippedAlreadyProcessed: number
}

export interface EnrichmentOptions {
  batchSize?: number
  concurrency?: number
  skipProcessed?: boolean
  clearMapOnStart?: boolean
  initialContinuationToken?: string // NEW: Allow starting from a specific continuation token
}

interface ClientCache {
  jwtClients: Map<string, any>
  gmailClients: Map<string, any>
}

const userSchema = z.object({ email: z.string() })

// Implement visit function for Vespa
export async function visit(options: VisitOptions): Promise<VisitResponse> {
  const {
    namespace,
    schema,
    continuation,
    wantedDocumentCount = 50,
    fieldSet = `${schema}:*`,
    concurrency = 1,
    cluster = "my_content",
  } = options

  const params = new URLSearchParams({
    wantedDocumentCount: wantedDocumentCount.toString(),
    cluster: cluster,
    selection: schema,
    ...(continuation ? { continuation } : {}),
  })

  const url = `${config.vespaEndpoint}/document/v1/${namespace}/${schema}/docid?${params.toString()}`

  try {
    const response = await fetch(url, {
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
    return {
      documents: data.documents || [],
      continuation: data.continuation,
      documentCount: data.documentCount || 0,
    }
  } catch (error) {
    const errMessage = (error as Error).message
    logger.error(error, `Error visiting documents: ${errMessage}`)
    throw new Error(`Error visiting documents: ${errMessage}`)
  }
}

// Fetch documents with continuation using vespa.visit
export const fetchDocumentsWithContinuation = async (
  limit: number = 100,
  continuation?: string,
): Promise<{ documents: any[]; continuation?: string }> => {
  const resp = await visit({
    namespace: NAMESPACE,
    schema: mailSchema,
    continuation: continuation,
    wantedDocumentCount: limit,
  })

  const documents = Array.isArray(resp.documents) ? resp.documents : []
  const nextContinuation = resp.continuation

  return {
    documents,
    continuation: nextContinuation,
  }
}

// Direct GET request to fetch document by mailId via search API
export const getDocByMailId = async (mailId: string): Promise<any | null> => {
  const url = `${config.vespaEndpoint}/search/?yql=select * from ${mailSchema} where mailId contains "${mailId}"`

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(
        `Search failed: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    const data = await response.json()

    if (data.root && data.root.children && data.root.children.length > 0) {
      return data.root.children[0]
    }

    return null
  } catch (error) {
    const errMessage = (error as Error).message
    logger.error(error, `Error fetching document by mailId: ${errMessage}`)
    throw new Error(`Error fetching document by mailId: ${errMessage}`)
  }
}

// Fetch documents from Vespa by mailId
export const fetchDocumentByMailId = async (
  mailId: string,
): Promise<any | null> => {
  try {
    return await getDocByMailId(mailId)
  } catch (error) {
    logger.error({ mailId, error }, "Failed to fetch document by mailId")
    return null
  }
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

// Client Management
class GmailClientManager {
  private cache: ClientCache = {
    jwtClients: new Map(),
    gmailClients: new Map(),
  }

  // Helper function to normalize messageId
  private normalizeMessageId(messageId: string): string {
    return messageId.replace(/^<|>$/g, "")
  }

  async initialize(
    userEmails: Set<string>,
    serviceAccount: GoogleServiceAccount,
  ): Promise<void> {
    logger.info({ userCount: userEmails.size }, "Initializing Gmail clients")

    for (const email of userEmails) {
      try {
        const jwtClient = createJwtClient(serviceAccount, email)
        const gmailClient = google.gmail({ version: "v1", auth: jwtClient })

        this.cache.jwtClients.set(email, jwtClient)
        this.cache.gmailClients.set(email, gmailClient)
      } catch (error) {
        logger.warn({ email, error }, "Failed to create client for user")
      }
    }

    logger.info(
      {
        clientsCreated: this.cache.gmailClients.size,
      },
      "Gmail clients initialized",
    )
  }

  // Get threadId from a message
  async getThreadIdFromMessage(
    userEmail: string,
    messageId: string,
  ): Promise<string | null> {
    const gmail = this.cache.gmailClients.get(userEmail)
    if (!gmail) {
      logger.warn({ userEmail }, "Gmail client not found")
      return null
    }

    try {
      const normalizedId =
        messageId.startsWith("<") && messageId.endsWith(">")
          ? messageId
          : `<${messageId}>`
      const response = await gmail.users.messages.list({
        userId: "me",
        includeSpamTrash: false,
        q: `rfc822msgid:${normalizedId}`,
        fields: "messages(id,threadId)",
        maxResults: 1,
      })
      const messages = response.data.messages

      if (!messages?.length) {
        return null
      }
      return messages[0].threadId || null
    } catch (error) {
      logger.error(
        { userEmail, messageId, error },
        "Failed to get threadId from message",
      )
      return null
    }
  }

  // OPTIMIZED: Single call to get all thread data we need
  async getThreadData(
    userEmail: string,
    threadId: string,
  ): Promise<{
    allMessages: Array<{ messageId: string; gmailId: string }>
    rootMessageId: string | null
  } | null> {
    const gmail = this.cache.gmailClients.get(userEmail)
    if (!gmail) {
      logger.warn({ userEmail }, "Gmail client not found")
      return null
    }

    try {
      // Single API call to get all the data we need
      const response = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "metadata",
        metadataHeaders: ["Message-ID", "In-Reply-To", "References"],
      })

      const messages = response.data.messages || []
      const allMessages: Array<{ messageId: string; gmailId: string }> = []
      let rootMessageId: string | null = null

      // Process all messages in one pass
      for (const message of messages) {
        const headers = message.payload?.headers || []
        const messageIdHeader = headers.find(
          (h: any) => h.name === "Message-ID",
        )
        const inReplyToHeader = headers.find(
          (h: any) => h.name === "In-Reply-To",
        )
        const referencesHeader = headers.find(
          (h: any) => h.name === "References",
        )

        // Add to allMessages array with normalized messageId
        if (messageIdHeader?.value && message.id) {
          allMessages.push({
            messageId: this.normalizeMessageId(messageIdHeader.value),
            gmailId: message.id,
          })
        }

        // Find root message (no In-Reply-To and no References)
        if (
          !rootMessageId &&
          !inReplyToHeader?.value &&
          !referencesHeader?.value &&
          messageIdHeader?.value
        ) {
          rootMessageId = this.normalizeMessageId(messageIdHeader.value)
        }
      }

      // If no clear root found, use the first message's ID
      if (!rootMessageId && messages.length > 0) {
        const headers = messages[0].payload?.headers || []
        const messageIdHeader = headers.find(
          (h: any) => h.name === "Message-ID",
        )
        rootMessageId = messageIdHeader?.value
          ? this.normalizeMessageId(messageIdHeader.value)
          : null
      }

      return {
        allMessages,
        rootMessageId,
      }
    } catch (error) {
      logger.error({ userEmail, threadId, error }, "Failed to get thread data")
      return null
    }
  }

  clear(): void {
    this.cache.jwtClients.clear()
    this.cache.gmailClients.clear()
  }
}

// OPTIMIZED: Main function to process thread-based updates
async function processThreadBasedUpdates(
  doc: any,
  validUsers: Set<string>,
  clientManager: GmailClientManager,
): Promise<{
  updated: boolean
  error?: Error
  messagesProcessed: number
  threadId?: string
}> {
  const mailId = doc.fields.mailId
  let messagesProcessed = 0

  try {
    // Skip if document already has parentThreadId
    if (doc.fields.parentThreadId) {
      logger.info({ mailId }, "Document already has parentThreadId, skipping")
      return { updated: false, messagesProcessed: 0 }
    }

    // Get permissions from the document
    const permissions = doc.fields.permissions || []
    const eligibleUsers = permissions.filter((user: string) =>
      validUsers.has(user),
    )

    if (eligibleUsers.length === 0) {
      logger.warn({ mailId }, "No eligible users found")
      return { updated: false, messagesProcessed: 0 }
    }

    // OPTIMIZED: Use first eligible user directly (any will work since they're all valid)
    const primaryUser = eligibleUsers[0]

    // Get threadId from the current message
    const threadId = await clientManager.getThreadIdFromMessage(
      primaryUser,
      mailId,
    )

    if (!threadId) {
      logger.warn({ mailId }, "No threadId found for message")
      return { updated: false, messagesProcessed: 0 }
    }

    // Check if we've already processed this mailId
    if (isMailIdProcessed(mailId)) {
      logger.info({ mailId, threadId }, "MailId already processed, skipping")
      return { updated: false, messagesProcessed: 0 }
    }

    // OPTIMIZED: Single call to get all thread data using the same user
    const threadData = await clientManager.getThreadData(primaryUser, threadId)

    if (!threadData || threadData.allMessages.length === 0) {
      logger.warn({ mailId, threadId }, "No messages found in thread")
      return { updated: false, messagesProcessed: 0 }
    }

    const { allMessages, rootMessageId } = threadData

    // Check if ANY message in this thread has already been processed
    const hasProcessedMessage = allMessages.some((message) =>
      isMailIdProcessed(message.messageId),
    )

    if (hasProcessedMessage) {
      logger.info(
        {
          mailId,
          threadId,
          totalMessages: allMessages.length,
        },
        "Thread already processed (found processed message), skipping entire thread",
      )

      // Mark ALL messages in this thread as processed to avoid future checks
      allMessages.forEach((message) => {
        addProcessedMailId(message.messageId)
      })

      return { updated: false, messagesProcessed: 0 }
    }

    if (!rootMessageId) {
      logger.warn({ mailId, threadId }, "No root message ID found")
      return { updated: false, messagesProcessed: 0 }
    }

    logger.info(
      {
        mailId,
        threadId,
        rootMessageId,
        totalMessages: allMessages.length,
      },
      "Found thread with messages, processing entire thread",
    )

    // Process each message in the thread
    const updatePromises = allMessages.map(async (message) => {
      try {
        const messageDoc = await fetchDocumentByMailId(message.messageId)

        if (!messageDoc) {
          logger.warn(
            { messageId: message.messageId },
            "Document not found in Vespa",
          )
          return false
        }

        // Update document with parentThreadId
        await UpdateDocument(mailSchema, messageDoc.fields.docId, {
          parentThreadId: rootMessageId,
        })

        logger.info(
          {
            messageId: message.messageId,
            docId: messageDoc.fields.docId,
            parentThreadId: rootMessageId,
          },
          "Updated document with parentThreadId",
        )

        messagesProcessed++
        return true
      } catch (error) {
        logger.error(
          { messageId: message.messageId, error },
          "Failed to update document",
        )
        return false
      }
    })

    // Wait for all updates to complete
    const results = await Promise.allSettled(updatePromises)
    const successCount = results.filter(
      (result) => result.status === "fulfilled" && result.value === true,
    ).length

    // Mark ALL messages in the thread as processed
    allMessages.forEach((message) => {
      addProcessedMailId(message.messageId)
    })

    logger.info(
      {
        threadId,
        totalMessages: allMessages.length,
        successfulUpdates: successCount,
        rootMessageId,
        markedAsProcessed: allMessages.length,
      },
      "Thread processing completed - all messages marked as processed",
    )

    return {
      updated: successCount > 0,
      messagesProcessed: successCount,
      threadId,
    }
  } catch (error) {
    logger.error({ mailId, error }, "Failed to process thread-based updates")
    return { updated: false, error: error as Error, messagesProcessed: 0 }
  }
}

// Main Function to Add Parent Thread IDs using thread-based approach
export async function addParentThreadIdsToDocuments(
  app: Apps = Apps.Gmail,
  options: EnrichmentOptions = {},
): Promise<EnrichmentStats> {
  const {
    batchSize = 100,
    concurrency = 5,
    skipProcessed = true,
    clearMapOnStart = false,
    initialContinuationToken, // NEW: Accept initial continuation token
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
    "Starting thread-based parentThreadId enrichment process",
  )

  // NEW: Log the initial continuation token if provided
  if (initialContinuationToken) {
    logger.info("=== RESUMING FROM CONTINUATION TOKEN ===")
    logger.info("Initial continuation token:", initialContinuationToken)
    logger.info("==========================================")
    logger.info(
      { initialContinuationToken },
      "Resuming from provided continuation token",
    )
  }

  if (clearMapOnStart) {
    clearProcessedMailIds()
  }

  const stats: EnrichmentStats = {
    totalDocuments: 0,
    documentsUpdated: 0,
    threadsProcessed: 0,
    rootMessages: 0,
    errors: 0,
    skippedAlreadyProcessed: 0,
  }

  const clientManager = new GmailClientManager()

  try {
    // Setup
    const [serviceAccount, validUsers] = await Promise.all([
      getServiceAccountCredentials(),
      getUsersWithSyncJobs(db, app),
    ])

    await clientManager.initialize(validUsers, serviceAccount)

    const processLimit = pLimit(concurrency)
    let continuation: string | undefined = initialContinuationToken // NEW: Start with provided token
    let batchCounter = 0

    // Process in batches using vespa.visit
    do {
      batchCounter++
      const batchId = `batch-${batchCounter}-${Date.now()}`

      // NEW: Log current continuation token at the start of each batch
      logger.info(`=== BATCH ${batchCounter} CONTINUATION TOKEN ===`)
      logger.info("Current continuation token:", continuation || "NONE")
      logger.info("=========================================")

      const { documents, continuation: nextContinuation } =
        await fetchDocumentsWithContinuation(batchSize, continuation)

      // NEW: Log the next continuation token received
      logger.info(`=== BATCH ${batchCounter} NEXT CONTINUATION TOKEN ===`)
      logger.info("Next continuation token:", nextContinuation || "NONE")
      logger.info("===============================================")

      continuation = nextContinuation

      if (documents.length === 0) break

      // Filter out documents that already have parentThreadId or are already processed
      const documentsToProcess = skipProcessed
        ? documents.filter((doc) => {
            const hasParentThreadId = doc?.fields?.parentThreadId
            const isAlreadyProcessed =
              doc?.fields?.mailId && isMailIdProcessed(doc.fields.mailId)
            return !hasParentThreadId && !isAlreadyProcessed
          })
        : documents

      stats.skippedAlreadyProcessed +=
        documents.length - documentsToProcess.length
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
            processThreadBasedUpdates(doc, validUsers, clientManager),
          ),
        ),
      )

      // Update statistics
      results.forEach((result) => {
        if (result.status === "fulfilled") {
          const { updated, error, messagesProcessed, threadId } = result.value
          if (updated) {
            stats.documentsUpdated += messagesProcessed
            if (threadId) {
              stats.threadsProcessed++
            }
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

      // NEW: Log continuation token after batch completion
      if (continuation) {
        logger.info(`=== BATCH ${batchCounter} COMPLETED - SAVE THIS TOKEN ===`)
        logger.info("Continuation token for next run:", continuation)
        logger.info("=================================================")
      }
    } while (continuation)

    logger.info(
      {
        ...stats,
        totalProcessedMailIds: processedMailIds.size,
      },
      "Thread-based parentThreadId enrichment completed",
    )

    return stats
  } catch (error) {
    // NEW: Log current continuation token on error for recovery
    logger.info("=== ERROR OCCURRED - SAVE THIS TOKEN FOR RECOVERY ===")
    logger.info("Last continuation token:", "NONE")
    logger.info("====================================================")

    logger.error(
      { error, lastContinuationToken: "" },
      "Fatal error during thread-based parentThreadId enrichment",
    )
    throw error
  } finally {
    clientManager.clear()
  }
}

// Single entry point function
export async function runMigration(continuationToken?: string): Promise<void> {
  logger.info(
    continuationToken
      ? `Resuming enrichment from token: ${continuationToken}`
      : "Starting enrichment from the beginning",
  )

  const stats = await addParentThreadIdsToDocuments(Apps.Gmail, {
    batchSize: 100,
    concurrency: 4,
    skipProcessed: true,
    clearMapOnStart: false,
    initialContinuationToken: continuationToken,
  })

  logger.info("Thread-based parentThreadId enrichment completed:", stats)
  logger.info("Total processed mailIds:", processedMailIds.size)
  logger.info("Documents updated:", stats.documentsUpdated)
}

runMigration()
