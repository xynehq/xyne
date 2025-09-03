import { splitGroupedCitationsWithSpaces, getErrorMessage } from "@/utils"
import {
  Apps,
  CalendarEntity,
  chatContainerSchema,
  chatMessageSchema,
  DataSourceEntity,
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
  SlackEntity,
  SystemEntity,
  userSchema,
  type Entity,
  type VespaChatContainer,
  type VespaChatMessage,
  type VespaDataSourceFile,
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
  KbItemsSchema,
  KnowledgeBaseEntity,
} from "@/search/types"
import type { z } from "zod"
import { getDocumentOrSpreadsheet } from "@/integrations/google/sync"
import config from "@/config"
import type { Intent, UserQuery, QueryRouterLLMResponse } from "@/ai/types"
import {
  AgentReasoningStepType,
  OpenAIError,
  type AgentReasoningStep,
} from "@/shared/types"
import type { Citation } from "@/api/chat/types"
import { getFolderItems, SearchEmailThreads } from "@/search/vespa"
import { getLoggerWithChild, getLogger } from "@/logger"
import type { Span } from "@/tracer"
import { Subsystem } from "@/types"
import type { SelectMessage } from "@/db/schema"
const { maxValidLinks } = config
import fs from "fs"
import path from "path"
import {
  getAllCollectionAndFolderItems,
  getCollectionFilesVespaIds,
} from "@/db/knowledgeBase"
import { db } from "@/db/client"
import { get } from "http"

function slackTs(ts: string | number) {
  if (typeof ts === "number") ts = ts.toString()
  return ts.replace(".", "").padEnd(16, "0")
}

export const getChannelIdsFromAgentPrompt = (agentPrompt: string) => {
  try {
    const agent = JSON.parse(agentPrompt)
    if (!agent || !agent.docIds) {
      return []
    }
    const channelIds = new Set<string>()
    agent.docIds?.forEach((doc: any) => {
      if (doc.app === Apps.Slack) {
        if (doc.entity === SlackEntity.Channel && doc.docId) {
          channelIds.add(doc.docId)
        }
      }
    })
    return Array.from(channelIds)
  } catch (e) {
    return []
  }
}

export interface AppSelection {
  itemIds: string[]
  selectedAll: boolean
}

export interface AppSelectionMap {
  [appName: string]: AppSelection
}

export interface ParsedResult {
  selectedApps: Apps[]
  selectedItems: { [app: string]: string[] }
}

export function parseAppSelections(input: AppSelectionMap): ParsedResult {
  const selectedApps: Apps[] = []
  const selectedItems: { [app: string]: string[] } = {}

  for (let [appName, selection] of Object.entries(input)) {
    let app: Apps
    // Add app to selectedApps list
    if (appName == "googledrive") {
      app = Apps.GoogleDrive
    } else if (appName == "googlesheets") {
      app = Apps.GoogleDrive
    } else if (appName == "gmail") {
      app = Apps.Gmail
    } else if (appName == "googlecalendar") {
      app = Apps.GoogleCalendar
    } else if (appName == "DataSource") {
      app = Apps.DataSource
    } else if (appName == "knowledge_base") {
      app = Apps.KnowledgeBase
    } else if (appName == "slack") {
      app = Apps.Slack
    } else if (appName == "google-workspace") app = Apps.GoogleWorkspace
    else {
      app = appName as unknown as Apps
    }

    selectedApps.push(app)
    // If selectedAll is true or itemIds is empty, we infer "all selected"
    // So we don't add anything to selectedItems (empty means all)
    if (
      !selection.selectedAll &&
      selection.itemIds &&
      selection.itemIds.length > 0
    ) {
      // Only add specific itemIds when selectedAll is false and there are specific items
      if (selectedItems[app]) {
        selectedItems[app] = [
          ...new Set([...selectedItems[app], ...selection.itemIds]),
        ]
      } else {
        selectedItems[app] = selection.itemIds
      }
    }
  }
  return {
    selectedApps,
    selectedItems,
  }
}

// Interface for email search result fields
export interface EmailSearchResultFields {
  app: Apps
  threadId?: string
  docId: string
  [key: string]: any // Allow other fields
}

