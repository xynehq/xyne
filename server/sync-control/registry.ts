import type { SelectSyncQueueControl } from "@/db/schema"
import { sql } from "drizzle-orm"
import type {
  Actor,
  JobIdentity,
  QueueFilterBuilder,
  SyncControlScopeType,
  SyncQueueDefinition,
} from "./types"

const DEFAULT_ALLOWED_DELETE_STATES = [
  "created",
  "retry",
  "cancelled",
  "failed",
] as const

const DEFAULT_ALLOWED_CANCEL_STATES = ["created", "retry"] as const

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null

const asNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (
    typeof value === "string" &&
    value.trim() &&
    !Number.isNaN(Number(value))
  ) {
    return Number(value)
  }
  return null
}

const jsonTextEquals = (field: string, value: unknown) => {
  const stringValue = asString(value)
  return stringValue ? sql`j.data->>${field} = ${stringValue}` : null
}

const jsonNumericEquals = (field: string, value: unknown) => {
  const numberValue = asNumber(value)
  return numberValue === null
    ? null
    : sql`j.data->>${field} = ${String(numberValue)}`
}

const kbFileById: QueueFilterBuilder = (value) => {
  const fileId = asString(value)
  return fileId ? sql`j.data->>'fileId' = ${fileId}` : null
}

const kbFileByEmail: QueueFilterBuilder = (value) => {
  const email = asString(value)
  if (!email) return null
  return sql`(
    EXISTS (
    SELECT 1
    FROM collection_items ci
    WHERE ci.id::text IN (j.data->>'fileId', j.data->>'folderId')
      AND ci.uploaded_by_email = ${email}
    ) OR EXISTS (
    SELECT 1
    FROM collections c
    WHERE c.id::text = j.data->>'collectionId'
      AND c.last_updated_by_email = ${email}
    )
  )`
}

const kbFileByCollection: QueueFilterBuilder = (value) => {
  const collectionId = asString(value)
  if (!collectionId) return null
  return sql`(
    j.data->>'collectionId' = ${collectionId} OR EXISTS (
    SELECT 1
    FROM collection_items ci
    WHERE ci.id::text IN (j.data->>'fileId', j.data->>'folderId')
      AND ci.collection_id::text = ${collectionId}
    )
  )`
}

const perUserEmail: QueueFilterBuilder = (value) =>
  jsonTextEquals("email", value)
const connectorId: QueueFilterBuilder = (value) =>
  jsonNumericEquals("connectorId", value)
const ticketId: QueueFilterBuilder = (value) =>
  jsonTextEquals("ticketId", value)
const attachmentId: QueueFilterBuilder = (value) =>
  jsonTextEquals("attachmentId", value)

const defaultControlMatcher = (
  control: SelectSyncQueueControl,
  identity: JobIdentity,
  _jobData: unknown,
  queueName: string,
): boolean => {
  switch (control.scopeType) {
    case "global":
      return control.scopeValue === "*"
    case "queue":
      return (control.queueName ?? control.scopeValue) === queueName
    case "worker_group":
      return false
    case "email":
      return !!identity.email && identity.email === control.scopeValue
    case "connector":
      return (
        identity.connectorId !== undefined &&
        String(identity.connectorId) === control.scopeValue
      )
    case "collection":
      return (
        !!identity.collectionId && identity.collectionId === control.scopeValue
      )
    case "job":
      return !!identity.jobId && identity.jobId === control.scopeValue
    default:
      return false
  }
}

const extractObject = (jobData: unknown): Record<string, unknown> =>
  jobData && typeof jobData === "object"
    ? (jobData as Record<string, unknown>)
    : {}

const perUserIdentity = (jobData: unknown): JobIdentity => {
  const data = extractObject(jobData)
  return {
    email: asString(data.email) ?? undefined,
    connectorId: asNumber(data.connectorId) ?? undefined,
    workspaceId: asNumber(data.workspaceId) ?? undefined,
    app: asString(data.app) ?? undefined,
    authType: asString(data.authType) ?? undefined,
  }
}

const connectorIdentity = (jobData: unknown): JobIdentity => {
  const data = extractObject(jobData)
  return {
    connectorId: asNumber(data.connectorId) ?? undefined,
    email: asString(data.email) ?? undefined,
    workspaceId: asNumber(data.workspaceId) ?? undefined,
    app: asString(data.app) ?? undefined,
    authType: asString(data.authType) ?? undefined,
  }
}

