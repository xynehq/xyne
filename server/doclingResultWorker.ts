import { InitialisationError } from "@/errors"
import { closeRedisClient } from "@/lib/redisClient"
import { getLogger } from "@/logger"
import { startDoclingRedisResultWorker } from "@/queue/doclingResultWorker"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Queue).child({
  module: "doclingResultWorkerMain",
})

const shutdown = async (signal: string) => {
  Logger.info({ signal }, "Shutting down Docling result worker")
  await closeRedisClient()
  process.exit(0)
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM")
})
process.on("SIGINT", () => {
  void shutdown("SIGINT")
})

startDoclingRedisResultWorker().catch((error) => {
  throw new InitialisationError({ cause: error })
})
