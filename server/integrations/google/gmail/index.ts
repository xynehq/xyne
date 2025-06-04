import { chunkTextByParagraph } from "@/chunks"
import { EmailParsingError } from "@/errors"
import { getLogger } from "@/logger"
import {
  Apps,
  MailAttachmentEntity,
  mailAttachmentSchema,
  MailEntity,
  mailSchema,
  type Attachment,
  type Mail,
  type MailAttachment,
  type VespaMailAttachment,
} from "@/search/types"
import { ifMailDocumentsExist, insert } from "@/search/vespa"
import { Subsystem, type GoogleClient } from "@/types"
import { gmail_v1, google } from "googleapis"
import { parseEmailBody } from "./quote-parser"
import pLimit from "p-limit"
import { GmailConcurrency } from "@/integrations/google/config"
import { retryWithBackoff } from "@/utils"
import { StatType, Tracker } from "@/integrations/tracker"
const htmlToText = require("html-to-text")
const Logger = getLogger(Subsystem.Integrations)
import { batchFetchImplementation } from "@jrmdayn/googleapis-batcher"
import {
  getGmailAttachmentChunks,
  parseAttachments,
} from "@/integrations/google/worker-utils"
import {
  ingestionMailErrorsTotal,
  totalAttachmentError,
  totalAttachmentIngested,
  totalIngestedMails,
} from "@/metrics/google/gmail-metrics"
import { skipMailExistCheck } from "@/integrations/google/config"

export const handleGmailIngestion = async (
  client: GoogleClient,
  email: string,
  tracker: Tracker,
): Promise<string> => {
  const batchSize = 100
  const fetchImpl = batchFetchImplementation({ maxBatchSize: batchSize })
  const gmail = google.gmail({
    version: "v1",
    auth: client,
    fetchImplementation: fetchImpl,
  })
  let totalMails = 0
  let nextPageToken = ""
  const limit = pLimit(GmailConcurrency)

  const profile = await retryWithBackoff(
    () => gmail.users.getProfile({ userId: "me" }),
    "Fetching Gmail user profile",
    Apps.Gmail,
    0,
    client,
  )
  const historyId = profile.data.historyId!
  if (!historyId) {
    throw new Error("Could not get historyId from getProfile")
  }

  do {
    const resp = await retryWithBackoff(
      () =>
        gmail.users.messages.list({
          userId: "me",
          includeSpamTrash: false,
          maxResults: batchSize,
          pageToken: nextPageToken,
          fields: "messages(id), nextPageToken",
          q: "-in:promotions",
        }),
      `Fetching Gmail messages list (pageToken: ${nextPageToken})`,
      Apps.Gmail,
      0,
      client,
    )

    nextPageToken = resp.data.nextPageToken ?? ""
    if (resp.data.messages) {
      let messageBatch = resp.data.messages.slice(0, batchSize)
      let batchRequests = messageBatch.map((message) =>
        limit(async () => {
          let msgResp
          try {
            msgResp = await retryWithBackoff(
              () =>
                gmail.users.messages.get({
                  userId: "me",
                  id: message.id!,
                  format: "full",
                }),
              `Fetching Gmail message (id: ${message.id})`,
              Apps.Gmail,
              0,
              client,
            )
            const { mailData, exist } = await parseMail(
              msgResp.data,
              gmail,
              email,
              client,
              tracker,
            )
            if (!exist) {
              await insert(mailData, mailSchema)


              totalIngestedMails.inc(
                {
                  mime_type: message.payload?.mimeType ?? "GOOGLE_MAIL",
                  status: "GMAIL_INGEST_SUCCESS",
                  email: email,
                  account_type: "OAUTH_ACCOUNT",
                },
                1,
              )

              tracker.updateUserStats(email, StatType.Gmail, 1)
            }
          } catch (error) {
            Logger.error(
              error,
              `Failed to process message ${message.id}: ${(error as Error).message}`,
            )
            ingestionMailErrorsTotal.inc(
              {
                mime_type: message.payload?.mimeType ?? "GOOGLE_MAIL",
                status: "FAILED",
                error_type: "ERROR_IN_GMAIL_INGESTION",
              },
              1,
            )
          } finally {
            // release from memory
            msgResp = null
          }
        }),
      )

      // Process batch of messages in parallel
      await Promise.allSettled(batchRequests)
      totalMails += messageBatch.length

      // clean up explicitly
      batchRequests = []
      messageBatch = []
    }
  } while (nextPageToken)

  Logger.info(`Inserted ${totalMails} mails`)
  return historyId
}

