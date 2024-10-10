import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

import { db } from "@/db/client";
import { getUserByEmail } from "@/db/user";
import {
  getConnectorByExternalId,
  getConnectors,
  insertConnector,
} from "@/db/connector";
import {
  ConnectorType,
  type OAuthProvider,
  type OAuthStartQuery,
  type SaaSJob,
  type ServiceAccountConnection,
} from "@/types";
import { boss, SaaSQueue } from "@/queue";
import config from "@/config";
import { Apps, AuthType, ConnectorStatus } from "@/shared/types";
import { createOAuthProvider, getOAuthProvider } from "@/db/oauthProvider";
const { JwtPayloadKey } = config;
import { generateCodeVerifier, generateState, Google } from "arctic";
import type { SelectOAuthProvider } from "@/db/schema";
import { setCookieByEnv } from "@/utils";

export const GetConnectors = async (c: Context) => {
  const { workspaceId } = c.get(JwtPayloadKey);
  const connectors = await getConnectors(workspaceId);
  return c.json(connectors);
};

const getAuthorizationUrl = async (
  c: Context,
  app: Apps,
  provider: SelectOAuthProvider,
): Promise<URL> => {
  const { clientId, clientSecret, oauthScopes } = provider;
  const google = new Google(
    clientId as string,
    clientSecret,
    `${config.host}/oauth/callback`,
  );
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  console.log("code verifier ", codeVerifier);
  // adding some data to state
  const newState = JSON.stringify({ app, random: state });
  const url: URL = await google.createAuthorizationURL(newState, codeVerifier, {
    scopes: oauthScopes,
  });
  // for google refresh token
  if (app === Apps.GoogleDrive) {
    url.searchParams.set("access_type", "offline");
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

export const StartOAuth = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey);
  const { app }: OAuthStartQuery = c.req.valid("query");
  console.log(`${sub} started ${app} OAuth`);
  const provider = await getOAuthProvider(db, app);
  const url = await getAuthorizationUrl(c, app, provider);
  return c.redirect(url.toString());
};

export const CreateOAuthProvider = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey);
  const email = sub;
  const userRes = await getUserByEmail(db, email);
  if (!userRes || !userRes.length) {
    throw new Error("Could not get user");
  }
  const [user] = userRes;
  const form: OAuthProvider = c.req.valid("form");
  const clientId = form.clientId;
  const clientSecret = form.clientSecret;
  const scopes = form.scopes;
  const app = form.app;

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
      ConnectorStatus.NotConnected,
    );
    if (!connector) {
      throw new Error("Connecter wasn't created");
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

export const AddServiceConnection = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey);
  const email = sub;
  const userRes = await getUserByEmail(db, email);
  if (!userRes || !userRes.length) {
    throw new Error("Could not get user");
  }
  const [user] = userRes;
  const form: ServiceAccountConnection = c.req.valid("form");
  const data = await form["service-key"].text();
  const subject = form.email;
  const app = form.app;

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
      );

      const SaasJobPayload: SaaSJob = {
        connectorId: connector.id,
        workspaceId: user.workspaceId,
        userId: user.id,
        app,
        externalId: connector.externalId,
        authType: connector.authType as AuthType,
        email: sub,
      };
      // Enqueue the background job within the same transaction
      const jobId = await boss.send(SaaSQueue, SaasJobPayload);

      console.log(`Job ${jobId} enqueued for connection ${connector.id}`);

      // Commit the transaction if everything is successful
      return c.json({
        success: true,
        message: "Connection created, job enqueued",
        id: connector.externalId,
      });
    } catch (error) {
      console.error("Error:", error);
      // Rollback the transaction in case of any error
      throw new HTTPException(500, {
        message: "Error creating connection or enqueuing job",
      });
    }
  });
};
