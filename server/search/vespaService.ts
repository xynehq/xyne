import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import {
  createVespaService,
  createDefaultConfig,
  type VespaDependencies,
} from "@xyne/vespa-ts"
import config, { CLUSTER, NAMESPACE } from "@/config"
import {
  fileSchema,
  userSchema,
  mailSchema,
  eventSchema,
  mailAttachmentSchema,
  chatUserSchema,
  chatMessageSchema,
  chatContainerSchema,
  type VespaSchema,
} from "@xyne/vespa-ts/types"

// Generic ticket schema constant (supports Zoho Desk, Jira, Linear, etc.)
const ticketSchema = "ticket" as const

const Logger = getLogger(Subsystem.Vespa).child({ module: "vespa-service" })

const vespaConfig = createDefaultConfig({
  vespaBaseHost: config.vespaBaseHost,
  page: config.VespaPageSize,
  isDebugMode: config.isDebugMode,
  namespace: NAMESPACE,
  cluster: CLUSTER,
  vespaMaxRetryAttempts: config.vespaMaxRetryAttempts,
  vespaRetryDelay: config.vespaRetryDelay,
  feedEndpoint: config.vespaEndpoint.feedEndpoint,
  queryEndpoint: config.vespaEndpoint.queryEndpoint,
})

const AllSources = [
  fileSchema,
  userSchema,
  mailSchema,
  eventSchema,
  mailAttachmentSchema,
  // chatUserSchema, // we mostly should not be searching for chat users
  chatMessageSchema,
  chatContainerSchema,
  ticketSchema,
] as VespaSchema[]

const dependencies: VespaDependencies = {
  logger: Logger,
  config: vespaConfig,
  sourceSchemas: AllSources,
}

// Create a single shared vespa service instance
export const sharedVespaService = createVespaService(dependencies)
