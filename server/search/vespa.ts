import {
  Apps,
  CalendarEntity,
  DriveEntity,
  eventSchema,
  MailEntity,
  fileSchema,
  mailSchema,
  userQuerySchema,
  userSchema,
  mailAttachmentSchema,
  chatUserSchema,
  chatMessageSchema,
  datasourceSchema,
  dataSourceFileSchema,
  KbItemsSchema,
  type VespaDataSource,
  type VespaDataSourceFile,
  type VespaDataSourceSearch,
  type VespaKbFile,
  SlackEntity,
  chatContainerSchema,
} from "@/search/types"
import type { Intent } from "@/ai/types"
import type {
  VespaAutocompleteResponse,
  VespaFile,
  VespaMail,
  VespaSearchResult,
  VespaSearchResponse,
  VespaUser,
  VespaGetResult,
  Entity,
  VespaEvent,
  VespaUserQueryHistory,
  VespaSchema,
  VespaMailAttachment,
  VespaChatContainer,
  Inserts,
  VespaChatUserSearchSchema,
  VespaSearchResults,
  ChatUserCore,
} from "@/search/types"
import { getErrorMessage } from "@/utils"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import {
  ErrorDeletingDocuments,
  ErrorGettingDocument,
  ErrorUpdatingDocument,
  ErrorRetrievingDocuments,
  ErrorPerformingSearch,
  ErrorInsertingDocument,
} from "@/errors"
import { getTracer, type Span, type Tracer } from "@/tracer"
import crypto from "crypto"
import VespaClient from "@/search/vespaClient"
import pLimit from "p-limit"
import { VespaSearchResponseToSearchResult } from "./mappers"
import { getAppSyncJobsByEmail } from "@/db/syncJob"
import { AuthType } from "@/shared/types"
import { db } from "@/db/client"
import { getConnectorByAppAndEmailId } from "@/db/connector"
import { ProductionVespaClient } from "./productionVespaClient"
import {
  getAllFolderItems,
  getCollectionFilesVespaIds,
} from "@/db/knowledgeBase"

const prodUrl = process.env.PRODUCTION_SERVER_URL
const apiKey = process.env.API_KEY

const vespa =
  prodUrl && apiKey
    ? new ProductionVespaClient(prodUrl, apiKey)
    : new VespaClient()
const fallbackVespa = new VespaClient()

// Define your Vespa endpoint and schema name
const vespaEndpoint = `http://${config.vespaBaseHost}:8080`
export const NAMESPACE = "namespace" // Replace with your actual namespace
const CLUSTER = "my_content"

const Logger = getLogger(Subsystem.Vespa).child({ module: "vespa" })

/**
 * Deletes all documents from the specified schema and namespace in Vespa.
 */
async function deleteAllDocuments() {
  return fallbackVespa
    .deleteAllDocuments({
      cluster: CLUSTER,
      namespace: NAMESPACE,
      schema: fileSchema,
    })
    .catch((error) => {
      Logger.error(`Deleting documents failed with error:`, error)
      throw new ErrorDeletingDocuments({
        cause: error as Error,
        sources: AllSources,
      })
    })
}

export const insertDocument = async (document: VespaFile) => {
  return fallbackVespa
    .insertDocument(document, {
      namespace: NAMESPACE,
      schema: fileSchema,
    })
    .catch((error) => {
      Logger.error(`Inserting document failed with error:`, error)
      throw new ErrorInsertingDocument({
        docId: document.docId,
        cause: error as Error,
        sources: fileSchema,
      })
    })
}

// Renamed to reflect its purpose: retrying a single insert
export const insertWithRetry = async (
  document: Inserts,
  schema: VespaSchema,
  maxRetries = 8,
) => {
  let lastError: any
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fallbackVespa.insert(document, { namespace: NAMESPACE, schema })
      Logger.debug(`Inserted document ${document.docId}`)
      return
    } catch (error) {
      lastError = error
      if (
        (error as Error).message.includes("429 Too Many Requests") &&
        attempt < maxRetries
      ) {
        const delayMs = Math.pow(2, attempt) * 2000
        Logger.warn(
          `Vespa 429 for ${document.docId}, retrying in ${delayMs}ms (attempt ${attempt + 1})`,
        )
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      } else {
        throw new Error(
          `Error inserting document ${document.docId}: ${(error as Error).message}`,
        )
      }
    }
  }
  throw new Error(
    `Failed to insert ${document.docId} after ${maxRetries} retries: ${lastError.message}`,
  )
}

// generic insert method
export const insert = async (document: Inserts, schema: VespaSchema) => {
  return fallbackVespa
    .insert(document, { namespace: NAMESPACE, schema })
    .catch((error) => {
      Logger.error(`Inserting document failed with error:`, error)
      throw new ErrorInsertingDocument({
        docId: document.docId,
        cause: error as Error,
        sources: schema,
      })
    })
}

export const insertUser = async (user: VespaUser) => {
  return fallbackVespa
    .insertUser(user, { namespace: NAMESPACE, schema: userSchema })
    .catch((error) => {
      Logger.error(`Inserting user failed with error:`, error)
      throw new ErrorInsertingDocument({
        docId: user.docId,
        cause: error as Error,
        sources: userSchema,
      })
    })
}

export const deduplicateAutocomplete = (
  resp: VespaAutocompleteResponse,
): VespaAutocompleteResponse => {
  const { root } = resp
  if (!root.children) {
    return resp
  }
  const uniqueResults = []
  const emails = new Set()
  for (const child of root.children) {
    // @ts-ignore
    const email = child.fields.email
    if (email && !emails.has(email)) {
      emails.add(email)
      uniqueResults.push(child)
    } else if (!email) {
      uniqueResults.push(child)
    }
  }
  resp.root.children = uniqueResults
  return resp
}

const AllSources = [
  fileSchema,
  userSchema,
  mailSchema,
  eventSchema,
  mailAttachmentSchema,
  chatUserSchema,
  chatMessageSchema,
  chatContainerSchema,
  // Not adding datasource or datasource_file to AllSources by default,
  // as they are for a specific app functionality.
  // dataSourceFileSchema and collection file schemas are intentionally excluded from search
].join(", ")

export const autocomplete = async (
  query: string,
  email: string,
  limit: number = 5,
): Promise<VespaAutocompleteResponse> => {
  const sources = AllSources.split(", ")
    .filter((s) => s !== chatMessageSchema)
    .join(", ")

  // Construct the YQL query for fuzzy prefix matching with maxEditDistance:2
  // the drawback here is that for user field we will get duplicates, for the same
  // email one contact and one from user directory
  const yqlQuery = `select * from sources ${sources}, ${userQuerySchema}
    where
        (title_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
        and permissions contains @email)
        or
        (
            (name_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
            and owner contains @email)
            or
            (email_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
            and owner contains @email)
        )
        or
        (
            (name_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
            and app contains "${Apps.GoogleWorkspace}")
            or
            (email_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
            and app contains "${Apps.GoogleWorkspace}")
        )
        or
        (subject_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
        and permissions contains @email)
        or
        (name_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
        and permissions contains @email)
        or
        (query_text contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
        and owner contains @email)
        or
        (
          (
            name_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query)) or
            email_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
          )
          and permissions contains @email
        )
        `

  const searchPayload = {
    yql: yqlQuery,
    query,
    email: email,
    hits: limit, // Limit the number of suggestions
    "ranking.profile": "autocomplete", // Use the autocomplete rank profile
    "presentation.summary": "autocomplete",
    timeout: "5s",
  }

  return vespa
    .autoComplete(searchPayload)
    .catch((err) => {
      if (vespa instanceof ProductionVespaClient) {
        Logger.warn(err, "Prod vespa failed in autoComplete, trying fallback")
        return fallbackVespa.autoComplete(searchPayload)
      }
      throw err
    })
    .catch((error) => {
      Logger.error(`Autocomplete failed with error:`, error)
      throw new ErrorPerformingSearch({
        message: `Error performing autocomplete search`,
        cause: error as Error,
        sources: "file",
      })
      // TODO: instead of null just send empty response
      throw error
    })
}

export enum SearchModes {
  NativeRank = "default_native",
  BM25 = "default_bm25",
  AI = "default_ai",
  Random = "default_random",
  GlobalSorted = "global_sorted",
  BoostTitle = "title_boosted_hybrid",
}

type YqlProfile = {
  profile: SearchModes
  yql: string
}

const handleAppsNotInYql = (app: Apps | null, includedApp: Apps[]) => {
  Logger.error(`${app} is not supported in YQL queries yet`)
  throw new ErrorPerformingSearch({
    message: `${app} is not supported in YQL queries yet`,
    sources: includedApp.join(", "),
  })
}

