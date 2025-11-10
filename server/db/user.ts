import { and, eq, isNull, sql } from "drizzle-orm"
import { db } from "./client"
import {
  apiKeys,
  selectUserSchema,
  selectWorkspaceSchema,
  userPublicSchema,
  users,
  workspacePublicSchema,
  workspaces,
  type InternalUserWorkspace,
  type PublicUserWorkspace,
  type SelectUser,
  syncJobs,
  connectors,
  type UserMetadata,
  userMetadataSchema,
} from "@/db/schema"
import type { PgTransaction } from "drizzle-orm/pg-core"
import { createId } from "@paralleldrive/cuid2"
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"
import type { TxnOrClient } from "@/types"
import { HTTPException } from "hono/http-exception"
import { Apps, type UserRole } from "@/shared/types"
import crypto from "crypto"
import { NoUserFound } from "@/errors"

// Define an interface for the shape of data after processing and before Zod parsing
interface ProcessedUser
  extends Omit<
    SelectUser,
    | "workspaceId"
    | "externalId"
    | "workspaceExternalId"
    | "updatedAt"
    | "deletedAt"
    | "lastLogin"
  > {
  syncJobs: Record<Apps, Date | null | undefined>
}

// Define an interface for the return type of getAllUsers
interface UserWithSyncJobs {
  id: number
  email: string
  name: string
  photoLink: string | null
  role: string
  createdAt: Date
  syncJobs: Record<
    Apps,
    {
      lastSyncDate: Date | null
      createdAt: Date | null
      connectorStatus?: string | null
    }
  >
}
interface NonUsersWithSyncJobs {
  id: number
  email: string
  syncJobs: Record<
    Apps,
    {
      lastSyncDate: Date | null
      createdAt: Date | null
      connectorStatus?: string | null
    }
  >
}

export const getPublicUserAndWorkspaceByEmail = async (
  trx: TxnOrClient,
  workspaceId: string,
  email: string,
): Promise<PublicUserWorkspace> => {
  const userAndWorkspace = await trx
    .select({
      user: users,
      workspace: workspaces,
    })
    .from(users)
    .innerJoin(workspaces, eq(users.workspaceId, workspaces.id)) // Join workspaces on users.workspaceId
    .where(
      and(
        eq(users.email, email), // Filter by user email
        eq(users.workspaceExternalId, workspaceId), // Filter by workspaceId
      ),
    )
    .limit(1)
  if (!userAndWorkspace || userAndWorkspace.length === 0) {
    throw new HTTPException(404, { message: "User or Workspace not found" })
  }

  const { user, workspace } = userAndWorkspace[0]
  const userPublic = userPublicSchema.parse(user)
  const workspacePublic = workspacePublicSchema.parse(workspace)

  return { user: userPublic, workspace: workspacePublic }
}

export const getUserAndWorkspaceByEmail = async (
  trx: TxnOrClient,
  workspaceId: string,
  email: string,
): Promise<InternalUserWorkspace> => {
  const userAndWorkspace = await trx
    .select({
      user: users,
      workspace: workspaces,
    })
    .from(users)
    .innerJoin(workspaces, eq(users.workspaceId, workspaces.id)) // Join workspaces on users.workspaceId
    .where(
      and(
        eq(users.email, email), // Filter by user email
        eq(users.workspaceExternalId, workspaceId), // Filter by workspaceId
      ),
    )
    .limit(1)
  if (!userAndWorkspace || userAndWorkspace.length === 0) {
    throw new HTTPException(404, { message: "User or Workspace not found" })
  }

  const { user, workspace } = userAndWorkspace[0]

  return { user, workspace }
}

export const getUserAndWorkspaceByOnlyEmail = async (
  trx: PgTransaction<any>,
  email: string,
) => {
  return await trx
    .select({
      user: users,
      workspace: workspaces,
    })
    .from(users)
    .innerJoin(workspaces, eq(users.workspaceId, workspaces.id)) // Join workspaces on users.workspaceId
    .where(
      and(
        eq(users.email, email), // Filter by user email
      ),
    )
    .limit(1)
}

