// aim is to build context based on the internal types
// translate the company to the AI
import type { PublicUserWorkspace } from "@/db/schema"
import {
  fileSchema,
  mailSchema,
  userSchema,
  VespaSearchResultsSchema,
  type VespaFileSearch,
  type VespaMailSearch,
  type VespaUser,
} from "@/search/types"
import { getRelativeTime } from "@/utils"
import type { z } from "zod"

// Utility to capitalize the first letter of a string
const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1)

// Function for handling file context
const constructFileContext = (
  fields: VespaFileSearch,
  relevance: number,
): string => {
  return `App: ${fields.app}
Entity: ${fields.entity}
Title: ${fields.title ? `Title: ${fields.title}` : ""}
Created: ${getRelativeTime(fields.createdAt)}
Updated At: ${getRelativeTime(fields.updatedAt)}
${fields.url ? `Link: ${fields.url}` : ""}
${fields.owner ? `Owner: ${fields.owner}` : ""}
${fields.ownerEmail ? `Owner Email: ${fields.ownerEmail}` : ""}
${fields.mimeType ? `Mime Type: ${fields.mimeType}` : ""}
${fields.permissions ? `Permissions: ${fields.permissions.join(", ")}` : ""}
${fields.chunks_summary && fields.chunks_summary.length ? `Content: ${fields.chunks_summary.join("\n")}` : ""}
vespa relevance score: ${relevance}`
}

// TODO: tell if workspace that this is an employee
const constructUserContext = (fields: VespaUser, relevance: number): string => {
  return `App: ${fields.app}
Entity: ${fields.entity}
Added: ${getRelativeTime(fields.creationTime)}
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
): string => {
  return `App: ${fields.app}
Entity: ${fields.entity}
Sent: ${getRelativeTime(fields.timestamp)}
${fields.subject ? `Subject: ${fields.subject}` : ""}
${fields.from ? `From: ${fields.from}` : ""}
${fields.to ? `To: ${fields.to.join(", ")}` : ""}
${fields.cc ? `Cc: ${fields.cc.join(", ")}` : ""}
${fields.bcc ? `Bcc: ${fields.bcc.join(", ")}` : ""}
${fields.labels ? `Labels: ${fields.labels.join(", ")}` : ""}
${fields.chunks_summary && fields.chunks_summary.length ? `Content: ${fields.chunks_summary.join("\n")}` : ""}
vespa relevance score: ${relevance}`
}

// Function for handling file context
const constructFileMetadataContext = (
  fields: VespaFileSearch,
  relevance: number,
): string => {
  return `App: ${fields.app}
Entity: ${fields.entity}
Title: ${fields.title ? `Title: ${fields.title}` : ""}
Created: ${getRelativeTime(fields.createdAt)}
Updated At: ${getRelativeTime(fields.updatedAt)}
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
Entity: ${fields.entity}
Added: ${getRelativeTime(fields.creationTime)}
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
Entity: ${fields.entity}
Sent: ${getRelativeTime(fields.timestamp)}
${fields.subject ? `Subject: ${fields.subject}` : ""}
${fields.from ? `From: ${fields.from}` : ""}
${fields.to ? `To: ${fields.to.join(", ")}` : ""}
${fields.cc ? `Cc: ${fields.cc.join(", ")}` : ""}
${fields.bcc ? `Bcc: ${fields.bcc.join(", ")}` : ""}
${fields.labels ? `Mailbox Labels: ${fields.labels.join(", ")}` : ""}
vespa relevance score: ${relevance}`
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
  } else {
    throw new Error("Invalid search result type")
  }
}

type AiContext = string
export const answerContextMap = (
  searchResult: z.infer<typeof VespaSearchResultsSchema>,
): AiContext => {
  if (searchResult.fields.sddocname === fileSchema) {
    return constructFileContext(searchResult.fields, searchResult.relevance)
  } else if (searchResult.fields.sddocname === userSchema) {
    return constructUserContext(searchResult.fields, searchResult.relevance)
  } else if (searchResult.fields.sddocname === mailSchema) {
    return constructMailContext(searchResult.fields, searchResult.relevance)
  } else {
    throw new Error("Invalid search result type")
  }
}

export const cleanContext = (text: string): string => {
  return cleanDocs(cleanVespaHighlights(text))
}

const cleanVespaHighlights = (text: string): string => {
  const hiTagPattern = /<\/?hi>/g
  return text.replace(hiTagPattern, "").trim()
}

// google docs need lots of cleanup
const cleanDocs = (text: string): string => {
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
  const controlCharsPattern = /[\x00-\x1F\x7F-\x9F]/g
  cleanedText = cleanedText.replace(controlCharsPattern, "")
  // Remove invalid or incomplete UTF characters
  //  and �
  const invalidUtfPattern = /[\uE907\uFFFD]/g
  cleanedText = cleanedText.replace(invalidUtfPattern, "")

  return cleanedText
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
  return `My Name: ${user.name}
Email: ${user.email}
Company: ${workspace.name}
Company domain: ${workspace.domain}
Current Time: ${currentTime}
Today is: ${currentDate}`
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