// TODO: it seems the owner part is complicating things
export const HybridDefaultProfile = (
  hits: number,
  app: Apps | Apps[] | null,
  entity: Entity | Entity[] | null,
  profile: SearchModes = SearchModes.NativeRank,
  timestampRange?: { to: number | null; from: number | null } | null,
  excludedIds?: string[],
  notInMailLabels?: string[],
  excludedApps?: Apps[],
  intent?: Intent | null,
): YqlProfile => {
  // Helper function to build timestamp conditions
  const buildTimestampConditions = (fromField: string, toField: string) => {
    const conditions: string[] = []
    if (timestampRange?.from) {
      conditions.push(`${fromField} >= ${timestampRange.from}`)
    }
    if (timestampRange?.to) {
      conditions.push(`${toField} <= ${timestampRange.to}`)
    }
    return conditions.join(" and ")
  }

  // ToDo we have to handle this filter as we are applying multiple times app filtering
  // Helper function to build app/entity filter
  const buildAppEntityFilter = () => {
    return `${
      app
        ? (Array.isArray(app) && app.length > 0)
          ? `and ${app.map((a) => `app contains '${escapeYqlValue(a)}'`).join(" or ")}`
          : "and app contains @app"
        : ""
    } ${
      entity
        ? Array.isArray(entity) && entity.length > 0
          ? `and ${entity.map((e) => `entity contains '${escapeYqlValue(e)}'`).join(" or ")}`
          : "and entity contains @entity"
        : ""
    }`.trim()
  }

  // Helper function to build exclusion condition
  const buildExclusionCondition = () => {
    if (!excludedIds || excludedIds.length === 0) return ""
    return excludedIds.map((id) => `docId contains '${id}'`).join(" or ")
  }

  // Helper function to build mail label query
  const buildMailLabelQuery = () => {
    if (!notInMailLabels || notInMailLabels.length === 0) return ""
    return `and !(${notInMailLabels.map((label) => `labels contains '${label}'`).join(" or ")})`
  }
  const intentFilter = intent ? buildIntentFilter(intent) : ""

  // App-specific YQL builders
  const buildGoogleWorkspaceYQL = () => {
    const userTimestamp = buildTimestampConditions(
      "creationTime",
      "creationTime",
    )
    const appOrEntityFilter = buildAppEntityFilter()
    const hasAppOrEntity = !!(app || entity)
    return `
      (
        (
          ({targetHits:${hits}} userInput(@query))
          or
          ({targetHits:${hits}} nearestNeighbor(chunk_embeddings, e))
        )
        ${userTimestamp.length ? `and (${userTimestamp})` : ""}
        ${
          !hasAppOrEntity
            ? `and app contains "${Apps.GoogleWorkspace}"`
            : `${appOrEntityFilter} and permissions contains @email`
        }
        ${intentFilter}
      )
      or
      (
        (
          ({targetHits:${hits}} userInput(@query))
          or
          ({targetHits:${hits}} nearestNeighbor(chunk_embeddings, e))
        )
        and owner contains @email
        ${userTimestamp.length ? `and ${userTimestamp}` : ""}
        ${appOrEntityFilter}
      )`
  }

  const buildGmailYQL = () => {
    const mailTimestamp = buildTimestampConditions("timestamp", "timestamp")
    const appOrEntityFilter = buildAppEntityFilter()
    const mailLabelQuery = buildMailLabelQuery()
    return `
      (
        (
          ({targetHits:${hits}} userInput(@query))
          or
          ({targetHits:${hits}} nearestNeighbor(chunk_embeddings, e))
        )
        ${mailTimestamp.length ? `and (${mailTimestamp})` : ""}
        and permissions contains @email
        ${mailLabelQuery}
        ${appOrEntityFilter}
        ${intentFilter}
      )`
  }

  const buildDefaultYQL = () => {
    const appOrEntityFilter = buildAppEntityFilter()
    const timestamp = buildTimestampConditions("updatedAt", "updatedAt")
    return ` 
  (
      (
            ({targetHits:${hits}} userInput(@query))
            or
            ({targetHits:${hits}} nearestNeighbor(chunk_embeddings, e))
      )
      and (permissions contains @email or owner contains @email)
      ${timestamp.length ? `and (${timestamp})` : ""}
      ${appOrEntityFilter}
      ${intentFilter}
  )
  `
  }

  const buildGoogleDriveYQL = () => {
    const fileTimestamp = buildTimestampConditions("updatedAt", "updatedAt")
    const appOrEntityFilter = buildAppEntityFilter()
    return `
      (
        (
          ({targetHits:${hits}} userInput(@query))
          or
          ({targetHits:${hits}} nearestNeighbor(chunk_embeddings, e))
        )
        ${fileTimestamp.length ? `and (${fileTimestamp})` : ""}
        and permissions contains @email
        ${appOrEntityFilter}
        ${intentFilter}
      )`
  }

  const buildGoogleCalendarYQL = () => {
    const eventTimestamp = buildTimestampConditions("startTime", "startTime")
    const appOrEntityFilter = buildAppEntityFilter()
    return `
      (
        (
          ({targetHits:${hits}} userInput(@query))
          or
          ({targetHits:${hits}} nearestNeighbor(chunk_embeddings, e))
        )
        ${eventTimestamp.length ? `and (${eventTimestamp})` : ""}
        and permissions contains @email
        ${appOrEntityFilter}
        ${intentFilter}
      )`
  }

  const buildSlackYQL = () => {
    const appOrEntityFilter = buildAppEntityFilter()
    const timestamp = buildTimestampConditions("updatedAt", "updatedAt")
    return `
      (
        (
          ({targetHits:${hits}} userInput(@query))
          or
          ({targetHits:${hits}} nearestNeighbor(text_embeddings, e))
        )
        ${timestamp.length ? `and (${timestamp})` : ""}
        ${appOrEntityFilter}
        and permissions contains @email
      )`
  }

  // Start with AllSources and filter out excluded app schemas
  let newSources = AllSources
  if (excludedApps && excludedApps.length > 0) {
    let sourcesToExclude: string[] = []

    excludedApps.forEach((excludedApp) => {
      switch (excludedApp) {
        case Apps.Slack:
          sourcesToExclude.push(chatMessageSchema, chatUserSchema)
          break
        case Apps.Gmail:
          sourcesToExclude.push(mailSchema, mailAttachmentSchema)
          break
        case Apps.GoogleDrive:
          sourcesToExclude.push(fileSchema)
          break
        case Apps.GoogleCalendar:
          sourcesToExclude.push(eventSchema)
          break
        case Apps.GoogleWorkspace:
          sourcesToExclude.push(userSchema)
          break
      }
    })
    newSources = newSources
      .split(", ")
      .filter((source) => !sourcesToExclude.includes(source))
      .join(", ")
  }

  // Start with all apps and filter out excluded ones
  const allApps = Object.values(Apps)
  const includedApps = allApps.filter(
    (appItem) => !excludedApps?.includes(appItem),
  )

  // Build app-specific queries for included apps
  const appQueries: string[] = []

  for (const includedApp of includedApps) {
    switch (includedApp) {
      case Apps.GoogleWorkspace:
        appQueries.push(buildGoogleWorkspaceYQL())
        break
      case Apps.Gmail:
        appQueries.push(buildGmailYQL())
        break
      case Apps.GoogleDrive:
        appQueries.push(buildGoogleDriveYQL())
        break
      case Apps.GoogleCalendar:
        appQueries.push(buildGoogleCalendarYQL())
        break
      case Apps.Slack:
        appQueries.push(buildSlackYQL())
        break
      case Apps.DataSource:
        break
      default:
        appQueries.push(buildDefaultYQL())
        break
    }
  }

  // Combine all queries
  const combinedQuery = appQueries.join("\nor\n")
  const exclusionCondition = buildExclusionCondition()

  return {
    profile: profile,
    yql: `
    select * from sources ${newSources}
        where (
          (
            ${combinedQuery}
          )
          ${exclusionCondition ? `and !(${exclusionCondition})` : ""}
        )
    `,
  }
}
// Helper function to build intent filter
const buildIntentFilter = (intent: Intent | null) => {
  const intentFilters: string[] = []
  if (intent?.from && intent.from.length > 0) {
    intentFilters.push(
      intent.from.map((from) => `\"from\" contains '${from}'`).join(" or "),
    )
  }
  if (intent?.to && intent.to.length > 0) {
    intentFilters.push(
      intent.to.map((to) => `to contains '${to}'`).join(" or "),
    )
  }
  if (intent?.cc && intent.cc.length > 0) {
    intentFilters.push(
      intent.cc.map((cc) => `cc contains '${cc}'`).join(" or "),
    )
  }
  if (intent?.bcc && intent.bcc.length > 0) {
    intentFilters.push(
      intent.bcc.map((bcc) => `bcc contains '${bcc}'`).join(" or "),
    )
  }
  return intentFilters.length > 0
    ? "and" + " " + intentFilters.join(" and ")
    : ""
}
export const HybridDefaultProfileForAgent = async (
  email: string,
  hits: number,
  app: Apps | Apps[] | null,
  entity: Entity | Entity[] | null,
  profile: SearchModes = SearchModes.NativeRank,
  timestampRange?: { to: number | null; from: number | null } | null,
  excludedIds?: string[],
  notInMailLabels?: string[],
  AllowedApps: Apps[] | null = null,
  dataSourceIds: string[] = [],
  intent: Intent | null = null,
  channelIds: string[] = [],
  collectionSelections: Array<{
    collectionIds?: string[]
    collectionFolderIds?: string[]
    collectionFileIds?: string[]
  }> = [],
  driveIds: string[] = [],
  selectedItem: {} = {},
): Promise<YqlProfile> => {
  // Helper function to build timestamp conditions
  const buildTimestampConditions = (fromField: string, toField: string) => {
    const conditions: string[] = []
    if (timestampRange?.from) {
      conditions.push(`${fromField} >= ${timestampRange.from}`)
    }
    if (timestampRange?.to) {
      conditions.push(`${toField} <= ${timestampRange.to}`)
    }
    return conditions.join(" and ")
  }

  // helper function to build docId inclusion condition
  const buildDocsInclusionCondition = (fieldName: string, ids: string[]) => {
    if (!ids || ids.length === 0) return ""

    const conditions = ids.map((id) => `${fieldName} contains '${id.trim()}'`)
    return conditions.join(" or ")
  }

  // Helper function to build app/entity filter
  const buildAppEntityFilter = () => {
    return `${
      app
        ? (Array.isArray(app) && app.length > 0)
          ? `and ${app.map((a) => `app contains '${escapeYqlValue(a)}'`).join(" or ")}`
          : "and app contains @app"
        : ""
    } ${
      entity
        ? Array.isArray(entity) && entity.length > 0
          ? `and ${entity.map((e) => `entity contains '${escapeYqlValue(e)}'`).join(" or ")}`
          : "and entity contains @entity"
        : ""
    }`.trim()
  }
  // Helper function to build exclusion condition
  const buildExclusionCondition = () => {
    if (!excludedIds || excludedIds.length === 0) return ""
    return excludedIds.map((id) => `docId contains '${id}'`).join(" or ")
  }
  // Helper function to build mail label query
  const buildMailLabelQuery = () => {
    if (!notInMailLabels || notInMailLabels.length === 0) return ""
    return `and !(${notInMailLabels.map((label) => `labels contains '${label}'`).join(" or ")})`
  }
  // App-specific YQL builders
  const buildGoogleWorkspaceYQL = () => {
    const userTimestamp = buildTimestampConditions(
      "creationTime",
      "creationTime",
    )
    const appOrEntityFilter = buildAppEntityFilter()
    const hasAppOrEntity = !!(app || entity)
    const intentFilter = buildIntentFilter(intent)
    return `
      (
        ({targetHits:${hits}} userInput(@query))
        ${timestampRange ? `and (${userTimestamp})` : ""}
        ${
          !hasAppOrEntity
            ? `and app contains "${Apps.GoogleWorkspace}"`
            : `${appOrEntityFilter} and permissions contains @email`
        }
      )
      or
      (
        ({targetHits:${hits}} userInput(@query))
        and owner contains @email
        ${timestampRange ? `and ${userTimestamp}` : ""}
        ${appOrEntityFilter}
        ${intentFilter}
      )`
  }
  const buildGmailYQL = () => {
    const mailTimestamp = buildTimestampConditions("timestamp", "timestamp")
    const appOrEntityFilter = buildAppEntityFilter()
    const mailLabelQuery = buildMailLabelQuery()
    const intentFilter = buildIntentFilter(intent)
    return `
      (
        (
          ({targetHits:${hits}} userInput(@query))
          or
          ({targetHits:${hits}} nearestNeighbor(chunk_embeddings, e))
        )
        ${timestampRange ? `and (${mailTimestamp})` : ""}
        and permissions contains @email
        ${mailLabelQuery}
        ${appOrEntityFilter}
        ${intentFilter}
      )`
  }
  const buildGoogleDriveYQL = async () => {
    const fileTimestamp = buildTimestampConditions("updatedAt", "updatedAt")
    const appOrEntityFilter = buildAppEntityFilter()
    // let driveItem:string [] = []
    // if we have some DriveIds then we are going to fetch all the items in that folder
    const intentFilter = buildIntentFilter(intent)
    let driveItem: string[] = []
    if ((selectedItem as any)[Apps.GoogleDrive]) {
      driveItem = [...(selectedItem as any)[Apps.GoogleDrive]]
    }
    const driveIds = []

    while (driveItem.length) {
      let curr = driveItem.shift()
      // Ensure email is defined before passing it to getFolderItems\
      if (curr) driveIds.push(curr)
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
                driveIds.push((item.fields as any).docId)
              }
            }
          }
        } catch (error) {
          Logger.error("failed to fetch drive items")
        }
      }
    }
    const driveIdConditions = buildDocsInclusionCondition("docId", driveIds)
    return `
      (
        (
          ({targetHits:${hits}} userInput(@query))
          or
          ({targetHits:${hits}} nearestNeighbor(chunk_embeddings, e))
        )
        ${timestampRange ? `and (${fileTimestamp})` : ""}
        and permissions contains @email
        ${appOrEntityFilter}
        ${driveIdConditions ? `and ${driveIdConditions}` : ""}
        ${intentFilter}
      )
     `
  }
  const buildGoogleCalendarYQL = () => {
    const eventTimestamp = buildTimestampConditions("startTime", "startTime")
    const appOrEntityFilter = buildAppEntityFilter()
    const intentFilter = buildIntentFilter(intent)
    return `
      (
        (
          ({targetHits:${hits}} userInput(@query))
          or
          ({targetHits:${hits}} nearestNeighbor(chunk_embeddings, e))
        )
        ${timestampRange ? `and (${eventTimestamp})` : ""}
        and permissions contains @email
        ${appOrEntityFilter}
        ${intentFilter}
      )`
  }
  const buildSlackYQL = () => {
    const appOrEntityFilter = buildAppEntityFilter()
    let channelIds: string[] = []
    const intentFilter = buildIntentFilter(intent)
    channelIds = (selectedItem as Record<string, unknown>)[Apps.Slack] as any
    const channelIdConditions = buildDocsInclusionCondition("docId", channelIds)

    return `
      (
        (
          ({targetHits:${hits}} userInput(@query))
          or
          ({targetHits:${hits}} nearestNeighbor(text_embeddings, e))
        )
        ${appOrEntityFilter}
        and permissions contains @email
        ${channelIdConditions ? `and ${channelIdConditions}` : ""}
      )`
  }

  const buildDataSourceFileYQL = () => {
    // For DataSourceFile, app and entity might not be directly applicable in the same way,
    // but keeping appOrEntityFilter for consistency if needed for other metadata.

    const dsIds = (selectedItem as Record<string, unknown>)[
      Apps.DataSource
    ] as any
    const dataSourceIdConditions = buildDocsInclusionCondition(
      "dataSourceId",
      dsIds,
    )

    return `
      (
        (
          ({targetHits:${hits}}userInput(@query))
          or
          ({targetHits:${hits}}nearestNeighbor(chunk_embeddings, e))
        ) 
        and ${dataSourceIdConditions}
      )`
  }

  const buildCollectionFileYQL = async () => {
    console.log("collectionSelections:", collectionSelections)

    // Extract all IDs from the key-value pairs
    const collectionIds: string[] = []
    const collectionFolderIds: string[] = []
    const collectionFileIds: string[] = []

    for (const selection of collectionSelections) {
      if (selection.collectionIds) {
        collectionIds.push(...selection.collectionIds)
      }
      if (selection.collectionFolderIds) {
        collectionFolderIds.push(...selection.collectionFolderIds)
      }
      if (selection.collectionFileIds) {
        collectionFileIds.push(...selection.collectionFileIds)
      }
    }
    let conditions: string[] = []

    // Handle entire collections - use clId filter (efficient)
    if (collectionIds.length > 0) {
      const collectionCondition = `(${collectionIds.map((id: string) => `clId contains '${id.trim()}'`).join(" or ")})`
      conditions.push(collectionCondition)
    }

    // Handle specific folders - need to get file IDs (less efficient but necessary)
    if (collectionFolderIds.length > 0) {
      const clFileIds = await getAllFolderItems(collectionFolderIds, db)
      if (clFileIds.length > 0) {
        const ids = await getCollectionFilesVespaIds(clFileIds, db)
        const clVespaIds = ids
          .filter((item: any) => item.vespaDocId !== null)
          .map((item: any) => item.vespaDocId!)

        if (clVespaIds.length > 0) {
          const folderCondition = `(${clVespaIds.map((id: string) => `docId contains '${id.trim()}'`).join(" or ")})`
          conditions.push(folderCondition)
        }
      }
    }

    // Handle specific files - use file IDs directly (most efficient for individual files)
    if (collectionFileIds.length > 0) {
      const ids = await getCollectionFilesVespaIds(collectionFileIds, db)
      const clVespaIds = ids
        .filter((item: any) => item.vespaDocId !== null)
        .map((item: any) => item.vespaDocId!)

      if (clVespaIds.length > 0) {
        const fileCondition = `(${clVespaIds.map((id: string) => `docId contains '${id.trim()}'`).join(" or ")})`
        conditions.push(fileCondition)
      }
    }

    const finalCondition =
      conditions.length > 0 ? `(${conditions.join(" or ")})` : "true"
    console.log(finalCondition)
    // Collection files use clId for collections and docId for folders/files
    return `
      (
        (
          ({targetHits:${hits}}userInput(@query))
          or
          ({targetHits:${hits}}nearestNeighbor(chunk_embeddings, e))
        ) 
        and ${finalCondition}
      )`
  }

  // Build app-specific queries and sources
  const appQueries: string[] = []
  const sources: string[] = []

  if (AllowedApps && AllowedApps.length > 0) {
    for (const allowedApp of AllowedApps) {
      switch (allowedApp) {
        case Apps.GoogleWorkspace:
          appQueries.push(buildGoogleWorkspaceYQL())
          if (!sources.includes(userSchema)) sources.push(userSchema)
          break
        case Apps.Gmail:
          appQueries.push(buildGmailYQL())
          if (!sources.includes(mailSchema)) sources.push(mailSchema)
          break
        case Apps.GoogleDrive:
          const googleDriveYQL = await buildGoogleDriveYQL()
          appQueries.push(googleDriveYQL)
          if (!sources.includes(fileSchema)) sources.push(fileSchema)
          break
        case Apps.GoogleCalendar:
          appQueries.push(buildGoogleCalendarYQL())
          if (!sources.includes(eventSchema)) sources.push(eventSchema)
          break
        case Apps.Slack:
          appQueries.push(buildSlackYQL())
          if (!sources.includes(chatUserSchema)) sources.push(chatUserSchema)
          if (!sources.includes(chatMessageSchema))
            sources.push(chatMessageSchema)
          if (!sources.includes(chatContainerSchema))
            sources.push(chatContainerSchema)
          break
        case Apps.DataSource:
          appQueries.push(buildDataSourceFileYQL())
          if (!sources.includes(dataSourceFileSchema))
            sources.push(dataSourceFileSchema)
          break
        case Apps.KnowledgeBase:
          if (collectionSelections && collectionSelections.length > 0) {
            const collectionQuery = await buildCollectionFileYQL()
            if (collectionQuery) {
              appQueries.push(collectionQuery)
              if (!sources.includes(KbItemsSchema)) sources.push(KbItemsSchema)
            }
          } else {
            Logger.warn(
              "Apps.KnowledgeBase specified for agent, but no specific collectionIds provided. Skipping generic KnowledgeBase search part.",
            )
          }
          break
      }
    }
  } else if (dataSourceIds && dataSourceIds.length > 0) {
    // This handles the case where AllowedApps might be empty or null,
    // but specific dataSourceIds are provided (e.g., agent is only for specific data sources).
    appQueries.push(buildDataSourceFileYQL())
    if (!sources.includes(dataSourceFileSchema))
      sources.push(dataSourceFileSchema)
  }
  if (channelIds.length > 0) {
    appQueries.push(buildSlackYQL())
    if (!sources.includes(chatUserSchema)) sources.push(chatUserSchema)
    if (!sources.includes(chatMessageSchema)) sources.push(chatMessageSchema)
    if (!sources.includes(chatContainerSchema))
      sources.push(chatContainerSchema)
  }
  // Debug logging
  Logger.debug(`Agent search configuration:`, {
    AllowedApps,
    dataSourceIds,
    collectionSelections,
    appQueriesCount: appQueries.length,
    sources,
  })

  // Combine all queries
  const combinedQuery = appQueries.join("\n    or\n    ")
  const exclusionCondition = buildExclusionCondition()
  const sourcesString = [...new Set(sources)].join(", ") // Ensure unique sources

  // If sourcesString is empty (e.g., only Apps.DataSource was specified but no dataSourceIds were provided,
  // or no valid AllowedApps were given), then the YQL query will be invalid.
  const fromClause = sourcesString ? `from sources ${sourcesString}` : ""

  const finalYql = `
    select *
    ${fromClause} 
    where
    (
      (
        ${combinedQuery}
      )
      ${exclusionCondition ? `and !(${exclusionCondition})` : ""}
    )
    ;
    `
  Logger.debug(`Generated YQL for agent search:`, {
    yql: finalYql,
    sources: sourcesString,
    hasCollectionQueries:
      collectionSelections && collectionSelections.length > 0,
  })

  return {
    profile: profile,
    yql: finalYql,
  }
}

