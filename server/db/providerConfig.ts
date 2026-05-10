import {
  providerConfigs,
  type ProviderConfig,
  type NewProviderConfig,
  workspaces,
} from "@/db/schema"
import type { TxnOrClient } from "@/types"
import { eq, sql } from "drizzle-orm"

export const getProviderConfigByWorkspaceExternalId = async (
  trx: TxnOrClient,
  workspaceExternalId: string,
): Promise<ProviderConfig | null> => {
  const [result] = await trx
    .select()
    .from(providerConfigs)
    .where(eq(providerConfigs.workspaceId, workspaceExternalId))
  return result || null
}

export const getProviderConfigWithWorkspace = async (
  trx: TxnOrClient,
  workspaceExternalId: string,
): Promise<{ config: ProviderConfig; workspace: { id: number; externalId: string } } | null> => {
  const [result] = await trx
    .select({
      config: providerConfigs,
      workspace: {
        id: workspaces.id,
        externalId: workspaces.externalId,
      },
    })
    .from(providerConfigs)
    .innerJoin(workspaces, eq(providerConfigs.workspaceId, workspaces.externalId))
    .where(eq(providerConfigs.workspaceId, workspaceExternalId))
  return result || null
}

export const createProviderConfig = async (
  trx: TxnOrClient,
  data: NewProviderConfig,
): Promise<ProviderConfig> => {
  const [result] = await trx
    .insert(providerConfigs)
    .values(data)
    .returning()
  return result
}

export const updateProviderConfig = async (
  trx: TxnOrClient,
  workspaceExternalId: string,
  updates: Partial<Pick<NewProviderConfig, "tokenSecret" | "tokenExpirySeconds" | "allowedOrigins" | "enabled">>,
): Promise<ProviderConfig> => {
  const [result] = await trx
    .update(providerConfigs)
    .set({
      ...updates,
      updatedAt: sql`NOW()`,
    })
    .where(eq(providerConfigs.workspaceId, workspaceExternalId))
    .returning()
  return result
}
