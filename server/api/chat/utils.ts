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
  MailAttachmentEntity,
  WebSearchEntity,
  type MailParticipant,
} from "@xyne/vespa-ts/types"
import type { z } from "zod"
import { getDocumentOrSpreadsheet } from "@/integrations/google/sync"
import config from "@/config"
import type { UserQuery, QueryRouterLLMResponse } from "@/ai/types"
import {
  AgentReasoningStepType,
  OpenAIError,
  type AgentReasoningStep,
  type AttachmentMetadata,
} from "@/shared/types"
import type { Citation } from "@/api/chat/types"
import { getFolderItems, SearchEmailThreads } from "@/search/vespa"
import { getLoggerWithChild, getLogger } from "@/logger"
import type { Span } from "@/tracer"
import { Subsystem } from "@/types"
import type { SelectMessage } from "@/db/schema"
import { MessageRole } from "@/types"
const { maxValidLinks } = config
import fs from "fs"
import path from "path"
import {
  getAllCollectionAndFolderItems,
  getCollectionFilesVespaIds,
  getCollectionFoldersItemIds,
} from "@/db/knowledgeBase"
import { db } from "@/db/client"
import { collections, collectionItems } from "@/db/schema"
import { and, eq, isNull } from "drizzle-orm"
import { get } from "http"

// Follow-up context types and utilities
export type WorkingSet = {
  fileIds: string[]
  attachmentFileIds: string[] // images etc.
  carriedFromMessageIds: string[]
}

const MAX_FILES = 12

export function collectFollowupContext(
  messages: SelectMessage[],
  maxHops = 12,
): WorkingSet {
  const startIdx = messages.length - 1
  const ws: WorkingSet = {
    fileIds: [],
    attachmentFileIds: [],
    carriedFromMessageIds: [],
  }

  const seen = new Set<string>()
  let hops = 0

  // Extract chain breaks to understand conversation boundaries
  const chainBreaks = extractChainBreakClassifications(messages)
  const chainBreakIndices = new Set(chainBreaks.map((cb) => cb.messageIndex))

  for (let i = startIdx; i >= 0 && hops < maxHops; i--, hops++) {
    const m = messages[i]

    // 1) attachments the user explicitly added
    if (Array.isArray(m.attachments)) {
      for (const a of m.attachments as AttachmentMetadata[]) {
        if (a.isImage && a.fileId && !seen.has(`img:${a.fileId}`)) {
          ws.attachmentFileIds.push(a.fileId)
          ws.carriedFromMessageIds.push(m.externalId)
          seen.add(`img:${a.fileId}`)
          continue // images are separate from fileIds
        }
        if (a.fileId && !seen.has(`f:${a.fileId}`)) {
          ws.fileIds.push(a.fileId)
          ws.carriedFromMessageIds.push(m.externalId)
          seen.add(`f:${a.fileId}`)
          if (ws.fileIds.length >= MAX_FILES) break
        }
      }
    }

    // 2) fileIds from user messages
    if (Array.isArray(m.fileIds) && m.fileIds.length > 0) {
      for (const fileId of m.fileIds) {
        if (!seen.has(`f:${fileId}`)) {
          ws.fileIds.push(fileId)
          ws.carriedFromMessageIds.push(m.externalId)
          seen.add(`f:${fileId}`)
          if (ws.fileIds.length >= MAX_FILES) break
        }
      }
    }

    // 3) sourceIds from assistant messages
    if (
      Array.isArray(m.sources) &&
      m.sources.length > 0 &&
      ws.fileIds.length < MAX_FILES
    ) {
      for (const source of m.sources) {
        if (!seen.has(`f:${source.docId}`)) {
          ws.fileIds.push(source.docId)
          ws.carriedFromMessageIds.push(m.externalId)
          seen.add(`f:${source.docId}`)
          if (ws.fileIds.length >= MAX_FILES) break
        }
      }
    }

    // Stop if we hit a chain break (previous conversation topic)
    if (chainBreakIndices.has(i)) break
  }

  // De-dupe & trim
  ws.fileIds = Array.from(new Set(ws.fileIds)).slice(0, MAX_FILES)
  ws.attachmentFileIds = Array.from(new Set(ws.attachmentFileIds))

  return ws
}

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
  // Required fields
  itemIds: string[] // For Slack: channelIds, for Gmail: message/thread IDs
  selectedAll: boolean

  // Multiple filters array
  filters?: AppFilter[]
}

