import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import {
  createVespaService,
  createDefaultConfig,
  type VespaDependencies,
} from "@xyne/vespa-ts"
import config, { CLUSTER, NAMESPACE } from "@/config"
import {
  Apps,
  chatContainerSchema,
  chatMessageSchema,
  chatUserSchema,
  DriveEntity,
  eventSchema,
  fileSchema,
  mailAttachmentSchema,
  mailSchema,
  userSchema,
  type Entity,
  type VespaQueryConfig,
} from "@xyne/vespa-ts/types"
import { db, getConnectorByAppAndEmailId } from "@/db/connector"
import { AuthType, ConnectorStatus } from "@/shared/types"
import { extractDriveIds, extractCollectionVespaIds } from "./utils"
// Define your Vespa endpoint and schema name

const Logger = getLogger(Subsystem.Vespa).child({ module: "vespa" })

const vespaConfig = createDefaultConfig({
  vespaBaseHost: config.vespaBaseHost,
  page: config.VespaPageSize,
  isDebugMode: config.isDebugMode,
  namespace: NAMESPACE,
  cluster: CLUSTER,
  vespaMaxRetryAttempts: config.vespaMaxRetryAttempts,
  vespaRetryDelay: config.vespaRetryDelay,
})
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
]
const dependencies: VespaDependencies = {
  logger: Logger,
  config: vespaConfig,
  sourceSchemas: AllSources,
  vespaEndpoint: config.vespaEndpoint,
}

const vespa = createVespaService(dependencies)

export const insert = vespa.insert.bind(vespa)
export const GetDocument = vespa.GetDocument.bind(vespa)
export const getDocumentOrNull = vespa.getDocumentOrNull.bind(vespa)
export const UpdateDocument = vespa.UpdateDocument.bind(vespa)
export const DeleteDocument = vespa.DeleteDocument.bind(vespa)

export const searchVespa = async (
  query: string,
  email: string,
  app: Apps | Apps[] | null,
  entity: Entity | Entity[] | null,
  options: Partial<VespaQueryConfig> = {},
) => {
  let isSlackConnected = false
  try {
    const connector = await getConnectorByAppAndEmailId(
      db,
      Apps.Slack,
      AuthType.OAuth,
      email,
    )
    isSlackConnected =
      connector && connector.status === ConnectorStatus.Connected
  } catch (error) {}

  return await vespa.searchVespa.bind(vespa)(query, email, app, entity, {
    ...options,
    recencyDecayRate: options.recencyDecayRate || 0.1,
    isSlackConnected,
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
  const driveIds = await extractDriveIds(options, email)
  const clVespaIds = await extractCollectionVespaIds(options)
  return await vespa.searchVespaAgent.bind(vespa)(
    query,
    email,
    app,
    entity,
    AgentApps,
    {
      ...options,
      driveIds,
      clVespaIds,
      recencyDecayRate: options.recencyDecayRate || 0.1,
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

// Item operations
export const getItems = vespa.getItems.bind(vespa)
export const getFolderItems = vespa.getFolderItems.bind(vespa)
export const getThreadItems = vespa.getThreadItems.bind(vespa)
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
export const getSlackUserDetails = vespa.getSlackUserDetails.bind(vespa)

// Utility operations
export const getTimestamp = vespa.getTimestamp.bind(vespa)
export const GetRandomDocument = vespa.GetRandomDocument.bind(vespa)
export const HybridDefaultProfile = vespa.HybridDefaultProfile.bind(vespa)

export const GetDocumentsByDocIds = vespa.GetDocumentsByDocIds.bind(vespa)
export const searchVespaThroughAgent = vespa.searchVespaThroughAgent.bind(vespa)
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