export const HybridDefaultProfileInFiles = (
  hits: number,
  profile: SearchModes = SearchModes.NativeRank,
  fileIds: string[],
  notInMailLabels?: string[],
): YqlProfile => {
  let mailLabelQuery = ""
  if (notInMailLabels && notInMailLabels.length > 0) {
    mailLabelQuery = `and !(${notInMailLabels.map((label) => `labels contains '${label}'`).join(" or ")})`
  }

  const contextClauses: string[] = []

  if (fileIds?.length) {
    const idFilters = fileIds.map((id) => `docId contains '${id}'`)
    contextClauses.push(...idFilters)
  }

  const specificContextQuery = contextClauses.length
    ? `and (${contextClauses.join(" or ")})`
    : ""

  // the last 2 'or' conditions are due to the 2 types of users, contacts and admin directory present in the same schema
  return {
    profile: profile,
    yql: `
        select * from sources ${AllSources}
        where ((
          (
            (
              ({targetHits:${hits}}userInput(@query))
              or
              ({targetHits:${hits}}nearestNeighbor(chunk_embeddings, e))
            )
            and permissions contains @email ${mailLabelQuery}
            ${specificContextQuery} 
          )
            or
            (
              (
              ({targetHits:${hits}}userInput(@query))
              or
              ({targetHits:${hits}}nearestNeighbor(text_embeddings, e))
            )
              and permissions contains @email ${specificContextQuery}
            )
          or
          (
            ({targetHits:${hits}}userInput(@query))
            and permissions contains @email ${specificContextQuery}
          )
          or
          (
            ({targetHits:${hits}}userInput(@query))
            and owner contains @email
            ${specificContextQuery}
          )
        )
      )`,
  }
}

export const HybridDefaultProfileForSlack = (
  hits: number,
  profile: SearchModes = SearchModes.NativeRank,
  channelIds?: string[],
  threadId?: string,
  userId?: string,
  timestampRange?: { to: number | null; from: number | null } | null,
): YqlProfile => {
  // Helper function to build timestamp conditions
  const buildTimestampConditions = (fromField: string, toField: string) => {
    const conditions: string[] = []
    if (timestampRange?.from) {
      conditions.push(`${fromField} >= ${timestampRange.from}`)
    }
    if (timestampRange?.to) {
      conditions.push(`${toField} <= ${timestampRange.to}`)
    }
    return conditions.join(" and ")
  }

  const timestampCondition = buildTimestampConditions("createdAt", "createdAt")

  const channelIdConditions =
    channelIds && channelIds.length > 0
      ? `(${channelIds.map((id) => `channelId contains '${id}'`).join(" or ")})`
      : ""

  const threadIdCondition = threadId ? `threadId contains '${threadId}'` : ""
  const userIdCondition = userId ? `userId contains '${userId}'` : ""

  const conditions = [
    timestampCondition,
    channelIdConditions,
    threadIdCondition,
    userIdCondition,
  ]
    .filter(Boolean)
    .join(" and ")

  const yql = `
    select * from sources ${chatMessageSchema}
    where (
      (
        (
          ({targetHits:${hits}} userInput(@query))
          or
          ({targetHits:${hits}} nearestNeighbor(text_embeddings, e))
        )
        and permissions contains @email
        ${conditions ? `and ${conditions}` : ""}
      )
    )
  `

  return {
    profile: profile,
    yql: yql,
  }
}

