import config from "@/config"
import { db } from "@/db/client"
import {
  getConnector,
  updateConnector,
  insertConnector,
  getConnectorByAppAndEmailId,
} from "@/db/connector"
import { getOAuthProvider } from "@/db/oauthProvider"
import type { SelectConnector } from "@/db/schema"
import { NoUserFound, OAuthCallbackError } from "@/errors"
import { boss, SaaSQueue } from "@/queue"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Apps, ConnectorStatus, ConnectorType, AuthType } from "@/shared/types"
import { type OAuthCredentials, type ZohoOAuthCredentials, type SaaSOAuthJob, Subsystem } from "@/types"
import { Google, MicrosoftEntraId } from "arctic"
import type { Context } from "hono"
import { getCookie } from "hono/cookie"
import { HTTPException } from "hono/http-exception"
import { handleGoogleOAuthIngestion } from "@/integrations/google"
import { handleMicrosoftOAuthIngestion } from "@/integrations/microsoft"
import { ZohoDeskClient } from "@/integrations/zoho/client"
import querystring from "querystring"

const {
  JwtPayloadKey,
  JobExpiryHours,
  slackHost,
  ZohoClientId,
  ZohoClientSecret,
  ZohoOrgId,
} = config
import { IsGoogleApp, IsMicrosoftApp } from "@/utils"
import { getUserByEmail } from "@/db/user"
import { globalAbortControllers } from "@/integrations/abortManager"
import { getErrorMessage } from "@/utils"

const Logger = getLogger(Subsystem.Api).child({ module: "oauth" })
const loggerWithChild = getLoggerWithChild(Subsystem.Api, { module: "oauth" })

interface OAuthCallbackQuery {
  state: string
  code: string
}
interface SlackOAuthResp {
  appId: string
  userId: string
  scope: string
  accessToken: string
  tokenType: string
  teamName: string
  teamId: string
}

interface ZohoDeskProvider {
  type: "zoho"
  connectorId: number | null
  clientId: string
  clientSecret: string
}

interface DatabaseProvider {
  type: "database"
  connectorId: number
  clientId: string
  clientSecret: string
}

type OAuthProvider = ZohoDeskProvider | DatabaseProvider

