import type PgBoss from "pg-boss"
import { db } from "@/db/client"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { Apps } from "@/shared/types"
import { eq } from "drizzle-orm"
import { connectors, type SelectConnector } from "@/db/schema"
import { ZohoDeskClient } from "./client"
import {
  transformZohoTicketToVespa,
  enqueueSummaryJobs,
  type VespaZohoTicket,
  type VespaZohoTicketBase,
  type VespaAttachmentType,
} from "./transformer"
import { insert, GetDocument, UpdateDocument } from "@/search/vespa"
import type { ZohoTicket } from "./types"
import { boss } from "@/queue/boss"
import {
  ProcessZohoDeskTicketQueue,
  ProcessZohoDeskAttachmentQueue,
} from "@/queue"
import {
  updateIngestionMetadata,
  updateIngestionStatus,
  getIngestionById,
} from "@/db/ingestion"
import type { ZohoDeskIngestionMetadata } from "@/db/schema/ingestions"
import { chunkByOCRFromBuffer } from "@/lib/chunkByOCR"
import * as XLSX from "xlsx"
import { chunkSheetWithHeaders } from "@/sheetChunk"

const Logger = getLogger(Subsystem.Integrations).child({ module: "zoho-queue" })

// Vespa schema constant for tickets (generic for all ticketing systems)
const ticketSchema = "ticket" as const

/**
 * Check if file is a spreadsheet (CSV, XLSX, XLS) based on filename
 */
function isSpreadsheetFile(filename: string): boolean {
  const lowerFilename = filename.toLowerCase()
  return (
    lowerFilename.endsWith(".csv") ||
    lowerFilename.endsWith(".xlsx") ||
    lowerFilename.endsWith(".xls")
  )
}

/**
 * Check if file is a plain text file that can be read directly without OCR
 */
function isPlainTextFile(filename: string): boolean {
  const lowerFilename = filename.toLowerCase()
  return (
    lowerFilename.endsWith(".txt") ||
    lowerFilename.endsWith(".log") ||
    lowerFilename.endsWith(".md") ||
    lowerFilename.endsWith(".json") ||
    lowerFilename.endsWith(".xml") ||
    lowerFilename.endsWith(".html") ||
    lowerFilename.endsWith(".css") ||
    lowerFilename.endsWith(".js") ||
    lowerFilename.endsWith(".ts") ||
    lowerFilename.endsWith(".py") ||
    lowerFilename.endsWith(".java") ||
    lowerFilename.endsWith(".sh")
  )
}

/**
 * Fetch ticket from Vespa with retry logic (for race condition with ticket insertion)
 */
async function fetchTicketWithRetry(
  ticketId: string,
  maxRetries = 5,
  delayMs = 2000,
): Promise<any> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const ticket = await GetDocument(ticketSchema as any, ticketId)
      if (ticket) {
        return ticket
      }
    } catch (error: any) {
      const is404 =
        error.message?.includes("404") || error.message?.includes("Not Found")

      if (is404 && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        continue
      }

      // Non-404 error or last attempt
      throw error
    }
  }

  throw new Error(
    `Ticket not found in Vespa after ${maxRetries} attempts: ${ticketId}`,
  )
}

/**
 * Parse spreadsheet file (CSV, XLSX, XLS) and extract text chunks
 */
async function parseSpreadsheetFile(
  buffer: Buffer,
  filename: string,
): Promise<string> {
  try {

    // Parse with XLSX library (supports CSV, XLSX, XLS)
    const workbook = XLSX.read(buffer, {
      type: "buffer",
      cellDates: true,
      cellNF: false,
      cellText: false,
      cellFormula: false,
      cellStyles: false,
      sheetStubs: false,
      dense: true, // More memory efficient
    })

    const allChunks: string[] = []

    // Process each sheet
    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName]
      if (!worksheet) continue

      // Extract text chunks with headers
      const chunks = chunkSheetWithHeaders(worksheet)

      if (chunks.length > 0) {
        // Add sheet name as header if multiple sheets
        if (workbook.SheetNames.length > 1) {
          allChunks.push(`Sheet: ${sheetName}`)
        }
        allChunks.push(...chunks)
      }
    }

    const combinedText = allChunks.join("\n\n")


    return combinedText
  } catch (error) {

    Logger.error("Failed to parse spreadsheet file", {
      filename,
      error: error instanceof Error ? error.message : String(error),
    })
    throw new Error(`Failed to parse spreadsheet file "${filename}": ${error}`)
  }
}