const kbFileIdentity = (jobData: unknown): JobIdentity => {
  const data = extractObject(jobData)
  return {
    fileId: asString(data.fileId) ?? undefined,
    folderId: asString(data.folderId) ?? undefined,
    collectionId: asString(data.collectionId) ?? undefined,
    email: asString(data.email) ?? undefined,
    workspaceId: asNumber(data.workspaceId) ?? undefined,
  }
}

const zohoTicketIdentity = (jobData: unknown): JobIdentity => {
  const data = extractObject(jobData)
  return {
    connectorId: asNumber(data.connectorId) ?? undefined,
    ticketId: asString(data.ticketId) ?? asString(data.id) ?? undefined,
  }
}

const zohoAttachmentIdentity = (jobData: unknown): JobIdentity => {
  const data = extractObject(jobData)
  return {
    connectorId: asNumber(data.connectorId) ?? undefined,
    ticketId: asString(data.ticketId) ?? undefined,
    attachmentId: asString(data.attachmentId) ?? undefined,
  }
}

const baseMutationPolicy = {
  canDelete: true,
  canCancelQueued: true,
  canPauseScoped: true,
  requiresDomainCancel: false,
  allowedDeleteStates: [...DEFAULT_ALLOWED_DELETE_STATES],
  allowedCancelStates: [...DEFAULT_ALLOWED_CANCEL_STATES],
  activeCancelMode: "job_control" as const,
}

type QueueDefinitionOptions = Omit<
  Partial<SyncQueueDefinition>,
  "mutationPolicy"
> & {
  payloadKind: SyncQueueDefinition["payloadKind"]
  jobIdentityExtractor: SyncQueueDefinition["jobIdentityExtractor"]
  mutationPolicy?: Partial<SyncQueueDefinition["mutationPolicy"]>
}

const def = (
  queueName: string,
  workerGroup: string,
  options: QueueDefinitionOptions,
): SyncQueueDefinition => ({
  queueName,
  workerGroup,
  defaultConcurrency: options.defaultConcurrency ?? 1,
  payloadKind: options.payloadKind,
  allowedScopes:
    options.allowedScopes ??
    ([
      "global",
      "queue",
      "worker_group",
      "email",
      "connector",
      "collection",
      "job",
    ] as SyncControlScopeType[]),
  filterBuilders: options.filterBuilders ?? {},
  jobIdentityExtractor: options.jobIdentityExtractor,
  controlMatcher: options.controlMatcher ?? defaultControlMatcher,
  mutationPolicy: {
    ...baseMutationPolicy,
    ...options.mutationPolicy,
  },
  domainCancelHandler: options.domainCancelHandler,
  pauseBehavior: options.pauseBehavior ?? "defer_before_start",
})

