import { type Context, Hono, type Next } from "hono"
import {
  AnswerApi,
  AutocompleteApi,
  autocompleteSchema,
  chatBookmarkSchema,
  chatDeleteSchema,
  chatHistorySchema,
  chatRenameSchema,
  chatTraceSchema,
  chatSchema,
  followUpQuestionsSchema,
  dashboardDataSchema,
  sharedAgentUsageSchema,
  messageRetrySchema,
  messageSchema,
  SearchApi,
  chatStopSchema,
  chatClarificationSchema,
  SearchSlackChannels,
  agentChatMessageSchema,
  chatTitleSchema,
  GetDriveItem,
  GetDriveItemsByDocIds,
  handleAttachmentDeleteSchema,
} from "@/api/search"
import { callNotificationService } from "@/services/callNotifications"
import {
  slackDocumentsApi,
  SlackEntitiesApi,
  slackListSchema,
  slackSearchSchema,
} from "@/api/slack"
import { zValidator } from "@hono/zod-validator"
import {
  addApiKeyConnectorSchema,
  addApiKeyMCPConnectorSchema,
  addServiceConnectionSchema,
  updateServiceConnectionSchema,
  addStdioMCPConnectorSchema,
  answerSchema,
  createOAuthProvider,
  deleteConnectorSchema,
  oauthStartQuerySchema,
  searchSchema,
  updateConnectorStatusSchema,
  updateToolsStatusSchema, // Added for tool status updates
  serviceAccountIngestMoreSchema,
  deleteUserDataSchema,
  ingestMoreChannelSchema,
  startSlackIngestionSchema,
  microsoftServiceSchema,
  UserRoleChangeSchema,
  chatIdParamSchema,
} from "@/types"
import {
  AddApiKeyConnector,
  AddApiKeyMCPConnector,
  AddServiceConnection,
  UpdateServiceConnection,
  CreateOAuthProvider,
  DeleteConnector,
  DeleteOauthConnector,
  GetConnectors,
  StartOAuth,
  AddStdioMCPConnector,
  UpdateConnectorStatus,
  ServiceAccountIngestMoreUsersApi,
  GetConnectorTools, // Added GetConnectorTools
  UpdateToolsStatusApi, // Added for tool status updates
  AdminDeleteUserData,
  GetProviders,
  GetAdminChats,
  GetAdminAgents,
  GetAdminUsers,
  GetUserAgentLeaderboard,
  GetAgentAnalysis,
  GetAgentFeedbackMessages,
  GetAgentUserFeedbackMessages,
  GetAllUserFeedbackMessages,
  adminQuerySchema,
  userAgentLeaderboardQuerySchema,
  agentAnalysisQuerySchema,
  AddServiceConnectionMicrosoft,
  UpdateUser,
  ListAllLoggedInUsers,
  ListAllIngestedUsers,
  GetKbVespaContent,
  GetChatQueriesApi,
} from "@/api/admin"
import { ProxyUrl } from "@/api/proxy"
import { initApiServerQueue } from "@/queue/api-server-queue"
import { createBunWebSocket } from "hono/bun"
import type { ServerWebSocket } from "bun"
import { googleAuth } from "@hono/oauth-providers/google"
import { jwt, verify } from "hono/jwt"
import type { JwtVariables } from "hono/jwt"
import { sign } from "hono/jwt"
import { db } from "@/db/client"
import { HTTPException } from "hono/http-exception"
import { createWorkspace, getWorkspaceByDomain } from "@/db/workspace"
import {
  createUser,
  deleteRefreshTokenFromDB,
  getPublicUserAndWorkspaceByEmail,
  getUserByEmail,
  saveRefreshTokenToDB,
} from "@/db/user"
import { getAppGlobalOAuthProvider } from "@/db/oauthProvider" // Import getAppGlobalOAuthProvider
import { getCookie } from "hono/cookie"
import { serveStatic } from "hono/bun"
import config from "@/config"
import { OAuthCallback } from "@/api/oauth"
import { deleteCookieByEnv, setCookieByEnv } from "@/utils"
import {
  validateAppleToken,
  extractUserInfoFromToken,
} from "@/utils/apple-auth"
import { getLogger, LogMiddleware } from "@/logger"
import { Subsystem } from "@/types"
import {
  GetUserWorkspaceInfo,
  GenerateUserApiKey,
  GetUserApiKeys,
  DeleteUserApiKey,
} from "@/api/auth"
import {
  getIngestionStatusSchema,
  cancelIngestionSchema,
  pauseIngestionSchema,
  resumeIngestionSchema,
} from "@/api/ingestion"
import { SearchWorkspaceUsersApi, searchUsersSchema } from "@/api/users"
import {
  InitiateCallApi,
  JoinCallApi,
  EndCallApi,
  LeaveCallApi,
  GetActiveCallsApi,
  GetCallHistoryApi,
  InviteToCallApi,
  initiateCallSchema,
  joinCallSchema,
  endCallSchema,
  leaveCallSchema,
  inviteToCallSchema,
  getCallHistorySchema,
} from "@/api/calls"
import {
  SendMessageApi,
  GetConversationApi,
  MarkMessagesAsReadApi,
  GetUnreadCountsApi,
  GetConversationParticipantsApi,
  EditMessageApi,
  DeleteMessageApi,
  sendMessageSchema,
  getConversationSchema,
  markAsReadSchema,
  editMessageSchema,
  deleteMessageSchema,
} from "@/api/directMessages"
import {
  CreateChannelApi,
  GetChannelDetailsApi,
  UpdateChannelApi,
  ArchiveChannelApi,
  GetUserChannelsApi,
  BrowsePublicChannelsApi,
  JoinChannelApi,
  AddChannelMembersApi,
  RemoveChannelMemberApi,
  UpdateMemberRoleApi,
  LeaveChannelApi,
  GetChannelMembersApi,
  DeleteChannelApi,
  SendChannelMessageApi,
  GetChannelMessagesApi,
  EditChannelMessageApi,
  DeleteChannelMessageApi,
  PinMessageApi,
  UnpinMessageApi,
  GetPinnedMessagesApi,
  createChannelSchema,
  updateChannelSchema,
  archiveChannelSchema,
  addMembersSchema,
  removeMemberSchema,
  updateMemberRoleSchema,
  leaveChannelSchema,
  sendChannelMessageSchema,
  getChannelMessagesSchema,
  editChannelMessageSchema,
  deleteChannelMessageSchema,
  pinMessageSchema,
  unpinMessageSchema,
  joinChannelSchema,
  getPinnedMessagesSchema,
  getChannelMembersSchema,
  getUserChannelsSchema,
  channelIdParamSchema,
} from "@/api/channels"
import {
  getThread,
  sendThreadReply,
  updateThreadReply,
  deleteThreadReply,
  getThreadSchema,
  sendThreadReplySchema,
  updateThreadReplySchema,
  deleteThreadReplySchema,
} from "@/api/threads"
import { AuthRedirectError, InitialisationError } from "@/errors"
import {
  ListDataSourcesApi,
  ListDataSourceFilesApi,
  DeleteDocumentApi,
  deleteDocumentSchema,
  GetAgentsForDataSourceApi,
  GetDataSourceFile,
} from "@/api/dataSource"
import {
  ChatBookmarkApi,
  ChatDeleteApi,
  ChatFavoritesApi,
  ChatHistory,
  ChatRenameApi,
  DashboardDataApi,
  SharedAgentUsageApi,
  GetChatApi,
  MessageApi,
  MessageFeedbackApi,
  EnhancedMessageFeedbackApi,
  MessageRetryApi,
  GetChatTraceApi,
  StopStreamingApi,
  GenerateFollowUpQuestionsApi,
  GetAvailableModelsApi,
  GenerateChatTitleApi,
} from "@/api/chat/chat"
import {
  CreateSharedChatApi,
  GetSharedChatApi,
  ListSharedChatsApi,
  DeleteSharedChatApi,
  CheckSharedChatApi,
  createSharedChatSchema,
  getSharedChatSchema,
  listSharedChatsSchema,
  deleteSharedChatSchema,
  checkSharedChatSchema,
} from "@/api/chat/sharedChat"
import {
  UserRole,
  Apps,
  CreateApiKeySchema,
  getDocumentSchema,
} from "@/shared/types" // Import Apps
import {
  wsConnections,
  sendWebsocketMessage,
} from "@/integrations/metricStream"

