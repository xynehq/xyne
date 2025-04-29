import {
  Subsystem,
  type TxnOrClient,
  type UpdateOAuthProviderForm,
} from "@/types"
import {
  oauthProviders,
  type InsertOAuthProvider,
  type SelectOAuthProvider,
} from "@/db/schema"
import { createId } from "@paralleldrive/cuid2"
import { type Apps } from "@/shared/types"
import { and, eq } from "drizzle-orm"
import { getLogger } from "@/logger"

const Logger = getLogger(Subsystem.Db).child({ module: "oauth_provider" })

export const createOAuthProvider = async (
  trx: TxnOrClient,
  data: Omit<InsertOAuthProvider, "externalId">,
) => {
  const externalId = createId()
  const toInsert = { ...data, externalId: externalId }
  try {
    const inserted = await trx
      .insert(oauthProviders)
      .values(toInsert)
      .returning()
    Logger.info("Provider inserted successfully")
    return inserted[0]
  } catch (error) {
    Logger.error(
      error,
      `Error inserting provider:, ${error} : ${(error as Error).stack}`,
    )
    throw new Error("Could not insert provider")
  }
}

export const getOAuthProvider = async (
  trx: TxnOrClient,
  userId: number,
  app: Apps,
): Promise<SelectOAuthProvider> => {
  const res = await trx
    .select()
    .from(oauthProviders)
    .where(and(eq(oauthProviders.app, app), eq(oauthProviders.userId, userId)))
    .limit(1)
  if (res.length) {
    return res[0]
  } else {
    throw new Error("Could not get the connector")
  }
}

export const getOAuthProviderByConnectorId = async (
  trx: TxnOrClient,
  connectorId: number,
): Promise<SelectOAuthProvider[]> => {
  const res = await trx
    .select()
    .from(oauthProviders)
    .where(eq(oauthProviders.connectorId, connectorId))
    .limit(1)
  if (res.length) {
    return res
  } else {
    throw new Error("Could not get the provider")
  }
}

export const updateOauthProvider = async (
  trx: TxnOrClient,
  userId: number,
  connectorId: number,
  data: UpdateOAuthProviderForm,
): Promise<SelectOAuthProvider> => {
  const { clientId, clientSecret, scopes } = data
  const result = await trx
    .update(oauthProviders)
    .set({
      clientId,
      clientSecret,
      oauthScopes: scopes,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(oauthProviders.userId, userId),
        eq(oauthProviders.connectorId, connectorId),
      ),
    )
    .returning()

  if (result.length === 0) {
    throw new Error("Could not update the provider")
  }
  return result[0]
}
