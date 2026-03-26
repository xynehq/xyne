import { parentPort } from "worker_threads"
import { getLogger } from "@/logger"
import { TOC_QUEUE_NAME } from "@/knowledgeBase/toc"
import { Subsystem } from "@/types"
import { initTocProcessingWorker } from "./worker"

const Logger = getLogger(Subsystem.Queue)

async function startTocProcessingWorker() {
  try {
    Logger.info("Starting TOC processing worker thread...")

    const { boss } = await import("@/queue")
    await boss.start()
    await boss.createQueue(TOC_QUEUE_NAME)

    await initTocProcessingWorker()
    Logger.info("TOC processing worker thread initialized successfully")

    parentPort?.postMessage({ status: "initialized" })
  } catch (error) {
    Logger.error(error, "Failed to initialize TOC processing worker thread")
    parentPort?.postMessage({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

await startTocProcessingWorker()

parentPort?.on("message", (message) => {
  Logger.info("Received message from parent:", message)
})
