import config from "@/config";
import { db } from "@/db/client";
import { getConnector, updateConnector } from "@/db/connector";
import { getOAuthProvider } from "@/db/oauthProvider";
import type { SelectConnector } from "@/db/schema";
import { ServerLogger } from "@/logger";
import { boss, SaaSQueue } from "@/queue";
import { Apps, type AuthType } from "@/shared/types";
import { LOGGERTYPES, type SaaSOAuthJob } from "@/types";
import { Google, type GoogleTokens } from "arctic";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
const { JwtPayloadKey } = config

const Logger = new ServerLogger(LOGGERTYPES.api)

interface OAuthCallbackQuery {
    state: string,
    code: string,
}
export const OAuthCallback = async (c: Context) => {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub
    const { state, code }: OAuthCallbackQuery = c.req.query()
    if (!state) {
        throw new HTTPException(500)
    }
    const { app, random } = JSON.parse(state)
    if (!app) {
        throw new HTTPException(500)
    }
    const stateInCookie = getCookie(c, `${app}-state`)
    if (random !== stateInCookie) {
        throw new HTTPException(500, { message: "Invalid state, potential CSRF attack." });
    }

    const codeVerifier = getCookie(c, `${app}-code-verifier`)
    if (!codeVerifier && app === Apps.GoogleDrive) {
        throw new HTTPException(500, { message: "Could not verify the code" });
    }

    const provider = await getOAuthProvider(db, app)
    const { clientId, clientSecret } = provider
    const google = new Google(clientId as string, clientSecret, `${config.host}/oauth/callback`);
    const tokens: GoogleTokens = await google.validateAuthorizationCode(code, codeVerifier as string);
    const connectorId = provider.connectorId
    const connectors: SelectConnector[] =
        await updateConnector(connectorId, {
            subject: email,
            oauthCredentials: JSON.stringify(tokens)
        })
    if (!connectors || !connectors.length) {
        throw new HTTPException(500)
    }
    const [connector] = connectors
    const SaasJobPayload: SaaSOAuthJob = {
        connectorId: connector.id,
        app,
        externalId: connector.externalId,
        authType: connector.authType as AuthType,
        email: sub
    }
    // Enqueue the background job within the same transaction
    const jobId = await boss.send(SaaSQueue, SaasJobPayload)

    Logger.info(`Job ${jobId} enqueued for connection ${connector.id}`)

    // Commit the transaction if everything is successful
    return c.redirect(`${config.host}/oauth/success`)
}