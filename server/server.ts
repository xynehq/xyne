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
  SearchSlackChannels,
} from "@/api/search"
import { zValidator } from "@hono/zod-validator"
import {
  addApiKeyConnectorSchema,
  addApiKeyMCPConnectorSchema,
  addServiceConnectionSchema,
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
} from "@/types"
import {
  AddApiKeyConnector,
  AddApiKeyMCPConnector,
  AddServiceConnection,
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
  IngestMoreChannelApi,
  StartSlackIngestionApi,
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
  GetAgentApiKeys,
} from "@/api/admin"
import { ProxyUrl } from "@/api/proxy"
import { init as initQueue } from "@/queue"
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
import { getLogger, LogMiddleware } from "@/logger"
import { Subsystem } from "@/types"
import { GetUserWorkspaceInfo, GenerateApiKey } from "@/api/auth"
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
import { UserRole, Apps } from "@/shared/types" // Import Apps
import { wsConnections } from "@/integrations/metricStream"
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
import metricRegister from "@/metrics/sharedRegistry"
import {
  handleAttachmentUpload,
  handleFileUpload,
  handleAttachmentServe,
  handleThumbnailServe,
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
} from "@/api/knowledgeBase"

import {
  isSlackEnabled,
  startSocketMode,
  getSocketModeStatus,
} from "@/integrations/slack/client"
const { JwtPayloadKey } = config
// Import Vespa proxy handlers
import {
  validateApiKey,
  vespaSearchProxy,
  vespaAutocompleteProxy,
  vespaGroupSearchProxy,
  vespaGetItemsProxy,
  vespaChatContainerByChannelProxy,
  vespaChatUserByEmailProxy,
  vespaGetDocumentProxy,
  vespaGetDocumentsByIdsProxy,
  vespaGetUsersByNamesAndEmailsProxy,
  vespaGetDocumentsByThreadIdProxy,
  vespaGetEmailsByThreadIdsProxy,
  vespaGetDocumentsWithFieldProxy,
  vespaGetRandomDocumentProxy,
  searchVespaProxy,
  groupVespaSearchProxy,
} from "@/routes/vespa-proxy"
import { updateMetricsFromThread } from "@/metrics/utils"
import { agents, apiKeys, type PublicUserWorkspace } from "./db/schema"
import { AgentMessageCustomApi } from "./api/chat/agents"
import { and, eq, isNull, sql } from "drizzle-orm"

// Define Zod schema for delete datasource file query parameters
const deleteDataSourceFileQuerySchema = z.object({
  dataSourceName: z.string().min(1),
  fileName: z.string().min(1),
})

// Add schema for API key generation
const generateApiKeySchema = z.object({
  expirationDays: z.coerce
    .number()
    .min(1 / 1440)
    .max(30), // Allow fractional days, minimum 1 minute (1/1440 days)
})

export type Variables = JwtVariables

const clientId = process.env.GOOGLE_CLIENT_ID!
const clientSecret = process.env.GOOGLE_CLIENT_SECRET!
const redirectURI = config.redirectUri
const postOauthRedirect = config.postOauthRedirect

const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET!
const refreshTokenSecret = process.env.REFRESH_TOKEN_SECRET!

