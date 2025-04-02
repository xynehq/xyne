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
import { insert, NAMESPACE, UpdateDocument } from "@/search/vespa"
import { Subsystem, SyncCron, type SaaSOAuthJob } from "@/types"
import {
  WebClient,
  type ConversationsHistoryResponse,
  type ConversationsListResponse,
  type ConversationsRepliesResponse,
  type FilesListResponse,
  type TeamInfoResponse,
  type UsersListResponse,
} from "@slack/web-api"
import slackPkg from "@slack/web-api"
import type { Channel } from "@slack/web-api/dist/types/response/ChannelsListResponse"
import type PgBoss from "pg-boss"
import { db } from "@/db/client"
import { getLogger } from "@/logger"
import type { Member } from "@slack/web-api/dist/types/response/UsersListResponse"
import type { Team } from "@slack/web-api/dist/types/response/TeamInfoResponse"
import type { User } from "@slack/web-api/dist/types/response/UsersInfoResponse"
import { count, eq } from "drizzle-orm"
import { StatType, Tracker } from "@/integrations/tracker"
import { sendWebsocketMessage } from "../metricStream"
import { AuthType, ConnectorStatus, SyncJobStatus } from "@/shared/types"
import pLimit from "p-limit"
import { IngestionState } from "../ingestionState"
import { insertSyncJob } from "@/db/syncJob"
import type { Reaction } from "@slack/web-api/dist/types/response/ChannelsHistoryResponse"

const Logger = getLogger(Subsystem.Integrations).child({ module: "slack" })

const { retryPolicies } = slackPkg

// team and workspace metadata
// join all the public channels
// get all the users
// get all the channels
// get all the members of each channel
// files, pins
// user group lists

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
 */
