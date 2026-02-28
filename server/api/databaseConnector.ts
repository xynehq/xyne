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
function assertDatabaseConnectorConfig(connector: {
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
        message: "Internal server error",
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
  return c.json({ tables })
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
        message: "Internal server error",
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
  port: z.number().int().positive().default(5432),
  database: z.string().min(1, "Database is required"),
  schema: z.string().optional(),
  username: z.string().min(1, "Username is required"),
  password: z.string().optional(), // Optional on update - if not provided, keep existing
  tablesInclude: z.string().optional(),
  tablesIgnore: z.string().optional(),
  watermarkColumn: z.string().optional(),
  batchSize: z.number().int().positive().default(1000),
})

export type UpdateDatabaseConnector = z.infer<
  typeof updateDatabaseConnectorSchema
>

/**
 * Update a database connector's configuration.
 * Allows updating connection details, credentials, and sync settings.
 * If password is not provided, the existing password is retained.
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

  const tables: DatabaseConnectorConfig["tables"] = {}
  if (hasTablesInclude) {
    tables.include = body.tablesInclude!.trim()
      ? body.tablesInclude!.split(",").map((s) => s.trim()).filter(Boolean)
      : []
  }
  if (hasTablesIgnore) {
    tables.ignore = body.tablesIgnore!.trim()
      ? body.tablesIgnore!.split(",").map((s) => s.trim()).filter(Boolean)
      : []
  }

  const existingConfig = connector.config as Record<string, unknown>

  // Only update tables if either tablesInclude or tablesIgnore was provided
  const tablesConfig = (hasTablesInclude || hasTablesIgnore)
    ? (Object.keys(tables).length ? tables : undefined)
    : (undefined)

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

  // Handle credentials - if password is provided, update; otherwise keep existing
  let credentialsStr: string
  if (body.password) {
    const credentialsPayload: DatabaseCredentialsPayload = {
      kind: "database",
      username: body.username,
      password: body.password,
    }
    credentialsStr = JSON.stringify(credentialsPayload)
  } else {
    // Keep existing credentials but update username if changed
    if (!connector.credentials?.trim()) {
      throw new HTTPException(400, { message: "Database connector missing credentials" })
    }
    let existingCreds: DatabaseCredentialsPayload
    try {
      existingCreds = JSON.parse(connector.credentials) as DatabaseCredentialsPayload
    } catch {
      throw new HTTPException(400, { message: "Invalid database connector credentials" })
    }
    const credentialsPayload: DatabaseCredentialsPayload = {
      kind: "database",
      username: body.username,
      password: existingCreds.password,
    }
    credentialsStr = JSON.stringify(credentialsPayload)
  }

  try {
    const updated = await updateConnector(db, connector.id, {
      name: body.name,
      config: updatedConfig as unknown as Record<string, unknown>,
      credentials: credentialsStr,
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
      message: "Internal server error",
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
      message: "Internal server error",
    })
  }
}
