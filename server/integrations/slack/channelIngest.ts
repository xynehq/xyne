// Resumable Slack channel ingestion implementation
// Provides full resumability with progress tracking and WebSocket communication
// Supports stopping and starting from the exact point where ingestion was interrupted

import { getOAuthConnectorWithCredentials } from "@/db/connector"
import {
  connectors,
  type SelectConnector,
  type SlackOAuthIngestionState,
} from "@/db/schema"
import {
  Apps,
  chatAttachmentSchema,
  chatContainerSchema,
  chatMessageSchema,
  chatTeamSchema,
  chatUserSchema,
  SlackEntity,
  type VespaChatAttachment,
  type VespaChatContainer,
  type VespaChatMessage,
} from "@xyne/vespa-ts/types"
import {
  ifDocumentsExist,
  ifDocumentsExistInSchema,
  insert,
  insertWithRetry,
  UpdateDocument,
  UpdateDocumentPermissions,
} from "@/search/vespa"
import {
  OperationStatus,
  Subsystem,
  SyncCron,
  type SaaSOAuthJob,
} from "@/types"
import {
  retryPolicies,
  WebClient,
  type ConversationsHistoryResponse,
  type ConversationsListResponse,
  type ConversationsRepliesResponse,
  type FilesListResponse,
  type TeamInfoResponse,
  type UsersListResponse,
} from "@slack/web-api"
import type { Channel } from "@slack/web-api/dist/types/response/ConversationsListResponse"
import type PgBoss from "pg-boss"
import { db } from "@/db/client"
import { getLogger, getLoggerWithChild } from "@/logger"
import type { Member } from "@slack/web-api/dist/types/response/UsersListResponse"
import type { Team } from "@slack/web-api/dist/types/response/TeamInfoResponse"
import type { User } from "@slack/web-api/dist/types/response/UsersInfoResponse"
import { count, eq } from "drizzle-orm"
import { StatType, Tracker } from "@/integrations/tracker"
// Removed WebSocket import - now using database-only approach for progress updates
import {
  AuthType,
  ConnectorStatus,
  SyncJobStatus,
  IngestionType,
} from "@/shared/types"
import pLimit from "p-limit"
import { IngestionState } from "../ingestionState"
import { insertSyncJob } from "@/db/syncJob"
import type { Reaction } from "@slack/web-api/dist/types/response/ChannelsHistoryResponse"
import { time } from "console"
import {
  allConversationsInTotal,
  ingestedMembersErrorTotalCount,
  ingestedMembersTotalCount,
  ingestedTeamErrorTotalCount,
  ingestedTeamTotalCount,
  insertChannelMessageDuration,
  insertChannelMessagesCount,
  insertChannelMessagesErrorCount,
  insertChatMessagesCount,
  insertConversationCount,
  insertConversationDuration,
  insertConversationErrorCount,
  totalChatToBeInsertedCount,
  totalConversationsSkipped,
  totalConversationsToBeInserted,
} from "@/metrics/slack/slack-metrics"
import { start } from "repl"
import { NAMESPACE } from "@/config"
import type { FileElement } from "@slack/web-api/dist/types/response/ConversationsHistoryResponse"

const Logger = getLogger(Subsystem.Integrations).child({ module: "slack" })
const loggerWithChild = getLoggerWithChild(Subsystem.Integrations, {
  module: "slack",
})

export const getAllUsers = async (client: WebClient): Promise<Member[]> => {
  let users: Member[] = []
  let cursor: string | undefined = undefined
  do {
    const response = await client.users.list({ limit: 999, cursor })
    if (!response.ok) {
      throw new Error(`Error fetching users: ${response.error}`)
    }
    if (response.members) {
      users = users.concat(response.members)
    }
    cursor = response.response_metadata?.next_cursor
  } while (cursor)
  return users
}

/**
 * Retrieves team (workspace) metadata using the team.info API.
 */
const getTeamInfo = async (client: WebClient): Promise<Team> => {
  const response = await client.team.info()
  if (!response.ok) {
    throw new Error(`Error fetching team info: ${response.error}`)
  }
  return response.team!
}

/**
 * Fetches all conversations of types: public, private, IMs, and MPIMs.
 * except archived channels
 */
export async function getAllConversations(
  client: WebClient,
  excludeArchived: boolean,
  abortController: AbortController,
): Promise<ConversationsListResponse["channels"]> {
  let channels: Channel[] = []
  let cursor: string | undefined = undefined
  do {
    if (abortController.signal.aborted) {
      Logger.info("Aborted fetching conversations")
      break
    }
    const response = await client.conversations.list({
      types: "public_channel,private_channel,im,mpim",
      exclude_archived: excludeArchived,
      limit: 999,
      cursor,
    })
    if (!response.ok) {
      throw new Error(`Error fetching conversations: ${response.error}`)
    }
    if (response.channels) {
      channels = channels.concat(response.channels)
    }
    cursor = response.response_metadata?.next_cursor
  } while (cursor)
  return channels
}

type SlackMessage = NonNullable<
  ConversationsHistoryResponse["messages"]
>[number]

const safeConversationReplies = async (
  client: WebClient,
  channelId: string,
  threadTs: string,
  cursor: string | undefined,
  timestamp: string = "0",
): Promise<ConversationsRepliesResponse> => {
  return retryOnFatal(
    () =>
      client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 999,
        cursor,
        oldest: timestamp,
      }),
    3,
    1000,
  )
}
/**
 * Fetches all messages in a thread (given the parent message's thread_ts)
 */
export async function fetchThreadMessages(
  client: WebClient,
  channelId: string,
  threadTs: string,
  timestamp: string = "0",
): Promise<SlackMessage[]> {
  let threadMessages: SlackMessage[] = []
  let cursor: string | undefined = undefined
  do {
    const response: ConversationsRepliesResponse =
      await safeConversationReplies(
        client,
        channelId,
        threadTs,
        cursor,
        timestamp,
      )
    if (!response.ok) {
      throw new Error(
        `Error fetching thread replies for ${threadTs}: ${response.error}`,
      )
    }
    if (response.messages) {
      threadMessages.push(...(response.messages as SlackMessage[]))
    }
    cursor = response.response_metadata?.next_cursor
  } while (cursor)
  return threadMessages
}

function replaceMentionsIfPresent(message: string, memberMap: any): string {
  const regex = /<@([^>]+)>/g

  // Check if there's at least one mention
  if (!regex.test(message)) {
    return message // No mentions, return original text
  }

  // Reset regex lastIndex after test() and replace mentions
  regex.lastIndex = 0
  return message.replace(regex, (_match, userId) => {
    const user = memberMap[userId]
    return user ? `@${user.name}` : `<@${userId}>` // Replace with username or keep original
  })
}

export const safeGetTeamInfo = async (client: WebClient): Promise<Team> => {
  return retryOnFatal(() => getTeamInfo(client), 3, 1000)
}

