import { chunkTextByParagraph } from "@/chunks"
import { EmailParsingError } from "@/errors"
import { getLogger } from "@/logger"
import { Apps, mailSchema, type Attachment, type Mail } from "@/search/types"
import { insert } from "@/search/vespa"
import { Subsystem, type GoogleClient } from "@/types"
import { gmail_v1, google } from "googleapis"
import { parseEmailBody } from "./quote-parser"
import pLimit from "p-limit"
import { GmailConcurrency } from "../config"
const htmlToText = require("html-to-text")
const Logger = getLogger(Subsystem.Integrations)

export const handleGmailIngestion = async (
  client: GoogleClient,
  email: string,
): Promise<string> => {
  const gmail = google.gmail({ version: "v1", auth: client })
  let totalMails = 0
  let nextPageToken = ""

  const limit = pLimit(GmailConcurrency)
  let historyId: string = ""
  do {
    const resp = await gmail.users.messages.list({
      userId: "me",
      maxResults: 100,
      pageToken: nextPageToken,
    })
    nextPageToken = resp.data.nextPageToken ?? ""
    if (resp.data.messages) {
      totalMails += resp.data.messages.length
      const firstMessage = resp.data.messages.shift()
      // we want to set the history Id for the first message itself
      // to prevent any discrepency
      if (firstMessage) {
        const firstMsgResp = await gmail.users.messages.get({
          userId: "me",
          id: firstMessage.id!,
          format: "full",
        })

        if (firstMsgResp.data.historyId) {
          historyId = firstMsgResp.data.historyId
          Logger.info(`History ID set from the first message: ${historyId}`)
        }
        await insert(parseMail(firstMsgResp.data), mailSchema)
      }
      const messagePromises = resp.data.messages.map((message) =>
        limit(async () => {
          const msgResp = await gmail.users.messages.get({
            userId: "me",
            id: message.id!,
            format: "full",
          })
          if (!historyId) {
          }
          await insert(parseMail(msgResp.data), mailSchema)
        }),
      )
      // Process messages in parallel for each page
      await Promise.all(messagePromises)
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
export const parseMail = (email: gmail_v1.Schema$Message): Mail => {
  const messageId = email.id
  const threadId = email.threadId
  let timestamp = parseInt(email.internalDate ?? "", 10)

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
  const chunks = chunkTextByParagraph(body)

  let attachments: Attachment[] = []
  let filenames: string[] = []
  if (payload) {
    const parsedParts = parseAttachments(payload)
    attachments = parsedParts.attachments
    filenames = parsedParts.filenames
  }

  if (!messageId || !threadId) {
    throw new Error("Invalid message")
  }

  const emailData: Mail = {
    docId: messageId,
    threadId: threadId,
    subject: subject,
    chunks: chunks,
    timestamp: timestamp,
    app: Apps.Gmail,
    entity: "mail",
    permissions: permissions,
    from: from,
    to: to,
    cc: cc,
    bcc: bcc,
    mimeType: payload?.mimeType ?? "text/plain",
    attachmentFilenames: filenames,
    attachments,
  }

  return emailData
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

// Function to parse attachments from the email payload
const parseAttachments = (
  payload: gmail_v1.Schema$MessagePart,
): { attachments: Attachment[]; filenames: string[] } => {
  const attachments: Attachment[] = []
  const filenames: string[] = []

  const traverseParts = (parts: any[]) => {
    for (const part of parts) {
      if (part.filename && part.body && part.body.attachmentId) {
        filenames.push(part.filename)
        attachments.push({
          fileType: part.mimeType || "application/octet-stream",
          fileSize: parseInt(part.body.size, 10) || 0,
        })
      } else if (part.parts) {
        traverseParts(part.parts)
      }
    }
  }

  if (payload.parts) {
    traverseParts(payload.parts)
  }

  return { attachments, filenames }
}