export async function getAllConversations(
  client: WebClient,
  abortController: AbortController,
): Promise<ConversationsListResponse["channels"]> {
  let channels: ConversationsListResponse["channels"] = []
  let cursor: string | undefined = undefined
  do {
    const response = await client.conversations.list({
      types: "public_channel,private_channel,im,mpim",
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

/**
 * Fetches all messages from a given channel using pagination.
 * @param channelId - The ID of the channel to fetch messages from.
 * @returns A promise that resolves to an array of Slack messages.
 */
// const fetchChannelMessages = async (client: WebClient, channelId: string): Promise<SlackMessage[]> => {
//   let messages: SlackMessage[] = [];
//   let cursor: string | undefined = undefined;

//   do {
//     const response: ConversationsHistoryResponse = await client.conversations.history({
//       channel: channelId,
//       limit: 200, // Adjust limit as needed; max is 1000.
//       cursor,
//     });

//     if (!response.ok) {
//       throw new Error(`Error fetching messages: ${response.error}`);
//     }

//     if (response.messages) {
//       // Type assertion ensures messages are of type SlackMessage[]
//       messages.push(...(response.messages as SlackMessage[]));
//     }

//     cursor = response.response_metadata?.next_cursor;
//   } while (cursor);

//   return messages;
// }

const safeConversationReplies = async (
  client: WebClient,
  channelId: string,
  threadTs: string,
  cursor: string | undefined,
): Promise<ConversationsRepliesResponse> => {
  return retryOnFatal(
    () =>
      client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 999,
        cursor,
      }),
    3,
    1000,
  )
}
/**
 * Fetches all messages in a thread (given the parent message's thread_ts)
 */
async function fetchThreadMessages(
  client: WebClient,
  channelId: string,
  threadTs: string,
): Promise<SlackMessage[]> {
  let threadMessages: SlackMessage[] = []
  let cursor: string | undefined = undefined
  do {
    const response: ConversationsRepliesResponse =
      await safeConversationReplies(client, channelId, threadTs, cursor)
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

const safeGetTeamInfo = async (client: WebClient): Promise<Team> => {
  return retryOnFatal(() => getTeamInfo(client), 3, 1000)
}

const safeConversationHistory = async (
  client: WebClient,
  channelId: string,
  cursor: string | undefined,
  oldest?: string,
): Promise<ConversationsHistoryResponse> => {
  return retryOnFatal(
    () =>
      client.conversations.history({
        channel: channelId,
        limit: 999,
        cursor,
        oldest,
      }),
    3,
    1000,
  )
}

/**
 * Fetches all messages from a channel.
 * For each message that is a thread parent, it also fetches the thread replies.
 */
async function insertChannelMessages(
  email: string,
  client: WebClient,
  channelId: string,
  abortController: AbortController,
  memberMap: Record<string, Member | User>,
  teamMap: Record<string, Team>,
  permissionMap: Record<string, string[]>,
  tracker: Tracker,
  ingestionState: IngestionState<SlackOAuthIngestionState>,
  lastMessageTs?: string,
): Promise<void> {
  // let allMessages: SlackMessage[] = []
  let cursor: string | undefined = undefined

  let replyCount = 0

  let threadBatchSize = []
  const subtypes = new Set()
  do {
    const response: ConversationsHistoryResponse =
      await safeConversationHistory(client, channelId, cursor, lastMessageTs)

    if (!response.ok) {
      throw new Error(
        `Error fetching messages for channel ${channelId}: ${response.error}`,
      )
    }

    if (response.messages) {
      for (const message of response.messages as SlackMessage[]) {
        // replace user id with username
        const text = replaceMentionsIfPresent(message.text || "", memberMap)
        // Add the top-level message
        // allMessages.push(message)
        if (
          message.type === "message" &&
          !message.subtype &&
          message.user
          // memberMap[message.user]
        ) {
          // a deleted user's message could be there
          if (!memberMap[message.user]) {
            memberMap[message.user] = (
              await client.users.info({
                user: message.user,
              })
            ).user!
          }

          insertChatMessage(
            email,
            message,
            channelId,
            memberMap[message.user!].profile?.display_name!,
            memberMap[message.user!].name!,
            memberMap[message.user!].profile?.image_192!,
            permissionMap[channelId] || [],
          )
          tracker.updateUserStats(email, StatType.Slack_Message, 1)

          await ingestionState.update({
            currentChannelId: channelId,
            lastMessageTs: message.ts,
          })
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
          const threadMessages = await fetchThreadMessages(
            client,
            channelId,
            message.thread_ts,
          )
          // Exclude the parent message (already added)
          const replies = threadMessages.filter((msg) => msg.ts !== message.ts)
          for (const reply of replies) {
            if (
              message.type === "message" &&
              !message.subtype &&
              reply.user
              // memberMap[reply.user]
            ) {
              // a deleted user's message could be there
              if (!memberMap[reply.user]) {
                memberMap[reply.user] = (
                  await client.users.info({
                    user: reply.user,
                  })
                ).user!
              }
              insertChatMessage(
                email,
                reply,
                channelId,
                memberMap[message.user!].profile?.display_name!,
                memberMap[reply.user!].name!,
                memberMap[reply.user!].profile?.image_192!,
                permissionMap[channelId] || [],
              )
              tracker.updateUserStats(email, StatType.Slack_Message_Reply, 2)
            } else {
              subtypes.add(reply.subtype)
            }
          }
          // allMessages.push(...replies)
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

const insertConversations = async (
  conversations: ConversationsListResponse["channels"],
  abortController: AbortController,
): Promise<void> => {
  for (const conversation of conversations || []) {
    if ((conversation as Channel).is_channel) {
      const vespaChatContainer: VespaChatContainer = {
        docId: (conversation as Channel).id!,
        name: (conversation as Channel).name!,
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
        topic: (conversation as Channel).topic?.value!,
        description: (conversation as Channel).purpose?.value!,
        count: (conversation as Channel).num_members!,
      }
      await insert(vespaChatContainer, chatContainerSchema)
    }
  }
}

async function getConversationUsers(
  client: WebClient,
  conversationId: string,
): Promise<string[]> {
  Logger.info("fetching users from conversation")
  let allMembers: string[] = []
  let cursor: string | undefined

  try {
    do {
      const result = await client.conversations.members({
        channel: conversationId,
        limit: 999, // Max allowed per call
        cursor, // Next page cursor
      })

      if (result.ok && result.members) {
        allMembers = allMembers.concat(result.members)
        cursor = result.response_metadata?.next_cursor
      } else {
        throw new Error("Failed to fetch channel members")
      }
    } while (cursor) // Continue until no more pages

    return allMembers
  } catch (error) {
    console.error("Error fetching channel users:", error)
    return []
  }
}

const insertChatMessage = async (
  email: string,
  message: SlackMessage,
  channelId: string,
  name: string,
  username: string,
  image: string,
  permissions: string[],
) => {
  const editedTimestamp = message.edited ? parseFloat(message?.edited?.ts!) : 0
  if (!permissions.length || permissions.indexOf(email) == -1) {
    permissions = permissions.concat(email)
  }
  return insert(
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
      permissions,
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
      mentions: [],
      updatedAt: editedTimestamp,
      // files: [],
      metadata: "",
      // files: message.files,
    } as VespaChatMessage,
    chatMessageSchema,
  )
}

const insertTeam = async (team: Team, own: boolean) => {
  return insert(
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

const insertMember = async (member: Member) => {
  return insert(
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

const concurrency = 8

const makeMemberTeamAndPermissionMap = async (
  email: string,
  client: WebClient,
  conversations: string[],
  tracker: Tracker,
): Promise<{
  memberMap: Record<string, Member | User>
  teamMap: Record<string, Team>
  permissionMap: Record<string, string[]>
}> => {
  const workspaceMembers: Member[] = await getAllUsers(client)

  await UpdateDocument(chatTeamSchema, workspaceMembers[0].team_id!, {
    count: workspaceMembers.length,
  })
  const permissionMap: Record<string, string[]> = {}
  const teamMap: Record<string, Team> = {}
  Logger.info(`total members ${workspaceMembers.length}`)
  const memberMap: Record<string, Member | User> = {}
  for (const member of workspaceMembers) {
    memberMap[member.id!] = member
    await insertMember(member)
    tracker.updateUserStats(email, StatType.Slack_User, 1)
  }
  const uniqueMembers = new Set<string>()
  for (const conversationId of conversations) {
    let originalMembers = await getConversationUsers(client, conversationId)
    let members = originalMembers.filter((m) => !memberMap[m])
    members.forEach((m) => uniqueMembers.add(m))

    permissionMap[conversationId] = originalMembers

    console.log(
      "total members outside workspace in this channel",
      members.length,
    )
  }

  const memberLimit = pLimit(concurrency)

  const memberPromises = [...uniqueMembers].map((memberId: string) =>
    memberLimit(async () => {
      const userResp = await client.users.info({ user: memberId })
      if (!userResp.user) {
        return null
      }
      return userResp
    }),
  )

  const teamList = new Set<string>()
  const userResults = (await Promise.all(memberPromises)).filter((v) => v)
  userResults.forEach((userResp) => {
    memberMap[userResp?.user?.id!] = userResp?.user!
    insertMember(userResp?.user!)
    tracker.updateUserStats(email, StatType.Slack_User, 1)
    teamList.add(userResp?.user?.team_id!)
  })
  const teamLimit = pLimit(concurrency)
  const teamPromises = [...teamList].map((teamId: string) =>
    teamLimit(async () => {
      const teamResp: TeamInfoResponse = await client.team.info({
        team: teamId,
      })
      return teamResp
    }),
  )
  const teamResults = await Promise.all(teamPromises)
  teamResults.forEach((teamResp) => {
    teamMap[teamResp.team?.id!] = teamResp.team!
    insertTeam(teamResp.team!, false)
  })

  Object.entries(permissionMap).forEach(([key, value]) => {
    permissionMap[key] = value
      .map((m) => memberMap[m]?.profile?.email!)
      .filter((v) => v)
  })

  return { memberMap, teamMap, permissionMap }
}

const periodicSaveState = 4000

export const handleSlackIngestion = async (data: SaaSOAuthJob) => {
  try {
    const abortController = new AbortController()
    const connector: SelectConnector = await getOAuthConnectorWithCredentials(
      db,
      data.connectorId,
    )

    // Initialize ingestion state
    const initialState: SlackOAuthIngestionState = {
      app: Apps.Slack,
      authType: AuthType.OAuth,
      currentChannelId: undefined,
      lastMessageTs: undefined,
      lastUpdated: new Date().toISOString(),
    }
    const ingestionState = new IngestionState(
      connector.id,
      connector.workspaceId,
      connector.userId,
      db,
      initialState,
    )

    const { accessToken } = connector.oauthCredentials

    // Load existing state if it exists and isn’t empty
    const connectorState = connector.state as Record<string, any>
    if (Object.keys(connectorState).length > 0) {
      await ingestionState.load()
      Logger.info(
        `Loaded existing ingestion state for connector ${connector.id}`,
      )
    } else {
      Logger.info(`Starting fresh ingestion for connector ${connector.id}`)
    }

    const client = new WebClient(accessToken, {
      retryConfig: retryPolicies.rapidRetryPolicy,
    })

    const tracker = new Tracker(Apps.Slack, AuthType.OAuth)

    // if ingestion state exists means that ingestion has not been completed yet
    // so it exists just to keep track of till where we have done
    // it is per connector and per user for OAuth
    // for service account it is per connector but will be aware of what all is finished
    // it's all about not doing again what is already ingested

    const team = await safeGetTeamInfo(client)
    const isFreshSync =
      !connectorState || Object.keys(connectorState).length === 0
    if (!isFreshSync) {
      await ingestionState.load()
      Logger.info(
        `Resuming ingestion from existing state for connector ${connector.id}`,
      )
    } else {
      Logger.info(`Starting fresh ingestion for connector ${connector.id}`)
    }

    const interval = setInterval(() => {
      sendWebsocketMessage(
        JSON.stringify({
          progress: tracker.getProgress(),
          userStats: tracker.getOAuthProgress().userStats,
          startTime: tracker.getStartTime(),
        }),
        connector.externalId,
      )
    }, 4000)
    await insertTeam(team, true)

    const conversations =
      (await getAllConversations(client, abortController)) || []
    conversations.sort((a, b) => {
      return b.created! - a.created!
    })

    tracker.setCurrent(0)
    tracker.setTotal(conversations.length)
    await insertConversations(conversations, abortController)
    tracker.updateUserStats(
      data.email,
      StatType.Slack_Conversation,
      conversations.length,
    )
    const { memberMap, teamMap, permissionMap } =
      await makeMemberTeamAndPermissionMap(
        data.email,
        client,
        conversations.map((c) => c.id!),
        tracker,
      )

    // Start periodic saving
    const saveInterval = setInterval(async () => {
      try {
        await ingestionState.save()
        Logger.debug(`Periodic state save for connector ${connector.id}`)
      } catch (error) {
        Logger.error(`Failed to periodically save state: ${error}`)
      }
    }, periodicSaveState)

    if (isFreshSync) {
      let conversationIndex = 0
      for (const conversation of conversations) {
        const teamIds = conversation.shared_team_ids || []

        if (conversation.is_mpim) {
          // stats.mpims++
          await insertChannelMessages(
            data.email,
            client,
            conversation.id!,
            abortController,
            memberMap,
            teamMap,
            permissionMap,
            tracker,
            ingestionState,
          )
        } else if (conversation.is_im) {
          // stats.ims++
          await insertChannelMessages(
            data.email,
            client,
            conversation.id!,
            abortController,
            memberMap,
            teamMap,
            permissionMap,
            tracker,
            ingestionState,
          )
        } else if (conversation.is_channel) {
          if (conversation.is_private) {
            // stats.private++
          } else {
            // stats.public++
          }
          await insertChannelMessages(
            data.email,
            client,
            conversation.id!,
            abortController,
            memberMap,
            teamMap,
            permissionMap,
            tracker,
            ingestionState,
          )
        } else {
          console.log("skipping conversation", conversation)
        }
        conversationIndex++
        tracker.setCurrent(conversationIndex)
      }
    } else {
      // Resume sync: start from last known point
      const currentState = ingestionState.get()
      const resumeChannelId = currentState.currentChannelId
      const { lastMessageTs } = currentState
      Logger.info(`Resuming from ${resumeChannelId} and ${lastMessageTs}`)
      const startIndex = resumeChannelId
        ? conversations.findIndex((c) => c.id === resumeChannelId)
        : 0

      if (startIndex === -1) {
        Logger.warn(
          `Resume channel ${resumeChannelId} not found, starting from beginning`,
        )
      }

      tracker.setCurrent(startIndex)

      const remainingConversations = conversations.slice(startIndex)
      const newConversations = remainingConversations.filter(
        (c) => c.created! > new Date(currentState.lastUpdated).getTime() / 1000,
      )
      // const existingConversations = remainingConversations.filter(
      //   (c) => c.created! <= new Date(currentState.lastUpdated).getTime() / 1000
      // );

      // Insert only new conversations
      await insertConversations(conversations, abortController)
      tracker.updateUserStats(
        data.email,
        StatType.Slack_Conversation,
        newConversations.length,
      )

      let conversationIndex = startIndex
      for (const conversation of remainingConversations) {
        if (
          conversation.is_mpim ||
          conversation.is_im ||
          conversation.is_channel
        ) {
          await insertChannelMessages(
            data.email,
            client,
            conversation.id!,
            abortController,
            memberMap,
            teamMap,
            permissionMap,
            tracker,
            ingestionState,
            lastMessageTs,
          )
        } else {
          console.log("skipping conversation", conversation)
        }
        conversationIndex++
        tracker.setCurrent(conversationIndex)
      }
    }

    setTimeout(() => {
      clearInterval(interval)
    }, 8000)

    clearInterval(saveInterval)

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

// handleSlackIngestion({
//   data: { connectorId: 8, email: "saheb@xynehq.com" },
// })

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