export const safeConversationHistory = async (
  client: WebClient,
  channelId: string,
  cursor: string | undefined,
  timestamp: string = "0",
  startDate: string,
  endDate: string,
  email?: string,
): Promise<ConversationsHistoryResponse> => {
  // Convert date strings to Unix timestamps
  let oldestTs: string = timestamp // Initialize with the fallback timestamp
  let latestTs: string | undefined = undefined

  loggerWithChild({ email: email ?? "" }).info(
    `starting the slack ingestion for data rage ${startDate} -> ${endDate}`,
  )

  if (startDate) {
    try {
      const startDateObj = new Date(startDate)
      if (isNaN(startDateObj.getTime())) {
        loggerWithChild({ email: email ?? "" }).warn(
          `Invalid startDate "${startDate}" provided for channel ${channelId}. Falling back to oldest: ${timestamp}.`,
        )
      } else {
        startDateObj.setUTCHours(0, 0, 0, 0) // Set to the very beginning of the day in UTC
        oldestTs = Math.floor(startDateObj.getTime() / 1000).toString()
      }
    } catch (e) {
      loggerWithChild({ email: email ?? "" }).warn(
        `Error processing startDate "${startDate}" for channel ${channelId}. Falling back to oldest: ${timestamp}. Error: ${e}`,
      )
    }
  }

  if (endDate) {
    try {
      const endDateObj = new Date(endDate)
      if (isNaN(endDateObj.getTime())) {
        loggerWithChild({ email: email ?? "" }).warn(
          `Invalid endDate "${endDate}" provided for channel ${channelId}. Not applying 'latest' filter.`,
        )
      } else {
        endDateObj.setUTCHours(23, 59, 59, 999) // Set to the very end of the day in UTC
        latestTs = Math.floor(endDateObj.getTime() / 1000).toString()
      }
    } catch (e) {
      loggerWithChild({ email: email ?? "" }).warn(
        `Error processing endDate "${endDate}" for channel ${channelId}. Not applying 'latest' filter. Error: ${e}`,
      )
    }
  }

  return retryOnFatal(
    () =>
      client.conversations.history({
        channel: channelId,
        limit: 999,
        cursor,
        oldest: oldestTs,
        latest: latestTs,
      }),
    3,
    1000,
  )
}

// instead of parsing ourselves we are relying on slack to provide us the
// user id's
export function extractUserIdsFromBlocks(message: SlackMessage): string[] {
  if (!message.blocks) return []
  const userIds: string[] = []
  for (const block of message.blocks) {
    if (block.type === "rich_text" && block.elements) {
      for (const section of block.elements) {
        if (section.elements) {
          // Check the nested elements array
          for (const element of section.elements) {
            // @ts-ignore
            if (element.type === "user" && element.user_id) {
              // @ts-ignore
              userIds.push(element.user_id)
            }
          }
        }
      }
    }
  }
  return userIds
}
export function formatSlackSpecialMentions(
  text: string | undefined,
  channelMap: Map<string, string>,
  currentChannelId: string,
): string {
  if (!text) return ""

  let formattedText = text

  // Get current channel name
  const currentChannelName = channelMap.get(currentChannelId) || "this"

  // Replace special mentions with more descriptive text
  formattedText = formattedText.replace(/<!channel>/gi, `@channel`)

  formattedText = formattedText.replace(/<!here>/gi, `@here`)

  // Handle channel mentions with empty display name: <#C12345|>
  formattedText = formattedText.replace(
    /<#([A-Z0-9]+)\|>/g,
    (match, channelId) => {
      const channelName = channelMap.get(channelId)
      return channelName ? `#${channelName}` : `#unknown-channel`
    },
  )

  return formattedText
}

/**
 * Processes user mentions in bot messages, replacing <@userId> with appropriate names
 * Similar to formatSlackSpecialMentions but handles user mentions specifically
 */
export async function processBotMessageMentions(
  text: string | undefined,
  client: WebClient,
  memberMap: Map<string, User>,
): Promise<string> {
  if (!text) return ""

  let processedText = text
  const mentionRegex = /<@([A-Z0-9]+)>/g

  // Find all user mentions
  const mentions = text.match(mentionRegex)
  if (!mentions) return processedText

  for (const mention of mentions) {
    const userId = mention.slice(2, -1) // Remove <@ and >

    // Check if user is already in memberMap
    let user = memberMap.get(userId)

    // If not in map, fetch user info
    if (!user) {
      try {
        const userResponse = await client.users.info({ user: userId })
        if (userResponse.ok && userResponse.user) {
          user = userResponse.user as User
          memberMap.set(userId, user)
        }
      } catch (error) {
        // If fetching fails, continue with original mention
        continue
      }
    }

    if (user) {
      let replacementName: string

      // Check if this is a bot user
      if (user.is_bot) {
        // For bots, use the bot's name or real_name
        replacementName =
          user.profile?.real_name ||
          user.real_name ||
          user.name ||
          "Unknown Bot"
      } else {
        // For regular users, use display_name or name
        replacementName =
          user.profile?.display_name || user.name || "Unknown User"
      }

      // Replace the mention with @username format
      processedText = processedText.replace(mention, `@${replacementName}`)
    }
  }

  return processedText
}

/**
 * Extracts and combines all text content from bot message blocks
 */
export function extractBotMessageText(message: SlackMessage): string {
  let combinedText = ""

  // Add the main text field if it exists
  if (message.text) {
    combinedText += message.text + "\n"
  }

  // Extract text from blocks
  if (message.blocks) {
    for (const block of message.blocks) {
      if (block.type === "section" && block.text?.text) {
        combinedText += block.text.text + "\n"
      }

      if (block.type === "section" && block.fields) {
        for (const field of block.fields) {
          if (field.text) {
            combinedText += field.text + "\n"
          }
        }
      }
    }
  }

  return combinedText.trim()
}
/**
 * Fetches all messages from a channel.
 * For each message that is a thread parent, it also fetches the thread replies.
 */
