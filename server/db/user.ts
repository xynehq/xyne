import { and, eq } from "drizzle-orm"
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
} from "@/db/schema"
import type { PgTransaction } from "drizzle-orm/pg-core"
import { createId } from "@paralleldrive/cuid2"
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"
import type { TxnOrClient } from "@/types"
import { HTTPException } from "hono/http-exception"
import { hashPassword, verifyPassword } from "@/utils/password"

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
  password?: string,
) => {
  const externalId = createId()
  
  // Hash password if provided (for email/password users)
  let hashedPassword: string | undefined = undefined
  if (password && password.trim() !== "") {
    hashedPassword = await hashPassword(password)
  }
  
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
      password: hashedPassword,
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

/**
 * Verify user password for email/password authentication
 * @param trx - Database transaction or client
 * @param email - User email
 * @param password - Plaintext password to verify
 * @returns Promise<SelectUser | null> - User if password is correct, null otherwise
 */
export const verifyUserPassword = async (
  trx: TxnOrClient,
  email: string,
  password: string,
): Promise<SelectUser | null> => {
  try {
    // Get user with password
    const userResult = await trx
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
    
    if (!userResult || userResult.length === 0) {
      return null // User not found
    }
    
    const user = userResult[0]
    
    // Check if user has a password set (OAuth users might not have passwords)
    if (!user.password) {
      return null // User doesn't have password authentication enabled
    }
    
    // Verify password
    const isPasswordValid = await verifyPassword(password, user.password)
    
    if (!isPasswordValid) {
      return null // Invalid password
    }
    
    return user
  } catch (error) {
    throw new Error(`Password verification failed: ${error}`)
  }
}

/**
 * Update user password (for password reset functionality)
 * @param trx - Database transaction or client
 * @param email - User email
 * @param newPassword - New plaintext password
 * @returns Promise<void>
 */
export const updateUserPassword = async (
  trx: TxnOrClient,
  email: string,
  newPassword: string,
): Promise<void> => {
  const hashedPassword = await hashPassword(newPassword)
  
  await trx
    .update(users)
    .set({ password: hashedPassword })
    .where(eq(users.email, email))
}