// Type for VespaSearchResult with email fields
export type EmailSearchResult = VespaSearchResult & {
  fields: EmailSearchResultFields
}

export async function expandEmailThreadsInResults(
  results: VespaSearchResult[],
  email: string,
  span?: Span,
): Promise<VespaSearchResult[]> {
  // Extract unique thread IDs from email results
  const threadIds = extractThreadIdsFromResults(results)
  if (threadIds.length === 0) {
    return results
  }
  const { mergedResults, addedCount } = await mergeThreadResults(
    results,
    threadIds,
    email,
    span,
  )

  if (addedCount > 0) {
    getLoggerWithChild(Subsystem.Chat)({ email }).info(
      `Added ${addedCount} additional emails from ${threadIds.length} threads to search results`,
    )
  }

  return mergedResults
}

// Helper function to process thread results and merge them with existing results
export function processThreadResults(
  threadResults: VespaSearchResult[],
  existingDocIds: Set<string>,
  mergedResults: VespaSearchResult[],
): { addedCount: number; threadInfo: Record<string, number> } {
  let addedCount = 0
  let threadInfo: Record<string, number> = {}

  for (const child of threadResults) {
    const emailChild = child as EmailSearchResult
    const docId = emailChild.fields.docId
    const threadId = emailChild.fields.threadId

    // Skip if already in results
    if (!existingDocIds.has(docId)) {
      mergedResults.push(child)
      existingDocIds.add(docId)
      addedCount++

      // Track count per thread for logging
      if (threadId) {
        threadInfo[threadId] = (threadInfo[threadId] || 0) + 1
      }
    }
  }

  return { addedCount, threadInfo }
}

// Function to extract thread IDs from search results
export function extractThreadIdsFromResults(
  results: VespaSearchResult[],
): string[] {
  const seenThreadIds = new Set<string>()

  return results.reduce<string[]>((threadIds, result) => {
    const fields = result.fields as EmailSearchResultFields
    // Check if it's an email result
    if (fields.app === Apps.Gmail && fields.threadId) {
      if (!seenThreadIds.has(fields.threadId)) {
        threadIds.push(fields.threadId)
        seenThreadIds.add(fields.threadId)
      }
    }
    return threadIds
  }, [])
}

// Helper function to merge thread results into existing results
export async function mergeThreadResults(
  existingResults: VespaSearchResult[],
  threadIds: string[],
  email: string,
  span?: Span,
): Promise<{
  mergedResults: VespaSearchResult[]
  addedCount: number
  threadInfo: Record<string, number>
}> {
  if (threadIds.length === 0) {
    return { mergedResults: existingResults, addedCount: 0, threadInfo: {} }
  }

  const threadSpan = span?.startSpan("fetch_email_threads")
  threadSpan?.setAttribute("threadIds", JSON.stringify(threadIds))

  try {
    const threadResults = await SearchEmailThreads(threadIds, email)

    if (
      !threadResults.root.children ||
      threadResults.root.children.length === 0
    ) {
      threadSpan?.setAttribute("no_thread_results", true)
      threadSpan?.end()
      return { mergedResults: existingResults, addedCount: 0, threadInfo: {} }
    }

    // Create a set of existing docIds to avoid duplicates
    const existingDocIds = new Set(
      existingResults.map((child: any) => child.fields.docId),
    )

    // Merge thread results
    const mergedResults = [...existingResults]

    const { addedCount, threadInfo } = processThreadResults(
      threadResults.root.children,
      existingDocIds,
      mergedResults,
    )

    threadSpan?.setAttribute("added_email_count", addedCount)
    threadSpan?.setAttribute(
      "total_thread_emails_found",
      threadResults.root.children.length,
    )
    threadSpan?.setAttribute("thread_info", JSON.stringify(threadInfo))
    threadSpan?.end()

    return { mergedResults, addedCount, threadInfo }
  } catch (error) {
    getLoggerWithChild(Subsystem.Chat)({ email }).error(
      error,
      `Error fetching email threads: ${getErrorMessage(error)}`,
    )
    threadSpan?.setAttribute("error", getErrorMessage(error))
    threadSpan?.end()
    return { mergedResults: existingResults, addedCount: 0, threadInfo: {} }
  }
}