export async function insertChannelMessages(
  email: string,
  client: WebClient,
  channelId: string,
  abortController: AbortController,
  memberMap: Map<string, User>,
  tracker: Tracker,
  timestamp: string = "0",
  channelMap: Map<string, string>,
  startDate: string,
  endDate: string,
  includeBotMessages: boolean = false,
  messageCounters?: {
    totalMessages: { value: number }
    processedMessages: { value: number }
  },
  checkCancellationOrPause?: () => Promise<{
    shouldStop: boolean
    isPaused: boolean
  }>,
  onLastTimestampUpdate?: (timestamp: string) => void,
): Promise<void> {
  let cursor: string | undefined = undefined
  let lastProcessedTimestamp: string = timestamp

  let replyCount = 0

  const subtypes = new Set()
  do {
    const response: ConversationsHistoryResponse =
      await safeConversationHistory(
        client,
        channelId,
        cursor,
        timestamp,
        startDate,
        endDate,
        email,
      )

    if (!response.ok) {
      throw new Error(
        `Error fetching messages for channel ${channelId}: ${response.error}`,
      )
    }

    if (response.messages) {
      totalChatToBeInsertedCount.inc(
        { conversation_id: channelId ?? "", email: email },
        response.messages?.length,
      )

      // Update total message count
      if (messageCounters) {
        const previousTotal = messageCounters.totalMessages.value
        messageCounters.totalMessages.value += response.messages.length
        loggerWithChild({ email }).info(
          `Message counter update: added ${response.messages.length} messages, total now ${messageCounters.totalMessages.value} (was ${previousTotal})`,
        )
      }

      let messageIndex = 0
      for (const message of response.messages as (SlackMessage & {
        mentions: string[]
      })[]) {
        messageIndex++
        // Processing message ${messageIndex}/${response.messages.length}
        // Check for pause/cancellation/deletion before processing each message
        // Check for pause/cancellation/deletion before processing each message
        if (checkCancellationOrPause) {
          try {
            // Check cancellation status
            const { shouldStop } = await checkCancellationOrPause()
            // Cancellation check complete
            if (shouldStop) {
              loggerWithChild({ email }).info(
                `Message processing stopped due to pause/cancellation/deletion in channel ${channelId}`,
              )
              return
            }
          } catch (error) {
            loggerWithChild({ email }).error(
              `❌ Error in checkCancellationOrPause for message ${messageIndex}: ${error}`,
            )
            throw error
          }
        }

        // replace user id with username

        // Extract mentions
        const mentions = extractUserIdsFromBlocks(message)
        // Found ${mentions.length} mentions
        let text = message.text
        if (mentions.length) {
          for (const m of mentions) {
            if (!memberMap.get(m)) {
              // Fetching user info for mention
              memberMap.set(
                m,
                (
                  await client.users.info({
                    user: m,
                  })
                ).user!,
              )
              // Successfully fetched user info
            }
            text = text?.replace(
              `<@${m}>`,
              `@${memberMap.get(m)?.profile?.display_name ?? memberMap.get(m)?.name}`,
            )
          }
        }
        loggerWithChild({ email }).info(
          `🔄 Formatting special mentions for message ${messageIndex}`,
        )
        text = formatSlackSpecialMentions(text, channelMap, channelId)
        message.text = text
        // Completed text processing
        // Add the top-level message
        // Check if message should be processed based on includeBotMessages flag
        const isRegularMessage =
          message.type === "message" &&
          !message.subtype &&
          message.user &&
          message.client_msg_id &&
          message.text != ""

        const hasTextOrBlocks =
          (message.text && message.text.trim().length > 0) ||
          (Array.isArray(message.blocks) && message.blocks.length > 0)
        const isBotMessage =
          includeBotMessages &&
          message.type === "message" &&
          message.bot_id &&
          hasTextOrBlocks

        if (isRegularMessage || isBotMessage) {
          // Insert message ${messageIndex}
          message.mentions = mentions
          message.team = await getTeam(client, message)

          // Handle both regular user messages and bot messages
          if (isBotMessage) {
            // For bot messages, generate custom ID: channelId_ts_botid
            const customBotId = `${channelId}_${message.ts}_${message.bot_id}`
            // Temporarily set identifiers for bot messages
            message.client_msg_id = message.client_msg_id || customBotId
            // Ensure a userId-like value exists for downstream writes/attachments
            message.user =
              message.user || (message.bot_profile?.id as any) || message.bot_id

            // For bot messages, extract and combine all text from blocks
            const combinedBotText = extractBotMessageText(message)

            // Process user mentions in the combined bot text
            const processedBotText = await processBotMessageMentions(
              combinedBotText,
              client,
              memberMap,
            )

            // Apply special mentions formatting
            const finalBotText = formatSlackSpecialMentions(
              processedBotText,
              channelMap,
              channelId,
            )

            message.text = finalBotText
            // For bot messages, use bot profile information
            const botName = message.bot_profile?.name || "Unknown Bot"
            const botUsername =
              message.bot_profile?.name || message.bot_id || "bot"
            const botImage =
              message.bot_profile?.icons?.image_72 ||
              message.bot_profile?.icons?.image_48 ||
              message.bot_profile?.icons?.image_36 ||
              ""

            await insertChatMessage(
              client,
              message,
              channelId,
              botName,
              botUsername,
              botImage,
            )
          } else {
            // For regular user messages, handle user info
            if (message.user && !memberMap.get(message.user)) {
              memberMap.set(
                message.user,
                (
                  await client.users.info({
                    user: message.user,
                  })
                ).user!,
              )
            }

            await insertChatMessage(
              client,
              message,
              channelId,
              memberMap.get(message.user!)?.profile?.display_name!,
              memberMap.get(message.user!)?.name!,
              memberMap.get(message.user!)?.profile?.image_192!,
            )
          }
          try {
            insertChatMessagesCount.inc({
              conversation_id: channelId,
              status: OperationStatus.Success,
              team_id: message.team,
              email: email,
            })
          } catch (error) {
            loggerWithChild({ email: email ?? "" }).error(
              error,
              `Error inserting chat message`,
            )
          }

          // Update processed message count
          if (messageCounters) {
            messageCounters.processedMessages.value += 1
            // Successfully processed message
          }

          tracker.updateUserStats(email, StatType.Slack_Message, 1)
        } else {
          // Skipping message (subtype: ${message.subtype})
          subtypes.add(message.subtype)
        }

        // Update last processed timestamp for resumption
        lastProcessedTimestamp = message.ts!
        if (onLastTimestampUpdate) {
          onLastTimestampUpdate(lastProcessedTimestamp)
        }

        // Completed processing message ${messageIndex}

        // If the message is a thread parent (its thread_ts equals its ts) and it has replies, fetch them.
        if (
          message.thread_ts &&
          message.thread_ts === message.ts &&
          message.reply_count &&
          message.reply_count > 0
        ) {
          replyCount += 1
          // this is the part that takes the longest and uses up all the rate limit quota
          // for slack api
          // for each thread that exists it will count as at least 1 api call
          // if not for this I was able to achieve 200+ messages per second ingestion
          // but with this we will have to accept ~5-10 messages per second rate.
          // there is no way around this, as long as we want to ingest replies.
          const threadMessages: SlackMessage[] = await fetchThreadMessages(
            client,
            channelId,
            message.thread_ts,
          )
          // Exclude the parent message (already added)
          const replies: (SlackMessage & { mentions?: string[] })[] =
            threadMessages.filter((msg) => msg.ts !== message.ts)

          // Add thread replies to total message count
          if (messageCounters && replies.length > 0) {
            const previousTotal = messageCounters.totalMessages.value
            messageCounters.totalMessages.value += replies.length
            loggerWithChild({ email }).info(
              `Thread replies counter update: added ${replies.length} replies, total now ${messageCounters.totalMessages.value} (was ${previousTotal})`,
            )
          }
          for (const reply of replies) {
            // Check if reply should be processed based on includeBotMessages flag
            const isRegularReply =
              reply.type === "message" &&
              !reply.subtype &&
              reply.user &&
              reply.client_msg_id &&
              reply.text != ""

            const hasTextOrBlocks =
              (reply.text && reply.text.trim().length > 0) ||
              (Array.isArray(reply.blocks) && reply.blocks.length > 0)
            const isBotReply =
              includeBotMessages &&
              reply.type === "message" &&
              reply.bot_id &&
              hasTextOrBlocks

            if (isRegularReply || isBotReply) {
              const mentions = extractUserIdsFromBlocks(reply)
              let text = reply.text
              if (mentions.length) {
                for (const m of mentions) {
                  if (!memberMap.get(m)) {
                    memberMap.set(
                      m,
                      (
                        await client.users.info({
                          user: m,
                        })
                      ).user!,
                    )
                  }
                  text = text?.replace(
                    `<@${m}>`,
                    `@${memberMap.get(m)?.profile?.display_name ?? memberMap.get(m)?.name}`,
                  )
                }
              }
              text = formatSlackSpecialMentions(text, channelMap, channelId)

              reply.mentions = mentions
              reply.text = text
              reply.team = await getTeam(client, reply)

              // Handle both regular user replies and bot replies
              if (isBotReply) {
                // For bot replies, generate custom ID: channelId_ts_botid
                const customBotId = `${channelId}_${reply.ts}_${reply.bot_id}`
                reply.client_msg_id = reply.client_msg_id || customBotId
                // Ensure a userId-like value exists for downstream writes/attachments
                reply.user =
                  reply.user || (reply.bot_profile?.id as any) || reply.bot_id

                // For bot replies, extract and combine all text from blocks
                const combinedBotText = extractBotMessageText(reply)

                // Process user mentions in the combined bot text
                const processedBotText = await processBotMessageMentions(
                  combinedBotText,
                  client,
                  memberMap,
                )

                // Apply special mentions formatting
                const finalBotText = formatSlackSpecialMentions(
                  processedBotText,
                  channelMap,
                  channelId,
                )

                reply.text = finalBotText
                // For bot replies, use bot profile information
                const botName = reply.bot_profile?.name || "Unknown Bot"
                const botUsername =
                  reply.bot_profile?.name || reply.bot_id || "bot"
                const botImage =
                  reply.bot_profile?.icons?.image_72 ||
                  reply.bot_profile?.icons?.image_48 ||
                  reply.bot_profile?.icons?.image_36 ||
                  ""

                await insertChatMessage(
                  client,
                  reply,
                  channelId,
                  botName,
                  botUsername,
                  botImage,
                )
              } else {
                // For regular user replies, handle user info
                if (reply.user && !memberMap.get(reply.user)) {
                  memberMap.set(
                    reply.user,
                    (
                      await client.users.info({
                        user: reply.user,
                      })
                    ).user!,
                  )
                }

                await insertChatMessage(
                  client,
                  reply,
                  channelId,
                  memberMap.get(reply.user!)?.profile?.display_name!,
                  memberMap.get(reply.user!)?.name!,
                  memberMap.get(reply.user!)?.profile?.image_192!,
                )
              }
              try {
                insertChatMessagesCount.inc({
                  conversation_id: channelId,
                  status: OperationStatus.Success,
                  team_id: message.team,
                  email: email,
                })
              } catch (error) {
                loggerWithChild({ email: email ?? "" }).error(
                  error,
                  `Error inserting chat message`,
                )
              }

              // Update processed message count for replies
              if (messageCounters) {
                messageCounters.processedMessages.value += 1
                loggerWithChild({ email }).info(
                  `Processed reply counter: ${messageCounters.processedMessages.value}`,
                )
              }

              tracker.updateUserStats(email, StatType.Slack_Message_Reply, 1)
            } else {
              subtypes.add(reply.subtype)
            }
          }
        }
      }
    }

    cursor = response.response_metadata?.next_cursor
  } while (cursor)
}

