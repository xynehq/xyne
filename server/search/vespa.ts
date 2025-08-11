import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import {
  createVespaService,
  createDefaultConfig,
  type VespaDependencies,
} from "@xyne/vespa-ts"
import config from "@/config"
const prodUrl = process.env.PRODUCTION_SERVER_URL
const apiKey = process.env.API_KEY
import { fileSchema, mailSchema, userSchema } from "@/search/types"
// Define your Vespa endpoint and schema name
const vespaEndpoint = `http://${config.vespaBaseHost}:8080`
export const NAMESPACE = "namespace" // Replace with your actual namespace
const CLUSTER = "my_content"

const Logger = getLogger(Subsystem.Vespa).child({ module: "vespa" })

const vespaConfig = createDefaultConfig({
  vespaBaseHost: config.vespaBaseHost,
  page: 20,
  isDebugMode: false,
  productionServerUrl: prodUrl,
  apiKey: apiKey,
  namespace: NAMESPACE,
  cluster: CLUSTER,
  vespaMaxRetryAttempts: config.vespaMaxRetryAttempts,
  vespaRetryDelay: config.vespaRetryDelay,
})

const dependencies: VespaDependencies = {
  logger: Logger,
  config: vespaConfig,
  sourceSchemas: [fileSchema, userSchema, mailSchema],
  vespaEndpoint: vespaEndpoint,
}

const vespa = createVespaService(dependencies)

export const insert = vespa.insert.bind(vespa)
export const GetDocument = vespa.GetDocument.bind(vespa)
export const getDocumentOrNull = vespa.getDocumentOrNull.bind(vespa)
export const UpdateDocument = vespa.UpdateDocument.bind(vespa)
export const DeleteDocument = vespa.DeleteDocument.bind(vespa)

// Search operations
export const searchVespa = vespa.searchVespa.bind(vespa)
export const searchVespaInFiles = vespa.searchVespaInFiles.bind(vespa)
export const searchVespaAgent = vespa.searchVespaAgent.bind(vespa)
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
