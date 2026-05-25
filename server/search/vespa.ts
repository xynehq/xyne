import config from "@/config"
import { NAMESPACE } from "@/config"
import { db } from "@/db/client"
import { getConnectorByAppAndEmailId } from "@/db/connector"
import { getAppSyncJobsByEmail } from "@/db/syncJob"
import { isZohoDeskConnected as checkZohoDeskConnected } from "@/integrations/zoho/utils"
import { getLogger } from "@/logger"
import { AuthType, ConnectorStatus } from "@/shared/types"
import { Subsystem } from "@/types"
import {
  Apps,
  DriveEntity,
  type Entity,
  type GetItemsParams,
  type VespaQueryConfig,
  type VespaSchema,
  type VespaSearchResult,
  fileSchema,
} from "@xyne/vespa-ts/types"
import { extractCollectionVespaIds, extractDriveIds } from "./utils"
import { sharedVespaService as vespa } from "./vespaService"

const Logger = getLogger(Subsystem.Vespa).child({ module: "vespa" })

type VespaFieldUpdate =
  | { assign: unknown }
  | { add: unknown }
  | { remove: unknown }

export const updateDocumentWithOperations = async (
  schema: VespaSchema,
  docId: string,
  fields: Record<string, VespaFieldUpdate>,
) => {
  const url = `${config.vespaEndpoint.feedEndpoint}/document/v1/${NAMESPACE}/${schema}/docid/${docId}`
  let lastError: Error | null = null
  const maxAttempts = Object.values(fields).some(
    (operation) => "add" in operation,
  )
    ? 1
    : config.vespaMaxRetryAttempts

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields }),
      })

      if (response.ok) {
        Logger.info(
          `Updated document ${docId} in ${schema} with operations: ${Object.keys(fields).join(", ")}`,
        )
        return
      }

      const errorText = await response.text().catch(() => response.statusText)
      lastError = new Error(
        `Failed to update document ${docId}: ${response.status} ${response.statusText} - ${errorText}`,
      )
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) =>
        setTimeout(resolve, config.vespaRetryDelay * attempt),
      )
    }
  }

  throw lastError || new Error(`Failed to update document ${docId}`)
}

/**
 * Dedupe Vespa search children by fileHash when app is Attachment (same file re-uploaded → same hash).
 * Call at Vespa entry point so downstream only sees unique attachments.
 */
function dedupeVespaChildrenByAttachmentHash(
  children: VespaSearchResult[],
): VespaSearchResult[] {
  if (!children?.length) return children
  const seenHash = new Set<string>()
  return children.filter((child) => {
    const fields = (child as { fields?: Record<string, unknown> }).fields
    if (
      fields?.sddocname === fileSchema &&
      fields?.app === Apps.Attachment &&
      typeof fields?.fileHash === "string" &&
      fields.fileHash
    ) {
      if (seenHash.has(fields.fileHash)) return false
      seenHash.add(fields.fileHash)
    }
    return true
  })
}

/** Mutates result.root.children in place when present; safe for any response with root.children (e.g. search, autocomplete). */
function dedupeResponseChildren<T>(result: T): T {
  const r = result as { root?: { children?: VespaSearchResult[] } }
  if (r?.root?.children?.length) {
    r.root.children = dedupeVespaChildrenByAttachmentHash(r.root.children)
  }
  return result
}