/**
 * Fetches all files from a channel.
 */
async function fetchChannelFiles(
  client: WebClient,
  channelId: string,
): Promise<FilesListResponse["files"]> {
  let files: FilesListResponse["files"] = []
  let cursor: string | undefined = undefined
  do {
    const response = (await client.files.list({
      channel: channelId,
      // limit: 200,
      // cursor,
    })) as FilesListResponse

    if (!response.ok) {
      throw new Error(
        `Error fetching files for channel ${channelId}: ${response.error}`,
      )
    }

    if (response.files) {
      files = files.concat(response.files)
    }
    cursor = response.response_metadata?.next_cursor
  } while (cursor)
  return files
}

const joinChannel = async (
  client: WebClient,
  channelId: string,
): Promise<void> => {
  try {
    const response = await client.conversations.join({ channel: channelId })
    if (!response.ok) {
      throw new Error(`Failed to join channel: ${response.error}`)
    }
    console.log(`Successfully joined channel: ${channelId}`)
  } catch (error) {
    console.error("Error joining channel:", error)
  }
}

export const insertConversation = async (
  conversation: Channel & { permissions: string[] },
): Promise<void> => {
  const vespaChatContainer: VespaChatContainer = {
    docId: conversation.id!,
    name: conversation.name!,
    channelName: (conversation as Channel).name!,
    app: Apps.Slack,
    entity: SlackEntity.Channel,
    creator: conversation.creator!,
    isPrivate: conversation.is_private ?? false,
    isGeneral: conversation.is_general ?? false,
    isArchived: conversation.is_archived ?? false,
    isIm: conversation.is_im ?? false,
    isMpim: conversation.is_mpim ?? false,
    createdAt: conversation.created ?? new Date().getTime(),
    updatedAt: conversation.updated ?? conversation.created!,
    lastSyncedAt: new Date().getTime(),
    topic: conversation.topic?.value ?? "",
    description: conversation.purpose?.value!,
    permissions: conversation.permissions,
    count: conversation.num_members ?? conversation.permissions.length,
  }
  await insertWithRetry(vespaChatContainer, chatContainerSchema)
}

const insertConversations = async (
  conversations: ConversationsListResponse["channels"],
  abortController: AbortController,
): Promise<void> => {
  for (const conversation of conversations || []) {
    if ((conversation as Channel).is_channel) {
      const vespaChatContainer: VespaChatContainer = {
        docId: (conversation as Channel).id!,
        name: (conversation as Channel).name!,
        channelName: (conversation as Channel).name!,
        app: Apps.Slack,
        entity: SlackEntity.Channel,
        creator: (conversation as Channel).creator!,
        isPrivate: (conversation as Channel).is_private!,
        isGeneral: (conversation as Channel).is_general!,
        isArchived: (conversation as Channel).is_archived!,
        // @ts-ignore
        isIm: (conversation as Channel).is_im!,
        isMpim: (conversation as Channel).is_mpim!,
        createdAt: (conversation as Channel).created!,
        updatedAt: (conversation as Channel).created!,
        lastSyncedAt: new Date().getTime(),
        topic: (conversation as Channel).topic?.value!,
        description: (conversation as Channel).purpose?.value!,
        permissions: [],
        count: (conversation as Channel).num_members!,
      }
      await insertWithRetry(vespaChatContainer, chatContainerSchema)
    }
  }
}

export async function getConversationUsers(
  userId: string,
  client: WebClient,
  conversation: Channel,
  email: string,
): Promise<string[]> {
  loggerWithChild({ email: email }).info("fetching users from conversation")

  if (conversation.is_im) {
    if (!conversation.user) {
      return [userId]
    }
    return [userId, conversation.user!]
  }

  let allMembers: string[] = []
  let cursor: string | undefined

  try {
    do {
      const result = await client.conversations.members({
        channel: conversation.id!,
        limit: 999,
        cursor,
      })

      if (result.ok && result.members) {
        allMembers = allMembers.concat(result.members)
        cursor = result.response_metadata?.next_cursor
      } else {
        throw new Error("Failed to fetch channel members")
      }
    } while (cursor)

    return allMembers
  } catch (error) {
    loggerWithChild({ email: email }).error(
      error,
      "Error fetching channel users:",
    )
    return []
  }
}

export const getTeam = async (
  client: WebClient,
  message: SlackMessage & { mentions?: string[] },
) => {
  if (!message.team) {
    if (message.files) {
      for (const file of message.files) {
        if (file.user_team) {
          message.team = file.user_team
          break
        }
      }
    }
  }
  if (!message.team) {
    const res = await client.users.info({ user: message.user! })
    if (res.ok) {
      message.team = res.user?.team_id
    }
  }
  return message.team
}

export const insertChatAttachment = async (
  file: FileElement,
  messageId: string,
  teamId: string,
  userId: string,
  channelId: string,
) => {
  // Extract dimensions for images
  let dimensions: number[] | undefined
  if (file.thumb_pdf_w && file.thumb_pdf_h) {
    dimensions = [parseFloat(file.thumb_pdf_w), parseFloat(file.thumb_pdf_h)]
  } else if (file.original_w && file.original_h) {
    dimensions = [parseFloat(file.original_w), parseFloat(file.original_h)]
  }

  // Get thumbnail URL (prioritize specific format thumbnails)
  let thumbnailUrl: string | undefined
  if (file.thumb_pdf) {
    thumbnailUrl = file.thumb_pdf
  } else if (file.thumb_360) {
    thumbnailUrl = file.thumb_360
  } else if (file.thumb_160) {
    thumbnailUrl = file.thumb_160
  }

  const vespaChatAttachment: VespaChatAttachment = {
    docId: file.id!,
    messageId: messageId,
    title: file.title || file.name || "",
    filename: file.name || "",
    mimeType: file.mimetype || "",
    fileType: file.filetype || "",
    size: file.size || 0,
    url: file.permalink_public,
    urlPrivate: file.url_private || "",
    urlPrivateDownload: file.url_private_download || "",
    thumbnailUrl,
    createdAt: file.timestamp
      ? file.timestamp * 1000
      : file.created
        ? file.created * 1000
        : 0, // Convert to milliseconds
    teamId: teamId,
    userId: userId,
    chatRef: `id:${NAMESPACE}:${chatContainerSchema}::${channelId}`,
    dimensions,
    duration: file.duration_ms,
    metadata: JSON.stringify({
      pretty_type: file.pretty_type,
      mode: file.mode,
      is_external: file.is_external,
      is_public: file.is_public,
      file_access: file.file_access,
      has_rich_preview: file.has_rich_preview,
    }),
    chunks: [], // Files don't have text chunks initially, could be populated later if needed
  }

  return insertWithRetry(vespaChatAttachment, chatAttachmentSchema)
}

