import { calendar_v3, drive_v3, gmail_v1, google, people_v1 } from "googleapis"
import type PgBoss from "pg-boss"
import { getOAuthConnectorWithCredentials } from "@/db/connector"
import { db } from "@/db/client"
import { Apps, AuthType, SyncJobStatus } from "@/shared/types"
import {
  connectors,
  type SelectConnector,
  type SlackOAuthIngestionState,
} from "@/db/schema"
import { Subsystem, type SlackConfig, SyncCron } from "@/types"
import {
  getAppSyncJobs,
  getAppSyncJobsByEmail,
  updateSyncJob,
} from "@/db/syncJob"
import { WebClient } from "@slack/web-api"
import {
  getAllConversations,
  insertConversation,
  safeGetTeamInfo,
  extractUserIdsFromBlocks,
  fetchThreadMessages,
  insertMember,
  formatSlackSpecialMentions,
} from "@/integrations/slack/index"
import { getLogger, getLoggerWithChild } from "@/logger"
import { GaxiosError } from "gaxios"
const Logger = getLogger(Subsystem.Integrations).child({ module: "slack" })

import type { Channel } from "@slack/web-api/dist/types/response/ChannelsListResponse"
import type { Member } from "@slack/web-api/dist/types/response/UsersListResponse"
import type { Team } from "@slack/web-api/dist/types/response/TeamInfoResponse"
import type { User } from "@slack/web-api/dist/types/response/UsersInfoResponse"
import { count, eq } from "drizzle-orm"
import { StatType, Tracker } from "@/integrations/tracker"
import { sendWebsocketMessage } from "../metricStream"
import { ConnectorStatus } from "@/shared/types"
import pLimit from "p-limit"
import { IngestionState } from "../ingestionState"
import { insertSyncJob } from "@/db/syncJob"
import type { Reaction } from "@slack/web-api/dist/types/response/ChannelsHistoryResponse"
import {
  retryPolicies,
  type ConversationsHistoryResponse,
  type ConversationsListResponse,
  type ConversationsRepliesResponse,
  type FilesListResponse,
  type TeamInfoResponse,
  type UsersListResponse,
} from "@slack/web-api"
import { insertSyncHistory } from "@/db/syncHistory"
import {
  chatContainerSchema,
  chatMessageSchema,
  chatTeamSchema,
  chatUserSchema,
  SlackEntity,
  type VespaChatContainer,
  type VespaChatMessage,
  VespaChatUserSchema,
  type ChatUserCore,
} from "@xyne/vespa-ts/types"
import {
  insert,
  UpdateDocument,
  insertDocument,
  insertUser,
  ifDocumentsExist,
  ifDocumentsExistInSchema,
  ifDocumentsExistInChatContainer,
  GetDocument,
} from "@/search/vespa"
import {
  getAllUsers,
  getConversationUsers,
  insertTeam,
  safeConversationHistory,
  insertChatMessage,
  getTeam,
} from "@/integrations/slack/index"
import { chat } from "googleapis/build/src/apis/chat"
import { jobs } from "googleapis/build/src/apis/jobs"
import { getErrorMessage } from "@/utils"
type SlackMessage = NonNullable<
  ConversationsHistoryResponse["messages"]
>[number]

const concurrency = 5

const loggerWithChild = getLoggerWithChild(Subsystem.Queue)
type ChangeStats = {
  added: number
  removed: number
  updated: number
  summary: string
}
// ---------------------------

// -----------------------------

