import { InitialisationError } from "@/errors"
import { closeRedisClient } from "@/lib/redisClient"
import { getLogger } from "@/logger"
import { startDoclingSchedulerRole } from "@/queue/doclingSchedulerWorkers"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Queue).child({
  module: "doclingSchedulerWorkerMain",
})

const shutdown = async (signal: string) => {
  Logger.info({ signal }, "Shutting down Docling scheduler worker")
  await closeRedisClient()
  process.exit(0)
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM")
})
process.on("SIGINT", () => {
  void shutdown("SIGINT")
})

const role = process.env.DOCLING_SCHEDULER_ROLE || process.env.ROLE || "reaper"

startDoclingSchedulerRole(role).catch((error) => {
  throw new InitialisationError({ cause: error })
})
