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
import config, { NAMESPACE } from "@/config"
import { periodicSaveState } from "./config"
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
  email: string,
): Promise<ConversationsListResponse["channels"]> {
  let channels: Channel[] = []
  let cursor: string | undefined = undefined
  do {
    if (abortController.signal.aborted) {
      loggerWithChild({ email: email }).info("Aborted fetching conversations")
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
  latestTs: string = (Date.now() / 1000).toString(),
): Promise<ConversationsHistoryResponse> => {
  return retryOnFatal(
    () =>
      client.conversations.history({
        channel: channelId,
        limit: 999,
        cursor,
        oldest: timestamp,
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
  ingestionState?: IngestionState<SlackOAuthIngestionState>,
  latestTs: string = (Date.now() / 1000).toString(),
): Promise<void> {
  let cursor: string | undefined = undefined

  let messageCount = 0
  const subtypes = new Set()

  do {
    // Check for abort signal
    if (abortController.signal.aborted) {
      loggerWithChild({ email }).info(
        `Aborted message insertion for channel ${channelId}`,
      )
      break
    }

    const response: ConversationsHistoryResponse =
      await safeConversationHistory(
        client,
        channelId,
        cursor,
        timestamp,
        latestTs,
      )

    if (!response.ok) {
      throw new Error(
        `Error fetching messages for channel ${channelId}: ${response.error}`,
      )
    }

    if (response.messages && response.messages.length > 0) {
      totalChatToBeInsertedCount.inc(
        { conversation_id: channelId ?? "", email: email },
        response.messages.length,
      )

      // Process messages (keep the most recent first for proper state tracking)
      const messages = response.messages as (SlackMessage & {
        mentions: string[]
      })[]

      for (const message of messages) {
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
        if (
          message.type === "message" &&
          !message.subtype &&
          message.user &&
          message.client_msg_id &&
          message.text != ""
          // memberMap[message.user]
        ) {
          // a deleted user's message could be there
          if (!memberMap.get(message.user)) {
            memberMap.set(
              message.user,
              (
                await client.users.info({
                  user: message.user,
                })
              ).user!,
            )
          }
          message.mentions = mentions
          message.team = await getTeam(client, message)

          // case to avoid bot messages
          await insertChatMessage(
            client,
            message,
            channelId,
            memberMap.get(message.user!)?.profile?.display_name!,
            memberMap.get(message.user!)?.name!,
            memberMap.get(message.user!)?.profile?.image_192!,
          )
          try {
            insertChatMessagesCount.inc({
              conversation_id: channelId,
              status: OperationStatus.Success,
              team_id: message.team ?? "No Name Found",
              email: email,
            })
          } catch (error) {
            loggerWithChild({ email: email }).error(
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
          const threadMessages: SlackMessage[] = await fetchThreadMessages(
            client,
            channelId,
            message.thread_ts,
          )
          const replies: (SlackMessage & { mentions?: string[] })[] =
            threadMessages.filter((msg) => msg.ts !== message.ts)
          for (const reply of replies) {
            if (
              reply.type === "message" &&
              !reply.subtype &&
              reply.user &&
              reply.client_msg_id &&
              reply.text != ""
            ) {
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
              if (!memberMap.get(reply.user)) {
                memberMap.set(
                  reply.user,
                  (
                    await client.users.info({
                      user: reply.user,
                    })
                  ).user!,
                )
              }
              reply.mentions = mentions
              reply.text = text

              reply.team = await getTeam(client, reply)

              await insertChatMessage(
                client,
                reply,
                channelId,
                memberMap.get(reply.user!)?.profile?.display_name!,
                memberMap.get(reply.user!)?.name!,
                memberMap.get(reply.user!)?.profile?.image_192!,
              )
              try {
                insertChatMessagesCount.inc({
                  conversation_id: channelId,
                  status: OperationStatus.Success,
                  team_id: message.team ?? "No Name Found",
                  email: email,
                })
              } catch (error) {
                loggerWithChild({ email: email }).error(
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

        messageCount++

        // Update state with latest message timestamp every 10 messages
        if (ingestionState && messageCount % 10 === 0) {
          await ingestionState.update({
            currentChannelId: channelId,
            lastMessageTs: message.ts,
          })
        }
      }
    }

    cursor = response.response_metadata?.next_cursor
  } while (cursor)

  loggerWithChild({ email }).info(
    `Processed ${messageCount} messages for channel ${channelId}`,
  )
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
        loggerWithChild({ email: name }).info(
          `Inserted attachment ${file.id} for message ${message.client_msg_id}`,
        )
      } catch (error) {
        loggerWithChild({ email: name }).error(
          `Error inserting attachment ${file.id}: ${error}`,
        )
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

export const handleSlackIngestion = async (data: SaaSOAuthJob) => {
  let ingestionState: IngestionState<SlackOAuthIngestionState> | undefined
  let ingestionOldState: IngestionState<SlackOAuthIngestionState> | undefined
  try {
    const abortController = new AbortController()
    const connector: SelectConnector = await getOAuthConnectorWithCredentials(
      db,
      data.connectorId,
    )
    // change the status of connector to connecting
    // before update the status is authenticated
    try {
      await db
        .update(connectors)
        .set({
          status: ConnectorStatus.Connecting,
        })
        .where(eq(connectors.id, data.connectorId))
    } catch (error) {
      loggerWithChild({ email: data.email }).error(
        error,
        `Failed to update connector status to Connecting`,
      )
      throw error
    }
    // Initialize ingestion state
    const initialState: SlackOAuthIngestionState = {
      app: Apps.Slack,
      authType: AuthType.OAuth,
      currentChannelId: undefined,
      lastMessageTs: undefined,
      lastUpdated: new Date().toISOString(),
    }
    ingestionState = new IngestionState(
      connector.id,
      connector.workspaceId,
      connector.userId,
      db,
      initialState,
    )
    ingestionOldState = new IngestionState(
      connector.id,
      connector.workspaceId,
      connector.userId,
      db,
      initialState,
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

    // Load existing state if it exists and isn't empty
    const connectorState = connector.state as Record<string, any>
    const isFreshSync =
      !connectorState || Object.keys(connectorState).length === 0

    if (!isFreshSync) {
      await ingestionState.load()
      await ingestionOldState.load()
      Logger.info(
        `Resuming ingestion from existing state for connector ${connector.id}`,
      )
    } else {
      Logger.info(`Starting fresh ingestion for connector ${connector.id}`)
    }

    const interval = setInterval(() => {
      sendWebsocketMessage(
        JSON.stringify({
          IngestionType: IngestionType.fullIngestion,
          progress: tracker.getProgress(),
          userStats: tracker.getOAuthProgress().userStats,
          startTime: tracker.getStartTime(),
        }),
        connector?.externalId,
      )
    }, 4000)

    try {
      await insertTeam(team, true)
      ingestedTeamTotalCount.inc({
        email_domain: team.email_domain,
        enterprise_id: team.enterprise_id,
        domain: team.domain,
        status: OperationStatus.Success,
      })
    } catch (error) {
      loggerWithChild({ email: data.email }).info(`Error inserting team`)
      ingestedTeamErrorTotalCount.inc({
        email_domain: team.email_domain,
        enterprise_id: team.enterprise_id,
        domain: team.domain,
        status: OperationStatus.Failure,
        email: data.email,
      })
    }

    const conversations = (
      (await getAllConversations(
        client,
        true,
        new AbortController(),
        data.email,
      )) || []
    ).filter((conversation) => {
      return (
        conversation.is_mpim ||
        conversation.is_im ||
        (conversation.is_channel && conversation.is_private) ||
        (conversation.is_channel &&
          !conversation.is_private &&
          conversation.is_member)
      )
    })

    // Sort conversations by creation time for consistent resuming
    conversations.sort((a, b) => {
      return b.created! - a.created!
    })

    // Add channel names to map
    for (const conv of conversations) {
      if (conv.id && conv.name) channelMap.set(conv.id!, conv.name!)
    }

    // Determine which conversations to process based on sync type
    let conversationsToProcess: typeof conversations

    const existenceMap = await ifDocumentsExistInSchema(
      chatContainerSchema,
      conversations.map((c) => c.id!),
    )
    conversationsToProcess = conversations.filter(
      (conversation) =>
        (existenceMap[conversation.id!] &&
          !existenceMap[conversation.id!].exists) ||
        !existenceMap[conversation.id!],
    )

    loggerWithChild({ email: data.email }).info(
      ` ${conversationsToProcess.length} conversations to process`,
    )

    // Update metrics
    allConversationsInTotal.inc(
      {
        team_id: team.id ?? team.name ?? "",
        email: data.email,
        status: OperationStatus.Success,
      },
      conversations.length,
    )

    totalConversationsSkipped.inc(
      { team_id: team.id ?? team.name ?? "", email: data.email },
      conversations.length - conversationsToProcess.length,
    )

    totalConversationsToBeInserted.inc(
      { team_id: team.id ?? team.name ?? "", email: data.email },
      conversationsToProcess.length,
    )

    const user = await getAuthenticatedUserId(client)
    const teamMap = new Map<string, Team>()
    teamMap.set(team.id!, team)
    const memberMap = new Map<string, User>()
    tracker.setTotal(conversationsToProcess.length)

    // Start periodic saving
    const saveInterval = setInterval(async () => {
      try {
        await ingestionState?.save()
        Logger.debug(`Periodic state save for connector ${connector.id}`)
      } catch (error) {
        Logger.error(`Failed to periodically save state: ${error}`)
      }
    }, periodicSaveState)

    let conversationIndex = 0

    // put the conversation where it last stopped to the front of conversationsToProcess
    const prevState = ingestionOldState.get()
    if (prevState.currentChannelId) {
      const idx = conversationsToProcess.findIndex(
        (c) => c.id === prevState.currentChannelId,
      )
      if (idx > 0) {
        // Move the found conversation to the front
        const [conv] = conversationsToProcess.splice(idx, 1)
        conversationsToProcess.unshift(conv)
      }
    }

    for (const conversation of conversationsToProcess) {
      // Update state with current conversation
      await ingestionState.update({
        currentChannelId: conversation.id!,
        lastUpdated: new Date().toISOString(),
      })

      const memberIds = await getConversationUsers(
        user,
        client,
        conversation,
        data.email,
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

      for (const member of members) {
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
            loggerWithChild({ email: data.email }).error(
              error,
              `Error inserting member`,
            )
            ingestedTeamErrorTotalCount.inc({
              email_domain: teamResp.team!.email_domain,
              enterprise_id: teamResp.team!.enterprise_id,
              domain: teamResp.team!.domain,
              status: OperationStatus.Failure,
              email: data.email,
            })
          }
        }
        try {
          await insertMember(member)
          ingestedMembersTotalCount.inc({
            team_id: team.id,
            status: OperationStatus.Success,
          })
          tracker.updateUserStats(data.email, StatType.Slack_User, 1)
        } catch (error) {
          loggerWithChild({ email: data.email }).error(
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
      if (!permissions.length || permissions.indexOf(data.email) == -1) {
        permissions = permissions.concat(data.email)
      }
      const conversationWithPermission: Channel & { permissions: string[] } = {
        ...conversation,
        permissions,
      }

      // Determine timestamp for incremental message fetching
      let messageTimestamp = (Date.now() / 1000).toString()

      const oldState = ingestionOldState.get()
      if (
        conversation.id === oldState.currentChannelId &&
        oldState.lastMessageTs
      ) {
        messageTimestamp = oldState.lastMessageTs
        loggerWithChild({ email: data.email }).info(
          `Resuming messages from timestamp ${messageTimestamp} for channel ${conversation.id}`,
        )
      }
      const channelMessageInsertionDuration =
        insertChannelMessageDuration.startTimer({
          conversation_id: conversation.id,
          team_id: team.id,
          status: OperationStatus.Success,
        })
      try {
        await insertChannelMessages(
          data.email,
          client,
          conversation.id!,
          abortController,
          memberMap,
          tracker,
          "0",
          channelMap,
          ingestionState,
          messageTimestamp,
        )
        channelMessageInsertionDuration()
        insertChannelMessagesCount.inc({
          conversation_id: conversation.id ?? "",
          team_id: team.id ?? "",
          status: OperationStatus.Success,
          email: data.email,
        })
        tracker.updateUserStats(data.email, StatType.Slack_Conversation, 1)
      } catch (error) {
        loggerWithChild({ email: data.email }).error(
          "Error inserting Channel Messages",
        )
        insertChannelMessagesErrorCount.inc({
          conversation_id: conversation.id ?? "",
          team_id: team.id ?? "",
          status: OperationStatus.Failure,
          email: data.email,
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
          email: data.email,
        })
        conversationIndex++
        tracker.setCurrent(conversationIndex)
        loggerWithChild({ email: data.email }).info(
          `Inserted conversation with id : ${conversation.id ?? "N/A"}`,
        )
      } catch (error) {
        loggerWithChild({ email: data.email }).error(
          `Error inserting Conversation`,
        )
        insertConversationErrorCount.inc({
          conversation_id: conversationWithPermission.id ?? "",
          team_id: conversationWithPermission.context_team_id ?? "",
          status: OperationStatus.Failure,
          email: data.email,
        })
      }
    }

    // Clear periodic saving
    clearInterval(saveInterval)
    clearInterval(interval)

    db.transaction(async (trx) => {
      await trx
        .update(connectors)
        .set({
          status: ConnectorStatus.Connected,
          state: JSON.stringify({}),
        })
        .where(eq(connectors.id, connector.id))
      await insertSyncJob(trx, {
        workspaceId: connector.workspaceId,
        workspaceExternalId: connector.workspaceExternalId,
        app: Apps.Slack,
        connectorId: connector.id,
        authType: AuthType.OAuth,
        config: { type: "updatedAt", updatedAt: new Date().toISOString() },
        email: data.email,
        type: SyncCron.Partial,
        status: SyncJobStatus.NotStarted,
      })
    })
  } catch (error) {
    loggerWithChild({ email: data.email }).error(error)
    // Save state on error for resuming
    try {
      if (ingestionState) {
        await ingestionState.save()
        Logger.info(
          `State saved for resume after error in connector ${data.connectorId}`,
        )
      }
    } catch (saveError) {
      Logger.error(`Failed to save state on error: ${saveError}`)
    }
    throw error // Re-throw to ensure proper error handling
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
