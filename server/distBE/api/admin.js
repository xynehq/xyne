import { HTTPException } from "hono/http-exception";
import { db } from "../db/client.js";
import { getUserByEmail } from "../db/user.js";
import { getConnectorByExternalId, getConnectors, insertConnector, } from "../db/connector.js";
import { ConnectorType, Subsystem, } from "../types.js";
// import { boss, SaaSQueue } from "../queue";
import config from "../config.js";
import { Apps, AuthType, ConnectorStatus } from "../shared/types.js";
import { createOAuthProvider, getOAuthProvider } from "../db/oauthProvider.js";
const { JwtPayloadKey, JobExpiryHours, serviceAccountWhitelistedEmails } = config;
import { generateCodeVerifier, generateState, Google } from "arctic";
import { getErrorMessage, IsGoogleApp, setCookieByEnv } from "../utils.js";
import { getLogger } from "../logger/index.js";
import { getPath } from "hono/utils/url";
import { AddServiceConnectionError, ConnectorNotCreated, NoUserFound, } from "../errors/index.js";
import { handleGoogleServiceAccountIngestion } from "../integrations/google/index.js";
const Logger = getLogger(Subsystem.Api).child({ module: "admin" });
export const GetConnectors = async (c) => {
    const { workspaceId, sub } = c.get(JwtPayloadKey);
    const users = await getUserByEmail(db, sub);
    if (users.length === 0) {
        Logger.error({ sub }, "No user found for sub in GetConnectors");
        throw new NoUserFound({});
    }
    const user = users[0];
    const connectors = await getConnectors(workspaceId, user.id);
    return c.json(connectors);
};
const getAuthorizationUrl = async (c, app, provider) => {
    const { clientId, clientSecret, oauthScopes } = provider;
    const google = new Google(clientId, clientSecret, `${config.host}/oauth/callback`);
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    Logger.info(`code verifier  ${codeVerifier}`);
    // adding some data to state
    const newState = JSON.stringify({ app, random: state });
    const url = google.createAuthorizationURL(newState, codeVerifier, oauthScopes);
    // for google refresh token
    if (IsGoogleApp(app)) {
        url.searchParams.set("access_type", "offline");
        url.searchParams.set("prompt", "consent");
    }
    // store state verifier as cookie
    setCookieByEnv(c, `${app}-state`, state, {
        secure: true, // set to false in localhost
        path: "/",
        httpOnly: true,
        maxAge: 60 * 10, // 10 min
    });
    // store code verifier as cookie
    setCookieByEnv(c, `${app}-code-verifier`, codeVerifier, {
        secure: true, // set to false in localhost
        path: "/",
        httpOnly: true,
        maxAge: 60 * 10, // 10 min
    });
    return url;
};
export const StartOAuth = async (c) => {
    const path = getPath(c.req.raw);
    Logger.info({
        reqiestId: c.var.requestId,
        method: c.req.method,
        path,
    }, "Started Oauth");
    const { sub, workspaceId } = c.get(JwtPayloadKey);
    // @ts-ignore
    const { app } = c.req.valid("query");
    Logger.info(`${sub} started ${app} OAuth`);
    const userRes = await getUserByEmail(db, sub);
    if (!userRes || !userRes.length) {
        Logger.error("Could not find user by email when starting OAuth");
        throw new NoUserFound({});
    }
    const provider = await getOAuthProvider(db, userRes[0].id, app);
    const url = await getAuthorizationUrl(c, app, provider);
    return c.redirect(url.toString());
};
export const CreateOAuthProvider = async (c) => {
    const { sub, workspaceId } = c.get(JwtPayloadKey);
    const email = sub;
    const userRes = await getUserByEmail(db, email);
    if (!userRes || !userRes.length) {
        throw new NoUserFound({});
    }
    const [user] = userRes;
    // @ts-ignore
    const form = c.req.valid("form");
    const clientId = form.clientId;
    const clientSecret = form.clientSecret;
    const scopes = form.scopes;
    const app = form.app;
    return await db.transaction(async (trx) => {
        const connector = await insertConnector(trx, // Pass the transaction object
        user.workspaceId, user.id, user.workspaceExternalId, `${app}-${ConnectorType.SaaS}-${AuthType.OAuth}`, ConnectorType.SaaS, AuthType.OAuth, app, {}, null, null, null, ConnectorStatus.NotConnected);
        if (!connector) {
            throw new ConnectorNotCreated({});
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
        });
        return c.json({
            success: true,
            message: "Connection and Provider created",
        });
    });
};
export const AddServiceConnection = async (c) => {
    Logger.info("AddServiceConnection");
    const { sub, workspaceId } = c.get(JwtPayloadKey);
    const email = sub;
    const userRes = await getUserByEmail(db, email);
    if (!userRes || !userRes.length) {
        throw new NoUserFound({});
    }
    const [user] = userRes;
    // @ts-ignore
    const form = c.req.valid("form");
    const data = await form["service-key"].text();
    const subject = form.email;
    const app = form.app;
    // Start a transaction
    // return await db.transaction(async (trx) => {
    try {
        // Insert the connection within the transaction
        const connector = await insertConnector(db, // Pass the transaction object
        user.workspaceId, user.id, user.workspaceExternalId, `${app}-${ConnectorType.SaaS}-${AuthType.ServiceAccount}`, ConnectorType.SaaS, AuthType.ServiceAccount, app, {}, data, subject);
        const SaasJobPayload = {
            connectorId: connector.id,
            workspaceId: user.workspaceId,
            userId: user.id,
            app,
            externalId: connector.externalId,
            authType: connector.authType,
            email: sub,
            whiteListedEmails: serviceAccountWhitelistedEmails,
        };
        // Enqueue the background job within the same transaction
        // const jobId = await boss.send(SaaSQueue, SaasJobPayload, {
        //   singletonKey: connector.externalId,
        //   priority: 1,
        //   retryLimit: 0,
        //   expireInHours: JobExpiryHours,
        // })
        if (IsGoogleApp(app)) {
            handleGoogleServiceAccountIngestion(SaasJobPayload);
        }
        // Logger.info(`Job ${jobId} enqueued for connection ${connector.id}`)
        // Commit the transaction if everything is successful
        return c.json({
            success: true,
            message: "Connection created, job enqueued",
            id: connector.externalId,
        });
    }
    catch (error) {
        const errMessage = getErrorMessage(error);
        Logger.error(error, `${new AddServiceConnectionError({ cause: error })} \n : ${errMessage} : ${error.stack}`);
        // Rollback the transaction in case of any error
        throw new HTTPException(500, {
            message: "Error creating connection or enqueuing job",
        });
    }
    // })
};
