import { createId } from "@paralleldrive/cuid2"
import { db } from "./client"
export { db }
import {
  connectors,
  ingestionStateSchema,
  oauthProviders,
  selectConnectorSchema,
  users,
  type IngestionStateUnion,
  type SelectConnector,
  type SelectOAuthProvider,
} from "./schema"
import type {
  MicrosoftServiceCredentials,
  OAuthCredentials,
  TxnOrClient,
} from "@/types" // ConnectorType removed
import { Subsystem } from "@/types"
import { and, eq } from "drizzle-orm"
import { Apps, AuthType, ConnectorStatus, ConnectorType } from "@/shared/types" // ConnectorType added
import { Google, MicrosoftEntraId } from "arctic"
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
import { IsGoogleApp, IsMicrosoftApp } from "@/utils"
import { getOAuthProviderByConnectorId } from "@/db/oauthProvider"
import { getErrorMessage } from "@/utils"
import { syncJobs, syncHistory } from "@/db/schema"
import { scopes } from "@/integrations/microsoft/config"
import { CustomServiceAuthProvider } from "@/integrations/microsoft/utils"
import { date } from "zod"
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
  apiKey?: string | null,
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
        apiKey,
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
export const getConnectors = async (workspaceId: string, userId: number) => {
  const res = await db
    .select({
      id: connectors.externalId,
      cId: connectors.id,
      name: connectors.name,
      app: connectors.app,
      authType: connectors.authType,
      type: connectors.type,
      status: connectors.status,
      createdAt: connectors.createdAt,
      config: connectors.config,
      connectorId: connectors.id,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.workspaceExternalId, workspaceId),
        eq(connectors.userId, userId),
      ),
    )
  return res
}

export const getConnectorByApp = async (
  trx: TxnOrClient,
  app: Apps,
): Promise<SelectConnector> => {
  const res = await trx
    .select()
    .from(connectors)
    .where(and(eq(connectors.app, app)))
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
      message: `Could not get the connector with type: ${app}`,
    })
  }
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
  if (IsGoogleApp(app) || IsMicrosoftApp(app)) {
    const tokens = oauthCredentials.data
    const now: Date = new Date()
    // make the type as Date, currently the date is stringified
    const expirationTime = new Date(tokens.accessTokenExpiresAt).getTime()
    const currentTime = now.getTime()
    return currentTime + bufferInSeconds * 1000 > expirationTime
  }
  return false
}