import {
  EvaluateHandler,
  ListDatasetsHandler,
  TuneDatasetHandler,
  TuningWsRoute,
  tuneDatasetSchema,
  DeleteDatasetHandler,
} from "@/api/tuning"
import {
  CreateAgentApi,
  ListAgentsApi,
  UpdateAgentApi,
  DeleteAgentApi,
  GetWorkspaceUsersApi,
  GetAgentPermissionsApi,
  GetAgentIntegrationItemsApi,
  createAgentSchema,
  listAgentsSchema,
  updateAgentSchema,
  GetAgentApi,
} from "@/api/agent"
import { GeneratePromptApi } from "@/api/agent/promptGeneration"
import {
  CreateWorkflowTemplateApi,
  CreateComplexWorkflowTemplateApi,
  ExecuteTemplateApi,
  ExecuteWorkflowWithInputApi,
  GetWorkflowTemplateApi,
  ListWorkflowTemplatesApi,
  UpdateWorkflowTemplateApi,
  CreateWorkflowExecutionApi,
  GetWorkflowExecutionApi,
  GetWorkflowExecutionStatusApi,
  ListWorkflowExecutionsApi,
  CreateWorkflowToolApi,
  GetWorkflowToolApi,
  ListWorkflowToolsApi,
  UpdateWorkflowToolApi,
  DeleteWorkflowToolApi,
  AddStepToWorkflowApi,
  DeleteWorkflowStepTemplateApi,
  UpdateWorkflowStepExecutionApi,
  CompleteWorkflowStepExecutionApi,
  SubmitFormStepApi,
  GetFormDefinitionApi,
  ServeWorkflowFileApi,
  GetGeminiModelEnumsApi,
  GetVertexAIModelEnumsApi,
  GetWorkflowUsersApi,
  TestJiraConnectionApi,
  RegisterJiraWebhookApi,
  GetJiraWebhooksApi,
  DeleteJiraWebhookApi,
  GetJiraMetadataApi,
  ReceiveJiraWebhookApi,
  createWorkflowTemplateSchema,
  createComplexWorkflowTemplateSchema,
  updateWorkflowTemplateSchema,
  createWorkflowExecutionSchema,
  updateWorkflowExecutionSchema,
  createWorkflowToolSchema,
  updateWorkflowStepExecutionSchema,
  formSubmissionSchema,
  listWorkflowExecutionsQuerySchema,
} from "@/api/workflow"
import {
  workflowTool,
  workflowStepTemplate,
  workflowTemplate,
  workflowExecution,
  workflowStepExecution,
} from "@/db/schema/workflows"
import {
  ToolType,
  WorkflowStatus,
  ToolExecutionStatus,
} from "@/types/workflowTypes"
import { sql, eq } from "drizzle-orm"
import metricRegister from "@/metrics/sharedRegistry"
import {
  handleAttachmentUpload,
  handleFileUpload,
  handleAttachmentServe,
  handleThumbnailServe,
  handleAttachmentDeleteApi,
} from "@/api/files"
import { z } from "zod" // Ensure z is imported if not already at the top for schemas
import {
  messageFeedbackSchema,
  enhancedMessageFeedbackSchema,
} from "@/api/chat/types"

import {
  CreateCollectionApi,
  ListCollectionsApi,
  GetCollectionApi,
  UpdateCollectionApi,
  DeleteCollectionApi,
  ListCollectionItemsApi,
  CreateFolderApi,
  UploadFilesApi,
  DeleteItemApi,
  GetFilePreviewApi,
  GetFileContentApi,
  DownloadFileApi,
  GetChunkContentApi,
  GetCollectionNameForSharedAgentApi,
  PollCollectionsStatusApi,
} from "@/api/knowledgeBase"
import {
  searchKnowledgeBaseSchema,
  SearchKnowledgeBaseApi,
} from "./api/knowledgeBase/search"

import {
  isSlackEnabled,
  startSocketMode,
  getSocketModeStatus,
} from "@/integrations/slack/client"
const { JwtPayloadKey } = config
import { updateMetricsFromThread } from "@/metrics/utils"

import {
  agents,
  apiKeys,
  channelMembers,
  users,
  type PublicUserWorkspace,
  updateWorkflowToolSchema,
  addStepToWorkflowSchema,
} from "./db/schema"
import { sendMailHelper } from "@/api/testEmail"
import { emailService } from "./services/emailService"
import { AgentMessageApi, ProvideClarificationApi } from "./api/chat/agents"
import {
  checkOverallSystemHealth,
  checkPaddleOCRHealth,
  checkPostgresHealth,
  checkVespaHealth,
} from "./health"
import {
  HealthStatusType,
  ServiceName,
  type HealthStatusResponse,
} from "@/health/type"
import WebhookHandler from "@/services/WebhookHandler"

// Define Zod schema for delete datasource file query parameters
const deleteDataSourceFileQuerySchema = z.object({
  dataSourceName: z.string().min(1),
  fileName: z.string().min(1),
})

export type Variables = JwtVariables

const clientId = process.env.GOOGLE_CLIENT_ID!
const clientSecret = process.env.GOOGLE_CLIENT_SECRET!
const redirectURI = config.redirectUri
const postOauthRedirect = config.postOauthRedirect

const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET!
const refreshTokenSecret = process.env.REFRESH_TOKEN_SECRET!

const AccessTokenCookieName = config.AccessTokenCookie
const RefreshTokenCookieName = "refresh-token"

const Logger = getLogger(Subsystem.Server)

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>()

const app = new Hono<{ Variables: Variables }>()

const internalMetricRouter = new Hono<{ Variables: Variables }>()

const AuthMiddleware = jwt({
  secret: accessTokenSecret,
  cookie: AccessTokenCookieName,
})

// Middleware to check if user has admin or superAdmin role
const AdminRoleMiddleware = async (c: Context, next: Next) => {
  const { sub } = c.get(JwtPayloadKey)
  const user = await getUserByEmail(db, sub)
  if (!user.length) {
    throw new HTTPException(403, {
      message: `Access denied. user with email ${sub} does not exist.`,
    })
  }
  const userRole = user[0].role
  if (userRole !== UserRole.Admin && userRole !== UserRole.SuperAdmin) {
    throw new HTTPException(403, {
      message: "Access denied. Admin privileges required.",
    })
  }

  await next()
}

const ApiKeyMiddleware = async (c: Context, next: Next) => {
  let apiKey: string
  try {
    // Extract API key from request body
    apiKey = c.req.header("x-api-key") || (c.req.query("api_key") as string)

    if (!apiKey) {
      Logger.error(
        "API key verification failed: Missing apiKey in request body",
      )
      throw new HTTPException(401, {
        message: "Missing API key. Please provide apiKey in request body.",
      })
    }
    // Decrypt and validate the API key
    const [foundApiKey] = await db
      .select({
        workspaceId: apiKeys.workspaceId,
        userId: apiKeys.userId,
        userEmail: users.email,
        config: apiKeys.config,
      })
      .from(apiKeys)
      .leftJoin(users, eq(apiKeys.userId, users.externalId)) // or users.externalId depending on your schema
      .where(eq(apiKeys.key, apiKey))
      .limit(1)

    if (!foundApiKey) {
      throw new HTTPException(400, {
        message: "Invalid API KEY",
      })
    }
    c.set("apiKey", apiKey)
    c.set("workspaceId", foundApiKey.workspaceId)
    c.set("userEmail", foundApiKey.userEmail)
    c.set("config", foundApiKey.config)

    Logger.info(`API key verified for workspace ID: ${foundApiKey.workspaceId}`)

    await next()
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error
    }
    Logger.warn("API key verification failed: Invalid JSON body")
    throw new HTTPException(400, {
      message: "Invalid API KEY",
    })
  }
}

// Middleware for frontend routes
// Checks if there is token in cookie or not
// If there is token, verify it is valid or not
// Redirect to auth page if no token or invalid token
const AuthRedirect = async (c: Context, next: Next) => {
  const authToken = getCookie(c, AccessTokenCookieName)

  // If no auth token is found
  if (!authToken) {
    Logger.warn("Redirected by server - No AuthToken")
    // Redirect to login page if no token found
    return c.redirect(`/auth`)
  }

  try {
    // Verify the token if available
    await AuthMiddleware(c, next)
  } catch (err) {
    Logger.error(
      err,
      `${new AuthRedirectError({ cause: err as Error })} ${
        (err as Error).stack
      }`,
    )
    Logger.warn("Redirected by server - Error in AuthMW")
    // Redirect to auth page if token invalid
    return c.redirect(`/auth`)
  }
}

const honoMiddlewareLogger = LogMiddleware(Subsystem.Server)

export const WsApp = app.get(
  "/ws",
  upgradeWebSocket((c) => {
    let connectorId: string | undefined
    return {
      onOpen(event, ws) {
        connectorId = c.req.query("id")
        Logger.info(`Websocket connection with id ${connectorId}`)
        wsConnections.set(connectorId, ws)
      },
      onMessage(event, ws) {
        Logger.info(`Message from client: ${event.data}`)
        ws.send(JSON.stringify({ message: "Hello from server!" }))
      },
      onClose: (event, ws) => {
        Logger.info("Connection closed")
        if (connectorId) {
          wsConnections.delete(connectorId)
        }
      },
    }
  }),
)

// const MobileWebSocketAuthMiddleware = async (c: Context, next: any) => {
//   // First try cookie-based auth (for web)
//   try {
//     const cookieToken =
//       getCookie(c, "access_token") || getCookie(c, "accessToken")
//     if (cookieToken) {
//       const decoded = await verify(cookieToken, accessTokenSecret)
//       c.set(JwtPayloadKey, decoded)
//       return await next()
//     }
//   } catch (error) {
//     // Cookie auth failed, try query parameter (for mobile)
//   }

//   // Try query parameter auth (for mobile)
//   const queryToken = c.req.query("token")
//   if (!queryToken) {
//     return c.text("Unauthorized: No token provided", 401)
//   }