const HybridDefaultProfileAppEntityCounts = (
  hits: number,
  timestampRange: { to: number; from: number } | null,
  notInMailLabels?: string[],
  excludedApps?: Apps[],
): YqlProfile => {
  // Helper function to build timestamp conditions
  const buildTimestampConditions = (fromField: string, toField: string) => {
    const conditions: string[] = []
    if (timestampRange?.from) {
      conditions.push(`${fromField} >= ${timestampRange.from}`)
    }
    if (timestampRange?.to) {
      conditions.push(`${toField} <= ${timestampRange.to}`)
    }
    return conditions.join(" and ")
  }

  // Helper function to build mail label query
  const buildMailLabelQuery = () => {
    if (!notInMailLabels || notInMailLabels.length === 0) return ""
    return `and !(${notInMailLabels.map((label) => `labels contains '${label}'`).join(" or ")})`
  }

  // Validate timestamp range
  if (timestampRange && !timestampRange.from && !timestampRange.to) {
    throw new Error("Invalid timestamp range")
  }

  // App-specific YQL builders for counting
  const buildFilesAndMailYQL = () => {
    const fileTimestamp = buildTimestampConditions("updatedAt", "updatedAt")
    const mailTimestamp = buildTimestampConditions("timestamp", "timestamp")
    const mailLabelQuery = buildMailLabelQuery()

    return `
      (
        (
          ({targetHits:${hits}}userInput(@query))
          or
          ({targetHits:${hits}}nearestNeighbor(chunk_embeddings, e))
        )
        ${timestampRange ? `and (${fileTimestamp} or ${mailTimestamp})` : ""}
        and permissions contains @email
        ${mailLabelQuery}
      )`
  }

  const buildTextEmbeddingsYQL = () => {
    const fileTimestamp = buildTimestampConditions("updatedAt", "updatedAt")
    const mailTimestamp = buildTimestampConditions("timestamp", "timestamp")

    return `
      (
        (
          ({targetHits:${hits}}userInput(@query))
          or
          ({targetHits:${hits}}nearestNeighbor(text_embeddings, e))
        )
        ${timestampRange ? `and (${fileTimestamp} or ${mailTimestamp})` : ""}
        and permissions contains @email
      )`
  }

  const buildGoogleWorkspaceYQL = () => {
    const userTimestamp = buildTimestampConditions(
      "creationTime",
      "creationTime",
    )

    return `
      (
        ({targetHits:${hits}}userInput(@query))
        ${timestampRange ? `and ${userTimestamp}` : ""}
        and app contains "${Apps.GoogleWorkspace}"
      )`
  }

  const buildOwnerYQL = () => {
    const userTimestamp = buildTimestampConditions(
      "creationTime",
      "creationTime",
    )

    return `
      (
        ({targetHits:${hits}}userInput(@query))
        and owner contains @email
        ${timestampRange ? `and ${userTimestamp}` : ""}
      )`
  }

  // Start with AllSources and filter out excluded app schemas
  let newSources = AllSources
  if (excludedApps && excludedApps.length > 0) {
    let sourcesToExclude: string[] = []

    excludedApps.forEach((excludedApp) => {
      switch (excludedApp) {
        case Apps.Slack:
          sourcesToExclude.push(chatMessageSchema, chatUserSchema)
          break
        case Apps.Gmail:
          sourcesToExclude.push(mailSchema, mailAttachmentSchema)
          break
        case Apps.GoogleDrive:
          sourcesToExclude.push(fileSchema)
          break
        case Apps.GoogleCalendar:
          sourcesToExclude.push(eventSchema)
          break
        case Apps.GoogleWorkspace:
          sourcesToExclude.push(userSchema)
          break
      }
    })

    // Filter out excluded schemas from AllSources
    newSources = AllSources.split(", ")
      .filter((source) => !sourcesToExclude.includes(source))
      .join(", ")
  }

  // Build the combined query using modular components
  const filesAndMailQuery = buildFilesAndMailYQL()
  const textEmbeddingsQuery = buildTextEmbeddingsYQL()
  const googleWorkspaceQuery = buildGoogleWorkspaceYQL()
  const ownerQuery = buildOwnerYQL()

  return {
    profile: SearchModes.NativeRank,
    yql: `select * from sources ${newSources}
            where (
              ${filesAndMailQuery}
              or
              ${textEmbeddingsQuery}
              or
              ${googleWorkspaceQuery}
              or
              ${ownerQuery}
            )
            limit 0
            | all(
                group(app) each(
                    group(entity) each(output(count()))
                )
            )`,
  }
}

export const getAllDocumentsForAgent = async (
  AllowedApps: Apps[] | null,
  dataSourceIds: string[] = [],
  limit: number = 400,
): Promise<VespaSearchResponse | null> => {
  const sources: string[] = []
  const conditions: string[] = []

  if (AllowedApps && AllowedApps.length > 0) {
    for (const allowedApp of AllowedApps) {
      switch (allowedApp) {
        case Apps.GoogleWorkspace:
          if (!sources.includes(userSchema)) sources.push(userSchema)
          conditions.push(`app contains "${Apps.GoogleWorkspace}"`)
          break
        case Apps.Gmail:
          if (!sources.includes(mailSchema)) sources.push(mailSchema)
          conditions.push(`app contains "${Apps.Gmail}"`)
          break
        case Apps.GoogleDrive:
          if (!sources.includes(fileSchema)) sources.push(fileSchema)
          conditions.push(`app contains "${Apps.GoogleDrive}"`)
          break
        case Apps.GoogleCalendar:
          if (!sources.includes(eventSchema)) sources.push(eventSchema)
          conditions.push(`app contains "${Apps.GoogleCalendar}"`)
          break
        case Apps.Slack:
          if (!sources.includes(chatUserSchema)) sources.push(chatUserSchema)
          if (!sources.includes(chatMessageSchema))
            sources.push(chatMessageSchema)
          conditions.push(`app contains "${Apps.Slack}"`)
          break
        case Apps.DataSource:
          if (dataSourceIds && dataSourceIds.length > 0) {
            if (!sources.includes(dataSourceFileSchema))
              sources.push(dataSourceFileSchema)
            const dsConditions = dataSourceIds
              .map((id) => `dataSourceId contains '${id.trim()}'`)
              .join(" or ")
            conditions.push(`(${dsConditions})`)
          }
          break
      }
    }
  } else if (dataSourceIds && dataSourceIds.length > 0) {
    if (!sources.includes(dataSourceFileSchema))
      sources.push(dataSourceFileSchema)
    const dsConditions = dataSourceIds
      .map((id) => `dataSourceId contains '${id.trim()}'`)
      .join(" or ")
    conditions.push(`(${dsConditions})`)
  }
  //return null
  const sourcesString = [...new Set(sources)].join(", ")
  if (!sourcesString) {
    return null
  }

  const whereClause = `where ${conditions.join(" or ")}`
  const yql = `select * from sources ${sourcesString} ${whereClause}`

  const payload = {
    yql,
    hits: limit,
    timeout: "30s",
    "ranking.profile": "unranked",
  }

  return vespa
    .search<VespaSearchResponse>(payload)
    .catch((err) => {
      if (vespa instanceof ProductionVespaClient) {
        Logger.warn(
          "Prod vespa failed in getAllDocumentsForAgent, trying fallback",
        )
        return fallbackVespa.search<VespaSearchResponse>(payload)
      }
      throw err
    })
    .catch((error) => {
      throw new ErrorPerformingSearch({
        cause: error as Error,
        sources: sourcesString,
      })
    })
}

export const groupVespaSearch = async (
  query: string,
  email: string,
  limit = config.page,
  timestampRange?: { to: number; from: number } | null,
): Promise<AppEntityCounts> => {
  const hasProdConfig = Boolean(
    process.env.PRODUCTION_SERVER_URL && process.env.API_KEY,
  )

  if (hasProdConfig) {
    try {
      const client = new ProductionVespaClient(
        process.env.PRODUCTION_SERVER_URL!,
        process.env.API_KEY!,
      )
      return await client.makeApiCall("group-vespa-search", {
        query,
        email,
        limit,
        timestampRange,
      })
    } catch (err) {
      Logger.warn(
        "Production group search Vespa call failed, falling back to local:",
        err,
      )
      // fall through to local
    }
  }

  // either no prod config, or prod call errored
  return await _groupVespaSearch(query, email, limit, timestampRange)
}
async function _groupVespaSearch(
  query: string,
  email: string,
  limit = config.page,
  timestampRange?: { to: number; from: number } | null,
): Promise<AppEntityCounts> {
  let excludedApps: Apps[] = []
  try {
    const connector = await getConnectorByAppAndEmailId(
      db,
      Apps.Slack,
      AuthType.OAuth,
      email,
    )

    if (!connector || connector.status === "not-connected") {
      excludedApps.push(Apps.Slack)
    }
  } catch (error) {
    // If no Slack connector is found, this is normal - exclude Slack from search
    // Only log as debug since this is expected behavior for users without Slack
    Logger.debug(
      `No Slack connector found for user ${email}, excluding Slack from search`,
    )
    excludedApps.push(Apps.Slack)
  }

  let { yql, profile } = HybridDefaultProfileAppEntityCounts(
    limit,
    timestampRange ?? null,
    [], // notInMailLabels
    excludedApps, // excludedApps as fourth parameter
  )

  const hybridDefaultPayload = {
    yql,
    query,
    email: email,
    "ranking.profile": profile,
    "input.query(e)": "embed(@query)",
  }
  try {
    return await vespa.groupSearch(hybridDefaultPayload)
  } catch (error) {
    throw new ErrorPerformingSearch({
      cause: error as Error,
      sources: AllSources,
    })
  }
}

type VespaQueryConfig = {
  limit: number
  offset: number
  alpha: number
  timestampRange: { from: number | null; to: number | null } | null
  excludedIds: string[]
  notInMailLabels: string[]
  rankProfile: SearchModes
  requestDebug: boolean
  span: Span | null
  maxHits: number
  recencyDecayRate: number
  dataSourceIds?: string[] // Added for agent-specific data source filtering
  isIntentSearch?: boolean
  intent?: Intent | null
  channelIds?: string[]
  collectionSelections?: Array<{
    collectionIds?: string[]
    collectionFolderIds?: string[]
    collectionFileIds?: string[]
  }> // Updated to support key-value pairs instead of prefixed strings
  driveIds?: string[] // Added for agent-specfic googleDrive docIds filtering
  selectedItem?: {}
}

export const searchVespa = async (
  query: string,
  email: string,
  app: Apps | Apps[] | null,
  entity: Entity | Entity[] | null,
  {
    alpha = 0.5,
    limit = config.page,
    offset = 0,
    timestampRange = null,
    excludedIds = [],
    notInMailLabels = [],
    rankProfile = SearchModes.NativeRank,
    requestDebug = false,
    span = null,
    maxHits = 400,
    recencyDecayRate = 0.02,
    isIntentSearch = false,
    intent = {},
  }: Partial<VespaQueryConfig>,
): Promise<VespaSearchResponse> => {
  const hasProdConfig = Boolean(
    process.env.PRODUCTION_SERVER_URL && process.env.API_KEY,
  )

  if (hasProdConfig) {
    try {
      const client = new ProductionVespaClient(
        process.env.PRODUCTION_SERVER_URL!,
        process.env.API_KEY!,
      )
      return await client.makeApiCall("search-vespa", {
        query,
        email,
        app,
        entity,
        alpha,
        limit,
        offset,
        timestampRange,
        excludedIds,
        notInMailLabels,
        rankProfile,
        requestDebug,
        span,
        maxHits,
        recencyDecayRate,
        intent,
      })
    } catch (err) {
      Logger.warn(
        "Production search Vespa call failed, falling back to local:",
        err,
      )
      // fall through to local
    }
  }

  // either no prod config, or prod call errored
  return await _searchVespa(query, email, app, entity, {
    alpha,
    limit,
    offset,
    timestampRange,
    excludedIds,
    notInMailLabels,
    rankProfile,
    requestDebug,
    span,
    maxHits,
    recencyDecayRate,
    isIntentSearch,
    intent,
  })
}
async function _searchVespa(
  query: string,
  email: string,
  app: Apps | Apps[] | null,
  entity: Entity | Entity[] | null,
  {
    alpha = 0.5,
    limit = config.page,
    offset = 0,
    timestampRange = null,
    excludedIds = [],
    notInMailLabels = [],
    rankProfile = SearchModes.NativeRank,
    requestDebug = false,
    span = null,
    maxHits = 400,
    recencyDecayRate = 0.02,
    isIntentSearch = false,
    intent = {},
  }: Partial<VespaQueryConfig>,
): Promise<VespaSearchResponse> {
  // Determine the timestamp cutoff based on lastUpdated
  // const timestamp = lastUpdated ? getTimestamp(lastUpdated) : null
  const isDebugMode = config.isDebugMode || requestDebug || false

  // Check if Slack sync job exists for the user (only for local vespa)
  let excludedApps: Apps[] = []
  try {
    const connector = await getConnectorByAppAndEmailId(
      db,
      Apps.Slack,
      AuthType.OAuth,
      email,
    )

    if (!connector || connector.status === "not-connected") {
      excludedApps.push(Apps.Slack)
    }
  } catch (error) {
    // If no Slack connector is found, this is normal - exclude Slack from search
    // Only log as debug since this is expected behavior for users without Slack
    Logger.debug(
      `No Slack connector found for user ${email}, excluding Slack from search`,
    )
    excludedApps.push(Apps.Slack)
  }

  let { yql, profile } = HybridDefaultProfile(
    limit,
    app,
    entity,
    rankProfile,
    timestampRange,
    excludedIds,
    notInMailLabels,
    excludedApps,
    intent,
  )

  const hybridDefaultPayload = {
    yql,
    query,
    email: email,
    "ranking.profile": profile,
    "input.query(e)": "embed(@query)",
    "input.query(alpha)": alpha,
    "input.query(recency_decay_rate)": recencyDecayRate,
    "input.query(is_intent_search)": isIntentSearch ? 1.0 : 0.0,
    maxHits,
    hits: limit,
    timeout: "30s",
    ...(offset
      ? {
          offset,
        }
      : {}),
    ...(app ? { app } : {}),
    ...(entity ? { entity } : {}),
    ...(isDebugMode ? { "ranking.listFeatures": true, tracelevel: 4 } : {}),
  }

  span?.setAttribute("vespaPayload", JSON.stringify(hybridDefaultPayload))
  try {
    let result = await vespa.search<VespaSearchResponse>(hybridDefaultPayload)
    return result
  } catch (error) {
    Logger.error(`Search failed with error:`, error)
    throw new ErrorPerformingSearch({
      cause: error as Error,
      sources: AllSources,
    })
  }
}

