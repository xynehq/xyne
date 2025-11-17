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

// Vespa schema constant for Zoho tickets
const zohoTicketSchema = "zoho_ticket" as const

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
 * Fetch ticket from Vespa with retry logic (for race condition with ticket insertion)
 */
async function fetchTicketWithRetry(
  ticketId: string,
  maxRetries = 5,
  delayMs = 2000,
): Promise<any> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `   Attempt ${attempt}/${maxRetries} to fetch ticket from Vespa`,
      )
      const ticket = await GetDocument(zohoTicketSchema as any, ticketId)
      if (ticket) {
        console.log(`   ✅ Ticket found on attempt ${attempt}`)
        return ticket
      }
    } catch (error: any) {
      const is404 =
        error.message?.includes("404") || error.message?.includes("Not Found")

      if (is404 && attempt < maxRetries) {
        console.log(
          `   ⏳ Ticket not found yet (404), retrying in ${delayMs}ms...`,
        )
        console.log(`      (Ticket worker may still be inserting it)`)
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
    console.log("\n📊 SPREADSHEET PARSER: Parsing spreadsheet file")
    console.log(`   Filename: ${filename}`)
    console.log(`   Buffer Size: ${buffer.length} bytes`)
    console.log("")

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

    console.log(`   Sheets Found: ${workbook.SheetNames.length}`)
    console.log(`   Sheet Names: ${workbook.SheetNames.join(", ")}`)
    console.log("")

    const allChunks: string[] = []

    // Process each sheet
    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName]
      if (!worksheet) continue

      console.log(`   Processing Sheet: "${sheetName}"`)

      // Extract text chunks with headers
      const chunks = chunkSheetWithHeaders(worksheet)

      console.log(`   Chunks Extracted: ${chunks.length}`)

      if (chunks.length > 0) {
        // Add sheet name as header if multiple sheets
        if (workbook.SheetNames.length > 1) {
          allChunks.push(`Sheet: ${sheetName}`)
        }
        allChunks.push(...chunks)
      }
    }

    const combinedText = allChunks.join("\n\n")

    console.log("\n✅ SPREADSHEET PARSER: Parsing complete")
    console.log(`   Total Chunks: ${allChunks.length}`)
    console.log(`   Total Text Length: ${combinedText.length} characters`)
    console.log(
      `   Text Preview: ${combinedText.substring(0, 200)}${combinedText.length > 200 ? "..." : ""}`,
    )
    console.log("")

    return combinedText
  } catch (error) {
    console.log("\n❌ SPREADSHEET PARSER: Failed to parse spreadsheet")
    console.log(
      `   Error: ${error instanceof Error ? error.message : String(error)}`,
    )
    console.log("")

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

    Logger.info("📋 Connector loaded from database", {
      connectorId,
      hasCredentials: !!connector.credentials,
      credentialsType: typeof connector.credentials,
      credentialsValue:
        typeof connector.credentials === "string"
          ? connector.credentials.substring(0, 100)
          : connector.credentials,
    })

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

    Logger.info("🔑 Parsed credentials", {
      hasOrgId: !!credentials?.orgId,
      hasClientId: !!credentials?.clientId,
      hasClientSecret: !!credentials?.clientSecret,
      hasRefreshToken: !!credentials?.refreshToken,
      refreshTokenLength: credentials?.refreshToken?.length,
      credentialsKeys: credentials ? Object.keys(credentials) : [],
    })

    const client = new ZohoDeskClient({
      orgId: credentials.orgId || "",
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      refreshToken: credentials.refreshToken,
    })

    // 3. Fetch full ticket details
    const fullTicket = await client.fetchTicketById(ticketId)

    console.log("\n📥 RAW ZOHO API RESPONSE - TICKET")
    console.log("=".repeat(80))
    console.log(JSON.stringify(fullTicket, null, 2))
    console.log("=".repeat(80))
    console.log("")

    Logger.info("📥 Fetched full ticket from Zoho API", {
      ticketId,
      ticketNumber: fullTicket.ticketNumber,
      subject: fullTicket.subject,
      status: fullTicket.status,
      priority: fullTicket.priority,
      departmentId: fullTicket.departmentId,
      createdTime: fullTicket.createdTime,
      modifiedTime: fullTicket.modifiedTime,
    })

    // 3.5. Enrich ticket with agent and account information
    // TODO: Fix enrichment - these API endpoints don't exist in Zoho Desk API v1
    // Commenting out for now to avoid errors
    /*
    // Fetch createdBy agent info if it's just an ID
    if (fullTicket.createdBy && typeof fullTicket.createdBy === 'string') {
      const createdByAgent = await client.fetchAgentById(fullTicket.createdBy)
      if (createdByAgent) {
        fullTicket.createdBy = createdByAgent as any
        Logger.info("✅ Enriched ticket with createdBy agent info", {
          ticketId,
          createdByEmail: createdByAgent.email,
        })
      }
    }

    // Fetch modifiedBy agent info if it's just an ID
    if (fullTicket.modifiedBy && typeof fullTicket.modifiedBy === 'string') {
      const modifiedByAgent = await client.fetchAgentById(fullTicket.modifiedBy)
      if (modifiedByAgent) {
        fullTicket.modifiedBy = modifiedByAgent as any
        Logger.info("✅ Enriched ticket with modifiedBy agent info", {
          ticketId,
          modifiedByEmail: modifiedByAgent.email,
        })
      }
    }

    // Fetch account info if we only have accountId
    if (fullTicket.accountId && !fullTicket.account) {
      const account = await client.fetchAccountById(fullTicket.accountId)
      if (account) {
        fullTicket.account = account as any
        Logger.info("✅ Enriched ticket with account info", {
          ticketId,
          accountName: account.accountName,
        })
      }
    }

    // Fetch product info if we only have productId
    if (fullTicket.productId && !fullTicket.product) {
      const product = await client.fetchProductById(fullTicket.productId)
      if (product) {
        fullTicket.product = product as any
        Logger.info("✅ Enriched ticket with product info", {
          ticketId,
          productName: product.productName,
        })
      }
    }

    // Fetch team info if we only have teamId
    if (fullTicket.teamId && !fullTicket.team) {
      const team = await client.fetchTeamById(fullTicket.teamId)
      if (team) {
        fullTicket.team = team as any
        Logger.info("✅ Enriched ticket with team info", {
          ticketId,
          teamName: team.name,
        })
      }
    }
    */

    // 4. Check if ticket should be skipped (incremental sync filter)
    if (
      lastModifiedTime &&
      fullTicket.modifiedTime &&
      fullTicket.modifiedTime <= lastModifiedTime
    ) {
      console.log(`\n⏭️  SKIPPING OLD TICKET`)
      console.log(`   Ticket ID: ${ticketId}`)
      console.log(`   Ticket Number: ${fullTicket.ticketNumber}`)
      console.log(`   Ticket Modified: ${fullTicket.modifiedTime}`)
      console.log(`   Sync Threshold: ${lastModifiedTime}`)
      console.log(`   ✅ Already processed in previous sync\n`)

      Logger.info("⏭️  Skipping old ticket", {
        ticketId,
        ticketNumber: fullTicket.ticketNumber,
        ticketModifiedTime: fullTicket.modifiedTime,
        syncThreshold: lastModifiedTime,
        message: "Ticket already processed in previous sync",
      })
      return // Skip processing this ticket
    }

    // 4. Fetch threads
    const threads = await client.fetchAllThreads(ticketId)

    console.log("\n📥 RAW ZOHO API RESPONSE - THREADS")
    console.log("=".repeat(80))
    console.log(JSON.stringify(threads, null, 2))
    console.log("=".repeat(80))
    console.log("")

    Logger.info("📥 Fetched threads from Zoho API", {
      ticketId,
      threadCount: threads.length,
      sampleThread:
        threads.length > 0
          ? {
              direction: threads[0]?.direction,
              channel: threads[0]?.channel,
              hasAttachments: (threads[0]?.attachments?.length ?? 0) > 0,
            }
          : null,
    })

    // 5. Fetch comments
    const comments = await client.fetchAllComments(ticketId)

    console.log("\n📥 RAW ZOHO API RESPONSE - COMMENTS")
    console.log("=".repeat(80))
    console.log(JSON.stringify(comments, null, 2))
    console.log("=".repeat(80))
    console.log("")

    Logger.info("📥 Fetched comments from Zoho API", {
      ticketId,
      commentCount: comments.length,
      sampleComment:
        comments.length > 0
          ? {
              hasContent: !!comments[0]?.content,
              hasAttachments: (comments[0]?.attachments?.length ?? 0) > 0,
            }
          : null,
    })

    // 6. Fetch ticket-level attachments
    const ticketAttachments = await client.fetchTicketAttachments(ticketId)

    console.log("\n📥 RAW ZOHO API RESPONSE - TICKET ATTACHMENTS")
    console.log("=".repeat(80))
    console.log(JSON.stringify(ticketAttachments, null, 2))
    console.log("=".repeat(80))
    console.log("")

    Logger.info("📥 Fetched ticket attachments from Zoho API", {
      ticketId,
      attachmentCount: ticketAttachments.length,
      attachmentNames: ticketAttachments.map((a) => a.name),
    })

    // 7. Transform to Vespa format
    const vespaTicket = transformZohoTicketToVespa(
      fullTicket,
      threads,
      comments,
      ticketAttachments,
    )
    Logger.info("🔄 Transformed ticket to Vespa format", {
      ticketId,
      vespaFields: {
        id: vespaTicket.id,
        ticketNumber: vespaTicket.ticketNumber,
        subject: vespaTicket.subject,
        status: vespaTicket.status,
        priority: vespaTicket.priority,
        departmentId: vespaTicket.departmentId,
        threadCount: vespaTicket.threads?.length || 0,
        commentCount: vespaTicket.comments?.length || 0,
        ticketAttachmentCount: vespaTicket.ticketAttachments?.length || 0,
      },
    })

    // 8. Check if ticket already exists in Vespa (for upsert logic)
    let existingTicket = null
    try {
      existingTicket = await GetDocument(zohoTicketSchema as any, ticketId)
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

    Logger.info("Attachments to queue for processing", {
      ticketId,
      totalAttachments: attachmentJobs.length,
      attachmentsToQueue: attachmentsToQueue.length,
      alreadyProcessed: attachmentJobs.length - attachmentsToQueue.length,
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

    console.log("\n📤 EXACT FIELDS BEING SENT TO VESPA")
    console.log("=".repeat(80))
    console.log(JSON.stringify(finalDocument, null, 2))
    console.log("=".repeat(80))
    console.log("")

    Logger.info("📤 Preparing to send document to Vespa", {
      ticketId,
      documentStructure: {
        id: finalDocument.id,
        ticketNumber: finalDocument.ticketNumber,
        subject: finalDocument.subject,
        status: finalDocument.status,
        priority: finalDocument.priority,
        departmentId: finalDocument.departmentId,
        workspaceExternalId: finalDocument.workspaceExternalId,
        app: finalDocument.app,
        entity: finalDocument.entity,
        permissions: finalDocument.permissions,
        threadCount: finalDocument.threads?.length || 0,
        commentCount: finalDocument.comments?.length || 0,
        ticketAttachmentCount: finalDocument.ticketAttachments?.length || 0,
        attachmentsMarkedProcessing: attachmentsToQueue.length,
      },
    })

    if (existingTicket) {
      console.log(`📝 UPDATING EXISTING TICKET IN VESPA: ${ticketId}\n`)
      Logger.info("📝 Updating existing ticket in Vespa", { ticketId })
      await UpdateDocument(zohoTicketSchema as any, ticketId, finalDocument)
      console.log(
        `✅ SUCCESSFULLY UPDATED TICKET IN VESPA: ${finalDocument.ticketNumber}\n`,
      )
      Logger.info("✅ Successfully updated ticket in Vespa", { ticketId })

      // Enqueue summary generation jobs for updated ticket
      // Re-generate summaries when ticket is updated (new threads/comments may have been added)
      try {
        Logger.info("🔄 Enqueueing summary generation jobs for updated ticket", {
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
        // Don't throw - ticket update should continue even if summary jobs fail
      }
    } else {
      console.log(`📝 INSERTING NEW TICKET TO VESPA: ${ticketId}\n`)
      Logger.info("📝 Inserting new ticket to Vespa", { ticketId })
      await insert(finalDocument as any, zohoTicketSchema as any)
      console.log(
        `✅ SUCCESSFULLY INSERTED NEW TICKET TO VESPA: ${finalDocument.ticketNumber}\n`,
      )
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

  console.log("\n🔵 ATTACHMENT WORKER: Starting attachment processing")
  console.log("=".repeat(80))
  console.log("📌 JOB DATA:")
  console.log(JSON.stringify(job.data, null, 2))
  console.log("=".repeat(80))
  console.log("")

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

    console.log("\n✅ ATTACHMENT WORKER: Downloaded attachment from Zoho")
    console.log(`   Attachment ID: ${attachmentId}`)
    console.log(`   Attachment Name: ${attachmentName}`)
    console.log(
      `   Buffer Size: ${buffer.length} bytes (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`,
    )
    console.log("")

    Logger.info("✅ Downloaded attachment", {
      attachmentId,
      bufferSize: buffer.length,
      bufferSizeMB: (buffer.length / 1024 / 1024).toFixed(2),
    })

    // 5. Extract text from attachment (spreadsheet parsing or OCR)
    let ocrText: string

    // Check if file is a spreadsheet (CSV, XLSX, XLS)
    if (isSpreadsheetFile(attachmentName)) {
      console.log(
        "\n📊 ATTACHMENT WORKER: Detected spreadsheet file, parsing with XLSX",
      )
      console.log(`   Attachment: ${attachmentName}`)
      console.log("")

      Logger.info("📊 Parsing spreadsheet file", {
        attachmentId,
        attachmentName,
      })
      ocrText = await parseSpreadsheetFile(buffer, attachmentName)
    } else {
      // Use OCR for images, PDFs, etc.
      console.log("\n🔍 ATTACHMENT WORKER: Running OCR on attachment")
      console.log(`   Attachment: ${attachmentName}`)
      console.log("")

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
        // Log OCR failure but continue processing
        console.log("\n⚠️  ATTACHMENT WORKER: OCR processing failed")
        console.log(`   Attachment: ${attachmentName}`)
        console.log(`   Error: ${ocrError instanceof Error ? ocrError.message : String(ocrError)}`)
        console.log("   Continuing with empty text content")
        console.log("")

        Logger.warn("OCR processing failed, continuing with empty text", {
          attachmentId,
          attachmentName,
          error: ocrError instanceof Error ? ocrError.message : String(ocrError),
        })

        // Set empty text if OCR fails
        ocrText = ""
      }
    }

    console.log("\n✅ ATTACHMENT WORKER: Text extraction completed")
    console.log(`   Attachment ID: ${attachmentId}`)
    console.log(`   Attachment Name: ${attachmentName}`)
    console.log(`   Extracted Text Length: ${ocrText.length} characters`)
    console.log(
      `   Text Preview: ${ocrText.substring(0, 200)}${ocrText.length > 200 ? "..." : ""}`,
    )
    console.log("")

    Logger.info("✅ Text extraction completed", {
      attachmentId,
      attachmentName,
      textLength: ocrText.length,
      textPreview:
        ocrText.substring(0, 200) + (ocrText.length > 200 ? "..." : ""),
      isSpreadsheet: isSpreadsheetFile(attachmentName),
    })

    // 6. Fetch ticket from Vespa (with retry for race condition)
    console.log("\n📥 ATTACHMENT WORKER: Fetching ticket from Vespa")
    console.log(`   Ticket ID: ${ticketId}`)
    console.log("")

    const ticket = await fetchTicketWithRetry(ticketId, 5, 2000)
    if (!ticket) {
      throw new Error(`Ticket not found in Vespa: ${ticketId}`)
    }

    const ticketFields = ticket.fields as unknown as VespaZohoTicket

    console.log("\n✅ ATTACHMENT WORKER: Fetched ticket from Vespa")
    console.log(`   Ticket ID: ${ticketId}`)
    console.log(`   Ticket Number: ${ticketFields.ticketNumber}`)
    console.log("")
    console.log("📎 ATTACHMENT STRUCTURE BEFORE UPDATE:")
    console.log(`   Location: ${location}`)
    console.log(`   Location Index: ${locationIndex}`)
    console.log(`   Array Index: ${arrayIndex}`)

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

    console.log("   Current Attachment Data:")
    console.log(JSON.stringify(currentAttachment, null, 2))
    console.log("")

    // 7. Update the specific attachment based on location
    console.log("\n🔄 ATTACHMENT WORKER: Updating attachment with OCR text")
    console.log(`   Attachment ID: ${attachmentId}`)
    console.log(`   OCR Text Length: ${ocrText.length} characters`)
    console.log("")

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

    console.log("✅ ATTACHMENT WORKER: Attachment updated in memory")
    console.log("   Updated Attachment Data:")
    console.log(JSON.stringify(updatedAttachment, null, 2))
    console.log("")

    // 8. Update Vespa
    console.log("\n📤 ATTACHMENT WORKER: Sending update to Vespa")
    console.log(`   Ticket ID: ${ticketId}`)
    console.log(`   Ticket Number: ${ticketFields.ticketNumber}`)
    console.log(`   Schema: ${zohoTicketSchema}`)
    console.log("")
    console.log("📋 FULL TICKET STRUCTURE BEING SENT TO VESPA:")
    console.log("=".repeat(80))
    console.log(JSON.stringify(ticketFields, null, 2))
    console.log("=".repeat(80))
    console.log("")

    await UpdateDocument(zohoTicketSchema as any, ticketId, ticketFields)

    console.log("\n✅ ATTACHMENT WORKER: Successfully updated Vespa")
    console.log(`   Ticket ID: ${ticketId}`)
    console.log(`   Attachment ID: ${attachmentId}`)
    console.log(`   Attachment Name: ${attachmentName}`)
    console.log(`   Processing Status: completed`)
    console.log("")

    Logger.info("Updated ticket in Vespa with OCR text", {
      ticketId,
      attachmentId,
    })

    // 9. Update ingestion metadata - increment processed attachments
    await incrementProcessedAttachments(ingestionId)

    console.log(
      "✅ ATTACHMENT WORKER: Attachment processing completed successfully",
    )
    console.log("=".repeat(80))
    console.log("")

    Logger.info("Successfully processed attachment", {
      ticketId,
      attachmentId,
    })
  } catch (error) {
    console.log("\n❌ ATTACHMENT WORKER: Error processing attachment")
    console.log("=".repeat(80))
    console.log(`   Ticket ID: ${ticketId}`)
    console.log(`   Attachment ID: ${attachmentId}`)
    console.log(`   Attachment Name: ${attachmentName}`)
    console.log(
      `   Error: ${error instanceof Error ? error.message : String(error)}`,
    )
    if (error instanceof Error && error.stack) {
      console.log(`   Stack: ${error.stack}`)
    }
    console.log("=".repeat(80))
    console.log("")

    Logger.error("Error processing attachment", {
      ticketId,
      attachmentId,
      error: error instanceof Error ? error.message : String(error),
    })

    // Mark attachment as failed in Vespa (with retry)
    console.log(
      "\n⚠️  ATTACHMENT WORKER: Attempting to mark attachment as failed in Vespa",
    )
    console.log(`   Ticket ID: ${ticketId}`)
    console.log(`   Attachment ID: ${attachmentId}`)
    console.log("")

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
        await UpdateDocument(zohoTicketSchema as any, ticketId, ticketFields)

        console.log(
          "✅ ATTACHMENT WORKER: Marked attachment as failed in Vespa",
        )
        console.log(`   Ticket ID: ${ticketId}`)
        console.log(`   Attachment ID: ${attachmentId}`)
        console.log("")
      } else {
        console.log(
          "⚠️  ATTACHMENT WORKER: Ticket not found in Vespa, cannot mark as failed",
        )
        console.log("")
      }
    } catch (updateError) {
      console.log("\n❌ ATTACHMENT WORKER: Failed to mark attachment as failed")
      console.log(
        `   Error: ${updateError instanceof Error ? updateError.message : String(updateError)}`,
      )
      console.log(
        `   (Ticket may not have been inserted yet - attachment will retry via job queue)`,
      )
      console.log("")

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