//   try {
//     const decoded = await verify(queryToken, accessTokenSecret)
//     c.set(JwtPayloadKey, decoded)
//     await next()
//   } catch (error) {
//     Logger.error("WebSocket authentication failed:", error)
//     return c.text("Unauthorized: Invalid token", 401)
//   }
// }

// WebSocket endpoint for call notifications
export const CallNotificationWs = app.get(
  "/ws/calls",
  // MobileWebSocketAuthMiddleware,
  AuthMiddleware,
  upgradeWebSocket((c) => {
    const payload = c.get(JwtPayloadKey)
    const userEmail = payload.sub
    let userId: string | undefined

    return {
      async onOpen(event, ws) {
        // Get user details from database
        const user = await getUserByEmail(db, userEmail)
        if (user.length > 0) {
          userId = user[0].externalId
          // Register user for call notifications
          callNotificationService.registerUser(userId, ws)
          Logger.info(`User ${userId} connected for call notifications`)
        }
      },
      async onMessage(event, ws) {
        try {
          const message = JSON.parse(event.data.toString())
          Logger.info(`Call notification message from user ${userId}:`, message)

          // Handle different message types (accept call, reject call, typing indicator, etc.)
          switch (message.type) {
            case "call_response":
              // Handle call acceptance/rejection
              if (message.callId && message.response) {
                callNotificationService.notifyCallStatus(
                  message.callerId,
                  message.response,
                  { callId: message.callId, targetUserId: userId },
                )
              }
              break
            case "typing_indicator":
              // Handle typing indicator
              if (
                userId &&
                message.targetUserId &&
                typeof message.isTyping === "boolean"
              ) {
                callNotificationService.sendTypingIndicator(
                  message.targetUserId,
                  message.isTyping,
                  userId,
                )
              }
              break
            case "channel_typing_indicator":
              // Handle channel typing indicator - derive recipients server-side
              if (
                userId &&
                message.channelId &&
                typeof message.isTyping === "boolean"
              ) {
                const members = await db
                  .select({ externalId: users.externalId })
                  .from(channelMembers)
                  .innerJoin(users, eq(channelMembers.userId, users.id))
                  .where(eq(channelMembers.channelId, message.channelId))
                const targets = members
                  .map((m) => m.externalId)
                  .filter((externalId) => externalId !== userId)
                callNotificationService.sendChannelTypingIndicator(
                  targets,
                  message.channelId,
                  userId,
                  message.isTyping,
                )
              }
              break
          }
        } catch (error) {
          Logger.error(`Error parsing call notification message: ${error}`)
        }
      },
      onClose: (event, ws) => {
        if (userId) {
          callNotificationService.removeUser(userId)
        }
        Logger.info(`Call notification connection closed for user ${userId}`)
      },
    }
  }),
)

const clearCookies = (c: Context) => {
  const opts = {
    secure: true,
    path: "/",
    httpOnly: true,
  }
  deleteCookieByEnv(c, AccessTokenCookieName, opts)
  deleteCookieByEnv(c, RefreshTokenCookieName, opts)
  Logger.info("Cookies deleted")
}

const LogOut = async (c: Context) => {
  const accessToken = getCookie(c, AccessTokenCookieName)
  const refreshToken = getCookie(c, RefreshTokenCookieName)

  if (!accessToken || !refreshToken) {
    Logger.warn("No tokens found during logout")
    clearCookies(c)
    return c.redirect(`/auth`)
  }

  try {
    const { payload } = await verify(refreshToken, refreshTokenSecret)
    const { sub, workspaceId } = payload as { sub: string; workspaceId: string }
    const email = sub
    const userAndWorkspace: PublicUserWorkspace =
      await getPublicUserAndWorkspaceByEmail(db, workspaceId, email)

    const existingUser = userAndWorkspace?.user
    if (existingUser) {
      await deleteRefreshTokenFromDB(db, existingUser.email)
      Logger.info("Deleted refresh token from DB")
    } else {
      Logger.warn("User not found during logout")
    }
  } catch (err) {
    Logger.error("Error during logout token verify or DB operation", err)
  } finally {
    clearCookies(c)
    Logger.info("Logged out, redirecting to /auth")
    return c.redirect(`/auth`)
  }
}

// Update Metrics From Script
const handleUpdatedMetrics = async (c: Context) => {
  Logger.info(`Started Adding Metrics`)

  const authHeader = c.req.raw.headers.get("authorization") ?? ""
  const secret = authHeader.replace(/^Bearer\s+/i, "").trim()

  if (secret !== process.env.METRICS_SECRET) {
    Logger.warn("Unauthorized metrics update attempt")
    return c.text("Unauthorized", 401)
  }

  const body = await c.req.json()
  const {
    email,
    messageCount,
    attachmentCount,
    failedMessages,
    failedAttachments,
    totalMails,
    skippedMail,
    eventsCount,
    contactsCount,
    pdfCount,
    docCount,
    sheetsCount,
    slidesCount,
    fileCount,
    totalDriveFiles,
    blockedPdfs,
  } = body
  await updateMetricsFromThread({
    email,
    messageCount,
    attachmentCount,
    failedMessages,
    failedAttachments,
    totalMails,
    skippedMail,
    eventsCount,
    contactsCount,
    pdfCount,
    docCount,
    sheetsCount,
    slidesCount,
    fileCount,
    totalDriveFiles,
    blockedPdfs,
  })
}

internalMetricRouter.post("/update-metrics", handleUpdatedMetrics)

// App validatione endpoint

const handleAppValidation = async (c: Context) => {
  const authHeader = c.req.header("Authorization")

  if (!authHeader) {
    throw new HTTPException(401, {
      message: "Missing Authorization header",
    })
  }

  if (!authHeader.startsWith("Bearer ")) {
    throw new HTTPException(400, { message: "Malformed Authorization header" })
  }

  const token = authHeader.slice("Bearer ".length).trim()

  const userInfoRes = await fetch(
    "https://www.googleapis.com/oauth2/v3/userinfo",
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  )
  if (!userInfoRes.ok) {
    throw new HTTPException(401, {
      message: "Invalid or expired token",
    })
  }

  const user = await userInfoRes.json()

  const email = user?.email
  if (!email) {
    throw new HTTPException(400, {
      message: "Could not get the email of the user",
    })
  }

  if (!user?.email_verified) {
    throw new HTTPException(403, { message: "User email is not verified" })
  }
  // hosted domain
  // @ts-ignore
  let domain = user.hd
  if (!domain && email) {
    domain = email.split("@")[1]
  }
  const name = user?.name || user?.given_name || user?.family_name || ""
  const photoLink = user?.picture || ""

  const existingUserRes = await getUserByEmail(db, email)

  // if user exists then workspace exists too
  if (existingUserRes && existingUserRes.length) {
    Logger.info(
      {
        requestId: c.var.requestId, // Access the request ID
        user: {
          email: user.email,
          name: user.name,
          verified_email: user.email_verified,
        },
      },
      "User found and authenticated",
    )
    const existingUser = existingUserRes[0]
    const workspaceId = existingUser.workspaceExternalId

    const accessToken = await generateTokens(
      user.email,
      existingUser.role,
      existingUser.workspaceExternalId,
    )
    const refreshToken = await generateTokens(
      user.email,
      existingUser.role,
      existingUser.workspaceExternalId,
      true,
    )
    // save refresh token generated in user schema
    await saveRefreshTokenToDB(db, email, refreshToken)

    return c.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      workspace_id: workspaceId,
    })
  }
  Logger.error(`No existing user found`)
  return c.json(
    {
      success: false,
      message: "User is not provisioned / access forbidden",
    },
    403,
  )
}

