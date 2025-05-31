import type { PublicUserWorkspace } from "@/db/schema"
import {
  chatMessageSchema,
  eventSchema,
  fileSchema,
  mailAttachmentSchema,
  mailSchema,
  userSchema,
  VespaSearchResultsSchema,
  type VespaEventSearch,
  type VespaFileSearch,
  type VespaMailAttachmentSearch,
  type VespaMailSearch,
  type VespaSearchResults,
  type VespaUser,
  type VespaChatMessageSearch,
  type ScoredChunk,
  transcriptSchema,
  type VespaTranscriptSearch,
} from "@/search/types"
import { getRelativeTime } from "@/utils"
import type { z } from "zod"
import pc from "picocolors"
import { getSortedScoredChunks } from "@/search/mappers"
import { getDateForAI } from "@/utils/index"

// Utility to capitalize the first letter of a string
const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1)

// Function for handling file context
const constructFileContext = (
  fields: VespaFileSearch,
  relevance: number,
  maxSummaryChunks?: number,
  isSelectedFiles?: boolean,
): string => {
  if (!maxSummaryChunks && !isSelectedFiles) {
    maxSummaryChunks = fields.chunks_summary?.length
  }

  let chunks: ScoredChunk[] = []
  if (fields.matchfeatures) {
    chunks = getSortedScoredChunks(
      fields.matchfeatures,
      fields.chunks_summary as string[],
    )
  } else {
    chunks =
      fields.chunks_summary?.map((chunk, idx) => ({
        chunk: typeof chunk == "string" ? chunk : chunk.chunk,
        index: idx,
        score: 0,
      })) || []
  }

  let content = ""
  if (isSelectedFiles && fields?.matchfeatures) {
    content = chunks
      .slice(0, maxSummaryChunks)
      .sort((a, b) => a.index - b.index)
      .map((v) => v.chunk)
      .join("\n")
  } else if (isSelectedFiles) {
    content = chunks.map((v) => v.chunk).join("\n")
  } else {
    content = chunks
      .map((v) => v.chunk)
      .slice(0, maxSummaryChunks)
      .join("\n")
  }

  return `App: ${fields.app}
Entity: ${fields.entity}
Title: ${fields.title ? `Title: ${fields.title}` : ""}${typeof fields.createdAt === "number" && isFinite(fields.createdAt) ? `\nCreated: ${getRelativeTime(fields.createdAt)}` : ""}${typeof fields.updatedAt === "number" && isFinite(fields.updatedAt) ? `\nUpdated At: ${getRelativeTime(fields.updatedAt)}` : ""}
${fields.owner ? `Owner: ${fields.owner}` : ""}
${fields.ownerEmail ? `Owner Email: ${fields.ownerEmail}` : ""}
${fields.mimeType ? `Mime Type: ${fields.mimeType}` : ""}
${fields.permissions ? `Permissions: ${fields.permissions.join(", ")}` : ""}
${fields.chunks_summary && fields.chunks_summary.length ? `Content: ${content}` : ""}
\nvespa relevance score: ${relevance}\n`
}

// TODO: tell if workspace that this is an employee
const constructUserContext = (fields: VespaUser, relevance: number): string => {
  return `App: ${fields.app}
Entity: ${fields.entity}${typeof fields.creationTime === "number" && isFinite(fields.creationTime) ? `\nAdded: ${getRelativeTime(fields.creationTime)}` : ""}
${fields.name ? `Name: ${fields.name}` : ""}
${fields.email ? `Email: ${fields.email}` : ""}
${fields.gender ? `Gender: ${fields.gender}` : ""}
${fields.orgJobTitle ? `Job Title: ${fields.orgJobTitle}` : ""}
${fields.orgDepartment ? `Department: ${fields.orgDepartment}` : ""}
${fields.orgLocation ? `Location: ${fields.orgLocation}` : ""}
vespa relevance score: ${relevance}`
}

