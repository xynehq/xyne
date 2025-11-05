import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { db } from "@/db/client"
import {
  getUserAndWorkspaceByEmail,
  getUserByEmail,
  updateUser,
  getAllLoggedInUsers,
  getAllIngestedUsers,
} from "@/db/user"
import { getWorkspaceByExternalId } from "@/db/workspace" // Added import
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Job } from "pg-boss"
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  syncConnectorTools,
  deleteToolsByConnectorId,
  getToolsByConnectorId as dbGetToolsByConnectorId,
  tools as toolsTable,
} from "@/db/tool" // Added dbGetToolsByConnectorId and toolsTable
import {
  eq,
  and,
  inArray,
  sql,
  gte,
  lte,
  isNull,
  isNotNull,
  like,
  ilike,
  count,
  sum,
  desc,
  asc,
  or,
  countDistinct,
} from "drizzle-orm"
import {
  deleteConnector,
  getConnectorByExternalId,
  getConnectors,
  insertConnector,
  updateConnector,
  deleteOauthConnector,
  getConnector,
} from "@/db/connector"
import {
  type OAuthProvider,
  type OAuthStartQuery,
  type SaaSJob,
  type ServiceAccountConnection,
  type UpdateServiceAccountConnection,
  type ApiKeyMCPConnector,
  type StdioMCPConnector,
  MCPClientStdioConfig,
  MCPConnectorMode,
  MCPClientConfig,
  Subsystem,
  type microsoftService,
  type MicrosoftServiceCredentials, // Added for tool status updates
  updateToolsStatusSchema, // Added for tool status updates
  type userRoleChange,
} from "@/types"
import { z } from "zod"
import { boss, SaaSQueue } from "@/queue"
import config from "@/config"
import {
  Apps,
  AuthType,
  ConnectorStatus,
  ConnectorType,
  getDocumentSchema,
} from "@/shared/types"
import {
  createOAuthProvider,
  getAppGlobalOAuthProvider,
  getOAuthProvider,
} from "@/db/oauthProvider"
const { JwtPayloadKey, slackHost } = config
import {
  generateCodeVerifier,
  generateState,
  Google,
  Slack,
  MicrosoftEntraId,
} from "arctic"
import type {
  SelectConnector,
  SelectOAuthProvider,
  SelectUser,
} from "@/db/schema"
import {
  users,
  chats,
  messages,
  agents,
  selectConnectorSchema,
} from "@/db/schema" // Add database schema imports
import {
  getErrorMessage,
  IsGoogleApp,
  IsMicrosoftApp,
  setCookieByEnv,
} from "@/utils"
import { getLogger, getLoggerWithChild } from "@/logger"
import {
  getUserAgentLeaderboard,
  type UserAgentLeaderboard,
  getAgentAnalysis,
  type AgentAnalysisData,
  getAgentFeedbackMessages,
  getAgentUserFeedbackMessages,
  getAllUserFeedbackMessages,
} from "@/db/sharedAgentUsage"
import { getPath } from "hono/utils/url"
import {
  AddServiceConnectionError,
  ConnectorNotCreated,
  NoUserFound,
} from "@/errors"
import {
  handleGoogleOAuthIngestion,
  handleGoogleServiceAccountIngestion,
} from "@/integrations/google"
import { scopes } from "@/integrations/google/config"
import { ServiceAccountIngestMoreUsers } from "@/integrations/google"
import { handleSlackChannelIngestion } from "@/integrations/slack/channelIngest"
import { handleSlackIngestion } from "@/integrations/slack"
import {
  clearUserDataInVespa,
  type ClearUserDataOptions,
} from "@/integrations/dataDeletion"
import { deleteUserDataSchema, type DeleteUserDataPayload } from "@/types"
import { clearUserSyncJob } from "@/db/syncJob"
import { int } from "drizzle-orm/mysql-core"
import {
  handleGoogleOAuthChanges,
  handleGoogleServiceAccountChanges,
} from "@/integrations/google/sync"
import { zValidator } from "@hono/zod-validator"
import { handleSlackChanges } from "@/integrations/slack/sync"
import { getAgentByExternalIdWithPermissionCheck } from "@/db/agent"
import { ClientSecretCredential } from "@azure/identity"
import { Client as GraphClient } from "@microsoft/microsoft-graph-client"
import type { AuthenticationProvider } from "@microsoft/microsoft-graph-client"
import { handleMicrosoftServiceAccountIngestion } from "@/integrations/microsoft"
import { CustomServiceAuthProvider } from "@/integrations/microsoft/utils"
import { KbItemsSchema, type VespaSchema } from "@xyne/vespa-ts"
import { GetDocument } from "@/search/vespa"
import { getCollectionFilesVespaIds } from "@/db/knowledgeBase"
import { replaceSheetIndex } from "@/search/utils"
import { fetchUserQueriesForChat } from "@/db/message"

const Logger = getLogger(Subsystem.Api).child({ module: "admin" })
const loggerWithChild = getLoggerWithChild(Subsystem.Api, { module: "admin" })

// Schema for admin query validation
export const adminQuerySchema = z.object({
  from: z
    .string()
    .optional()
    .refine((val) => !val || !isNaN(Date.parse(val)), {
      message: "Invalid date format for 'from' parameter",
    })
    .transform((val) => (val ? new Date(val) : undefined)),
  to: z
    .string()
    .optional()
    .refine((val) => !val || !isNaN(Date.parse(val)), {
      message: "Invalid date format for 'to' parameter",
    })
    .transform((val) => (val ? new Date(val) : undefined)),
  userId: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined)),
  page: z
    .string()
    .optional()
    .refine((val) => !val || (!isNaN(Number(val)) && Number(val) > 0), {
      message: "Page must be a positive number",
    })
    .transform((val) => (val ? Number(val) : 1)),
  offset: z
    .string()
    .optional()
    .refine((val) => !val || (!isNaN(Number(val)) && Number(val) >= 0), {
      message: "Offset must be a non-negative number",
    })
    .transform((val) => (val ? Number(val) : 20)),
  search: z
    .string()
    .optional()
    .transform((val) => (val?.trim() ? val.trim() : undefined)),
  filterType: z.enum(["all", "agent", "normal"]).optional().default("all"),
  sortBy: z
    .enum(["created", "messages", "cost", "tokens"])
    .optional()
    .default("created"),
  paginated: z
    .string()
    .optional()
    .default("false")
    .transform((val) => val === "true"),
})

// Schema for user agent leaderboard query
export const userAgentLeaderboardQuerySchema = z.object({
  from: z
    .string()
    .optional()
    .refine((val) => !val || !isNaN(Date.parse(val)), {
      message: "Invalid date format for 'from' parameter",
    })
    .transform((val) => (val ? new Date(val) : undefined)),
  to: z
    .string()
    .optional()
    .refine((val) => !val || !isNaN(Date.parse(val)), {
      message: "Invalid date format for 'to' parameter",
    })
    .transform((val) => (val ? new Date(val) : undefined)),
})

// Schema for agent analysis query
export const agentAnalysisQuerySchema = z.object({
  from: z
    .string()
    .optional()
    .refine((val) => !val || !isNaN(Date.parse(val)), {
      message: "Invalid date format for 'from' parameter",
    })
    .transform((val) => (val ? new Date(val) : undefined)),
  to: z
    .string()
    .optional()
    .refine((val) => !val || !isNaN(Date.parse(val)), {
      message: "Invalid date format for 'to' parameter",
    })
    .transform((val) => (val ? new Date(val) : undefined)),
  workspaceExternalId: z.string().optional(),
})

export const GetConnectors = async (c: Context) => {
  const { workspaceId, sub } = c.get(JwtPayloadKey)
  const users: SelectUser[] = await getUserByEmail(db, sub)
  if (users.length === 0) {
    loggerWithChild({ email: sub }).error(
      { sub },
      "No user found for sub in GetConnectors",
    )
    throw new NoUserFound({})
  }
  const user = users[0]
  const connectors = await getConnectors(workspaceId, user.id)
  return c.json(connectors)
}
export const GetProviders = async (c: Context) => {
  try {
    const provider = await getAppGlobalOAuthProvider(db, Apps.Slack)
    return c.json({ exists: !!provider })
  } catch (error) {
    return c.json({ exists: false })
  }
}

