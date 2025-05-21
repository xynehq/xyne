import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { db } from "@/db/client"
import { getUserByEmail } from "@/db/user"
import {
  deleteConnector,
  getConnectorByExternalId,
  getConnectors,
  insertConnector,
  updateConnector,
  deleteOauthConnector,
} from "@/db/connector"
import {
  ConnectorType,
  type OAuthProvider,
  type OAuthStartQuery,
  type SaaSJob,
  type ServiceAccountConnection,
  Subsystem,
} from "@/types"
import { boss, SaaSQueue } from "@/queue"
import config from "@/config"
import { Apps, AuthType, ConnectorStatus } from "@/shared/types"
import { createOAuthProvider, getOAuthProvider, getGlobalOAuthProvider } from "@/db/oauthProvider"
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

const getAuthorizationUrl = async (
  c: Context,
  app: Apps,
  provider: SelectOAuthProvider,
): Promise<URL> => {
  const { clientId, clientSecret, oauthScopes } = provider
  let url: URL
  const state = generateState()
  const codeVerifier = generateCodeVerifier()

  // Get date parameters from query
  const startDate = c.req.query('startDate')
  const endDate = c.req.query('endDate')
  const insertDrive = c.req.query('insertDrive')
  const insertGmail = c.req.query('insertGmail')
  const insertCalendar = c.req.query('insertCalendar')
  const insertContacts = c.req.query('insertContacts')
  
  console.log("[getAuthorizationUrl] Received parameters:", {
    startDate,
    endDate,
    insertDrive,
    insertGmail,
    insertCalendar,
    insertContacts,
    query: c.req.query()
  })

  // for google refresh token
  if (IsGoogleApp(app)) {
    const google = new Google(
      clientId as string,
      clientSecret,
      `${config.host}/oauth/callback`,
    )
    Logger.info(`code verifier  ${codeVerifier}`)

    // adding some data to state
    const newState = JSON.stringify({ 
      app, 
      random: state,
      startDate,
      endDate,
      insertDrive: insertDrive === "true",
      insertGmail: insertGmail === "true",
      insertCalendar: insertCalendar === "true",
      insertContacts: insertContacts === "true",
    })
    console.log("[getAuthorizationUrl] State object:", newState)
    url = google.createAuthorizationURL(newState, codeVerifier, oauthScopes)
    url.searchParams.set("access_type", "offline")
    url.searchParams.set("prompt", "consent")
  } else if (app === Apps.Slack) {
    // we are not using arctic as it would only go to oidc urls
    const newState = JSON.stringify({ 
      app, 
      random: state,
      startDate,
      endDate,
    })
    console.log("[getAuthorizationUrl] State object for Slack:", newState)
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
  console.log("form", form.isForm2)
  const clientId = form.clientId
  const clientSecret = form.clientSecret
  const scopes = form.scopes
  const app = form.app
  const isForm2 = form.isForm2
  console.log(form.startDate, form.endDate)
  let globalProvider=null
  // For form2 with Slack, check if global provider exists before creating connector
  if (isForm2 && app === Apps.Slack) {
    // First check if global provider exists
    globalProvider = await getGlobalOAuthProvider(db, Apps.Slack)
    if (!globalProvider) {
      Logger.info("No global OAuth provider found for app", { app })
      return c.json({ 
        success: false,
        error: "No global OAuth provider found for Slack. Please configure global credentials first." 
      }, 404)
    }
  }
  
  return await db.transaction(async (trx) => {
    const connector = await insertConnector(
      trx,
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

    // For form2 with Slack, use global provider credentials
    if (isForm2 && app === Apps.Slack) {
      
      const provider = await createOAuthProvider(trx, {
        clientId: globalProvider!.clientId,
        clientSecret: globalProvider!.clientSecret,
        oauthScopes: globalProvider!.oauthScopes,
        workspaceId: user.workspaceId,
        userId: user.id,
        workspaceExternalId: user.workspaceExternalId,
        connectorId: connector.id,
        app,
      })
      return c.json({
        success: true,
        message: "Connection and Provider created using global credentials",
      })
    }

    // Normal flow (form1)
    const provider = await createOAuthProvider(trx, {
      clientId,
      clientSecret,
      oauthScopes: scopes,
      workspaceId: user.workspaceId,
      userId: user.id,
      workspaceExternalId: user.workspaceExternalId,
      connectorId: connector.id,
      app,
      isGlobal: form.isGlobal,
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
      insertDrive: form.insertDrive,
      insertGmail: form.insertGmail,
      insertCalendar: form.insertCalendar,
      insertContacts: form.insertContacts,
      // Conditionally add whiteListedEmails to the payload
      ...(whitelistedEmails &&
        whitelistedEmails.length > 0 && { whitelistedEmails }),
      // Add date range if provided
      ...(form.startDate && { startDate: form.startDate }),
      ...(form.endDate && { endDate: form.endDate }),
    }

    if (IsGoogleApp(app)) {
      // Start ingestion in the background, but catch any errors it might throw later
      handleGoogleServiceAccountIngestion(SaasJobPayload).catch(
        (error: any) => {
          Logger.error(
            error,
            `Background Google Service Account ingestion failed for connector ${connector.id}: ${getErrorMessage(error)}`,
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
      `${new AddServiceConnectionError({ cause: error as Error })} \n : ${errMessage} : ${(error as Error).stack}`,
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
        `${new AddServiceConnectionError({ cause: error as Error })} \n : ${errMessage} : ${(error as Error).stack}`,
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
    status,
    // @ts-ignore
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
      message: `Failed to delete connector ${connectorExternalId}: ${getErrorMessage(error)}`,
      cause: error,
    })
  }
}

export const ServiceAccountIngestMoreUsersApi = async (c: Context) => {
  // @ts-ignore - Assuming payload is validated by zValidator and has the correct shape
  const payload = c.req.valid("json") as {
    connectorId: string
    emailsToIngest: string[]
  }

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
    `Attempting to ingest more users for SA connector: ${payload.connectorId} by user: ${userId}`,
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
      `Failed to ingest more users for service account: ${getErrorMessage(error)}`,
    )
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, {
      message: `Failed to ingest more users: ${getErrorMessage(error)}`,
    })
  }
}