export const searchVespaInFiles = async (
  query: string,
  email: string,
  fileIds: string[],
  {
    alpha = 0.5,
    limit = config.page,
    offset = 0,
    notInMailLabels = [],
    rankProfile = SearchModes.NativeRank,
    requestDebug = false,
    span = null,
    maxHits = 400,
  }: Partial<VespaQueryConfig>,
): Promise<VespaSearchResponse> => {
  const isDebugMode = config.isDebugMode || requestDebug || false

  let { yql, profile } = HybridDefaultProfileInFiles(
    limit,
    rankProfile,
    fileIds,
    notInMailLabels,
  )

  const hybridDefaultPayload = {
    yql,
    query,
    email: email,
    "ranking.profile": profile,
    "input.query(e)": "embed(@query)",
    "input.query(alpha)": alpha,
    maxHits,
    hits: limit,
    timeout: "30s",
    ...(offset
      ? {
          offset,
        }
      : {}),
    ...(isDebugMode ? { "ranking.listFeatures": true, tracelevel: 4 } : {}),
  }
  span?.setAttribute("vespaPayload", JSON.stringify(hybridDefaultPayload))
  return vespa
    .search<VespaSearchResponse>(hybridDefaultPayload)
    .catch((err) => {
      if (vespa instanceof ProductionVespaClient) {
        Logger.warn(
          err,
          "Prod vespa failed in searchVespaInFiles for search, trying fallback",
        )
        return fallbackVespa.search<VespaSearchResponse>(hybridDefaultPayload)
      }
      throw err
    })
    .catch((error) => {
      throw new ErrorPerformingSearch({
        cause: error as Error,
        sources: AllSources,
      })
    })
}

export const searchSlackInVespa = async (
  query: string,
  email: string,
  {
    alpha = 0.5,
    limit = config.page,
    offset = 0,
    rankProfile = SearchModes.NativeRank,
    requestDebug = false,
    span = null,
    maxHits = 400,
    channelIds = [],
    threadId = undefined,
    userId = undefined,
    timestampRange = null,
  }: Partial<VespaQueryConfig> & {
    channelIds?: string[]
    threadId?: string
    userId?: string
  },
): Promise<VespaSearchResponse> => {
  const isDebugMode = config.isDebugMode || requestDebug || false

  let { yql, profile } = HybridDefaultProfileForSlack(
    limit,
    rankProfile,
    channelIds,
    threadId,
    userId,
    timestampRange,
  )

  const hybridDefaultPayload = {
    yql,
    query,
    email: email,
    "ranking.profile": profile,
    "input.query(e)": "embed(@query)",
    "input.query(alpha)": alpha,
    maxHits,
    hits: limit,
    timeout: "30s",
    ...(offset && { offset }),
    ...(isDebugMode && { "ranking.listFeatures": true, tracelevel: 4 }),
  }
  span?.setAttribute("vespaPayload", JSON.stringify(hybridDefaultPayload))
  return vespa
    .search<VespaSearchResponse>(hybridDefaultPayload)
    .catch((err) => {
      if (vespa instanceof ProductionVespaClient) {
        Logger.warn(
          err,
          "Prod vespa failed in searchSlackInVespa for search, trying fallback",
        )
        return fallbackVespa.search<VespaSearchResponse>(hybridDefaultPayload)
      }
      throw err
    })
    .catch((error) => {
      throw new ErrorPerformingSearch({
        cause: error as Error,
        sources: chatMessageSchema,
      })
    })
}

export const searchVespaThroughAgent = async (
  query: string,
  email: string,
  apps: Apps[] | null,
  {
    alpha = 0.5,
    limit = config.page,
    offset = 0,
    rankProfile = SearchModes.NativeRank,
    requestDebug = false,
    span = null,
    maxHits = 400,
  }: Partial<VespaQueryConfig>,
): Promise<VespaSearchResponse> => {
  if (!query?.trim()) {
    throw new Error("Query cannot be empty")
  }

  if (!email?.trim()) {
    throw new Error("Email cannot be empty")
  }
  return {} as VespaSearchResponse
}

export const searchVespaAgent = async (
  query: string,
  email: string,
  app: Apps | Apps[] | null,
  entity: Entity | Entity[] | null,
  Apps: Apps[] | null,
  {
    alpha = 0.5,
    limit = config.page,
    offset = 0,
    timestampRange = null,
    excludedIds = [],
    notInMailLabels = [],
    rankProfile = SearchModes.NativeRank,
    requestDebug = false,
    span = null,
    maxHits = 400,
    recencyDecayRate = 0.02,
    dataSourceIds = [], // Ensure dataSourceIds is destructured here
    intent = null,
    channelIds = [],
    collectionSelections = [], // Unified parameter for all collection selections (key-value pairs)
    driveIds = [], // docIds
    selectedItem = {},
  }: Partial<VespaQueryConfig>,
): Promise<VespaSearchResponse> => {
  // Determine the timestamp cutoff based on lastUpdated
  // const timestamp = lastUpdated ? getTimestamp(lastUpdated) : null
  const isDebugMode = config.isDebugMode || requestDebug || false
  let { yql, profile } = await HybridDefaultProfileForAgent(
    email,
    limit,
    app,
    entity,
    rankProfile,
    timestampRange,
    excludedIds,
    notInMailLabels,
    Apps,
    dataSourceIds, // Pass dataSourceIds here
    intent,
    channelIds,
    collectionSelections, // Pass unified collectionSelections here
    driveIds,
    selectedItem,
  )

  const hybridDefaultPayload = {
    yql,
    query,
    email: email,
    "ranking.profile": profile,
    "input.query(e)": "embed(@query)",
    "input.query(alpha)": alpha,
    "input.query(recency_decay_rate)": recencyDecayRate,
    maxHits,
    hits: limit,
    timeout: "30s",
    ...(offset
      ? {
          offset,
        }
      : {}),
    ...(app ? { app } : {}),
    ...(entity ? { entity } : {}),
    ...(isDebugMode ? { "ranking.listFeatures": true, tracelevel: 4 } : {}),
  }
  span?.setAttribute("vespaPayload", JSON.stringify(hybridDefaultPayload))
  return vespa
    .search<VespaSearchResponse>(hybridDefaultPayload)
    .catch((err) => {
      if (vespa instanceof ProductionVespaClient) {
        Logger.warn(
          err,
          "Prod vespa failed in searchVespaAgent for search, trying fallback",
        )
        return fallbackVespa.search<VespaSearchResponse>(hybridDefaultPayload)
      }
      throw err
    })
    .catch((error) => {
      throw new ErrorPerformingSearch({
        cause: error as Error,
        sources: AllSources,
      })
    })
}

export const GetDocument = async (schema: VespaSchema, docId: string) => {
  const opts = { namespace: NAMESPACE, docId, schema }
  return vespa
    .getDocument(opts)
    .catch((err) => {
      if (vespa instanceof ProductionVespaClient) {
        Logger.warn(
          err,
          "Prod vespa failed in getDocument for search, trying fallback",
        )
        return fallbackVespa.getDocument(opts)
      }
      throw err
    })
    .catch((error) => {
      Logger.error(error, `Error fetching document docId: ${docId}`)
      throw new Error(getErrorMessage(error))
    })
}

export const IfMailDocExist = async (
  email: string,
  docId: string,
): Promise<boolean> => {
  return fallbackVespa.ifMailDocExist(email, docId).catch((error) => {
    Logger.error(error, `Error checking if document docId: ${docId} exists`)
    return false
  })
}

export const GetDocumentsByDocIds = async (
  docIds: string[],
  generateAnswerSpan: Span,
): Promise<VespaSearchResponse> => {
  const opts = { namespace: NAMESPACE, docIds, generateAnswerSpan }
  return vespa
    .getDocumentsByOnlyDocIds(opts)
    .catch((err) => {
      if (vespa instanceof ProductionVespaClient) {
        Logger.warn(
          err,
          "Prod vespa failed in getDocumentsByOnlyDocIds for search, trying fallback",
        )
        return fallbackVespa.getDocumentsByOnlyDocIds(opts)
      }
      throw err
    })
    .catch((error) => {
      Logger.error(error, `Error fetching document docIds: ${docIds}`)
      throw new Error(getErrorMessage(error))
    })
}

/**
 * Fetches a single random document from a specific schema.
 */
export const GetRandomDocument = async (
  namespace: string,
  schema: string,
  cluster: string,
): Promise<any | null> => {
  return vespa
    .getRandomDocument(namespace, schema, cluster)
    .catch((err) => {
      if (vespa instanceof ProductionVespaClient) {
        Logger.warn(
          err,
          "Prod vespa failed in getRandomDocument for search, trying fallback",
        )
        return fallbackVespa.getRandomDocument(namespace, schema, cluster)
      }
      throw err
    })
    .catch((error) => {
      Logger.error(error, `Error fetching random document for schema ${schema}`)
      throw new Error(getErrorMessage(error))
    })
}

export const GetDocumentWithField = async (
  fieldName: string,
  schema: VespaSchema,
  limit: number = 100,
  offset: number = 0,
): Promise<VespaSearchResponse> => {
  const opts = { namespace: NAMESPACE, schema }
  return vespa
    .getDocumentsWithField(fieldName, opts, limit, offset)
    .catch((err) => {
      if (vespa instanceof ProductionVespaClient) {
        Logger.warn(
          err,
          "Prod vespa failed in getDocumentsWithField for search, trying fallback",
        )
        return fallbackVespa.getDocumentsWithField(
          fieldName,
          opts,
          limit,
          offset,
        )
      }
      throw err
    })
    .catch((error) => {
      Logger.error(error, `Error fetching documents with field: ${fieldName}`)
      throw new Error(getErrorMessage(error))
    })
}

export const UpdateDocumentPermissions = async (
  schema: VespaSchema,
  docId: string,
  updatedPermissions: string[],
) => {
  const opts = { namespace: NAMESPACE, docId, schema }
  return fallbackVespa
    .updateDocumentPermissions(updatedPermissions, opts)
    .catch((error) => {
      Logger.error(
        error,
        `Error updating document permissions for docId: ${docId}`,
      )
      throw new Error(getErrorMessage(error))
    })
}

export const UpdateEventCancelledInstances = async (
  schema: VespaSchema,
  docId: string,
  updatedCancelledInstances: string[],
) => {
  const opts = { namespace: NAMESPACE, docId, schema }
  return fallbackVespa
    .updateCancelledEvents(updatedCancelledInstances, opts)
    .catch((error) => {
      Logger.error(
        error,
        `Error updating event cancelled instances for docId: ${docId}`,
      )
      throw new Error(getErrorMessage(error))
    })
}

export const UpdateDocument = async (
  schema: VespaSchema,
  docId: string,
  updatedFields: Record<string, any>,
) => {
  const opts = { namespace: NAMESPACE, docId, schema }

  return fallbackVespa.updateDocument(updatedFields, opts).catch((error) => {
    Logger.error(error, `Error updating document for docId: ${docId}`)
    throw new Error(getErrorMessage(error))
  })
}

export const DeleteDocument = async (docId: string, schema: VespaSchema) => {
  const opts = { namespace: NAMESPACE, docId, schema }
  return fallbackVespa.deleteDocument(opts).catch((error) => {
    Logger.error(error, `Error deleting document for docId: ${docId}`)
    throw new Error(getErrorMessage(error))
  })
}

// Define a type for Entity Counts (where the key is the entity name and the value is the count)
interface EntityCounts {
  [entity: string]: number
}

// Define a type for App Entity Counts (where the key is the app name and the value is the entity counts)
export interface AppEntityCounts {
  [app: string]: EntityCounts
}

export const ifDocumentsExist = async (
  docIds: string[],
): Promise<Record<string, { exists: boolean; updatedAt: number | null }>> => {
  return fallbackVespa.ifDocumentsExist(docIds).catch((error) => {
    Logger.error(error, `Error checking if documents exist: ${docIds}`)
    throw new Error(getErrorMessage(error))
  })
}

