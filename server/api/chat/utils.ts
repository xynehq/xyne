import { splitGroupedCitationsWithSpaces } from "@/utils"
import {
  Apps,
  CalendarEntity,
  chatMessageSchema,
  dataSourceFileSchema,
  DriveEntity,
  entitySchema,
  eventSchema,
  fileSchema,
  GooglePeopleEntity,
  isValidApp,
  isValidEntity,
  mailAttachmentSchema,
  MailEntity,
  mailSchema,
  SystemEntity,
  userSchema,
  type Entity,
  type VespaChatMessage,
  type VespaEvent,
  type VespaEventSearch,
  type VespaFile,
  type VespaMail,
  type VespaMailAttachment,
  type VespaMailSearch,
  type VespaSchema,
  type VespaSearchResponse,
  type VespaSearchResult,
  type VespaSearchResults,
  type VespaSearchResultsSchema,
  type VespaUser,
} from "@/search/types"
import type { z } from "zod"
import { getDocumentOrSpreadsheet } from "@/integrations/google/sync"
import config from "@/config"
import type { UserQuery } from "@/ai/types"
import {
  AgentReasoningStepType,
  OpenAIError,
  type AgentReasoningStep,
} from "@/shared/types"
import type { Citation } from "@/api/chat/types"
const { maxValidLinks } = config

export const searchToCitation = (result: VespaSearchResults): Citation => {
  const fields = result.fields
  if (result.fields.sddocname === userSchema) {
    return {
      docId: (fields as VespaUser).docId,
      title: (fields as VespaUser).name,
      url: `https://contacts.google.com/${(fields as VespaUser).email}`,
      app: (fields as VespaUser).app,
      entity: (fields as VespaUser).entity,
    }
  } else if (result.fields.sddocname === fileSchema) {
    return {
      docId: (fields as VespaFile).docId,
      title: (fields as VespaFile).title,
      url: (fields as VespaFile).url || "",
      app: (fields as VespaFile).app,
      entity: (fields as VespaFile).entity,
    }
  } else if (result.fields.sddocname === mailSchema) {
    return {
      docId: (fields as VespaMail).docId,
      title: (fields as VespaMail).subject,
      url: `https://mail.google.com/mail/u/0/#inbox/${fields.docId}`,
      app: (fields as VespaMail).app,
      entity: (fields as VespaMail).entity,
    }
  } else if (result.fields.sddocname === eventSchema) {
    return {
      docId: (fields as VespaEvent).docId,
      title: (fields as VespaEvent).name || "No Title",
      url: (fields as VespaEvent).url,
      app: (fields as VespaEvent).app,
      entity: (fields as VespaEvent).entity,
    }
  } else if (result.fields.sddocname === mailAttachmentSchema) {
    return {
      docId: (fields as VespaMailAttachment).docId,
      title: (fields as VespaMailAttachment).filename || "No Filename",
      url: `https://mail.google.com/mail/u/0/#inbox/${
        (fields as VespaMailAttachment).mailId
      }?projector=1&messagePartId=0.${
        (fields as VespaMailAttachment).partId
      }&disp=safe&zw`,
      app: (fields as VespaMailAttachment).app,
      entity: (fields as VespaMailAttachment).entity,
    }
  } else if (result.fields.sddocname === chatMessageSchema) {
    return {
      docId: (fields as VespaChatMessage).docId,
      title: (fields as VespaChatMessage).text,
      url: `https://${(fields as VespaChatMessage).domain}.slack.com/archives/${
        (fields as VespaChatMessage).channelId
      }/p${(fields as VespaChatMessage).updatedAt}`,
      app: (fields as VespaChatMessage).app,
      entity: (fields as VespaChatMessage).entity,
    }
  } else {
    throw new Error("Invalid search result type for citation")
  }
}

const searchToCitations = (
  results: z.infer<typeof VespaSearchResultsSchema>[],
): Citation[] => {
  if (results.length === 0) {
    return []
  }
  return results.map((result) => searchToCitation(result as VespaSearchResults))
}

export const textToCitationIndex = /\[(\d+)\]/g

export const processMessage = (
  text: string,
  citationMap: Record<number, number>,
) => {
  if (!text) {
    return ""
  }

  text = splitGroupedCitationsWithSpaces(text)
  return text.replace(textToCitationIndex, (match, num) => {
    const index = citationMap[num]

    return typeof index === "number" ? `[${index + 1}]` : ""
  })
}

export function flattenObject(obj: any, parentKey = ""): [string, string][] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const fullKey = parentKey ? `${parentKey}.${key}` : key

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return flattenObject(value, fullKey)
    } else {
      return [[fullKey, JSON.stringify(value)]]
    }
  })
}
// the Set is passed by reference so that singular object will get updated
// but need to be kept in mind