// This function will handle the insertion of new messages
// and also handle the update of existing messages
// for thread also the same
export async function insertChannelMessages(
  email: string,
  client: WebClient,
  channelId: string,
  abortController: AbortController,
  memberMap: Map<string, User>,
  tracker: Tracker,
  timestamp: string = "0",
  channelMap: Map<string, string>,
): Promise<boolean> {
  const syncTimestamp = parseFloat(timestamp)
  const ThreehrsBack =
    syncTimestamp === 0 ? "0" : (syncTimestamp - 10800).toString()

  let cursor: string | undefined = undefined
  let replyCount = 0
  let changesMade = false
  const subtypes = new Set()

  do {
    const response: ConversationsHistoryResponse =
      await safeConversationHistory(client, channelId, cursor, ThreehrsBack)

    if (!response.ok) {
      throw new Error(
        `Error fetching messages for channel ${channelId}: ${response.error}`,
      )
    }

    if (response.messages) {
      for (const message of response.messages as (SlackMessage & {
        mentions: string[]
      })[]) {
        const mentions = extractUserIdsFromBlocks(message)
        let text = message.text

        if (mentions.length) {
          for (const m of mentions) {
            if (!memberMap.get(m)) {
              memberMap.set(m, (await client.users.info({ user: m })).user!)
            }
            text = text?.replace(
              `<@${m}>`,
              `@${memberMap.get(m)?.profile?.display_name ?? memberMap.get(m)?.name}`,
            )
          }
        }
        text = formatSlackSpecialMentions(text, channelMap, channelId)
        message.text = text
        const messageId = message.client_msg_id
        const messageUpdatedTs = parseFloat(message.edited?.ts! ?? message.ts)

        if (
          message.type === "message" &&
          !message.subtype &&
          message.user &&
          message.client_msg_id &&
          message.text != ""
        ) {
          if (!memberMap.get(message.user)) {
            memberMap.set(
              message.user,
              (await client.users.info({ user: message.user })).user!,
            )
          }

          message.mentions = mentions
          message.team = await getTeam(client, message)

          const vespaDoc = await ifDocumentsExist([messageId!])
          if (!vespaDoc[messageId!]?.exists) {
            try {
              await insertChatMessage(
                client,
                message,
                channelId,
                memberMap.get(message.user!)?.profile?.display_name!,
                memberMap.get(message.user!)?.name!,
                memberMap.get(message.user!)?.profile?.image_192!,
              )
            } catch (error) {
              Logger.error("Error inserting message", error, message)
            }
            changesMade = true

            tracker.updateUserStats(email, StatType.Slack_Message, 1)
          } else {
            const vespaUpdatedTs = parseFloat(
              String(vespaDoc[messageId!].updatedAt ?? "0"),
            )
            if (vespaUpdatedTs < messageUpdatedTs) {
              await UpdateDocument(chatMessageSchema, messageId!, {
                text: message.text,
                updatedAt: messageUpdatedTs,
                reactions: message.reactions?.reduce((acc, curr) => {
                  return acc + (curr as Reaction).count! || 0
                }, 0),
              })
              changesMade = true
              tracker.updateUserStats(email, StatType.Slack_Message, 1)
            }
          }
        } else {
          subtypes.add(message.subtype)
        }

        if (
          message.thread_ts &&
          message.thread_ts === message.ts &&
          message.reply_count &&
          message.reply_count > 0
        ) {
          replyCount += 1

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
                      (await client.users.info({ user: m })).user!,
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
                  (await client.users.info({ user: reply.user })).user!,
                )
              }

              reply.mentions = mentions
              reply.text = text
              reply.team = await getTeam(client, reply)

              const replyId = reply.client_msg_id
              const replyUpdatedTs = parseFloat(
                reply.edited?.ts! ?? reply.thread_ts,
              )
              const vespaDoc = await ifDocumentsExist([replyId!])

              if (!vespaDoc[replyId!]?.exists) {
                await insertChatMessage(
                  client,
                  reply,
                  channelId,
                  memberMap.get(reply.user!)?.profile?.display_name!,
                  memberMap.get(reply.user!)?.name!,
                  memberMap.get(reply.user!)?.profile?.image_192!,
                )
                changesMade = true
                tracker.updateUserStats(email, StatType.Slack_Message_Reply, 1)
              } else {
                const vespaUpdatedTs = parseFloat(
                  String(vespaDoc[replyId!].updatedAt ?? "0"),
                )

                if (vespaUpdatedTs < replyUpdatedTs) {
                  await UpdateDocument(
                    chatMessageSchema,
                    reply.client_msg_id!,
                    {
                      text: reply.text,
                      updatedAt: replyUpdatedTs,
                      reactions:
                        reply.reactions?.reduce((acc, curr) => {
                          return acc + ((curr as Reaction).count || 0)
                        }, 0) || 0,
                    },
                  )
                  changesMade = true
                  tracker.updateUserStats(
                    email,
                    StatType.Slack_Message_Reply,
                    1,
                  )
                }
              }
            } else {
              subtypes.add(reply.subtype)
            }
          }
        }
      }
    }

    cursor = response.response_metadata?.next_cursor
  } while (cursor)

  return changesMade
}

