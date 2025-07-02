import { and, eq, sql } from "drizzle-orm"
import { db } from "./client"
import {
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
} from "@/db/schema"
import type { PgTransaction } from "drizzle-orm/pg-core"
import { createId } from "@paralleldrive/cuid2"
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"
import type { TxnOrClient } from "@/types"
import { HTTPException } from "hono/http-exception"
import { Apps } from "@/search/types"
import type { UserRole } from "@/shared/types"

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
  syncJobs: Record<Apps, { lastSyncDate: Date | null; createdAt: Date | null }>
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
    })
    .returning()
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

// based on user email will perform the join on tables users and sync_jobs which will have same email
// then for each user we can have max 4 row 1 is for slack other is for google-drive , gmail, google-calendar
// then we will get the last_ran_on and the user data to frontend
export const getAllUsers = async (
  trx: TxnOrClient,
): Promise<UserWithSyncJobs[]> => {
  // Select users and their latest sync job date for each app type, and sync job creation time
  const usersWithSyncJobs = await trx
    .select({
      // Select user fields
      id: users.id,
      email: users.email,
      name: users.name,
      photoLink: users.photoLink,
      createdAt: users.createdAt,
      role: users.role,
      // Select sync job app, its latest lastRanOn, and createdAt for this user/app combination
      syncApp: syncJobs.app,
      lastSyncDate: sql<Date>`max(${syncJobs.lastRanOn})`.as("lastSyncDate"),
      syncCreatedAt: sql<Date>`max(${syncJobs.createdAt})`.as("syncCreatedAt"),
    })
    .from(users)
    .leftJoin(syncJobs, eq(users.email, syncJobs.email))
    .groupBy(users.id, users.email, syncJobs.app)
    .execute()

  // Process the flat result to create the nested structure
  const usersMap = new Map<string, UserWithSyncJobs>()

  for (const row of usersWithSyncJobs) {
    const userEmail = row.email
    if (!usersMap.has(userEmail)) {
      // Initialize user entry
      const userEntry: UserWithSyncJobs = {
        id: row.id,
        email: row.email,
        name: row.name,
        photoLink: row.photoLink,
        role: row.role,
        createdAt: row.createdAt,
        syncJobs: {} as Record<
          Apps,
          { lastSyncDate: Date | null; createdAt: Date | null }
        >,
      }
      // Initialize syncJobs for all Apps to null values
      Object.values(Apps).forEach((app) => {
        userEntry.syncJobs[app] = { lastSyncDate: null, createdAt: null }
      })
      usersMap.set(userEmail, userEntry)
    }

    // Add the latest sync date and creation time for the specific app
    const userEntry = usersMap.get(userEmail)!
    if (row.syncApp && Object.values(Apps).includes(row.syncApp as Apps)) {
      userEntry.syncJobs[row.syncApp as Apps] = {
        lastSyncDate: row.lastSyncDate,
        createdAt: row.syncCreatedAt,
      }
    }
  }

  // Convert the map values back to an array and return directly
  const result = Array.from(usersMap.values())
  return result
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