// Apple Sign-In validation endpoint
const handleAppleAppValidation = async (c: Context) => {
  const authHeader = c.req.header("Authorization")
  const body = await c.req.json()

  if (!authHeader) {
    throw new HTTPException(401, {
      message: "Missing Authorization header",
    })
  }

  if (!authHeader.startsWith("Bearer ")) {
    throw new HTTPException(400, { message: "Malformed Authorization header" })
  }

  const identityToken = authHeader.slice("Bearer ".length).trim()

  try {
    const expectedAudience = config.appleBundleId

    if (!expectedAudience) {
      throw new HTTPException(500, {
        message: "Apple Bundle ID is not configured",
      })
    }

    // Validate the Apple identity token
    const tokenClaims = await validateAppleToken(
      identityToken,
      expectedAudience,
    )

    // Extract user information from token and request body
    const userInfo = extractUserInfoFromToken(tokenClaims, {
      name: body.fullName
        ? {
            firstName: body.fullName.givenName,
            lastName: body.fullName.familyName,
          }
        : body.user?.name,
    })

    const email = tokenClaims?.email

    if (!email) {
      throw new HTTPException(400, {
        message: "Could not extract email from Apple token or request body",
      })
    }

    // Check if email is verified (Apple tokens should always have verified emails)
    if (!userInfo.emailVerified) {
      throw new HTTPException(403, {
        message: "Apple ID email is not verified",
      })
    }

    // Extract domain from email
    const emailParts = email.split("@")
    if (emailParts.length !== 2) {
      throw new HTTPException(400, { message: "Invalid email format" })
    }
    let domain = emailParts[1]

    const name =
      userInfo.name || userInfo.givenName || userInfo.familyName || ""

    Logger.info(
      {
        requestId: c.var.requestId,
        user: {
          id: userInfo.id,
          email: email,
          email_verified: userInfo.emailVerified,
          name: name,
        },
      },
      "Apple Sign-In token validated successfully",
    )

    // Check if user already exists
    const existingUserRes = await getUserByEmail(db, email)

    // if user exists then workspace exists too
    if (existingUserRes && existingUserRes.length) {
      Logger.info(
        {
          requestId: c.var.requestId,
          user: {
            email: email,
            name: name,
            verified_email: userInfo.emailVerified,
          },
        },
        "Existing user found and authenticated with Apple Sign-In",
      )

      const existingUser = existingUserRes[0]
      const workspaceId = existingUser.workspaceExternalId

      const accessToken = await generateTokens(
        email,
        existingUser.role,
        existingUser.workspaceExternalId,
      )
      const refreshToken = await generateTokens(
        email,
        existingUser.role,
        existingUser.workspaceExternalId,
        true,
      )

      // Save refresh token to database
      await saveRefreshTokenToDB(db, email, refreshToken)

      return c.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        workspace_id: workspaceId,
        user: {
          id: userInfo.id,
          email: email,
          name: name,
          apple_user_id: userInfo.id,
        },
      })
    }

    // check if workspace exists
    // just create the user
    const existingWorkspaceRes = await getWorkspaceByDomain(domain)
    if (existingWorkspaceRes && existingWorkspaceRes.length) {
      Logger.info("Workspace found, creating user for Apple Sign-In")
      const existingWorkspace = existingWorkspaceRes[0]
      const [user] = await createUser(
        db,
        existingWorkspace.id,
        email,
        name,
        "",
        UserRole.User,
        existingWorkspace.externalId,
      )

      const accessToken = await generateTokens(
        user.email,
        user.role,
        user.workspaceExternalId,
      )
      const refreshToken = await generateTokens(
        user.email,
        user.role,
        user.workspaceExternalId,
        true,
      )
      // save refresh token generated in user schema
      await saveRefreshTokenToDB(db, email, refreshToken)
      const emailSent = await emailService.sendWelcomeEmail(
        user.email,
        user.name,
      )
      if (emailSent) {
        Logger.info(`Welcome email sent to ${user.email} and ${user.name}`)
      }

      return c.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        workspace_id: user.workspaceExternalId,
        user: {
          id: userInfo.id,
          email: user.email,
          name: user.name,
          apple_user_id: userInfo.id,
        },
      })
    }

    // we could not find the user and the workspace
    // creating both
    Logger.info("Creating workspace and user for Apple Sign-In")
    const userAcc = await db.transaction(async (trx) => {
      const [workspace] = await createWorkspace(trx, email, domain)
      const [user] = await createUser(
        trx,
        workspace.id,
        email,
        name,
        "",
        UserRole.SuperAdmin,
        workspace.externalId,
      )
      return user
    })

    const accessToken = await generateTokens(
      userAcc.email,
      userAcc.role,
      userAcc.workspaceExternalId,
    )
    const refreshToken = await generateTokens(
      userAcc.email,
      userAcc.role,
      userAcc.workspaceExternalId,
      true,
    )
    // save refresh token generated in user schema
    await saveRefreshTokenToDB(db, email, refreshToken)
    const emailSent = await emailService.sendWelcomeEmail(
      userAcc.email,
      userAcc.name,
    )
    if (emailSent) {
      Logger.info(
        `Welcome email sent to new workspace creator ${userAcc.email}`,
      )
    }

    return c.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      workspace_id: userAcc.workspaceExternalId,
      user: {
        id: userInfo.id,
        email: userAcc.email,
        name: userAcc.name,
        apple_user_id: userInfo.id,
      },
    })
  } catch (error) {
    Logger.error(
      {
        requestId: c.var.requestId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Apple Sign-In validation failed",
    )

    if (error instanceof HTTPException) {
      throw error
    }

    throw new HTTPException(401, {
      message: "Apple Sign-In validation failed",
    })
  }
}

const handleAppRefreshToken = async (c: Context) => {
  let body
  try {
    body = await c.req.json()
  } catch {
    Logger.warn("Failed to parse JSON body")
    return c.json({ msg: "Invalid request" }, 400)
  }

  const refreshToken =
    typeof body.refreshToken === "string" ? body.refreshToken : undefined

  if (!refreshToken) {
    Logger.warn("No refresh token provided")
    return c.json({ msg: "Missing refresh token" }, 401)
  }

  let payload: Record<string, unknown>
  try {
    payload = await verify(refreshToken, refreshTokenSecret)
  } catch (err) {
    Logger.warn("Invalid or expired refresh token", err)
    return c.json({ msg: "Invalid or expired refresh token" }, 401)
  }

  const { sub: email, workspaceId } = payload as {
    sub: string
    workspaceId: string
  }

  const uw = await getPublicUserAndWorkspaceByEmail(db, workspaceId, email)
  if (!uw?.user || !uw?.workspace) {
    Logger.warn("No user/workspace for token payload", { email, workspaceId })
    return c.json({ msg: "Unauthorized" }, 401)
  }
  const existingUser = uw.user

  if (existingUser.refreshToken !== refreshToken) {
    Logger.warn("Refresh token mismatch", { email })
    return c.json({ msg: "Unauthorized" }, 401)
  }

  try {
    const newAccessToken = await generateTokens(
      existingUser.email,
      existingUser.role,
      existingUser.workspaceExternalId,
    )
    const newRefreshToken = await generateTokens(
      existingUser.email,
      existingUser.role,
      existingUser.workspaceExternalId,
      true,
    )

    await saveRefreshTokenToDB(db, existingUser.email, newRefreshToken)
    Logger.info("Mobile tokens refreshed", { email })
    return c.json(
      {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      },
      200,
    )
  } catch (err) {
    Logger.error("Error generating tokens", err)
    return c.json({ msg: "Internal server error" }, 500)
  }
}

const getNewAccessRefreshToken = async (c: Context) => {
  const refreshToken = getCookie(c, RefreshTokenCookieName)

  const clearAndRedirect = () => {
    clearCookies(c)
    Logger.warn("Cleared tokens and redirecting to /auth")
    return c.redirect(`/auth`)
  }

  if (!refreshToken) {
    Logger.warn("No refresh token found")
    return clearAndRedirect()
  }

  let payload
  try {
    payload = await verify(refreshToken, refreshTokenSecret)
  } catch (err) {
    Logger.warn("Failed to verify refresh token", err)
    return clearAndRedirect()
  }

  const { sub, workspaceId } = payload as { sub: string; workspaceId: string }
  const email = sub
  const userAndWorkspace: PublicUserWorkspace =
    await getPublicUserAndWorkspaceByEmail(db, workspaceId, email)

  const existingUser = userAndWorkspace?.user
  const existingWorkspace = userAndWorkspace?.workspace

  if (!existingUser || !existingWorkspace) {
    Logger.warn("User or workspace not found for refresh token")
    return clearAndRedirect()
  }

  // Check if the refresh token matches the one in DB
  if (existingUser.refreshToken !== refreshToken) {
    Logger.warn("Refresh token does not match DB")
    return clearAndRedirect()
  }

  try {
    const newAccessToken = await generateTokens(
      existingUser.email,
      existingUser.role,
      existingUser.workspaceExternalId,
    )
    const newRefreshToken = await generateTokens(
      existingUser.email,
      existingUser.role,
      existingUser.workspaceExternalId,
      true,
    )
    // Save new refresh token in DB
    await saveRefreshTokenToDB(db, email, newRefreshToken)
    const opts = {
      secure: true,
      path: "/",
      httpOnly: true,
    }
    setCookieByEnv(c, AccessTokenCookieName, newAccessToken, opts)
    setCookieByEnv(c, RefreshTokenCookieName, newRefreshToken, opts)
    Logger.info("Both tokens refreshed successfully")
    return c.json({
      msg: "Access Token refreshed",
    })
  } catch (err) {
    Logger.error("Error generating new tokens", err)
    return clearAndRedirect()
  }
}

// Initialize webhook handler on startup
const webhookHandler = WebhookHandler
webhookHandler.initialize()

// Dynamic webhook handler
app.all("/workflow/webhook/*", async (c) => {
  return await webhookHandler.handleWebhookRequest(c)
})

// API endpoint to reload webhooks
app.get("/workflow/webhook-api/reload", async (c) => {
  try {
    const result = await webhookHandler.reloadWebhooks()
    return c.json(result)
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    )
  }
})

// API endpoint to list registered webhooks
app.get("/workflow/webhook-api/list", async (c) => {
  try {
    const result = webhookHandler.listWebhooks()
    return c.json(result)
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    )
  }
})

// Jira webhook endpoints (public - no auth required) - placed at top level outside AuthMiddleware
app.post("/api/v1/webhook/jira/:webhookId", ReceiveJiraWebhookApi)
app.post("/api/v1/webhook-test/jira/:webhookId", ReceiveJiraWebhookApi)