export const GetConnectorTools = async (c: Context) => {
  const { workspaceId, sub } = c.get(JwtPayloadKey)
  const connectorExternalId = c.req.param("connectorId")

  if (!connectorExternalId) {
    throw new HTTPException(400, { message: "Connector ID is required" })
  }

  const users: SelectUser[] = await getUserByEmail(db, sub)
  if (users.length === 0) {
    loggerWithChild({ email: sub }).error(
      { sub },
      "No user found for sub in GetConnectorTools",
    )
    throw new NoUserFound({})
  }
  const user = users[0]

  // Fetch the connector by its externalId to get the internal numeric id
  const connector = await getConnectorByExternalId(
    db,
    connectorExternalId,
    user.id,
  )
  if (!connector) {
    throw new HTTPException(404, {
      message: `Connector with ID ${connectorExternalId} not found.`,
    })
  }

  // Ensure the connector is an MCP type before fetching tools
  if (connector.type !== ConnectorType.MCP) {
    // Return empty array or specific message if not an MCP connector
    return c.json([])
  }

  const tools = await dbGetToolsByConnectorId(
    db,
    user.workspaceId,
    connector.id,
  )
  return c.json(tools)
}

const getAuthorizationUrl = async (
  c: Context,
  app: Apps,
  provider: SelectOAuthProvider,
): Promise<URL> => {
  const { sub } = c.get(JwtPayloadKey)
  const { clientId, clientSecret, oauthScopes } = provider
  let url: URL
  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  // for google refresh token
  if (IsGoogleApp(app)) {
    const google = new Google(
      clientId as string,
      clientSecret as string,
      `${config.host}/oauth/callback`,
    )
    loggerWithChild({ email: sub }).info(`code verifier  ${codeVerifier}`)

    // adding some data to state
    const newState = JSON.stringify({ app, random: state })
    url = google.createAuthorizationURL(newState, codeVerifier, oauthScopes)
    url.searchParams.set("access_type", "offline")
    url.searchParams.set("prompt", "consent")
  } else if (app === Apps.Slack) {
    // we are not using arctic as it would only go to oidc urls
    const newState = JSON.stringify({ app, random: state })
    url = new URL("https://slack.com/oauth/v2/authorize")
    url.searchParams.set("client_id", clientId!)
    url.searchParams.set("redirect_uri", `${slackHost}/oauth/callback`)
    url.searchParams.set("state", newState)
    url.searchParams.set("code", codeVerifier)
    url.searchParams.set("user_scope", oauthScopes.join(","))
  } else if (IsMicrosoftApp(app)) {
    const microsoft = new MicrosoftEntraId(
      "common",
      clientId as string,
      clientSecret as string,
      `${config.host}/oauth/callback`,
    )

    // adding some data to state
    const newState = JSON.stringify({ app, random: state })

    // Ensure scopes are properly formatted - filter out empty strings
    const validScopes = oauthScopes.filter(
      (scope) => scope && scope.trim() !== "",
    )
    let scopesToUse = validScopes
    if (validScopes.length === 0) {
      // Use default Microsoft scopes if none provided
      const { scopes: defaultScopes } = await import(
        "@/integrations/microsoft/config"
      )
      scopesToUse = defaultScopes
    }

    url = microsoft.createAuthorizationURL(newState, codeVerifier, scopesToUse)
  } else {
    throw new Error(`Unsupported app: ${app}`)
  }

  // store state verifier as cookie
  setCookieByEnv(c, `${app}-state`, state, {
    secure: true, // set to false in localhost
    path: "/",
    httpOnly: true,
    maxAge: 60 * 10, // 10 min
  })

  // store code verifier as cookie
  setCookieByEnv(c, `${app}-code-verifier`, codeVerifier, {
    secure: true, // set to false in localhost
    path: "/",
    httpOnly: true,
    maxAge: 60 * 10, // 10 min
  })
  return url
}

export const StartOAuth = async (c: Context) => {
  const path = getPath(c.req.raw)

  const { sub, workspaceId } = c.get(JwtPayloadKey)

  loggerWithChild({ email: sub }).info(
    {
      reqiestId: c.var.requestId,
      method: c.req.method,
      path,
    },
    "Started Oauth",
  )
  // @ts-ignore
  const { app }: OAuthStartQuery = c.req.valid("query")
  loggerWithChild({ email: sub }).info(`${sub} started ${app} OAuth`)
  const userRes = await getUserByEmail(db, sub)
  if (!userRes || !userRes.length) {
    loggerWithChild({ email: sub }).error(
      "Could not find user by email when starting OAuth",
    )
    throw new NoUserFound({})
  }
  const provider = await getOAuthProvider(db, userRes[0].id, app)
  const url = await getAuthorizationUrl(c, app, provider)
  return c.redirect(url.toString())
}

export const CreateOAuthProvider = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  const email = sub
  const userRes = await getUserByEmail(db, email)
  if (!userRes || !userRes.length) {
    throw new NoUserFound({})
  }
  const [user] = userRes
  // @ts-ignore
  const form: OAuthProvider = c.req.valid("form")
  const isUsingGlobalCred = form.isUsingGlobalCred

  let clientId = undefined
  let scopes = undefined
  let clientSecret = undefined
  let isGlobalProvider = undefined
  if (isUsingGlobalCred) {
    // get the global connector where the isGlobal flag is true
    try {
      const globalProviders = await getAppGlobalOAuthProvider(db, Apps.Slack)
      if (globalProviders.length > 0) {
        const globalProvider = globalProviders[0] // Take the first global provider
        clientId = globalProvider.clientId
        scopes = globalProvider.oauthScopes // Use oauthScopes instead of scopes to match the schema
        clientSecret = globalProvider.clientSecret
      }
    } catch (error) {
      loggerWithChild({ email: sub }).error(
        `Error fetching global OAuth provider: ${getErrorMessage(error)}`,
      )
      return c.json(
        {
          success: false,
          message: "No global OAuth provider exist",
        },
        500,
      )
    }
  } else {
    // When not using global creds, use form values and set isGlobalProvider to true
    clientId = form.clientId
    clientSecret = form.clientSecret
    scopes = form.scopes
    isGlobalProvider = form.isGlobalProvider
  }
  const app = form.app

  return await db.transaction(async (trx) => {
    const connector = await insertConnector(
      trx, // Pass the transaction object
      user.workspaceId,
      user.id,
      user.workspaceExternalId,
      `${app}-${ConnectorType.SaaS}-${AuthType.OAuth}`,
      ConnectorType.SaaS,
      AuthType.OAuth,
      app,
      {},
      null,
      null,
      null,
      null,
      ConnectorStatus.NotConnected,
    )
    if (!connector) {
      throw new ConnectorNotCreated({})
    }
    const provider = await createOAuthProvider(trx, {
      clientId: clientId!,
      clientSecret: clientSecret as string,
      oauthScopes: scopes || [],
      workspaceId: user.workspaceId,
      userId: user.id,
      isGlobal: isGlobalProvider,
      workspaceExternalId: user.workspaceExternalId,
      connectorId: connector.id,

      app,
    })
    return c.json({
      success: true,
      message: "Connection and Provider created",
    })
  })
}

export const AddServiceConnectionMicrosoft = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  loggerWithChild({ email: sub }).info("AddServiceConnectionMicrosoft")
  const email = sub
  const userRes = await getUserByEmail(db, email)
  if (!userRes || !userRes.length) {
    throw new NoUserFound({})
  }
  const [user] = userRes
  // @ts-ignore
  const form: microsoftService = c.req.valid("form")

  let { clientId, clientSecret, tenantId } = form
  let scopes = ["https://graph.microsoft.com/.default"]
  const app = Apps.MicrosoftSharepoint

  if (!clientId || !clientSecret || !tenantId) {
    throw new HTTPException(400, {
      message: "Client ID, Client Secret, and Tenant ID are required",
    })
  }

  try {
    const authProvider = new CustomServiceAuthProvider(
      tenantId,
      clientId,
      clientSecret,
    )

    const accessToken = await authProvider.getAccessTokenWithExpiry()
    const expiresAt = new Date(accessToken.expiresOnTimestamp)

    const credentialsData: MicrosoftServiceCredentials = {
      tenantId,
      clientId,
      clientSecret,
      scopes,
      access_token: accessToken.token,
      expires_at: expiresAt.toISOString(),
    }

    const res = await insertConnector(
      db,
      user.workspaceId,
      user.id,
      user.workspaceExternalId,
      `${app}-${ConnectorType.SaaS}-${AuthType.ServiceAccount}`,
      ConnectorType.SaaS,
      AuthType.ServiceAccount,
      app,
      {},
      JSON.stringify(credentialsData), // Store the validated credentials
      email, // Use current user's email as subject email
      null,
      null,
      ConnectorStatus.Connected, // Set as connected since we validated the connection
    )

    const connector = selectConnectorSchema.parse(res)

    if (!connector) {
      throw new ConnectorNotCreated({})
    }
    await handleMicrosoftServiceAccountIngestion(email, connector)

    loggerWithChild({ email: sub }).info(
      `Microsoft service account connector created with ID: ${connector.externalId}`,
    )

    return c.json({
      success: true,
      message: "connection created and job enqueued",
      id: connector.externalId,
      expiresAt: expiresAt.toISOString(),
    })
  } catch (error) {
    const errMessage = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `${new AddServiceConnectionError({
        cause: error as Error,
      })} \n : ${errMessage} : ${(error as Error).stack}`,
    )

    if (error instanceof HTTPException) {
      throw error
    }

    throw new HTTPException(500, {
      message: "Error creating Microsoft service account connection",
    })
  }
}