export const ifMailDocumentsExist = async (
  mailIds: string[],
): Promise<
  Record<
    string,
    {
      docId: string
      exists: boolean
      updatedAt: number | null
      userMap: Record<string, string>
    }
  >
> => {
  return fallbackVespa.ifMailDocumentsExist(mailIds).catch((error) => {
    Logger.error(error, `Error checking if mail documents exist: ${mailIds}`)
    throw new Error(getErrorMessage(error))
  })
}

export const ifDocumentsExistInChatContainer = async (
  docIds: string[],
): Promise<
  Record<
    string,
    { exists: boolean; updatedAt: number | null; permissions: string[] }
  >
> => {
  return fallbackVespa
    .ifDocumentsExistInChatContainer(docIds)
    .catch((error) => {
      Logger.error(
        error,
        `Error checking if documents exist in chat container: ${docIds}`,
      )
      throw new Error(getErrorMessage(error))
    })
}

export const ifDocumentsExistInSchema = async (
  schema: string,
  docIds: string[],
): Promise<Record<string, { exists: boolean; updatedAt: number | null }>> => {
  return fallbackVespa
    .ifDocumentsExistInSchema(schema, docIds)
    .catch((error) => {
      Logger.error(
        error,
        `Error checking if documents exist in schema: ${schema}`,
      )
      throw new Error(getErrorMessage(error))
    })
}

const getNDocuments = async (n: number) => {
  // Encode the YQL query to ensure it's URL-safe
  const yql = encodeURIComponent(
    `select * from sources ${fileSchema} where true`,
  )

  // Construct the search URL with necessary query parameters
  const url = `${vespaEndpoint}/search/?yql=${yql}&hits=${n}&cluster=${CLUSTER}`

  try {
    const response: Response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    })

    if (!response.ok) {
      const errorText = response.statusText
      throw new Error(
        `Failed to fetch document count: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    const data = await response.json()

    return data
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(error, `Error retrieving document count: , ${errMessage}`)
    throw new ErrorRetrievingDocuments({
      cause: error as Error,
      sources: "file",
    })
  }
}

const hashQuery = (query: string) => {
  return crypto.createHash("sha256").update(query.trim()).digest("hex")
}

export const updateUserQueryHistory = async (query: string, owner: string) => {
  const docId = `query_id-${hashQuery(query + owner)}`
  const timestamp = new Date().getTime()

  try {
    const docExist = await getDocumentOrNull(userQuerySchema, docId)

    if (docExist) {
      const docFields = docExist.fields as VespaUserQueryHistory
      const timeSinceLastUpdate = timestamp - docFields.timestamp
      if (timeSinceLastUpdate > config.userQueryUpdateInterval) {
        await UpdateDocument(userQuerySchema, docId, {
          count: docFields.count + 1,
          timestamp,
        })
      } else {
        Logger.warn(`Skipping update for ${docId}: Under time interval`)
      }
    } else {
      await insert(
        { docId, query_text: query, timestamp, count: 1, owner: owner },
        userQuerySchema,
      )
    }
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(error, `Update user query error: ${errMsg}`, error)
    throw new Error("Failed to update user query history")
  }
}

export const getDocumentOrNull = async (schema: VespaSchema, docId: string) => {
  try {
    return await GetDocument(schema, docId)
  } catch (error) {
    const errMsg = getErrorMessage(error)
    if (errMsg.includes("404 Not Found")) {
      Logger.warn(`Document ${docId} does not exist`)
      return null
    }

    throw error
  }
}

export const searchUsersByNamesAndEmails = async (
  mentionedNames: string[],
  mentionedEmails: string[],
  limit: number = 10,
): Promise<VespaSearchResponse> => {
  // Construct YQL conditions for names and emails
  const nameConditions = mentionedNames.map((name) => {
    // For fuzzy search
    return `(name_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy("${name}")))`
    // For exact match, use:
    // return `(name contains "${name}")`;
  })

  const emailConditions = mentionedEmails.map((email) => {
    // For fuzzy search
    return `(email_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy("${email}")))`
    // For exact match, use:
    // return `(email contains "${email}")`;
  })

  // Combine all conditions with OR operator
  const allConditions = [...nameConditions, ...emailConditions].join(" or ")

  // Build the full YQL query
  const yqlQuery = `select * from sources ${userSchema} where (${allConditions});`

  const searchPayload = {
    yql: yqlQuery,
    hits: limit,
    "ranking.profile": "default",
  }

  return vespa
    .getUsersByNamesAndEmails(searchPayload)
    .catch((err) => {
      if (vespa instanceof ProductionVespaClient) {
        Logger.warn(
          err,
          "Prod vespa failed in getUsersByNamesAndEmails for search, trying fallback",
        )
        return fallbackVespa.getUsersByNamesAndEmails(searchPayload)
      }
      throw err
    })
    .catch((error) => {
      Logger.error(
        error,
        `Error fetching users by names and emails: ${searchPayload}`,
      )
      throw new Error(getErrorMessage(error))
    })
}

/**
 * Helper function to calculate the timestamp based on LastUpdated value.
 */
export const getTimestamp = (lastUpdated: string): number | null => {
  const now = new Date().getTime() // Convert current time to epoch seconds
  switch (lastUpdated) {
    case "pastDay":
      return now - 24 * 60 * 60 * 1000
    case "pastWeek":
      return now - 7 * 24 * 60 * 60 * 1000
    case "pastMonth":
      return now - 30 * 24 * 60 * 60 * 1000
    case "pastYear":
      return now - 365 * 24 * 60 * 60 * 1000
    case "anytime":
    default:
      return null
  }
}

// export const searchEmployeesViaName = async (
//   name: string,
//   email: string,
//   limit = config.page,
//   offset?: number,
// ): Promise<VespaSearchResponse> => {
//   const url = `${vespaEndpoint}/search/`

//   const yqlQuery = `
//       select * from sources user
//       where name contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))`

//   const hybridDefaultPayload = {
//     yql: yqlQuery,
//     query: name,
//     email,
//     "ranking.profile": HybridDefaultProfile(limit).profile,
//     "input.query(e)": "embed(@query)",
//     hits: limit,
//     alpha: 0.5,
//     ...(offset
//       ? {
//           offset,
//         }
//       : {}),
//     variables: {
//       query,
//     },
//   }
//   try {
//     const response = await fetch(url, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//       },
//       body: JSON.stringify(hybridDefaultPayload),
//     })
//     if (!response.ok) {
//       const errorText = response.statusText
//       throw new Error(
//         `Failed to fetch documents: ${response.status} ${response.statusText} - ${errorText}`,
//       )
//     }

//     const data = await response.json()
//     return data
//   } catch (error) {
//     Logger.error(`Error performing search:, ${error}`)
//     throw new ErrorPerformingSearch({
//       cause: error as Error,
//       sources: AllSources,
//     })
//   }
// }

const escapeYqlValue = (value: string): string => {
  return value.replace(/'/g, "''")
}

// Gmail intent processing function
const processGmailIntent = (intent: Intent): string[] => {
  const intentConditions: string[] = []

  // Helper function to validate email addresses
  const isValidEmailAddress = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    return emailRegex.test(email)
  }

  // VALIDATION: Process intent if there are actual email addresses OR subject fields
  // DO NOT process intent for names without email addresses (unless subject is present)
  const hasValidEmailAddresses =
    intent &&
    ((intent.from &&
      intent.from.length > 0 &&
      intent.from.some(isValidEmailAddress)) ||
      (intent.to &&
        intent.to.length > 0 &&
        intent.to.some(isValidEmailAddress)) ||
      (intent.cc &&
        intent.cc.length > 0 &&
        intent.cc.some(isValidEmailAddress)) ||
      (intent.bcc &&
        intent.bcc.length > 0 &&
        intent.bcc.some(isValidEmailAddress)))

  const hasSubjectFields = intent && intent.subject && intent.subject.length > 0

  // Process intent if we have valid email addresses OR subject fields
  if (!hasValidEmailAddresses && !hasSubjectFields) {
    Logger.debug(
      "Intent contains only names or no actionable identifiers - skipping Gmail intent filtering",
      { intent },
    )
    return [] // Return empty array if no valid email addresses or subjects found
  }

  Logger.debug(
    "Intent contains valid email addresses or subjects - processing Gmail intent filtering",
    { intent },
  )

  // Process 'from' field
  if (intent.from && intent.from.length > 0) {
    if (intent.from.length === 1) {
      const fromCondition = `"from" contains '${escapeYqlValue(intent.from[0])}'`
      intentConditions.push(fromCondition)
    } else {
      const fromConditions = intent.from
        .map((email) => `"from" contains '${escapeYqlValue(email)}'`)
        .join(" or ")
      intentConditions.push(`(${fromConditions})`)
    }
  }

  // Process 'to' field
  if (intent.to && intent.to.length > 0) {
    if (intent.to.length === 1) {
      const toCondition = `"to" contains '${escapeYqlValue(intent.to[0])}'`
      intentConditions.push(toCondition)
    } else {
      const toConditions = intent.to
        .map((email) => `"to" contains '${escapeYqlValue(email)}'`)
        .join(" or ")
      intentConditions.push(`(${toConditions})`)
    }
  }

  // Process 'cc' field
  if (intent.cc && intent.cc.length > 0) {
    if (intent.cc.length === 1) {
      const ccCondition = `cc contains '${escapeYqlValue(intent.cc[0])}'`
      intentConditions.push(ccCondition)
    } else {
      const ccConditions = intent.cc
        .map((email) => `cc contains '${escapeYqlValue(email)}'`)
        .join(" or ")
      intentConditions.push(`(${ccConditions})`)
    }
  }

  // Process 'bcc' field
  if (intent.bcc && intent.bcc.length > 0) {
    if (intent.bcc.length === 1) {
      const bccCondition = `bcc contains '${escapeYqlValue(intent.bcc[0])}'`
      intentConditions.push(bccCondition)
    } else {
      const bccConditions = intent.bcc
        .map((email) => `bcc contains '${escapeYqlValue(email)}'`)
        .join(" or ")
      intentConditions.push(`(${bccConditions})`)
    }
  }

  // Process 'subject' field
  if (intent.subject && intent.subject.length > 0) {
    if (intent.subject.length === 1) {
      const subjectCondition = `"subject" contains '${escapeYqlValue(intent.subject[0])}'`
      intentConditions.push(subjectCondition)
    } else {
      const subjectConditions = intent.subject
        .map((subj) => `"subject" contains '${escapeYqlValue(subj)}'`)
        .join(" or ")
      intentConditions.push(`(${subjectConditions})`)
    }
  }

  return intentConditions
}

// Future: Slack intent processing function
// const processSlackIntent = (intent: Intent): string[] => {
//   const intentConditions: string[] = []
//   // Add Slack-specific intent processing logic here
//   return intentConditions
// }

interface GetItemsParams {
  schema: VespaSchema | VespaSchema[]
  app?: Apps | Apps[] | null
  entity?: Entity | Entity[] | null
  timestampRange: { from: number | null; to: number | null } | null
  limit?: number
  offset?: number
  email: string
  excludedIds?: string[]
  asc: boolean
  intent?: Intent | null
  channelIds?: string[]
}