// since email is unique across the users we don't need workspaceId
export const getUserByEmail = async (
  trx: TxnOrClient,
  email: string,
): Promise<SelectUser[]> => {
  return await trx
    .select()
    .from(users)
    .where(and(eq(users.email, email)))
    .limit(1)
}

export const createUser = async (
  trx: TxnOrClient,
  workspaceId: number,
  email: string,
  name: string,
  photoLink: string,
  // accessToken: string,
  // refreshToken: string,
  role: string,
  workspaceExternalId: string,
) => {
  const externalId = createId()
  return await trx
    .insert(users)
    .values({
      externalId,
      workspaceId,
      email,
      name,
      photoLink,
      workspaceExternalId,
      // googleAccessToken: accessToken,
      // googleRefreshToken: refreshToken,
      lastLogin: new Date(),
      role,
      refreshToken: "",
    })
    .returning()
}

export const saveRefreshTokenToDB = async (
  trx: TxnOrClient,
  email: string,
  refreshToken: string,
) => {
  const updatedUser = await trx
    .update(users)
    .set({
      refreshToken,
    })
    .where(eq(users.email, email))
    .returning()
  return selectUserSchema.parse(updatedUser[0])
}

export const deleteRefreshTokenFromDB = async (
  trx: TxnOrClient,
  email: string,
) => {
  const updatedUser = await trx
    .update(users)
    .set({
      refreshToken: "",
    })
    .where(eq(users.email, email))
    .returning()
  return selectUserSchema.parse(updatedUser[0])
}

export const getUserById = async (
  trx: TxnOrClient,
  userId: number,
): Promise<SelectUser> => {
  const resp = await trx.select().from(users).where(eq(users.id, userId))
  if (!resp || !resp.length) {
    throw new Error("Could not get User by Id")
  }
  const parsedRes = selectUserSchema.safeParse(resp[0])
  if (!parsedRes.success) {
    throw new Error(`Could not parse user: ${parsedRes.error.toString()}`)
  }
  return parsedRes.data
}

export const getUserMetaData = async(
  trx: TxnOrClient,
  userId: number
): Promise<UserMetadata> => {
  const user = await getUserById(
    trx,
    userId
  )
  return userMetadataSchema.parse(user)
}

