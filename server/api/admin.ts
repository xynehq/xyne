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
import { eq, and, inArray, sql } from "drizzle-orm"
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
import { createOAuthProvider, getOAuthProvider } from "@/db/oauthProvider"
const { JwtPayloadKey, slackHost } = config
import { generateCodeVerifier, generateState, Google, Slack } from "arctic"
import type { SelectOAuthProvider, SelectUser } from "@/db/schema"
import { getErrorMessage, IsGoogleApp, setCookieByEnv } from "@/utils"
import { getLogger } from "@/logger"
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

const Logger = getLogger(Subsystem.Api).child({ module: "admin" })

export const GetConnectors = async (c: Context) => {
  const { workspaceId, sub } = c.get(JwtPayloadKey)
  const users: SelectUser[] = await getUserByEmail(db, sub)
  if (users.length === 0) {
    Logger.error({ sub }, "No user found for sub in GetConnectors")
    throw new NoUserFound({})
  }
  const user = users[0]
  const connectors = await getConnectors(workspaceId, user.id)
  return c.json(connectors)
}

export const GetConnectorTools = async (c: Context) => {
  const { workspaceId, sub } = c.get(JwtPayloadKey)
  const connectorExternalId = c.req.param("connectorId")

  if (!connectorExternalId) {
    throw new HTTPException(400, { message: "Connector ID is required" })
  }

  const users: SelectUser[] = await getUserByEmail(db, sub)
  if (users.length === 0) {
    Logger.error({ sub }, "No user found for sub in GetConnectorTools")
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
    Logger.info(`code verifier  ${codeVerifier}`)

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
  Logger.info(
    {
      reqiestId: c.var.requestId,
      method: c.req.method,
      path,
    },
    "Started Oauth",
  )
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  // @ts-ignore
  const { app }: OAuthStartQuery = c.req.valid("query")
  Logger.info(`${sub} started ${app} OAuth`)
  const userRes = await getUserByEmail(db, sub)
  if (!userRes || !userRes.length) {
    Logger.error("Could not find user by email when starting OAuth")
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
  const clientId = form.clientId
  const clientSecret = form.clientSecret
  const scopes = form.scopes
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
  Logger.info("AddServiceConnection")
  const { sub, workspaceId } = c.get(JwtPayloadKey)
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
          Logger.error(
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
    Logger.error(
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
  Logger.info("ApiKeyConnector")
  const { sub, workspaceId } = c.get(JwtPayloadKey)
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

      Logger.info(`Job ${jobId} enqueued for connection ${connector.id}`)

      return c.json({
        success: true,
        message: "Connection created, job enqueued",
        id: connector.externalId,
      })
    } catch (error) {
      const errMessage = getErrorMessage(error)
      Logger.error(
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
    Logger.warn(
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
      console.log(`Deleted MCP tools for connector ${connectorId}`)
    } catch (error) {
      console.error(`Error deleting MCP tools: ${getErrorMessage(error)}`)
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
  const { connectorId: connectorExternalId }: { connectorId: string } =
    // @ts-ignore Ignore Hono validation type issue
    c.req.valid("form")

  if (!connectorExternalId) {
    Logger.error(
      "connectorId (external) not provided in request for DeleteOauthConnector",
    )
    throw new HTTPException(400, { message: "Missing connectorId" })
  }

  const { sub } = c.get(JwtPayloadKey)
  const userRes = await getUserByEmail(db, sub)
  if (!userRes || !userRes.length) {
    Logger.error({ sub }, "No user found for sub in DeleteOauthConnector")
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
      Logger.warn(
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
    Logger.error(
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
    Logger.error(
      { email },
      "User not found for service account ingest more users.",
    )
    throw new NoUserFound({ message: `User with email ${email} not found.` })
  }
  const [userInstance] = userRes
  const userId = userInstance.id

  Logger.info(
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
    Logger.error(
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
  Logger.info("ApiKeyMCPConnector")
  const { sub, workspaceId } = c.get(JwtPayloadKey)
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
      Logger.info(`invoking client initialize for url: ${new URL(url)}`)
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
      Logger.error(`error occurred while connecting to connector ${error}`)
    }
    await updateConnector(db, connector.id, { status: status })
    return c.json({
      success: true,
      message: "Connector added",
      id: connector.externalId,
    })
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(
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
    Logger.error(
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

  Logger.info(
    { adminEmail: sub, targetEmail: emailToClear, options },
    "Admin initiated user data deletion.",
  )

  try {
    const deletionResults = await clearUserDataInVespa(emailToClear, options)
    Logger.info(
      { adminEmail: sub, targetEmail: emailToClear, results: deletionResults },
      "User data deletion process completed.",
    )
    return c.json({
      success: true,
      message: `Data deletion process initiated for user ${emailToClear}. Check server logs for details.`,
      results: deletionResults,
    })
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    Logger.error(
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
    Logger.error({ sub }, "No user found for sub in UpdateToolsStatusApi")
    throw new NoUserFound({})
  }
  const user = users[0]

  const retrievedWorkspace = await getWorkspaceByExternalId(
    db,
    workspaceExternalId,
  )
  if (!retrievedWorkspace) {
    Logger.error(
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
        Logger.warn(
          `Tool with id ${toolUpdate.toolId} not found in workspace ${internalWorkspaceId} (external: ${workspaceExternalId}) or no change needed.`,
        )
        // Optionally, you could collect these and report them back
      }
      // Ensure success is true only if result.length > 0
      return { toolId: toolUpdate.toolId, success: result.length > 0 }
    } catch (error) {
      Logger.error(
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
    Logger.error({ failedUpdates }, "Some tools failed to update.")
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
  Logger.info("StdioMCPConnector")
  const { sub, workspaceId } = c.get(JwtPayloadKey)
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
  Logger.info(`called with req body ${form} ${form.appType}`)
  switch (form.appType) {
    case "github":
      app = Apps.GITHUB_MCP
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
      Logger.info(
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
      Logger.error(`error occurred while connecting to connector ${error}`)
    }
    await updateConnector(db, connector.id, { status: status })
    return c.json({
      success: true,
      message: "Connector added",
      id: connector.externalId,
    })
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(
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
      Logger.error({ sub }, "No user found for sub in StartSlackIngestionApi")
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
      Logger.error(
        error,
        `Background Slack ingestion failed for connector ${connector.id}: ${getErrorMessage(error)}`,
      )
    })

    return c.json({
      success: true,
      message: "Regular Slack ingestion started.",
    })
  } catch (error: any) {
    Logger.error(
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
    Logger.error(error, "Failed to ingest Slack channels")
    return c.json({
      success: false,
      message: getErrorMessage(error),
    })
  }
}