const constructMailContext = (
  fields: VespaMailSearch,
  relevance: number,
  maxSummaryChunks?: number,
  isSelectedFiles?: boolean,
): string => {
  if (!maxSummaryChunks && !isSelectedFiles) {
    maxSummaryChunks = fields.chunks_summary?.length
  }

  let chunks: ScoredChunk[] = []
  if (fields.matchfeatures) {
    chunks = getSortedScoredChunks(
      fields.matchfeatures,
      fields.chunks_summary as string[],
    )
  } else {
    chunks =
      fields.chunks_summary?.map((chunk, idx) => ({
        chunk: typeof chunk == "string" ? chunk : chunk.chunk,
        index: idx,
        score: 0,
      })) || []
  }

  let content = ""
  if (isSelectedFiles && fields?.matchfeatures) {
    content = chunks
      .slice(0, maxSummaryChunks)
      .sort((a, b) => a.index - b.index)
      .map((v) => v.chunk)
      .join("\n")
  } else if (isSelectedFiles) {
    content = chunks.map((v) => v.chunk).join("\n")
  } else {
    content = chunks
      .map((v) => v.chunk)
      .slice(0, maxSummaryChunks)
      .join("\n")
  }

  return `App: ${fields.app}
Entity: ${fields.entity}${typeof fields.timestamp === "number" && isFinite(fields.timestamp) ? `\nSent: ${getRelativeTime(fields.timestamp)}` : ""}
${fields.subject ? `Subject: ${fields.subject}` : ""}
${fields.from ? `From: ${fields.from}` : ""}
${fields.to ? `To: ${fields.to.join(", ")}` : ""}
${fields.cc ? `Cc: ${fields.cc.join(", ")}` : ""}
${fields.bcc ? `Bcc: ${fields.bcc.join(", ")}` : ""}
${fields.labels ? `Labels: ${fields.labels.join(", ")}` : ""}
${fields.chunks_summary && fields.chunks_summary.length ? `Content: ${content}` : ""}
vespa relevance score: ${relevance}`
}

const constructSlackMessageContext = (
  fields: VespaChatMessageSearch,
  relevance: number,
): string => {
  let channelCtx = ``
  if (fields.isIm && fields.permissions) {
    channelCtx = `It's a DM between ${fields.permissions.join(", ")}`
  } else if (!fields.isPrivate) {
    // mpim and public channel
    channelCtx = `It's a message in ${fields.channelName}`
  } else {
    channelCtx = `It's a in private channel ${fields.channelName}`
  }
  return `${channelCtx}
    App: ${fields.app}
    Entity: ${fields.entity}
    User: ${fields.name}
    Username: ${fields.username}
    Message: ${fields.text}
    ${fields.threadId ? "it's a message thread" : ""}${typeof fields.createdAt === "number" && isFinite(fields.createdAt) ? `\n    Time: ${getRelativeTime(fields.createdAt)}` : ""}
    User is part of Workspace: ${fields.teamName}
    vespa relevance score: ${relevance}`
}

const constructMailAttachmentContext = (
  fields: VespaMailAttachmentSearch,
  relevance: number,
  maxSummaryChunks?: number,
  isSelectedFiles?: boolean,
): string => {
  if (!maxSummaryChunks && !isSelectedFiles) {
    maxSummaryChunks = fields.chunks_summary?.length
  }

  let chunks: ScoredChunk[] = []
  if (fields.matchfeatures) {
    chunks = getSortedScoredChunks(
      fields.matchfeatures,
      fields.chunks_summary as string[],
    )
  } else {
    chunks =
      fields.chunks_summary?.map((chunk, idx) => ({
        chunk: typeof chunk == "string" ? chunk : chunk.chunk,
        index: idx,
        score: 0,
      })) || []
  }

  let content = ""
  if (isSelectedFiles && fields?.matchfeatures) {
    content = chunks
      .slice(0, maxSummaryChunks)
      .sort((a, b) => a.index - b.index)
      .map((v) => v.chunk)
      .join("\n")
  } else if (isSelectedFiles) {
    content = chunks.map((v) => v.chunk).join("\n")
  } else {
    content = chunks
      .map((v) => v.chunk)
      .slice(0, maxSummaryChunks)
      .join("\n")
  }

  return `App: ${fields.app}
Entity: ${fields.entity}${typeof fields.timestamp === "number" && isFinite(fields.timestamp) ? `\nSent: ${getRelativeTime(fields.timestamp)}` : ""}
${fields.filename ? `Filename: ${fields.filename}` : ""}
${fields.partId ? `Attachment_no: ${fields.partId}` : ""}
${fields.chunks_summary && fields.chunks_summary.length ? `Content: ${content}` : ""}
vespa relevance score: ${relevance}`
}