export const AddServiceConnection = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  loggerWithChild({ email: sub }).info("AddServiceConnection")
  const email = sub
  const userRes = await getUserByEmail(db, email)
  if (!userRes || !userRes.length) {
    throw new NoUserFound({})
  }
  const [user] = userRes
  // @ts-ignore
  const form: ServiceAccountConnection = c.req.valid("form")
  const serviceKeyData = await form["service-key"].text()
  const serviceAccountSubjectEmail = form.email // This is the service account's email (subject)
  const app = form.app
  const whitelistedEmailsString = form.whitelistedEmails // Read from validated form

  let whitelistedEmails: string[] | undefined = undefined

  if (whitelistedEmailsString && whitelistedEmailsString.trim() !== "") {
    whitelistedEmails = whitelistedEmailsString
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e)
  }

  // Start a transaction
  // return await db.transaction(async (trx) => {
  try {
    // Insert the connection within the transaction
    const connector = await insertConnector(
      db,
      user.workspaceId,
      user.id,
      user.workspaceExternalId,
      `${app}-${ConnectorType.SaaS}-${AuthType.ServiceAccount}`,
      ConnectorType.SaaS,
      AuthType.ServiceAccount,
      app,
      {},
      serviceKeyData,
      serviceAccountSubjectEmail,
    )

    const SaasJobPayload: SaaSJob = {
      connectorId: connector.id,
      workspaceId: user.workspaceId,
      userId: user.id,
      app,
      externalId: connector.externalId,
      authType: connector.authType as AuthType,
      email: sub,
      // Conditionally add whiteListedEmails to the payload
      ...(whitelistedEmails &&
        whitelistedEmails.length > 0 && { whitelistedEmails }),
    }

    if (IsGoogleApp(app)) {
      // Start ingestion in the background, but catch any errors it might throw later
      handleGoogleServiceAccountIngestion(SaasJobPayload).catch(
        (error: any) => {
          loggerWithChild({ email: email }).error(
            error,
            `Background Google Service Account ingestion failed for connector ${
              connector.id
            }: ${getErrorMessage(error)}`,
          )
        },
      )
    }

    // Logger.info(`Job ${jobId} enqueued for connection ${connector.id}`)

    // Commit the transaction if everything is successful
    return c.json({
      success: true,
      message: "Connection created, job enqueued",
      id: connector.externalId,
    })
  } catch (error) {
    const errMessage = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `${new AddServiceConnectionError({
        cause: error as Error,
      })} \n : ${errMessage} : ${(error as Error).stack}`,
    )
    // Rollback the transaction in case of any error
    throw new HTTPException(500, {
      message: "Error creating connection or enqueuing job",
    })
  }
  // })
}

export const UpdateServiceConnection = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  loggerWithChild({ email: sub }).info("UpdateServiceConnection")
  const email = sub
  const userRes = await getUserByEmail(db, email)
  if (!userRes || !userRes.length) {
    throw new NoUserFound({})
  }
  const [user] = userRes
  // @ts-ignore
  const form: UpdateServiceAccountConnection = c.req.valid("form")
  const serviceKeyData = await form["service-key"].text()
  const connectorId = form.connectorId

  try {
    // Get the existing connector
    const existingConnector = await getConnectorByExternalId(
      db,
      connectorId,
      user.id,
    )
    if (!existingConnector) {
      throw new HTTPException(404, {
        message: "Service account connector not found",
      })
    }

    // Verify it's a service account connector
    if (existingConnector.authType !== AuthType.ServiceAccount) {
      throw new HTTPException(400, {
        message: "Connector is not a service account type",
      })
    }

    // Update the connector with new credentials
    await updateConnector(db, existingConnector.id, {
      credentials: serviceKeyData,
      status: ConnectorStatus.Connected,
    })

    return c.json({
      success: true,
      message: "Service account updated",
      id: existingConnector.externalId,
    })
  } catch (error) {
    const errMessage = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `${new AddServiceConnectionError({
        cause: error as Error,
      })} \n : ${errMessage} : ${(error as Error).stack}`,
    )

    if (error instanceof HTTPException) {
      throw error
    }

    throw new HTTPException(500, {
      message: "Error updating service account connection",
    })
  }
}

// adding first for slack
// slack is using bot token for the initial ingestion and sync
// same service will be used for any api key based connector
export const AddApiKeyConnector = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  loggerWithChild({ email: sub }).info("ApiKeyConnector")
  const email = sub
  const userRes = await getUserByEmail(db, email)
  if (!userRes || !userRes.length) {
    throw new NoUserFound({})
  }
  const [user] = userRes
  // @ts-ignore
  const form: ApiKeyConnector = c.req.valid("form")
  const apiKey = form.apiKey
  const app = form.app

  // Start a transaction
  return await db.transaction(async (trx) => {
    try {
      // Insert the connection within the transaction
      const connector = await insertConnector(
        trx,
        user.workspaceId,
        user.id,
        user.workspaceExternalId,
        `${app}-${ConnectorType.SaaS}-${AuthType.ApiKey}`,
        ConnectorType.SaaS,
        AuthType.ApiKey,
        app,
        {},
        null,
        null,
        null,
        apiKey,
      )

      const SaasJobPayload: SaaSJob = {
        connectorId: connector.id,
        workspaceId: user.workspaceId,
        userId: user.id,
        app,
        externalId: connector.externalId,
        authType: connector.authType as AuthType,
        email: sub,
      }
      // Enqueue the background job within the same transaction
      const jobId = await boss.send(SaaSQueue, SaasJobPayload, {
        singletonKey: connector.externalId,
        priority: 1,
        retryLimit: 0,
      })

      loggerWithChild({ email: sub }).info(
        `Job ${jobId} enqueued for connection ${connector.id}`,
      )

      return c.json({
        success: true,
        message: "Connection created, job enqueued",
        id: connector.externalId,
      })
    } catch (error) {
      const errMessage = getErrorMessage(error)
      loggerWithChild({ email: sub }).error(
        error,
        `${new AddServiceConnectionError({
          cause: error as Error,
        })} \n : ${errMessage} : ${(error as Error).stack}`,
      )
      throw new HTTPException(500, {
        message: "Error creating connection or enqueuing job",
      })
    }
  })
}

export const UpdateConnectorStatus = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  const email = sub
  const userRes = await getUserByEmail(db, email)
  if (!userRes || !userRes.length) {
    throw new NoUserFound({})
  }
  const [user] = userRes
  const {
    connectorId,
    status, // @ts-ignore
  }: { connectorId: string; status: ConnectorStatus } = c.req.valid("form")
  const connector = await getConnectorByExternalId(db, connectorId, user.id)
  if (!connector) {
    throw new HTTPException(404, {
      message: "could not get connector",
    })
  }
  await updateConnector(db, connector.id, { status: status })
  return c.json({
    success: true,
    message: "connector updated",
  })
}
export const DeleteConnector = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  const email = sub
  const userRes = await getUserByEmail(db, email)
  if (!userRes || !userRes.length) {
    throw new NoUserFound({})
  }
  const [user] = userRes
  // @ts-ignore
  const { connectorId }: { connectorId: string } = c.req.valid("form")

  // Get connector details to check its type
  const connector = await getConnectorByExternalId(db, connectorId, user.id)
  if (!connector) {
    loggerWithChild({ email: sub }).warn(
      { connectorId, userId: user.id },
      "Connector not found for deletion",
    )
    throw new HTTPException(404, {
      message: `Connector not found: ${connectorId}`,
    })
  }

  // Check if it's an MCP connector and delete tools first if needed
  if (connector.type === ConnectorType.MCP) {
    try {
      // Delete all MCP tools associated with this connector
      await deleteToolsByConnectorId(db, user.workspaceId, connector.id)
      loggerWithChild({ email: sub }).info(
        `Deleted MCP tools for connector ${connectorId}`,
      )
    } catch (error) {
      loggerWithChild({ email: sub }).error(
        `Error deleting MCP tools: ${getErrorMessage(error)}`,
      )
      throw new Error(`Failed to delete MCP tools: ${getErrorMessage(error)}`)
    }
  }

  // Proceed with deleting the connector
  await deleteConnector(db, connectorId, user.id)

  return c.json({
    success: true,
    message: "Connector deleted",
  })
}

