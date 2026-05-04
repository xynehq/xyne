import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import type { Context, Next } from "hono"
import { z } from "zod"
import type { WorkerCommandResult } from "./types"

export const InternalSyncControlAuth = async (c: Context, next: Next) => {
  const authHeader = c.req.header("Authorization")
  const expectedSecret = process.env.METRICS_SECRET
  if (
    !expectedSecret ||
    !authHeader ||
    !authHeader.startsWith("Bearer ") ||
    authHeader.slice(7) !== expectedSecret
  ) {
    return c.json({ message: "Unauthorized" }, 401)
  }
  await next()
}

export const internalWorkerCommandSchema = z.object({
  workerGroup: z.string().min(1),
  count: z.number().int().nonnegative().optional(),
})

type InternalSyncControlDeps = {
  getWorkerState: () => unknown
  pauseWorkerGroup: (
    workerGroup: string,
    count?: number,
  ) => Promise<WorkerCommandResult>
  resumeWorkerGroup: (
    workerGroup: string,
    count?: number,
  ) => Promise<WorkerCommandResult>
}

export const buildInternalSyncControlRoutes = (
  deps: InternalSyncControlDeps,
) => {
  const app = new Hono()

  app.get("/workers/state", InternalSyncControlAuth, (c) =>
    c.json(deps.getWorkerState() as Record<string, unknown>),
  )

  app.post(
    "/workers/pause",
    InternalSyncControlAuth,
    zValidator("json", internalWorkerCommandSchema),
    async (c) => {
      const body = c.req.valid("json")
      return c.json(await deps.pauseWorkerGroup(body.workerGroup, body.count))
    },
  )

  app.post(
    "/workers/resume",
    InternalSyncControlAuth,
    zValidator("json", internalWorkerCommandSchema),
    async (c) => {
      const body = c.req.valid("json")
      return c.json(await deps.resumeWorkerGroup(body.workerGroup, body.count))
    },
  )

  return app
}