export const AppRoutes = app
  .basePath("/api/v1")
  .post("/validate-token", handleAppValidation)
  .post("/validate-apple-token", handleAppleAppValidation)
  .post("/app-refresh-token", handleAppRefreshToken) // To refresh the access token for mobile app
  .post("/refresh-token", getNewAccessRefreshToken)
  .use("*", AuthMiddleware)
  .use("*", honoMiddlewareLogger)
  .post(
    "/autocomplete",
    zValidator("json", autocompleteSchema),
    AutocompleteApi,
  )
  .post("files/upload", handleFileUpload)
  .post("/files/upload-attachment", handleAttachmentUpload)
  .get("/attachments/:fileId", handleAttachmentServe)
  .get("/attachments/:fileId/thumbnail", handleThumbnailServe)
  .post(
    "/files/delete",
    zValidator("json", handleAttachmentDeleteSchema),
    handleAttachmentDeleteApi,
  )
  .post("/chat", zValidator("json", chatSchema), GetChatApi)
  .post(
    "/chat/generateTitle",
    zValidator("json", chatTitleSchema),
    GenerateChatTitleApi,
  )
  .post(
    "/chat/bookmark",
    zValidator("json", chatBookmarkSchema),
    ChatBookmarkApi,
  )
  .post("/chat/rename", zValidator("json", chatRenameSchema), ChatRenameApi)
  .post("/chat/delete", zValidator("json", chatDeleteSchema), ChatDeleteApi)
  .post("/chat/stop", zValidator("json", chatStopSchema), StopStreamingApi)
  .post(
    "/chat/clarification",
    zValidator("json", chatClarificationSchema),
    ProvideClarificationApi,
  )
  .get("/chat/history", zValidator("query", chatHistorySchema), ChatHistory)
  .get(
    "/chat/favorites",
    zValidator("query", chatHistorySchema),
    ChatFavoritesApi,
  )
  .get(
    "/chat/dashboard-data",
    zValidator("query", dashboardDataSchema),
    DashboardDataApi,
  )
  .get(
    "/chat/shared-agent-usage",
    zValidator("query", sharedAgentUsageSchema),
    SharedAgentUsageApi,
  )
  .get("/chat/trace", zValidator("query", chatTraceSchema), GetChatTraceApi)
  .post(
    "/chat/followup-questions",
    zValidator("json", followUpQuestionsSchema),
    GenerateFollowUpQuestionsApi,
  )
  .get("/chat/models", GetAvailableModelsApi)
  // Shared chat routes
  .post(
    "/chat/share/create",
    zValidator("json", createSharedChatSchema),
    CreateSharedChatApi,
  )
  .get(
    "/chat/share",
    zValidator("query", getSharedChatSchema),
    GetSharedChatApi,
  )
  .get(
    "/chat/shares",
    zValidator("query", listSharedChatsSchema),
    ListSharedChatsApi,
  )
  .get(
    "/chat/share/check",
    zValidator("query", checkSharedChatSchema),
    CheckSharedChatApi,
  )
  .delete(
    "/chat/share/delete",
    zValidator("json", deleteSharedChatSchema),
    DeleteSharedChatApi,
  )
  // this is event streaming end point
  .get("/message/create", zValidator("query", messageSchema), MessageApi)
  .get(
    "/message/retry",
    zValidator("query", messageRetrySchema),
    MessageRetryApi,
  )
  .post(
    "/message/feedback",
    zValidator("json", messageFeedbackSchema),
    MessageFeedbackApi,
  )
  .post(
    "/message/feedback/enhanced",
    zValidator("json", enhancedMessageFeedbackSchema),
    EnhancedMessageFeedbackApi,
  )
  .get("/search", zValidator("query", searchSchema), SearchApi)
  .get(
    "/search/slack-channels",
    zValidator("query", searchSchema),
    SearchSlackChannels,
  )
  // Slack Entity API routes
  .get("/slack/entities", SlackEntitiesApi)
  .get("/slack/documents", slackDocumentsApi)
  .get("/me", GetUserWorkspaceInfo)
  .get("/users/api-keys", GetUserApiKeys)
  .post(
    "/users/api-key",
    zValidator("json", CreateApiKeySchema),
    GenerateUserApiKey,
  )
  .delete("/users/api-keys/:keyId", DeleteUserApiKey)
  .get("/datasources", ListDataSourcesApi)
  .get("/datasources/:docId", GetDataSourceFile)
  .get("/datasources/:dataSourceName/files", ListDataSourceFilesApi)
  .get("/datasources/:dataSourceId/agents", GetAgentsForDataSourceApi)
  .get("/proxy/:url", ProxyUrl)
  .get("/answer", zValidator("query", answerSchema), AnswerApi)
  .post(
    "/search/document/delete",
    zValidator("json", deleteDocumentSchema),
    DeleteDocumentApi,
  )
  .post("/search/driveitem", GetDriveItem)
  .post("/search/driveitemsbydocids", GetDriveItemsByDocIds)
  .post("/tuning/evaluate", EvaluateHandler)
  .get("/tuning/datasets", ListDatasetsHandler)
  .post(
    "/tuning/tuneDataset",
    zValidator("json", tuneDatasetSchema),
    TuneDatasetHandler,
  )
  .delete("/tuning/datasets/:filename", DeleteDatasetHandler)
  .get("/tuning/ws/:jobId", TuningWsRoute)

  // Workflow Routes
  .post(
    "/workflow/templates",
    zValidator("json", createWorkflowTemplateSchema),
    CreateWorkflowTemplateApi,
  )
  .post(
    "/workflow/templates/complex",
    zValidator("json", createComplexWorkflowTemplateSchema),
    CreateComplexWorkflowTemplateApi,
  )
  .get("/workflow/templates", ListWorkflowTemplatesApi)
  .get("/workflow/templates/:templateId", GetWorkflowTemplateApi)
  .get("/workflow/templates/:templateId/permissions",GetWorkflowUsersApi)
  .put(
    "/workflow/templates/:templateId",
    zValidator("json", updateWorkflowTemplateSchema),
    UpdateWorkflowTemplateApi,
  )
  .post("/workflow/templates/:templateId/execute", ExecuteTemplateApi)
  .post(
    "/workflow/templates/:templateId/execute-with-input",
    ExecuteWorkflowWithInputApi,
  )
  .post(
    "/workflow/templates/:templateId/steps",
    zValidator("json", addStepToWorkflowSchema),
    AddStepToWorkflowApi,
  )
  .post(
    "/workflow/executions",
    zValidator("json", createWorkflowExecutionSchema),
    CreateWorkflowExecutionApi,
  )
  .get(
    "/workflow/executions",
    zValidator("query", listWorkflowExecutionsQuerySchema),
    ListWorkflowExecutionsApi,
  )
  .get("/workflow/executions/:executionId", GetWorkflowExecutionApi)
  .get(
    "/workflow/executions/:executionId/status",
    GetWorkflowExecutionStatusApi,
  )
  .post(
    "/workflow/tools",
    zValidator("json", createWorkflowToolSchema),
    CreateWorkflowToolApi,
  )
  .get("/workflow/tools", ListWorkflowToolsApi)
  .get("/workflow/tools/:toolId", GetWorkflowToolApi)
  .put(
    "/workflow/tools/:toolId",
    zValidator("json", updateWorkflowToolSchema),
    UpdateWorkflowToolApi,
  )
  .delete("/workflow/tools/:toolId", DeleteWorkflowToolApi)
  .post("/workflow/tools/jira/test-connection", TestJiraConnectionApi)
  .post("/workflow/tools/jira/register-webhook", RegisterJiraWebhookApi)
  .post("/workflow/tools/jira/webhooks", GetJiraWebhooksApi)
  .post("/workflow/tools/jira/delete-webhook", DeleteJiraWebhookApi)
  .post("/workflow/tools/jira/metadata", GetJiraMetadataApi)
  // Webhook routes moved to before AuthMiddleware (lines 892-893)
  .delete("/workflow/steps/:stepId", DeleteWorkflowStepTemplateApi)
  .put(
    "/workflow/steps/:stepId",
    zValidator("json", updateWorkflowStepExecutionSchema),
    UpdateWorkflowStepExecutionApi,
  )
  .post("/workflow/steps/:stepId/complete", CompleteWorkflowStepExecutionApi)
  .get("/workflow/steps/:stepId/form", GetFormDefinitionApi)
  .post("/workflow/steps/submit-form", SubmitFormStepApi)
  .get("/workflow/files/:fileId", ServeWorkflowFileApi)
  .get("/workflow/models/gemini", GetGeminiModelEnumsApi)
  .get("/workflow/models/vertexai", GetVertexAIModelEnumsApi)

  // Agent Routes
  .post("/agent/create", zValidator("json", createAgentSchema), CreateAgentApi)
  .get("/agent/generate-prompt", GeneratePromptApi)
  .get("/agents", zValidator("query", listAgentsSchema), ListAgentsApi)
  .get("/agent/:agentExternalId", GetAgentApi)
  .get("/workspace/users", GetWorkspaceUsersApi)
  .get(
    "/workspace/users/search",
    zValidator("query", searchUsersSchema),
    SearchWorkspaceUsersApi,
  )
  // Call routes
  .post(
    "/calls/initiate",
    zValidator("json", initiateCallSchema),
    InitiateCallApi,
  )
  .post(
    "/calls/invite",
    zValidator("json", inviteToCallSchema),
    InviteToCallApi,
  )
  .post("/calls/join", zValidator("json", joinCallSchema), JoinCallApi)
  .post("/calls/end", zValidator("json", endCallSchema), EndCallApi)
  .post("/calls/leave", zValidator("json", leaveCallSchema), LeaveCallApi)
  .get("/calls/active", GetActiveCallsApi)
  .get(
    "/calls/history",
    zValidator("query", getCallHistorySchema),
    GetCallHistoryApi,
  )
  // Direct message routes
  .post("/messages/send", zValidator("json", sendMessageSchema), SendMessageApi)
  .get(
    "/messages/conversation",
    zValidator("query", getConversationSchema),
    GetConversationApi,
  )
  .post(
    "/messages/mark-read",
    zValidator("json", markAsReadSchema),
    MarkMessagesAsReadApi,
  )
  .get("/messages/unread-counts", GetUnreadCountsApi)
  .get("/messages/participants", GetConversationParticipantsApi)
  .put("/messages/edit", zValidator("json", editMessageSchema), EditMessageApi)
  .delete(
    "/messages/delete",
    zValidator("json", deleteMessageSchema),
    DeleteMessageApi,
  )
  // Channel routes
  .post("/channels", zValidator("json", createChannelSchema), CreateChannelApi)
  .put(
    "/channels/update",
    zValidator("json", updateChannelSchema),
    UpdateChannelApi,
  )
  .post(
    "/channels/archive",
    zValidator("json", archiveChannelSchema),
    ArchiveChannelApi,
  )
  .get(
    "/channels",
    zValidator("query", getUserChannelsSchema),
    GetUserChannelsApi,
  )
  .get("/channels/browse", BrowsePublicChannelsApi)
  .post("/channels/join", zValidator("json", joinChannelSchema), JoinChannelApi)
  .get(
    "/channels/members",
    zValidator("query", getChannelMembersSchema),
    GetChannelMembersApi,
  )
  .post(
    "/channels/members/add",
    zValidator("json", addMembersSchema),
    AddChannelMembersApi,
  )
  .post(
    "/channels/members/remove",
    zValidator("json", removeMemberSchema),
    RemoveChannelMemberApi,
  )
  .put(
    "/channels/members/role",
    zValidator("json", updateMemberRoleSchema),
    UpdateMemberRoleApi,
  )
  .post(
    "/channels/leave",
    zValidator("json", leaveChannelSchema),
    LeaveChannelApi,
  )
  .get(
    "/channels/messages",
    zValidator("query", getChannelMessagesSchema),
    GetChannelMessagesApi,
  )
  .post(
    "/channels/messages/send",
    zValidator("json", sendChannelMessageSchema),
    SendChannelMessageApi,
  )
  .put(
    "/channels/messages/edit",
    zValidator("json", editChannelMessageSchema),
    EditChannelMessageApi,
  )
  .delete(
    "/channels/messages/delete",
    zValidator("json", deleteChannelMessageSchema),
    DeleteChannelMessageApi,
  )
  .post(
    "/channels/messages/pin",
    zValidator("json", pinMessageSchema),
    PinMessageApi,
  )
  .post(
    "/channels/messages/unpin",
    zValidator("json", unpinMessageSchema),
    UnpinMessageApi,
  )
  .get(
    "/channels/messages/pinned",
    zValidator("query", getPinnedMessagesSchema),
    GetPinnedMessagesApi,
  )
  .delete(
    "/channels/:channelId",
    zValidator("param", channelIdParamSchema),
    DeleteChannelApi,
  )
  .get(
    "/channels/:channelId",
    zValidator("param", channelIdParamSchema),
    GetChannelDetailsApi,
  )
  // Thread routes
  .get("/threads/:messageId", zValidator("query", getThreadSchema), getThread)
  .post(
    "/threads/:messageId/reply",
    zValidator("json", sendThreadReplySchema),
    sendThreadReply,
  )
  .patch(
    "/threads/replies/:replyId",
    zValidator("json", updateThreadReplySchema),
    updateThreadReply,
  )
  .delete(
    "/threads/replies/:replyId",
    zValidator("param", deleteThreadReplySchema),
    deleteThreadReply,
  )
  .get("/agent/:agentExternalId/permissions", GetAgentPermissionsApi)
  .get("/agent/:agentExternalId/integration-items", GetAgentIntegrationItemsApi)
  .put(
    "/agent/:agentExternalId",
    zValidator("json", updateAgentSchema),
    UpdateAgentApi,
  )
  .delete("/agent/:agentExternalId", DeleteAgentApi)
  .post("/auth/logout", LogOut)
  //send Email Route
  .post("/email/send", sendMailHelper)

  // Collection Routes
  .post("/cl", CreateCollectionApi)
  .get("/cl", ListCollectionsApi)
  .get(
    "/cl/search",
    zValidator("query", searchKnowledgeBaseSchema),
    SearchKnowledgeBaseApi,
  )
  .post("/cl/poll-status", PollCollectionsStatusApi)
  .get("/cl/:clId", GetCollectionApi)
  .get("/cl/:clId/name", GetCollectionNameForSharedAgentApi)
  .put("/cl/:clId", UpdateCollectionApi)
  .delete("/cl/:clId", DeleteCollectionApi)
  .get("/cl/:clId/items", ListCollectionItemsApi)
  .post("/cl/:clId/items/folder", CreateFolderApi)
  .post("/cl/:clId/items/upload", UploadFilesApi)
  .post("/cl/:clId/items/upload/batch", UploadFilesApi) // Batch upload endpoint
  .post("/cl/:clId/items/upload/complete", UploadFilesApi) // Complete batch session
  .delete("/cl/:clId/items/:itemId", DeleteItemApi)
  .get("/cl/:clId/files/:itemId/preview", GetFilePreviewApi)
  .get("/cl/:clId/files/:itemId/content", GetFileContentApi)
  .get("/cl/:clId/files/:itemId/download", DownloadFileApi)
  .get("/chunk/:cId/files/:docId/content", GetChunkContentApi)

  .post(
    "/oauth/create",
    zValidator("form", createOAuthProvider),
    CreateOAuthProvider,
  )
  .post("/slack/ingest_more_channel", (c) =>
    proxyToSyncServer(c, "/slack/ingest_more_channel"),
  )
  .post("/slack/start_ingestion", (c) =>
    proxyToSyncServer(c, "/slack/start_ingestion"),
  )
  .post("/google/start_ingestion", (c) =>
    proxyToSyncServer(c, "/google/start_ingestion"),
  )
  // Ingestion Management APIs - new polling-based approach for Slack channel ingestion
  .get(
    "/ingestion/status",
    zValidator("query", getIngestionStatusSchema),
    (c) => proxyToSyncServer(c, "/ingestion/status", "GET"),
  )
  .post("/ingestion/cancel", zValidator("json", cancelIngestionSchema), (c) =>
    proxyToSyncServer(c, "/ingestion/cancel"),
  )
  .post("/ingestion/pause", zValidator("json", pauseIngestionSchema), (c) =>
    proxyToSyncServer(c, "/ingestion/pause"),
  )
  .post("/ingestion/resume", zValidator("json", resumeIngestionSchema), (c) =>
    proxyToSyncServer(c, "/ingestion/resume"),
  )
  .delete(
    "/oauth/connector/delete",
    zValidator("form", deleteConnectorSchema),
    DeleteOauthConnector,
  )
  .post(
    "/connector/update_status",
    zValidator("form", updateConnectorStatusSchema),
    UpdateConnectorStatus,
  )
  .get("/connectors/all", GetConnectors)
  .get("/oauth/global-slack-provider", GetProviders)

  // Admin Routes
  .basePath("/admin")
  .use("*", AdminRoleMiddleware)
  // TODO: debug
  // for some reason the validation schema
  // is not making the keys mandatory
  .get("/list_loggedIn_users", ListAllLoggedInUsers)
  .get("/list_ingested_users", ListAllIngestedUsers)
  .post("/change_role", zValidator("form", UserRoleChangeSchema), UpdateUser)
  .post("/syncGoogleWorkSpaceByMail", (c) =>
    proxyToSyncServer(c, "/syncGoogleWorkSpaceByMail"),
  )
  .post("syncSlackByMail", (c) => proxyToSyncServer(c, "/syncSlackByMail"))
  // create the provider + connector
  .post(
    "/oauth/create",
    zValidator("form", createOAuthProvider),
    CreateOAuthProvider,
  )
  .post(
    "/microsoft/service_account",
    zValidator("form", microsoftServiceSchema),
    AddServiceConnectionMicrosoft,
  )
  .post("/slack/ingest_more_channel", (c) =>
    proxyToSyncServer(c, "/slack/ingest_more_channel"),
  )
  .post("/slack/start_ingestion", (c) =>
    proxyToSyncServer(c, "/slack/start_ingestion"),
  )
  .post("/google/start_ingestion", (c) =>
    proxyToSyncServer(c, "/google/start_ingestion"),
  )
  .delete(
    "/oauth/connector/delete",
    zValidator("form", deleteConnectorSchema),
    DeleteOauthConnector,
  )
  .post(
    "/connector/update_status",
    zValidator("form", updateConnectorStatusSchema),
    UpdateConnectorStatus,
  )
  .get("/connectors/all", GetConnectors)
  .get("/oauth/global-slack-provider", GetProviders)

  .post(
    "/service_account",
    zValidator("form", addServiceConnectionSchema),
    AddServiceConnection,
  )
  .put(
    "/service_account",
    zValidator("form", updateServiceConnectionSchema),
    UpdateServiceConnection,
  )
  .post("/google/service_account/ingest_more", (c) =>
    proxyToSyncServer(c, "/google/service_account/ingest_more"),
  )
  // create the provider + connector
  .post(
    "/apikey/create",
    zValidator("form", addApiKeyConnectorSchema),
    AddApiKeyConnector,
  )
  .post(
    "/apikey/mcp/create",
    zValidator("json", addApiKeyMCPConnectorSchema),
    AddApiKeyMCPConnector,
  )
  .post(
    "/stdio/mcp/create",
    zValidator("form", addStdioMCPConnectorSchema),
    AddStdioMCPConnector,
  )

  .get("/connector/:connectorId/tools", GetConnectorTools) // Added route for GetConnectorTools

  .delete(
    "/connector/delete",
    zValidator("form", deleteConnectorSchema),
    DeleteConnector,
  )

  .post(
    // Added route for updating tool statuses
    "/tools/update_status",
    zValidator("json", updateToolsStatusSchema),
    UpdateToolsStatusApi,
  )
  .post(
    "/user/delete_data",
    zValidator("json", deleteUserDataSchema),
    AdminDeleteUserData,
  )
  .post(
    "/kb/vespa-data",
    zValidator("json", getDocumentSchema),
    GetKbVespaContent,
  )

  // Admin Dashboard Routes
  .get("/chats", zValidator("query", adminQuerySchema), GetAdminChats)
  .get("/agents", GetAdminAgents)
  .get("/users", GetAdminUsers)
  .get(
    "/users/:userId/feedback",
    zValidator("query", userAgentLeaderboardQuerySchema),
    GetAllUserFeedbackMessages,
  )
  .get(
    "/users/:userId/agent-leaderboard",
    zValidator("query", userAgentLeaderboardQuerySchema),
    GetUserAgentLeaderboard,
  )
  .get(
    "/chat/queries/:chatId",
    zValidator("param", chatIdParamSchema),
    GetChatQueriesApi,
  )

  .get(
    "/agents/:agentId/analysis",
    zValidator("query", agentAnalysisQuerySchema),
    GetAgentAnalysis,
  )
  .get(
    "/agents/:agentId/feedback",
    zValidator("query", agentAnalysisQuerySchema),
    GetAgentFeedbackMessages,
  )

  .get(
    "/agents/:agentId/user-feedback/:userId",
    zValidator("query", agentAnalysisQuerySchema),
    GetAgentUserFeedbackMessages,
  )
  .get(
    "/admin/users/:userId/feedback",
    zValidator("query", userAgentLeaderboardQuerySchema),
    GetAllUserFeedbackMessages,
  )

