import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { db } from "@/db/client"
import { getUserByEmail } from "@/db/user"
import { getWorkspaceByExternalId } from "@/db/workspace" // Added import
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  syncConnectorTools,
  deleteToolsByConnectorId,
  getToolsByConnectorId as dbGetToolsByConnectorId,
  tools as toolsTable,
} from "@/db/tool" // Added dbGetToolsByConnectorId and toolsTable
import { eq, and, inArray, sql, gte, lte, isNull } from "drizzle-orm"
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
  type ApiKeyMCPConnector,
  type StdioMCPConnector,
  MCPClientStdioConfig,
  Subsystem,
  updateToolsStatusSchema, // Added for tool status updates
} from "@/types"
import { z } from "zod"
import { boss, SaaSQueue } from "@/queue"
import config from "@/config"
import { Apps, AuthType, ConnectorStatus, ConnectorType } from "@/shared/types"
import {
  createOAuthProvider,
  getAppGlobalOAuthProvider,
  getOAuthProvider,
} from "@/db/oauthProvider"
const { JwtPayloadKey, slackHost } = config
import { generateCodeVerifier, generateState, Google, Slack } from "arctic"
import type { SelectOAuthProvider, SelectUser } from "@/db/schema"
import { users, chats, messages, agents } from "@/db/schema" // Add database schema imports
import { getErrorMessage, IsGoogleApp, setCookieByEnv } from "@/utils"
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
import { handleGoogleServiceAccountIngestion } from "@/integrations/google"
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
      clientSecret,
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
      clientId,
      clientSecret,
      oauthScopes: scopes,
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
    throw new HTTPException(500, {
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
  const form: ApiKeyMCPConnector = c.req.valid("form")
  const apiKey = form.apiKey
  const url = form.url
  const app = form.name
  let status = ConnectorStatus.NotConnected
  try {
    // Insert the connection within the transaction
    const connector = await insertConnector(
      db,
      user.workspaceId,
      user.id,
      user.workspaceExternalId,
      app,
      ConnectorType.MCP,
      AuthType.ApiKey,
      Apps.MCP,
      { url: url, version: "0.1.0" },
      null,
      null,
      null,
      apiKey,
    )
    try {
      const client = new Client({
        name: `connector-${connector.externalId}`,
        version: "0.1.0",
      })
      loggerWithChild({ email: sub }).info(
        `invoking client initialize for url: ${new URL(url)}`,
      )
      await client.connect(new SSEClientTransport(new URL(url)))
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
  const payload = c.req.valid("json") as { connectorId: string }

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

    const connector = await getConnector(db, parseInt(payload.connectorId))
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

export const IngestMoreChannelApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  // @ts-ignore
  const payload = c.req.valid("json") as {
    connectorId: string
    channelsToIngest: string[]
    startDate: string
    endDate: string
  }

  try {
    const email = sub
    const resp = await handleSlackChannelIngestion(
      parseInt(payload.connectorId),
      payload.channelsToIngest,
      payload.startDate,
      payload.endDate,
      email,
    )
    return c.json({
      success: true,
      message: "Successfully ingested the channels",
    })
  } catch (error) {
    loggerWithChild({ email: sub }).error(
      error,
      "Failed to ingest Slack channels",
    )
    return c.json({
      success: false,
      message: getErrorMessage(error),
    })
  }
}

// Admin Dashboard API Functions

export const GetAdminChats = async (c: Context) => {
  try {
    // Get validated query parameters
    // @ts-ignore
    const { from, to, userId } = c.req.valid("query")

    // Build the conditions array
    const conditions = []
    if (from) {
      conditions.push(gte(chats.createdAt, from))
    }
    if (to) {
      conditions.push(lte(chats.createdAt, to))
    }
    if (userId) {
      conditions.push(eq(chats.userId, userId))
    }

    // Build the query with feedback aggregation
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
        messageCount: sql<number>`COUNT(${messages.id})::int`,
        likes: sql<number>`COUNT(CASE WHEN ${messages.feedback}->>'type' = 'like' THEN 1 END)::int`,
        dislikes: sql<number>`COUNT(CASE WHEN ${messages.feedback}->>'type' = 'dislike' THEN 1 END)::int`,
      })
      .from(chats)
      .leftJoin(users, eq(chats.userId, users.id))
      .leftJoin(messages, eq(chats.id, messages.chatId))

    const result =
      conditions.length > 0
        ? await baseQuery
            .where(and(...conditions))
            .groupBy(chats.id, users.email, users.name, users.role)
        : await baseQuery.groupBy(chats.id, users.email, users.name, users.role)

    return c.json(result)
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

    return c.json(result)
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