const constructEventContext = (
  fields: VespaEventSearch,
  relevance: number,
): string => {
  return `App: ${fields.app}
Entity: ${fields.entity}
Event Name: ${fields.name ? `Name: ${fields.name}` : ""}
Description: ${fields.description ? fields.description.substring(0, 50) : ""}
Base URL: ${fields.baseUrl ? fields.baseUrl : "No base URL"}
Status: ${fields.status ? fields.status : "Status unknown"}
Location: ${fields.location ? fields.location : "No location specified"}${typeof fields.createdAt === "number" && isFinite(fields.createdAt) ? `\nCreated: ${getRelativeTime(fields.createdAt)}` : ""}${typeof fields.updatedAt === "number" && isFinite(fields.updatedAt) ? `\nUpdated: ${getRelativeTime(fields.updatedAt)}` : ""}
Today's Date: ${getDateForAI()}${typeof fields.startTime === "number" && isFinite(fields.startTime) ? `\nStart Time: ${!fields.defaultStartTime ? new Date(fields.startTime).toUTCString() : `No start time specified but date is ${new Date(fields.startTime)}`}` : ""}${typeof fields.endTime === "number" && isFinite(fields.endTime) ? `\nEnd Time: ${!fields.defaultStartTime ? new Date(fields.endTime).toUTCString() : `No end time specified but date is ${new Date(fields.endTime)}`}` : ""}
Organizer: ${fields.organizer ? fields.organizer.displayName : "No organizer specified"}
Attendees: ${
    fields.attendees && fields.attendees.length
      ? fields.attendees
          .map((attendee) => `${attendee.email} ${attendee.displayName}`)
          .join(", ")
      : "No attendees listed"
  }
Recurrence: ${
    fields.recurrence && fields.recurrence.length
      ? fields.recurrence.join(", ")
      : "No recurrence pattern specified"
  }
Joining Link: ${fields.joiningLink ? fields.joiningLink : "No meeting link available"}
Cancelled Instances: ${
    fields.cancelledInstances && fields.cancelledInstances.length
      ? fields.cancelledInstances.join(", ")
      : "No cancelled instances"
  }
${relevance ? `vespa relevance score: ${relevance}` : ""}`
}

// Function for handling file context
const constructFileMetadataContext = (
  fields: VespaFileSearch,
  relevance: number,
): string => {
  return `App: ${fields.app}
Entity: ${fields.entity}
Title: ${fields.title ? `Title: ${fields.title}` : ""}${typeof fields.createdAt === "number" && isFinite(fields.createdAt) ? `\nCreated: ${getRelativeTime(fields.createdAt)}` : ""}${typeof fields.updatedAt === "number" && isFinite(fields.updatedAt) ? `\nUpdated At: ${getRelativeTime(fields.updatedAt)}` : ""}
${fields.owner ? `Owner: ${fields.owner}` : ""}
${fields.ownerEmail ? `Owner Email: ${fields.ownerEmail}` : ""}
${fields.mimeType ? `Mime Type: ${fields.mimeType}` : ""}
${fields.permissions ? `Permissions: ${fields.permissions.join(", ")}` : ""}
vespa relevance score: ${relevance}`
}