export const extractImageFileNames = (
  context: string,
  results?: VespaSearchResult[],
): { imageFileNames: string[] } => {
  // This matches "Image File Names:" followed by content until the next field (starting with a capital letter and colon) or "vespa relevance score:"
  const imageContentRegex =
    /Image File Names:\s*([\s\S]*?)(?=\n[A-Z][a-zA-Z ]*:|vespa relevance score:|$)/g
  const matches = [...context.matchAll(imageContentRegex)]

  let imageFileNames: string[] = []
  for (const match of matches) {
    let imageContent = match[1].trim()
    try {
      if (imageContent) {
        const docId = imageContent.split("_")[0]
        // const docIndex =
        //   results?.findIndex((c) => (c.fields as any).docId === docId) || -1
        const docIndex =
          results?.findIndex((c) => (c.fields as any).docId === docId) ?? -1

        if (docIndex === -1) {
          console.warn(
            `No matching document found for docId: ${docId} in results for image content extraction.`,
          )
          continue
        }

        // Split by newlines and filter out empty strings
        const fileNames = imageContent
          .split("\n")
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
          // Additional safety: split by spaces and filter out empty strings
          // in case multiple filenames are on the same line
          .flatMap((name) =>
            name.split(/\s+/).filter((part) => part.length > 0),
          )
          .map((name) => `${docIndex}_${name}`)
        imageFileNames.push(...fileNames)
      }
    } catch (error) {
      console.error(
        `Error processing image content: ${getErrorMessage(error)}`,
        { imageContent },
      )
      continue
    }
  }
  return { imageFileNames }
}