export const insertChatMessage = async (
  client: WebClient,
  message: SlackMessage & { mentions?: string[] },
  channelId: string,
  name: string,
  username: string,
  image: string,
  channelMap?: Map<string, string>,
) => {
  const editedTimestamp = message.edited
    ? parseFloat(message?.edited?.ts!)
    : message.ts!

  // Process attachments if they exist
  const attachmentIds: string[] = []
  if (message.files && message.files.length > 0) {
    for (const file of message.files) {
      if (!file.id) {
        loggerWithChild({ email: name }).info(
          `attachment Id is missing for message ${message.client_msg_id}`,
        )
        continue
      }
      try {
        await insertChatAttachment(
          file,
          message.client_msg_id!,
          message.team!,
          message.user!,
          channelId,
        )
        attachmentIds.push(file.id!)
        // Successfully inserted attachment
      } catch (error) {
        Logger.error(`Error inserting attachment ${file.id}: ${error}`)
      }
    }
  }

  return insertWithRetry(
    {
      docId: message.client_msg_id!,
      teamId: message.team!,
      text: message.text!,
      attachmentIds: attachmentIds,
      app: Apps.Slack,
      entity: SlackEntity.Message,
      name: name || username,
      username,
      image,
      teamRef: `id:${NAMESPACE}:${chatTeamSchema}::${message.team!}`,
      chatRef: `id:${NAMESPACE}:${chatContainerSchema}::${channelId}`,
      reactions: message.reactions?.reduce((acc, curr) => {
        return acc + (curr as Reaction).count! || 0
      }, 0),
      channelId,
      userId: message.user!,
      replyCount: message.reply_count!,
      replyUsersCount: message.reply_users_count!,
      threadId: message.thread_ts!,
      createdAt: parseFloat(message.ts!),
      mentions: message.mentions || [],
      updatedAt: editedTimestamp,
      deletedAt: 0,
      metadata: "",
    } as VespaChatMessage,
    chatMessageSchema,
  )
}

export const insertTeam = async (team: Team, own: boolean) => {
  return insertWithRetry(
    {
      docId: team.id!,
      name: team.name!,
      app: Apps.Slack,
      url: team.url!,
      icon: team.icon?.image_230!,
      domain: team.domain!,
      email_domain: team.email_domain!,
      own,
      createdAt: 0,
      updatedAt: 0,
      count: 0,
    },
    chatTeamSchema,
  )
}

export const insertMember = async (member: Member) => {
  return insertWithRetry(
    {
      docId: member.id!,
      name: member.name!,
      app: Apps.Slack,
      entity: SlackEntity.User,
      email: member.profile?.email!,
      image: member.profile?.image_192!,
      teamId: member.team_id!,
      statusText: member.profile?.status_text!,
      title: member.profile?.title!,
      tz: member.tz!,
      isAdmin: member.is_admin!,
      deleted: member.deleted!,
      updatedAt: member.updated!,
    },
    chatUserSchema,
  )
}