const IsExpired = (
  app: Apps,
  expiresAt: Date,
  bufferInSeconds: number,
): boolean => {
  const now: Date = new Date()
  const currentTime = now.getTime()
  const expirationTime = new Date(expiresAt).getTime()
  return currentTime + bufferInSeconds * 1000 > expirationTime
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
  oauthRes.oauthCredentials = JSON.parse(oauthRes.oauthCredentials as string)

  // google tokens have expiry of 1 hour
  // 5 minutes before expiry we refresh them
  if (
    IsTokenExpired(
      oauthRes.app,
      oauthRes.oauthCredentials as OAuthCredentials,
      5 * 60,
    )
  ) {
    // token is expired. We should get new tokens
    // update it in place
    if (IsGoogleApp(oauthRes.app)) {
      // we will need the provider now to refresh the token
      const providers: SelectOAuthProvider[] =
        await getOAuthProviderByConnectorId(trx, connectorId)

      if (!providers.length) {
        Logger.error("Could not fetch provider while refreshing Google Token")
        throw new FetchProviderFailed({
          message: "Could not fetch provider while refreshing Google Token",
        })
      }
      const [googleProvider] = providers
      const google = new Google(
        googleProvider.clientId!,
        googleProvider.clientSecret as string,
        `${config.host}/oauth/callback`,
      )
      const tokens = (oauthRes.oauthCredentials as OAuthCredentials).data
      const refreshedTokens = await google.refreshAccessToken(
        tokens.refresh_token,
      )
      // update the token values
      tokens.access_token = refreshedTokens.accessToken()
      tokens.accessTokenExpiresAt = new Date(
        refreshedTokens.accessTokenExpiresAt(),
      )
      ;(oauthRes.oauthCredentials as OAuthCredentials).data = tokens
      const updatedConnector = await updateConnector(trx, oauthRes.id, {
        oauthCredentials: JSON.stringify(oauthRes.oauthCredentials),
      })
      Logger.info(`Connector successfully updated: ${updatedConnector.id}`)
    } else if (IsMicrosoftApp(oauthRes.app)) {
      // we will need the provider now to refresh the token
      const providers: SelectOAuthProvider[] =
        await getOAuthProviderByConnectorId(trx, connectorId)

      if (!providers.length) {
        Logger.error(
          "Could not fetch provider while refreshing Microsoft Token",
        )
        throw new FetchProviderFailed({
          message: "Could not fetch provider while refreshing Microsoft Token",
        })
      }
      const [microsoftProvider] = providers
      const microsoft = new MicrosoftEntraId(
        "common",
        microsoftProvider.clientId!,
        microsoftProvider.clientSecret as string,
        `${config.host}/oauth/callback`,
      )
      const tokens = (oauthRes.oauthCredentials as OAuthCredentials).data
      const refreshedTokens = await microsoft.refreshAccessToken(
        tokens.refresh_token,
        scopes,
      )
      // update the token values
      tokens.access_token = refreshedTokens.accessToken()
      tokens.accessTokenExpiresAt = new Date(
        refreshedTokens.accessTokenExpiresAt(),
      )
      // Update refresh token if a new one is provided
      if (refreshedTokens.refreshToken()) {
        tokens.refresh_token = refreshedTokens.refreshToken()
      }
      ;(oauthRes.oauthCredentials as OAuthCredentials).data = tokens
      const updatedConnector = await updateConnector(trx, oauthRes.id, {
        oauthCredentials: JSON.stringify(oauthRes.oauthCredentials),
      })
      Logger.info(
        `Microsoft connector successfully updated: ${updatedConnector.id}`,
      )
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

export const getMicrosoftAuthConnectorWithCredentials = async (
  trx: TxnOrClient,
  connectorId: number,
): Promise<SelectConnector> => {
  const res = await trx
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.id, connectorId),
        eq(connectors.authType, AuthType.ServiceAccount),
      ),
    )
    .limit(1)

  if (!res.length) {
    throw new NoOauthConnectorFound({
      message: `Could not get the oauth connector with id:  ${connectorId}`,
    })
  }

  let authRes: SelectConnector = selectConnectorSchema.parse(res[0])

  if (!authRes.credentials) {
    throw new MissingOauthConnectorCredentialsError({})
  }
  // parse the string
  const credentials: MicrosoftServiceCredentials = JSON.parse(
    authRes.credentials as string,
  )

  if (IsExpired(authRes.app, new Date(credentials.expires_at), 5 * 60)) {
    // token is expired. We should get new tokens
    // update it in place
    if (IsMicrosoftApp(authRes.app)) {
      const authProvider = new CustomServiceAuthProvider(
        credentials.tenantId,
        credentials.clientId,
        credentials.clientSecret,
      )

      const accessToken = await authProvider.getAccessTokenWithExpiry()
      credentials.access_token = accessToken.token
      credentials.expires_at = new Date(
        accessToken.expiresOnTimestamp,
      ).toISOString()

      authRes = await updateConnector(trx, authRes.id, {
        credentials: JSON.stringify(credentials),
      })
      Logger.info(`Microsoft connector successfully updated: ${authRes.id}`)
    } else {
      Logger.error(
        `Token has to refresh but ${authRes.app} app not yet supported`,
      )
      throw new Error(
        `Token has to refresh but ${authRes.app} app not yet supported`,
      )
    }
  }
  return authRes
}

export const getConnectorByExternalId = async (
  trx: TxnOrClient,
  connectorId: string,
  userId: number,
): Promise<SelectConnector> => {
  const res = await trx
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.externalId, connectorId),
        eq(connectors.userId, userId),
      ),
    )
    .limit(1)
  if (res.length) {
    const parsedRes = selectConnectorSchema.safeParse(res[0])
    if (!parsedRes.success) {
      Logger.error(
        `Failed to parse connector data for externalId ${connectorId}: ${parsedRes.error.toString()}`,
      )
      throw new NoConnectorsFound({
        message: `Could not parse connector data for externalId: ${connectorId}`,
      })
    }
    return parsedRes.data
  } else {
    Logger.error(
      `Connector not found for external ID ${connectorId} and user ID ${userId}`,
    )
    throw new NoConnectorsFound({
      message: `Connector not found for external ID ${connectorId} and user ID ${userId}`,
    })
  }
}

export const getConnectorById = async (
  trx: TxnOrClient,
  connectorId: number,
  userId: number,
): Promise<SelectConnector> => {
  const res = await trx
    .select()
    .from(connectors)
    .where(and(eq(connectors.id, connectorId), eq(connectors.userId, userId)))
    .limit(1)
  if (res.length) {
    const parsedRes = selectConnectorSchema.safeParse(res[0])
    if (!parsedRes.success) {
      Logger.error(
        `Failed to parse connector data for id ${connectorId}: ${parsedRes.error.toString()}`,
      )
      throw new NoConnectorsFound({
        message: `Could not parse connector data for id: ${connectorId}`,
      })
    }
    return parsedRes.data
  } else {
    Logger.error(
      `Connector not found for ID ${connectorId} and user ID ${userId}`,
    )
    throw new NoConnectorsFound({
      message: `Connector not found for ID ${connectorId} and user ID ${userId}`,
    })
  }
}

