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
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub
    const { state, code } = c.req.query()
    if (!state) {
      throw new HTTPException(500)
    }
    const { app, random } = JSON.parse(state)
    if (!app) {
      throw new HTTPException(500)
    }
    const stateInCookie = getCookie(c, `${app}-state`)
    if (random !== stateInCookie) {
      throw new HTTPException(500, {
        message: "Invalid state, potential CSRF attack.",
      })
    }

    const codeVerifier = getCookie(c, `${app}-code-verifier`)
    if (!codeVerifier && app === Apps.GoogleDrive) {
      throw new HTTPException(500, { message: "Could not verify the code" })
    }
    let tokens: SlackOAuthResp | OAuthCredentials

    const userRes = await getUserByEmail(db, sub)
    if (!userRes || !userRes.length) {
      Logger.error("Could not find user in OAuth Callback")
      throw new NoUserFound({})
    }
    const provider = await getOAuthProvider(db, userRes[0].id, app)
    const { clientId, clientSecret } = provider
    console.log("provider", provider)
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
    }

    if (IsGoogleApp(app)) {
      handleGoogleOAuthIngestion(SaasJobPayload)
    } else if (app === Apps.Slack) {
      const abortController = new AbortController();
      globalAbortControllers.set(`${connector.id}`, abortController);
      handleSlackIngestion({
        connectorId: connector.id,
        app,
        externalId: connector.externalId,
        authType: connector.authType as AuthType,
        email: sub,
      })
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
      Logger.info(`Job ${jobId} enqueued for connection ${connector.id}`)
    }

    // Commit the transaction if everything is successful
    if (app === Apps.Slack) {
      return c.redirect(`${slackHost}/oauth/success`)
    }
    return c.redirect(`${config.host}/oauth/success`)
  } catch (error) {
    Logger.error(
      error,
      `${new OAuthCallbackError({ cause: error as Error })} \n ${(error as Error).stack}`,
    )
    throw new HTTPException(500, { message: "Error in OAuthCallback" })
  }
}