// TODO: tell if workspace that this is an employee
const constructUserMetadataContext = (
  fields: VespaUser,
  relevance: number,
): string => {
  return `App: ${fields.app}
Entity: ${fields.entity}${typeof fields.creationTime === "number" && isFinite(fields.creationTime) ? `\nAdded: ${getRelativeTime(fields.creationTime)}` : ""}
${fields.name ? `Name: ${fields.name}` : ""}
${fields.email ? `Email: ${fields.email}` : ""}
${fields.gender ? `Gender: ${fields.gender}` : ""}
${fields.orgJobTitle ? `Job Title: ${fields.orgJobTitle}` : ""}
${fields.orgDepartment ? `Department: ${fields.orgDepartment}` : ""}
${fields.orgLocation ? `Location: ${fields.orgLocation}` : ""}
vespa relevance score: ${relevance}`
}

const constructMailMetadataContext = (
  fields: VespaMailSearch,
  relevance: number,
): string => {
  return `App: ${fields.app}
Entity: ${fields.entity}${typeof fields.timestamp === "number" && isFinite(fields.timestamp) ? `\nSent: ${getRelativeTime(fields.timestamp)}` : ""}
${fields.subject ? `Subject: ${fields.subject}` : ""}
${fields.from ? `From: ${fields.from}` : ""}
${fields.to ? `To: ${fields.to.join(", ")}` : ""}
${fields.cc ? `Cc: ${fields.cc.join(", ")}` : ""}
${fields.bcc ? `Bcc: ${fields.bcc.join(", ")}` : ""}
${fields.labels ? `Mailbox Labels: ${fields.labels.join(", ")}` : ""}
vespa relevance score: ${relevance}`
}

const constructMailAttachmentMetadataContext = (
  fields: VespaMailAttachmentSearch,
  relevance: number,
): string => {
  return `App: ${fields.app}
Entity: ${fields.entity}${typeof fields.timestamp === "number" && isFinite(fields.timestamp) ? `\ntimestamp: ${getRelativeTime(fields.timestamp)}` : ""}
${fields.partId ? `Attachment_no: ${fields.partId}` : ""}
${fields.filename ? `Filename: ${fields.filename}` : ""}
${fields.fileType ? `FileType: ${fields.fileType}` : ""}
vespa relevance score: ${relevance}`
}

const constructFileColoredContext = (
  fields: VespaFileSearch,
  relevance: number,
): string => {
  return `${pc.green("App")}: ${fields.app}
${pc.green("Entity")}: ${fields.entity}
${fields.title ? `${pc.green("Title")}: ${fields.title}` : ""}${typeof fields.createdAt === "number" && isFinite(fields.createdAt) ? `\n${pc.green("Created")}: ${getRelativeTime(fields.createdAt)}` : ""}${typeof fields.updatedAt === "number" && isFinite(fields.updatedAt) ? `\n${pc.green("Updated At")}: ${getRelativeTime(fields.updatedAt)}` : ""}
${fields.url ? `${pc.green("Link")}: ${pc.cyan(fields.url)}` : ""}
${fields.owner ? `${pc.green("Owner")}: ${fields.owner}` : ""}
${fields.ownerEmail ? `${pc.green("Owner Email")}: ${fields.ownerEmail}` : ""}
${fields.mimeType ? `${pc.green("Mime Type")}: ${fields.mimeType}` : ""}
${fields.permissions ? `${pc.green("Permissions")}: ${fields.permissions.join(", ")}` : ""}
${fields.chunks_summary && fields.chunks_summary.length ? `${pc.green("Content")}: ${fields.chunks_summary.join("\n")}` : ""}
\n${pc.green("vespa relevance score")}: ${relevance}`
}

