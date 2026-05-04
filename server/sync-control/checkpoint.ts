import { getLogger } from "@/logger"
import { UserRole } from "@/shared/types"
import { Subsystem } from "@/types"
import { getMatchingControls } from "./controlState"
import { deferActiveJob } from "./queueStore"
import { getQueueDefinition } from "./registry"
import type { Actor } from "./types"

const Logger = getLogger(Subsystem.Queue).child({ module: "sync-control" })

export type SyncControlCheckpoint =
  | "before_start"
  | "scheduler_item"
  | "loop_checkpoint"

export const checkSyncControl = async ({
  queueName,
  jobId,
  jobData,
  checkpoint,
  actor,
  deferSeconds = 300,
}: {
  queueName: string
  jobId?: string
  jobData: unknown
  checkpoint: SyncControlCheckpoint
  workspaceId?: number
  actor?: Actor
  deferSeconds?: number
}): Promise<"allowed" | "deferred" | "cancelled"> => {
  const definition = getQueueDefinition(queueName)
  const controls = await getMatchingControls({
    queueName,
    jobData,
    jobId,
    actor,
  })
  const cancelControl = controls.find(
    (control) => control.controlType === "cancel",
  )
  if (cancelControl) {
    const identity = definition.jobIdentityExtractor(jobData)
    if (definition.domainCancelHandler) {
      await definition.domainCancelHandler(
        { ...identity, jobId, queueName },
        cancelControl.reason,
        actor ?? {
          userId: cancelControl.createdByUserId,
          email: cancelControl.createdByEmail,
          workspaceId: cancelControl.workspaceId ?? 0,
          workspaceExternalId: "",
          role: UserRole.SuperAdmin,
          isSuperAdmin: true,
        },
      )
    }

    Logger.info(
      `Sync control cancelled ${queueName} job ${jobId ?? "without-id"} at ${checkpoint}`,
    )
    return "cancelled"
  }

  const pauseControl = controls.find(
    (control) => control.controlType === "pause",
  )
  if (!pauseControl) return "allowed"

  if (
    checkpoint === "before_start" &&
    jobId &&
    definition.pauseBehavior === "defer_before_start"
  ) {
    await deferActiveJob({
      queueName,
      jobId,
      delaySeconds: deferSeconds,
      reason: pauseControl.reason,
    })
  }

  Logger.info(
    `Sync control paused ${queueName} job ${jobId ?? "without-id"} at ${checkpoint}`,
  )
  return "deferred"
}