export const DeleteOauthConnector = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  const { connectorId: connectorExternalId }: { connectorId: string } =
    // @ts-ignore Ignore Hono validation type issue
    c.req.valid("form")

  if (!connectorExternalId) {
    loggerWithChild({ email: sub }).error(
      "connectorId (external) not provided in request for DeleteOauthConnector",
    )
    throw new HTTPException(400, { message: "Missing connectorId" })
  }

  const userRes = await getUserByEmail(db, sub)
  if (!userRes || !userRes.length) {
    loggerWithChild({ email: sub }).error(
      { sub },
      "No user found for sub in DeleteOauthConnector",
    )
    throw new NoUserFound({})
  }
  const [user] = userRes

  try {
    const connector = await getConnectorByExternalId(
      db,
      connectorExternalId,
      user.id,
    )
    if (!connector) {
      loggerWithChild({ email: sub }).warn(
        { connectorExternalId, userId: user.id },
        "Connector not found for deletion",
      )
      throw new HTTPException(404, {
        message: `Connector not found: ${connectorExternalId}`,
      })
    }
    const connectorInternalId = connector.id

    await db.transaction(async (trx) => {
      await deleteOauthConnector(trx, connectorInternalId)
    })
    return c.json({
      success: true,
      message: `OAuth connector ${connectorExternalId} and related data deleted successfully`,
    })
  } catch (error) {
    loggerWithChild({ email: sub }).error(
      { error, connectorExternalId, userId: user.id },
      "Error in DeleteOauthConnector API handler",
    )
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, {
      message: `Failed to delete connector ${connectorExternalId}: ${getErrorMessage(
        error,
      )}`,
      cause: error,
    })
  }
}

export const ServiceAccountIngestMoreUsersApi = async (c: Context) => {
  // @ts-ignore - Assuming payload is validated by zValidator and has the correct shape
  const payload = c.req.valid("json") as {
    connectorId: string
    emailsToIngest: string[]
    startDate: string
    endDate: string
    insertDriveAndContacts: boolean
    insertGmail: boolean
    insertCalendar: boolean
  }

  // Validate date range only if actual date strings are provided
  if (payload.startDate && payload.endDate) {
    // Both dates are non-empty strings
    const startDateObj = new Date(payload.startDate)
    const endDateObj = new Date(payload.endDate)

    if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime())) {
      throw new HTTPException(400, {
        message:
          "Invalid date format. If dates are provided, please use YYYY-MM-DD format.",
      })
    }
    if (endDateObj < startDateObj) {
      throw new HTTPException(400, {
        message: "End date must be after start date.",
      })
    }
  } else if (payload.startDate && !payload.endDate) {
    // Only startDate is non-empty
    const startDateObj = new Date(payload.startDate)
    if (isNaN(startDateObj.getTime())) {
      throw new HTTPException(400, {
        message: "Invalid start date format. Please use YYYY-MM-DD format.",
      })
    }
    // Frontend defaults endDate to today in this case, so it should arrive as a valid date string or empty if not defaulted.
    // If it arrives empty here, it means the frontend logic for defaulting didn't run or was bypassed.
    // The core ServiceAccountIngestMoreUsers will handle empty endDate appropriately.
  } else if (!payload.startDate && payload.endDate) {
    // Only endDate is non-empty
    const endDateObj = new Date(payload.endDate)
    if (isNaN(endDateObj.getTime())) {
      throw new HTTPException(400, {
        message: "Invalid end date format. Please use YYYY-MM-DD format.",
      })
    }
  }
  // If both payload.startDate and payload.endDate are empty strings, these validations are skipped,
  // and the empty strings are passed to ServiceAccountIngestMoreUsers.

  // Correct way to get userId, following existing patterns in this file
  const { sub } = c.get(JwtPayloadKey) // Get email (sub) from JWT
  const email = sub
  const userRes = await getUserByEmail(db, email)
  if (!userRes || !userRes.length) {
    loggerWithChild({ email: sub }).error(
      { email },
      "User not found for service account ingest more users.",
    )
    throw new NoUserFound({ message: `User with email ${email} not found.` })
  }
  const [userInstance] = userRes
  const userId = userInstance.id

  loggerWithChild({ email: sub }).info(
    `Attempting to ingest more users for SA connector: ${payload.connectorId} by user: ${userId}. Date range: ${payload.startDate} to ${payload.endDate}. Services: Drive & Contacts=${payload.insertDriveAndContacts}, Gmail=${payload.insertGmail}, Calendar=${payload.insertCalendar}`,
  )
  try {
    // ServiceAccountIngestMoreUsers expects payload and a numeric userId
    const result = await ServiceAccountIngestMoreUsers(payload, userId)
    return c.json({
      success: true,
      message: "Ingestion process for additional users started.",
      data: result,
    })
  } catch (error) {
    loggerWithChild({ email: sub }).error(
      error,
      `Failed to ingest more users for service account: ${getErrorMessage(
        error,
      )}`,
    )
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, {
      message: `Failed to ingest more users: ${getErrorMessage(error)}`,
    })
  }
}