export const getConnectorByAppAndEmailId = async (
  trx: TxnOrClient,
  app: Apps,
  authType: AuthType,
  emailId: string,
): Promise<SelectConnector> => {
  const res = await trx
    .select()
    .from(connectors)
    .innerJoin(users, eq(connectors.userId, users.id))
    .where(and(eq(connectors.app, app), eq(users.email, emailId)))
    .limit(1)
  // console.log(res[0].connectors)
  if (res.length) {
    const parsedRes = selectConnectorSchema.safeParse(res[0].connectors)
    if (!parsedRes.success) {
      Logger.error(`Failed to parse connector data for user:${emailId} `)
      throw new NoConnectorsFound({
        message: `Could not parse connector data for user: ${emailId}`,
      })
    }
    return parsedRes.data
  } else {
    Logger.error(`Connector not found for emailID ${emailId} and app  ${app}`)
    throw new NoConnectorsFound({
      message: `Connector not found for emailID ${emailId} and app  ${app}`,
    })
  }
}

export const updateConnector = async (
  trx: TxnOrClient,
  connectorId: number,
  updateData: Partial<typeof connectors.$inferInsert>, // TODO: restrict updatable fields
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

export const deleteConnector = async (
  trx: TxnOrClient,
  connectorId: string,
  userId: number,
): Promise<void> => {
  return await trx
    .delete(connectors)
    .where(
      and(
        eq(connectors.externalId, connectorId),
        eq(connectors.userId, userId),
      ),
    )
}

export const deleteOauthConnector = async (
  trx: TxnOrClient,
  connectorId: number,
): Promise<void> => {
  Logger.info(
    `Attempting to delete OAuth connector and related data for connector ID: ${connectorId}`,
  )
  try {
    await trx.delete(syncJobs).where(eq(syncJobs.connectorId, connectorId))
    Logger.debug(`Deleted sync jobs for connector ID: ${connectorId}`)

    await trx
      .delete(oauthProviders)
      .where(eq(oauthProviders.connectorId, connectorId))
    Logger.debug(`Deleted OAuth providers for connector ID: ${connectorId}`)

    await trx.delete(connectors).where(eq(connectors.id, connectorId))
  } catch (error) {
    Logger.error(
      { error, connectorId },
      `Error deleting connector and related data: ${getErrorMessage(error)}`,
    )
    throw new Error(
      `Failed to delete connector ${connectorId}: ${getErrorMessage(error)}`,
    )
  }
}

export async function loadConnectorState<T extends IngestionStateUnion>(
  trx: TxnOrClient,
  connectorId: number,
  workspaceId: number,
  userId: number,
): Promise<T | null> {
  const result = await trx
    .select({ state: connectors.state })
    .from(connectors)
    .where(
      and(
        eq(connectors.id, connectorId),
        eq(connectors.workspaceId, workspaceId),
        eq(connectors.userId, userId),
      ),
    )
    .limit(1)

  if (result.length === 0) {
    Logger.warn(
      `No connector found for id=${connectorId}, workspaceId=${workspaceId}, userId=${userId}`,
    )
    return null
  }

  const state = result[0].state as Record<string, any>
  if (Object.keys(state).length === 0) {
    return null // Treat empty object as no state
  }
  const parsedState = ingestionStateSchema.safeParse(result[0].state)
  if (parsedState.success) {
    return parsedState.data as T
  } else {
    Logger.warn(
      `Invalid state format for connector ${connectorId}: ${parsedState.error}`,
    )
    return null
  }
}

export async function saveConnectorState<T extends IngestionStateUnion>(
  trx: TxnOrClient,
  connectorId: number,
  workspaceId: number,
  userId: number,
  state: T,
): Promise<void> {
  const updated = await trx
    .update(connectors)
    .set({ state })
    .where(
      and(
        eq(connectors.id, connectorId),
        eq(connectors.workspaceId, workspaceId),
        eq(connectors.userId, userId),
      ),
    )
    .returning({ id: connectors.id })

  if (updated.length === 0) {
    Logger.error(
      `Failed to update state for connector id=${connectorId}, workspaceId=${workspaceId}, userId=${userId}`,
    )
    throw new UpdateConnectorFailed(
      `Could not update state for connector ${connectorId}`,
    )
  }

  Logger.debug(`State saved for connector ${connectorId}`)
}
