import { createId } from "@paralleldrive/cuid2"
import { db } from "./client"
import {
  connectors,
  oauthProviders,
  selectConnectorSchema,
  type SelectConnector,
  type SelectOAuthProvider,
} from "./schema"
import type { ConnectorType, OAuthCredentials, TxnOrClient } from "@/types"
import { Subsystem } from "@/types"
import { and, eq } from "drizzle-orm"
import { Apps, AuthType, ConnectorStatus } from "@/shared/types"
import { Google, type GoogleRefreshedTokens, type GoogleTokens } from "arctic"
import config from "@/config"
import { getLogger } from "@/logger"
import {
  ConnectionInsertionError,
  NoConnectorsFound,
  NoOauthConnectorFound,
  MissingOauthConnectorCredentialsError,
  FetchProviderFailed,
  UpdateConnectorFailed,
} from "@/errors"
const Logger = getLogger(Subsystem.Db).child({ module: "connector" })

export const insertConnector = async (
  trx: TxnOrClient,
  workspaceId: number,
  userId: number,
  workspaceExternalId: string,
  name: string,
  type: ConnectorType, // Use TypeScript enum for type safety
  authType: AuthType, // Use TypeScript enum for authType
  app: Apps, // Use TypeScript enum for app
  config: Record<string, any>,
  credentials: string | null,
  subject: string | null,
  oauthCredentials?: string | null,
  status?: ConnectorStatus | null,
) => {
  const externalId = createId() // Generate unique external ID
  try {
    const inserted = await trx
      .insert(connectors)
      .values({
        workspaceId,
        userId,
        workspaceExternalId,
        externalId: externalId, // Unique external ID for the connection
        name: name, // Name of the connection
        type: type, // Type of connection from the enum
        authType: authType, // Authentication type from the enum
        app: app, // App type from the enum
        config: config, // JSON configuration for the connection
        credentials, // Encrypted credentials
        subject,
        oauthCredentials,
        ...(status ? { status } : {}),
      })
      .returning()
    Logger.info("Connection inserted successfully")
    return inserted[0]
  } catch (error) {
    Logger.error(
      error,
      `Error inserting connection:, ${error} \n ${(error as Error).stack}`,
    )
    throw new ConnectionInsertionError({
      message: "Could not insert connection",
      cause: error as Error,
    })
  }
}

// for the admin we can get all the connectors
export const getConnectors = async (workspaceId: string) => {
  const res = await db
    .select({
      id: connectors.externalId,
      app: connectors.app,
      authType: connectors.authType,
      type: connectors.type,
      status: connectors.status,
      createdAt: connectors.createdAt,
    })
    .from(connectors)
    .where(eq(connectors.workspaceExternalId, workspaceId))
  return res
}

// don't call this
// call the function that ensures the credentials are always refreshed
export const getConnector = async (
  trx: TxnOrClient,
  connectorId: number,
): Promise<SelectConnector> => {
  const res = await db
    .select()
    .from(connectors)
    .where(eq(connectors.id, connectorId))
    .limit(1)
  if (res.length) {
    const parsedRes = selectConnectorSchema.safeParse(res[0])
    if (!parsedRes.success) {
      throw parsedRes.error
    }
    // TODO: maybe add a check if OAuth and expired token then throw error
    return parsedRes.data
  } else {
    throw new NoConnectorsFound({
      message: `Could not get the connector with id: ${connectorId}`,
    })
  }
}

const IsTokenExpired = (
  app: Apps,
  oauthCredentials: OAuthCredentials,
  bufferInSeconds: number,
): boolean => {
  if (app === Apps.GoogleDrive) {
    const tokens: GoogleTokens = oauthCredentials
    const now: Date = new Date()
    // make the type as Date, currently the date is stringified
    const expirationTime = new Date(tokens.accessTokenExpiresAt).getTime()
    const currentTime = now.getTime()
    return currentTime + bufferInSeconds * 1000 > expirationTime
  }
  return false
}

// this method ensures that if it retuns the connector then the access token will always be valid
// it takes upon itself to refresh if expired
export const getOAuthConnectorWithCredentials = async (
  trx: TxnOrClient,
  connectorId: number,
): Promise<SelectConnector> => {
  const res = await trx
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.id, connectorId),
        eq(connectors.authType, AuthType.OAuth),
      ),
    )
    .limit(1)

  if (!res.length) {
    throw new NoOauthConnectorFound({
      message: `Could not get the oauth connector with id:  ${connectorId}`,
    })
  }

  const oauthRes: SelectConnector = selectConnectorSchema.parse(res[0])

  if (!oauthRes.oauthCredentials) {
    throw new MissingOauthConnectorCredentialsError({})
  }
  // parse the string
  oauthRes.oauthCredentials = JSON.parse(oauthRes.oauthCredentials)

  // google tokens have expiry of 1 hour
  // 5 minutes before expiry we refresh them
  if (IsTokenExpired(oauthRes.app, oauthRes.oauthCredentials, 5 * 60)) {
    // token is expired. We should get new tokens
    // update it in place
    if (oauthRes.app === Apps.GoogleDrive) {
      // we will need the provider now to refresh the token
      const providers: SelectOAuthProvider[] = await trx
        .select()
        .from(oauthProviders)
        .where(eq(oauthProviders.connectorId, oauthRes.id))
        .limit(1)

      if (!providers.length) {
        Logger.error("Could not fetch provider while refreshing Google Token")
        throw new FetchProviderFailed({
          message: "Could not fetch provider while refreshing Google Token",
        })
      }
      const [googleProvider] = providers
      const google = new Google(
        googleProvider.clientId!,
        googleProvider.clientSecret,
        `${config.host}/oauth/callback`,
      )
      const tokens: GoogleTokens = oauthRes.oauthCredentials
      const refreshedTokens: GoogleRefreshedTokens =
        await google.refreshAccessToken(tokens.refreshToken!)
      // update the token values
      tokens.accessToken = refreshedTokens.accessToken
      tokens.accessTokenExpiresAt = new Date(
        refreshedTokens.accessTokenExpiresAt,
      )
      const updatedConnector = await updateConnector(trx, oauthRes.id, {
        oauthCredentials: JSON.stringify(tokens),
      })
      Logger.info(`Connector successfully updated: ${updatedConnector.id}`)
      oauthRes.oauthCredentials = tokens
    } else {
      Logger.error(
        `Token has to refresh but ${oauthRes.app} app not yet supported`,
      )
      throw new Error(
        `Token has to refresh but ${oauthRes.app} app not yet supported`,
      )
    }
  }
  return oauthRes
}

export const getConnectorByExternalId = async (connectorId: string) => {
  const res = await db
    .select()
    .from(connectors)
    .where(eq(connectors.externalId, connectorId))
    .limit(1)
  if (res.length) {
    return res[0]
  } else {
    Logger.error(`Connector not found for external ID ${connectorId}`)
    throw new NoConnectorsFound({
      message: `Could not get the connector with id: ${connectorId}`,
    })
  }
}

export const updateConnector = async (
  trx: TxnOrClient,
  connectorId: number,
  updateData: Partial<SelectConnector>,
): Promise<SelectConnector> => {
  const updatedConnectors = await trx
    .update(connectors)
    .set(updateData)
    .where(eq(connectors.id, connectorId))
    .returning()

  if (!updatedConnectors || !updatedConnectors.length) {
    Logger.error(`Could not update connector`)
    throw new UpdateConnectorFailed("Could not update connector")
  }
  const [connectorVal] = updatedConnectors
  return selectConnectorSchema.parse(connectorVal)
}