// Main function for resumable Slack channel ingestion
// Processes specified channels with full resumability support
// Tracks progress and communicates via WebSocket for real-time updates
export const handleSlackChannelIngestion = async (
  connectorId: number,
  channelsToIngest: string[],
  startDate: string,
  endDate: string,
  email: string,
  includeBotMessages: boolean = false,
  ingestionId?: number, // Optional for resumability tracking
) => {
  let ingestionRecord: any = null
  let interval: ReturnType<typeof setInterval> | undefined
  try {
    const abortController = new AbortController()

    // Function to check if ingestion has been cancelled, paused, or deleted
    const checkCancellationOrPause = async (): Promise<{
      shouldStop: boolean
      isPaused: boolean
    }> => {
      if (!ingestionId) return { shouldStop: false, isPaused: false }
      try {
        const { getIngestionById } = await import("@/db/ingestion")
        const currentIngestion = await getIngestionById(db, ingestionId)
        if (!currentIngestion) {
          // Ingestion was deleted
          return { shouldStop: true, isPaused: false }
        }
        const isCancelled = currentIngestion?.status === "cancelled"
        const isPaused = currentIngestion?.status === "paused"
        const isFailed = currentIngestion?.status === "failed"
        const isCompleted = currentIngestion?.status === "completed"
        const shouldStop = isCancelled || isPaused || isFailed || isCompleted
        loggerWithChild({ email }).info(
          `Status check: ingestionId=${ingestionId}, status=${currentIngestion?.status}, isCancelled=${isCancelled}, isPaused=${isPaused}`,
        )
        return { shouldStop, isPaused }
      } catch (error) {
        loggerWithChild({ email }).warn(
          "Failed to check ingestion status:",
          error,
        )
        return { shouldStop: false, isPaused: false }
      }
    }
    const connector: SelectConnector = await getOAuthConnectorWithCredentials(
      db,
      connectorId,
    )

    // Import ingestion database functions for progress tracking
    const { updateIngestionStatus, updateIngestionMetadata, getIngestionById } =
      await import("@/db/ingestion")

    // Initialize resumability variables with defaults
    let resumeFromChannelIndex = 0
    let existingChannelsToIngest = channelsToIngest
    let existingStartDate = startDate
    let existingEndDate = endDate
    let existingIncludeBotMessages = includeBotMessages

    if (ingestionId) {
      // Check if this is a resume operation by examining existing state
      const existingIngestion = await getIngestionById(db, ingestionId)
      if (existingIngestion && existingIngestion.status === "pending") {
        // Extract resumability state from stored metadata
        // This is the key to resuming from exactly where we left off
        const metadata = existingIngestion.metadata as any
        if (metadata?.slack?.ingestionState) {
          const state = metadata.slack.ingestionState
          resumeFromChannelIndex = state.currentChannelIndex || 0 // Resume from this channel
          existingChannelsToIngest = state.channelsToIngest || channelsToIngest
          existingStartDate = state.startDate || startDate
          existingEndDate = state.endDate || endDate
          existingIncludeBotMessages =
            state.includeBotMessage ?? includeBotMessages

          loggerWithChild({ email }).info(
            `Resuming Slack channel ingestion from channel index ${resumeFromChannelIndex} of ${existingChannelsToIngest.length}`,
          )
        }
      }

      // Update database status to indicate active processing
      ingestionRecord = await updateIngestionStatus(
        db,
        ingestionId,
        "in_progress",
      )
      loggerWithChild({ email }).info(
        `Started Slack channel ingestion with ID: ${ingestionId}`,
      )
    }

    const { accessToken } = connector.oauthCredentials as {
      accessToken: string
    }
    const client = new WebClient(accessToken, {
      retryConfig: retryPolicies.rapidRetryPolicy,
    })
    const tracker = new Tracker(Apps.Slack, AuthType.OAuth)
    const team = await safeGetTeamInfo(client)
    const channelMap = new Map<string, string>()

    let processedChannels = resumeFromChannelIndex
    let globalLastMessageTimestamp = "0" // Track last processed message timestamp globally

    // Restore last message timestamp if resuming
    if (
      ingestionRecord?.metadata?.slack?.ingestionState?.lastMessageTimestamp
    ) {
      globalLastMessageTimestamp =
        ingestionRecord.metadata.slack.ingestionState.lastMessageTimestamp
      loggerWithChild({ email }).info(
        `📍 Restored global last message timestamp: ${globalLastMessageTimestamp}`,
      )
    }

    // Initialize message counters - restore from saved metadata if resuming
    let savedMessageCounters = { totalMessages: 0, processedMessages: 0 }
    if (ingestionRecord?.metadata?.slack?.websocketData?.progress) {
      savedMessageCounters = {
        totalMessages:
          ingestionRecord.metadata.slack.websocketData.progress.totalMessages ||
          0,
        processedMessages:
          ingestionRecord.metadata.slack.websocketData.progress
            .processedMessages || 0,
      }
      loggerWithChild({ email }).info(
        `📊 Resuming with saved counters: total=${savedMessageCounters.totalMessages}, processed=${savedMessageCounters.processedMessages}`,
      )
    } else {
      loggerWithChild({ email }).info(
        `📊 Starting fresh counters: total=0, processed=0`,
      )
    }

    const messageCounters = {
      totalMessages: { value: savedMessageCounters.totalMessages },
      processedMessages: { value: savedMessageCounters.processedMessages },
    }

    // Set up periodic progress updates every 4 seconds
    // This ensures real-time frontend updates and persistent resumability state
    interval = setInterval(async () => {
      loggerWithChild({ email }).info(
        `Periodic check running for ingestion ${ingestionId}`,
      )
      loggerWithChild({ email }).info(
        `Message counters: total=${messageCounters.totalMessages.value}, processed=${messageCounters.processedMessages.value}`,
      )
      // Check for cancellation/pause and abort if requested
      const { shouldStop, isPaused } = await checkCancellationOrPause()
      if (shouldStop) {
        if (isPaused) {
          loggerWithChild({ email }).info(
            `Ingestion ${ingestionId} was paused, stopping process`,
          )
        } else {
          // Get the actual status to log the correct message
          if (ingestionId !== undefined) {
            const { getIngestionById } = await import("@/db/ingestion")
            const currentIngestion = await getIngestionById(db, ingestionId)
            const status = currentIngestion?.status || "unknown"
            loggerWithChild({ email }).info(
              `Ingestion ${ingestionId} was ${status}, stopping process`,
            )
          } else {
            loggerWithChild({ email }).info(
              `Ingestion was cancelled/stopped, stopping process`,
            )
          }
        }
        abortController.abort()
        clearInterval(interval)
        return
      }
      const progressData = {
        IngestionType: IngestionType.partialIngestion,
        progress: tracker.getProgress(),
        userStats: tracker.getOAuthProgress().userStats,
        startTime: tracker.getStartTime(),
        // Enhanced progress information for resumable ingestion UI
        channelProgress: {
          totalChannels: existingChannelsToIngest.length,
          processedChannels,
          currentChannel:
            channelMap.get(existingChannelsToIngest[processedChannels]) || "",
          totalMessages: messageCounters.totalMessages.value,
          processedMessages: messageCounters.processedMessages.value,
        },
        ingestionId,
      }

      // Progress updates now handled via database polling - no WebSocket needed
      // Frontend will get this data when it polls /api/ingestion/status
      // sendWebsocketMessage call removed - using database-only approach

      // Persist current state to database for resumability
      // Critical: this allows resuming from exact same point if interrupted
      if (ingestionId && ingestionRecord) {
        try {
          await updateIngestionMetadata(db, ingestionId, {
            slack: {
              // Data sent to frontend for progress display
              websocketData: {
                connectorId: connector.externalId,
                progress: progressData.channelProgress,
              },
              // Internal state data for resuming interrupted ingestions
              ingestionState: {
                currentChannelId: existingChannelsToIngest[processedChannels],
                channelsToIngest: existingChannelsToIngest,
                startDate: existingStartDate,
                endDate: existingEndDate,
                includeBotMessage: existingIncludeBotMessages,
                currentChannelIndex: processedChannels, // Key for resumability
                lastMessageTimestamp: globalLastMessageTimestamp, // Key for message-level resumability
                lastUpdated: new Date().toISOString(),
              },
            },
          })
        } catch (metadataError) {
          loggerWithChild({ email }).warn(
            "Failed to update ingestion metadata:",
            metadataError,
          )
        }
      }
    }, 4000) // Update every 4 seconds for good UX without overwhelming the system

    const conversations: Channel[] = []
    for (const channel in existingChannelsToIngest) {
      const channelId = existingChannelsToIngest[channel] // Get the channel ID string using the index from the for...in loop
      try {
        const response = await client.conversations.info({ channel: channelId })
        if (response.ok && response.channel) {
          conversations.push(response.channel as Channel)
        } else {
          loggerWithChild({ email: email }).warn(
            `Failed to retrieve information for channel ${channelId}: ${response.error}`,
          )
        }
      } catch (error) {
        loggerWithChild({ email: email }).error(
          `Exception while fetching info for channel ${channelId}:`,
          error,
        )
      }
    }
    allConversationsInTotal.inc(
      {
        team_id: team.id ?? team.name ?? "",
        email: email,
        status: OperationStatus.Success,
      },
      conversations.length,
    )
    for (const conv of conversations) {
      if (conv.id && conv.name) channelMap.set(conv.id!, conv.name!)
    }
    // only insert conversations that are not yet inserted already
    const existenceMap = await ifDocumentsExistInSchema(
      chatContainerSchema,
      conversations.map((c) => c.id!),
    )
    const conversationsToInsert = conversations.filter(
      (conversation) =>
        (existenceMap[conversation.id!] &&
          !existenceMap[conversation.id!].exists) ||
        !existenceMap[conversation.id!],
    )

    // Fix: Build conversationsToProcess from original ordering to prevent skipping channels
    // resumeFromChannelIndex refers to position in existingChannelsToIngest, not conversationsToInsert
    const channelsToResume = existingChannelsToIngest.slice(
      resumeFromChannelIndex,
    )
    const conversationsToProcess = channelsToResume
      .map((channelId) =>
        conversationsToInsert.find((conv) => conv.id === channelId),
      )
      .filter(Boolean) as typeof conversationsToInsert

    loggerWithChild({ email }).info(
      `Processing ${conversationsToProcess.length} channels (skipping ${resumeFromChannelIndex} already processed)`,
    )

    loggerWithChild({ email: email }).info(
      `conversations to insert ${conversationsToProcess.length} (skipping ${resumeFromChannelIndex} already processed) and skipping ${conversations.length - conversationsToInsert.length} existing`,
    )
    // Fix: Correct skip count calculation - don't double-count resume offset
    // conversations.length - conversationsToInsert.length = already ingested
    // resumeFromChannelIndex = channels processed in previous runs
    totalConversationsSkipped.inc(
      { team_id: team.id ?? team.name ?? "", email: email },
      conversations.length -
        conversationsToInsert.length +
        resumeFromChannelIndex,
    )
    const user = await getAuthenticatedUserId(client)
    const teamMap = new Map<string, Team>()
    teamMap.set(team.id!, team)
    const memberMap = new Map<string, User>()
    tracker.setCurrent(resumeFromChannelIndex)
    tracker.setTotal(conversationsToInsert.length)
    let conversationIndex = resumeFromChannelIndex
    totalConversationsToBeInserted.inc(
      { team_id: team.id ?? team.name ?? "", email: email },
      conversationsToInsert.length,
    )
    // can be done concurrently, but can cause issues with ratelimits
    for (const conversation of conversationsToProcess) {
      // Update conversationIndex to match position in existingChannelsToIngest
      conversationIndex = existingChannelsToIngest.indexOf(conversation.id!)
      loggerWithChild({ email }).info(
        `Processing channel ${conversationIndex + 1}/${existingChannelsToIngest.length}: ${conversation.name}`,
      )

      // Check for cancellation/pause before processing each conversation
      if (abortController.signal.aborted) {
        loggerWithChild({ email }).info(
          `Conversation processing aborted for ingestion ${ingestionId}`,
        )
        return
      }

      // Update processedChannels for progress tracking
      processedChannels = conversationIndex
      loggerWithChild({ email }).info(
        `Updated processedChannels to ${processedChannels} for conversation ${conversation.name}`,
      )

      loggerWithChild({ email }).info(
        `Starting member fetching for conversation ${conversation.name}`,
      )
      const memberIds = await getConversationUsers(
        user,
        client,
        conversation,
        email,
      )
      loggerWithChild({ email }).info(
        `Found ${memberIds.length} member IDs for conversation ${conversation.name}`,
      )

      const membersToFetch = memberIds.filter((m: string) => !memberMap.get(m))
      loggerWithChild({ email }).info(
        `Need to fetch ${membersToFetch.length} new members for ${conversation.name}`,
      )

      const concurrencyLimit = pLimit(5)
      const memberPromises = membersToFetch.map((memberId: string) =>
        concurrencyLimit(async () => {
          // Check abort signal before each individual API call
          if (abortController.signal.aborted) {
            loggerWithChild({ email }).info(
              `Aborting member fetch due to cancellation`,
            )
            return null // Return null to signal abort without error
          }
          return client.users.info({ user: memberId })
        }),
      )

      loggerWithChild({ email }).info(
        `Starting member fetch for ${memberPromises.length} members`,
      )

      // Check for abort before starting member fetching
      if (abortController.signal.aborted) {
        loggerWithChild({ email }).info(
          `Member fetching aborted for ingestion ${ingestionId}`,
        )
        return
      }

      // Use Promise.allSettled to handle individual promise failures due to abort
      const memberResults = await Promise.allSettled(memberPromises)
      const members: User[] = memberResults
        .filter(
          (result): result is PromiseFulfilledResult<any> =>
            result.status === "fulfilled",
        )
        .map((result) => {
          // Handle null values from aborted calls
          if (result.value?.user && result.value) {
            memberMap.set(result.value.user.id!, result.value.user)
            return result.value.user as User
          }
          return undefined
        })
        .filter((user) => !!user)

      // Check if we were aborted during member fetching
      if (abortController.signal.aborted) {
        loggerWithChild({ email }).info(
          `Member fetching aborted during processing for ingestion ${ingestionId}`,
        )
        return
      }
      loggerWithChild({ email }).info(
        `👥 [CHANNEL ${conversationIndex + 1}] Completed member fetching, got ${members.length} valid members for ${conversation.name} (ID: ${conversation.id})`,
      )

      // Check for abort after member fetching completes
      if (abortController.signal.aborted) {
        loggerWithChild({ email }).info(
          `Aborting after member fetching completed for ingestion ${ingestionId}`,
        )
        return
      }
      let memberIndex = 0
      for (const member of members) {
        memberIndex++
        // Check for abort during member processing
        if (abortController.signal.aborted) {
          loggerWithChild({ email }).info(
            `Member processing aborted for ingestion ${ingestionId}`,
          )
          return
        }

        // team first time encountering
        if (!teamMap.get(member.team_id!)) {
          const teamResp: TeamInfoResponse = await client.team.info({
            team: member.team_id!,
          })
          teamMap.set(teamResp.team?.id!, teamResp.team!)
          try {
            await insertTeam(teamResp.team!, false)
            ingestedTeamTotalCount.inc({
              email_domain: teamResp.team!.email_domain,
              enterprise_id: teamResp.team!.enterprise_id,
              domain: teamResp.team!.domain,
              status: OperationStatus.Success,
            })
          } catch (error) {
            loggerWithChild({ email: email ?? "" }).error(
              error,
              `Error inserting team`,
            )
            ingestedTeamErrorTotalCount.inc({
              email_domain: teamResp.team!.email_domain,
              enterprise_id: teamResp.team!.enterprise_id,
              domain: teamResp.team!.domain,
              status: OperationStatus.Failure,
              email: email,
            })
          }
        }
        try {
          await insertMember(member)
          ingestedMembersTotalCount.inc({
            team_id: team.id,
            status: OperationStatus.Success,
          })
        } catch (error) {
          loggerWithChild({ email: email }).error(
            `Error inserting member ${member.id}: ${error}`,
          )
          ingestedMembersErrorTotalCount.inc({
            team_id: team.id,
            status: OperationStatus.Failure,
          })
        }
      }

      let permissions: string[] = memberIds
        .map((m: string) => {
          const user: User | undefined = memberMap.get(m)
          return user?.profile?.email
        })
        .filter((email): email is string => !!email)
      // this case shouldn't even be there
      if (!permissions.length || permissions.indexOf(email) == -1) {
        permissions = permissions.concat(email)
      }
      const conversationWithPermission: Channel & { permissions: string[] } = {
        ...conversation,
        permissions,
      }

      const channelMessageInsertionDuration =
        insertChannelMessageDuration.startTimer({
          conversation_id: conversation.id,
          team_id: team.id,
          status: OperationStatus.Success,
        })
      try {
        // Get last processed message timestamp for resumption
        let resumeTimestamp = "0" // Default to start from beginning
        if (
          ingestionRecord?.metadata?.slack?.ingestionState
            ?.lastMessageTimestamp &&
          conversationIndex === resumeFromChannelIndex
        ) {
          resumeTimestamp =
            ingestionRecord.metadata.slack.ingestionState.lastMessageTimestamp
          loggerWithChild({ email }).info(
            `📍 Resuming channel ${conversation.name} from timestamp: ${resumeTimestamp}`,
          )
        } else {
          loggerWithChild({ email }).info(
            `📍 Starting channel ${conversation.name} from beginning (timestamp: 0)`,
          )
        }

        // Track the last processed message timestamp for resumption
        let currentLastTimestamp = resumeTimestamp

        loggerWithChild({ email }).info(
          `📨 [CHANNEL ${conversationIndex + 1}] About to call insertChannelMessages for conversation ${conversation.name} (ID: ${conversation.id})`,
        )
        loggerWithChild({ email }).info(
          `📊 [CHANNEL ${conversationIndex + 1}] Current message counters before processing: total=${messageCounters.totalMessages.value}, processed=${messageCounters.processedMessages.value}`,
        )
        await insertChannelMessages(
          email,
          client,
          conversation.id!,
          abortController,
          memberMap,
          tracker,
          resumeTimestamp,
          channelMap,
          existingStartDate,
          existingEndDate,
          existingIncludeBotMessages,
          messageCounters,
          checkCancellationOrPause,
          (timestamp: string) => {
            // Update the last processed timestamp for this channel
            currentLastTimestamp = timestamp
            globalLastMessageTimestamp = timestamp // Update global variable for metadata storage
            loggerWithChild({ email }).info(
              `📍 [CHANNEL ${conversationIndex + 1}] Updated last processed timestamp: ${timestamp} for ${conversation.name}`,
            )
          },
        )
        loggerWithChild({ email }).info(
          `✅ [CHANNEL ${conversationIndex + 1}] Completed insertChannelMessages for conversation ${conversation.name} (ID: ${conversation.id})`,
        )
        loggerWithChild({ email }).info(
          `📊 [CHANNEL ${conversationIndex + 1}] Message counters after processing ${conversation.name}: total=${messageCounters.totalMessages.value}, processed=${messageCounters.processedMessages.value}`,
        )
        channelMessageInsertionDuration()
        insertChannelMessagesCount.inc({
          conversation_id: conversation.id ?? "",
          team_id: team.id ?? "",
          status: OperationStatus.Success,
          email: email,
        })
        tracker.updateUserStats(email, StatType.Slack_Conversation, 1)
      } catch (error) {
        loggerWithChild({ email: email }).error(
          `Error inserting Channel Messages for ${conversation.name}: ${error}`,
        )
        insertChannelMessagesErrorCount.inc({
          conversation_id: conversation.id ?? "",
          team_id: team.id ?? "",
          status: OperationStatus.Failure,
          email: email,
        })
      }
      try {
        const conversationInsertionDuration =
          insertConversationDuration.startTimer({
            conversation_id: conversation.id,
            team_id: team.id,
            status: OperationStatus.Success,
          })
        await insertConversation(conversationWithPermission)
        conversationInsertionDuration()
        insertConversationCount.inc({
          conversation_id: conversationWithPermission.id ?? "",
          team_id: conversationWithPermission.context_team_id ?? "",
          status: OperationStatus.Success,
          email: email,
        })
        tracker.setCurrent(conversationIndex)
        loggerWithChild({ email }).info(
          `Completed processing conversation ${conversation.name} (${conversationIndex + 1}/${existingChannelsToIngest.length})`,
        )
      } catch (error) {
        loggerWithChild({ email: email }).error(`Error inserting Conversation`)
        insertConversationErrorCount.inc({
          conversation_id: conversationWithPermission.id ?? "",
          team_id: conversationWithPermission.context_team_id ?? "",
          status: OperationStatus.Failure,
          email: email,
        })
      }
    }

    loggerWithChild({ email }).info(
      `Successfully processed all ${conversationsToInsert.length} channels. Total messages: ${messageCounters.totalMessages.value}, Processed: ${messageCounters.processedMessages.value}`,
    )

    // Check if ingestion was actually completed or just paused/cancelled
    const finalStatus = await checkCancellationOrPause()
    loggerWithChild({ email }).info(
      `🔍 Final status check: shouldStop=${finalStatus.shouldStop}, isPaused=${finalStatus.isPaused}`,
    )

    if (finalStatus.shouldStop && finalStatus.isPaused) {
      loggerWithChild({ email }).info(
        `⏸️ Ingestion was paused - keeping status as 'paused', not completing`,
      )
      return // Exit without marking as completed
    }

    if (finalStatus.shouldStop && !finalStatus.isPaused) {
      loggerWithChild({ email }).info(
        `❌ Ingestion was cancelled - keeping status as 'cancelled', not completing`,
      )
      return // Exit without marking as completed
    }

    // Update connector status only for actual completion
    db.transaction(async (trx) => {
      await trx
        .update(connectors)
        .set({
          status: ConnectorStatus.Connected,
          state: JSON.stringify({}),
        })
        .where(eq(connectors.id, connector.id))
    })

    // Mark ingestion as successfully completed (only if not paused/cancelled)
    loggerWithChild({ email }).info(
      `🎯 Reached completion section! About to mark ingestion ${ingestionId} as completed`,
    )
    if (ingestionId) {
      try {
        // Update database status to completed
        loggerWithChild({ email }).info(
          `🔄 Calling updateIngestionStatus with ingestionId=${ingestionId}, status=completed`,
        )
        await updateIngestionStatus(db, ingestionId, "completed")

        // Update metadata with final message counters for frontend display
        const finalProgressData = {
          totalChannels: channelsToIngest.length,
          processedChannels: channelsToIngest.length, // All channels completed
          currentChannel: "", // Completed
          totalMessages: messageCounters.totalMessages.value,
          processedMessages: messageCounters.processedMessages.value,
        }

        loggerWithChild({ email }).info(
          `📊 Updating final metadata: total=${finalProgressData.totalMessages}, processed=${finalProgressData.processedMessages}`,
        )
        await updateIngestionMetadata(db, ingestionId, {
          slack: {
            websocketData: {
              connectorId: connector.externalId,
              progress: finalProgressData,
            },
            ingestionState: {
              channelsToIngest: existingChannelsToIngest,
              currentChannelIndex: existingChannelsToIngest.length, // Completed all
              currentChannelId: null, // No current channel
              startDate: existingStartDate,
              endDate: existingEndDate,
              includeBotMessage: existingIncludeBotMessages,
              lastUpdated: new Date().toISOString(),
            },
          },
        })

        loggerWithChild({ email }).info(
          `✅ SUCCESS: Completed Slack channel ingestion with ID: ${ingestionId}`,
        )

        // Completion notification now handled via database status
        // Frontend will detect completion via polling /api/ingestion/status
        loggerWithChild({ email }).info(
          `🚀 Slack channel ingestion completed - status updated in database for polling detection`,
        )
      } catch (completionError) {
        loggerWithChild({ email }).error(
          "Failed to mark ingestion as completed:",
          completionError,
        )
      }
    }
  } catch (error) {
    loggerWithChild({ email: email }).error(error)

    // Handle ingestion failure by updating database and notifying frontend
    if (ingestionId) {
      try {
        const { updateIngestionStatus, getIngestionById } = await import(
          "@/db/ingestion"
        )

        // Check current status before overwriting - preserve cancellation/pause states
        const currentIngestion = await getIngestionById(db, ingestionId)
        const currentStatus = currentIngestion?.status

        // Only mark as failed if not already cancelled, paused, or completed
        if (
          currentStatus &&
          !["cancelled", "paused", "completed"].includes(currentStatus)
        ) {
          await updateIngestionStatus(
            db,
            ingestionId,
            "failed",
            (error as Error).message,
          )
          loggerWithChild({ email }).error(
            `Failed Slack channel ingestion with ID: ${ingestionId}`,
          )

          // Failure notification now handled via database status
          // Frontend will detect failure via polling /api/ingestion/status
          loggerWithChild({ email }).error(
            `Slack channel ingestion failed - status updated in database for polling detection`,
          )
        } else {
          loggerWithChild({ email }).info(
            `Ingestion ${ingestionId} error occurred but preserving existing status: ${currentStatus}`,
          )
        }
      } catch (failureError) {
        loggerWithChild({ email }).error(
          "Failed to mark ingestion as failed:",
          failureError,
        )
      }
    }
  } finally {
    // Always clear the interval regardless of how the function exits
    if (interval) {
      clearInterval(interval)
      loggerWithChild({ email }).info(
        `Cleared periodic progress interval for ingestion ${ingestionId}`,
      )
    }
  }
}

