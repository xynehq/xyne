import type { ZohoTicket, ZohoThread, ZohoAttachment } from "./types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { enqueueIndividualSummary } from "@/queue/summary-generation"

const logger = getLogger(Subsystem.Integrations).child({
  module: "zoho-transformer",
})

// Vespa document structure for ticket schema (without system fields)
// System fields are added in queue.ts before inserting to Vespa
// Used for Zoho Desk tickets (and can be extended for Jira, Linear, etc.)
export interface VespaZohoTicketBase {
  // Core Identifiers
  id: string
  ticketNumber: string
  departmentId: string
  departmentName: string
  accountName: string
  productName: string
  teamName: string

  // Core Ticket Fields
  subject: string
  description: string
  category: string
  subCategory: string
  classification: string
  priority: string
  status: string
  resolution: string
  webUrl: string
  sourceType: string
  platform: string
  contactEmail: string
  assigneeEmail: string
  createdByEmail: string
  modifiedByEmail: string
  channel: string
  sharedDepartments: string[]

  // Custom Fields
  merchantId: string
  productDetails: string
  firstResponseTime: number | null
  resolutionTime: number | null
  onHoldStartTime: number | null
  onHoldEndTime: number | null
  escalatedEndDate: number | null

  // Boolean Flags
  isOverDue: boolean
  isResponseOverdue: boolean
  isEscalated: boolean

  // Time Fields (epoch milliseconds)
  createdTime: number
  modifiedTime: number
  closedTime: number | null
  dueDate: number | null
  daysToClose: number | null

  // Derived & NLP Summaries (initially empty, filled later)
  threadSummary: string
  commentSummary: string
  wholeResolutionSummary: string

  // Flattened text arrays for BM25 search (no embeddings)
  threadMessages: string[]
  commentMessages: string[]
  attachmentTexts: string[]

  // Email recipients
  to: string[]
  cc: string[]
  bcc: string[]
  mentions: string[]

  // Thread & Comment Structures
  threads: VespaThreadSchema[]
  comments: VespaThreadSchema[]

  // Ticket-level attachments
  ticketAttachments: VespaAttachmentType[]
}

// Full Vespa document with system fields
export interface VespaZohoTicket extends VespaZohoTicketBase {
  // System Fields (required for all Vespa documents)
  workspaceExternalId: string
  app: string
  entity: string
  permissions: string[]
}

export interface VespaAttachmentType {
  attachmentId: string
  attachmentName: string
  attachmentDetail: string // OCR extracted text (initially empty)
  attachmentUrl: string
  processingStatus: string // "pending" | "processing" | "completed" | "failed"
  fileType: string
  size: number
}

export interface VespaThreadSchema {
  id: string
  messageText: string
  attachmentDetails: VespaAttachmentType[]
  authorEmail: string
  link: string
  createdTime: string
}

/**
 * Transform a Zoho ticket to Vespa ticket schema
 */