export const getUsersByWorkspace = async (
  trx: TxnOrClient,
  workspaceExternalId: string,
  externalId?: string,
): Promise<SelectUser[]> => {
  const conditions = [
    eq(users.workspaceExternalId, workspaceExternalId),
    isNull(users.deletedAt),
  ]

  // Add external ID filter if provided
  if (externalId) {
    conditions.push(eq(users.externalId, externalId))
  }

  const resp = await trx
    .select()
    .from(users)
    .where(and(...conditions))

  return resp.map((user) => {
    const parsedRes = selectUserSchema.safeParse(user)
    if (!parsedRes.success) {
      throw new Error(`Could not parse user: ${parsedRes.error.toString()}`)
    }
    return parsedRes.data
  })
}
// based on user email will perform the join on tables users and sync_jobs which will have same email
// then for each user we can have max 4 row 1 is for slack other is for google-drive , gmail, google-calendar
// then we will get the last_ran_on and the user data to frontend
export const getAllLoggedInUsers = async (
  trx: TxnOrClient,
  workspaceId: string,
): Promise<UserWithSyncJobs[]> => {
  const usersWithSyncJobs = await trx
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      photoLink: users.photoLink,
      createdAt: users.createdAt,
      role: users.role,
      syncApp: syncJobs.app,
      lastSyncDate: sql<Date>`max(${syncJobs.lastRanOn})`.as("lastSyncDate"),
      syncCreatedAt: sql<Date>`max(${syncJobs.createdAt})`.as("syncCreatedAt"),
      connectorStatus: sql<string | null>`
        CASE 
          WHEN ${syncJobs.app} = 'slack' THEN max(${connectors.status}) 
          ELSE NULL 
        END
      `.as("connectorStatus"),
      slackConnectorStatus: sql<string | null>`
        max(CASE WHEN ${connectors.app} = 'slack' THEN ${connectors.status} ELSE NULL END)
      `.as("slackConnectorStatus"),
    })
    .from(users)
    .where(eq(users.workspaceExternalId, workspaceId))
    .leftJoin(syncJobs, eq(users.email, syncJobs.email))
    .leftJoin(connectors, eq(users.id, connectors.userId))
    .groupBy(users.id, users.email, syncJobs.app)
    .execute()

  const usersMap = new Map<string, UserWithSyncJobs>()

  for (const row of usersWithSyncJobs) {
    const userEmail = row.email
    if (!usersMap.has(userEmail)) {
      const userEntry: UserWithSyncJobs = {
        id: row.id,
        email: row.email,
        name: row.name,
        photoLink: row.photoLink,
        role: row.role,
        createdAt: row.createdAt,
        syncJobs: {} as Record<
          Apps,
          {
            lastSyncDate: Date | null
            createdAt: Date | null
            connectorStatus?: string | null
          }
        >,
      }
      Object.values(Apps).forEach((app) => {
        userEntry.syncJobs[app] = { lastSyncDate: null, createdAt: null }
      })
      usersMap.set(userEmail, userEntry)
    }

    const userEntry = usersMap.get(userEmail)!
    if (row.syncApp && Object.values(Apps).includes(row.syncApp as Apps)) {
      if (row.syncApp === Apps.Slack) {
        userEntry.syncJobs[row.syncApp as Apps] = {
          lastSyncDate: row.lastSyncDate,
          createdAt: row.syncCreatedAt,
          connectorStatus: row.connectorStatus,
        }
      } else {
        userEntry.syncJobs[row.syncApp as Apps] = {
          lastSyncDate: row.lastSyncDate,
          createdAt: row.syncCreatedAt,
        }
      }
    }

    // If user does not have a Slack syncJob but has a Slack connector, set connectorStatus for Slack
    if (
      (!row.syncApp || row.syncApp !== Apps.Slack) &&
      row.slackConnectorStatus
    ) {
      userEntry.syncJobs[Apps.Slack] = {
        lastSyncDate: null,
        createdAt: null,
        connectorStatus: row.slackConnectorStatus,
      }
    }
  }

  const result = Array.from(usersMap.values())
  return result
}

export const getAllIngestedUsers = async (
  trx: TxnOrClient,
  workspaceId: string,
): Promise<NonUsersWithSyncJobs[]> => {
  // Get all sync jobs for emails that don't have corresponding users
  const ingestedUsersWithSyncJobs = await trx
    .select({
      email: syncJobs.email,
      syncApp: syncJobs.app,
      lastSyncDate: sql<Date>`max(${syncJobs.lastRanOn})`.as("lastSyncDate"),
      syncCreatedAt: sql<Date>`max(${syncJobs.createdAt})`.as("syncCreatedAt"),
      connectorStatus: sql<string | null>`NULL`.as("connectorStatus"), // No connectors for non-users
    })
    .from(syncJobs)
    .where(eq(syncJobs.workspaceExternalId, workspaceId))
    .groupBy(syncJobs.email, syncJobs.app)
    .execute()

  // Process ingested users with sync jobs
  const ingestedUsersMap = new Map<string, NonUsersWithSyncJobs>()
  let ingestedUserIdCounter = 1 // Temporary ID for ingested users

  for (const row of ingestedUsersWithSyncJobs) {
    const userEmail = row.email
    if (!ingestedUsersMap.has(userEmail)) {
      const ingestedUserEntry: NonUsersWithSyncJobs = {
        id: ingestedUserIdCounter++, // Assign temporary ID
        email: row.email,
        syncJobs: {} as Record<
          Apps,
          {
            lastSyncDate: Date | null
            createdAt: Date | null
            connectorStatus?: string | null
          }
        >,
      }
      Object.values(Apps).forEach((app) => {
        ingestedUserEntry.syncJobs[app] = {
          lastSyncDate: null,
          createdAt: null,
        }
      })
      ingestedUsersMap.set(userEmail, ingestedUserEntry)
    }

    const ingestedUserEntry = ingestedUsersMap.get(userEmail)!
    if (row.syncApp && Object.values(Apps).includes(row.syncApp as Apps)) {
      ingestedUserEntry.syncJobs[row.syncApp as Apps] = {
        lastSyncDate: row.lastSyncDate,
        createdAt: row.syncCreatedAt,
        connectorStatus: row.connectorStatus,
      }
    }
  }

  return Array.from(ingestedUsersMap.values())
}