export const SyncQueueRegistry: Record<string, SyncQueueDefinition> = {
  "ingestion-SaaS": def("ingestion-SaaS", "ingestion-saas", {
    payloadKind: "global-sync",
    jobIdentityExtractor: connectorIdentity,
    filterBuilders: { email: perUserEmail, connectorId },
  }),
  "sync-SaaS-oauth": def("sync-SaaS-oauth", "sync-saas-oauth", {
    payloadKind: "global-sync",
    jobIdentityExtractor: connectorIdentity,
    filterBuilders: { email: perUserEmail, connectorId },
  }),
  "sync-SaaS-service_account": def(
    "sync-SaaS-service_account",
    "sync-service-account",
    {
      payloadKind: "global-sync",
      jobIdentityExtractor: connectorIdentity,
      filterBuilders: { email: perUserEmail, connectorId },
    },
  ),
  "sync-SaaS-service_account-scheduler": def(
    "sync-SaaS-service_account-scheduler",
    "sync-service-account-scheduler",
    {
      payloadKind: "global-sync",
      jobIdentityExtractor: connectorIdentity,
      filterBuilders: { email: perUserEmail, connectorId },
      pauseBehavior: "checkpoint_only",
    },
  ),
  "sync-SaaS-service_account-per-user": def(
    "sync-SaaS-service_account-per-user",
    "sync-service-account-per-user",
    {
      payloadKind: "per-user-sync",
      jobIdentityExtractor: perUserIdentity,
      defaultConcurrency: 2,
      filterBuilders: { email: perUserEmail },
    },
  ),
  "sync-google-workspace-service_account": def(
    "sync-google-workspace-service_account",
    "sync-google-workspace",
    {
      payloadKind: "global-sync",
      jobIdentityExtractor: connectorIdentity,
      filterBuilders: { email: perUserEmail, connectorId },
    },
  ),
  "check-downloads-folder": def(
    "check-downloads-folder",
    "check-downloads-folder",
    {
      payloadKind: "maintenance",
      jobIdentityExtractor: () => ({}),
      mutationPolicy: { canPauseScoped: false },
    },
  ),
  "sync-slack-oauth": def("sync-slack-oauth", "sync-slack", {
    payloadKind: "global-sync",
    jobIdentityExtractor: perUserIdentity,
    filterBuilders: { email: perUserEmail },
  }),
  "sync-slack-oauth-scheduler": def(
    "sync-slack-oauth-scheduler",
    "sync-slack-scheduler",
    {
      payloadKind: "global-sync",
      jobIdentityExtractor: perUserIdentity,
      filterBuilders: { email: perUserEmail },
      pauseBehavior: "checkpoint_only",
    },
  ),
  "sync-slack-oauth-per-user": def(
    "sync-slack-oauth-per-user",
    "sync-slack-per-user",
    {
      payloadKind: "per-user-sync",
      jobIdentityExtractor: perUserIdentity,
      defaultConcurrency: 2,
      filterBuilders: { email: perUserEmail },
    },
  ),
  "sync-zoho-desk-oauth": def("sync-zoho-desk-oauth", "sync-zoho-desk", {
    payloadKind: "connector-sync",
    jobIdentityExtractor: connectorIdentity,
    filterBuilders: { connectorId },
  }),
  "process-zoho-desk-ticket": def("process-zoho-desk-ticket", "zoho-ticket", {
    payloadKind: "zoho-ticket",
    jobIdentityExtractor: zohoTicketIdentity,
    defaultConcurrency: 3,
    filterBuilders: { connectorId, ticketId },
  }),
  "process-zoho-desk-attachment": def(
    "process-zoho-desk-attachment",
    "zoho-attachment",
    {
      payloadKind: "zoho-attachment",
      jobIdentityExtractor: zohoAttachmentIdentity,
      defaultConcurrency: 5,
      filterBuilders: { connectorId, ticketId, attachmentId },
    },
  ),
  "file-processing": def("file-processing", "file-processing", {
    payloadKind: "kb-file",
    jobIdentityExtractor: kbFileIdentity,
    defaultConcurrency: 4,
    filterBuilders: {
      fileId: kbFileById,
      email: kbFileByEmail,
      collectionId: kbFileByCollection,
    },
  }),
  "file-processing-pdf": def("file-processing-pdf", "pdf-file-processing", {
    payloadKind: "kb-file",
    jobIdentityExtractor: kbFileIdentity,
    defaultConcurrency: 2,
    filterBuilders: {
      fileId: kbFileById,
      email: kbFileByEmail,
      collectionId: kbFileByCollection,
    },
  }),
  "sync-tools": def("sync-tools", "sync-tools", {
    payloadKind: "maintenance",
    jobIdentityExtractor: () => ({}),
    mutationPolicy: { canPauseScoped: false },
  }),
  "cleanup-attachments": def("cleanup-attachments", "cleanup-attachments", {
    payloadKind: "maintenance",
    jobIdentityExtractor: () => ({}),
    mutationPolicy: { canPauseScoped: false },
  }),
}

export const getQueueDefinition = (queueName: string): SyncQueueDefinition => {
  const definition = SyncQueueRegistry[queueName]
  if (!definition) {
    throw new Error(`Unsupported sync queue: ${queueName}`)
  }
  return definition
}

export const listRegisteredQueues = () => Object.values(SyncQueueRegistry)

export const workspaceGuardForQueue = (
  definition: SyncQueueDefinition,
  actor: Actor,
) => {
  if (actor.isSuperAdmin) return null
  switch (definition.payloadKind) {
    case "kb-file":
      return sql`(
        EXISTS (
        SELECT 1
        FROM collection_items ci
        WHERE ci.id::text IN (j.data->>'fileId', j.data->>'folderId')
          AND ci.workspace_id = ${actor.workspaceId}
        ) OR EXISTS (
        SELECT 1
        FROM collections c
        WHERE c.id::text = j.data->>'collectionId'
          AND c.workspace_id = ${actor.workspaceId}
        )
      )`
    case "per-user-sync":
      return sql`(
        j.data->>'workspaceId' = ${String(actor.workspaceId)} OR EXISTS (
        SELECT 1
        FROM connectors c
        WHERE c.id::text = j.data->>'connectorId'
          AND c.workspace_id = ${actor.workspaceId}
        )
      )`
    case "connector-sync":
    case "zoho-ticket":
    case "zoho-attachment":
      return sql`EXISTS (
        SELECT 1
        FROM connectors c
        WHERE c.id::text = j.data->>'connectorId'
          AND c.workspace_id = ${actor.workspaceId}
      )`
    case "global-sync":
    case "maintenance":
      return sql`FALSE`
    default:
      return sql`FALSE`
  }
}
