#!/usr/bin/env bun

import { insert } from "@/search/vespa"
import { fileSchema, mailSchema, eventSchema } from "@xyne/vespa-ts/types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { createId } from "@paralleldrive/cuid2"

const Logger = getLogger(Subsystem.Scripts)

interface SampleDocument {
  title: string
  content: string
  type: "file" | "email" | "event"
  userEmail: string
}

const sampleData: SampleDocument[] = [
  {
    title: "Sample Document 1",
    content: "This is a sample document content for testing Vespa ingestion.",
    type: "file",
    userEmail: "user@example.com",
  },
  {
    title: "Sample Email",
    content: "This is a sample email content for testing email search.",
    type: "email",
    userEmail: "user@example.com",
  },
  {
    title: "Sample Meeting",
    content: "This is a sample meeting description for calendar events.",
    type: "event",
    userEmail: "user@example.com",
  },
]

async function ingestSampleData() {
  Logger.info("Starting sample data ingestion...")

  for (const doc of sampleData) {
    try {
      const docId = createId()

      if (doc.type === "file") {
        const vespaDoc = {
          docId,
          title: doc.title,
          url: `https://example.com/${docId}`,
          app: "DataSource" as const,
          entity: "Misc" as const,
          chunks: [doc.content],
          permissions: [doc.userEmail],
          mimeType: "text/plain",
          owner: doc.userEmail,
          ownerEmail: doc.userEmail,
          parentId: null,
          photoLink: "",
        }

        await insert(vespaDoc, fileSchema)
        Logger.info(`Inserted file document: ${doc.title} (${docId})`)
      } else if (doc.type === "email") {
        const vespaDoc = {
          docId,
          subject: doc.title,
          body: doc.content,
          from: doc.userEmail,
          to: doc.userEmail,
          cc: "",
          bcc: "",
          timestamp: Date.now(),
          threadId: docId,
          app: "Gmail" as const,
          entity: "Email" as const,
          permissions: [doc.userEmail],
          chunks: [doc.content],
        }

        await insert(vespaDoc, mailSchema)
        Logger.info(`Inserted email document: ${doc.title} (${docId})`)
      } else if (doc.type === "event") {
        const vespaDoc = {
          docId,
          title: doc.title,
          description: doc.content,
          startTime: Date.now(),
          endTime: Date.now() + 3600000, // 1 hour later
          app: "GoogleCalendar" as const,
          entity: "Event" as const,
          permissions: [doc.userEmail],
          chunks: [doc.content],
          attendees: [doc.userEmail],
          creator: doc.userEmail,
          location: "Virtual",
          status: "confirmed" as const,
        }

        await insert(vespaDoc, eventSchema)
        Logger.info(`Inserted event document: ${doc.title} (${docId})`)
      }

      // Add delay to avoid overwhelming Vespa
      await new Promise((resolve) => setTimeout(resolve, 100))
    } catch (error) {
      Logger.error(error, `Failed to insert document: ${doc.title}`)
    }
  }

  Logger.info("Sample data ingestion completed!")
}

// Run the ingestion
ingestSampleData().catch((error) => {
  Logger.error(error, "Sample data ingestion failed")
  process.exit(1)
})
