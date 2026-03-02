import type { Context } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { HTTPException } from "hono/http-exception"
import { db } from "@/db/client"
import { connectors } from "@/db/schema"
import { eq } from "drizzle-orm"
import { updateConnector } from "@/db/connector"
import {
  syncDatabase,
  syncSingleTable,
  type DatabaseSyncKbContext,
} from "@/integrations/database"
import type { DatabaseCredentialsPayload } from "@/integrations/database/types"
import type { DatabaseConnectorConfig } from "@/shared/types"
import { DatabaseEngine } from "@/integrations/database/types"
import {
  getDatabaseConnectorForUser,
  getOrCreateDatabaseConnectorKbCollectionId,
  insertConnector,
} from "@/db/connector"
import { getSyncStateRowsByConnectorId } from "@/db/databaseSyncState"
import { ConnectorType, Apps, AuthType, ConnectorStatus } from "@/shared/types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import config from "@/config"
import { createDatabaseConnectorSchema } from "@/types"
import { deleteCollection } from "@/api/knowledgeBase"
import { getErrorMessage } from "@/utils"

const { JwtPayloadKey } = config


const Logger = getLogger(Subsystem.Api).child({ module: "databaseConnector" })

const triggerSyncSchema = z.object({
  connectorId: z.string().min(1),
})

/**
 * Build full DatabaseConnectorConfig from connector row.
 * Credentials are read from connectors.credentials (decrypted by Drizzle); never log them.
 */
export function assertDatabaseConnectorConfig(connector: {
  type: string
  config: unknown
  credentials: string | null
}): DatabaseConnectorConfig {
  if (connector.type !== ConnectorType.Database) {
    throw new HTTPException(400, {
      message: "Connector is not a database connector",
    })
  }
  const config = connector.config as Record<string, unknown>
  if (!config?.engine || !config?.host || !config?.database) {
    throw new HTTPException(400, {
      message: "Invalid database connector config",
    })
  }
  if (!connector.credentials?.trim()) {
    throw new HTTPException(400, { message: "Database connector missing credentials" })
  }
  let creds: DatabaseCredentialsPayload
  try {
    creds = JSON.parse(connector.credentials) as DatabaseCredentialsPayload
  } catch {
    throw new HTTPException(400, { message: "Invalid database connector credentials" })
  }
  if (creds.kind !== "database" || typeof creds.username !== "string" || typeof creds.password !== "string") {
    throw new HTTPException(400, { message: "Invalid database connector credentials" })
  }
  const base = config as Omit<DatabaseConnectorConfig, "auth">
  return {
    ...base,
    auth: { username: creds.username, password: creds.password },
  }
}

/** Returns DatabaseConnectorConfig from connector row or null if invalid. For use in non-API code (e.g. retrieval). */
export function getDatabaseConnectorConfig(connector: {
  type: string
  config: unknown
  credentials: string | null
}): DatabaseConnectorConfig | null {
  if (connector.type !== ConnectorType.Database) return null
  const config = connector.config as Record<string, unknown>
  if (!config?.engine || !config?.host || !config?.database || !connector.credentials?.trim()) return null
  let creds: DatabaseCredentialsPayload
  try {
    creds = JSON.parse(connector.credentials) as DatabaseCredentialsPayload
  } catch {
    return null
  }
  if (creds.kind !== "database" || typeof creds.username !== "string" || typeof creds.password !== "string") return null
  const base = config as Omit<DatabaseConnectorConfig, "auth">
  return { ...base, auth: { username: creds.username, password: creds.password } }
}

