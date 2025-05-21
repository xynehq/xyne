import config from "@/config"
import { db } from "@/db/client"
import { getConnector, updateConnector } from "@/db/connector"
import { getOAuthProvider } from "@/db/oauthProvider"
import type { SelectConnector } from "@/db/schema"
import { NoUserFound, OAuthCallbackError } from "@/errors"
import { boss, SaaSQueue } from "@/queue"
import { getLogger } from "@/logger"
import { Apps, ConnectorStatus, type AuthType } from "@/shared/types"
import { type OAuthCredentials, type SaaSOAuthJob, Subsystem } from "@/types"
import { Google, Slack } from "arctic"
import type { Context } from "hono"
import { getCookie } from "hono/cookie"
import { HTTPException } from "hono/http-exception"
import { handleGoogleOAuthIngestion } from "@/integrations/google"

const { JwtPayloadKey, JobExpiryHours, slackHost } = config
import { IsGoogleApp } from "@/utils"
import { getUserByEmail } from "@/db/user"
import { handleSlackIngestion } from "@/integrations/slack"
import { globalAbortControllers } from "@/integrations/abortManager"
import { getErrorMessage } from "@/utils"

const Logger = getLogger(Subsystem.Api).child({ module: "oauth" })

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

export const OAuthCallback = async (c: Context) => {
  try {
    const { state, code } = c.req.query() as { state: string; code: string }
    if (!state) {
      throw new HTTPException(400, { message: "No state parameter" })
    }

    // Parse the state parameter to get app and date parameters
    let stateData: { 
      app: Apps; 
      random: string; 
      startDate?: string; 
      endDate?: string;
      insertDrive?: boolean;
      insertGmail?: boolean;
      insertCalendar?: boolean;
      insertContacts?: boolean;
    }
    try {
      const parsedState = JSON.parse(state)
      console.log("[OAuthCallback] Parsed state data:", parsedState)
      stateData = {
        app: parsedState.app as Apps,
        random: parsedState.random,
        startDate: parsedState.startDate,
        endDate: parsedState.endDate,
        insertDrive: parsedState.insertDrive,
        insertGmail: parsedState.insertGmail,
        insertCalendar: parsedState.insertCalendar,
        insertContacts: parsedState.insertContacts,
      }
    } catch (error) {
      throw new HTTPException(400, { message: "Invalid state parameter" })
    }

    const { app, random } = stateData
    if (!app) {
      throw new HTTPException(400, { message: "No app in state parameter" })
    }

    const stateInCookie = getCookie(c, `${app}-state`)
    if (random !== stateInCookie) {
      throw new HTTPException(400, {
        message: "Invalid state, potential CSRF attack.",
      })
    }

    const codeVerifier = getCookie(c, `${app}-code-verifier`)
    if (!codeVerifier && app === Apps.GoogleDrive) {
      throw new HTTPException(400, { message: "Could not verify the code" })
    }

    const { sub } = c.get(JwtPayloadKey)
    const email = sub
    const userRes = await getUserByEmail(db, email)
    if (!userRes || !userRes.length) {
      throw new NoUserFound({})
    }
    const [user] = userRes

    const provider = await getOAuthProvider(db, user.workspaceId, app)
    if (!provider) {
      throw new HTTPException(500, { message: "No OAuth provider found" })
    }

    const { clientId, clientSecret } = provider
    let tokens: OAuthCredentials | SlackOAuthResp

    if (app === Apps.Slack) {
      const response = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId!,
          client_secret: clientSecret,
          code, // Use the code from the callback
          redirect_uri: `${slackHost}/oauth/callback`,
        }).toString(),
      })

      const tokenData = (await response.json()) as any
      if (!tokenData.ok) {
        throw new Error("Could not get Slack token")
      }

      tokens = {
        data: {
          access_token: tokenData.authed_user.access_token,
          refresh_token: tokenData.authed_user.refresh_token,
          accessTokenExpiresAt: new Date(Date.now() + 3600000),
        },
      }
    } else if (IsGoogleApp(app)) {
      const google = new Google(
        clientId as string,
        clientSecret,
        `${config.host}/oauth/callback`,
      )
      const oauthTokens = await google.validateAuthorizationCode(
        code,
        codeVerifier as string,
      )
      tokens = oauthTokens as OAuthCredentials
      tokens.data.accessTokenExpiresAt = oauthTokens.accessTokenExpiresAt()
    } else {
      throw new HTTPException(500, { message: "Invalid App" })
    }
    const connectorId = provider.connectorId
    const connector: SelectConnector = await updateConnector(db, connectorId, {
      subject: email,
      oauthCredentials: JSON.stringify(tokens),
      status: ConnectorStatus.Connecting,
    })
    const SaasJobPayload: SaaSOAuthJob = {
      connectorId: connector.id,
      app,
      externalId: connector.externalId,
      authType: connector.authType as AuthType,
      email: sub,
      // Add date range if provided in the state
      ...(stateData.startDate && { startDate: stateData.startDate }),
      ...(stateData.endDate && { endDate: stateData.endDate }),
    }

    console.log("[OAuthCallback] Creating SaaS job with payload:", SaasJobPayload)

    if (IsGoogleApp(app)) {
      // Start ingestion in the background, but catch any errors it might throw later
      handleGoogleOAuthIngestion(
        SaasJobPayload,
        SaasJobPayload.startDate ? new Date(SaasJobPayload.startDate) : undefined,
        SaasJobPayload.endDate ? new Date(SaasJobPayload.endDate) : undefined,
        stateData.insertDrive,
        stateData.insertGmail,
        stateData.insertCalendar,
        stateData.insertContacts
      ).catch((error) => {
        Logger.error(
          error,
          `Background Google OAuth ingestion failed for connector ${connector.id}: ${getErrorMessage(error)}`,
        )
      })
    } else if (app === Apps.Slack) {
      const abortController = new AbortController()
      globalAbortControllers.set(`${connector.id}`, abortController)
      handleSlackIngestion({
        connectorId: connector.id,
        app,
        externalId: connector.externalId,
        authType: connector.authType as AuthType,
        email: sub,
      })
    } else {
      // Enqueue the background job
      const jobId = await boss.send(SaaSQueue, SaasJobPayload, {
        singletonKey: connector.externalId,
        priority: 1,
        retryLimit: 0,
      })

      console.log(`[OAuthCallback] Job ${jobId} enqueued for connector ${connector.id}`)
    }

    return c.redirect("/oauth/success")
  } catch (error) {
    console.error("[OAuthCallback] Error:", error)
    throw error
  }
}
