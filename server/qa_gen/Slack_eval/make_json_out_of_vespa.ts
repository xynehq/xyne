import { writeFileSync } from "fs"
import { join } from "path"

// Configuration
const VESPA_ENDPOINT = "http://0.0.0.0:8080"
const CHANNEL_ID = "C06U5J8JPGS"
const MESSAGES_OUTPUT_FILE = "slack_messages.json"
const SUMMARY_OUTPUT_FILE = "summary_and_issues.json"

interface VespaHit {
  id: string
  relevance: number
  source: string
  fields: {
    docId?: string
    teamId?: string
    channelId?: string
    text?: string
    name?: string
    username?: string
    image?: string
    userId?: string
    createdAt?: number
    threadId?: string
    app?: string
    entity?: string
    attachmentIds?: string[]
    reactions?: number
    replyCount?: number
    replyUsersCount?: number
    mentions?: string[]
    updatedAt?: number
    deletedAt?: number
    metadata?: string
    [key: string]: any
  }
}

interface VespaResponse {
  root: {
    id: string
    relevance: number
    fields: {
      totalCount: number
    }
    coverage: {
      coverage: number
      documents: number
      full: boolean
      nodes: number
      results: number
      resultsFull: number
    }
    children?: VespaHit[]
  }
}

async function fetchChatMessages(channelId: string): Promise<VespaHit[]> {
  const hitsPerPage = 400 // Vespa's configured limit per request
  let allMessages: VespaHit[] = []
  let lastCreatedAt = 0 // Start from the beginning
  let hasMore = true
  let batchCount = 0

  console.log(`Fetching messages from channel: ${channelId}`)
  console.log(
    `Using cursor-based pagination with createdAt field to fetch all messages\n`,
  )

  try {
    while (hasMore) {
      batchCount++

      // Use cursor-based pagination by filtering on createdAt
      // This avoids the offset limit by using a WHERE clause
      const yqlQuery = `select * from chat_message where channelId contains "${channelId}" and createdAt > ${lastCreatedAt} order by createdAt asc;`

      const params = new URLSearchParams({
        yql: yqlQuery,
        hits: hitsPerPage.toString(),
      })
      const url = `${VESPA_ENDPOINT}/search/?${params.toString()}`

      console.log(`Fetching batch ${batchCount}: createdAt > ${lastCreatedAt}`)

      const response = await fetch(url)

      if (!response.ok) {
        const errorText = await response.text()
        console.error(`Error response: ${errorText}`)
        throw new Error(
          `HTTP error! status: ${response.status}, body: ${errorText}`,
        )
      }

      const data: VespaResponse = await response.json()

      if (!data.root.children || data.root.children.length === 0) {
        hasMore = false
        break
      }

      allMessages.push(...data.root.children)
      console.log(
        `Fetched ${data.root.children.length} messages (total so far: ${allMessages.length})`,
      )

      // Update cursor to the last message's createdAt timestamp
      const lastMessage = data.root.children[data.root.children.length - 1]
      if (lastMessage.fields.createdAt) {
        lastCreatedAt = lastMessage.fields.createdAt
      }

      // Check if we got fewer results than requested, meaning we've reached the end
      if (data.root.children.length < hitsPerPage) {
        hasMore = false
      }
    }

    console.log(`\n✓ Successfully fetched all messages: ${allMessages.length}`)
    return allMessages
  } catch (error) {
    console.error("Error fetching messages from Vespa:", error)
    throw error
  }
}