// Job types
export interface TicketJob {
  ticketId: string
  connectorId: number
  workspaceExternalId: string
  ingestionId: number
  lastModifiedTime?: string // Sync threshold - skip tickets older than this
}

export interface AttachmentJob {
  ticketId: string
  attachmentId: string
  attachmentName: string
  attachmentUrl: string // URL provided by Zoho API
  location: "ticket" | "thread" | "comment"
  locationIndex?: number // For threads[X] or comments[X]
  arrayIndex: number // Index within the attachment array
  connectorId: number
  workspaceExternalId: string
  ingestionId: number
}

/**
 * Process a single ticket: fetch details, transform, insert to Vespa, queue attachments
 */
export async function processTicketJob(
  job: PgBoss.Job<TicketJob>,
): Promise<void> {
  const {
    ticketId,
    connectorId,
    workspaceExternalId,
    ingestionId,
    lastModifiedTime,
  } = job.data

  Logger.info("Processing ticket job", {
    ticketId,
    connectorId,
    lastModifiedTime,
  })

  try {
    // 1. Get connector
    const connector = await getConnector(connectorId)
    if (!connector) {
      throw new Error(`Connector not found: ${connectorId}`)
    }

    // 2. Parse credentials (it's a JSON string from database)
    let credentials: any
    try {
      if (typeof connector.credentials === "string") {
        credentials = JSON.parse(connector.credentials)
        Logger.info("✅ Credentials parsed from JSON string")
      } else {
        credentials = connector.credentials
        Logger.info("✅ Credentials already an object")
      }
    } catch (error) {
      Logger.error("❌ Failed to parse credentials JSON", {
        error: error instanceof Error ? error.message : String(error),
        credentialsValue: connector.credentials,
      })
      throw new Error("Invalid credentials format in database")
    }

    const client = new ZohoDeskClient({
      orgId: credentials.orgId || "",
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      refreshToken: credentials.refreshToken,
    })

    // 3. Fetch full ticket details
    const fullTicket = await client.fetchTicketById(ticketId)

    // 3.5. Check if ticket should be skipped BEFORE enrichment (incremental sync filter)
    if (
      lastModifiedTime &&
      fullTicket.modifiedTime &&
      fullTicket.modifiedTime <= lastModifiedTime
    ) {

      Logger.info(
        "⏭️  Skipping old ticket (early check)",
      )
      return
    }

    // 3.6. Enrich ticket with agent and account information
    // Fetch createdBy agent info if it's just an ID
    if (fullTicket.createdBy && typeof fullTicket.createdBy === "string") {
      const createdByAgent = await client.fetchAgentById(fullTicket.createdBy)
      if (createdByAgent) {
        fullTicket.createdBy = createdByAgent as any
      } 
    }

    // Fetch modifiedBy agent info if it's just an ID
    if (fullTicket.modifiedBy && typeof fullTicket.modifiedBy === "string") {
      const modifiedByAgent = await client.fetchAgentById(fullTicket.modifiedBy)
      if (modifiedByAgent) {
        fullTicket.modifiedBy = modifiedByAgent as any
      }
    }

    // Fetch account info if we only have accountId
    if (fullTicket.accountId && !fullTicket.account) {
      const account = await client.fetchAccountById(fullTicket.accountId)
      if (account) {
        fullTicket.account = account as any
      } 
    }

    // Fetch product info if we only have productId
    if (fullTicket.productId && !fullTicket.product) {
      const product = await client.fetchProductById(fullTicket.productId)
      if (product) {
        fullTicket.product = product as any
      } 
    }

    // Fetch team info if we only have teamId
    if (fullTicket.teamId && !fullTicket.team) {

      const team = await client.fetchTeamById(fullTicket.teamId)
      if (team) {
        fullTicket.team = team as any
      } 
    }

    // 4. Fetch threads
    const threads = await client.fetchAllThreads(ticketId)

    // 5. Fetch comments
    const comments = await client.fetchAllComments(ticketId)

    // 6. Fetch ticket-level attachments
    const ticketAttachments = await client.fetchTicketAttachments(ticketId)

    // 7. Transform to Vespa format
    const vespaTicket = transformZohoTicketToVespa(
      fullTicket,
      threads,
      comments,
      ticketAttachments,
    )

    // 8. Check if ticket already exists in Vespa (for upsert logic)
    let existingTicket = null
    try {
      existingTicket = await GetDocument(ticketSchema as any, ticketId)
      Logger.info("✅ Ticket already exists in Vespa, will update", {
        ticketId,
      })
    } catch (error: any) {
      // 404 is expected for new tickets - it just means we'll do an INSERT
      if (error.message?.includes("404")) {
        Logger.info("📝 New ticket (not in Vespa yet), will insert", {
          ticketId,
        })
      } else {
        // Unexpected error - log it but continue with insert
        Logger.warn(
          "⚠️ Error checking if ticket exists, will try insert anyway",
          {
            ticketId,
            error: error instanceof Error ? error.message : String(error),
          },
        )
      }
    }

    if (existingTicket) {
      // Update existing ticket - preserve OCR data from already-processed attachments
      Logger.info("🔄 Merging with existing ticket data", { ticketId })

      const existingFields = existingTicket.fields as unknown as VespaZohoTicket

      // Merge attachment data: keep OCR results from existing attachments
      if (existingFields.ticketAttachments && vespaTicket.ticketAttachments) {
        vespaTicket.ticketAttachments = mergeAttachments(
          existingFields.ticketAttachments,
          vespaTicket.ticketAttachments,
        )
      }

      // Merge thread attachments
      if (existingFields.threads && vespaTicket.threads) {
        vespaTicket.threads.forEach((thread, index) => {
          if (
            existingFields.threads?.[index]?.attachmentDetails &&
            thread.attachmentDetails
          ) {
            thread.attachmentDetails = mergeAttachments(
              existingFields.threads[index].attachmentDetails,
              thread.attachmentDetails,
            )
          }
        })
      }

      // Merge comment attachments
      if (existingFields.comments && vespaTicket.comments) {
        vespaTicket.comments.forEach((comment, index) => {
          if (
            existingFields.comments?.[index]?.attachmentDetails &&
            comment.attachmentDetails
          ) {
            comment.attachmentDetails = mergeAttachments(
              existingFields.comments[index].attachmentDetails,
              comment.attachmentDetails,
            )
          }
        })
      }
    }

    // 9. Collect attachment jobs and mark as "processing" BEFORE Vespa update
    // This ensures we only update Vespa once
    const attachmentJobs = collectAttachmentJobs(
      vespaTicket,
      connectorId,
      workspaceExternalId,
      ingestionId,
    )

    // Filter to only queue attachments that need processing
    const attachmentsToQueue = attachmentJobs.filter((job) => {
      // Find the attachment in vespaTicket to check its status
      const attachment = findAttachmentInTicket(
        vespaTicket,
        job.location,
        job.locationIndex,
        job.arrayIndex,
      )
      return (
        attachment &&
        (attachment.processingStatus === "pending" ||
          attachment.processingStatus === "failed")
      )
    })

    // Mark attachments as "processing" in-memory BEFORE Vespa update
    attachmentsToQueue.forEach((job) => {
      const attachment = findAttachmentInTicket(
        vespaTicket,
        job.location,
        job.locationIndex,
        job.arrayIndex,
      )
      if (attachment) {
        attachment.processingStatus = "processing"
      }
    })

    // 10. Single Vespa update/insert with all data including "processing" status
    const finalDocument = {
      ...vespaTicket,
      docId: ticketId, // vespa-ts library needs docId field for URL construction
      workspaceExternalId: connector.workspaceExternalId,
      app: Apps.ZohoDesk,
      entity: "ticket",
      permissions: vespaTicket.departmentId ? [vespaTicket.departmentId] : [],
    }

    // Log departmentId being set in permissions array
    Logger.info("🔐 Setting departmentId in permissions array for Vespa", {
      ticketId,
      ticketNumber: vespaTicket.ticketNumber,
      departmentId: vespaTicket.departmentId,
      permissionsArray: finalDocument.permissions,
      hasPermissions: finalDocument.permissions.length > 0,
    })

    if (existingTicket) {
      Logger.info("📝 Updating existing ticket in Vespa", { ticketId })
      await UpdateDocument(ticketSchema as any, ticketId, finalDocument)
      Logger.info("✅ Successfully updated ticket in Vespa", { ticketId })

      // Enqueue summary generation jobs for updated ticket
      // Re-generate summaries when ticket is updated (new threads/comments may have been added)
      try {
        Logger.info(
          "🔄 Enqueueing summary generation jobs for updated ticket",
          {
            ticketId,
            threadCount: vespaTicket.threads?.length || 0,
            commentCount: vespaTicket.comments?.length || 0,
          },
        )

        await enqueueSummaryJobs(
          fullTicket,
          vespaTicket.threads || [],
          vespaTicket.comments || [],
        )

        Logger.info("✅ Successfully enqueued summary generation jobs", {
          ticketId,
          threadCount: vespaTicket.threads?.length || 0,
          commentCount: vespaTicket.comments?.length || 0,
        })
      } catch (error) {
        Logger.error("❌ Failed to enqueue summary generation jobs", {
          ticketId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
        // Don't throw - ticket update should continue even if summary jobs fail
      }
    } else {
      Logger.info("📝 Inserting new ticket to Vespa", { ticketId })
      await insert(finalDocument as any, ticketSchema as any)
      // Success log - safe for production
      Logger.info("✅ Successfully inserted ticket to Vespa", { ticketId })
    }

    // Enqueue summary generation jobs for this ticket
    // This happens after Vespa insert to ensure ticket exists before summaries are generated
    try {
      Logger.info("🔄 Enqueueing summary generation jobs", {
        ticketId,
        threadCount: vespaTicket.threads?.length || 0,
        commentCount: vespaTicket.comments?.length || 0,
      })

      await enqueueSummaryJobs(
        fullTicket,
        vespaTicket.threads || [],
        vespaTicket.comments || [],
      )

      Logger.info("✅ Successfully enqueued summary generation jobs", {
        ticketId,
        threadCount: vespaTicket.threads?.length || 0,
        commentCount: vespaTicket.comments?.length || 0,
      })
    } catch (error) {
      Logger.error("❌ Failed to enqueue summary generation jobs", {
        ticketId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
      // Don't throw - ticket ingestion should continue even if summary jobs fail
    }

    // Queue attachment jobs with singleton keys to prevent duplicates
    for (const attachmentJob of attachmentsToQueue) {
      try {
        await boss.send(ProcessZohoDeskAttachmentQueue, attachmentJob, {
          retryLimit: 2,
          expireInHours: 23,
          singletonKey: `${attachmentJob.ticketId}-${attachmentJob.attachmentId}`,
        })
      } catch (error) {
        Logger.error("Failed to queue attachment", {
          ticketId,
          attachmentId: attachmentJob.attachmentId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // 11. Queue attachment jobs (already marked as "processing" in Vespa)
    Logger.info("Queueing attachments for OCR processing", {
      ticketId,
      count: attachmentsToQueue.length,
    })

    // 12. Update ingestion metadata - increment processed tickets
    // Only count attachments that will be queued for processing
    await incrementProcessedTickets(ingestionId, attachmentsToQueue.length)

    Logger.info("Successfully processed ticket", {
      ticketId,
      attachmentsQueued: attachmentsToQueue.length,
      attachmentsAlreadyProcessed:
        attachmentJobs.length - attachmentsToQueue.length,
    })
  } catch (error) {
    Logger.error("Error processing ticket", {
      ticketId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Process a single attachment: download, run OCR, update Vespa
 */
export async function processAttachmentJob(
  job: PgBoss.Job<AttachmentJob>,
): Promise<void> {
  const {
    ticketId,
    attachmentId,
    attachmentName,
    attachmentUrl,
    location,
    locationIndex,
    arrayIndex,
    connectorId,
    ingestionId,
  } = job.data

  Logger.info("Processing attachment job", {
    ticketId,
    attachmentId,
    location,
  })

  try {
    // 1. Get connector for credentials
    const connector = await getConnector(connectorId)
    if (!connector) {
      throw new Error(`Connector not found: ${connectorId}`)
    }

    // 2. Parse credentials (it's a JSON string from database)
    let credentials: any
    try {
      if (typeof connector.credentials === "string") {
        credentials = JSON.parse(connector.credentials)
        Logger.info("✅ Credentials parsed from JSON string", { attachmentId })
      } else {
        credentials = connector.credentials
        Logger.info("✅ Credentials already an object", { attachmentId })
      }
    } catch (error) {
      Logger.error("❌ Failed to parse credentials JSON", {
        attachmentId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw new Error("Invalid credentials format in database")
    }

    // 3. Initialize Zoho client
    const client = new ZohoDeskClient({
      orgId: credentials.orgId || "",
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      refreshToken: credentials.refreshToken,
    })

    // 4. Download attachment using the URL from API
    Logger.info("📥 Downloading attachment from Zoho", {
      ticketId,
      attachmentId,
      attachmentName,
      attachmentUrl,
    })
    const buffer = await client.downloadAttachmentFromUrl(attachmentUrl)

    Logger.info("✅ Downloaded attachment", {
      attachmentId,
      bufferSize: buffer.length,
      bufferSizeMB: (buffer.length / 1024 / 1024).toFixed(2),
    })

    // 5. Extract text from attachment (spreadsheet parsing or OCR)
    let ocrText: string

    // Check if file is a spreadsheet (CSV, XLSX, XLS)
    if (isSpreadsheetFile(attachmentName)) {

      Logger.info("📊 Parsing spreadsheet file", {
        attachmentId,
        attachmentName,
      })
      ocrText = await parseSpreadsheetFile(buffer, attachmentName)
    } else if (isPlainTextFile(attachmentName)) {

      Logger.info("📄 Reading plain text file directly", {
        attachmentId,
        attachmentName,
      })

      try {
        ocrText = buffer.toString("utf-8")
        // Success log - safe for production (no sensitive text content)
        console.log(`✅ Plain text extracted: ${ocrText.length} characters`)
      } catch (error) {
        Logger.error(
          error,
          "Failed to decode plain text file, using empty text",
          {
            attachmentId,
            attachmentName,
          },
        )
        ocrText = ""
      }
    } else {

      Logger.info("🔍 Running OCR on attachment", {
        attachmentId,
        attachmentName,
      })

      try {
        const ocrResult = await chunkByOCRFromBuffer(
          buffer,
          attachmentName,
          attachmentId,
        )

        // Extract text from chunks
        ocrText = ocrResult.chunks.join(" ")
      } catch (ocrError) {

        Logger.warn("OCR processing failed, continuing with empty text", {
          attachmentId,
          attachmentName,
          error:
            ocrError instanceof Error ? ocrError.message : String(ocrError),
        })

        // Set empty text if OCR fails
        ocrText = ""
      }
    }

    const ticket = await fetchTicketWithRetry(ticketId, 5, 2000)
    if (!ticket) {
      throw new Error(`Ticket not found in Vespa: ${ticketId}`)
    }

    const ticketFields = ticket.fields as unknown as VespaZohoTicket

    // Find and log the current attachment
    let currentAttachment
    if (location === "ticket") {
      currentAttachment = ticketFields.ticketAttachments?.[arrayIndex]
    } else if (location === "thread" && locationIndex !== undefined) {
      currentAttachment =
        ticketFields.threads?.[locationIndex]?.attachmentDetails?.[arrayIndex]
    } else if (location === "comment" && locationIndex !== undefined) {
      currentAttachment =
        ticketFields.comments?.[locationIndex]?.attachmentDetails?.[arrayIndex]
    }

    updateAttachmentInTicket(
      ticketFields,
      location,
      locationIndex,
      arrayIndex,
      ocrText,
    )

    // Log updated attachment
    let updatedAttachment
    if (location === "ticket") {
      updatedAttachment = ticketFields.ticketAttachments?.[arrayIndex]
    } else if (location === "thread" && locationIndex !== undefined) {
      updatedAttachment =
        ticketFields.threads?.[locationIndex]?.attachmentDetails?.[arrayIndex]
    } else if (location === "comment" && locationIndex !== undefined) {
      updatedAttachment =
        ticketFields.comments?.[locationIndex]?.attachmentDetails?.[arrayIndex]
    }

    await UpdateDocument(ticketSchema as any, ticketId, ticketFields)

    Logger.info("Updated ticket in Vespa with OCR text", {
      ticketId,
      attachmentId,
    })

    // 9. Update ingestion metadata - increment processed attachments
    await incrementProcessedAttachments(ingestionId)

    Logger.info("Successfully processed attachment", {
      ticketId,
      attachmentId,
    })
  } catch (error) {

    Logger.error("Error processing attachment", {
      ticketId,
      attachmentId,
      error: error instanceof Error ? error.message : String(error),
    })


    try {
      const ticket = await fetchTicketWithRetry(ticketId, 3, 2000)
      if (ticket) {
        const ticketFields = ticket.fields as unknown as VespaZohoTicket
        markAttachmentAsFailed(
          ticketFields,
          location,
          locationIndex,
          arrayIndex,
        )
        await UpdateDocument(ticketSchema as any, ticketId, ticketFields)

        // Success log - safe for production
      

      } else {
        // Warning log - safe for production
      
      }
    } catch (updateError) {
      // Failure log - safe for production


      Logger.error("Failed to mark attachment as failed", {
        ticketId,
        attachmentId,
        error:
          updateError instanceof Error
            ? updateError.message
            : String(updateError),
      })
    }

    throw error
  }
}

/**
 * Collect all attachment jobs from a ticket
 */
function collectAttachmentJobs(
  vespaTicket: VespaZohoTicketBase,
  connectorId: number,
  workspaceExternalId: string,
  ingestionId: number,
): AttachmentJob[] {
  const jobs: AttachmentJob[] = []

  // Ticket-level attachments
  vespaTicket.ticketAttachments?.forEach((att, index) => {
    jobs.push({
      ticketId: vespaTicket.id,
      attachmentId: att.attachmentId,
      attachmentName: att.attachmentName,
      attachmentUrl: att.attachmentUrl,
      location: "ticket",
      arrayIndex: index,
      connectorId,
      workspaceExternalId,
      ingestionId,
    })
  })

  // Thread attachments
  vespaTicket.threads?.forEach((thread, threadIndex) => {
    thread.attachmentDetails?.forEach((att, attIndex) => {
      jobs.push({
        ticketId: vespaTicket.id,
        attachmentId: att.attachmentId,
        attachmentName: att.attachmentName,
        attachmentUrl: att.attachmentUrl,
        location: "thread",
        locationIndex: threadIndex,
        arrayIndex: attIndex,
        connectorId,
        workspaceExternalId,
        ingestionId,
      })
    })
  })

  // Comment attachments
  vespaTicket.comments?.forEach((comment, commentIndex) => {
    comment.attachmentDetails?.forEach((att, attIndex) => {
      jobs.push({
        ticketId: vespaTicket.id,
        attachmentId: att.attachmentId,
        attachmentName: att.attachmentName,
        attachmentUrl: att.attachmentUrl,
        location: "comment",
        locationIndex: commentIndex,
        arrayIndex: attIndex,
        connectorId,
        workspaceExternalId,
        ingestionId,
      })
    })
  })

  return jobs
}

/**
 * Update specific attachment with OCR text
 */
function updateAttachmentInTicket(
  ticket: VespaZohoTicket,
  location: "ticket" | "thread" | "comment",
  locationIndex: number | undefined,
  arrayIndex: number,
  ocrText: string,
): void {
  if (location === "ticket") {
    if (ticket.ticketAttachments && ticket.ticketAttachments[arrayIndex]) {
      ticket.ticketAttachments[arrayIndex].attachmentDetail = ocrText
      ticket.ticketAttachments[arrayIndex].processingStatus = "completed"
    }
  } else if (location === "thread") {
    if (
      locationIndex !== undefined &&
      ticket.threads &&
      ticket.threads[locationIndex] &&
      ticket.threads[locationIndex].attachmentDetails &&
      ticket.threads[locationIndex].attachmentDetails[arrayIndex]
    ) {
      ticket.threads[locationIndex].attachmentDetails[
        arrayIndex
      ].attachmentDetail = ocrText
      ticket.threads[locationIndex].attachmentDetails[
        arrayIndex
      ].processingStatus = "completed"
    }
  } else if (location === "comment") {
    if (
      locationIndex !== undefined &&
      ticket.comments &&
      ticket.comments[locationIndex] &&
      ticket.comments[locationIndex].attachmentDetails &&
      ticket.comments[locationIndex].attachmentDetails[arrayIndex]
    ) {
      ticket.comments[locationIndex].attachmentDetails[
        arrayIndex
      ].attachmentDetail = ocrText
      ticket.comments[locationIndex].attachmentDetails[
        arrayIndex
      ].processingStatus = "completed"
    }
  }
}

/**
 * Mark attachment as failed
 */
function markAttachmentAsFailed(
  ticket: VespaZohoTicket,
  location: "ticket" | "thread" | "comment",
  locationIndex: number | undefined,
  arrayIndex: number,
): void {
  if (location === "ticket") {
    if (ticket.ticketAttachments && ticket.ticketAttachments[arrayIndex]) {
      ticket.ticketAttachments[arrayIndex].processingStatus = "failed"
    }
  } else if (location === "thread") {
    if (
      locationIndex !== undefined &&
      ticket.threads &&
      ticket.threads[locationIndex] &&
      ticket.threads[locationIndex].attachmentDetails &&
      ticket.threads[locationIndex].attachmentDetails[arrayIndex]
    ) {
      ticket.threads[locationIndex].attachmentDetails[
        arrayIndex
      ].processingStatus = "failed"
    }
  } else if (location === "comment") {
    if (
      locationIndex !== undefined &&
      ticket.comments &&
      ticket.comments[locationIndex] &&
      ticket.comments[locationIndex].attachmentDetails &&
      ticket.comments[locationIndex].attachmentDetails[arrayIndex]
    ) {
      ticket.comments[locationIndex].attachmentDetails[
        arrayIndex
      ].processingStatus = "failed"
    }
  }
}

/**
 * Increment processed tickets count and total attachments
 */
async function incrementProcessedTickets(
  ingestionId: number,
  attachmentCount: number,
): Promise<void> {
  const ingestion = await getIngestionById(db, ingestionId)
  if (!ingestion) return

  const metadata = ingestion.metadata as {
    zohoDesk?: ZohoDeskIngestionMetadata
  }
  const zohoDeskMetadata = metadata?.zohoDesk

  if (!zohoDeskMetadata) return

  const updatedMetadata: { zohoDesk: ZohoDeskIngestionMetadata } = {
    zohoDesk: {
      ...zohoDeskMetadata,
      websocketData: {
        ...zohoDeskMetadata.websocketData,
        progress: {
          ...zohoDeskMetadata.websocketData.progress,
          processedTickets:
            (zohoDeskMetadata.websocketData.progress?.processedTickets || 0) +
            1,
          totalAttachments:
            (zohoDeskMetadata.websocketData.progress?.totalAttachments || 0) +
            attachmentCount,
        },
      },
      ingestionState: {
        ...zohoDeskMetadata.ingestionState,
        lastUpdated: new Date().toISOString(),
      },
    },
  }

  await updateIngestionMetadata(db, ingestionId, updatedMetadata)
}

/**
 * Increment processed attachments count and check if ingestion is complete
 */
async function incrementProcessedAttachments(
  ingestionId: number,
): Promise<void> {
  const ingestion = await getIngestionById(db, ingestionId)
  if (!ingestion) return

  const metadata = ingestion.metadata as {
    zohoDesk?: ZohoDeskIngestionMetadata
  }
  const zohoDeskMetadata = metadata?.zohoDesk

  if (!zohoDeskMetadata) return

  const processedAttachments =
    (zohoDeskMetadata.websocketData.progress?.processedAttachments || 0) + 1
  const totalAttachments =
    zohoDeskMetadata.websocketData.progress?.totalAttachments || 0

  const updatedMetadata: { zohoDesk: ZohoDeskIngestionMetadata } = {
    zohoDesk: {
      ...zohoDeskMetadata,
      websocketData: {
        ...zohoDeskMetadata.websocketData,
        progress: {
          ...zohoDeskMetadata.websocketData.progress,
          processedAttachments,
        },
      },
      ingestionState: {
        ...zohoDeskMetadata.ingestionState,
        lastUpdated: new Date().toISOString(),
      },
    },
  }

  await updateIngestionMetadata(db, ingestionId, updatedMetadata)

  // Check if all attachments are processed
  if (processedAttachments >= totalAttachments && totalAttachments > 0) {
    Logger.info("All attachments processed, marking ingestion as completed", {
      ingestionId,
      processedAttachments,
      totalAttachments,
    })
    await updateIngestionStatus(db, ingestionId, "completed")
  }
}

/**
 * Merge old and new attachment arrays, preserving OCR data from old attachments
 * Uses NEW attachments as source of truth - deleted attachments are automatically removed
 */
function mergeAttachments(
  oldAttachments: VespaAttachmentType[],
  newAttachments: VespaAttachmentType[],
): VespaAttachmentType[] {
  // Use NEW attachments as source of truth
  // Only preserve OCR data for attachments that still exist in Zoho
  return newAttachments.map((newAtt) => {
    // Find matching attachment in old array by attachmentId
    const oldAtt = oldAttachments.find(
      (old) => old.attachmentId === newAtt.attachmentId,
    )

    if (oldAtt) {
      if (oldAtt.processingStatus === "completed") {
        // Preserve OCR data from completed attachment
        return {
          ...newAtt,
          attachmentDetail: oldAtt.attachmentDetail,
          processingStatus: "completed",
        }
      } else if (oldAtt.processingStatus === "processing") {
        // Preserve "processing" status to avoid re-queuing during concurrent syncs
        return {
          ...newAtt,
          processingStatus: "processing",
        }
      }
    }

    // New attachment or old one was "pending"/"failed" - keep as "pending" to be processed
    return newAtt
  })
  // Note: Deleted attachments are automatically removed because they're not in newAttachments
}

/**
 * Find a specific attachment in a ticket by location
 */
function findAttachmentInTicket(
  ticket: VespaZohoTicketBase,
  location: "ticket" | "thread" | "comment",
  locationIndex: number | undefined,
  arrayIndex: number,
): VespaAttachmentType | undefined {
  if (location === "ticket") {
    return ticket.ticketAttachments?.[arrayIndex]
  } else if (location === "thread" && locationIndex !== undefined) {
    return ticket.threads?.[locationIndex]?.attachmentDetails?.[arrayIndex]
  } else if (location === "comment" && locationIndex !== undefined) {
    return ticket.comments?.[locationIndex]?.attachmentDetails?.[arrayIndex]
  }
  return undefined
}

/**
 * Get connector with credentials
 */
async function getConnector(
  connectorId: number,
): Promise<SelectConnector | null> {
  const results = await db
    .select()
    .from(connectors)
    .where(eq(connectors.id, connectorId))
    .limit(1)

  return (results[0] as SelectConnector) || null
}
