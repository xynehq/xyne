#!/usr/bin/env bun

import { boss } from "@/queue"
import { FileProcessingQueue, PdfFileProcessingQueue } from "@/queue/api-server-queue"

async function clearFileProcessorQueues() {
  console.log("🧹 Clearing file processor queues...")

  try {
    await boss.start()

    // Clear file processing queue
    await boss.clearQueue(FileProcessingQueue)
    console.log(`✅ Cleared queue: ${FileProcessingQueue}`)

    // Clear PDF file processing queue
    await boss.clearQueue(PdfFileProcessingQueue)
    console.log(`✅ Cleared queue: ${PdfFileProcessingQueue}`)

    console.log("🎉 All file processor queues cleared successfully!")
  } catch (error) {
    console.error("❌ Failed to clear queues:", error)
    process.exit(1)
  } finally {
    await boss.stop()
    process.exit(0)
  }
}

clearFileProcessorQueues()
