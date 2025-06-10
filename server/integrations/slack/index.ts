import { getOAuthConnectorWithCredentials } from "@/db/connector"
import {
  connectors,
  type SelectConnector,
  type SlackOAuthIngestionState,
} from "@/db/schema"
import {
  Apps,
  chatContainerSchema,
  chatMessageSchema,
  chatTeamSchema,
  chatUserSchema,
  SlackEntity,
  type VespaChatContainer,
  type VespaChatMessage,
} from "@/search/types"
import {
  ifDocumentsExist,
  ifDocumentsExistInSchema,
  insert,
  insertWithRetry,
  NAMESPACE,
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
import { getLogger } from "@/logger"
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
} from "@/metrics/slack/slack-metrics"

const Logger = getLogger(Subsystem.Integrations).child({ module: "slack" })

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
): Promise<ConversationsHistoryResponse> => {
  return retryOnFatal(
    () =>
      client.conversations.history({
        channel: channelId,
        limit: 999,
        cursor,
        oldest: timestamp,
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
): Promise<void> {
  let cursor: string | undefined = undefined

  let replyCount = 0

  const subtypes = new Set()
  do {
    const response: ConversationsHistoryResponse =
      await safeConversationHistory(client, channelId, cursor, timestamp)

    if (!response.ok) {
      throw new Error(
        `Error fetching messages for channel ${channelId}: ${response.error}`,
      )
    }

    if (response.messages) {
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
              team_id: message.team,
            })
          } catch (error) {
            Logger.error(error, `Error inserting chat message`)
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
            if (
              reply.type === "message" &&
              !reply.subtype &&
              reply.user &&
              reply.client_msg_id &&
              reply.text != ""
              // memberMap[reply.user]
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
                  team_id: message.team,
                })
              } catch (error) {
                Logger.error(error, `Error inserting chat message`)
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
): Promise<string[]> {
  Logger.info("fetching users from conversation")

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
    console.error("Error fetching channel users:", error)
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

export const insertChatMessage = async (
  client: WebClient,
  message: SlackMessage & { mentions?: string[] },
  channelId: string,
  name: string,
  username: string,
  image: string,
) => {
  const editedTimestamp = message.edited
    ? parseFloat(message?.edited?.ts!)
    : message.ts!

  return insertWithRetry(
    {
      docId: message.client_msg_id!,
      teamId: message.team!,
      text: message.text!,
      attachmentIds: [],
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
      // files: [],
      metadata: "",
      // files: message.files,
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
  try {
    const abortController = new AbortController()
    const connector: SelectConnector = await getOAuthConnectorWithCredentials(
      db,
      data.connectorId,
    )

    const { accessToken } = connector.oauthCredentials
    const client = new WebClient(accessToken, {
      retryConfig: retryPolicies.rapidRetryPolicy,
    })
    const tracker = new Tracker(Apps.Slack, AuthType.OAuth)
    const team = await safeGetTeamInfo(client)
    const channelMap = new Map<string, string>()
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
      Logger.info(`Error inserting team`)
      ingestedTeamErrorTotalCount.inc({
        email_domain: team.email_domain,
        enterprise_id: team.enterprise_id,
        domain: team.domain,
        status: OperationStatus.Failure,
      })
    }
    const conversations = (
      (await getAllConversations(client, true, new AbortController())) || []
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
    Logger.info(
      `conversations to insert ${conversationsToInsert.length} and skipping ${conversations.length - conversationsToInsert.length}`,
    )
    const user = await getAuthenticatedUserId(client)
    const teamMap = new Map<string, Team>()
    teamMap.set(team.id!, team)
    const memberMap = new Map<string, User>()
    tracker.setCurrent(0)
    tracker.setTotal(conversationsToInsert.length)
    let conversationIndex = 0
    // can be done concurrently, but can cause issues with ratelimits
    for (const conversation of conversationsToInsert) {
      const memberIds = await getConversationUsers(user, client, conversation)
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
            Logger.error(error, `Error inserting member`)
            ingestedTeamErrorTotalCount.inc({
              email_domain: teamResp.team!.email_domain,
              enterprise_id: teamResp.team!.enterprise_id,
              domain: teamResp.team!.domain,
              status: OperationStatus.Failure,
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
          Logger.error(`Error inserting member ${member.id}: ${error}`)
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
      if (!permissions.length || permissions.indexOf(data.email) == -1) {
        permissions = permissions.concat(data.email)
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
          data.email,
          client,
          conversation.id!,
          abortController,
          memberMap,
          tracker,
          "0",
          channelMap,
        )
        channelMessageInsertionDuration()
        insertChannelMessagesCount.inc({
          conversation_id: conversation.id ?? "",
          team_id: team.id ?? "",
          status: OperationStatus.Success,
        })
        tracker.updateUserStats(data.email, StatType.Slack_Conversation, 1)
      } catch (error) {
        Logger.error("Error inserting Channel Messages")
        insertChannelMessagesErrorCount.inc({
          conversation_id: conversation.id ?? "",
          team_id: team.id ?? "",
          status: OperationStatus.Failure,
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
        })
        conversationIndex++
        tracker.setCurrent(conversationIndex)
      } catch (error) {
        Logger.error(`Error inserting Conversation`)
        insertConversationErrorCount.inc({
          conversation_id: conversationWithPermission.id ?? "",
          team_id: conversationWithPermission.context_team_id ?? "",
          status: OperationStatus.Failure,
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
      await insertSyncJob(trx, {
        workspaceId: connector.workspaceId,
        workspaceExternalId: connector.workspaceExternalId,
        app: Apps.Slack,
        connectorId: connector.id,
        authType: AuthType.OAuth,
        // config: {lastUpdated: new Date().toISOString()},
        config: { type: "updatedAt", updatedAt: new Date().toISOString() },
        email: data.email,
        type: SyncCron.Partial,
        status: SyncJobStatus.NotStarted,
      })
    })
  } catch (error) {
    Logger.error(error)
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