export const AddApiKeyMCPConnector = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  loggerWithChild({ email: sub }).info("ApiKeyMCPConnector")
  const email = sub
  const userRes = await getUserByEmail(db, email)
  if (!userRes || !userRes.length) {
    throw new NoUserFound({})
  }
  const [user] = userRes
  // @ts-ignore
  const form: ApiKeyMCPConnector = c.req.valid("json")
  const { url, name: connectorName, mode, headers } = form
  // Normalize and sanitize headers (defensive)
  const forbiddenHeaderSet = new Set([
    "host",
    "connection",
    "proxy-connection",
    "transfer-encoding",
    "content-length",
    "keep-alive",
    "upgrade",
  ])
  const sanitizedHeaders: Record<string, string> = Object.fromEntries(
    Object.entries(headers ?? {})
      .filter(
        ([k, v]) =>
          typeof k === "string" && typeof v === "string" && v.trim() !== "",
      )
      .map(([k, v]) => [k.toLowerCase(), v])
      .filter(([k]) => !forbiddenHeaderSet.has(k)),
  )
  let status = ConnectorStatus.NotConnected
  try {
    // Insert the connection within the transaction
    const connector = await insertConnector(
      db,
      user.workspaceId,
      user.id,
      user.workspaceExternalId,
      connectorName,
      ConnectorType.MCP,
      AuthType.Custom, // Using Custom AuthType for headers
      Apps.MCP,
      { url: url, version: "0.1.0", mode: mode },
      JSON.stringify(sanitizedHeaders), // Storing headers in the encrypted credentials field
      null,
      null,
      null, // apiKey is no longer used
    )
    try {
      // Backwards compatibility logic demonstration for connection test
      const loadedConfig = connector.config as MCPClientConfig
      const loadedUrl = loadedConfig.url
      // Default to 'sse' for old connectors that won't have the mode field
      const loadedMode = loadedConfig.mode || MCPConnectorMode.SSE

      let loadedHeaders: Record<string, string> = {}

      if (connector.credentials) {
        // New format: credentials contain the headers object. The custom type decrypts it.
        try {
          loadedHeaders = JSON.parse(connector.credentials)
        } catch (error) {
          loggerWithChild({ email: sub }).error(
            `Failed to parse credentials for connector ${connector.externalId}: ${getErrorMessage(
              error,
            )}`,
          )
          loadedHeaders = {}
        }
      } else if (connector.apiKey) {
        // Old format: for backwards compatibility.
        loadedHeaders["Authorization"] = `Bearer ${connector.apiKey}`
      }

      const client = new Client({
        name: `connector-${connector.externalId}`,
        version: "0.1.0",
      })
      loggerWithChild({ email: sub }).info(
        `invoking client initialize for url: ${
          new URL(loadedUrl).origin
        }${new URL(loadedUrl).pathname} with mode: ${loadedMode}`,
      )

      if (loadedMode === MCPConnectorMode.StreamableHTTP) {
        const transportOptions: StreamableHTTPClientTransportOptions = {
          requestInit: {
            headers: loadedHeaders,
          },
        }
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(loadedUrl),
            transportOptions,
          ),
        )
      } else if (loadedMode === MCPConnectorMode.SSE) {
        const transportOptions: SSEClientTransportOptions = {
          requestInit: {
            headers: loadedHeaders,
          },
        }
        await client.connect(
          new SSEClientTransport(new URL(loadedUrl), transportOptions),
        )
      } else {
        // This case should ideally not be reached if validation is correct,
        // but it's a good safeguard.
        throw new Error(`Unsupported MCP connector mode: ${loadedMode}`)
      }

      status = ConnectorStatus.Connected

      // Fetch all available tools from the client
      // TODO: look in the DB. cache logic has to be discussed.
      const clientTools = await client.listTools()
      await client.close()

      // Update tool definitions in the database for future use
      await syncConnectorTools(
        db,
        user.workspaceId,
        connector.id,
        clientTools.tools.map((tool) => ({
          toolName: tool.name,
          toolSchema: JSON.stringify(tool),
          description: tool.description,
        })),
      )
    } catch (error) {
      status = ConnectorStatus.Failed
      loggerWithChild({ email: sub }).error(
        `error occurred while connecting to connector ${error}`,
      )
    }
    await updateConnector(db, connector.id, { status: status })
    return c.json({
      success: true,
      message: "Connector added",
      id: connector.externalId,
    })
  } catch (error) {
    const errMessage = getErrorMessage(error)
    loggerWithChild({ email: sub }).error(
      error,
      `${new AddServiceConnectionError({
        cause: error as Error,
      })} \n : ${errMessage} : ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Error creating connection or enqueuing job",
    })
  }
}
// New API Endpoint for User Data Deletion
export const AdminDeleteUserData = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey) // Get email (sub) of the admin performing the action
  const adminUserRes = await getUserByEmail(db, sub)
  if (!adminUserRes || !adminUserRes.length) {
    loggerWithChild({ email: sub }).error(
      { adminEmail: sub },
      "Admin user not found for data deletion action.",
    )
    throw new NoUserFound({
      message: `Admin user with email ${sub} not found.`,
    })
  }
  // Potentially add more authorization checks here to ensure only permitted admins can delete data.

  // @ts-ignore Use the new schema for validation
  const deletionRequest: DeleteUserDataPayload = c.req.valid("json")

  const { emailToClear, options } = deletionRequest

  // emailToClear is already validated by the Zod schema
  // No need for: if (!emailToClear || typeof emailToClear !== 'string') { ... }

  loggerWithChild({ email: sub }).info(
    { adminEmail: sub, targetEmail: emailToClear, options },
    "Admin initiated user data deletion.",
  )

  try {
    const deletionResults = await clearUserDataInVespa(emailToClear, options)
    loggerWithChild({ email: sub }).info(
      { adminEmail: sub, targetEmail: emailToClear, results: deletionResults },
      "User data deletion process completed.",
    )
    const appsToDelete = options?.servicesToClear
    const deleteSyncJob = options?.deleteSyncJob
    if (deleteSyncJob) {
      try {
        const deleteSyncJobResult = await clearUserSyncJob(
          db,
          emailToClear,
          appsToDelete || [],
        )
        loggerWithChild({ email: sub }).info(
          {
            adminEmail: sub,
            targetEmail: emailToClear,
            results: deleteSyncJobResult,
          },
          "SyncJob deletion process completed.",
        )
      } catch (error) {
        loggerWithChild({ email: sub }).error(
          {
            adminEmail: sub,
            targetEmail: emailToClear,
            results: error,
          },
          "Failed to delete user sync jobs.",
        )
      }
    }
    return c.json({
      success: true,
      message: `Data deletion process initiated for user ${emailToClear}. Check server logs for details.`,
      results: deletionResults,
    })
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    loggerWithChild({ email: sub }).error(
      error,
      `Failed to clear user data for ${emailToClear}: ${errorMessage}`,
    )
    throw new HTTPException(500, {
      message: `Failed to clear user data for ${emailToClear}: ${errorMessage}`,
    })
  }
}

export const UpdateToolsStatusApi = async (c: Context) => {
  const { workspaceId: workspaceExternalId, sub } = c.get(JwtPayloadKey) // Renamed to workspaceExternalId for clarity
  const users: SelectUser[] = await getUserByEmail(db, sub)
  if (users.length === 0) {
    loggerWithChild({ email: sub }).error(
      { sub },
      "No user found for sub in UpdateToolsStatusApi",
    )
    throw new NoUserFound({})
  }
  const user = users[0]

  const retrievedWorkspace = await getWorkspaceByExternalId(
    db,
    workspaceExternalId,
  )
  if (!retrievedWorkspace) {
    loggerWithChild({ email: sub }).error(
      { workspaceExternalId },
      "Workspace not found for external ID in UpdateToolsStatusApi",
    )
    throw new HTTPException(404, { message: "Workspace not found." })
  }
  const internalWorkspaceId = retrievedWorkspace.id // This is the integer ID
  // @ts-ignore - Assuming validation middleware handles this
  const payload = c.req.valid("json") as z.infer<typeof updateToolsStatusSchema>

  if (!payload.tools || payload.tools.length === 0) {
    return c.json({ success: true, message: "No tools to update." })
  }

  const toolUpdates = payload.tools.map(async (toolUpdate) => {
    try {
      const result = await db
        .update(toolsTable)
        .set({
          enabled: toolUpdate.enabled,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(toolsTable.id, toolUpdate.toolId),
            eq(toolsTable.workspaceId, internalWorkspaceId), // Use internal integer workspaceId
          ),
        )
        .returning({ updatedId: toolsTable.id })

      if (result.length === 0) {
        loggerWithChild({ email: sub }).warn(
          `Tool with id ${toolUpdate.toolId} not found in workspace ${internalWorkspaceId} (external: ${workspaceExternalId}) or no change needed.`,
        )
        // Optionally, you could collect these and report them back
      }
      // Ensure success is true only if result.length > 0
      return { toolId: toolUpdate.toolId, success: result.length > 0 }
    } catch (error) {
      loggerWithChild({ email: sub }).error(
        error,
        `Failed to update tool ${
          toolUpdate.toolId
        } in workspace ${internalWorkspaceId} (external: ${workspaceExternalId}): ${getErrorMessage(error)}`,
      )
      return {
        toolId: toolUpdate.toolId,
        success: false,
        error: getErrorMessage(error),
      }
    }
  })

  const results = await Promise.all(toolUpdates)
  const failedUpdates = results.filter((r) => !r.success)

  if (failedUpdates.length > 0) {
    loggerWithChild({ email: sub }).error(
      { failedUpdates },
      "Some tools failed to update.",
    )
    return c.json(
      {
        success: false,
        message: "Some tools failed to update.",
        failedUpdates,
      },
      500,
    )
  }

  return c.json({ success: true, message: "Tools updated successfully." })
}

export const AddStdioMCPConnector = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  loggerWithChild({ email: sub }).info("StdioMCPConnector")
  const email = sub
  const userRes = await getUserByEmail(db, email)
  if (!userRes || !userRes.length) {
    throw new NoUserFound({})
  }
  const [user] = userRes
  // @ts-ignore
  const form: StdioMCPConnector = c.req.valid("form")
  const command = form.command
  // const args = form.args.join(" ") // Changed: No longer joining args here
  const name = form.name
  let app
  let status = ConnectorStatus.NotConnected
  loggerWithChild({ email: sub }).info(
    `called with req body ${form} ${form.appType}`,
  )
  switch (form.appType) {
    case "github":
      app = Apps.Github
      break
    default:
      app = Apps.MCP
  }

  try {
    // Insert the connection within the transaction
    const connector = await insertConnector(
      db,
      user.workspaceId,
      user.id,
      user.workspaceExternalId,
      app,
      ConnectorType.MCP,
      AuthType.Custom,
      app,
      { command: command, args: form.args, version: "0.1.0" }, // Changed: Pass form.args (string[])
      null,
      null,
      null,
      null,
    )
    try {
      const config = connector.config as z.infer<typeof MCPClientStdioConfig> // Changed: Use z.infer for type assertion
      const client = new Client({
        name: `connector-${connector.externalId}`,
        version: config.version,
      })
      loggerWithChild({ email: sub }).info(
        `invoking stdio to ${config.command} with args: ${config.args.join(" ")}`, // Logging joined args for readability if needed
      )
      await client.connect(
        new StdioClientTransport({
          command: config.command,
          args: config.args, // Changed: Pass config.args (string[]) directly
        }),
      )
      status = ConnectorStatus.Connected
      // Fetch all available tools from the client
      // TODO: look in the DB. cache logic has to be discussed.
      const clientTools = await client.listTools()
      await client.close()

      // Update tool definitions in the database for future use
      await syncConnectorTools(
        db,
        user.workspaceId,
        connector.id,
        clientTools.tools.map((tool) => ({
          toolName: tool.name,
          toolSchema: JSON.stringify(tool),
          description: tool.description,
        })),
      )
    } catch (error) {
      status = ConnectorStatus.Failed
      loggerWithChild({ email: sub }).error(
        `error occurred while connecting to connector ${error}`,
      )
    }
    await updateConnector(db, connector.id, { status: status })
    return c.json({
      success: true,
      message: "Connector added",
      id: connector.externalId,
    })
  } catch (error) {
    const errMessage = getErrorMessage(error)
    loggerWithChild({ email: sub }).error(
      error,
      `${new AddServiceConnectionError({
        cause: error as Error,
      })} \n : ${errMessage} : ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Error creating connection or enqueuing job",
    })
  }
}
export const StartSlackIngestionApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  // @ts-ignore - Assuming payload is validated by zValidator
  const payload = c.req.valid("json") as { connectorId: number }

  try {
    const userRes = await getUserByEmail(db, sub)
    if (!userRes || !userRes.length) {
      loggerWithChild({ email: sub }).error(
        { sub },
        "No user found for sub in StartSlackIngestionApi",
      )
      throw new NoUserFound({})
    }
    const [user] = userRes

    const connector = await getConnector(db, payload.connectorId)
    if (!connector) {
      throw new HTTPException(404, { message: "Connector not found" })
    }

    // Call the main Slack ingestion function
    handleSlackIngestion({
      connectorId: connector.id,
      app: connector.app as Apps,
      externalId: connector.externalId,
      authType: connector.authType as AuthType,
      email: sub,
    }).catch((error) => {
      loggerWithChild({ email: sub }).error(
        error,
        `Background Slack ingestion failed for connector ${connector.id}: ${getErrorMessage(error)}`,
      )
    })

    return c.json({
      success: true,
      message: "Regular Slack ingestion started.",
    })
  } catch (error: any) {
    loggerWithChild({ email: sub }).error(
      error,
      `Error starting regular Slack ingestion: ${getErrorMessage(error)}`,
    )
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, {
      message: `Failed to start regular Slack ingestion: ${getErrorMessage(error)}`,
    })
  }
}