async function main() {
  try {
    console.log("Starting Vespa chat message extraction...")

    // Fetch messages from Vespa
    const messages = await fetchChatMessages(CHANNEL_ID)

    if (messages.length === 0) {
      console.log("No messages to save")
      return
    }

    // Group messages by threadId
    const messagesByThread: Record<string, any[]> = {}
    const uniqueThreadIds = new Set<string>()
    const messagesWithoutThreadId: any[] = []

    for (const hit of messages) {
      const message = {
        id: hit.id,
        relevance: hit.relevance,
        ...hit.fields,
      }

      const threadId = hit.fields.threadId

      if (threadId) {
        uniqueThreadIds.add(threadId)
        if (!messagesByThread[threadId]) {
          messagesByThread[threadId] = []
        }
        messagesByThread[threadId].push(message)
      } else {
        messagesWithoutThreadId.push(message)
      }
    }

    // Prepare output data organized by threads
    const threads = Object.entries(messagesByThread).map(
      ([threadId, threadMessages]) => ({
        threadId,
        messageCount: threadMessages.length,
        messages: threadMessages.sort(
          (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
        ),
      }),
    )

    // Sort threads by the first message's createdAt
    threads.sort((a, b) => {
      const aFirstMsg = a.messages[0]?.createdAt || 0
      const bFirstMsg = b.messages[0]?.createdAt || 0
      return aFirstMsg - bFirstMsg
    })

    // Prepare messages output (just the threads array)
    const messagesOutput = {
      channelId: CHANNEL_ID,
      extractedAt: new Date().toISOString(),
      threads,
    }

    // Prepare summary and issues output
    const summaryOutput = {
      channelId: CHANNEL_ID,
      totalMessages: messages.length,
      uniqueThreadCount: uniqueThreadIds.size,
      messagesWithoutThreadCount: messagesWithoutThreadId.length,
      extractedAt: new Date().toISOString(),
      threadStatistics: {
        avgMessagesPerThread: 0,
        maxMessagesInThread: 0,
        minMessagesInThread: 0,
      },
      messagesWithoutThreadId: messagesWithoutThreadId,
    }

    // Calculate thread statistics
    const threadSizes = threads.map((t) => t.messageCount)
    summaryOutput.threadStatistics.avgMessagesPerThread = parseFloat(
      (threadSizes.reduce((a, b) => a + b, 0) / threadSizes.length).toFixed(2),
    )
    summaryOutput.threadStatistics.maxMessagesInThread = Math.max(
      ...threadSizes,
    )
    summaryOutput.threadStatistics.minMessagesInThread = Math.min(
      ...threadSizes,
    )

    // Save messages to JSON file
    const messagesOutputPath = join(__dirname, MESSAGES_OUTPUT_FILE)
    writeFileSync(
      messagesOutputPath,
      JSON.stringify(messagesOutput, null, 2),
      "utf-8",
    )

    // Save summary and issues to JSON file
    const summaryOutputPath = join(__dirname, SUMMARY_OUTPUT_FILE)
    writeFileSync(
      summaryOutputPath,
      JSON.stringify(summaryOutput, null, 2),
      "utf-8",
    )

    console.log(
      `\n✓ Successfully saved ${messages.length} messages to ${messagesOutputPath}`,
    )
    console.log(`✓ Successfully saved summary to ${summaryOutputPath}`)
    console.log(`\n=== SUMMARY ===`)
    console.log(`  Channel ID: ${CHANNEL_ID}`)
    console.log(`  Total Messages: ${messages.length}`)
    console.log(`  Unique Thread IDs: ${uniqueThreadIds.size}`)
    console.log(
      `  Messages without threadId: ${messagesWithoutThreadId.length}`,
    )
    console.log(`  Messages File: ${MESSAGES_OUTPUT_FILE}`)
    console.log(`  Summary File: ${SUMMARY_OUTPUT_FILE}`)
    console.log(`\n=== THREAD STATISTICS ===`)
    console.log(
      `  Average messages per thread: ${summaryOutput.threadStatistics.avgMessagesPerThread}`,
    )
    console.log(
      `  Max messages in a thread: ${summaryOutput.threadStatistics.maxMessagesInThread}`,
    )
    console.log(
      `  Min messages in a thread: ${summaryOutput.threadStatistics.minMessagesInThread}`,
    )
  } catch (error) {
    console.error("Failed to extract messages:", error)
    process.exit(1)
  }
}

// Run the script
main()