const AccessTokenCookieName = "access-token"
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
    const body = await c.req.json()
    apiKey = body.apiKey || body.api_key

    if (!apiKey) {
      Logger.warn("API key verification failed: Missing apiKey in request body")
      throw new HTTPException(401, {
        message: "Missing API key. Please provide apiKey in request body.",
      })
    }
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error
    }
    Logger.warn("API key verification failed: Invalid JSON body")
    throw new HTTPException(400, {
      message:
        "Invalid request body. Please provide valid JSON with apiKey field.",
    })
  }

  try {
    // Decrypt and validate the API key
    const result = await db
      .select({
        agentId: apiKeys.agentId,
        decryptedKey: sql<string>`
          pgp_sym_decrypt(${apiKeys.key}, ${process.env.PG_SECRET})
        `,
        agentName: agents.name,
      })
      .from(apiKeys)
      .innerJoin(agents, eq(apiKeys.agentId, agents.id))
      .where(and(eq(apiKeys.key, apiKey), isNull(agents.deletedAt)))
      .limit(1)

    if (result.length === 0) {
      Logger.warn("API key verification failed: Invalid API key")
      throw new HTTPException(401, {
        message: "Invalid API key.",
      })
    }

    const { agentId, decryptedKey, agentName } = result[0]

    // Validate the decrypted key format (should be agentId_agentName)
    const expectedKey = `${agentId}_${agentName}`
    if (decryptedKey !== expectedKey) {
      Logger.warn("API key verification failed: Key format mismatch")
      throw new HTTPException(401, {
        message: "Invalid API key format.",
      })
    }

    // Set agentId in context for downstream handlers
    c.set("agentId", agentId)

    Logger.info(`API key verified for agent ID: ${agentId}`)

    await next()
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error
    }

    Logger.error("API key verification error:", error)
    throw new HTTPException(500, {
      message: "Internal server error during API key verification.",
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

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new HTTPException(401, {
      message: "Missing or malformed Authorization header",
    })
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
    throw new HTTPException(500, {
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
      message: "No existing User found",
    },
    404,
  )
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

export const AppRoutes = app
  .basePath("/api/v1")
  .get(
    "/agent/completion",
    zValidator(
      "query",
      z.object({
        message: z.string(),
        // chatId: z.string().optional(),
        // modelId: z.string().optional(),
        isReasoningEnabled: z.string().optional(),
        agentId: z.string().optional(),
        // apiKey: z.string().optional(),
        // isRag: z.string().optional(),
        chunks: z.any(),
        history: z.any(),
      }),
    ),
    AgentMessageCustomApi,
  )
  .get("/agents/:agentId/api-key", GetAgentApiKeys)
  .post("/validate-token", handleAppValidation)
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
  .post("/chat", zValidator("json", chatSchema), GetChatApi)
  .post(
    "/chat/bookmark",
    zValidator("json", chatBookmarkSchema),
    ChatBookmarkApi,
  )
  .post("/chat/rename", zValidator("json", chatRenameSchema), ChatRenameApi)
  .post("/chat/delete", zValidator("json", chatDeleteSchema), ChatDeleteApi)
  .post("/chat/stop", zValidator("json", chatStopSchema), StopStreamingApi)
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
  .get("/me", GetUserWorkspaceInfo)
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
  .post("/tuning/evaluate", EvaluateHandler)
  .get("/tuning/datasets", ListDatasetsHandler)
  .post(
    "/tuning/tuneDataset",
    zValidator("json", tuneDatasetSchema),
    TuneDatasetHandler,
  )
  .delete("/tuning/datasets/:filename", DeleteDatasetHandler)
  .get("/tuning/ws/:jobId", TuningWsRoute)
  // Agent Routes
  .post("/agent/create", zValidator("json", createAgentSchema), CreateAgentApi)
  .get("/agent/generate-prompt", GeneratePromptApi)
  .get("/agents", zValidator("query", listAgentsSchema), ListAgentsApi)
  .get("/agent/:agentExternalId", GetAgentApi)
  .get("/workspace/users", GetWorkspaceUsersApi)
  .get("/agent/:agentExternalId/permissions", GetAgentPermissionsApi)
  .get("/agent/:agentExternalId/integration-items", GetAgentIntegrationItemsApi)
  .put(
    "/agent/:agentExternalId",
    zValidator("json", updateAgentSchema),
    UpdateAgentApi,
  )
  .delete("/agent/:agentExternalId", DeleteAgentApi)
  .post("/auth/logout", LogOut)
  .get(
    "/auth/generate-api-key",
    zValidator("query", generateApiKeySchema),
    GenerateApiKey,
  )

  // Collection Routes
  .post("/cl", CreateCollectionApi)
  .get("/cl", ListCollectionsApi)
  .get("/cl/:clId", GetCollectionApi)
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

  .post(
    "/oauth/create",
    zValidator("form", createOAuthProvider),
    CreateOAuthProvider,
  )
  .post(
    "/slack/ingest_more_channel",
    zValidator("json", ingestMoreChannelSchema),
    IngestMoreChannelApi,
  )
  .post(
    "/slack/start_ingestion",
    zValidator("json", startSlackIngestionSchema),
    StartSlackIngestionApi,
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
  .post(
    "/oauth/create",
    zValidator("form", createOAuthProvider),
    CreateOAuthProvider,
  )
  .post(
    "/slack/ingest_more_channel",
    zValidator("json", ingestMoreChannelSchema),
    IngestMoreChannelApi,
  )
  .post(
    "/slack/start_ingestion",
    zValidator("json", startSlackIngestionSchema),
    StartSlackIngestionApi,
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
  .post(
    "/google/service_account/ingest_more",
    zValidator("json", serviceAccountIngestMoreSchema),
    ServiceAccountIngestMoreUsersApi,
  )
  // create the provider + connector
  .post(
    "/apikey/create",
    zValidator("form", addApiKeyConnectorSchema),
    AddApiKeyConnector,
  )
  .post(
    "/apikey/mcp/create",
    zValidator("form", addApiKeyMCPConnectorSchema),
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

// Vespa Proxy Routes (for production server proxying)
app
  .basePath("/api/vespa")
  .post("/search", validateApiKey, vespaSearchProxy)
  .post("/autocomplete", validateApiKey, vespaAutocompleteProxy)
  .post("/group-search", validateApiKey, vespaGroupSearchProxy)
  .post("/get-items", validateApiKey, vespaGetItemsProxy)
  .post(
    "/chat-container-by-channel",
    validateApiKey,
    vespaChatContainerByChannelProxy,
  )
  .post("/chat-user-by-email", validateApiKey, vespaChatUserByEmailProxy)
  .post("/get-document", validateApiKey, vespaGetDocumentProxy)
  .post("/get-documents-by-ids", validateApiKey, vespaGetDocumentsByIdsProxy)
  .post(
    "/get-users-by-names-and-emails",
    validateApiKey,
    vespaGetUsersByNamesAndEmailsProxy,
  )
  .post(
    "/get-documents-by-thread-id",
    validateApiKey,
    vespaGetDocumentsByThreadIdProxy,
  )
  .post(
    "/get-emails-by-thread-ids",
    validateApiKey,
    vespaGetEmailsByThreadIdsProxy,
  )
  .post(
    "/get-documents-with-field",
    validateApiKey,
    vespaGetDocumentsWithFieldProxy,
  )
  .post("/get-random-document", validateApiKey, vespaGetRandomDocumentProxy)
  .post("/group-vespa-search", validateApiKey, groupVespaSearchProxy)
  .post("/search-vespa", validateApiKey, searchVespaProxy)

app.get("/oauth/callback", AuthMiddleware, OAuthCallback)
app.get(
  "/oauth/start",
  AuthMiddleware,
  zValidator("query", oauthStartQuerySchema),
  StartOAuth,
)

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
    const token = c.get("token")
    const grantedScopes = c.get("granted-scopes")
    const user = c.get("user-google")

    const email = user?.email
    if (!email) {
      throw new HTTPException(500, {
        message: "Could not get the email of the user",
      })
    }

    if (!user?.verified_email) {
      throw new HTTPException(500, { message: "User email is not verified" })
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

// Serving exact frontend routes and adding AuthRedirect wherever needed
app.get("/", AuthRedirect, serveStatic({ path: "./dist/index.html" }))
app.get("/chat", AuthRedirect, async (c, next) => {
  if (c.req.query("shareToken")) {
    const staticHandler = serveStatic({ path: "./dist/index.html" })
    return await staticHandler(c, next)
  }
  return c.redirect("/")
})
app.get("/trace", AuthRedirect, (c) => c.redirect("/"))
app.get("/auth", serveStatic({ path: "./dist/index.html" }))
app.get("/agent", AuthRedirect, serveStatic({ path: "./dist/index.html" }))
app.get("/search", AuthRedirect, serveStatic({ path: "./dist/index.html" }))
app.get("/dashboard", AuthRedirect, serveStatic({ path: "./dist/index.html" }))
app.get("/pdf.worker.min.js", serveStatic({ path: "./dist/pdf.worker.min.js" }))
app.get(
  "/chat/:param",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/trace/:chatId/:messageId",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/integrations",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/admin/integrations",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/integrations/fileupload",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/integrations/google",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/integrations/slack",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/integrations/mcp",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
// Catch-all for any other integration routes
app.get(
  "/integrations/*",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/admin/integrations",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/admin/integrations/google",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/admin/integrations/slack",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/admin/integrations/mcp",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/admin/integrations/*",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get("/tuning", AuthRedirect, serveStatic({ path: "./dist/index.html" }))
app.get("/oauth/success", serveStatic({ path: "./dist/index.html" }))
app.get("/assets/*", serveStatic({ root: "./dist" }))
app.get("/api-key", AuthRedirect, serveStatic({ path: "./dist/index.html" }))
app.get(
  "/knowledge-base",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/knowledgeManagement",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)

export const init = async () => {
  await initQueue()
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