/**
 * Determines if an error is considered fatal.
 * Modify this logic to distinguish between retryable fatal errors and those
 * that should immediately bubble up.
 *
 * @param error The error thrown by a Slack API call.
 * @returns True if the error is fatal, false otherwise.
 */
function isFatalError(error: any): boolean {
  // For example, if your error has a code or property indicating it’s fatal,
  // you can check for that. Here, we assume every error is fatal.
  // Modify this as needed.
  return true
}

/**
 * Retries a given async function if a fatal error occurs.
 * The function will be attempted up to maxAttempts times.
 * If the error is not considered fatal, it will immediately throw.
 *
 * @param fn The async function to retry.
 * @param maxAttempts Maximum number of attempts.
 * @param delayMs Optional delay between attempts in milliseconds.
 * @returns The result of the async function.
 * @throws The last fatal error encountered if all attempts fail.
 */
async function retryOnFatal<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  delayMs = 0,
): Promise<T> {
  let lastError: any
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (isFatalError(error)) {
        lastError = error
        console.error(
          `Fatal error on attempt ${attempt}: ${(error as Error).message}. Retrying...`,
        )
        if (attempt < maxAttempts && delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      } else {
        // If error is not fatal, rethrow immediately.
        throw error
      }
    }
  }
  throw lastError
}

async function getAuthenticatedUserId(client: WebClient): Promise<string> {
  const authResponse = await client.auth.test()
  if (!authResponse.ok || !authResponse.user_id) {
    throw new Error(
      `Failed to fetch authenticated user ID: ${authResponse.error}`,
    )
  }
  return authResponse.user_id
}