export const getItems = async (
  params: GetItemsParams,
): Promise<VespaSearchResponse> => {
  const {
    schema,
    app,
    entity,
    timestampRange,
    limit = config.page,
    offset = 0,
    email,
    excludedIds, // Added excludedIds here
    asc,
    intent,
    channelIds,
  } = params

  const schemas = Array.isArray(schema) ? schema : [schema]
  const schemasString = schemas.join(", ")
  // Construct conditions based on parameters
  let conditions: string[] = []

  // App condition
  if (Array.isArray(app) && app.length > 0) {
    conditions.push(
      app.map((a) => `app contains '${escapeYqlValue(a)}'`).join(" or "),
    )
  } else if (!Array.isArray(app) && app) {
    conditions.push(`app contains '${escapeYqlValue(app)}'`)
  }

  if (app === Apps.Slack && channelIds && channelIds.length > 0) {
    const channelIdConditions = channelIds
      .map((id) => `channelId contains '${escapeYqlValue(id)}'`)
      .join(" or ")
    conditions.push(`(${channelIdConditions})`)
  }

  // Entity condition
  if (Array.isArray(entity) && entity.length > 0) {
    conditions.push(
      entity.map((e) => `entity contains '${escapeYqlValue(e)}'`).join(" or "),
    )
  } else if (!Array.isArray(entity) && entity) {
    conditions.push(`entity contains '${escapeYqlValue(entity)}'`)
  }

  // Permissions or owner condition based on schema
  if (schemas.length === 1 && schemas[0] === dataSourceFileSchema) {
    // Temporal fix for datasoure selection
  } else if (!schemas.includes(userSchema)) {
    conditions.push(`permissions contains '${email}'`)
  } else {
    // For user schema
    if (
      app !== Apps.GoogleWorkspace ||
      (Array.isArray(app) && !app.includes(Apps.GoogleWorkspace))
    ) {
      conditions.push(`owner contains '${email}'`)
    }
  }

  let timestampField = []

  // Choose appropriate timestamp field based on schema
  if (schemas.includes(mailSchema) || schemas.includes(mailAttachmentSchema)) {
    timestampField.push("timestamp")
  } else if (
    schemas.includes(fileSchema) ||
    schemas.includes(chatMessageSchema)
  ) {
    timestampField.push("updatedAt")
  } else if (schemas.includes(eventSchema)) {
    timestampField.push("startTime")
  } else if (schemas.includes(userSchema)) {
    timestampField.push("creationTime")
  } else {
    timestampField.push("updatedAt")
  }

  // Timestamp conditions
  if (timestampRange) {
    let timeConditions: string[] = []
    let fieldForRange = timestampField // Use default field unless orderBy overrides

    if (timestampRange.from) {
      timeConditions.push(
        `${fieldForRange.map((field) => `${field} >= ${new Date(timestampRange.from!).getTime()}`).join(" or ")}`,
      )
    }
    if (timestampRange.to) {
      timeConditions.push(
        `${fieldForRange.map((field) => `${field} <= ${new Date(timestampRange.to!).getTime()}`).join(" or ")}`,
      )
    }
    if (timeConditions.length > 0) {
      conditions.push(`(${timeConditions.join(" and ")})`)
    }
  }

  // Excluded IDs condition
  if (excludedIds && excludedIds.length > 0) {
    const exclusionCondition = excludedIds
      .map((id) => `docId contains '${id}'`)
      .join(" or ")
    conditions.push(`!(${exclusionCondition})`)
  }

  // Intent-based conditions - modular approach for different apps
  if (intent) {
    Logger.debug("Processing intent-based filtering", {
      intent,
      app,
      entity,
      schema,
    })

    // Handle Gmail intent filtering
    if (
      app === Apps.Gmail &&
      entity === MailEntity.Email &&
      schema === mailSchema
    ) {
      const gmailIntentConditions = processGmailIntent(intent)
      if (gmailIntentConditions.length > 0) {
        conditions.push(...gmailIntentConditions)
        Logger.debug(
          `Added Gmail intent conditions: ${gmailIntentConditions.join(" and ")}`,
        )
      } else {
        Logger.debug(
          "Gmail intent provided but contains only names/non-specific identifiers - skipping intent filtering",
          { intent },
        )
      }
    }

    // Future: Handle Slack intent filtering
    // else if (app === Apps.Slack && entity === SlackEntity.Message && schema === chatMessageSchema) {
    //   const slackIntentConditions = processSlackIntent(intent)
    //   if (slackIntentConditions.length > 0) {
    //     conditions.push(...slackIntentConditions)
    //     Logger.debug(`Added Slack intent conditions: ${slackIntentConditions.join(" and ")}`)
    //   }
    // }

    // Future: Handle other apps...
  }

  // Combine conditions
  const whereClause =
    conditions.length > 0 ? `where ${conditions.join(" and ")}` : "where true"

  const orderByClause = timestampField
    ? `order by ${timestampField} ${asc ? "asc" : "desc"}`
    : ""

  // Construct YQL query with proper clause ordering and spacing
  let yql = `select * from sources ${schema} ${whereClause}`

  if (orderByClause) {
    yql += ` ${orderByClause}`
  }

  yql += ` limit ${limit}`

  if (offset > 0) {
    yql += ` offset ${offset}`
  }

  Logger.info(`[getItems] YQL Query: ${yql}`)
  Logger.info(
    `[getItems] Query Details: ${JSON.stringify({
      schema,
      app,
      entity,
      limit,
      offset,
      intentProvided: !!intent,
      conditions: conditions.length > 0 ? conditions : "none",
    })}`,
  )

  const searchPayload = {
    yql,
    "ranking.profile": "unranked",
    timeout: "30s",
  }

  return vespa
    .getItems(searchPayload)
    .catch((err) => {
      if (vespa instanceof ProductionVespaClient) {
        Logger.warn(
          err,
          "Prod vespa failed in getItems for search, trying fallback",
        )
        return fallbackVespa.getItems(searchPayload)
      }
      throw err
    })
    .catch((error) => {
      const searchError = new ErrorPerformingSearch({
        cause: error as Error,
        sources: JSON.stringify(schema),
        message: `getItems failed for schema ${schema}`,
      })
      Logger.error(searchError, "Error in getItems function")
      throw searchError
    })
}

// --- DataSource and DataSourceFile Specific Functions ---

export const insertDataSource = async (
  document: VespaDataSource,
): Promise<void> => {
  try {
    await insert(document as Inserts, datasourceSchema)
    Logger.info(`DataSource ${document.docId} inserted successfully`)
  } catch (error) {
    Logger.error(error, `Error inserting DataSource ${document.docId}`)
    throw error
  }
}

export const insertDataSourceFile = async (
  document: VespaDataSourceFile,
): Promise<void> => {
  try {
    await insert(document as Inserts, dataSourceFileSchema)
    Logger.info(`DataSourceFile ${document.docId} inserted successfully`)
  } catch (error) {
    Logger.error(error, `Error inserting DataSourceFile ${document.docId}`)
    throw error
  }
}

export const getDataSourceByNameAndCreator = async (
  name: string,
  createdByEmail: string,
): Promise<VespaDataSourceSearch | null> => {
  const yql = `select * from ${datasourceSchema} where name contains @name and createdBy contains @email limit 1`

  const payload = {
    yql,
    name,
    email: createdByEmail,
    hits: 1,
    "ranking.profile": "unranked",
    "presentation.summary": "default",
  }

  const parseResult = (
    res: VespaSearchResponse,
  ): VespaDataSourceSearch | null => {
    const first = res?.root?.children?.[0]
    return first?.fields
      ? (first.fields as unknown as VespaDataSourceSearch)
      : null
  }

  const errorMsg = `Error fetching DataSource by name "${name}" and creator "${createdByEmail}"`

  try {
    const response = await vespa.search(payload)
    return parseResult(response as VespaSearchResponse)
  } catch (error) {
    if (vespa instanceof ProductionVespaClient) {
      Logger.warn(
        error,
        `Prod failed in getDataSourceByNameAndCreator for search, trying fallback...`,
      )
      try {
        const fallbackResponse = await fallbackVespa.search(payload)
        return parseResult(fallbackResponse as VespaSearchResponse)
      } catch (fallbackError) {
        Logger.error(
          fallbackError,
          `Fallback failed in getDataSourceByNameAndCreator for search`,
        )
        throw new ErrorPerformingSearch({
          message: `${errorMsg} (fallback failed in getDataSourceByNameAndCreator for search)`,
          cause: fallbackError as Error,
          sources: datasourceSchema,
        })
      }
    }

    Logger.error(
      error,
      `Vespa failed for DataSource by name="${name}", email="${createdByEmail}"`,
    )
    throw new ErrorPerformingSearch({
      message: errorMsg,
      cause: error as Error,
      sources: datasourceSchema,
    })
  }
}

export const getDataSourcesByCreator = async (
  createdByEmail: string,
  limit: number = 100,
): Promise<VespaSearchResponse> => {
  const yql = `select * from ${datasourceSchema} where createdBy contains @email limit ${limit}`
  const payload = {
    yql,
    email: createdByEmail,
    hits: limit,
    "ranking.profile": "unranked",
    "presentation.summary": "default",
  }

  try {
    return await vespa.search<VespaSearchResponse>(payload)
  } catch (error) {
    const message = `Error fetching DataSources for creator "${createdByEmail}"`

    if (vespa instanceof ProductionVespaClient) {
      Logger.warn(
        error,
        `${message} (prod failed in getDataSourcesByCreator for search, trying fallback)`,
      )
      try {
        return await fallbackVespa.search<VespaSearchResponse>(payload)
      } catch (fallbackErr) {
        Logger.error(
          fallbackErr,
          `${message} (fallback failed in getDataSourcesByCreator for search)`,
        )
        throw new ErrorPerformingSearch({
          message,
          cause: fallbackErr as Error,
          sources: datasourceSchema,
        })
      }
    }

    Logger.error(error, message)
    throw new ErrorPerformingSearch({
      message,
      cause: error as Error,
      sources: datasourceSchema,
    })
  }
}

export const checkIfDataSourceFileExistsByNameAndId = async (
  fileName: string,
  dataSourceId: string,
  uploadedBy: string,
): Promise<boolean> => {
  const yql = `
    select * 
    from sources ${dataSourceFileSchema} 
    where fileName contains @fileName and dataSourceId contains @dataSourceId and uploadedBy contains @uploadedBy 
    limit 1
  `

  const payload = {
    yql,
    fileName,
    dataSourceId,
    uploadedBy,
    hits: 1,
    "ranking.profile": "unranked",
  }

  const exists = (res: VespaSearchResponse) => !!res?.root?.children?.length

  const errorMsg = `Error checking if file "${fileName}" exists for DataSource ID "${dataSourceId}" and user "${uploadedBy}"`

  try {
    Logger.debug(
      { payload },
      "Checking if datasource file exists by name and ID",
    )
    const response = await vespa.search<VespaSearchResponse>(payload)
    return exists(response)
  } catch (error) {
    if (vespa instanceof ProductionVespaClient) {
      Logger.warn(
        error,
        `${errorMsg} (prod failed in checkIfDataSourceFileExistsByNameAndId for search, trying fallback)`,
      )
      try {
        const fallbackResponse =
          await fallbackVespa.search<VespaSearchResponse>(payload)
        return exists(fallbackResponse)
      } catch (fallbackErr) {
        Logger.error(
          fallbackErr,
          `${errorMsg} (fallback failed in checkIfDataSourceFileExistsByNameAndId for search)`,
        )
        throw new ErrorPerformingSearch({
          message: errorMsg,
          cause: fallbackErr as Error,
          sources: dataSourceFileSchema,
        })
      }
    }

    Logger.error(error, errorMsg)
    throw new ErrorPerformingSearch({
      message: errorMsg,
      cause: error as Error,
      sources: dataSourceFileSchema,
    })
  }
}