export function transformZohoTicketToVespa(
  ticket: ZohoTicket,
  threads: ZohoThread[],
  comments: ZohoThread[],
  ticketAttachments: ZohoAttachment[],
): VespaZohoTicketBase {


  // Extract all emails from threads and comments
  const allEmails = extractEmails(threads, comments)

  // Transform threads
  const vespaThreads = threads.map((thread) =>
    transformThread(thread, ticket.id),
  )

  // Transform comments
  const vespaComments = comments.map((comment) =>
    transformThread(comment, ticket.id),
  )

  // Transform ticket-level attachments
  const vespaTicketAttachments = ticketAttachments.map((attachment) =>
    transformAttachment(attachment, ticket.id),
  )

  // Calculate days to close
  const daysToClose = calculateDaysToClose(
    ticket.createdTime,
    ticket.closedTime,
  )

  // Build Vespa document
  const vespaDoc: VespaZohoTicketBase = {
    // Core Identifiers
    id: ticket.id,
    ticketNumber: ticket.ticketNumber,
    departmentId: ticket.departmentId || "",
    departmentName: ticket.department?.name || "",
    accountName: ticket.account?.accountName || "",
    productName: ticket.product?.productName || "",
    teamName: ticket.team?.name || "",

    // Core Ticket Fields
    subject: ticket.subject || "",
    description: ticket.description || "",
    category: ticket.category || "",
    subCategory: ticket.subCategory || "",
    classification: ticket.classification || "",
    priority: ticket.priority || "",
    status: ticket.status || "",
    resolution: ticket.resolution || "",
    webUrl:
      ticket.webUrl || `https://desk.zoho.com/support/tickets/${ticket.id}`,
    sourceType: ticket.source?.type || "",
    platform: "zoho-desk", // Platform identifier for generic ticket schema
    channel: ticket.channel || "",
    contactEmail: ticket.email || ticket.contact?.email || "",
    assigneeEmail: ticket.assignee?.email || "",
    createdByEmail: ticket.createdBy?.email || "",
    modifiedByEmail: ticket.modifiedBy?.email || "",
    sharedDepartments: ticket.sharedDepartments || [],

    // Custom Fields
    merchantId: ticket.cf?.cf_merchant_id_1 || "",
    productDetails: ticket.cf?.cf_product_details || "",
    firstResponseTime: ticket.cf?.cf_first_response_time
      ? new Date(ticket.cf.cf_first_response_time).getTime()
      : null,
    resolutionTime: ticket.cf?.cf_resolution_time_1
      ? new Date(ticket.cf.cf_resolution_time_1).getTime()
      : null,
    onHoldStartTime: ticket.cf?.cf_on_hold_start_time
      ? new Date(ticket.cf.cf_on_hold_start_time).getTime()
      : null,
    onHoldEndTime: ticket.cf?.cf_on_hold_end_time
      ? new Date(ticket.cf.cf_on_hold_end_time).getTime()
      : null,
    escalatedEndDate: ticket.cf?.cf_escalated_end_date
      ? new Date(ticket.cf.cf_escalated_end_date).getTime()
      : null,

    // Boolean Flags
    isOverDue: ticket.isOverDue || false,
    isResponseOverdue: ticket.isResponseOverdue || false,
    isEscalated: ticket.isEscalated || false,

    // Time Fields (convert ISO to epoch milliseconds)
    createdTime: new Date(ticket.createdTime).getTime(),
    modifiedTime: new Date(ticket.modifiedTime).getTime(),
    closedTime: ticket.closedTime
      ? new Date(ticket.closedTime).getTime()
      : null,
    dueDate: ticket.dueDate ? new Date(ticket.dueDate).getTime() : null,
    daysToClose,

    // Derived & NLP Summaries (initially empty, will be filled asynchronously by summary worker)
    // Summaries are generated via queue jobs and updated in Vespa after LLM processing
    threadSummary: "",
    commentSummary: "",
    wholeResolutionSummary: "",

    // Flattened text arrays for BM25 search (no embeddings)
    threadMessages: vespaThreads
      .map((t) => t.messageText)
      .filter((msg) => msg && msg.trim().length > 0),
    commentMessages: vespaComments
      .map((c) => c.messageText)
      .filter((msg) => msg && msg.trim().length > 0),
    attachmentTexts: [
      ...vespaTicketAttachments.map((a) => a.attachmentDetail),
      ...vespaThreads.flatMap(
        (t) => t.attachmentDetails?.map((a) => a.attachmentDetail) || [],
      ),
      ...vespaComments.flatMap(
        (c) => c.attachmentDetails?.map((a) => a.attachmentDetail) || [],
      ),
    ].filter((text) => text && text.trim().length > 0),

    // Email recipients and mentions
    to: allEmails.to,
    cc: allEmails.cc,
    bcc: allEmails.bcc,
    mentions: allEmails.mentions,

    // Thread & Comment Structures
    threads: vespaThreads,
    comments: vespaComments,

    // Ticket-level attachments
    ticketAttachments: vespaTicketAttachments,
  }

  return vespaDoc
}

/**
 * Enqueue summary generation jobs for threads and comments
 * Jobs are processed asynchronously by the summary worker
 * Called from queue.ts AFTER ticket is successfully inserted to Vespa
 */
export async function enqueueSummaryJobs(
  ticket: ZohoTicket,
  threads: VespaThreadSchema[],
  comments: VespaThreadSchema[],
) {
  const ticketId = ticket.id

  // Enqueue individual thread summary jobs
  if (threads.length > 0) {
    for (let i = 0; i < threads.length; i++) {
      const thread = threads[i]
      await enqueueIndividualSummary(
        ticketId,
        thread.id,
        thread.messageText || "",
        thread.authorEmail || "Unknown",
        "thread",
        i, // itemIndex
        threads.length, // totalItems
      )
    }
    logger.info(`Enqueued ${threads.length} thread summary jobs`, { ticketId })
  } else {
    // No threads - mark thread aggregate as not needed
    logger.info("No threads to summarize", { ticketId })
  }

  // Enqueue individual comment summary jobs
  if (comments.length > 0) {
    for (let i = 0; i < comments.length; i++) {
      const comment = comments[i]
      await enqueueIndividualSummary(
        ticketId,
        comment.id,
        comment.messageText || "",
        comment.authorEmail || "Unknown",
        "comment",
        i, // itemIndex
        comments.length, // totalItems
      )
    }
    logger.info(`Enqueued ${comments.length} comment summary jobs`, {
      ticketId,
    })
  } else {
    // No comments - mark comment aggregate as not needed
    logger.info("No comments to summarize", { ticketId })
  }

  // If both threads and comments are empty, we still need to generate wholeResolutionSummary
  // This will be handled by checking the counts in the worker
  if (threads.length === 0 && comments.length === 0) {
    logger.info(
      "Ticket has no threads or comments, wholeResolutionSummary will use only ticket metadata",
      {
        ticketId,
      },
    )
  }
}

/**
 * Transform a Zoho thread/comment to Vespa thread schema
 */