const constructUserColoredContext = (
  fields: VespaUser,
  relevance: number,
): string => {
  return `${pc.green("App")}: ${fields.app}
${pc.green("Entity")}: ${fields.entity}${typeof fields.creationTime === "number" && isFinite(fields.creationTime) ? `\n${pc.green("Added")}: ${getRelativeTime(fields.creationTime)}` : ""}
${fields.name ? `${pc.green("Name")}: ${fields.name}` : ""}
${fields.email ? `${pc.green("Email")}: ${fields.email}` : ""}
${fields.gender ? `${pc.green("Gender")}: ${fields.gender}` : ""}
${fields.orgJobTitle ? `${pc.green("Job Title")}: ${fields.orgJobTitle}` : ""}
${fields.orgDepartment ? `${pc.green("Department")}: ${fields.orgDepartment}` : ""}
${fields.orgLocation ? `${pc.green("Location")}: ${fields.orgLocation}` : ""}
\n${pc.green("vespa relevance score")}: ${relevance}`
}

const constructMailColoredContext = (
  fields: VespaMailSearch,
  relevance: number,
): string => {
  return `${pc.green("App")}: ${fields.app}
${pc.green("Entity")}: ${fields.entity}${typeof fields.timestamp === "number" && isFinite(fields.timestamp) ? `\n${pc.green("Sent")}: ${getRelativeTime(fields.timestamp)}` : ""}
${fields.subject ? `${pc.green("Subject")}: ${fields.subject}` : ""}
${fields.from ? `${pc.green("From")}: ${fields.from}` : ""}
${fields.to ? `${pc.green("To")}: ${fields.to.join(", ")}` : ""}
${fields.cc ? `${pc.green("Cc")}: ${fields.cc.join(", ")}` : ""}
${fields.bcc ? `${pc.green("Bcc")}: ${fields.bcc.join(", ")}` : ""}
${fields.labels ? `${pc.green("Labels")}: ${fields.labels.join(", ")}` : ""}
${fields.chunks_summary && fields.chunks_summary.length ? `${pc.green("Content")}: ${fields.chunks_summary.join("\n")}` : ""}
\n${pc.green("vespa relevance score")}: ${relevance}`
}

const constructTranscriptContext = (
  fields: VespaTranscriptSearch,
  relevance: number,
  maxSummaryChunks?: number,
  isSelectedFiles?: boolean,
): string => {
  if (!maxSummaryChunks && !isSelectedFiles) {
    maxSummaryChunks = fields.chunks_summary?.length
  }

  let chunks: ScoredChunk[] = []
  if (fields.matchfeatures) {
    chunks = getSortedScoredChunks(
      fields.matchfeatures,
      fields.chunks_summary as string[],
    )
  } else {
    chunks =
      fields.chunks_summary?.map((chunk, idx) => ({
        chunk: typeof chunk == "string" ? chunk : chunk.chunk,
        index: idx,
        score: 0,
      })) || []
  }

  let content = ""
  if (isSelectedFiles && fields?.matchfeatures) {
    content = chunks
      .slice(0, maxSummaryChunks)
      .sort((a, b) => a.index - b.index)
      .map((v) => v.chunk)
      .join("\n")
  } else if (isSelectedFiles) {
    content = chunks.map((v) => v.chunk).join("\n")
  } else {
    content = chunks
      .map((v) => v.chunk)
      .slice(0, maxSummaryChunks)
      .join("\n")
  }

  return `App: ${fields.app}
Title: ${fields.title}
Description: ${fields.description}
File Name: ${fields.fileName}
File Size: ${fields.fileSize} bytes
Duration: ${fields.duration} seconds
Mime Type: ${fields.mimeType}
Uploaded By: ${fields.uploadedBy}${typeof fields.createdAt === "number" && isFinite(fields.createdAt) ? `\nCreated: ${getRelativeTime(fields.createdAt)}` : ""}${typeof fields.updatedAt === "number" && isFinite(fields.updatedAt) ? `\nUpdated At: ${getRelativeTime(fields.updatedAt)}` : ""}
${fields.chunks_summary && fields.chunks_summary.length ? `Content: ${content}` : ""}
\nvespa relevance score: ${relevance}\n`
}