export const StartGoogleIngestionApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  // @ts-ignore - Assuming payload is validated by zValidator
  const payload = c.req.valid("json") as { connectorId: string }
  try {
    const userRes = await getUserByEmail(db, sub)
    if (!userRes || !userRes.length) {
      loggerWithChild({ email: sub }).error(
        { sub },
        "No user found for sub in StartGoogleIngestionApi",
      )
      throw new NoUserFound({})
    }
    const [user] = userRes

    const connector = await getConnectorByExternalId(
      db,
      payload.connectorId,
      user.id,
    )
    if (!connector) {
      throw new HTTPException(404, { message: "Connector not found" })
    }

    // Call the main Google ingestion function
    handleGoogleOAuthIngestion({
      connectorId: connector.id,
      app: connector.app as Apps,
      externalId: connector.externalId,
      authType: connector.authType as AuthType,
      email: sub,
    }).catch((error) => {
      loggerWithChild({ email: sub }).error(
        error,
        `Background Google ingestion failed for connector ${connector.id}: ${getErrorMessage(error)}`,
      )
    })

    return c.json({
      success: true,
      message: "Regular Google ingestion started.",
    })
  } catch (error: any) {
    loggerWithChild({ email: sub }).error(
      error,
      `Error starting regular Google ingestion: ${getErrorMessage(error)}`,
    )
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, {
      message: `Failed to start regular Google ingestion: ${getErrorMessage(error)}`,
    })
  }
}
// API endpoint for starting resumable Slack channel ingestion
// Creates an ingestion record and starts background processing
// Returns immediate response while ingestion runs in sync-server
export const IngestMoreChannelApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  // @ts-ignore
  const payload = c.req.valid("json") as {
    connectorId: number
    channelsToIngest: string[]
    startDate: string
    endDate: string
    includeBotMessage: boolean
  }

  try {
    // Validate user exists and has access
    const userRes = await getUserByEmail(db, sub)
    if (!userRes || !userRes.length) {
      loggerWithChild({ email: sub }).error(
        { sub },
        "No user found for sub in IngestMoreChannelApi",
      )
      throw new NoUserFound({})
    }
    const [user] = userRes

    // Validate connector exists and user has access
    const connector = await getConnector(db, payload.connectorId)
    if (!connector) {
      throw new HTTPException(404, { message: "Connector not found" })
    }

    // Import ingestion functions for database operations
    const { createIngestion, hasActiveIngestion } = await import(
      "@/db/ingestion"
    )

    // Prevent concurrent ingestions using database transaction to avoid race conditions
    // This atomically checks for active ingestions and creates new one if none exist
    const ingestion = await db.transaction(async (trx) => {
      const hasActive = await hasActiveIngestion(trx, user.id, connector.id)
      if (hasActive) {
        throw new HTTPException(409, {
          message:
            "An ingestion is already in progress for this connector. Please wait for it to complete or cancel it first.",
        })
      }

      // Create ingestion record with initial metadata for resumability
      // All state needed for resuming is stored in the metadata field
      return await createIngestion(trx, {
        userId: user.id,
        connectorId: connector.id,
        workspaceId: connector.workspaceId,
        status: "pending",
        metadata: {
          slack: {
            // Data sent to frontend via WebSocket for progress display
            websocketData: {
              connectorId: connector.externalId,
              progress: {
                totalChannels: payload.channelsToIngest.length,
                processedChannels: 0,
                totalMessages: 0,
                processedMessages: 0,
              },
            },
            // Internal state data for resumability
            ingestionState: {
              channelsToIngest: payload.channelsToIngest,
              startDate: payload.startDate,
              endDate: payload.endDate,
              includeBotMessage: payload.includeBotMessage,
              currentChannelIndex: 0, // Resume from this channel
              lastUpdated: new Date().toISOString(),
            },
          },
        },
      })
    })

    // Start background ingestion processing asynchronously
    // Ingestion runs in sync-server while API returns immediately
    const email = sub
    handleSlackChannelIngestion(
      connector.id,
      payload.channelsToIngest,
      payload.startDate,
      payload.endDate,
      email,
      payload.includeBotMessage,
      ingestion.id, // Pass ingestion ID for progress tracking
    ).catch((error) => {
      loggerWithChild({ email: sub }).error(
        error,
        `Background Slack channel ingestion failed for connector ${connector.id}: ${getErrorMessage(error)}`,
      )
    })

    // Return immediate success response to frontend
    // Actual progress will be communicated via WebSocket
    return c.json({
      success: true,
      message: "Slack channel ingestion started.",
      ingestionId: ingestion.id,
    })
  } catch (error) {
    loggerWithChild({ email: sub }).error(
      error,
      "Failed to start Slack channel ingestion",
    )
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, {
      message: `Failed to start Slack channel ingestion: ${getErrorMessage(error)}`,
    })
  }
}

// Admin Dashboard API Functions

export const GetAdminChats = async (c: Context) => {
  try {
    // Get current user and workspace info
    const { workspaceId: currentWorkspaceId } = c.get(JwtPayloadKey)

    // Use validated query parameters from schema
    const query = c.req.query()
    const validatedParams = adminQuerySchema.parse(query)
    const {
      from,
      to,
      userId,
      page,
      offset: pageSize,
      search,
      filterType,
      sortBy,
      paginated,
    } = validatedParams

    // Build the conditions array
    const conditions = []

    // Always exclude deleted messages
    conditions.push(isNull(messages.deletedAt))
    conditions.push(isNull(chats.deletedAt))

    // Add workspace filtering unless user is SuperAdmin
    // if (!isSuperAdmin) {
    conditions.push(eq(users.workspaceExternalId, currentWorkspaceId))
    // }

    if (from) {
      conditions.push(gte(chats.createdAt, from))
    }
    if (to) {
      conditions.push(lte(chats.createdAt, to))
    }
    if (userId) {
      conditions.push(eq(chats.userId, userId))
    }

    // Add filterType conditions
    if (filterType === "agent") {
      conditions.push(isNotNull(chats.agentId))
    } else if (filterType === "normal") {
      conditions.push(isNull(chats.agentId))
    }

    // Add search functionality using ORM methods
    if (search) {
      const searchParam = `%${search}%`
      const searchCondition = or(
        ilike(chats.title, searchParam),
        ilike(users.email, searchParam),
        ilike(users.name, searchParam),
      )
      conditions.push(searchCondition)
    }

    // First, get the total count using Drizzle count function
    const totalCountResult = await db
      .select({
        count: count(),
      })
      .from(chats)
      .leftJoin(users, eq(chats.userId, users.id))
      .leftJoin(messages, eq(chats.id, messages.chatId))
      .where(and(...conditions))
      .groupBy(chats.id, users.email, users.name, users.role, users.createdAt)

    const totalCount = totalCountResult.length

    // Build the query with feedback aggregation and cost tracking
    const baseQuery = db
      .select({
        id: chats.id,
        externalId: chats.externalId,
        title: chats.title,
        createdAt: chats.createdAt,
        agentId: chats.agentId,
        userId: chats.userId,
        userEmail: users.email,
        userName: users.name,
        userRole: users.role,
        userCreatedAt: users.createdAt,
        messageCount: count(
          sql`CASE WHEN ${messages.deletedAt} IS NULL THEN ${messages.id} END`,
        ),
        likes: count(
          sql`CASE WHEN ${messages.feedback}->>'type' = 'like' AND ${messages.deletedAt} IS NULL THEN 1 END`,
        ),
        dislikes: count(
          sql`CASE WHEN ${messages.feedback}->>'type' = 'dislike' AND ${messages.deletedAt} IS NULL THEN 1 END`,
        ),
        totalCost: sum(
          sql`CASE WHEN ${messages.deletedAt} IS NULL THEN ${messages.cost} ELSE 0 END`,
        ),
        totalTokens: sum(
          sql`CASE WHEN ${messages.deletedAt} IS NULL THEN ${messages.tokensUsed} ELSE 0 END`,
        ),
      })
      .from(chats)
      .leftJoin(users, eq(chats.userId, users.id))
      .leftJoin(messages, eq(chats.id, messages.chatId))

    // Determine sort order based on sortBy parameter
    let orderByClause
    switch (sortBy) {
      case "messages":
        orderByClause = desc(
          count(
            sql`CASE WHEN ${messages.deletedAt} IS NULL THEN ${messages.id} END`,
          ),
        )
        break
      case "cost":
        orderByClause = desc(
          sql`COALESCE(SUM(CASE WHEN ${messages.deletedAt} IS NULL THEN ${messages.cost} ELSE 0 END), 0)`,
        )
        break
      case "tokens":
        orderByClause = desc(
          sum(
            sql`CASE WHEN ${messages.deletedAt} IS NULL THEN ${messages.tokensUsed} ELSE 0 END`,
          ),
        )
        break
      case "created":
      default:
        orderByClause = desc(chats.createdAt)
        break
    }

    // Execute the query with conditional pagination
    let result
    if (paginated) {
      // Apply pagination when paginated=true
      const limit = pageSize || 20
      const offsetValue = (page - 1) * limit

      result = await baseQuery
        .where(and(...conditions))
        .groupBy(chats.id, users.email, users.name, users.role, users.createdAt)
        .orderBy(orderByClause)
        .limit(limit)
        .offset(offsetValue)
    } else {
      // Fetch all results when paginated=false
      result = await baseQuery
        .where(and(...conditions))
        .groupBy(chats.id, users.email, users.name, users.role, users.createdAt)
        .orderBy(orderByClause)
    }

    // Convert totalCost from string to number and totalTokens from bigint to number
    const processedResult = result.map((chat) => ({
      ...chat,
      totalCost: Number(chat.totalCost) || 0, // numeric → string at runtime
      totalTokens: Number(chat.totalTokens) || 0, // bigint → string at runtime
    }))

    // Calculate pagination metadata based on paginated parameter
    let response
    if (paginated) {
      const currentPageSize = pageSize || 50
      const hasNextPage = page * currentPageSize < totalCount
      const hasPreviousPage = page > 1

      response = {
        data: processedResult,
        pagination: {
          totalCount,
          currentPage: page,
          pageSize: currentPageSize,
          hasNextPage,
          hasPreviousPage,
          paginated: true,
        },
      }
    } else {
      // For non-paginated queries, return all data without pagination metadata
      response = {
        data: processedResult,
        pagination: {
          totalCount,
          paginated: false,
        },
      }
    }

    return c.json(response)
  } catch (error) {
    Logger.error(error, "Error fetching admin chats")
    return c.json(
      {
        success: false,
        message: getErrorMessage(error),
      },
      500,
    )
  }
}

