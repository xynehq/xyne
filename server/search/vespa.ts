import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import {
  Apps,
  DriveEntity,
  type Entity,
  type GetItemsParams,
  type VespaQueryConfig,
  type VespaSchema,
} from "@xyne/vespa-ts/types"
import config from "@/config"
import { db } from "@/db/client"
import { getConnectorByAppAndEmailId } from "@/db/connector"
import { AuthType, ConnectorStatus } from "@/shared/types"
import { extractDriveIds, extractCollectionVespaIds } from "./utils"
import { getAppSyncJobsByEmail } from "@/db/syncJob"
import { sharedVespaService as vespa } from "./vespaService"

const Logger = getLogger(Subsystem.Vespa).child({ module: "vespa" })

export const insert = vespa.insert.bind(vespa)
export const GetDocument = vespa.GetDocument.bind(vespa)
export const getDocumentOrNull = vespa.getDocumentOrNull.bind(vespa)
export const UpdateDocument = vespa.UpdateDocument.bind(vespa)
export const DeleteDocument = vespa.DeleteDocument.bind(vespa)
export const searchCollectionRAG = vespa.searchCollectionRAG.bind(vespa)
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
  const processedCollectionSelections = await extractCollectionVespaIds(options)
  return await vespa.searchVespa.bind(vespa)(query, email, app, entity, {
    ...options,
    recencyDecayRate:
      options.recencyDecayRate || config.defaultRecencyDecayRate,
    isSlackConnected,
    isDriveConnected,
    isGmailConnected,
    isCalendarConnected,
    processedCollectionSelections,
  })
}

export const searchVespaAgent = async (
  query: string,
  email: string,
  app: Apps | Apps[] | null,
  entity: Entity | Entity[] | null,
  AgentApps: Apps[] | null,
  options: Partial<VespaQueryConfig> = {},
) => {

  Logger.info(`[searchVespaAgent] options.collectionSelections: ${JSON.stringify(options.collectionSelections)}`)
  Logger.info(`[searchVespaAgent] options.selectedItem: ${JSON.stringify(options.selectedItem)}`)
  const driveIds = await extractDriveIds(options, email)
  const processedCollectionSelections = await extractCollectionVespaIds(options)
  Logger.debug({ 
    hasCollectionIds: Boolean(processedCollectionSelections.collectionIds?.length),
    hasFolderIds: Boolean(processedCollectionSelections.collectionFolderIds?.length),
    hasFileIds: Boolean(processedCollectionSelections.collectionFileIds?.length)
  }, '[searchVespaAgent] Processed selections summary')
  return await vespa.searchVespaAgent.bind(vespa)(
    query,
    email,
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

export const searchVespaInFiles = vespa.searchVespaInFiles.bind(vespa)
export const groupVespaSearch = vespa.groupVespaSearch.bind(vespa)
export const autocomplete = vespa.autocomplete.bind(vespa)
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
  },
) => {
  const driveIds = await extractDriveIds(
    { selectedItem: params.selectedItem },
    params.email,
  )
  const processedCollectionSelections = await extractCollectionVespaIds({
    collectionSelections: params.collectionSelections,
  })
  return await vespa.getItems.bind(vespa)({
    processedCollectionSelections,
    driveIds,
    ...params,
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
