import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { db } from "@/db/client"
import { getUserByEmail } from "@/db/user"
import {
  getConnectorByExternalId,
  getConnectors,
  insertConnector,
  getConnector,
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
import { createOAuthProvider, getOAuthProvider } from "@/db/oauthProvider"
import { connectors } from "@/db/schema"
import { eq } from "drizzle-orm"
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
import { scopes } from "@/integrations/google/config"

const { JwtPayloadKey, JobExpiryHours, slackHost } = config

const Logger = getLogger(Subsystem.Api).child({ module: "admin" })

export const GetConnectors = async (c: Context) => {
  const { workspaceId, sub } = c.get(JwtPayloadKey)
  const users: SelectUser[] = await getUserByEmail(db, sub)
  if (users.length === 0) {
    Logger.error({sub}, "No user found for sub in GetConnectors");
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
  if(!userRes || !userRes.length) {
    Logger.error('Could not find user by email when starting OAuth')
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
  const data = await form["service-key"].text()
  const subject = form.email
  const app = form.app

  // Start a transaction
  return await db.transaction(async (trx) => {
    try {
      // Insert the connection within the transaction
      const connector = await insertConnector(
        trx, // Pass the transaction object
        user.workspaceId,
        user.id,
        user.workspaceExternalId,
        `${app}-${ConnectorType.SaaS}-${AuthType.ServiceAccount}`,
        ConnectorType.SaaS,
        AuthType.ServiceAccount,
        app,
        {},
        data,
        subject,
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
        expireInHours: JobExpiryHours,
      })

      Logger.info(`Job ${jobId} enqueued for connection ${connector.id}`)

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
  })
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
  // const data = await form["service-key"].text()
  const apiKey = form.apiKey
  const app = form.app

  // Start a transaction
  return await db.transaction(async (trx) => {
    try {
      // Insert the connection within the transaction
      const connector = await insertConnector(
        trx, // Pass the transaction object
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
  })
}

export const CreateWhatsAppConnector = async (c: Context) => {
  Logger.info("Processing WhatsApp Connector request")
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  const email = sub
  const body = await c.req.json()
  const { connectorId, action } = body || {}
  
  Logger.info(`Processing WhatsApp request for user ${email} in workspace ${workspaceId}`)
  
  const userRes = await getUserByEmail(db, email)
  if (!userRes || !userRes.length) {
    throw new NoUserFound({})
  }
  const [user] = userRes

  // If this is an ingestion request for an existing connector
  if (action === "startIngestion" && connectorId) {
    Logger.info(`Starting ingestion for existing WhatsApp connector ${connectorId}`)
    // Ensure connectorId is a number
    const numericConnectorId = parseInt(connectorId, 10)
    if (isNaN(numericConnectorId)) {
      Logger.error(`Invalid connector ID format: ${connectorId}`)
      throw new HTTPException(400, {
        message: "Invalid connector ID format",
      })
    }
    
    Logger.info(`Fetching connector with numeric ID: ${numericConnectorId}`)
    const connector = await getConnector(db, numericConnectorId)
    if (!connector) {
      Logger.error(`WhatsApp connector not found with ID: ${numericConnectorId}`)
      throw new HTTPException(404, {
        message: "WhatsApp connector not found",
      })
    }

    Logger.info(`Found connector: ${JSON.stringify(connector, null, 2)}`)

    // Update connector status to Connecting
    Logger.info("Updating connector status to Connecting")
    await db.update(connectors)
      .set({ status: ConnectorStatus.Connecting })
      .where(eq(connectors.id, numericConnectorId))
    Logger.info("Connector status updated successfully")

    const SaasJobPayload: SaaSJob = {
      connectorId: numericConnectorId,
      workspaceId: user.workspaceId,
      userId: user.id,
      app: Apps.WhatsApp,
      externalId: connector.externalId,
      authType: connector.authType as AuthType,
      email: sub,
    }

    Logger.info(`Enqueueing WhatsApp ingestion job with payload: ${JSON.stringify(SaasJobPayload, null, 2)}`)

    const jobId = await boss.send(SaaSQueue, SaasJobPayload, {
      singletonKey: connector.externalId,
      priority: 1,
      retryLimit: 0,
      expireInHours: JobExpiryHours,
    })

    Logger.info(`WhatsApp ingestion job ${jobId} created for connector ${connector.id}`)

    return c.json({
      success: true,
      message: "WhatsApp ingestion started",
      id: connector.externalId,
    })
  }

  // Start a transaction for creating a new connector
  return await db.transaction(async (trx) => {
    try {
      Logger.info(`Starting transaction to create WhatsApp connector`)
      // Insert the connection within the transaction
      const connector = await insertConnector(
        trx,
        user.workspaceId,
        user.id,
        user.workspaceExternalId,
        `${Apps.WhatsApp}-${ConnectorType.SaaS}-${AuthType.Custom}`,
        ConnectorType.SaaS,
        AuthType.Custom,
        Apps.WhatsApp,
        {},
        null,
        null,
        null,
        null,
        ConnectorStatus.Connecting
      )

      Logger.info(`Created WhatsApp connector with ID: ${connector.id} and externalId: ${connector.externalId}`)

      const SaasJobPayload: SaaSJob = {
        connectorId: connector.id,
        workspaceId: user.workspaceId,
        userId: user.id,
        app: Apps.WhatsApp,
        externalId: connector.externalId,
        authType: connector.authType as AuthType,
        email: sub,
      }

      Logger.info(`Enqueueing WhatsApp job with payload: ${JSON.stringify(SaasJobPayload, null, 2)}`)

      const jobId = await boss.send(SaaSQueue, SaasJobPayload, {
        singletonKey: connector.externalId,
        priority: 1,
        retryLimit: 0,
        expireInHours: JobExpiryHours,
      })

      Logger.info(`WhatsApp ingestion job ${jobId} created for connector ${connector.id}`)

      return c.json({
        success: true,
        message: "WhatsApp connection created, job enqueued",
        id: connector.externalId,
      })
    } catch (error) {
      const errMessage = getErrorMessage(error)
      Logger.error(
        error,
        `Error processing WhatsApp connector request: ${errMessage} : ${(error as Error).stack}`,
      )
      throw new HTTPException(500, {
        message: "Error processing WhatsApp connector request",
      })
    }
  })
}

export const DeleteWhatsAppConnector = async (c: Context) => {
  Logger.info("Processing WhatsApp Connector deletion request")
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  const email = sub
  const body = await c.req.json()
  const { connectorId } = body || {}
  
  Logger.info(`Processing WhatsApp deletion request for user ${email} in workspace ${workspaceId}`)
  
  const userRes = await getUserByEmail(db, email)
  if (!userRes || !userRes.length) {
    throw new NoUserFound({})
  }
  const [user] = userRes

  if (!connectorId) {
    Logger.error("No connector ID provided")
    throw new HTTPException(400, {
      message: "Connector ID is required",
    })
  }

  // Ensure connectorId is a number
  const numericConnectorId = parseInt(connectorId, 10)
  if (isNaN(numericConnectorId)) {
    Logger.error(`Invalid connector ID format: ${connectorId}`)
    throw new HTTPException(400, {
      message: "Invalid connector ID format",
    })
  }

  try {
    // Delete the connector
    await db.delete(connectors)
      .where(eq(connectors.id, numericConnectorId))

    Logger.info(`Successfully deleted WhatsApp connector with ID: ${numericConnectorId}`)

    return c.json({
      success: true,
      message: "WhatsApp connector deleted successfully",
    })
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(
      error,
      `Error deleting WhatsApp connector: ${errMessage} : ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Error deleting WhatsApp connector",
    })
  }
}