export const OAuthCallback = async (c: Context) => {
  let email = ""
  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    email = sub
    const { state, code } = c.req.query()
    if (!state) {
      throw new HTTPException(400, { message: "Missing 'state' parameter." })
    }
    const { app, random } = JSON.parse(state)
    if (!app) {
      throw new HTTPException(400, {
        message: "Invalid 'state': missing 'app'.",
      })
    }
    const stateInCookie = getCookie(c, `${app}-state`)
    if (random !== stateInCookie) {
      throw new HTTPException(500, {
        message: "Invalid state, potential CSRF attack.",
      })
    }

    const codeVerifier = getCookie(c, `${app}-code-verifier`)
    if (!codeVerifier && (IsGoogleApp(app) || IsMicrosoftApp(app))) {
      throw new HTTPException(500, { message: "Could not verify the code" })
    }
    let tokens: SlackOAuthResp | OAuthCredentials | ZohoOAuthCredentials

    const userRes = await getUserByEmail(db, sub)
    if (!userRes || !userRes.length) {
      loggerWithChild({ email: email }).error(
        "Could not find user in OAuth Callback",
      )
      throw new NoUserFound({})
    }

    // For Zoho Desk, use global config; for others, get provider from database
    let provider: OAuthProvider

    if (app === Apps.ZohoDesk) {
      // Check if connector already exists for this user
      let existingConnectorId: number | null = null
      try {
        const existingConnector = await getConnectorByAppAndEmailId(
          db,
          Apps.ZohoDesk,
          AuthType.OAuth,
          sub,
        )
        existingConnectorId = existingConnector.id
        Logger.info("✅ ZOHO CALLBACK: Found existing connector, will update", {
          email,
          connectorId: existingConnectorId,
        })
      } catch (error) {
        // No existing connector found, will create new one
        Logger.info("✅ ZOHO CALLBACK: No existing connector, will create new", {
          email,
        })
      }

      provider = {
        type: "zoho",
        connectorId: existingConnectorId, // null if no existing connector, number if updating
        clientId: ZohoClientId,
        clientSecret: ZohoClientSecret,
      }
    } else {
      const dbProvider = await getOAuthProvider(db, userRes[0].id, app)
      provider = {
        type: "database",
        connectorId: dbProvider.connectorId,
        clientId: dbProvider.clientId!,
        clientSecret: dbProvider.clientSecret as string,
      }
    }

    const { clientId, clientSecret } = provider
    if (app === Apps.Slack) {
      const response = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId!,
          client_secret: clientSecret as string,
          code, // Use the code from the callback
          redirect_uri: `${slackHost}/oauth/callback`,
        }).toString(),
      })

      const tokenData = (await response.json()) as any
      if (!tokenData.ok) {
        throw new HTTPException(400, {
          message: `Could not get Slack token`,
        })
      }

      tokens = {
        appId: tokenData.app_id,
        userId: tokenData.authed_user.id,
        accessToken: tokenData.authed_user.access_token,
        tokenType: tokenData.authed_user.token_type,
        teamName: tokenData.team.name,
        teamId: tokenData.team.id,
        scope: tokenData.authed_user.scope,
      }
    } else if (IsGoogleApp(app)) {
      const google = new Google(
        clientId as string,
        clientSecret as string,
        `${config.host}/oauth/callback`,
      )
      const oauthTokens = await google.validateAuthorizationCode(
        code,
        codeVerifier as string,
      )
      tokens = oauthTokens as OAuthCredentials
      tokens.data.accessTokenExpiresAt = oauthTokens.accessTokenExpiresAt()
    } else if (IsMicrosoftApp(app)) {
      const microsoft = new MicrosoftEntraId(
        "common",
        clientId as string,
        clientSecret as string,
        `${config.host}/oauth/callback`,
      )
      const oauthTokens = await microsoft.validateAuthorizationCode(
        code,
        codeVerifier as string,
      )
      tokens = oauthTokens as OAuthCredentials
      tokens.data.accessTokenExpiresAt = oauthTokens.accessTokenExpiresAt()
    } else if (app === Apps.ZohoDesk) {

      const response = await fetch("https://accounts.zoho.com/oauth/v2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId!,
          client_secret: clientSecret as string,
          code,
          redirect_uri: `${config.host}/callback`,
        }).toString(),
      })

      const tokenData = (await response.json()) as any

      if (!response.ok || tokenData.error) {
        Logger.error("❌ ZOHO CALLBACK: Token exchange failed", {
          email,
          error: tokenData.error,
          status: response.status,
        })
        throw new HTTPException(400, {
          message: `Could not get Zoho token: ${tokenData.error || "Unknown error"}`,
        })
      }

      // Fetch user information including department
      const client = ZohoDeskClient.fromAccessToken(
        tokenData.access_token,
        ZohoOrgId,
      )
      const userInfo = await client.fetchUserInfo()

      // Store tokens with user department info
      tokens = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        tokenType: "Bearer",
        expiresIn: tokenData.expires_in,
        scope: tokenData.scope || "",
        // Store department IDs for permissions
        departmentIds: userInfo.associatedDepartmentIds,
        departments: userInfo.associatedDepartments,
      } as ZohoOAuthCredentials

      Logger.info("✅ ZOHO CALLBACK: Tokens prepared for storage", { email })
    } else {
      throw new HTTPException(400, { message: "Unsupported OAuth app" })
    }

    let connector: SelectConnector

    // For Zoho Desk user OAuth, create a new connector if none exists; otherwise update existing
    if (app === Apps.ZohoDesk) {
      if (provider.connectorId === null) {
        // Create new connector for Zoho Desk user
        Logger.info("✅ ZOHO CALLBACK: Creating new connector for user", {
          email,
        })

        const departmentIds = (tokens as ZohoOAuthCredentials).departmentIds || []
        const departmentId = departmentIds.length > 0 ? departmentIds[0] : null

        Logger.info("✅ ZOHO CALLBACK: Department assignment", {
          email,
        })

        const newConnector = await insertConnector(
          db,
          userRes[0].workspaceId,
          userRes[0].id,
          userRes[0].workspaceExternalId,
          `${Apps.ZohoDesk}-${ConnectorType.SaaS}-${AuthType.OAuth}`,
          ConnectorType.SaaS,
          AuthType.OAuth,
          Apps.ZohoDesk,
          {}, // initial state
          null, // no credentials needed for OAuth
          email, // subject
          JSON.stringify(tokens), // OAuth credentials (includes departmentIds)
          null, // apiKey
          ConnectorStatus.Connected,
        )

        // Cast to SelectConnector with correct app type
        connector = { ...newConnector, app: Apps.ZohoDesk } as SelectConnector

        Logger.info("✅ ZOHO CALLBACK: Connector created successfully", {
          email,
        })
      } else {
        // Update existing ZohoDesk connector
        Logger.info("✅ ZOHO CALLBACK: Updating existing connector", {
          email,
          connectorId: provider.connectorId,
        })

        const updateData: any = {
          subject: email,
          oauthCredentials: JSON.stringify(tokens), // departmentIds will be stored in oauthCredentials
          status: ConnectorStatus.Authenticated,
        }

        connector = await updateConnector(db, provider.connectorId, updateData)

        Logger.info("✅ ZOHO CALLBACK: Connector updated successfully", {
          email,
          connectorId: connector.id,
        })
      }
    } else {
      // Update existing connector for other apps
      if (provider.connectorId === null) {
        throw new HTTPException(500, {
          message: "Invalid state: database provider must have connectorId",
        })
      }

      const updateData: any = {
        subject: email,
        oauthCredentials: JSON.stringify(tokens), // departmentIds will be stored in oauthCredentials
        status: ConnectorStatus.Authenticated,
      }

      connector = await updateConnector(db, provider.connectorId, updateData)
    }
    const SaasJobPayload: SaaSOAuthJob = {
      connectorId: connector.id,
      app,
      externalId: connector.externalId,
      authType: connector.authType as AuthType,
      email: sub,
    }

    if (IsGoogleApp(app)) {
      // moved the ingestion logic to sync-server , once the user will click on start ingestion
      // ingestion will start on sync-server
    } else if (IsMicrosoftApp(app)) {
      handleMicrosoftOAuthIngestion(SaasJobPayload).catch((error) => {
        loggerWithChild({ email: email }).error(
          error,
          `Background Microsoft OAuth ingestion failed for connector ${connector.id}: ${getErrorMessage(error)}`,
        )
      })
    } else if (app === Apps.Slack) {
      const abortController = new AbortController()
      globalAbortControllers.set(`${connector.id}`, abortController)
      // we are avoiding this , we will stop the flow here
      // either we will provide the button to start it
      // else we will merge it with the channelthing
      // handleSlackIngestion({
      //   connectorId: connector.id,
      //   app,
      //   externalId: connector.externalId,
      //   authType: connector.authType as AuthType,
      //   email: sub,
      // })
    } else {
      const SaasJobPayload: SaaSOAuthJob = {
        connectorId: connector.id,
        app,
        externalId: connector.externalId,
        authType: connector.authType as AuthType,
        email: sub,
      }
      // Enqueue the background job within the same transaction
      const jobId = await boss.send(SaaSQueue, SaasJobPayload, {
        expireInHours: JobExpiryHours,
      })
      loggerWithChild({ email: email }).info(
        `Job ${jobId} enqueued for connection ${connector.id}`,
      )
    }

    // Commit the transaction if everything is successful
    if (app === Apps.Slack) {
      return c.redirect(`${slackHost}/oauth/success`)
    }
    return c.redirect(`${config.host}/oauth/success`)
  } catch (error) {
    loggerWithChild({ email: email }).error(
      error,
      `${new OAuthCallbackError({ cause: error as Error })} \n ${(error as Error).stack}`,
    )
    throw new HTTPException(500, { message: "Error in OAuthCallback" })
  }
}