export const GetAdminAgents = async (c: Context) => {
  try {
    const result = await db
      .select({
        id: agents.id,
        externalId: agents.externalId,
        name: agents.name,
        description: agents.description,
        isPublic: agents.isPublic,
        createdAt: agents.createdAt,
        userId: agents.userId,
        workspaceId: agents.workspaceId,
      })
      .from(agents)

    return c.json(result)
  } catch (error) {
    Logger.error(error, "Error fetching admin agents")
    return c.json(
      {
        success: false,
        message: getErrorMessage(error),
      },
      500,
    )
  }
}

export const GetAdminUsers = async (c: Context) => {
  try {
    const result = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        createdAt: users.createdAt,
        lastLogin: users.lastLogin,
        isActive: isNull(users.deletedAt),
        totalChats: sql<number>`COUNT(DISTINCT ${chats.id})::int`,
        totalMessages: sql<number>`COUNT(${messages.id})::int`,
        likes: sql<number>`COUNT(CASE WHEN ${messages.feedback}->>'type' = 'like' THEN 1 END)::int`,
        dislikes: sql<number>`COUNT(CASE WHEN ${messages.feedback}->>'type' = 'dislike' THEN 1 END)::int`,
        totalCost: sql<number>`COALESCE(SUM(${messages.cost}), 0)::numeric`,
        totalTokens: sql<number>`COALESCE(SUM(${messages.tokensUsed}), 0)::bigint`,
      })
      .from(users)
      .leftJoin(chats, eq(users.id, chats.userId))
      .leftJoin(messages, eq(chats.id, messages.chatId))
      .groupBy(
        users.id,
        users.email,
        users.name,
        users.role,
        users.createdAt,
        users.lastLogin,
        users.deletedAt,
      )

    // Convert totalCost from string to number and totalTokens from bigint to number
    const processedResult = result.map((user) => ({
      ...user,
      totalCost: Number(user.totalCost) || 0, // numeric → string at runtime
      totalTokens: Number(user.totalTokens) || 0, // bigint → string at runtime
    }))

    return c.json(processedResult)
  } catch (error) {
    Logger.error(error, "Error fetching admin users")
    return c.json(
      {
        success: false,
        message: getErrorMessage(error),
      },
      500,
    )
  }
}

/**
 * Get agent leaderboard for a specific user showing their usage across all agents
 */
export const GetUserAgentLeaderboard = async (c: Context) => {
  try {
    const userId = c.req.param("userId")
    // @ts-ignore
    const { from, to } = c.req.valid("query")

    if (!userId) {
      return c.json(
        {
          success: false,
          message: "User ID is required",
        },
        400,
      )
    }

    // Validate that userId is a valid number string
    const userIdNumber = Number(userId)
    if (
      isNaN(userIdNumber) ||
      !Number.isInteger(userIdNumber) ||
      userIdNumber <= 0
    ) {
      return c.json(
        {
          success: false,
          message: "User ID must be a valid positive integer",
        },
        400,
      )
    }

    // Get the user's workspace information
    const user = await db
      .select({
        workspaceExternalId: users.workspaceExternalId,
      })
      .from(users)
      .where(eq(users.id, userIdNumber))
      .limit(1)

    if (user.length === 0) {
      return c.json(
        {
          success: false,
          message: "User not found",
        },
        404,
      )
    }

    const workspaceExternalId = user[0].workspaceExternalId

    const timeRange = from && to ? { from, to } : undefined

    const leaderboard = await getUserAgentLeaderboard({
      db,
      userId: userIdNumber,
      workspaceExternalId,
      timeRange,
    })

    return c.json({
      success: true,
      data: leaderboard,
      totalAgents: leaderboard.length,
    })
  } catch (error) {
    Logger.error(error, "Error fetching user agent leaderboard")
    return c.json(
      {
        success: false,
        message: getErrorMessage(error),
      },
      500,
    )
  }
}

/**
 * Get agent analysis data showing agent stats and user leaderboard who have used it
 */
export const GetAgentAnalysis = async (c: Context) => {
  try {
    const agentId = c.req.param("agentId")
    // @ts-ignore
    const { from, to, workspaceExternalId } = c.req.valid("query")

    if (!agentId) {
      return c.json(
        {
          success: false,
          message: "Agent ID is required",
        },
        400,
      )
    }

    const timeRange = from && to ? { from, to } : undefined

    const agentAnalysis = await getAgentAnalysis({
      db,
      agentId,
      workspaceExternalId, // Can be undefined for admin cross-workspace view
      timeRange,
    })

    if (!agentAnalysis) {
      return c.json(
        {
          success: false,
          message: "Agent not found",
        },
        404,
      )
    }

    return c.json({
      success: true,
      data: agentAnalysis,
    })
  } catch (error) {
    Logger.error(error, "Error fetching agent analysis")
    return c.json(
      {
        success: false,
        message: getErrorMessage(error),
      },
      500,
    )
  }
}

export const GetAgentFeedbackMessages = async (c: Context) => {
  try {
    const agentId = c.req.param("agentId")
    // @ts-ignore
    const { from, to, workspaceExternalId } = c.req.valid("query")

    if (!agentId) {
      return c.json(
        {
          success: false,
          message: "Agent ID is required",
        },
        400,
      )
    }

    const timeRange = from && to ? { from, to } : undefined

    const feedbackMessages = await getAgentFeedbackMessages({
      db,
      agentId,
      workspaceExternalId, // Can be undefined for admin cross-workspace view
      timeRange,
    })

    return c.json({
      success: true,
      data: feedbackMessages,
    })
  } catch (error) {
    Logger.error(error, "Error fetching agent feedback messages")
    return c.json(
      {
        success: false,
        message: getErrorMessage(error),
      },
      500,
    )
  }
}

