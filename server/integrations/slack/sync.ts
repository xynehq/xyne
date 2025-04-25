import { calendar_v3, drive_v3, gmail_v1, google, people_v1 } from "googleapis"
import type PgBoss from "pg-boss"
import { getOAuthConnectorWithCredentials } from "@/db/connector"
import { db } from "@/db/client"
import {
  Apps,
  AuthType,
  SyncJobStatus,
} from "@/shared/types"
import {
    connectors,
    type SelectConnector,
    type SlackOAuthIngestionState,
} from "@/db/schema"
import {
    Subsystem,
    type SlackConfig,
} from "@/types"
import { getAppSyncJobs, updateSyncJob } from "@/db/syncJob"
import {WebClient} from "@slack/web-api"
import {SlackConversationFiltering} from "@/integrations/slack/index"
import { getLogger } from "@/logger"
import {trackChannelChanges,fetchRecentMessages} from "@/integrations/slack/sync1"
import { GaxiosError } from "gaxios"
const Logger = getLogger(Subsystem.Integrations).child({ module: "google" })

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

import {
    chatContainerSchema,
    chatMessageSchema,
    chatTeamSchema,
    chatUserSchema,
    SlackEntity,
    type VespaChatContainer,
    type VespaChatMessage,
  } from "@/search/types"
import { insert, NAMESPACE, UpdateDocument,insertDocument,insertUser,ifDocumentsExist } from "@/search/vespa"
import { getAllUsers ,getConversationUsers,insertTeam,makeMemberTeamAndPermissionMap,safeConversationHistory,insertChatMessage} from "@/integrations/slack/index"
type SlackMessage = NonNullable<
  ConversationsHistoryResponse["messages"]
>[number]

const concurrency = 5

// ---------------------------

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


// -----------------------------