export const TriggerDatabaseSyncApi = async (c: Context) => {
    const { sub: email, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
    if (!email) throw new HTTPException(401, { message: "Unauthorized" })
    const syncBody = await c.req.json()
    const { connectorId } = triggerSyncSchema.parse(syncBody)
    const userWorkspace = await getUserAndWorkspaceByEmail(db, workspaceExternalId, email)
    if (!userWorkspace) throw new HTTPException(404, { message: "User or workspace not found" })

    const connector = await getDatabaseConnectorForUser(
      db,
      connectorId,
      userWorkspace.user.id,
      userWorkspace.workspace.id,
    )
    if (!connector) throw new HTTPException(404, { message: "Connector not found" })
    const dbConfig = assertDatabaseConnectorConfig(connector)

    const kbContext: DatabaseSyncKbContext = {
      workspaceId: connector.workspaceId,
      workspaceExternalId: connector.workspaceExternalId,
      userId: connector.userId,
      userEmail: email,
      connectorName: connector.name,
      getOrCreateKbCollection: getOrCreateDatabaseConnectorKbCollectionId,
    }

    try {
      const result = await syncDatabase(dbConfig, String(connector.id), kbContext)
      return c.json({
        success: true,
        tablesSynced: result.tablesSynced,
        rowsSynced: result.rowsSynced,
      })
    } catch (err) {
      Logger.error({ err, connectorId }, "Database sync failed")
      throw new HTTPException(500, {
        message: "Failed to sync database connector",
    })
  }
}

export const GetDatabaseSyncStateApi = async (c: Context) => {
  const { sub: email, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
  if (!email) throw new HTTPException(401, { message: "Unauthorized" })
  const connectorId = c.req.param("connectorId")
  if (!connectorId) throw new HTTPException(400, { message: "connectorId is required" })
  const userWorkspace = await getUserAndWorkspaceByEmail(db, workspaceExternalId, email)
  if (!userWorkspace) throw new HTTPException(404, { message: "User or workspace not found" })

  const connector = await getDatabaseConnectorForUser(
    db,
    connectorId,
    userWorkspace.user.id,
    userWorkspace.workspace.id,
  )
  if (!connector) throw new HTTPException(404, { message: "Connector not found" })

  const tables = await getSyncStateRowsByConnectorId(String(connector.id))
  const config = connector.config as Record<string, unknown>
  const tablesConfig = config?.tables as { embed?: string[] } | undefined
  const embedTables = tablesConfig?.embed ?? []
  return c.json({ tables, embedTables })
}

export const CreateDatabaseConnectorApi = async (c: Context) => {
    const { sub: email, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
    if (!email) {
      throw new HTTPException(401, { message: "Unauthorized" })
    }
    const userWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceExternalId,
      email,
    )
    if (!userWorkspace) {
      throw new HTTPException(404, { message: "User or workspace not found" })
    }
    const raw = await c.req.json()
    const body = createDatabaseConnectorSchema.parse(raw)
    const tables: DatabaseConnectorConfig["tables"] = {}
    if (body.tablesInclude?.trim()) {
      tables.include = body.tablesInclude.split(",").map((s) => s.trim()).filter(Boolean)
    }
    if (body.tablesIgnore?.trim()) {
      tables.ignore = body.tablesIgnore.split(",").map((s) => s.trim()).filter(Boolean)
    }
    if (body.tablesEmbed?.trim()) {
      tables.embed = body.tablesEmbed.split(",").map((s) => s.trim()).filter(Boolean)
    }
    const config = {
      engine: body.engine as DatabaseEngine,
      host: body.host,
      port: body.port,
      database: body.database,
      schema: body.schema || undefined,
      tables: Object.keys(tables).length ? tables : undefined,
      batchSize: body.batchSize,
      concurrency: 2,
      watermarkColumn: body.watermarkColumn || undefined,
      cdcEnabled: false,
    } as Omit<DatabaseConnectorConfig, "auth">
    const credentialsPayload: DatabaseCredentialsPayload = {
      kind: "database",
      username: body.username,
      password: body.password,
    }
    const credentialsStr = JSON.stringify(credentialsPayload)
    try {
      const connector = await insertConnector(
        db,
        userWorkspace.user.workspaceId as number,
        userWorkspace.user.id,
        userWorkspace.workspace.externalId,
        body.name,
        ConnectorType.Database,
        AuthType.Custom,
        Apps.Database,
        config as unknown as Record<string, unknown>,
        credentialsStr,
        null,
        null,
        null,
        ConnectorStatus.Connected,
      )
      return c.json({
        success: true,
        id: connector!.externalId,
        cId: connector!.id,
      })
    } catch (err) {
      Logger.error({ err }, "Create database connector failed")
      throw new HTTPException(500, {
        message: "Failed to create database connector",
      })
    }
  }

const deleteConnectorSchema = z.object({
  connectorId: z.string().min(1),
})

/**
 * Delete a database connector along with its KB collection and all items.
 * This will:
 * 1. Delete the connector from the connectors table
 * 2. Delete the associated KB collection and all its items
 * 3. Clean up Vespa documents and storage files
 * 4. Delete sync state records
 */
export const DeleteDatabaseConnectorApi = async (c: Context) => {
  const { sub: email, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
  if (!email) {
    throw new HTTPException(401, { message: "Unauthorized" })
  }

  const rawBody = await c.req.json()
  const { connectorId } = deleteConnectorSchema.parse(rawBody)
  const userWorkspace = await getUserAndWorkspaceByEmail(db, workspaceExternalId, email)
  if (!userWorkspace) throw new HTTPException(404, { message: "User or workspace not found" })

  const connector = await getDatabaseConnectorForUser(
    db,
    connectorId,
    userWorkspace.user.id,
    userWorkspace.workspace.id,
  )
  if (!connector) throw new HTTPException(404, { message: "Connector not found" })
  if (connector.type !== ConnectorType.Database) {
    throw new HTTPException(400, { message: "Connector is not a database connector" })
  }

  const state = (connector.state as Record<string, unknown>) || {}
  const kbCollectionId = state.kbCollectionId as string | undefined

  try {
    let deletedCount = 0
    let deletedFiles = 0
    let deletedFolders = 0

    if (kbCollectionId) {
      const result = await deleteCollection(db, kbCollectionId, email)
      if (!result.success) {
        throw new HTTPException(500, {
          message: "Failed to delete Collection",
        })
      }
      deletedCount = result.deletedCount
      deletedFiles = result.deletedFiles
      deletedFolders = result.deletedFolders
    }

    // Delete the connector row (database_sync_state rows cascade-delete via FK)
    await db.delete(connectors).where(eq(connectors.id, connector.id))

    Logger.info(
      `Deleted database connector: ${connectorId} (${deletedCount} items deleted, ${deletedFiles} files and ${deletedFolders} folders removed from Vespa and storage)`,
    )

    return c.json({
      success: true,
      deletedCount,
      deletedFiles,
      deletedFolders,
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    Logger.error(error, `Failed to delete database connector: ${errMsg}`)
    throw new HTTPException(500, {
      message: "Failed to delete database connector",
    })
  }
}

const syncTableSchema = z.object({
  connectorId: z.string().min(1),
  tableName: z.string().min(1),
})

const updateDatabaseConnectorSchema = z.object({
  connectorId: z.string().min(1),
  name: z.string().min(1, "Name is required"),
  engine: z.nativeEnum(DatabaseEngine),
  host: z.string().min(1, "Host is required"),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1, "Database is required"),
  schema: z.string().optional(),
  tablesInclude: z.string().optional(),
  tablesIgnore: z.string().optional(),
  tablesEmbed: z.string().optional(),
  watermarkColumn: z.string().optional(),
  batchSize: z.number().int().positive().default(1000),
})

const rotateCredentialsSchema = z.object({
  connectorId: z.string().min(1),
  newUsername: z.string().min(1, "New username is required"),
  newPassword: z.string().min(1, "New password is required"),
})

export type UpdateDatabaseConnector = z.infer<
  typeof updateDatabaseConnectorSchema
>

/**
 * Update a database connector's configuration (name, host, port, database, schema, tables, watermark, batch size).
 * Credentials are not accepted here; use RotateCredentialsApi to change username/password.
 */
export const UpdateDatabaseConnectorApi = async (c: Context) => {
  const { sub: email, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
  if (!email) {
    throw new HTTPException(401, { message: "Unauthorized" })
  }

  const userWorkspace = await getUserAndWorkspaceByEmail(
    db,
    workspaceExternalId,
    email,
  )
  if (!userWorkspace) {
    throw new HTTPException(404, { message: "User or workspace not found" })
  }

  const raw = await c.req.json()
  const body = updateDatabaseConnectorSchema.parse(raw)

  // Get the existing connector
  const connector = await getDatabaseConnectorForUser(
    db,
    body.connectorId,
    userWorkspace.user.id,
    userWorkspace.workspace.id,
  )
  if (!connector) {
    throw new HTTPException(404, { message: "Connector not found" })
  }
  if (connector.type !== ConnectorType.Database) {
    throw new HTTPException(400, { message: "Connector is not a database connector" })
  }

  // Build the updated config - check for presence (undefined) not truthy to allow clearing filters
  const hasTablesInclude = body.tablesInclude !== undefined
  const hasTablesIgnore = body.tablesIgnore !== undefined
  const hasTablesEmbed = body.tablesEmbed !== undefined

  const existingConfig = connector.config as Record<string, unknown>

  const tables: DatabaseConnectorConfig["tables"] = {}
  tables.include = hasTablesInclude
    ? (body.tablesInclude!.trim() ? body.tablesInclude!.split(",").map((s) => s.trim()).filter(Boolean) : [])
    : []
  tables.ignore = hasTablesIgnore
    ? (body.tablesIgnore!.trim() ? body.tablesIgnore!.split(",").map((s) => s.trim()).filter(Boolean) : [])
    : []
  tables.embed = hasTablesEmbed
    ? (body.tablesEmbed!.trim() ? body.tablesEmbed!.split(",").map((s) => s.trim()).filter(Boolean) : [])
    : []

  const tablesConfig =
    hasTablesInclude || hasTablesIgnore || hasTablesEmbed
      ? (Object.keys(tables).length ? tables : undefined)
      : existingConfig.tables

  const updatedConfig = {
    ...existingConfig,
    engine: body.engine as DatabaseEngine,
    host: body.host,
    port: body.port,
    database: body.database,
    schema: body.schema?.trim() || undefined,
    tables: tablesConfig,
    batchSize: body.batchSize,
    watermarkColumn: body.watermarkColumn?.trim() || undefined,
  } as Omit<DatabaseConnectorConfig, "auth">

  try {
    const updated = await updateConnector(db, connector.id, {
      name: body.name,
      config: updatedConfig as unknown as Record<string, unknown>,
    })

    Logger.info(`Updated database connector: ${body.connectorId}`)

    return c.json({
      success: true,
      id: updated.externalId,
      cId: updated.id,
    })
  } catch (err) {
    Logger.error({ err }, "Update database connector failed")
    throw new HTTPException(500, {
      message: "Failed to update database connector",
    })
  }
}

/**
 * Rotate database connector credentials.
 * Validates new credentials by testing connection before updating.
 */
export const RotateCredentialsApi = async (c: Context) => {
  const { sub: email, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
  if (!email) throw new HTTPException(401, { message: "Unauthorized" })

  const raw = await c.req.json()
  const body = rotateCredentialsSchema.parse(raw)

  const userWorkspace = await getUserAndWorkspaceByEmail(db, workspaceExternalId, email)
  if (!userWorkspace) throw new HTTPException(404, { message: "User or workspace not found" })

  const connector = await getDatabaseConnectorForUser(
    db,
    body.connectorId,
    userWorkspace.user.id,
    userWorkspace.workspace.id,
  )
  if (!connector) throw new HTTPException(404, { message: "Connector not found" })
  if (connector.type !== ConnectorType.Database) {
    throw new HTTPException(400, { message: "Connector is not a database connector" })
  }

  // Get connector config to test new credentials
  const config = connector.config as Record<string, unknown>
  
  // Build test config with new credentials
  const testConfig: DatabaseConnectorConfig = {
    engine: config.engine as DatabaseEngine,
    host: config.host as string,
    port: config.port as number,
    database: config.database as string,
    schema: config.schema as string | undefined,
    batchSize: config.batchSize as number ?? 1000,
    concurrency: config.concurrency as number ?? 2,
    cdcEnabled: config.cdcEnabled as boolean ?? false,
    auth: { username: body.newUsername, password: body.newPassword },
  }

  // Test the new credentials by attempting to connect
  const { createClient } = await import("@/integrations/database/client")
  const client = createClient(testConfig)
  
  try {
    await client.connect()
    await client.disconnect()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new HTTPException(400, {
      message: `Failed to connect with new credentials, please verify the username and password.`,
    })
  }

  // Update credentials
  const newCredentialsPayload: DatabaseCredentialsPayload = {
    kind: "database",
    username: body.newUsername,
    password: body.newPassword,
  }
  const credentialsStr = JSON.stringify(newCredentialsPayload)

  try {
    await updateConnector(db, connector.id, {
      credentials: credentialsStr,
    })

    Logger.info(`Rotated credentials for database connector: ${body.connectorId}`)

    return c.json({ success: true })
  } catch (err) {
    Logger.error({ err }, "Rotate database credentials failed")
    throw new HTTPException(500, {
      message: "Failed to update credentials",
    })
  }
}

/**
 * Sync an individual table from a database connector.
 * Uses the same sync flow as full DB sync (integrations/database syncTableToKb).
 */
export const SyncDatabaseTableApi = async (c: Context) => {
  const { sub: email, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
  if (!email) throw new HTTPException(401, { message: "Unauthorized" })

  const rawBody = await c.req.json()
  const { connectorId, tableName } = syncTableSchema.parse(rawBody)
  const userWorkspace = await getUserAndWorkspaceByEmail(db, workspaceExternalId, email)
  if (!userWorkspace) throw new HTTPException(404, { message: "User or workspace not found" })

  const connector = await getDatabaseConnectorForUser(
    db,
    connectorId,
    userWorkspace.user.id,
    userWorkspace.workspace.id,
  )
  if (!connector) throw new HTTPException(404, { message: "Connector not found" })
  const dbConfig = assertDatabaseConnectorConfig(connector)

  const kbContext: DatabaseSyncKbContext = {
    workspaceId: connector.workspaceId,
    workspaceExternalId: connector.workspaceExternalId,
    userId: connector.userId,
    userEmail: email,
    connectorName: connector.name,
    getOrCreateKbCollection: getOrCreateDatabaseConnectorKbCollectionId,
  }

  try {
    const result = await syncSingleTable(dbConfig, String(connector.id), tableName, kbContext)
    return c.json({
      success: true,
      tableName,
      rowsSynced: result.rowsSynced,
    })
  } catch (err) {
    if (err instanceof HTTPException) throw err
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("not found")) {
      throw new HTTPException(404, { message: msg })
    }
    if (msg.includes("primary key")) {
      throw new HTTPException(400, { message: msg })
    }
    Logger.error({ err, connectorId, tableName }, "Database table sync failed")
    throw new HTTPException(500, {
      message: "Failed to sync table",
    })
  }
}