export const GetAgentUserFeedbackMessages = async (c: Context) => {
  try {
    const agentId = c.req.param("agentId")
    const userId = c.req.param("userId")
    // @ts-ignore
    const { workspaceExternalId } = c.req.valid("query")

    if (!agentId) {
      return c.json(
        {
          success: false,
          message: "Agent ID is required",
        },
        400,
      )
    }

    if (!userId) {
      return c.json(
        {
          success: false,
          message: "User ID is required",
        },
        400,
      )
    }

    const feedbackMessages = await getAgentUserFeedbackMessages({
      db,
      agentId,
      userId: parseInt(userId),
      workspaceExternalId, // Can be undefined for admin cross-workspace view
    })

    return c.json({
      success: true,
      data: feedbackMessages,
    })
  } catch (error) {
    Logger.error(error, "Error fetching user feedback messages")
    return c.json(
      {
        success: false,
        message: getErrorMessage(error),
      },
      500,
    )
  }
}

/**
 * Get all feedback messages for a specific user across all agents (admin use)
 */
export const GetAllUserFeedbackMessages = async (c: Context) => {
  try {
    const { userId } = c.req.param()
    const userIdNum = parseInt(userId, 10)

    if (isNaN(userIdNum)) {
      return c.json(
        {
          success: false,
          message: "Invalid user ID",
        },
        400,
      )
    }

    // Get all feedback messages for this user across all agents
    const feedbackMessages = await getAllUserFeedbackMessages({
      db,
      userId: userIdNum,
    })

    return c.json({
      success: true,
      data: feedbackMessages,
    })
  } catch (error) {
    Logger.error(error, "Error fetching all user feedback messages")
    return c.json(
      {
        success: false,
        message: getErrorMessage(error),
      },
      500,
    )
  }
}

export const ListAllLoggedInUsers = async (c: Context) => {
  try {
    const { workspaceId } = c.get(JwtPayloadKey)

    const users = await getAllLoggedInUsers(db, workspaceId)
    return c.json({
      success: true,
      data: users,
      message: `Successfully fetched the users`,
    })
  } catch (error) {
    return c.json(
      {
        success: false,
        message: `Failed to fetch the users : ${getErrorMessage(error)}`,
      },
      500,
    )
  }
}
export const ListAllIngestedUsers = async (c: Context) => {
  try {
    const { workspaceId } = c.get(JwtPayloadKey)
    const users = await getAllIngestedUsers(db, workspaceId)
    return c.json({
      success: true,
      data: users,
      message: `Successfully fetched the users`,
    })
  } catch (error) {
    return c.json(
      {
        success: false,
        message: `Failed to fetch the users : ${getErrorMessage(error)}`,
      },
      500,
    )
  }
}

export const UpdateUser = async (c: Context) => {
  try {
    // @ts-ignore
    const form: userRoleChange = c.req.valid("form")
    const userId = form.userId
    const role = form.newRole
    const resp = await updateUser(db, parseInt(userId), role)
    return c.json({
      success: true,
      message: "User role updated successfully",
    })
  } catch (error) {
    return c.json(
      {
        success: false,
        message: `Failed to update the user:${getErrorMessage(error)}`,
      },
      500,
    )
  }
}

export const syncByMailSchema = z.object({
  email: z.string(),
})

export const HandlePerUserGoogleWorkSpaceSync = async (c: Context) => {
  try {
    Logger.info("HandlePerUserGoogleWorkSpaceSync called")
    // @ts-ignore
    const validatedData = c.req.valid("json") as { email: string }

    const targetUser = await getUserByEmail(db, validatedData.email)
    if (!targetUser || !targetUser.length) {
      throw new HTTPException(404, { message: "User not found" })
    }

    const jobData = {
      email: validatedData.email,
      syncOnlyCurrentUser: true,
    }

    const mockJob = {
      data: jobData,
      id: `manual-sync-${Date.now()}`,
    }

    // Call the appropriate sync function based on AUTH_TYPE from config
    if (config.CurrentAuthType === AuthType.OAuth) {
      loggerWithChild({ email: validatedData.email }).info(
        "Using OAuth-based sync for Google Workspace",
      )
      await handleGoogleOAuthChanges(boss, mockJob as Job)
    } else {
      loggerWithChild({ email: validatedData.email }).info(
        "Using Service Account-based sync for Google Workspace",
      )
      await handleGoogleServiceAccountChanges(boss, mockJob as Job)
    }

    return c.json({
      success: true,
      message: "Google Workspace sync initiated successfully",
    })
  } catch (error) {
    Logger.error(`Failed to sync googleWorkspace: ${getErrorMessage(error)}`)
    return c.json(
      {
        success: false,
        message: `Failed to sync googleWorkspace : ${getErrorMessage(error)}`,
      },
      500,
    )
  }
}

export const HandlePerUserSlackSync = async (c: Context) => {
  try {
    Logger.info("HandlePerUserSlackSync called")
    // @ts-ignore
    const validatedData = c.req.valid("json") as { email: string }
    const targetUser = await getUserByEmail(db, validatedData.email)
    if (!targetUser || !targetUser.length) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const jobData = {
      email: validatedData.email,
      syncOnlyCurrentUser: true,
    }

    const mockJob = {
      data: jobData,
      id: `manual-slack-sync-${Date.now()}`,
    }

    await handleSlackChanges(boss, mockJob as Job)

    return c.json({
      success: true,
      message: "Slack sync initiated successfully",
    })
  } catch (error) {
    Logger.error(`Failed to sync Slack: ${getErrorMessage(error)}`)
    return c.json(
      {
        success: false,
        message: `Failed to sync Slack: ${getErrorMessage(error)}`,
      },
      500,
    )
  }
}

export const GetKbVespaContent = async (c: Context) => {
  try {
    const { sub: userEmail } = c.get(JwtPayloadKey)

    const rawData = await c.req.json()
    const validatedData = getDocumentSchema.parse(rawData)
    const { docId, sheetIndex, schema: rawSchema } = validatedData
    const validSchemas = [KbItemsSchema]
    if (!validSchemas.includes(rawSchema)) {
      throw new HTTPException(400, {
        message: `Invalid schema type. Expected 'kb_items', got '${rawSchema}'`,
      })
    }
    const collectionFile = await getCollectionFilesVespaIds([docId], db)
    if (!collectionFile[0]) {
      throw new HTTPException(404, {
        message: `Document with id ${docId} not found in the system.`,
      })
    }

    const rawVespaDocId = collectionFile[0].vespaDocId
    if (!rawVespaDocId) {
      throw new HTTPException(500, {
        message: "Document Vespa ID is missing in the system.",
      })
    }
    const vespaDocId = replaceSheetIndex(rawVespaDocId, sheetIndex ?? 0)
    // console.log("Fetched Vespa Doc ID:", vespaDocId)
    const schema = rawSchema as VespaSchema

    const documentData = await GetDocument(schema, vespaDocId)

    if (!documentData || !("fields" in documentData) || !documentData.fields) {
      loggerWithChild({ email: userEmail }).warn(
        `Document not found or fields missing for docId: ${docId}, schema: ${schema} during delete operation by ${userEmail}`,
      )
      throw new HTTPException(404, { message: "Document not found." })
    }

    const fields = documentData.fields as Record<string, any>
    let ownerEmail: string

    ownerEmail = fields.createdBy as string

    if (!ownerEmail) {
      loggerWithChild({ email: userEmail }).error(
        `Ownership field (createdBy/uploadedBy) missing for document ${docId} of schema ${schema}. Cannot verify ownership for user ${userEmail}.`,
      )
      throw new HTTPException(500, {
        message:
          "Internal server error: Cannot verify document ownership due to missing data.",
      })
    }
    if (ownerEmail !== userEmail) {
      loggerWithChild({ email: userEmail }).warn(
        `User ${userEmail} attempt to access document ${docId} (schema: ${schema}) owned by ${ownerEmail}. Access denied.`,
      )
      throw new HTTPException(403, {
        message:
          "Forbidden: You do not have permission to access this document.",
      })
    }
    loggerWithChild({ email: userEmail }).info(
      `User ${userEmail} authorized to access document ${docId} (schema: ${schema}) owned by ${ownerEmail}.`,
    )
    return c.json(
      {
        success: true,
        data: fields,
      },
      200,
    )
  } catch (error) {
    Logger.error(error, "Error fetching Vespa data for KB document")
    throw new HTTPException(500, {
      message:
        "Unable to fetch document data at this time. Please try again later.",
    })
  }
}

export const GetChatQueriesApi = async (c: Context) => {
  try {
    const chatId = c.req.param("chatId")
    const { workspaceId: currentWorkspaceId } = c.get(JwtPayloadKey)

    const queries = await fetchUserQueriesForChat(
      db,
      chatId,
      currentWorkspaceId,
    )

    return c.json(
      {
        success: true,
        data: queries,
      },
      200,
    )
  } catch (error) {
    Logger.error(error, "Error fetching chat queries")
    if (error instanceof HTTPException) {
      throw error
    }
    return c.json(
      {
        success: false,
        message: getErrorMessage(error),
      },
      500,
    )
  }
}
