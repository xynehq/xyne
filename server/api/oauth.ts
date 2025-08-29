import config from "@/config"
import { db } from "@/db/client"
import { getConnector, updateConnector } from "@/db/connector"
import { getOAuthProvider } from "@/db/oauthProvider"
import type { SelectConnector } from "@/db/schema"
import { NoUserFound, OAuthCallbackError } from "@/errors"
import { boss, SaaSQueue } from "@/queue"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Apps, ConnectorStatus, type AuthType } from "@/shared/types"
import { type OAuthCredentials, type SaaSOAuthJob, Subsystem } from "@/types"
import { Google, Slack } from "arctic"
import type { Context } from "hono"
import { getCookie } from "hono/cookie"
import { HTTPException } from "hono/http-exception"
import { handleGoogleOAuthIngestion } from "@/integrations/google"
import { handleMicrosoftOAuthIngestion } from "@/integrations/microsoft"

const { JwtPayloadKey, JobExpiryHours, slackHost } = config
import { IsGoogleApp, IsMicrosoftApp } from "@/utils"
import { getUserByEmail } from "@/db/user"
import { handleSlackIngestion } from "@/integrations/slack"
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

export const OAuthCallback = async (c: Context) => {
  let email = ""
  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    email = sub
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
      loggerWithChild({ email: email }).error(
        "Could not find user in OAuth Callback",
      )
      throw new NoUserFound({})
    }
    const provider = await getOAuthProvider(db, userRes[0].id, app)
    const { clientId, clientSecret } = provider
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
    } else if (IsMicrosoftApp(app)) {
      // Microsoft OAuth token exchange
      const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId!,
          client_secret: clientSecret,
          code,
          redirect_uri: `${config.host}/oauth/callback`,
          grant_type: "authorization_code",
          code_verifier: codeVerifier as string,
        }).toString(),
      })

      const tokenData = await response.json()
      if (!response.ok) {
        loggerWithChild({ email: email }).error(
          `Microsoft OAuth token exchange failed: ${JSON.stringify(tokenData)}`,
        )
        throw new Error(`Could not get Microsoft token: ${tokenData.error_description || tokenData.error}`)
      }

      tokens = {
        data: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          accessTokenExpiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
        }
      } as OAuthCredentials
      
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
      // Start ingestion in the background, but catch any errors it might throw later
      handleGoogleOAuthIngestion(SaasJobPayload).catch((error) => {
        loggerWithChild({ email: email }).error(
          error,
          `Background Google OAuth ingestion failed for connector ${connector.id}: ${getErrorMessage(error)}`,
        )
      })
    } else if (IsMicrosoftApp(app)) {
      // Start Microsoft ingestion in the background, but catch any errors it might throw later
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