export const handleSlackChanges = async (
  boss: PgBoss,
  job: PgBoss.Job<any>,
) => {
  const jobData = job.data
  loggerWithChild({ email: jobData.email ?? "" }).info(
    "handleSlackChanges started",
  )
  const syncOnlyCurrentUser = job.data.syncOnlyCurrentUser || false

  try {
    let syncJobs = await getAppSyncJobs(db, Apps.Slack, AuthType.OAuth)
    if (syncOnlyCurrentUser) {
      loggerWithChild({ email: jobData.email }).info(
        "Syncing for Current User Only",
      )
      syncJobs = await getAppSyncJobsByEmail(
        db,
        Apps.Slack,
        AuthType.OAuth,
        jobData.email,
      )
    }
    loggerWithChild({ email: jobData.email ?? "" }).info(
      `Value of syncOnlyCurrentUser :${syncOnlyCurrentUser} `,
    )
    if (!syncJobs || syncJobs.length === 0) {
      loggerWithChild({ email: jobData.email ?? "" }).info(
        "No Slack sync jobs found",
      )
      return
    }

    const syncedChannels = new Set<string>()

    const memberMap = new Map<string, User>()
    const teamMap = new Map<string, Team>()
    const channelMap = new Map<string, string>()
    // Ensure team info is in the map

    // Process all sync jobs, not just the first one

    for (const syncJob of syncJobs) {
      const jobStats = newStats()
      let config: SlackConfig = syncJob.config as SlackConfig
      const jobStartTime = new Date()
      try {
        Logger.info(`Processing sync job ID: ${syncJob.id}`)
        const { connectorId, email } = syncJob
        const connector = await getOAuthConnectorWithCredentials(
          db,
          connectorId,
        )

        const { accessToken } = connector.oauthCredentials as {
          accessToken: string
        }
        const client = new WebClient(accessToken, {
          retryConfig: retryPolicies.rapidRetryPolicy,
        })

        const team = await safeGetTeamInfo(client)
        teamMap.set(team.id!, team)
        let changeExist = false

        const lastSyncTimestamp = Math.floor(config.updatedAt.getTime() / 1000)

        Logger.info(
          `Last sync timestamp for job ${syncJob.id}: ${lastSyncTimestamp}`,
        )

        // Get all conversations
        const conversations = (
          (await getAllConversations(
            client,
            true,
            new AbortController(),
            email,
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
        const user = await getAuthenticatedUserId(client)

        for (const conv of conversations) {
          if (conv.id && conv.name) {
            channelMap.set(conv.id, conv.name)
          }
        }
        if (!conversations || conversations.length === 0) {
          Logger.info(`No channels found for sync job ${syncJob.id}`)
          await db.transaction(async (trx) => {
            await updateSyncJob(trx, syncJob.id, {
              config: config,
              lastRanOn: new Date(),
              status: SyncJobStatus.Successful,
            })
          })
          continue
        }

        // Get team info

        // Get channel IDs
        const channelIds = conversations
          .filter((channel) => channel.id !== undefined)
          .map((channel) => channel.id!)

        // Check which channels exist in Vespa
        const existenceMap = await ifDocumentsExistInChatContainer(channelIds)

        // Create an abort controller for message fetching operations
        const abortController = new AbortController()

        // Create a tracker instance for tracking stats
        const tracker = new Tracker(Apps.Slack, AuthType.OAuth)

        // Process each channel
        const limit = pLimit(concurrency)
        const channelProcessingPromises = conversations.map((channel) =>
          limit(async () => {
            try {
              if (!channel.id) {
                loggerWithChild({ email: jobData.email ?? "" }).warn(
                  "Skipping channel without ID",
                )
                return
              }

              // Skip if this channel has already been synced by another job in this run
              if (syncedChannels.has(channel.id)) {
                loggerWithChild({ email: jobData.email ?? "" }).info(
                  `Skipping channel ${channel.name || channel.id} as it was already synced by another job`,
                )
                return
              }

              const channelExists =
                existenceMap[channel.id] && existenceMap[channel.id].exists

              // Always get current channel members to ensure up-to-date permissions
              const currentMemberIds = await getConversationUsers(
                user,
                client,
                channel,
                email,
              )
              Logger.info(
                `Current members for channel ${channel.name || channel.id}: ${currentMemberIds.length}`,
              )

              // First ensure all members are in the memberMap from Vespa
              const resp = await ifDocumentsExist(currentMemberIds)
              if (resp) {
                for (const [docId, data] of Object.entries(resp)) {
                  if (data.exists) {
                    const document = await GetDocument(chatUserSchema, docId)
                    const newuser = document as unknown as ChatUserCore

                    const newUser: User = {
                      id: newuser.fields.docId,
                      team_id: newuser.fields.teamId,
                      name: newuser.fields.name,
                      deleted: newuser.fields.deleted,
                      is_admin: newuser.fields.isAdmin,
                      profile: {
                        display_name: newuser.fields.name,
                        image_192: newuser.fields.image,
                        email: newuser.fields.email,
                      },
                    }
                    memberMap.set(docId, {
                      profile: {
                        display_name: newUser.profile?.display_name,
                        image_192: newUser.profile!.image_192,
                        email: newUser.profile?.email,
                      },
                      name: newUser.name,
                    })
                  }
                }
              }

              // Get missing members from Slack API in a single batch
              const missingMemberIds = currentMemberIds.filter(
                (id) => !memberMap.has(id),
              )

              if (missingMemberIds.length > 0) {
                loggerWithChild({ email: jobData.email ?? "" }).info(
                  `Fetching ${missingMemberIds.length} missing members from Slack API`,
                )
                const concurrencyLimit = pLimit(5)
                const memberPromises = missingMemberIds.map(
                  (memberId: string) =>
                    concurrencyLimit(async () => {
                      try {
                        return await client.users.info({ user: memberId })
                      } catch (error) {
                        loggerWithChild({ email: jobData.email ?? "" }).error(
                          `Error fetching user ${memberId}: ${error}`,
                        )
                        return { ok: false }
                      }
                    }),
                )

                const memberResponses = await Promise.all(memberPromises)

                for (const userResp of memberResponses) {
                  if (userResp.ok && userResp.user) {
                    memberMap.set(userResp.user.id!, userResp.user)

                    // Check if team exists in map
                    if (
                      userResp.user.team_id &&
                      !teamMap.has(userResp.user.team_id)
                    ) {
                      try {
                        const teamResp = await client.team.info({
                          team: userResp.user.team_id,
                        })
                        if (teamResp.ok && teamResp.team) {
                          teamMap.set(teamResp.team.id!, teamResp.team)
                          await insertTeam(teamResp.team!, false)
                          jobStats.added++
                        }
                      } catch (error) {
                        loggerWithChild({ email: jobData.email ?? "" }).error(
                          `Error fetching team for user ${userResp.user.id}: ${error}`,
                        )
                      }
                    }

                    // Insert member in Vespa
                    try {
                      await insertMember(userResp.user)
                      jobStats.added++
                    } catch (error) {
                      loggerWithChild({ email: jobData.email ?? "" }).error(
                        `Error inserting member ${userResp.user.id}: ${error}`,
                      )
                    }
                  }
                }
              }

              let currentPermissions: string[] = currentMemberIds
                .map((m: string) => {
                  const user: User | undefined = memberMap.get(m)
                  return user?.profile?.email
                })
                .filter((email): email is string => !!email)

              // Ensure current user's email is in permissions
              if (!currentPermissions.includes(email)) {
                currentPermissions.push(email)
              }

              // Prepare channel document that will be used for both insert and update
              const vespaChatContainer: VespaChatContainer = {
                docId: channel.id!,
                name: channel.name || "",
                app: Apps.Slack,
                entity: SlackEntity.Channel,
                creator: channel.creator || "",
                isPrivate: channel.is_private || false,
                isGeneral: channel.is_general || false,
                isArchived: channel.is_archived || false,
                isIm: channel.is_im || false,
                isMpim: channel.is_mpim || false,
                createdAt: channel.created || new Date().getTime(),
                updatedAt: channel.updated || channel.created || 0,
                lastSyncedAt: new Date().getTime(),
                topic: channel.topic?.value || "",
                description: channel.purpose?.value || "",
                count: channel.num_members || 0,
                channelName: channel.name || "",
                permissions: currentPermissions,
              }

              if (!channelExists) {
                // New channel - insert with current permissions
                loggerWithChild({ email: jobData.email ?? "" }).info(
                  `New channel found: ${channel.name || channel.id}`,
                )

                // Insert the new channel
                const conversationWithPermission: Channel & {
                  permissions: string[]
                } = {
                  ...channel,
                  permissions: currentPermissions,
                }

                // For new channels, fetch all messages using insertChannelMessages
                loggerWithChild({ email: jobData.email ?? "" }).info(
                  `Fetching all messages for new channel ${channel.name || channel.id}`,
                )
                await insertChannelMessages(
                  email,
                  client,
                  channel.id!,
                  abortController,
                  memberMap,
                  tracker,
                  "0",
                  channelMap,
                )
                await insertConversation(conversationWithPermission)
                changeExist = true
                jobStats.added++
              } else {
                loggerWithChild({ email: jobData.email ?? "" }).info(
                  `Fetching messages since last sync for channel ${channel.name || channel.id}`,
                )
                const messagesChanged = await insertChannelMessages(
                  email,
                  client,
                  channel.id!,
                  abortController,
                  memberMap,
                  tracker,
                  lastSyncTimestamp.toString(),
                  channelMap,
                )
                changeExist = changeExist || messagesChanged
              }

              // Always update the document in Vespa regardless of whether it's new or existing
              vespaChatContainer.lastSyncedAt = new Date().getTime()

              await UpdateDocument(
                chatContainerSchema,
                channel.id,
                vespaChatContainer,
              )

              // Mark this channel as synced
              syncedChannels.add(channel.id)
            } catch (error) {
              loggerWithChild({ email: jobData.email ?? "" }).error(
                `Error processing channel ${channel.id}: ${error}`,
              )
            }
          }),
        )

        await Promise.all(channelProcessingPromises)

        // Update sync job with new timestamp if changes were found
        if (changeExist) {
          config = {
            updatedAt: new Date(),
            type: "updatedAt",
          }

          await db.transaction(async (trx) => {
            await updateSyncJob(trx, syncJob.id, {
              config: config,
              lastRanOn: new Date(),
              status: SyncJobStatus.Successful,
            })
            await insertSyncHistory(trx, {
              workspaceId: syncJob.workspaceId,
              workspaceExternalId: syncJob.workspaceExternalId,
              dataAdded: jobStats.added,
              dataDeleted: jobStats.removed, // Assuming stats object tracks removals if applicable
              dataUpdated: jobStats.updated,
              authType: AuthType.OAuth,
              summary: { description: "Changes Exist in the slack" },
              errorMessage: "", // Add details on failure
              app: Apps.Slack,
              status: SyncJobStatus.Successful,
              config: {
                updatedAt: config.updatedAt.toISOString(),
                type: config.type,
              },
              type: SyncCron.Partial,
              lastRanOn: jobStartTime,
            })
          })
          loggerWithChild({ email: jobData.email ?? "" }).info(
            `Changes successfully synced for Slack job ${syncJob.id}`,
          )
        } else {
          // Logger.info(`No changes to sync for Slack job ${syncJob.id}`);

          await db.transaction(async (trx) => {
            await updateSyncJob(trx, syncJob.id, {
              config: config,
              lastRanOn: new Date(),
              status: SyncJobStatus.Successful,
            })
            await insertSyncHistory(trx, {
              workspaceId: syncJob.workspaceId,
              workspaceExternalId: syncJob.workspaceExternalId,
              dataAdded: jobStats.added,
              dataDeleted: jobStats.removed, // Assuming stats object tracks removals if applicable
              dataUpdated: jobStats.updated,
              authType: AuthType.OAuth,
              summary: { description: "No changes Found in slack" },
              errorMessage: "", // Add details on failure
              app: Apps.Slack,
              status: SyncJobStatus.Successful,
              config: {
                updatedAt: config.updatedAt.toISOString(),
                type: config.type,
              },
              type: SyncCron.Partial,
              lastRanOn: jobStartTime,
            })
          })
        }
      } catch (error) {
        await db.transaction(async (trx) => {
          await updateSyncJob(trx, syncJob.id, {
            lastRanOn: new Date(),
            status: SyncJobStatus.Failed,
          })
          await insertSyncHistory(trx, {
            workspaceId: syncJob.workspaceId,
            workspaceExternalId: syncJob.workspaceExternalId,
            dataAdded: jobStats.added,
            dataDeleted: jobStats.removed, // Assuming stats object tracks removals if applicable
            dataUpdated: jobStats.updated,
            authType: AuthType.OAuth,
            summary: { description: `sync Job failed for ${syncJob.id}` },
            errorMessage: getErrorMessage(error), // Add details on failure
            app: Apps.Slack,
            status: SyncJobStatus.Failed,
            config: {
              updatedAt: config.updatedAt.toISOString(),
              type: config.type,
            },
            type: SyncCron.Partial,
            lastRanOn: jobStartTime,
          })
        })
      }
    }
  } catch (error) {
    loggerWithChild({ email: jobData.email ?? "" }).error(
      `Error in Slack sync: ${error}`,
    )
  }
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

const newStats = (): ChangeStats => {
  return {
    added: 0,
    removed: 0,
    updated: 0,
    summary: "",
  }
}

const mergeStats = (prev: ChangeStats, current: ChangeStats): ChangeStats => {
  prev.added += current.added
  prev.updated += current.updated
  prev.removed += current.removed
  prev.summary += `\n${current.summary}`
  return prev
}