const extractEmailAddresses = (headerValue: string): string[] => {
  if (!headerValue) return []

  // Regular expression to match anything inside angle brackets
  const emailRegex = /<([^>]+)>/g

  const addresses: string[] = []
  let match

  const emailWithNames = headerValue
    .split(",")
    .map((addr) => addr.trim().toLowerCase())
    .filter(Boolean)
  for (const emailWithName of emailWithNames) {
    // it's not in the name <emai> format
    if (emailWithName.indexOf("<") == -1) {
      addresses.push(emailWithName)
      continue
    }
    match = emailRegex.exec(emailWithName)
    if (match !== null && match[1]) {
      addresses.push(match[1].toLowerCase())
    }
  }
  return addresses
}

// Function to parse and validate email data
export const parseMail = async (
  email: gmail_v1.Schema$Message,
  gmail: gmail_v1.Gmail,
  userEmail: string,
  client: GoogleClient,
  tracker?: Tracker,
): Promise<{ mailData: Mail; exist: boolean }> => {
  const messageId = email.id
  const threadId = email.threadId
  let timestamp = parseInt(email.internalDate ?? "", 10)
  const labels = email.labelIds

  const payload: gmail_v1.Schema$MessagePart | undefined = email.payload
  const headers = payload?.headers || []

  const getHeader = (name: string) => {
    const header = headers.find(
      (h: any) => h.name.toLowerCase() === name.toLowerCase(),
    )
    return header ? header.value : ""
  }

  const fromEmailArray = extractEmailAddresses(getHeader("From") ?? "")
  if (!fromEmailArray || !fromEmailArray.length) {
    throw new EmailParsingError({
      integration: Apps.Gmail,
      entity: "",
      message: `Could not get From email address: ${getHeader("From")}`,
    })
  }
  const from = fromEmailArray[0]
  const to = extractEmailAddresses(
    getHeader("To") ?? getHeader("Delivered-To") ?? "",
  )
  const cc = extractEmailAddresses(getHeader("Cc") ?? "")
  const bcc = extractEmailAddresses(getHeader("Bcc") ?? "")
  const subject = getHeader("Subject") || ""
  const mailId =
    getHeader("Message-Id")?.replace(/^<|>$/g, "") || messageId || undefined
  let exist = false
  if (mailId) {
    try {
      const res = await ifMailDocumentsExist([mailId])
      if (res[mailId]?.exists && !skipMailExistCheck) {
        exist = true
      }
    } catch (error) {
      Logger.warn(
        error,
        `Failed to check mail existence for mailId: ${mailId}, proceeding with insertion`,
      )
      exist = false
    }
  }
  // Handle timestamp from Date header if available
  const dateHeader = getHeader("Date")
  if (dateHeader) {
    const date = new Date(dateHeader)
    if (!isNaN(date.getTime())) {
      timestamp = date.getTime()
    }
  } else if (!timestamp) {
    console.warn("No valid date found for email:", messageId)
    timestamp = Date.now()
  }

  // Permissions include all unique email addresses involved
  const permissions = Array.from(
    new Set(
      [from, ...to, ...cc, ...bcc]
        .map((email) => email?.toLowerCase() ?? "")
        .filter((v) => !!v),
    ),
  )

  // Extract body and chunks
  const body = getBody(payload)
  const chunks = chunkTextByParagraph(body).filter((v) => v)

  if (!messageId || !threadId) {
    throw new Error("Invalid message")
  }

  let attachments: Attachment[] = []
  let filenames: string[] = []
  if (payload && !exist) {
    const parsedParts = parseAttachments(payload)
    attachments = parsedParts.attachments
    filenames = parsedParts.filenames

    // ingest attachments
    // TODO:
    // Prevent indexing duplicate attachments from forwarded emails for the same user.
    // When an email is forwarded within a thread, its attachments may be duplicated.
    // - For non-forwarded emails, we can use the threadId to check if an attachment already exists in the thread.
    // - For forwarded emails, we should still index the attachments but possibly adjust their permissions?
    // - what If a forwarded email includes new attachments, should we rely on the filename to differentiate them?
    if (payload.parts) {
      for (const part of payload.parts) {
        const { body, filename, mimeType } = part
        if (
          mimeType === "application/pdf" &&
          filename &&
          body &&
          body.attachmentId
        ) {
          try {
            const { attachmentId, size } = body
            const attachmentChunks = await getGmailAttachmentChunks(
              gmail,
              {
                attachmentId: attachmentId,
                filename: filename,
                size: size ? size : 0,
                messageId: messageId,
              },
              client,
            )
            if (!attachmentChunks) continue

            const attachmentDoc: MailAttachment = {
              app: Apps.Gmail,
              entity: MailAttachmentEntity.PDF,
              mailId: messageId,
              partId: part.partId ? parseInt(part.partId) : null,
              docId: attachmentId,
              filename: filename,
              fileSize: size,
              fileType: mimeType,
              chunks: attachmentChunks,
              threadId: threadId,
              timestamp,
              permissions,
            }

            await insert(attachmentDoc, mailAttachmentSchema)
            tracker?.updateUserStats(userEmail, StatType.Mail_Attachments, 1)

            totalAttachmentIngested.inc(
              {
                mail_id: messageId,
                mime_type: mimeType,
                attachment_id: attachmentId,
                status: "SUCCESS",
                account_type: "OAUTH_ACCOUNT",
                email: userEmail,
              },
              1,
            )

          } catch (error) {
            // not throwing error; avoid disrupting the flow if retrieving an attachment fails,
            // log the error and proceed.
            Logger.error(
              error,
              `Error retrieving attachment files: ${error} ${(error as Error).stack}, Skipping it`,
              error,
            )
            totalAttachmentError.inc(
              {
                mail_id: messageId,
                mime_type: mimeType,
                attachment_id: body.attachmentId ?? "",
                status: "FAILED",
                email: userEmail,
                error_type: "ERROR_INSERTING_ATTACHMENT",
              },
              1,
            )
          }
        }
      }
    }
  }

  const emailData: Mail = {
    docId: messageId,
    threadId: threadId,
    mailId: mailId,
    subject: subject,
    chunks: chunks,
    timestamp: timestamp,
    app: Apps.Gmail,
    entity: MailEntity.Email,
    permissions: permissions,
    from: from,
    to: to,
    cc: cc,
    bcc: bcc,
    mimeType: payload?.mimeType ?? "text/plain",
    attachmentFilenames: filenames,
    attachments,
    labels: labels ?? [],
  }

  return { mailData: emailData, exist: exist }
}

const getBody = (payload: any): string => {
  let body = ""

  if (payload.parts && payload.parts.length > 0) {
    for (const part of payload.parts) {
      if (part.body?.data) {
        const decodedData = Buffer.from(part.body.data, "base64").toString(
          "utf-8",
        )

        // Check if the part is HTML or plain text and process accordingly
        if (part.mimeType === "text/html") {
          body += htmlToText.convert(decodedData, { wordwrap: 130 }) + "\n"
        } else if (part.mimeType === "text/plain") {
          body += decodedData + "\n"
        }
      } else if (part.parts) {
        // Recursively extract body from nested parts
        body += getBody(part)
      }
    }
  } else if (payload.body?.data) {
    // Base case for simple body structure
    const decodedData = Buffer.from(payload.body.data, "base64").toString(
      "utf-8",
    )
    body +=
      payload.mimeType === "text/html"
        ? htmlToText.convert(decodedData, { wordwrap: 130 })
        : decodedData
  }

  const data = parseEmailBody(body).replace(/[\r?\n]+/g, "\n")

  return data
}