export const handleSlackChanges = async (
    boss: PgBoss,
    job: PgBoss.Job<any>,
  ) => {
    Logger.info("handleSlackChanges")
    
        const syncJobs = await getAppSyncJobs(db, Apps.Slack, AuthType.OAuth)
        if (!syncJobs || syncJobs.length === 0) {
            Logger.info("No Slack sync jobs found")
            return
        }
        const syncJob= syncJobs[0];
      
        const { connectorId, email } = syncJob;
        const connector = await getOAuthConnectorWithCredentials(
          db,
          connectorId
        )
        const { accessToken } = connector.oauthCredentials
        const client = new WebClient(accessToken);
        const data= {
            email: email,
            connectorId: connectorId,
            accessToken: accessToken,
            client: client,
        }
      try {
        let changeExist: boolean= false;
        let config: SlackConfig = syncJob.config as SlackConfig
        
        const conversationFiltering = await SlackConversationFiltering(client.token||"");
        // this is going to return the list of all the channel which are there
        // some channels exist and some channels do not exist
        // if that channel don't exist then insertDocuments in vespa
        // if that channel exist then we will check lastupdated time > curr sync timestamp we will update the documents  
        if(conversationFiltering==undefined){
            Logger.info("No channels found")
            return
        }
        const channelIds = conversationFiltering
        .filter(channel => channel.id !== undefined)
        .map(channel => channel.id!);

        const existenceResults = await ifDocumentsExist(channelIds);
        for (const channel of conversationFiltering) {
            try {
              if (!channel.id) {
                Logger.warn("Skipping channel without ID");
                continue;
              }
              
              const existenceInfo = existenceResults[channel.id];
              const channelExists = existenceInfo && existenceInfo.exists;

              if (!channelExists) {
                insertConversations([channel],new AbortController())
                changeExist = true;
              } else {
               
                const channelLastUpdated = channel.updated || channel.created || 0;
                const lastSyncTimestamp = Math.floor(config.updatedAt.getTime() / 1000);
                const vespaLastUpdated = existenceInfo?.updatedAt || 0;
                
                if (channelLastUpdated > lastSyncTimestamp || channelLastUpdated > vespaLastUpdated) {
                  Logger.info(`Updating existing channel: ${channel.name || channel.id}`);
                  
                  const vespaChatContainer: VespaChatContainer = {
                    docId: channel.id,
                    name: channel.name || '',
                    app: Apps.Slack,
                    creator: channel.creator || '',
                    isPrivate: channel.is_private || false,
                    isGeneral: channel.is_general || false,
                    isArchived: channel.is_archived || false,
                    isIm: channel.is_im || false,
                    isMpim: channel.is_mpim || false,
                    createdAt: channel.created || Math.floor(Date.now() / 1000),
                    updatedAt: channel.updated || Math.floor(Date.now() / 1000),
                    topic: channel.topic?.value || '',
                    description: channel.purpose?.value || '',
                    count: channel.num_members || 0,
                  };
                  
                  await UpdateDocument(
                    chatContainerSchema,
                    channel.id,
                    vespaChatContainer,
                    );
                }
                   else {
                  Logger.debug(`Channel unchanged since last sync: ${channel.name || channel.id}`);
                }
              }
            }
            catch (error) {
                Logger.error(`Error processing channel ${channel.id}: ${error}`);
            }
        }


// case Not Handled currently
// 1. If the channel is Deleted or archived then we will delete the document from vespa

         

// -------------------------------  -------------   ----------- -   --------    -   -   -   -   -   -   --  -   -


// first make the member and team and permission map
const { memberMap, teamMap, permissionMap } =
      await makeMemberTeamAndPermissionMap(
        data.email,
        client,
        conversationFiltering.map((c) => c.id!),
      )


    for(const channelId of channelIds) {
        let cursor: string | undefined = undefined
        const response: ConversationsHistoryResponse =
        await safeConversationHistory(client, channelId, cursor, Math.floor(config.updatedAt.getTime() / 1000).toString())
        const messageIds = response.messages
            ? response.messages
                .filter(msg => msg.type === 'message')
                .map(msg => msg.client_msg_id)
                .filter((id): id is string => id !== undefined)
            : [];
        
        const res = await ifDocumentsExist(messageIds);

        for (const message of response.messages || []) {
            if (message.type === 'message' && message.client_msg_id) {
               
                const messageExists = res[message.client_msg_id]?.exists || false;

                if (!messageExists) {
                    // Insert the new message into Vespa
                    await insertChatMessage(
                        data.email,
                        message,
                        channelId,
                        memberMap[message.user!].profile?.display_name!,
                        memberMap[message.user!].name!,
                        memberMap[message.user!].profile?.image_192!,
                        permissionMap[channelId] || [],
                    );
                    
                } else {
                    // Update the existing message in Vespa
                    const edited = message.edited?.ts || message.ts;
                    await UpdateDocument(
                        chatMessageSchema,
                        message.client_msg_id,
                        {
                            text: message.text,
                            updatedAt: edited,
                            reactions: message.reactions?.reduce((acc, curr) => {
                                return acc + (curr as Reaction).count! || 0
                            }, 0),
                        },
                    );
                }
            }
        }

    }
// now for each channel
// I have some TimeStamp T

// For each channel fetch the messages which occured after TimeStamp T
// Message Not present in vespa
// Insert that in chat_message vespa

// Message present in vespa
// there could be some messages which are edited 
// based on edited timestamp we will update the document









        const Changes:any=[];
        const Messages:any=[];
        console.log("newAddedConversations ");
        for (const conversation of conversationFiltering) {
            // console.log("conversation ",conversation);
          if (conversation.id) {
            const a= Date.parse(config.updatedAt.toString())/1000;
            console.log(conversation.id , " ", Math.floor(config.updatedAt.getTime() / 1000));
            const messages = await fetchRecentMessages(client, conversation.id, Math.floor(config.updatedAt.getTime() / 1000))
            console.log("Message ",messages);
            console.log("Changes", changes);
            if(changes && changes.length > 0 || messages && ( messages.editedMessages.length > 0 || messages.newMessages.length > 0)) {
              changeExist = true;
            }
            
          }
        } 
        console.log("Changes ",Changes);
        console.log("Messages ",Messages);















// --------`------------`--------`-`-`-`---`-`-`-`------------------`-`-`-`-`-`-`-`-`-`-`-`-`-`-`--`--`--`--`--`--`--`--`
        if (changeExist) { 
          config = {
            updatedAt: new Date(),
            type: "updatedAt",
          }
  
         
          await db.transaction(async (trx) => {
            await updateSyncJob(trx, syncJob.id, {
              config,
              lastRanOn: new Date(),
              status: SyncJobStatus.Successful,
            })
           
           
          })
          Logger.info(
            `Changes successfully synced for Slack}`,
          )
        } else {
          Logger.info(`No changes to sync`)
        }
      } catch (error) {
       
      }
    
}