export const searchToCitation = (result: VespaSearchResults, chunkIndex?: number): Citation => {
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
      threadId: (fields as VespaMail).threadId,
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
    let slackUrl = ""
    if (result.fields.threadId) {
      // Thread message format
      slackUrl = `https://${result.fields.domain}.slack.com/archives/${result.fields.channelId}/p${slackTs(result.fields.createdAt)}?thread_ts=${result.fields.threadId}&cid=${result.fields.channelId}`
    } else {
      // Normal message format
      slackUrl = `https://${result.fields.domain}.slack.com/archives/${result.fields.channelId}/p${slackTs(result.fields.createdAt)}`
    }
    return {
      docId: (fields as VespaChatMessage).docId,
      title: (fields as VespaChatMessage).text,
      url: slackUrl,
      app: (fields as VespaChatMessage).app,
      entity: (fields as VespaChatMessage).entity,
    }
  } else if (result.fields.sddocname === dataSourceFileSchema) {
    return {
      docId: (fields as VespaDataSourceFile).docId,
      title: (fields as VespaDataSourceFile).fileName,
      url: `/dataSource/${(fields as VespaDataSourceFile).docId}`,
      app: (fields as VespaDataSourceFile).app,
      entity: DataSourceEntity.DataSourceFile,
    }
  } else if (result.fields.sddocname == KbItemsSchema) {
    // Handle Collection files - include the actual file and Collection UUIDs for direct access
    const clFields = fields as any // Type as VespaClFileSearch when types are available
    return {
      docId: clFields.docId,
      title: clFields.fileName || "Collection File",
      url: `/cl/${clFields.clId}`,
      app: Apps.KnowledgeBase,
      entity: SystemEntity.SystemInfo,
      itemId: clFields.itemId,
      clId: clFields.clId,
      chunkIndex: chunkIndex,
    }
  } else if (result.fields.sddocname === chatContainerSchema) {
    return {
      docId: (fields as VespaChatContainer).docId,
      title: (fields as VespaChatContainer).name,
      url: `https://${result.fields.domain}.slack.com/archives/${result.fields.docId}`,
      app: (fields as VespaChatContainer).app,
      entity: SlackEntity.Channel,
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
  email?: string,
): Promise<{
  totalValidFileIdsFromLinkCount: number
  fileIds: string[]
  threadIds: string[]
}> => {
  const fileIds: string[] = []
  const threadIds: string[] = []
  const driveItem: string[] = []
  const collectionFolderIds: string[] = []
  const jsonMessage = JSON.parse(message) as UserQuery
  let validFileIdsFromLinkCount = 0
  let totalValidFileIdsFromLinkCount = 0

  for (const obj of jsonMessage) {
    if (obj?.type === "pill") {
      if (
        obj?.value &&
        obj?.value?.entity &&
        obj?.value?.entity == DriveEntity.Folder
      ) {
        driveItem.push(obj?.value?.docId)
      } else fileIds.push(obj?.value?.docId)
      // Check if this pill has a threadId (for email threads)
      if (obj?.value?.threadId && obj?.value?.app === Apps.Gmail) {
        threadIds.push(obj?.value?.threadId)
      }

      const pillValue = obj.value
      const docId = pillValue.docId

      // Check if this is a Google Sheets reference with wholeSheet: true
      if (pillValue.wholeSheet === true) {
        // Extract the base docId (remove the "_X" suffix if present)
        const baseDocId = docId.replace(/_\d+$/, "")

        // Get the spreadsheet metadata to find all sub-sheets
        const validFile = await getDocumentOrSpreadsheet(baseDocId)
        if (validFile) {
          const fields = validFile?.fields as VespaFile
          if (
            fields?.app === Apps.GoogleDrive &&
            fields?.entity === DriveEntity.Sheets
          ) {
            const sheetsMetadata = JSON.parse(fields?.metadata as string)
            const totalSheets = sheetsMetadata?.totalSheets
            // Add all sub-sheet IDs
            for (let i = 0; i < totalSheets; i++) {
              fileIds.push(`${baseDocId}_${i}`)
            }
          } else {
            // Fallback: just add the docId if it's not a spreadsheet
            fileIds.push(docId)
          }
        } else {
          // Fallback: just add the docId if we can't get metadata
          fileIds.push(docId)
        }
      } else {
        // Regular pill behavior: just add the docId
        fileIds.push(docId)
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

  while (driveItem.length) {
    let curr = driveItem.shift()
    // Ensure email is defined before passing it to getFolderItems\
    if (curr) fileIds.push(curr)
    if (curr && email) {
      try {
        const folderItem = await getFolderItems(
          [curr],
          fileSchema,
          DriveEntity.Folder,
          email,
        )
        if (
          folderItem.root &&
          folderItem.root.children &&
          folderItem.root.children.length > 0
        ) {
          for (const item of folderItem.root.children) {
            if (
              item.fields &&
              (item.fields as any).entity === DriveEntity.Folder
            ) {
              driveItem.push((item.fields as any).docId)
            } else {
              fileIds.push((item.fields as any).docId)
            }
          }
        }
      } catch (error) {
        getLoggerWithChild(Subsystem.Chat)({ email }).error(
          `Falied to fetch the content of Folder`,
        )
      }
    }
  }

  const collectionFileIds = await getAllCollectionAndFolderItems(
    collectionFolderIds,
    db,
  )
  if (collectionFolderIds.length > 0) {
    const ids = await getCollectionFilesVespaIds(collectionFileIds, db)
    const vespaIds = ids
      .filter((item) => item.vespaDocId !== null)
      .map((item) => item.vespaDocId!)
    fileIds.push(...vespaIds)
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
      // Don't show item counts for fallback tool to keep it clean
      if (step.itemsFound !== undefined && step.toolName !== "fall_back") {
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

export const mimeTypeMap: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}
export const getCitationToImage = async (
  citationIndex: string,
  doc: VespaSearchResult,
  email: string,
): Promise<{
  imagePath: string
  imageBuffer: Buffer
  extension: string | null
} | null> => {
  const loggerWithChild = getLoggerWithChild(Subsystem.Chat)
  try {
    // Parse the citation index format: docIndex_imageNumber
    const parts = citationIndex.split("_")
    if (parts.length < 2) {
      loggerWithChild({ email: email }).error(
        "Invalid citation index format, expected docIndex_imageNumber",
        citationIndex,
      )
      return null
    }

    const docIndex = parseInt(parts[0], 10)
    const imageNumber = parseInt(parts[1], 10)
    if (isNaN(docIndex) || isNaN(imageNumber)) {
      loggerWithChild({ email: email }).error(
        "Invalid numeric values in citation index",
        { citationIndex, docIndex, imageNumber },
      )
      return null
    }

    const document = doc
    if (!document) {
      loggerWithChild({ email: email }).error("Document not found at index", {
        docIndex,
      })
      return null
    }

    const docId = (document.fields as any)?.docId
    if (!docId) {
      loggerWithChild({ email: email }).error("DocId not found in document", {
        docIndex,
        document,
      })
      return null
    }

    const imageDir = process.env.IMAGE_DIR || "downloads/xyne_images_db"
    const imagePathProcess = path.join(process.cwd(), imageDir, docId)

    let imagePath: string | null = null
    let ext: string | null = null

    try {
      const files = await fs.promises.readdir(imagePathProcess)

      // Find file that matches the pattern: imageNumber.extension
      const imageFile = files.find((file) => {
        const nameWithoutExt = path.parse(file).name
        return nameWithoutExt === imageNumber.toString()
      })

      if (imageFile) {
        imagePath = path.join(imagePathProcess, imageFile)
        ext = path.parse(imageFile).ext
      }
    } catch (dirError) {
      loggerWithChild({ email: email }).error("Error reading image directory", {
        citationIndex,
        docId,
        imageNumber,
        directory: imagePathProcess,
        error: getErrorMessage(dirError),
      })
      return null
    }

    if (!imagePath) {
      loggerWithChild({ email: email }).error(
        "Image file not found in directory",
        { citationIndex, docId, imageNumber, directory: imagePathProcess },
      )
      return null
    }

    const imageBuffer = await fs.promises.readFile(imagePath)

    loggerWithChild({ email: email }).info("Successfully retrieved image", {
      citationIndex,
      docId,
      imageNumber,
      imagePath,
      extension: ext,
    })

    return {
      imagePath,
      imageBuffer,
      extension: ext,
    }
  } catch (error) {
    loggerWithChild({ email: email }).error(
      error,
      "Error retrieving image for citation",
      { citationIndex, error: getErrorMessage(error) },
    )
    return null
  }
}

export function extractNamesFromIntent(intent: any): Intent {
  if (!intent || typeof intent !== "object") return {}

  const result: Intent = {}
  const fieldsToCheck = ["from", "to", "cc", "bcc", "subject"] as const

  for (const field of fieldsToCheck) {
    if (Array.isArray(intent[field]) && intent[field].length > 0) {
      const uniqueValues = [...new Set(intent[field])].filter((v) => v)
      if (uniqueValues.length > 0) {
        result[field] = uniqueValues
      }
    }
  }

  return result
}

export function isAppSelectionMap(value: any): value is AppSelectionMap {
  if (!value || typeof value !== "object") {
    return false
  }
  // Check if it's an empty object (valid case)
  if (Object.keys(value).length === 0) {
    return true
  }
  // Check if all properties are valid AppSelection objects
  for (const [appName, selection] of Object.entries(value)) {
    // Optionally validate app name is a valid app
    // if (!isValidApp(appName)) {
    //   return false;
    // }

    if (!isValidAppSelection(selection)) {
      return false
    }
  }

  return true
}

function isValidAppSelection(value: any): value is AppSelection {
  return (
    value &&
    typeof value === "object" &&
    Array.isArray(value.itemIds) &&
    value.itemIds.every((id: any) => typeof id === "string") &&
    typeof value.selectedAll === "boolean"
  )
}

export interface ChainBreakClassification {
  messageIndex: number
  classification: QueryRouterLLMResponse
  query: string
}

function parseQueryRouterClassification(
  queryRouterClassification: any,
  messageIndex: number,
): QueryRouterLLMResponse | null {
  if (queryRouterClassification == null) return null
  try {
    const parsed =
      typeof queryRouterClassification === "string"
        ? JSON.parse(queryRouterClassification)
        : queryRouterClassification
    if (
      Array.isArray(parsed) ||
      typeof parsed !== "object" ||
      parsed === null
    ) {
      return null
    }
    return parsed as QueryRouterLLMResponse
  } catch (error) {
    getLoggerWithChild(Subsystem.Chat)().warn(
      `Failed to parse classification for message ${messageIndex}:`,
      error,
    )
    return null
  }
}

export function getRecentChainBreakClassifications(
  messages: SelectMessage[],
): ChainBreakClassification[] {
  const chainBreaks = extractChainBreakClassifications(messages)
  const recentChainBreaks = chainBreaks.slice(0, 2) // limit to the last 2 chain breaks
  getLoggerWithChild(Subsystem.Chat)().info(
    `[ChainBreak] Found ${recentChainBreaks.length} recent chain breaks`,
  )
  return recentChainBreaks
}

export function extractChainBreakClassifications(
  messages: SelectMessage[],
): ChainBreakClassification[] {
  const chainBreaks: ChainBreakClassification[] = []

  messages.forEach((message, index) => {
    // Only process user messages with classifications
    if (message.messageRole === "user" && message.queryRouterClassification) {
      const currentClassification = parseQueryRouterClassification(
        message.queryRouterClassification,
        index,
      )
      if (!currentClassification) return

      // Skip if this is the first user message (no previous user message available)
      if (index < 2) return

      // Get the previous user message
      const previousUserMessage = messages[index - 2]
      if (
        !previousUserMessage ||
        previousUserMessage.messageRole !== "user" ||
        !previousUserMessage.queryRouterClassification
      )
        return

      const prevClassification = parseQueryRouterClassification(
        previousUserMessage.queryRouterClassification,
        index - 2,
      )
      if (!prevClassification) return

      // If the current message is NOT a follow-up, store the previous user message's classification as a chain break
      if (currentClassification.isFollowUp === false) {
        chainBreaks.push({
          messageIndex: index - 2,
          classification: prevClassification,
          query: previousUserMessage.message || "",
        })
        getLoggerWithChild(Subsystem.Chat)().info(
          `[ChainBreak] Chain break detected: "${previousUserMessage.message}" → "${message.message}"`,
        )
      }
    }
  })

  return chainBreaks.reverse()
}

export function formatChainBreaksForPrompt(
  chainBreaks: ChainBreakClassification[],
) {
  if (chainBreaks.length === 0) {
    return null
  }

  const formatted = {
    availableChainBreaks: chainBreaks.map((chainBreak, index) => ({
      chainIndex: index + 1,
      messageIndex: chainBreak.messageIndex,
      originalQuery: chainBreak.query,
      classification: chainBreak.classification,
    })),
    usage:
      "These are previous conversation chains that were broken. The current query might relate to one of these earlier topics.",
  }
  return formatted
}

export function findOptimalCitationInsertionPoint(
  text: string,
  targetIndex: number,
): number {
  if (targetIndex >= text.length) {
    return text.length
  }

  if (targetIndex <= 0) {
    return 0
  }

  const charAtTarget = text[targetIndex]
  const charBeforeTarget = text[targetIndex - 1]

  // Word boundaries: space, punctuation, or start/end of text
  const isWordBoundary = (char: string) => /[\s\.,;:!?\-\(\)\[\]{}"]/.test(char)

  if (isWordBoundary(charBeforeTarget) || isWordBoundary(charAtTarget)) {
    return targetIndex
  }

  let leftBoundary = targetIndex
  let rightBoundary = targetIndex

  // Search backwards for a word boundary
  while (leftBoundary > 0 && !isWordBoundary(text[leftBoundary - 1])) {
    leftBoundary--
  }

  // Search forwards for a word boundary
  while (rightBoundary < text.length && !isWordBoundary(text[rightBoundary])) {
    rightBoundary++
  }

  const leftDistance = targetIndex - leftBoundary
  const rightDistance = rightBoundary - targetIndex

  // Prefer the closer boundary, but lean towards right boundary (end of word) for better readability
  if (leftDistance <= rightDistance || rightBoundary >= text.length) {
    return leftBoundary
  } else {
    return rightBoundary
  }
}
