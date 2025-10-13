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
import { sendWebsocketMessage } from "../metricStream"
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
): Promise<void> {
  let cursor: string | undefined = undefined

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
      for (const message of response.messages as (SlackMessage & {
        mentions: string[]
      })[]) {
        // replace user id with username

        const mentions = extractUserIdsFromBlocks(message)
        let text = message.text
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
        message.text = text
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
          tracker.updateUserStats(email, StatType.Slack_Message, 1)
        } else {
          subtypes.add(message.subtype)
        }

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
        Logger.info(
          `Inserted attachment ${file.id} for message ${message.client_msg_id}`,
        )
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

export const handleSlackChannelIngestion = async (
  connectorId: number,
  channelsToIngest: string[],
  startDate: string,
  endDate: string,
  email: string,
  includeBotMessages: boolean = false,
) => {
  try {
    const abortController = new AbortController()
    const connector: SelectConnector = await getOAuthConnectorWithCredentials(
      db,
      connectorId,
    )

    const { accessToken } = connector.oauthCredentials as {
      accessToken: string
    }
    const client = new WebClient(accessToken, {
      retryConfig: retryPolicies.rapidRetryPolicy,
    })
    const tracker = new Tracker(Apps.Slack, AuthType.OAuth)
    const team = await safeGetTeamInfo(client)
    const channelMap = new Map<string, string>()
    const interval = setInterval(() => {
      sendWebsocketMessage(
        JSON.stringify({
          IngestionType: IngestionType.partialIngestion,
          progress: tracker.getProgress(),
          userStats: tracker.getOAuthProgress().userStats,
          startTime: tracker.getStartTime(),
        }),
        connector?.externalId,
      )
    }, 4000)

    const conversations: Channel[] = []
    for (const channel in channelsToIngest) {
      const channelId = channelsToIngest[channel] // Get the channel ID string using the index from the for...in loop
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
    const conversationsToInsert = conversations
    // .filter(
    //   (conversation) =>
    //     (existenceMap[conversation.id!] &&
    //       !existenceMap[conversation.id!].exists) ||
    //     !existenceMap[conversation.id!],
    // )
    loggerWithChild({ email: email }).info(
      `conversations to insert ${conversationsToInsert.length} and skipping ${conversations.length - conversationsToInsert.length}`,
    )
    totalConversationsSkipped.inc(
      { team_id: team.id ?? team.name ?? "", email: email },
      conversations.length - conversationsToInsert.length,
    )
    const user = await getAuthenticatedUserId(client)
    const teamMap = new Map<string, Team>()
    teamMap.set(team.id!, team)
    const memberMap = new Map<string, User>()
    tracker.setCurrent(0)
    tracker.setTotal(conversationsToInsert.length)
    let conversationIndex = 0
    totalConversationsToBeInserted.inc(
      { team_id: team.id ?? team.name ?? "", email: email },
      conversationsToInsert.length,
    )
    // can be done concurrently, but can cause issues with ratelimits
    for (const conversation of conversationsToInsert) {
      const memberIds = await getConversationUsers(
        user,
        client,
        conversation,
        email,
      )
      const membersToFetch = memberIds.filter((m: string) => !memberMap.get(m))
      const concurrencyLimit = pLimit(5)
      const memberPromises = membersToFetch.map((memberId: string) =>
        concurrencyLimit(() => client.users.info({ user: memberId })),
      )
      const members: User[] = (await Promise.all(memberPromises))
        .map((userResp) => {
          if (userResp.user) {
            memberMap.set(userResp.user.id!, userResp.user)
            return userResp.user as User
          }
        })
        .filter((user) => !!user)
      // check if already exists
      for (const member of members) {
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
              `Error inserting member`,
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
        await insertChannelMessages(
          email,
          client,
          conversation.id!,
          abortController,
          memberMap,
          tracker,
          "0",
          channelMap,
          startDate,
          endDate,
          includeBotMessages,
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
          "Error inserting Channel Messages",
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
        conversationIndex++
        tracker.setCurrent(conversationIndex)
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
    setTimeout(() => {
      clearInterval(interval)
    }, 8000)

    db.transaction(async (trx) => {
      await trx
        .update(connectors)
        .set({
          status: ConnectorStatus.Connected,
          state: JSON.stringify({}),
        })
        .where(eq(connectors.id, connector.id))
    })
  } catch (error) {
    loggerWithChild({ email: email }).error(error)
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