function transformThread(
  thread: ZohoThread,
  ticketId: string,
): VespaThreadSchema {
  // Transform attachments
  const attachmentDetails =
    thread.attachments?.map((att) => transformAttachment(att, ticketId)) || []

  return {
    id: thread.id,
    messageText: thread.plainText || thread.content || thread.summary || "",
    attachmentDetails,
    authorEmail: thread.author?.email || "",
    link: `https://desk.zoho.com/support/tickets/${ticketId}/threads/${thread.id}`,
    createdTime: thread.createdTime,
  }
}

/**
 * Transform a Zoho attachment to Vespa attachment type
 */
function transformAttachment(
  attachment: ZohoAttachment,
  ticketId: string,
): VespaAttachmentType {
  // Determine file type from name
  const fileType = getFileType(attachment.name)

  return {
    attachmentId: attachment.id,
    attachmentName: attachment.name,
    attachmentDetail: "", // Will be filled after OCR processing
    attachmentUrl:
      attachment.href ||
      `https://desk.zoho.com/api/v1/tickets/${ticketId}/attachments/${attachment.id}/content`,
    processingStatus: "pending", // Initially pending OCR processing
    fileType,
    size: parseInt(attachment.size, 10) || 0, // Zoho returns size as string, convert to number
  }
}

/**
 * Extract all emails (to, cc, bcc, mentions) from threads and comments
 */
/**
 * Parse email string from Zoho format: "\"name\"<email>,\"name2\"<email2>,..."
 * Extracts emails from angle brackets: <email>
 */
function parseEmailString(emailStr: string): string[] {
  if (!emailStr || emailStr.trim() === "") {
    return []
  }

  const emails: string[] = []
  // Match emails inside angle brackets: <email@domain.com>
  const emailRegex = /<([^>]+)>/g
  let match

  while ((match = emailRegex.exec(emailStr)) !== null) {
    emails.push(match[1].trim())
  }

  return emails
}

function extractEmails(
  threads: ZohoThread[],
  comments: ZohoThread[],
): {
  to: string[]
  cc: string[]
  bcc: string[]
  mentions: string[]
} {
  const toSet = new Set<string>()
  const ccSet = new Set<string>()
  const bccSet = new Set<string>()
  const mentionsSet = new Set<string>()

  const allItems = [...threads, ...comments]

  for (const item of allItems) {
    // Extract to emails (Zoho returns comma-separated string like: "\"name\"<email>,...")
    if (item.to && typeof item.to === "string") {
      const emails = parseEmailString(item.to)
      emails.forEach((email) => toSet.add(email))
    }

    // Extract cc emails
    if (item.cc && typeof item.cc === "string") {
      const emails = parseEmailString(item.cc)
      emails.forEach((email) => ccSet.add(email))
    }

    // Extract bcc emails
    if (item.bcc && typeof item.bcc === "string") {
      const emails = parseEmailString(item.bcc)
      emails.forEach((email) => bccSet.add(email))
    }

    // Extract mentions from content (simple regex for @email patterns)
    const content = item.content || item.plainText || ""
    const mentionMatches = content.match(/@[\w.-]+@[\w.-]+/g)
    if (mentionMatches) {
      mentionMatches.forEach((mention) => {
        // Remove @ prefix
        const email = mention.substring(1)
        mentionsSet.add(email)
      })
    }
  }

  return {
    to: Array.from(toSet),
    cc: Array.from(ccSet),
    bcc: Array.from(bccSet),
    mentions: Array.from(mentionsSet),
  }
}

/**
 * Calculate days to close from created time to closed time
 */
function calculateDaysToClose(
  createdTime: string,
  closedTime: string | null,
): number | null {
  if (!closedTime) {
    return null
  }

  const created = new Date(createdTime).getTime()
  const closed = new Date(closedTime).getTime()
  const diffMs = closed - created
  const diffDays = diffMs / (1000 * 60 * 60 * 24)

  return Math.round(diffDays * 100) / 100 // Round to 2 decimal places
}

/**
 * Determine file type from filename
 */
function getFileType(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase()

  const typeMap: Record<string, string> = {
    pdf: "pdf",
    doc: "doc",
    docx: "doc",
    xls: "excel",
    xlsx: "excel",
    csv: "csv",
    txt: "text",
    jpg: "image",
    jpeg: "image",
    png: "image",
    gif: "image",
    bmp: "image",
    svg: "image",
    zip: "archive",
    rar: "archive",
    "7z": "archive",
    mp4: "video",
    avi: "video",
    mov: "video",
    mp3: "audio",
    wav: "audio",
  }

  return typeMap[extension || ""] || "unknown"
}

export function countTotalAttachments(ticket: VespaZohoTicketBase): number {
  const ticketAttachments = ticket.ticketAttachments?.length || 0
  const threadAttachments = ticket.threads.reduce(
    (sum, t) => sum + (t.attachmentDetails?.length || 0),
    0,
  )
  const commentAttachments = ticket.comments.reduce(
    (sum, c) => sum + (c.attachmentDetails?.length || 0),
    0,
  )

  return ticketAttachments + threadAttachments + commentAttachments
}
