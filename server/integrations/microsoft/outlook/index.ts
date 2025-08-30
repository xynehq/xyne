import { Apps } from "@/shared/types"
import {
  MailEntity,
  mailSchema,
  mailAttachmentSchema,
  type Mail,
  type Attachment,
} from "@/search/types"
import { ifMailDocumentsExist, insert } from "@/search/vespa"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { StatType, Tracker } from "@/integrations/tracker"
import { chunkTextByParagraph } from "@/chunks"
import { makeGraphApiCall, type MicrosoftGraphClient } from "../client"
import {
  getOutlookAttachmentChunks,
  getOutlookSpreadsheetSheets,
  parseOutlookAttachments,
  getMailAttachmentEntity,
  isSpreadsheetFile,
  isValidMimeType,
} from "../attachment-utils"
import pLimit from "p-limit"
import fs from "node:fs"
import path from "node:path"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "microsoft-outlook",
})

export const loggerWithChild = getLoggerWithChild(Subsystem.Integrations, {
  module: "microsoft-outlook",
})

// Convert HTML to text (similar to Google's implementation)
const htmlToText = require("html-to-text")

export const getTextFromEventDescription = (description: string): string => {
  return htmlToText.convert(description, { wordwrap: 130 })
}

// Function to parse and validate Outlook email data
export const parseMail = async (
  message: any,
  client: MicrosoftGraphClient,
  userEmail: string,
  tracker?: Tracker,
): Promise<{ mailData: Mail }> => {
  const messageId = message.id
  const conversationId = message.conversationId
  const internetMessageId = message.internetMessageId
  let timestamp = new Date(
    message.receivedDateTime || message.sentDateTime,
  ).getTime()

  // Extract email addresses
  const extractEmailAddresses = (recipients: any[]): string[] => {
    if (!recipients || !Array.isArray(recipients)) return []
    return recipients
      .map((recipient) => recipient.emailAddress?.address)
      .filter(Boolean)
      .map((email) => email.toLowerCase())
  }

  const from = message.from?.emailAddress?.address?.toLowerCase() || ""
  const to = extractEmailAddresses(message.toRecipients || [])
  const cc = extractEmailAddresses(message.ccRecipients || [])
  const bcc = extractEmailAddresses(message.bccRecipients || [])
  const subject = message.subject || ""

  // Use internetMessageId as mailId, fallback to messageId
  const mailId = internetMessageId || messageId || undefined
  let docId = messageId
  let userMap: Record<string, string> = {}
  let mailExist = false

  // Check if mail exists using internetMessageId (same as Google implementation)
  if (mailId) {
    try {
      const res = await ifMailDocumentsExist([mailId])
      if (res[mailId] && res[mailId]?.exists) {
        mailExist = true
        userMap = res[mailId].userMap || {}
        docId = res[mailId].docId
      }
    } catch (error) {
      Logger.warn(
        error,
        `Failed to check mail existence for mailId: ${mailId}, proceeding with insertion`,
      )
    }
  }

  // Permissions include all unique email addresses involved
  const permissions = Array.from(
    new Set([from, ...to, ...cc, ...bcc].filter((email) => !!email)),
  )

  // Extract body and chunks
  const body = message.body?.content
    ? getTextFromEventDescription(message.body.content)
    : ""
  const chunks = chunkTextByParagraph(body).filter((v) => v)

  if (!messageId || !conversationId) {
    throw new Error("Invalid message: missing messageId or conversationId")
  }

  let attachments: Attachment[] = []
  let filenames: string[] = []

  // Process attachments if message has them and mail doesn't already exist
  if (message.hasAttachments && !mailExist) {
    try {
      // First, get the list of attachments for this message
      const attachmentsResponse = await makeGraphApiCall(
        client,
        `/me/messages/${messageId}/attachments?$select=id,name,contentType,size,isInline`,
      )

      if (attachmentsResponse.value && attachmentsResponse.value.length > 0) {
        const parsedAttachments = parseOutlookAttachments(
          attachmentsResponse.value,
        )
        attachments = parsedAttachments.attachments
        filenames = parsedAttachments.filenames

        // Process each attachment for content extraction
        for (const attachment of attachmentsResponse.value) {
          try {
            const {
              id: attachmentId,
              name: filename,
              contentType: mimeType,
              size,
            } = attachment

            if (!filename || !mimeType || !isValidMimeType(mimeType)) {
              loggerWithChild({ email: userEmail }).info(
                `Skipping attachment ${filename} with unsupported MIME type: ${mimeType}`,
              )
              continue
            }

            // Handle spreadsheet files differently to process each sheet separately
            if (isSpreadsheetFile(mimeType)) {
              const sheetsData = await getOutlookSpreadsheetSheets(client, {
                messageId,
                attachmentId,
                filename,
                size: size || 0,
                mimeType,
              })

              if (!sheetsData || sheetsData.length === 0) continue

              // Create separate attachment documents for each sheet
              for (const [sheetIndex, sheetData] of sheetsData.entries()) {
                const sheetDocId =
                  sheetsData.length > 1
                    ? `${attachmentId}_${sheetData.sheetIndex}`
                    : attachmentId

                const sheetFilename =
                  sheetsData.length > 1
                    ? `${filename} / ${sheetData.sheetName}`
                    : filename

                const attachmentDoc = {
                  app: Apps.MicrosoftOutlook,
                  entity: getMailAttachmentEntity(mimeType),
                  mailId: messageId,
                  partId: null, // Microsoft doesn't use partId like Gmail
                  docId: sheetDocId,
                  filename: sheetFilename,
                  fileSize: size || 0,
                  fileType: mimeType,
                  chunks: sheetData.chunks,
                  threadId: conversationId,
                  timestamp,
                  permissions,
                }

                await insert(attachmentDoc, mailAttachmentSchema)
                tracker?.updateUserStats(
                  userEmail,
                  StatType.Mail_Attachments,
                  1,
                )

                // TODO: Add metrics similar to Google implementation
                // totalAttachmentIngested.inc(...)
              }
            } else {
              // Handle non-spreadsheet files
              const attachmentChunks = await getOutlookAttachmentChunks(
                client,
                {
                  messageId,
                  attachmentId,
                  filename,
                  size: size || 0,
                  mimeType,
                },
              )

              if (!attachmentChunks) continue

              const attachmentDoc = {
                app: Apps.MicrosoftOutlook,
                entity: getMailAttachmentEntity(mimeType),
                mailId: messageId,
                partId: null, // Microsoft doesn't use partId like Gmail
                docId: attachmentId,
                filename: filename,
                fileSize: size || 0,
                fileType: mimeType,
                chunks: attachmentChunks,
                threadId: conversationId,
                timestamp,
                permissions,
              }

              await insert(attachmentDoc, mailAttachmentSchema)
              tracker?.updateUserStats(userEmail, StatType.Mail_Attachments, 1)

              // TODO : metric for attachment has to be added
            }
          } catch (error) {
            Logger.error(
              error,
              `Error retrieving Outlook attachment: ${attachment.name} - ${error}`,
            )
            // TODO: Add error metrics for attachment
          }
        }
      }
    } catch (error) {
      Logger.error(
        error,
        `Error processing attachments for message ${messageId}: ${error}`,
      )
    }
  }

  userMap[userEmail] = messageId
  const emailData: Mail = {
    docId: docId!,
    threadId: conversationId,
    mailId: mailId,
    subject: subject,
    chunks: chunks,
    timestamp: timestamp,
    app: Apps.MicrosoftOutlook,
    userMap: userMap,
    entity: MailEntity.Email,
    permissions: permissions,
    from: from,
    to: to,
    cc: cc,
    bcc: bcc,
    mimeType: message.body?.contentType || "text/html",
    attachmentFilenames: filenames,
    attachments,
    labels: [], // OutLook don't have any labels
  }

  return { mailData: emailData }
}

