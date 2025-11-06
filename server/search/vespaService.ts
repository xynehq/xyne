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

// Zoho Desk schema constant
const zohoTicketSchema = "zoho_ticket" as const

const Logger = getLogger(Subsystem.Vespa).child({ module: "vespa-service" })

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
  zohoTicketSchema,
] as VespaSchema[]

const dependencies: VespaDependencies = {
  logger: Logger,
  config: vespaConfig,
  sourceSchemas: AllSources,
  vespaEndpoint: config.vespaEndpoint,
}

// Create a single shared vespa service instance
export const sharedVespaService = createVespaService(dependencies)
