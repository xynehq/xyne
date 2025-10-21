#!/usr/bin/env bun

import fs from "node:fs"
import path from "node:path"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Integrations)

interface SlackMessage {
  id: string
  sddocname: string
  text: string
  documentid: string
  docId: string
  domain?: string
  channelName: string
  isPrivate: boolean
  teamId: string
  channelId: string
  name: string
  username: string
  image?: string
  userId: string
  createdAt: number
  threadId: string
  app: string
  entity: string
  updatedAt: number
  deletedAt: number
  [key: string]: any
}

interface SlackData {
  channelId: string
  extractedAt: string
  threads: Array<{
    threadId: string
    messageCount: number
    messages: SlackMessage[]
  }>
}

async function convertSlackDataToVespaFeed(
  inputFile: string,
  outputFile: string,
) {
  Logger.info(`Converting Slack data from ${inputFile} to Vespa feed format...`)

  try {
    // Read the original JSON file
    const rawData = fs.readFileSync(inputFile, "utf-8")
    const slackData: SlackData = JSON.parse(rawData)

    // Create output stream
    const outputStream = fs.createWriteStream(outputFile)

    let processedCount = 0
    let totalMessages = 0

    // Count total messages first
    for (const thread of slackData.threads) {
      totalMessages += thread.messages.length
    }

    Logger.info(`Found ${totalMessages} messages to convert`)

    // Process each thread and message
    for (const thread of slackData.threads) {
      for (const message of thread.messages) {
        try {
          // Create Vespa document in proper feed format
          const vespaDoc = {
            put: message.documentid,
            fields: {
              docId: message.docId,
              text: message.text,
              teamId: message.teamId,
              channelId: message.channelId,
              name: message.name,
              username: message.username,
              image: message.image || "",
              userId: message.userId,
              createdAt: Math.floor(message.createdAt * 1000), // Convert to milliseconds
              threadId: message.threadId,
              app: message.app,
              entity: message.entity,
              attachmentIds: [], // Default empty array
              reactions: 0, // Default value
              replyCount: 0, // Default value
              replyUsersCount: 0, // Default value
              mentions: message.mentions || [], // Use mentions if available
              updatedAt: Math.floor(message.updatedAt * 1000), // Convert to milliseconds
              deletedAt: message.deletedAt,
              metadata: JSON.stringify({
                domain: message.domain || "",
                channelName: message.channelName,
                isPrivate: message.isPrivate,
              }),
            },
          }

          // Write each document as a separate JSON line
          outputStream.write(JSON.stringify(vespaDoc) + "\n")
          processedCount++

          if (processedCount % 1000 === 0) {
            Logger.info(`Processed ${processedCount}/${totalMessages} messages`)
          }
        } catch (error) {
          Logger.error(error, `Failed to process message ${message.docId}`)
        }
      }
    }

    outputStream.end()
    Logger.info(
      `Successfully converted ${processedCount} messages to ${outputFile}`,
    )

    return processedCount
  } catch (error) {
    Logger.error(error, `Failed to convert Slack data: ${error}`)
    throw error
  }
}

// Command line interface
const args = process.argv.slice(2)
if (args.length < 1) {
  console.error(
    "Usage: bun run convert-slack-data.ts <input-file> [output-file]",
  )
  console.error(
    "Example: bun run convert-slack-data.ts slack_data.json slack_feed.jsonl",
  )
  process.exit(1)
}

const inputFile = args[0]
const outputFile = args[1] || inputFile.replace(".json", "_feed.jsonl")

if (!fs.existsSync(inputFile)) {
  console.error(`Input file does not exist: ${inputFile}`)
  process.exit(1)
}

convertSlackDataToVespaFeed(inputFile, outputFile)
  .then((count) => {
    console.log(`✅ Successfully converted ${count} messages`)
    console.log(`📁 Output saved to: ${outputFile}`)
    console.log(`🚀 You can now feed to Vespa using:`)
    console.log(`   vespa feed -t http://localhost:8080 ${outputFile}`)
  })
  .catch((error) => {
    console.error("❌ Conversion failed:", error.message)
    process.exit(1)
  })