export interface AppFilter {
  id: number // Numeric identifier for this filter
  // Gmail-specific filters
  from?: string[]
  to?: string[]
  cc?: string[]
  bcc?: string[]
  // Slack-specific filters
  senderId?: string[]
  channelId?: string[]
  // Common filters
  timeRange?: {
    startDate: number
    endDate: number
  }
}

export interface AppSelectionMap {
  [appName: string]: AppSelection
}

export interface ParsedResult {
  selectedApps: Apps[]
  selectedItems: Partial<Record<Apps, string[]>>
  appFilters?: Partial<Record<Apps, AppFilter[]>> // Direct mapping - no redundancy!
}

export function parseAppSelections(input: AppSelectionMap): ParsedResult {
  const selectedApps: Apps[] = []
  let selectedItems: Record<Apps, string[]> = {} as Record<Apps, string[]>
  let appFilters: Record<Apps, AppFilter[]> = {} as Record<Apps, AppFilter[]>

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

    // SIMPLIFIED: Direct assignment without redundant nesting
    if (selection.filters && selection.filters.length > 0) {
      appFilters[app] = selection.filters // Direct assignment - no redundancy!
    }
  }

  const result: ParsedResult = {
    selectedApps,
    selectedItems,
  }

  // Only add appFilters if there are any
  if (Object.keys(appFilters).length > 0) {
    result.appFilters = appFilters
  }
  return result
}

// Interface for email search result fields
export interface EmailSearchResultFields {
  app: Apps
  parentThreadId?: string
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
    // const threadId = emailChild.fields.threadId
    const parentThreadId = emailChild.fields.parentThreadId