export const insert = vespa.insert.bind(vespa)
export const GetDocument = vespa.GetDocument.bind(vespa)
export const getDocumentOrNull = vespa.getDocumentOrNull.bind(vespa)
export const UpdateDocument = vespa.UpdateDocument.bind(vespa)
export const DeleteDocument = vespa.DeleteDocument.bind(vespa)
export const searchCollectionRAG = vespa.searchCollectionRAG.bind(vespa)
export const searchChatMemory = vespa.searchChatMemory.bind(vespa)
export const searchEpisodicMemory = vespa.searchEpisodicMemory.bind(vespa)
export const searchVespa = async (
  query: string,
  email: string,
  app: Apps | Apps[] | null,
  entity: Entity | Entity[] | null,
  options: Partial<VespaQueryConfig> = {},
) => {
  let isSlackConnected = false
  let isDriveConnected = false
  let isGmailConnected = false
  let isCalendarConnected = false
  let isZohoDeskConnected = false

  let connector
  try {
    connector = await getConnectorByAppAndEmailId(
      db,
      Apps.Slack,
      AuthType.OAuth,
      email,
    )
    isSlackConnected = Boolean(
      connector && connector.status === ConnectorStatus.Connected,
    )
  } catch (error) {
    Logger.error({ err: error, email }, "Error fetching Slack connector status")
  }
  try {
    const [driveConnector, gmailConnector, calendarConnector] =
      await Promise.all([
        getAppSyncJobsByEmail(
          db,
          Apps.GoogleDrive,
          config.CurrentAuthType,
          email,
        ),
        getAppSyncJobsByEmail(db, Apps.Gmail, config.CurrentAuthType, email),
        getAppSyncJobsByEmail(
          db,
          Apps.GoogleCalendar,
          config.CurrentAuthType,
          email,
        ),
      ])
    isDriveConnected = Boolean(driveConnector && driveConnector.length > 0)
    isGmailConnected = Boolean(gmailConnector && gmailConnector.length > 0)
    isCalendarConnected = Boolean(
      calendarConnector && calendarConnector.length > 0,
    )
  } catch (error) {
    Logger.error(
      { err: error, email },
      "Error fetching Google sync jobs status",
    )
  }
  // Use utility function to check Zoho Desk connection
  isZohoDeskConnected = await checkZohoDeskConnected(db, email)
  const processedCollectionSelections = await extractCollectionVespaIds(options)

  // For Zoho Desk queries, use permissionId (department ID) instead of email for filtering
  // This allows users to only see tickets from their assigned departments
  const emailOrPermission = options.permissionId || email

  return await vespa.searchVespa.bind(vespa)(
    query,
    emailOrPermission,
    app,
    entity,
    {
      ...options,
      appFilters: options.appFilters, // Explicitly pass appFilters
      recencyDecayRate:
        options.recencyDecayRate || config.defaultRecencyDecayRate,
      isSlackConnected,
      isDriveConnected,
      isGmailConnected,
      isCalendarConnected,
      isZohoDeskConnected,
      processedCollectionSelections,
    },
  )
}

export const searchVespaAgent = async (
  query: string,
  email: string,
  app: Apps | Apps[] | null,
  entity: Entity | Entity[] | null,
  AgentApps: Apps[] | null,
  options: Partial<VespaQueryConfig> = {},
) => {
  const driveIds = await extractDriveIds(options, email)
  const processedCollectionSelections = await extractCollectionVespaIds(options)

  // Send permissionId if available, otherwise send email
  const emailOrPermission = (options as any).permissionId || email

  return await vespa.searchVespaAgent.bind(vespa)(
    query,
    emailOrPermission,
    app,
    entity,
    AgentApps,
    {
      ...options,
      driveIds,
      processedCollectionSelections,
      appFilters: options.appFilters, // Explicitly pass appFilters
      recencyDecayRate:
        options.recencyDecayRate || config.defaultRecencyDecayRate,
    },
  )
}

export const searchVespaInFiles = async (
  ...args: Parameters<typeof vespa.searchVespaInFiles>
) => {
  const result = await vespa.searchVespaInFiles.bind(vespa)(...args)
  return dedupeResponseChildren(result)
}
export const searchVespaKnowledgeBase =
  vespa.searchVespaKnowledgeBase.bind(vespa)
export const groupVespaSearch = vespa.groupVespaSearch.bind(vespa)
export const groupVespaSearchKnowledgeBase =
  vespa.groupVespaSearchKnowledgeBase.bind(vespa)