// WebSocket endpoint for sync-server connections
export const SyncServerWsApp = app.get(
  "/internal/sync-websocket",
  upgradeWebSocket((c) => {
    // Verify authentication
    const authHeader = c.req.header("Authorization")
    const expectedSecret = process.env.METRICS_SECRET

    if (
      !authHeader ||
      !authHeader.startsWith("Bearer ") ||
      authHeader.slice(7) !== expectedSecret
    ) {
      Logger.warn("Unauthorized sync-server WebSocket connection attempt")
      return {
        onOpen() {
          // Close immediately if unauthorized
        },
      }
    }

    return {
      onOpen(event, ws) {
        Logger.info("Sync-server WebSocket connected")
      },
      onMessage(event, ws) {
        try {
          const { message, connectorId } = JSON.parse(event.data.toString())

          // Forward message to the appropriate frontend WebSocket connection
          const frontendWs = wsConnections.get(connectorId)
          if (frontendWs) {
            frontendWs.send(JSON.stringify({ message }))
            Logger.info(
              `WebSocket message forwarded from sync-server to frontend for connector ${connectorId}`,
            )
          } else {
            Logger.warn(
              `No frontend WebSocket connection found for connector ${connectorId}`,
            )
          }
        } catch (error) {
          Logger.error(error, "Error processing sync-server WebSocket message")
        }
      },
      onClose: (event, ws) => {
        Logger.info("Sync-server WebSocket connection closed")
      },
    }
  }),
)