type AiMetadataContext = string
export const answerMetadataContextMap = (
  searchResult: z.infer<typeof VespaSearchResultsSchema>,
): AiMetadataContext => {
  if (searchResult.fields.sddocname === fileSchema) {
    return constructFileMetadataContext(
      searchResult.fields,
      searchResult.relevance,
    )
  } else if (searchResult.fields.sddocname === userSchema) {
    return constructUserMetadataContext(
      searchResult.fields,
      searchResult.relevance,
    )
  } else if (searchResult.fields.sddocname === mailSchema) {
    return constructMailMetadataContext(
      searchResult.fields,
      searchResult.relevance,
    )
  } else if (searchResult.fields.sddocname === mailAttachmentSchema) {
    return constructMailAttachmentMetadataContext(
      searchResult.fields,
      searchResult.relevance,
    )
  } else if (searchResult.fields.sddocname === eventSchema) {
    return constructEventContext(searchResult.fields, searchResult.relevance)
  } else {
    throw new Error(
      `Invalid search result type: ${searchResult.fields.sddocname}`,
    )
  }
}

export const answerColoredContextMap = (
  searchResult: z.infer<typeof VespaSearchResultsSchema>,
): string => {
  if (searchResult.fields.sddocname === fileSchema) {
    return constructFileColoredContext(
      searchResult.fields,
      searchResult.relevance,
    )
  } else if (searchResult.fields.sddocname === userSchema) {
    return constructUserColoredContext(
      searchResult.fields,
      searchResult.relevance,
    )
  } else if (searchResult.fields.sddocname === mailSchema) {
    return constructMailColoredContext(
      searchResult.fields,
      searchResult.relevance,
    )
  } else {
    throw new Error(
      `Invalid search result type: ${searchResult.fields.sddocname}`,
    )
  }
}

type AiContext = string
export const answerContextMap = (
  searchResult: VespaSearchResults,
  maxSummaryChunks?: number,
  isSelectedFiles?: boolean,
): AiContext => {
  if (searchResult.fields.sddocname === fileSchema) {
    return constructFileContext(
      searchResult.fields,
      searchResult.relevance,
      maxSummaryChunks,
      isSelectedFiles,
    )
  } else if (searchResult.fields.sddocname === userSchema) {
    return constructUserContext(searchResult.fields, searchResult.relevance)
  } else if (searchResult.fields.sddocname === mailSchema) {
    return constructMailContext(
      searchResult.fields,
      searchResult.relevance,
      maxSummaryChunks,
      isSelectedFiles,
    )
  } else if (searchResult.fields.sddocname === eventSchema) {
    return constructEventContext(searchResult.fields, searchResult.relevance)
  } else if (searchResult.fields.sddocname === mailAttachmentSchema) {
    return constructMailAttachmentContext(
      searchResult.fields,
      searchResult.relevance,
      maxSummaryChunks,
      isSelectedFiles,
    )
  } else if (searchResult.fields.sddocname === chatMessageSchema) {
    return constructSlackMessageContext(
      searchResult.fields,
      searchResult.relevance,
    )
  } else if (searchResult.fields.sddocname === transcriptSchema) {
    return constructTranscriptContext(
      searchResult.fields,
      searchResult.relevance,
      maxSummaryChunks,
      isSelectedFiles,
    )
  } else {
    throw new Error(
      `Invalid search result type: ${searchResult.fields.sddocname}`,
    )
  }
}

export const cleanContext = (text: string): string => {
  return cleanDocs(cleanVespaHighlights(text))
}

export const cleanColoredContext = (text: string): string => {
  return cleanColoredDocs(cleanVespaHighlights(text))
}