export const isMessageWithContext = (message: string) => {
  return message?.startsWith("[{") && message?.endsWith("}]")
}

export const getFileIdFromLink = (link: string) => {
  const regex = /(?:\/d\/|[?&]id=)([a-zA-Z0-9_-]+)/
  const match = link.match(regex)
  const fileId = match ? match[1] : null
  return fileId
}
export const extractFileIdsFromMessage = async (
  message: string,
): Promise<{
  totalValidFileIdsFromLinkCount: number
  fileIds: string[]
  threadIds: string[]
}> => {
  const fileIds: string[] = []
  const threadIds: string[] = []
  const jsonMessage = JSON.parse(message) as UserQuery
  console.log(jsonMessage)
  let validFileIdsFromLinkCount = 0
  let totalValidFileIdsFromLinkCount = 0
  for (const obj of jsonMessage) {
    if (obj?.type === "pill") {
      fileIds.push(obj?.value?.docId)
      // Check if this pill has a threadId (for email threads)
      if (obj?.value?.threadId && obj?.value?.app === Apps.Gmail) {
        threadIds.push(obj?.value?.threadId)
      }
    } else if (obj?.type === "link") {
      const fileId = getFileIdFromLink(obj?.value)
      if (fileId) {
        // Check if it's a valid Drive File Id ingested in Vespa
        // Only works for fileSchema
        const validFile = await getDocumentOrSpreadsheet(fileId)
        if (validFile) {
          totalValidFileIdsFromLinkCount++
          if (validFileIdsFromLinkCount >= maxValidLinks) {
            continue
          }
          const fields = validFile?.fields as VespaFile
          // If any of them happens to a spreadsheet, add all its subsheet ids also here
          if (
            fields?.app === Apps.GoogleDrive &&
            fields?.entity === DriveEntity.Sheets
          ) {
            const sheetsMetadata = JSON.parse(fields?.metadata as string)
            const totalSheets = sheetsMetadata?.totalSheets
            for (let i = 0; i < totalSheets; i++) {
              fileIds.push(`${fileId}_${i}`)
            }
          } else {
            fileIds.push(fileId)
          }
          validFileIdsFromLinkCount++
        }
      }
    }
  }
  return { totalValidFileIdsFromLinkCount, fileIds, threadIds }
}

export const handleError = (error: any) => {
  let errorMessage = "Something went wrong. Please try again."
  if (error?.code === OpenAIError.RateLimitError) {
    errorMessage = "Rate limit exceeded. Please try again later."
  } else if (error?.code === OpenAIError.InvalidAPIKey) {
    errorMessage =
      "Invalid API key provided. Please check your API key and ensure it is correct."
  } else if (
    error?.name === "ThrottlingException" ||
    error?.message === "Too many tokens, please wait before trying again." ||
    error?.$metadata?.httpStatusCode === 429
  ) {
    errorMessage = "Rate limit exceeded. Please try again later."
  } else if (
    error?.name === "ValidationException" ||
    error?.message ===
      "The model returned the following errors: Input is too long for requested model."
  ) {
    errorMessage = "Input context is too large."
  }
  return errorMessage
}

export const convertReasoningStepToText = (
  step: AgentReasoningStep,
): string => {
  switch (step.type) {
    case AgentReasoningStepType.AnalyzingQuery:
      return step.details
    case AgentReasoningStepType.Iteration:
      return `### Iteration ${step.iteration} \n`
    case AgentReasoningStepType.Planning:
      return step.details + "\n" // e.g., "Planning next step..."
    case AgentReasoningStepType.ToolSelected:
      return `Tool selected: ${step.toolName} \n`
    case AgentReasoningStepType.ToolParameters:
      const params = Object.entries(step.parameters)
        .map(
          ([key, value]) =>
            `• ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
        )
        .join("\n")
      return `Parameters:\n${params} \n`
    case AgentReasoningStepType.ToolExecuting:
      return `Executing tool: ${step.toolName}...\n`
    case AgentReasoningStepType.ToolResult:
      let resultText = `Tool result (${step.toolName}): ${step.resultSummary}`
      if (step.itemsFound !== undefined) {
        resultText += ` (Found ${step.itemsFound} item(s))`
      }
      if (step.error) {
        resultText += `\nError: ${step.error}\n`
      }
      return resultText + "\n"
    case AgentReasoningStepType.Synthesis:
      return step.details + "\n" // e.g., "Synthesizing answer from X fragments..."
    case AgentReasoningStepType.ValidationError:
      return `Validation Error: ${step.details} \n`
    case AgentReasoningStepType.BroadeningSearch:
      return `Broadening Search: ${step.details}\n`
    case AgentReasoningStepType.LogMessage:
      return step.message + "\n"
    default:
      return "Unknown reasoning step"
  }
}