export const autocomplete = async (
  ...args: Parameters<typeof vespa.autocomplete>
) => {
  const result = await vespa.autocomplete.bind(vespa)(...args)
  return dedupeResponseChildren(result)
}
export const deduplicateAutocomplete = vespa.deduplicateAutocomplete.bind(vespa)

// User operations
export const searchUsersByNamesAndEmails =
  vespa.searchUsersByNamesAndEmails.bind(vespa)
export const updateUserQueryHistory = vespa.updateUserQueryHistory.bind(vespa)

// Mail operations
export const ifMailDocumentsExist = vespa.ifMailDocumentsExist.bind(vespa)
export const IfMailDocExist = vespa.IfMailDocExist.bind(vespa)
export const SearchEmailThreads = vespa.SearchEmailThreads.bind(vespa)
export const searchGoogleApps = vespa.searchGoogleApps.bind(vespa)
// Item operations
export const getItems = async (
  params: Omit<GetItemsParams, "processedCollectionSelections"> & {
    collectionSelections?: Array<{
      collectionIds?: string[]
      collectionFolderIds?: string[]
      collectionFileIds?: string[]
    }>
    appFilters?: any
    permissionId?: string
  },
) => {
  const driveIds = await extractDriveIds(
    { selectedItem: params.selectedItem },
    params.email,
  )
  const processedCollectionSelections = await extractCollectionVespaIds({
    collectionSelections: params.collectionSelections,
  })

  // Extract permissionId and use it if available, otherwise use email
  const { permissionId, email, ...restParams } = params
  const emailOrPermission = permissionId || email

  return await vespa.getItems.bind(vespa)({
    processedCollectionSelections,
    driveIds,
    email: emailOrPermission,
    ...restParams,
  })
}

export const getFolderItems = vespa.getFolderItems.bind(vespa)
export const searchSlackMessages = vespa.searchSlackMessages.bind(vespa)
export const SearchVespaThreads = vespa.SearchVespaThreads.bind(vespa)

// DataSource operations
export const insertDataSource = vespa.insertDataSource.bind(vespa)
export const insertDataSourceFile = vespa.insertDataSourceFile.bind(vespa)
export const getDataSourceByNameAndCreator =
  vespa.getDataSourceByNameAndCreator.bind(vespa)
export const fetchAllDataSourceFilesByName =
  vespa.fetchAllDataSourceFilesByName.bind(vespa)
export const getDataSourcesByCreator = vespa.getDataSourcesByCreator.bind(vespa)
export const checkIfDataSourceFileExistsByNameAndId =
  vespa.checkIfDataSourceFileExistsByNameAndId.bind(vespa)

// Slack operations
export const fetchSlackEntity = vespa.fetchSlackEntity.bind(vespa)

// Utility operations
export const getTimestamp = vespa.getTimestamp.bind(vespa)
export const GetRandomDocument = vespa.GetRandomDocument.bind(vespa)
export const HybridDefaultProfile = vespa.HybridDefaultProfile.bind(vespa)

export const GetDocumentsByDocIds = vespa.GetDocumentsByDocIds.bind(vespa)
export const searchSlackInVespa = vespa.searchSlackInVespa.bind(vespa)

export const getAllDocumentsForAgent = vespa.getAllDocumentsForAgent.bind(vespa)
export const ifDocumentsExist = vespa.ifDocumentsExist.bind(vespa)

export const insertDocument = vespa.insertDocument.bind(vespa)
export const insertUser = vespa.insertUser.bind(vespa)
export const UpdateEventCancelledInstances =
  vespa.UpdateEventCancelledInstances.bind(vespa)
export const insertWithRetry = vespa.insertWithRetry.bind(vespa)
export const UpdateDocumentPermissions =
  vespa.UpdateDocumentPermissions.bind(vespa)
export const ifDocumentsExistInSchema =
  vespa.ifDocumentsExistInSchema.bind(vespa)
export const ifDocumentsExistInChatContainer =
  vespa.ifDocumentsExistInChatContainer.bind(vespa)

export default vespa
