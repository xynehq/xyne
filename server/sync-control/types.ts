import type { SelectSyncQueueControl } from "@/db/schema"
import type { UserRole } from "@/shared/types"
import type { SQL } from "drizzle-orm"

export type PgBossJobState =
  | "created"
  | "retry"
  | "active"
  | "completed"
  | "cancelled"
  | "failed"

export type SyncControlScopeType =
  | "global"
  | "queue"
  | "worker_group"
  | "email"
  | "connector"
  | "collection"
  | "job"

export type SyncControlAuditAction =
  | "pause"
  | "resume"
  | "worker_pause"
  | "worker_resume"
  | "cancel"
  | "delete"
  | "clear"

export type Actor = {
  userId: number
  email: string
  workspaceId: number
  workspaceExternalId: string
  role: UserRole
  isSuperAdmin: boolean
}

export type JobIdentity = {
  jobId?: string
  queueName?: string
  email?: string
  connectorId?: number
  collectionId?: string
  fileId?: string
  folderId?: string
  ticketId?: string
  attachmentId?: string
  workspaceId?: number
  app?: string
  authType?: string
}

export type QueueFilterBuilderContext = {
  actor: Actor
  queueName: string
}

export type QueueFilterBuilder = (
  value: unknown,
  context: QueueFilterBuilderContext,
) => SQL | null

export type SyncQueueDefinition = {
  queueName: string
  workerGroup: string
  defaultConcurrency: number
  payloadKind:
    | "global-sync"
    | "per-user-sync"
    | "kb-file"
    | "zoho-ticket"
    | "zoho-attachment"
    | "connector-sync"
    | "maintenance"
  allowedScopes: SyncControlScopeType[]
  filterBuilders: Record<string, QueueFilterBuilder>
  jobIdentityExtractor: (jobData: unknown) => JobIdentity
  controlMatcher: (
    control: SelectSyncQueueControl,
    identity: JobIdentity,
    jobData: unknown,
    queueName: string,
  ) => boolean
  mutationPolicy: {
    canDelete: boolean
    canCancelQueued: boolean
    canPauseScoped: boolean
    requiresDomainCancel: boolean
    allowedDeleteStates: PgBossJobState[]
    allowedCancelStates: PgBossJobState[]
    activeCancelMode: "job_control" | "unsupported"
  }
  domainCancelHandler?: (
    identity: JobIdentity,
    reason: string,
    actor: Actor,
  ) => Promise<void>
  pauseBehavior: "defer_before_start" | "checkpoint_only"
}

export type QueueJobRow = {
  id: string
  queueName: string
  state: PgBossJobState
  priority: number
  data: unknown
  retryLimit: number
  retryCount: number
  startAfter: Date | null
  startedOn: Date | null
  createdOn: Date
  completedOn: Date | null
  singletonKey: string | null
}

export type WorkerCommandResult = {
  workerGroup: string
  requested: number
  affected: number
  results: Array<{
    targetId: string
    status: "paused" | "resumed" | "failed" | "not_found"
    workerId?: string
    error?: string
  }>
}