    // Skip if already in results
    if (!existingDocIds.has(docId)) {
      mergedResults.push(child)
      existingDocIds.add(docId)
      addedCount++

      // Track count per thread for logging
      if (parentThreadId) {
        threadInfo[parentThreadId] = (threadInfo[parentThreadId] || 0) + 1
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
    if (fields.app === Apps.Gmail && fields.parentThreadId) {
      if (!seenThreadIds.has(fields.parentThreadId)) {
        threadIds.push(fields.parentThreadId)
        seenThreadIds.add(fields.parentThreadId)
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
        // Split by newlines and spaces to handle various formatting
        const individualFileNames = imageContent
          .split(/\s+/)
          .map((name) => name.trim())
          .filter((name) => name.length > 0)

        for (const fileName of individualFileNames) {
          const lastUnderscoreIndex = fileName.lastIndexOf("_")
          if (lastUnderscoreIndex === -1) {
            console.warn(`Invalid image file name format: ${fileName}`)
            continue
          }

          const docId = fileName.substring(0, lastUnderscoreIndex)

          const docIndex =
            results?.findIndex((c) => (c.fields as any).docId === docId) ?? -1

          if (docIndex === -1) {
            console.warn(
              `No matching document found for docId: ${docId} in results for image content extraction.`,
            )
            continue
          }

          imageFileNames.push(`${docIndex}_${fileName}`)
        }
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
      threadId: (fields as VespaMail).threadId,
      parentThreadId: (fields as VespaMail).parentThreadId,
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
      page_title: clFields.pageTitle || "",
      entity: clFields.entity,
      itemId: clFields.itemId,
      clId: clFields.clId,
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
    throw new Error(
      `Invalid search result type for citation: ${result.fields.sddocname}`,
    )
  }
}

const searchToCitations = (results: VespaSearchResults[]): Citation[] => {
  if (results.length === 0) {
    return []
  }
  return results.map((result) => searchToCitation(result as VespaSearchResults))
}

export const textToCitationIndex = /\[(\d+)\]/g
export const textToImageCitationIndex = /(?<!K)\[(\d+_\d+)\]/g
export const textToKbItemCitationIndex = /K\[(\d+_\d+)\]/g

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
  pathRefId?: any,
): Promise<{
  totalValidFileIdsFromLinkCount: number
  fileIds: string[]
  threadIds: string[]
  webSearchResults?: { title: string; url: string }[]
  collectionFolderIds?: string[]
}> => {
  const fileIds: string[] = []
  const threadIds: string[] = []
  const driveItem: string[] = []
  const collectionFolderIds: string[] = []
  const collectionIds: string[] = []
  const webSearchResults: { title: string; url: string }[] = []

  if (pathRefId) {
    collectionFolderIds.push(pathRefId)
  }

  let validFileIdsFromLinkCount = 0
  let totalValidFileIdsFromLinkCount = 0

  try {
    const jsonMessage = JSON.parse(message) as UserQuery
    for (const obj of jsonMessage) {
      if (obj?.type === "pill") {
        if (
          obj?.value &&
          obj?.value?.entity &&
          obj?.value?.entity == DriveEntity.Folder
        ) {
          driveItem.push(obj?.value?.docId)
        } else if (obj?.value?.app === Apps.WebSearch) {
          webSearchResults.push({
            title: obj?.value?.title ?? "",
            url: obj?.value?.url || "",
          })
        } else {
          fileIds.push(obj?.value?.docId)
        }
        // Check if this pill has a threadId (for email threads)
        if (obj?.value?.threadId && obj?.value?.app === Apps.Gmail) {
          threadIds.push(obj?.value?.parentThreadId || obj?.value?.threadId)
        }

        const pillValue = obj.value
        const docId = obj.value.app !== Apps.WebSearch ? pillValue.docId : ""

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
  } catch (error) {}

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

  const collectionitems = await getAllCollectionAndFolderItems(
    collectionFolderIds,
    db,
  )
  const collectionPgFileIds = collectionitems.fileIds
  const collectionPgFolderIds = collectionitems.folderIds

  if (collectionFolderIds.length > 0) {
    const ids = await getCollectionFilesVespaIds(collectionPgFileIds, db)
    const vespaFileIds = ids
      .filter((item) => item.vespaDocId !== null)
      .map((item) => item.vespaDocId!)
    fileIds.push(...vespaFileIds)
    const folderVespaIds = await getCollectionFoldersItemIds(
      collectionPgFolderIds,
      db,
    )

    const vespaFolderIds = folderVespaIds
      .filter((item) => item.id !== null)
      .map((item) => item.id!)
    collectionIds.push(...vespaFolderIds)
  }

  // Ensure we always return the same structure
  return {
    totalValidFileIdsFromLinkCount,
    fileIds: fileIds.filter(Boolean),
    threadIds: threadIds.filter(Boolean),
    webSearchResults,
    collectionFolderIds: collectionIds.filter(Boolean),
  }
}
export const extractItemIdsFromPath = async (
  pathRefId: string,
): Promise<{
  collectionFileIds: string[]
  collectionFolderIds: string[]
  collectionIds: string[]
}> => {
  const collectionFileIds: string[] = []
  const collectionFolderIds: string[] = []
  const collectionIds: string[] = []

  // If pathRefId is empty string, return empty object
  if (!pathRefId || pathRefId === "") {
    return {
      collectionFileIds,
      collectionFolderIds,
      collectionIds,
    }
  }

  const vespaId = String(pathRefId)

  try {
    // Check prefix and do respective DB call
    if (vespaId.startsWith("clf-") || vespaId.startsWith("clfd-")) {
      // Collection file/folder prefix - extract ID and query collectionItems with type verification
      const isFile = vespaId.startsWith("clf-")
      const expectedType = isFile ? "file" : "folder"
      const [item] = await db
        .select({ id: collectionItems.id, type: collectionItems.type })
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.vespaDocId, vespaId),
            isNull(collectionItems.deletedAt),
          ),
        )

      // Verify the item exists and type matches the prefix
      if (item && item.type === expectedType) {
        if (isFile) {
          collectionFileIds.push(`clf-${item.id}`) // Keep the original prefixed ID
        } else {
          collectionFolderIds.push(`clfd-${item.id}`) // Keep the original prefixed ID
        }
      }
    } else if (vespaId.startsWith("cl-")) {
      // Collection prefix - extract ID and query collections table
      const [collection] = await db
        .select({ id: collections.id })
        .from(collections)
        .where(
          and(
            eq(collections.vespaDocId, vespaId),
            isNull(collections.deletedAt),
          ),
        )

      if (collection) {
        collectionIds.push(`cl-${collection.id}`) // Keep the original prefixed ID
      }
    } else {
    }
  } catch (error) {
    // Log error but don't throw - return empty arrays
    getLoggerWithChild(Subsystem.Chat)().error(
      `Error extracting item IDs from pathRefId: ${vespaId}`,
      error,
    )
  }

  // Ensure we always return the same structure
  return {
    collectionFileIds,
    collectionFolderIds,
    collectionIds,
  }
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

export function extractNamesFromIntent(intent: any): MailParticipant {
  if (!intent || typeof intent !== "object") return {}

  const result: MailParticipant = {}
  const fieldsToCheck = ["from", "to", "cc", "bcc"] as const

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
// // this helper function checks if the given value conforms to the AppSelectionMap structure
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

  // Look for the next newline after the target index
  for (let i = targetIndex; i < text.length; i++) {
    if (text[i] === "\n" || text[i] === "\r") {
      return i // Place citation just before the newline
    }
  }

  // If no newline found, look for sentence endings (., !, ?)
  for (let i = targetIndex; i < text.length; i++) {
    if (/[.!?]/.test(text[i])) {
      // Check if it's a real sentence ending (not decimal number)
      const prevChar = i > 0 ? text[i - 1] : ""
      const nextChar = i < text.length - 1 ? text[i + 1] : ""

      // Skip if it's a decimal number
      if (text[i] === "." && /\d/.test(prevChar) && /\d/.test(nextChar)) {
        continue
      }

      return i + 1 // Place after the sentence ending
    }
  }

  // Fallback: find the next space
  for (let i = targetIndex; i < text.length; i++) {
    if (text[i] === " ") {
      return i + 1 // Place after the space
    }
  }

  // Final fallback: end of text
  return text.length
}

export const isValidApp = (app: string): boolean => {
  return app
    ? Object.values(Apps)
        .map((v) => v.toLowerCase())
        .includes(app.toLowerCase() as Apps)
    : false
}

export const isValidEntity = (entity: string): boolean => {
  const normalizedEntity = entity?.toLowerCase()
  return normalizedEntity
    ? Object.values(DriveEntity)
        .map((v) => v.toLowerCase())
        .includes(normalizedEntity) ||
        Object.values(MailEntity)
          .map((v) => v.toLowerCase())
          .includes(normalizedEntity) ||
        Object.values(CalendarEntity)
          .map((v) => v.toLowerCase())
          .includes(normalizedEntity) ||
        Object.values(MailAttachmentEntity)
          .map((v) => v.toLowerCase())
          .includes(normalizedEntity) ||
        Object.values(GooglePeopleEntity)
          .map((v) => v.toLowerCase())
          .includes(normalizedEntity) ||
        Object.values(SlackEntity)
          .map((v) => v.toLowerCase())
          .includes(normalizedEntity) ||
        Object.values(WebSearchEntity)
          .map((v) => v.toLowerCase())
          .includes(normalizedEntity)
    : // Object.values(NotionEntity).map(v => v.toLowerCase()).includes(normalizedEntity)
      false
}