app.get("/oauth/callback", AuthMiddleware, OAuthCallback)
app.get(
  "/oauth/start",
  AuthMiddleware,
  zValidator("query", oauthStartQuerySchema),
  StartOAuth,
)

// Consumer API endpoints, authenticated by ApiKeyMiddleware
app
  .basePath("/api/consumer")
  .use("*", ApiKeyMiddleware)
  .post("/agent/create", zValidator("json", createAgentSchema), CreateAgentApi) // Create Agent
  .post(
    "/agent/chat",
    zValidator("json", agentChatMessageSchema), // Agent Chat
    AgentMessageApi,
  )
  .post(
    "/agent/chat/stop",
    zValidator("json", chatStopSchema), // Agent Chat Stop
    StopStreamingApi,
  )
  .put(
    "/agent/:agentExternalId",
    zValidator("json", updateAgentSchema), // Update Agent
    UpdateAgentApi,
  )
  .delete("/agent/:agentExternalId", DeleteAgentApi) // Delete Agent
  .get("/agent/:agentExternalId", GetAgentApi) // Get Agent details
  .get("/chat/history", zValidator("query", chatHistorySchema), ChatHistory) // List chat history
  .post("/cl", CreateCollectionApi) // Create collection (KB)
  .get("/cl", ListCollectionsApi) // List all collections
  .get(
    "/cl/search",
    zValidator("query", searchKnowledgeBaseSchema), // Search over KB
    SearchKnowledgeBaseApi,
  )
  .get("/cl/:clId", GetCollectionApi) // Get collection by ID
  .put("/cl/:clId", UpdateCollectionApi) // Update collection (rename, etc.)
  .delete("/cl/:clId", DeleteCollectionApi) // Delete collection (KB)
  .post("/cl/:clId/items/upload", UploadFilesApi) // Upload files to KB (supports zip files)
  .delete("/cl/:clId/items/:itemId", DeleteItemApi) // Delete Item in KB by ID
  .post("/cl/poll-status", PollCollectionsStatusApi) // Poll collection items status

// Proxy function to forward ingestion API calls to sync server
const proxyToSyncServer = async (
  c: Context,
  endpoint: string,
  method: string = "POST",
) => {
  try {
    // Get JWT token from cookie
    const token = getCookie(c, AccessTokenCookieName)
    if (!token) {
      throw new HTTPException(401, { message: "No authentication token" })
    }

    // Prepare URL - for GET requests, add query parameters
    let url = `http://${config.syncServerHost}:${config.syncServerPort}${endpoint}`
    if (method === "GET") {
      const urlObj = new URL(url)
      const queryParams = c.req.query()
      Object.keys(queryParams).forEach((key) => {
        if (queryParams[key]) {
          urlObj.searchParams.set(key, queryParams[key])
        }
      })
      url = urlObj.toString()
    }

    // Prepare request configuration
    const requestConfig: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: `${AccessTokenCookieName}=${token}`,
      },
    }

    // Add body for non-GET requests
    if (method !== "GET") {
      const body = await c.req.json()
      requestConfig.body = JSON.stringify(body)
    }

    // Forward to sync server
    const response = await fetch(url, requestConfig)

    if (!response.ok) {
      const errorData = await response
        .json()
        .catch(() => ({ message: "Proxy request failed" }))
      throw new HTTPException(response.status as any, {
        message: errorData.message || "Proxy request failed",
      })
    }

    return c.json(await response.json())
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, `Proxy request to ${endpoint} failed`)
    throw new HTTPException(500, { message: "Proxy request failed" })
  }
}

const generateTokens = async (
  email: string,
  role: string,
  workspaceId: string,
  forRefreshToken: boolean = false,
) => {
  const payload = forRefreshToken
    ? {
        sub: email,
        role: role,
        workspaceId,
        tokenType: "refresh",
        exp: Math.floor(Date.now() / 1000) + config.RefreshTokenTTL,
      }
    : {
        sub: email,
        role: role,
        workspaceId,
        tokenType: "access",
        exp: Math.floor(Date.now() / 1000) + config.AccessTokenTTL,
      }
  const jwtToken = await sign(
    payload,
    forRefreshToken ? refreshTokenSecret : accessTokenSecret,
  )
  return jwtToken
}
// we won't allow user to reach the login page if they are already logged in
// or if they have an expired token