const cleanVespaHighlights = (text: string): string => {
  const hiTagPattern = /<\/?hi>/g
  return text.replace(hiTagPattern, "").trim()
}
const cleanColoredDocs = (text: string): string => {
  const urlPattern =
    /!\[.*?\]\(https:\/\/lh7-rt\.googleusercontent\.com\/docsz\/[a-zA-Z0-9-_?=&]+\)/g
  let cleanedText = text.replace(urlPattern, "")

  // ........
  const extendedEllipsisPattern = /[…\.\s]{2,}/g
  cleanedText = cleanedText.replace(extendedEllipsisPattern, " ")
  // .0.0.0.0.0.0.0.0
  const repetitiveDotZeroPattern = /(?:\.0)+(\.\d+)?/g
  cleanedText = cleanedText.replace(repetitiveDotZeroPattern, "")

  // Remove control characters
  // Adjusted control characters pattern to exclude ANSI escape codes (\x1B)
  const controlCharsPattern = /[\x00-\x08\x0E-\x1A\x1C-\x1F\x7F-\x9F]/g
  cleanedText = cleanedText.replace(controlCharsPattern, "")
  // Remove invalid or incomplete UTF characters
  //  and �
  const invalidUtfPattern = /[\uE907\uFFFD]/g
  cleanedText = cleanedText.replace(invalidUtfPattern, "")

  return cleanedText
}

// google docs need lots of cleanup
export const cleanDocs = (text: string): string => {
  const urlPattern =
    /!\[.*?\]\(https:\/\/lh7-rt\.googleusercontent\.com\/docsz\/[a-zA-Z0-9-_?=&]+\)/g
  let cleanedText = text.replace(urlPattern, "")

  // Handle newlines first
  cleanedText = cleanedText.replace(/\s+/g, " ")

  // ........
  const extendedEllipsisPattern = /[…\.]{2,}/g
  cleanedText = cleanedText.replace(extendedEllipsisPattern, " ")

  // .0.0.0.0.0.0.0.0 while retaining the numeric
  const repetitiveDotZeroPattern = /(?<!\d)\s*[.0]+\.0(?:\.0)+\s*/g

  cleanedText = cleanedText.replace(repetitiveDotZeroPattern, " ")

  // Remove control characters
  const controlCharsPattern = /[\x00-\x1F\x7F-\x9F]/g
  cleanedText = cleanedText.replace(controlCharsPattern, "")
  // Remove invalid or incomplete UTF characters
  //  and �
  const invalidUtfPattern = /[\uE907\uFFFD]/g
  cleanedText = cleanedText.replace(invalidUtfPattern, "")

  return cleanedText.trim()
}

// TODO:
// inform about the location
// tell the IP of the user as well
export const userContext = ({
  user,
  workspace,
}: PublicUserWorkspace): string => {
  const now = new Date()
  const currentDate = now.toLocaleDateString() // e.g., "11/10/2024"
  const currentTime = now.toLocaleTimeString() // e.g., "10:14:03 AM"
  return `My Name is ${user.name}
Email: ${user.email}
Company: ${workspace.name}
Company domain: ${workspace.domain}
Current Time: ${currentTime}
Today is: ${currentDate}
Timezone: IST`
}

/**
 * Matches URLs starting with 'http://' or 'https://'.
 */
const URL_REGEX: RegExp = /\bhttps?:\/\/[^\s/$.?#].[^\s]*\b/gi
/**
 * Replaces URLs in the given text with placeholders in the format '[link: domain.tld]'.
 *
 * @param text - The text in which to replace URLs.
 * @returns The text with URLs replaced by placeholders.
 */
export const replaceLinks = (text: string): string => {
  return text.replace(URL_REGEX, (match: string): string => {
    try {
      const parsedUrl: URL = new URL(match)
      const domain: string = parsedUrl.hostname
      return `${domain}`
    } catch (e) {
      // If URL parsing fails, return the original match
      return match
    }
  })
}
