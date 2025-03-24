import { getOAuthConnectorWithCredentials } from "@/db/connector"
import type { SelectConnector } from "@/db/schema"
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
import { Subsystem, type SaaSOAuthJob } from "@/types"
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
import type { Channel } from "@slack/web-api/dist/types/response/ChannelsListResponse"
import type PgBoss from "pg-boss"
import { db } from "@/db/client"
import { getLogger } from "@/logger"
import type { Member } from "@slack/web-api/dist/types/response/UsersListResponse"
import type { Team } from "@slack/web-api/dist/types/response/TeamInfoResponse"
import type { User } from "@slack/web-api/dist/types/response/UsersInfoResponse"
import { count } from "drizzle-orm"
import { StatType, Tracker } from "@/integrations/tracker"
import { sendWebsocketMessage } from "../metricStream"

const Logger = getLogger(Subsystem.Integrations).child({ module: "slack" })

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
): Promise<ConversationsHistoryResponse> => {
  return retryOnFatal(
    () =>
      client.conversations.history({
        channel: channelId,
        limit: 999,
        cursor,
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
): Promise<void> {
  console.log(channelId)
  // let allMessages: SlackMessage[] = []
  let cursor: string | undefined = undefined

  let threadBatchSize = []
  const subtypes = new Set()
  do {
    const response: ConversationsHistoryResponse =
      await safeConversationHistory(client, channelId, cursor)

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
            memberMap[message.user!].name,
            memberMap[message.user!].profile?.image_192!,
            permissionMap[channelId] || [],
          )
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

  console.log(subtypes)
  // return allMessages
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
  console.log("inserting ", permissions, email)
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
      // userRef: `id:${NAMESPACE}:${chatUserSchema}::${message.user!}`,
      channelId,
      userId: message.user!,
      threadId: message.thread_ts!,
      createdAt: parseFloat(message.ts!),
      mentions: [],
      updatedAt: editedTimestamp,
      // files: [],
      metadata: "",
      // reactions: message.reactions,
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
  for (const conversationId of conversations) {
    let originalMembers = await getConversationUsers(client, conversationId)
    let members = originalMembers.filter((m) => !memberMap[m])
    console.log(
      "total members outside workspace in this channel",
      members.length,
    )
    // these should all be external members
    for (const memberId of members) {
      const userResp = await client.users.info({ user: memberId })
      if (!userResp.user) {
        Logger.info("user not found", memberId)
        continue
      }
      const user: User = userResp.user

      memberMap[memberId] = user
      await insertMember(user)
      tracker.updateUserStats(email, StatType.Slack_User, 1)
      if (!teamMap[user.team_id!]) {
        const teamResp: TeamInfoResponse = await client.team.info({
          team: user?.team_id,
        })

        teamMap[teamResp.team?.id!] = teamResp.team!
        await insertTeam(teamResp.team!, false)
      }
    }
    permissionMap[conversationId] = originalMembers
      .map((m) => memberMap[m]?.profile?.email)
      .filter((v) => v)
  }
  return { memberMap, teamMap, permissionMap }
}

export const handleSlackIngestion = async (
  boss: PgBoss,
  job: PgBoss.Job<any>,
) => {
  try {
    const abortController = new AbortController()
    const data: SaaSOAuthJob = job.data as SaaSOAuthJob
    const connector: SelectConnector = await getOAuthConnectorWithCredentials(
      db,
      data.connectorId,
    )

    const { accessToken } = connector.oauthCredentials

    const client = new WebClient(accessToken, {
      retryConfig: retryPolicies.rapidRetryPolicy,
    })

    const tracker = new Tracker(Apps.Slack)

    const team = await safeGetTeamInfo(client)
    const interval = setInterval(() => {
      sendWebsocketMessage(
        JSON.stringify({
          progress: () => {},
          userStats: tracker.getOAuthProgress().userStats,
        }),
        connector.externalId,
      )
    }, 4000)
    await insertTeam(team, true)

    const conversations =
      (await getAllConversations(client, abortController)) || []
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

    for (const conversation of conversations) {
      const teamIds = conversation.shared_team_ids || []

      if (conversation.is_mpim) {
        // stats.mpims++
        const messages = await insertChannelMessages(
          data.email,
          client,
          conversation.id!,
          abortController,
          memberMap,
          teamMap,
          permissionMap,
          tracker,
        )
      } else if (conversation.is_im) {
        // stats.ims++
        const messages = await insertChannelMessages(
          data.email,
          client,
          conversation.id!,
          abortController,
          memberMap,
          teamMap,
          permissionMap,
          tracker,
        )
      } else if (conversation.is_channel) {
        if (conversation.is_private) {
          // stats.private++
        } else {
          // stats.public++
        }
        // if (!conversation.is_member) {
        //   await joinChannel(client, conversation.id!);
        // }
        const messages = await insertChannelMessages(
          data.email,
          client,
          conversation.id!,
          abortController,
          memberMap,
          teamMap,
          permissionMap,
          tracker,
        )
      } else {
        console.log("skipping conversation", conversation)
      }
    }
    setTimeout(() => {
      clearInterval(interval)
    }, 8000)

    db.transaction(async (trx) => {})
    // const conversations: ConversationsListResponse["channels"] =
    //   await getAllConversations(client, abortController)
    // // join all public channels
    // for (const conversation in conversations) {
    //   // public channel
    //   if (
    //     (conversation as Channel).is_channel &&
    //     !(conversation as Channel).is_private
    //   ) {
    //     await joinChannel(client, (conversation as Channel).id!)
    //   }
    // }

    // // when fetching message, also fetch the reactions, if it's starred or pinned

    // for (const conversation in conversations) {
    //   if (
    //     (conversation as Channel).is_channel &&
    //     !(conversation as Channel).is_private
    //   ) {
    //     const messages = await fetchChannelMessages(
    //       client,
    //       (conversation as Channel).id!,
    //       abortController,
    //     )
    //     // insert the message as we get
    //   }
    // }
  } catch (error) {
    Logger.error(error)
  }
}

// handleSlackIngestion(null as any, { data: { connectorId: 292, email: "saheb@xynehq.com" } })

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