// After google oauth is done, google redirects user
// here and this is where all the onboarding will happen
// if user account does not exist, then we will automatically
// create the user and workspace
// if workspace already exists for that domain then we just login
// the user and update the last logged in value
app.get(
  "/v1/auth/callback",
  googleAuth({
    client_id: clientId,
    client_secret: clientSecret,
    scope: ["openid", "email", "profile"],
    redirect_uri: redirectURI,
  }),
  async (c: Context) => {
    const user = c.get("user-google")

    const email = user?.email
    if (!email) {
      throw new HTTPException(400, {
        message: "Could not get the email of the user",
      })
    }

    if (!user?.verified_email) {
      throw new HTTPException(403, { message: "User email is not verified" })
    }
    // hosted domain
    // @ts-ignore
    let domain = user.hd
    if (!domain && email) {
      domain = email.split("@")[1]
    }
    const name = user?.name || user?.given_name || user?.family_name || ""
    const photoLink = user?.picture || ""

    const existingUserRes = await getUserByEmail(db, email)
    // if user exists then workspace exists too
    if (existingUserRes && existingUserRes.length) {
      Logger.info(
        {
          requestId: c.var.requestId, // Access the request ID
          user: {
            email: user.email,
            name: user.name,
            verified_email: user.verified_email,
          },
        },
        "User found and authenticated",
      )
      const existingUser = existingUserRes[0]
      const accessToken = await generateTokens(
        existingUser.email,
        existingUser.role,
        existingUser.workspaceExternalId,
      )
      const refreshToken = await generateTokens(
        existingUser.email,
        existingUser.role,
        existingUser.workspaceExternalId,
        true,
      )
      // save refresh token generated in user schema
      await saveRefreshTokenToDB(db, email, refreshToken)
      const opts = {
        secure: true,
        path: "/",
        httpOnly: true,
      }
      setCookieByEnv(c, AccessTokenCookieName, accessToken, opts)
      setCookieByEnv(c, RefreshTokenCookieName, refreshToken, opts)
      return c.redirect(postOauthRedirect)
    }

    // check if workspace exists
    // just create the user
    const existingWorkspaceRes = await getWorkspaceByDomain(domain)
    if (existingWorkspaceRes && existingWorkspaceRes.length) {
      Logger.info("Workspace found, creating user")
      const existingWorkspace = existingWorkspaceRes[0]
      const [user] = await createUser(
        db,
        existingWorkspace.id,
        email,
        name,
        photoLink,
        UserRole.User,
        existingWorkspace.externalId,
      )

      const accessToken = await generateTokens(
        user.email,
        user.role,
        user.workspaceExternalId,
      )
      const refreshToken = await generateTokens(
        user.email,
        user.role,
        user.workspaceExternalId,
        true,
      )
      // save refresh token generated in user schema
      await saveRefreshTokenToDB(db, email, refreshToken)
      const emailSent = await emailService.sendWelcomeEmail(
        user.email,
        user.name,
      )
      if (emailSent) {
        Logger.info(`Welcome email sent to ${user.email} and ${user.name}`)
      }
      const opts = {
        secure: true,
        path: "/",
        httpOnly: true,
      }
      setCookieByEnv(c, AccessTokenCookieName, accessToken, opts)
      setCookieByEnv(c, RefreshTokenCookieName, refreshToken, opts)
      return c.redirect(postOauthRedirect)
    }

    // we could not find the user and the workspace
    // creating both

    Logger.info("Creating workspace and user")
    const userAcc = await db.transaction(async (trx) => {
      const [workspace] = await createWorkspace(trx, email, domain)
      const [user] = await createUser(
        trx,
        workspace.id,
        email,
        name,
        photoLink,
        UserRole.SuperAdmin,
        workspace.externalId,
      )
      return user
    })

    const accessToken = await generateTokens(
      userAcc.email,
      userAcc.role,
      userAcc.workspaceExternalId,
    )
    const refreshToken = await generateTokens(
      userAcc.email,
      userAcc.role,
      userAcc.workspaceExternalId,
      true,
    )
    // save refresh token generated in user schema
    await saveRefreshTokenToDB(db, email, refreshToken)
    const emailSent = await emailService.sendWelcomeEmail(
      userAcc.email,
      userAcc.name,
    )
    if (emailSent) {
      Logger.info(
        `Welcome email sent to new workspace creator ${userAcc.email}`,
      )
    }
    const opts = {
      secure: true,
      path: "/",
      httpOnly: true,
    }
    setCookieByEnv(c, AccessTokenCookieName, accessToken, opts)
    setCookieByEnv(c, RefreshTokenCookieName, refreshToken, opts)
    return c.redirect(postOauthRedirect)
  },
)

// START of Health Check Endpoints
// Comprehensive health check endpoint

const createHealthCheckHandler = (
  checkFn: () => Promise<HealthStatusResponse>,
  serviceName: ServiceName,
) => {
  return async (c: Context) => {
    try {
      const health = await checkFn()
      const statusCode =
        health.status === HealthStatusType.Healthy ||
        health.status === HealthStatusType.Degraded
          ? 200
          : 503
      return c.json(health, statusCode)
    } catch (error) {
      Logger.error(error, `Health check endpoint failed for ${serviceName}`)
      return c.json(
        {
          status: HealthStatusType.Unhealthy,
          timestamp: new Date().toISOString(),
          error: "Health check failed",
          details: error instanceof Error ? error.message : "Unknown error",
        },
        503,
      )
    }
  }
}

app.get("/health", async (c) => {
  try {
    const health = await checkOverallSystemHealth()
    const statusCode =
      health.status === HealthStatusType.Healthy
        ? 200
        : health.status === HealthStatusType.Degraded
          ? 200
          : 503

    return c.json(health, statusCode)
  } catch (error) {
    Logger.error(error, "Health check endpoint failed")
    return c.json(
      {
        status: HealthStatusType.Unhealthy,
        timestamp: new Date().toISOString(),
        error: "Health check failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      503,
    )
  }
})

// Postgres health check endpoint
app.get(
  "/health/postgres",
  createHealthCheckHandler(checkPostgresHealth, ServiceName.postgres),
)
// Vespa health check endpoint
app.get(
  "/health/vespa",
  createHealthCheckHandler(checkVespaHealth, ServiceName.vespa),
)

// PaddleOCR health check endpoint
app.get(
  "/health/paddle",
  createHealthCheckHandler(checkPaddleOCRHealth, ServiceName.paddleOCR),
)

// Serving exact frontend routes and adding AuthRedirect wherever needed
app.get("/auth", serveStatic({ path: "./dist/index.html" }))

// PDF.js worker files
app.get(
  "/pdfjs/pdf.worker.min.mjs",
  serveStatic({ path: "./dist/pdfjs/pdf.worker.min.mjs" }),
)

// PDF.js character maps
app.get("/pdfjs/cmaps/*", serveStatic({ root: "./dist" }))

// PDF.js standard fonts
app.get("/pdfjs/standard_fonts/*", serveStatic({ root: "./dist" }))

// PDF.js WASM files
app.get("/pdfjs/wasm/*", serveStatic({ root: "./dist" }))

// PDF.js annotation images
app.get("/pdfjs/images/*", serveStatic({ root: "./dist" }))

// PDF.js ICC color profiles
app.get("/pdfjs/iccs/*", serveStatic({ root: "./dist" }))

app.get("/assets/*", serveStatic({ root: "./dist" }))
app.get("/*", AuthRedirect, serveStatic({ path: "./dist/index.html" }))

export const init = async () => {
  // Initialize API server queue (only FileProcessingQueue, no workers)
  await initApiServerQueue()

  if (isSlackEnabled()) {
    Logger.info("Slack Web API client initialized and ready.")
    try {
      const socketStarted = await startSocketMode()
      if (socketStarted) {
        Logger.info("Slack Socket Mode connection initiated successfully.")
      } else {
        Logger.warn(
          "Failed to start Slack Socket Mode - missing configuration.",
        )
      }
    } catch (error) {
      Logger.error(error, "Error starting Slack Socket Mode")
    }
  } else {
    Logger.info("Slack integration disabled - no BOT_TOKEN/APP_TOKEN provided.")
  }
}

internalMetricRouter.get("/metrics", async (c) => {
  try {
    const metrics = await metricRegister.metrics()
    return c.text(metrics, 200, {
      "Content-Type": metricRegister.contentType,
    })
  } catch (err) {
    return c.text("Error generating metrics", 500)
  }
})

init().catch((error) => {
  throw new InitialisationError({ cause: error })
})

const errorHandler = (error: Error) => {
  // Added Error type
  return new Response(`<pre>${error}\n${error.stack}</pre>`, {
    headers: {
      "Content-Type": "text/html",
    },
  })
}

const server = Bun.serve({
  fetch: app.fetch,
  port: config.port,
  websocket,
  idleTimeout: 180,
  development: true,
  error: errorHandler,
})

const metricServer = Bun.serve({
  fetch: internalMetricRouter.fetch,
  port: config.metricsPort, // new port from config
  idleTimeout: 180,
  development: true,
  error: errorHandler,
})

Logger.info(`listening on port: ${config.port}`)
Logger.info(`metrics server started on port: ${config.metricsPort}`)

const errorEvents: string[] = [
  `uncaughtException`,
  `unhandledRejection`,
  `rejectionHandled`,
]
errorEvents.forEach((eventType: string) =>
  process.on(eventType, (error: Error) => {
    Logger.error(error, `Caught via event: ${eventType}`)
  }),
)