export const updateUser = async (
  trx: TxnOrClient,
  userId: number,
  role: UserRole,
) => {
  const result = await trx
    .update(users)
    .set({ role })
    .where(eq(users.id, userId))

  if (result.rowCount === 0) {
    throw new Error("User not Found")
  }

  return { success: true, message: "User role updated successfully" }
}

export const updateUserTimezone = async (
  trx: TxnOrClient,
  email: string,
  timeZone: string,
) => {
  try {
    // Validate input parameters
    if (!email?.trim()) {
      throw new HTTPException(400, { message: "Email is required" })
    }
    if (!timeZone?.trim()) {
      throw new HTTPException(400, { message: "TimeZone is required" })
    }

    const result = await trx
      .update(users)
      .set({
        timeZone,
        updatedAt: new Date(),
      })
      .where(eq(users.email, email))
      .returning({ id: users.id, email: users.email, timeZone: users.timeZone })

    if (!result || result.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }

    return {
      success: true,
      message: "User timezone updated successfully",
      user: result[0],
    }
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, {
      message: "Failed to update user timezone",
      cause: error instanceof Error ? error.message : "Unknown error",
    })
  }
}

export const getUserFromJWT = async (
  db: TxnOrClient,
  jwtPayload: { sub: string; workspaceId: string }
): Promise<SelectUser> => {
  const email = jwtPayload.sub
  const userRes = await getUserByEmail(db, email)
  
  if (!userRes?.length) {
    throw new NoUserFound({ message: `User with email ${email} not found.` })
  }
  
  return userRes[0]
}

export async function createUserApiKey({
  db,
  userId,
  workspaceId,
  name,
  scope,
}: {
  db: TxnOrClient
  userId: string
  workspaceId: string
  name: string
  scope: any
}): Promise<{
  success: boolean
  key?: string
  apiKey?: any
  error?: string
}> {
  try {
    // Generate random MD5 hash
    const md5Hash = crypto.randomBytes(16).toString("hex")

    // Extract first 4 characters for display
    const keyPrefix = md5Hash.substring(0, 4)

    // Store encrypted API key in database
    const [inserted] = await db
      .insert(apiKeys)
      .values({
        userId,
        name,
        workspaceId,
        key: md5Hash,
        keyPrefix: keyPrefix,
        config: scope,
      })
      .returning()

    const config = (inserted.config as any) || {}
    return {
      success: true,
      key: md5Hash,
      apiKey: {
        id: inserted.id.toString(),
        name: inserted.name,
        key: md5Hash,
        keyPrefix: keyPrefix,
        scopes: config.scopes || [],
        agents: config.agents || [],
        createdAt: inserted.createdAt.toISOString(),
      },
    }
  } catch (err) {
    console.error("[createAgentApiKey] Error:", err)
    return {
      success: false,
      error: `Database error while creating API key - ${err}`,
    }
  }
}
