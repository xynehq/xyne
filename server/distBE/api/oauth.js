import config from "../config.js"
import { db } from "../db/client.js"
import { getConnector, updateConnector } from "../db/connector.js"
import { getOAuthProvider } from "../db/oauthProvider.js"
import { NoUserFound, OAuthCallbackError } from "../errors/index.js"
import { boss, SaaSQueue } from "../queue/index.js"
import { getLogger } from "../logger/index.js";
import { Apps, ConnectorStatus } from "../shared/types.js"
import { Subsystem } from "../types.js"
import { Google } from "arctic";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { getUserByEmail } from "../db/user.js"
import { handleGoogleOAuthIngestion } from "../integrations/google/index.js";
import { IsGoogleApp } from "../utils.js"
const { JwtPayloadKey, JobExpiryHours } = config;
const Logger = getLogger(Subsystem.Api).child({ module: "oauth" });
export const OAuthCallback = async (c) => {
    try {
        const { sub, workspaceId } = c.get(JwtPayloadKey);
        const email = sub;
        const { state, code } = c.req.query();
        if (!state) {
            throw new HTTPException(500);
        }
        const { app, random } = JSON.parse(state);
        if (!app) {
            throw new HTTPException(500);
        }
        const stateInCookie = getCookie(c, `${app}-state`);
        if (random !== stateInCookie) {
            throw new HTTPException(500, {
                message: "Invalid state, potential CSRF attack.",
            });
        }
        const codeVerifier = getCookie(c, `${app}-code-verifier`);
        if (!codeVerifier && app === Apps.GoogleDrive) {
            throw new HTTPException(500, { message: "Could not verify the code" });
        }
        const userRes = await getUserByEmail(db, sub);
        if (!userRes || !userRes.length) {
            Logger.error("Could not find user in OAuth Callback");
            throw new NoUserFound({});
        }
        const provider = await getOAuthProvider(db, userRes[0].id, app);
        const { clientId, clientSecret } = provider;
        const google = new Google(clientId, clientSecret, `${config.host}/oauth/callback`);
        const tokens = await google.validateAuthorizationCode(code, codeVerifier);
        const oauthTokens = tokens;
        oauthTokens.data.accessTokenExpiresAt = tokens.accessTokenExpiresAt();
        const connectorId = provider.connectorId;
        const connector = await updateConnector(db, connectorId, {
            subject: email,
            oauthCredentials: JSON.stringify(oauthTokens),
            status: ConnectorStatus.Connecting,
        });
        const SaasJobPayload = {
            connectorId: connector.id,
            app,
            externalId: connector.externalId,
            authType: connector.authType,
            email: sub,
        };
        if (IsGoogleApp(app)) {
            handleGoogleOAuthIngestion(SaasJobPayload);
        }
        else {
            // Enqueue the background job within the same transaction
            const jobId = await boss.send(SaaSQueue, SaasJobPayload, {
                expireInHours: JobExpiryHours,
            });
            Logger.info(`Job ${jobId} enqueued for connection ${connector.id}`);
        }
        // Commit the transaction if everything is successful
        return c.redirect(`${config.host}/oauth/success`);
    }
    catch (error) {
        Logger.error(error, `${new OAuthCallbackError({ cause: error })} \n ${error.stack}`);
        throw new HTTPException(500, { message: "Error in OAuthCallback" });
    }
};