export const fetchAllDataSourceFilesByName = async (
  dataSourceName: string,
  userEmail: string,
  concurrency = 3,
  batchSize = 400,
): Promise<VespaSearchResult[] | null> => {
  const Logger = getLogger(Subsystem.Vespa).child({
    module: "fetchAllDataSourceFilesByName",
  })

  const countPayload = {
    yql: `
      select * 
      from sources ${dataSourceFileSchema} 
      where dataSourceName contains @dataSourceName and uploadedBy contains @userEmail 
    `,
    dataSourceName,
    userEmail,
    hits: 0,
    timeout: "20s",
    "presentation.summary": "count",
    "ranking.profile": "unranked",
  }

  let totalCount: number

  try {
    const countResponse = await vespa.search<VespaSearchResponse>(countPayload)
    totalCount = countResponse.root?.fields?.totalCount ?? 0
    Logger.info(`Found ${totalCount} total files`)
    if (totalCount === 0) {
      return null
    }
  } catch (error) {
    Logger.error(error, "Failed to get total count of files")
    throw new ErrorPerformingSearch({
      cause: error as Error,
      sources: dataSourceFileSchema,
      message: "Failed to get total count",
    })
  }

  const batchPayloads = []
  for (let offset = 0; offset < totalCount; offset += batchSize) {
    const payload = {
      yql: `
        select * 
        from sources ${dataSourceFileSchema} 
        where dataSourceName contains @dataSourceName and uploadedBy contains @userEmail 
        order by createdAt desc
      `,
      dataSourceName,
      userEmail,
      hits: Math.min(batchSize, totalCount - offset),
      offset,
      timeout: "30s",
      "ranking.profile": "unranked",
      "presentation.summary": "default",
      maxHits: 1000000,
      maxOffset: 1000000,
    }
    batchPayloads.push(payload)
  }

  Logger.debug(batchPayloads, "Prepared batch payloads for Vespa")

  Logger.info(
    `Fetching all batches (${batchPayloads.length}) with concurrency=${concurrency}`,
  )

  const limiter = pLimit(concurrency)

  const results = await Promise.all(
    batchPayloads.map((payload, idx) =>
      limiter(async () => {
        Logger.debug(`Fetching batch ${idx + 1}/${batchPayloads.length}`)
        const res = await vespa
          .search<VespaSearchResponse>(payload)
          .catch(async (err) => {
            if (vespa instanceof ProductionVespaClient) {
              Logger.warn(
                err,
                `Prod vespa failed in fetchAllDataSourceFilesByName, trying fallback`,
              )
              return fallbackVespa.search<VespaSearchResponse>(payload)
            }
            throw err
          })
        return res
      }),
    ),
  )

  const allChildren = results.flatMap((r) => r.root.children ?? [])

  return allChildren
}

export const SlackHybridProfile = (
  hits: number,
  entity: Entity | null,
  profile: SearchModes = SearchModes.NativeRank,
  timestampRange?: { to: number | null; from: number | null } | null,
  channelId?: string,
  userId?: string,
): YqlProfile => {
  // Helper function to build timestamp conditions
  const buildTimestampConditions = (fromField: string, toField: string) => {
    const conditions: string[] = []
    if (timestampRange?.from) {
      conditions.push(`${fromField} >= ${timestampRange.from}`)
    }
    if (timestampRange?.to) {
      conditions.push(`${toField} <= ${timestampRange.to}`)
    }
    return conditions.join(" and ")
  }

  // Helper function to build entity filter
  const buildEntityFilter = () => {
    return entity ? "and entity contains @entity" : ""
  }

  // Helper function to build channel filter
  const buildChannelFilter = () => {
    return channelId ? "and channelId contains @channelId" : ""
  }

  // Helper function to build user filter
  const buildUserFilter = () => {
    return userId ? "and userId contains @userId" : ""
  }

  // Build Slack YQL
  const buildSlackYQL = () => {
    const timestampCondition = timestampRange
      ? buildTimestampConditions("createdAt", "createdAt")
      : ""
    const entityFilter = buildEntityFilter()
    const channelFilter = buildChannelFilter()
    const userFilter = buildUserFilter()

    return `
      (
        (
          ({targetHits:${hits}} userInput(@query))
          or
          ({targetHits:${hits}} nearestNeighbor(text_embeddings, e))
        )
        ${timestampCondition ? `and (${timestampCondition})` : ""}
        and permissions contains @email
        ${entityFilter}
        ${channelFilter}
        ${userFilter}
      )`
  }

  const combinedQuery = buildSlackYQL()
  const sources = [chatMessageSchema] // Only chat message schema for Slack

  return {
    profile: profile,
    yql: `
    select *
    from sources ${sources.join(", ")} 
    where
    (
      (
        ${combinedQuery}
      )
    )
    ;
    `,
  }
}

export const dateToUnixTimestamp = (
  dateString: string,
  endOfDay: boolean = false,
): string => {
  const date = new Date(dateString)

  if (isNaN(date.getTime())) {
    throw new Error(
      `Invalid date format: ${dateString}. Expected format: YYYY-MM-DD`,
    )
  }

  if (endOfDay) {
    date.setHours(23, 59, 59, 999)
  } else {
    date.setHours(0, 0, 0, 0)
  }

  const timestampMs = date.getTime()

  const seconds = Math.floor(timestampMs / 1000)
  const microseconds = (timestampMs % 1000) * 1000

  return `${seconds}.${microseconds.toString().padStart(6, "0")}`
}

export const SearchVespaThreads = async (
  threadIdsInput: string[],
  generateAnswerSpan: Span,
): Promise<VespaSearchResponse> => {
  const validThreadIds = threadIdsInput.filter(
    (id) => typeof id === "string" && id.length > 0,
  )

  if (validThreadIds.length === 0) {
    Logger.warn("SearchVespaThreads called with no valid threadIds.")
    return {
      root: {
        id: "nullss",
        relevance: 0,
        fields: { totalCount: 0 },
        coverage: {
          coverage: 0,
          documents: 0,
          full: true,
          nodes: 0,
          results: 0,
          resultsFull: 0,
        },
        children: [],
      },
    }
  }

  return vespa
    .getDocumentsBythreadId(validThreadIds)
    .catch((err) => {
      if (vespa instanceof ProductionVespaClient) {
        Logger.warn(
          err,
          "Prod vespa failed for in SearchVespaThreads for getDocumentsBythreadId, trying fallback",
        )
        return fallbackVespa.getDocumentsBythreadId(validThreadIds)
      }
      throw err
    })
    .catch((error) => {
      Logger.error(
        error,
        `Error fetching documents by threadIds: ${validThreadIds.join(", ")}`,
      )
      const errMessage = getErrorMessage(error)
      throw new Error(errMessage)
    })
}

export const SearchEmailThreads = async (
  threadIdsInput: string[],
  email: string,
): Promise<VespaSearchResponse> => {
  const validThreadIds = threadIdsInput.filter(
    (id) => typeof id === "string" && id.length > 0,
  )
  return vespa
    .getEmailsByThreadIds(validThreadIds, email)
    .catch((err) => {
      if (vespa instanceof ProductionVespaClient) {
        Logger.warn(
          err,
          "Prod vespa failed for in SearchEmailThreads for getEmailsByThreadIds, trying fallback",
        )
        return fallbackVespa.getEmailsByThreadIds(validThreadIds, email)
      }
      throw err
    })
    .catch((error) => {
      Logger.error(
        error,
        `Error fetching emails by threadIds: ${validThreadIds.join(", ")}`,
      )
      const errMessage = getErrorMessage(error)
      throw new Error(errMessage)
    })
}

export interface GetThreadItemsParams {
  entity?: Entity | null
  timestampRange?: { from: any; to: any } | null
  limit?: number
  offset?: number
  email: string
  userEmail?: string
  asc?: boolean
  channelName?: string
  filterQuery?: string
}
// Enhanced getThreadItems function
export const getThreadItems = async (
  params: GetThreadItemsParams & { filterQuery?: string },
): Promise<VespaSearchResponse> => {
  const {
    entity = SlackEntity.Message,
    timestampRange = null,
    limit = config.page,
    offset = 0,
    email,
    userEmail = null,
    asc = true,
    channelName = null,
    filterQuery = null,
  } = params
  const chatMessageSchema = "chat_message"

  // Handle timestamp range normalization
  if (timestampRange) {
    if (timestampRange.from) {
      timestampRange.from = dateToUnixTimestamp(timestampRange.from, false)
    }
    if (timestampRange.to) {
      timestampRange.to = dateToUnixTimestamp(timestampRange.to, true)
    }
  }

  const tryWithFallback = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      if (vespa instanceof ProductionVespaClient) {
        Logger.warn(
          err,
          `Prod vespa failed in getThreadItems for ${fn.name}, trying fallback`,
        )
        try {
          return await fn.call(fallbackVespa)
        } catch (fallbackErr) {
          Logger.error(
            fallbackErr,
            `Fallback vespa failed in getThreadItems for ${fn.name}`,
          )
          throw fallbackErr
        }
      }
      throw err
    }
  }

  let channelId: string | undefined
  let userId: string | undefined

  // Fetch channelId
  if (channelName) {
    try {
      const resp = await tryWithFallback(() =>
        vespa.getChatContainerIdByChannelName(channelName),
      )
      channelId = resp?.root?.children?.[0]?.fields?.docId
    } catch (e) {
      Logger.error(e, `Could not fetch channelId for channel: ${channelName}`)
    }
  }

  // Fetch userId
  if (userEmail) {
    try {
      const resp = await tryWithFallback(() =>
        vespa.getChatUserByEmail(userEmail),
      )
      userId = resp?.root?.children?.[0]?.fields?.docId
    } catch (e) {
      Logger.error(e, `Could not fetch userId for user: ${userEmail}`)
    }
  }

  // Hybrid filterQuery-based search
  if (filterQuery) {
    const { yql, profile } = SlackHybridProfile(
      limit,
      SlackEntity.Message,
      SearchModes.NativeRank,
      timestampRange,
      channelId,
      userId,
    )

    const hybridPayload = {
      yql,
      query: filterQuery,
      email: userEmail,
      "ranking.profile": profile,
      "input.query(e)": "embed(@query)",
      "input.query(alpha)": 0.5,
      "input.query(recency_decay_rate)": 0.1,
      maxHits: limit,
      hits: limit,
      timeout: "20s",
      ...(offset && { offset }),
      ...(entity && { entity }),
      ...(channelId && { channelId }),
      ...(userId && { userId }),
    }

    try {
      return await tryWithFallback(() =>
        vespa.search<VespaSearchResponse>(hybridPayload),
      )
    } catch (error) {
      Logger.error(error, `Vespa hybrid search failed`)
      throw new ErrorPerformingSearch({
        cause: error as Error,
        sources: chatMessageSchema,
      })
    }
  }

  // Plain YQL search
  const conditions: string[] = []

  if (entity) conditions.push(`entity contains "${entity}"`)
  if (userEmail) conditions.push(`permissions contains "${userEmail}"`)
  if (channelId) conditions.push(`channelId contains "${channelId}"`)
  if (userId) conditions.push(`userId contains "${userId}"`)

  const timestampField = "createdAt"

  const buildTimestampConditions = (fromField: string, toField: string) => {
    const timestampConditions: string[] = []
    if (timestampRange?.from) {
      timestampConditions.push(`${fromField} >= '${timestampRange.from}'`)
    }
    if (timestampRange?.to) {
      timestampConditions.push(`${toField} <= '${timestampRange.to}'`)
    }
    return timestampConditions
  }

  if (timestampRange) {
    const timestampConditions = buildTimestampConditions(
      timestampField,
      timestampField,
    )
    conditions.push(...timestampConditions)
  }

  const whereClause = conditions.length
    ? `where ${conditions.join(" and ")}`
    : ""
  const orderClause = `order by createdAt ${asc ? "asc" : "desc"}`
  const yql = `select * from sources ${chatMessageSchema} ${whereClause} ${orderClause} limit ${limit} offset ${offset}`

  const payload = {
    yql,
    "ranking.profile": "unranked",
  }

  try {
    return await tryWithFallback(() => vespa.getItems(payload))
  } catch (error) {
    Logger.error(error, "Vespa search error")
    throw new ErrorPerformingSearch({
      cause: error as Error,
      sources: chatMessageSchema,
    })
  }
}

export const getSlackUserDetails = async (
  userEmail: string,
): Promise<VespaSearchResponse> => {
  return vespa
    .getChatUserByEmail(userEmail)
    .catch((err) => {
      if (vespa instanceof ProductionVespaClient) {
        Logger.warn(
          err,
          "Prod vespa failed in getSlackUserDetails for getChatUserByEmail, trying fallback",
        )
        return fallbackVespa.getChatUserByEmail(userEmail)
      }
      throw err
    })
    .catch((error) => {
      Logger.error(`Could not fetch the userId with user email ${userEmail}`)
      throw new ErrorPerformingSearch({
        cause: error as Error,
        sources: chatUserSchema,
      })
    })
}

export const getFolderItems = async (
  docIds: string[],
  schema: string,
  entity: string,
  email: string,
) => {
  try {
    const resp = fallbackVespa.getFolderItem(docIds, schema, entity, email)
    return resp
  } catch (error) {
    Logger.error(
      error,
      `Error fetching folderitem by docIds: ${docIds.join(", ")}`,
    )
    const errMessage = getErrorMessage(error)
    throw new Error(errMessage)
  }
}
