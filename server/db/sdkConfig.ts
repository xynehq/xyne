import {
  sdkConfigs,
  type SdkConfig,
  type NewSdkConfig,
  workspaces,
} from "@/db/schema"
import type { TxnOrClient } from "@/types"
import { eq, sql } from "drizzle-orm"

export const getSdkConfigByWorkspaceExternalId = async (
  trx: TxnOrClient,
  workspaceExternalId: string,
): Promise<SdkConfig | null> => {
  const [result] = await trx
    .select()
    .from(sdkConfigs)
    .where(eq(sdkConfigs.workspaceId, workspaceExternalId))
  return result || null
}

export const getSdkConfigWithWorkspace = async (
  trx: TxnOrClient,
  workspaceExternalId: string,
): Promise<{
  config: SdkConfig
  workspace: { id: number; externalId: string }
} | null> => {
  const [result] = await trx
    .select({
      config: sdkConfigs,
      workspace: {
        id: workspaces.id,
        externalId: workspaces.externalId,
      },
    })
    .from(sdkConfigs)
    .innerJoin(workspaces, eq(sdkConfigs.workspaceId, workspaces.externalId))
    .where(eq(sdkConfigs.workspaceId, workspaceExternalId))
  return result || null
}

export const createSdkConfig = async (
  trx: TxnOrClient,
  data: NewSdkConfig,
): Promise<SdkConfig> => {
  const [result] = await trx.insert(sdkConfigs).values(data).returning()
  return result
}

export const updateSdkConfig = async (
  trx: TxnOrClient,
  workspaceExternalId: string,
  updates: Partial<
    Pick<
      NewSdkConfig,
      "tokenSecret" | "tokenExpirySeconds" | "allowedOrigins" | "enabled" | "spacesConfig"
    >
  >,
): Promise<SdkConfig> => {
  const [result] = await trx
    .update(sdkConfigs)
    .set({
      ...updates,
      updatedAt: sql`NOW()`,
    })
    .where(eq(sdkConfigs.workspaceId, workspaceExternalId))
    .returning()
  return result
}