// Outlook email ingestion implementation
export const handleOutlookIngestion = async (
  client: MicrosoftGraphClient,
  userEmail: string,
  tracker: Tracker,
  startDate?: string,
  endDate?: string,
): Promise<string> => {
  const batchSize = 100
  let totalMails = 0
  let nextPageToken = ""
  const limit = pLimit(10) // Concurrency limit for processing messages

  let deltaToken = ""

  const queryParams: any = {
    $top: batchSize,
    $select:
      "id,subject,body,receivedDateTime,sentDateTime,from,toRecipients,ccRecipients,bccRecipients,hasAttachments,internetMessageId,conversationId",
  }

  if (startDate || endDate) {
    const filters: string[] = []
    if (startDate) {
      const startDateObj = new Date(startDate)
      filters.push(`receivedDateTime ge ${startDateObj.toISOString()}`)
    }
    if (endDate) {
      const endDateObj = new Date(endDate)
      endDateObj.setDate(endDateObj.getDate() + 1)
      filters.push(`receivedDateTime lt ${endDateObj.toISOString()}`)
    }
    if (filters.length > 0) {
      queryParams.$filter = filters.join(" and ")
    }
  }

  do {
    const endpoint = nextPageToken
      ? nextPageToken
      : `/me/messages?${new URLSearchParams(queryParams).toString()}`

    const response = await makeGraphApiCall(client, endpoint)

    nextPageToken = response["@odata.nextLink"] ?? ""
    deltaToken = response["@odata.deltaLink"] || deltaToken

    if (response.value) {
      let messageBatch = response.value.slice(0, batchSize)
      let batchRequests = messageBatch.map((message: any) =>
        limit(async () => {
          try {
            let mailExists = false
            if (message.internetMessageId) {
              // Check if mail exists using internetMessageId
              const res = await ifMailDocumentsExist([
                message.internetMessageId,
              ])
              if (
                res[message.internetMessageId] &&
                res[message.internetMessageId]?.exists
              ) {
                mailExists = true
                Logger.info(
                  `Skipping mail with internetMessageId: ${message.internetMessageId}`,
                )
                return
              }
            }

            const { mailData } = await parseMail(
              message,
              client,
              userEmail,
              tracker,
            )

            await insert(mailData, mailSchema)
            // metric has to be added for OutLook
          } catch (error) {
            Logger.child({ email: userEmail }).error(
              error,
              `Failed to process Outlook message ${message.id}: ${(error as Error).message}`,
            )
            // failing metric has to be added for OutLook
          }
        }),
      )

      // Process batch of messages in parallel
      await Promise.allSettled(batchRequests)
      totalMails += messageBatch.length

      // Clean up explicitly
      batchRequests = []
      messageBatch = []
    }
  } while (nextPageToken)

  Logger.child({ email: userEmail }).info(
    `Inserted ${totalMails} Outlook emails`,
  )
  return deltaToken || "outlook-delta-token"
}
