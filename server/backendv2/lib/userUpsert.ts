import { db } from "@/db/client"
import {
  createUser,
  getUserByEmail,
  getUserByEmailInsensitive,
  saveRefreshTokenToDB,
} from "@/db/user"
import { getWorkspaceByDomain, getWorkspaceByExternalId } from "@/db/workspace"
import { UserRole } from "@/shared/types"
import type { InternalAuthProvider } from "@/auth/keycloak"
import {
  generateAccessToken,
  generateRefreshToken,
} from "./tokens"

export class AuthError extends Error {
  public override readonly name = "AuthError"
  public readonly code: string
  public constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

type SessionUser = {
  email: string
  role: string
  workspaceExternalId: string
}

const generateSession = async (
  user: SessionUser,
  provider: InternalAuthProvider,
): Promise<{ accessToken: string; refreshToken: string }> => {
  const accessToken = await generateAccessToken(
    user.email,
    user.role,
    user.workspaceExternalId,
    provider,
  )
  const refreshToken = await generateRefreshToken(
    user.email,
    user.role,
    user.workspaceExternalId,
    provider,
  )
  await saveRefreshTokenToDB(db, user.email, refreshToken)
  return { accessToken, refreshToken }
}

// Google: find user by email, create with default role if missing and the
// workspace for the email's domain exists. Domain-less workspaces are not
// auto-created here — that's an admin action in xyne.
export const issueSessionForGoogle = async (params: {
  email: string
  name: string
  photoLink: string
  domain: string
}): Promise<{ accessToken: string; refreshToken: string }> => {
  const { email, name, photoLink, domain } = params

  const existing = await getUserByEmail(db, email)
  if (existing.length > 0) {
    const user = existing[0]!
    return generateSession(user, "google")
  }

  const workspaces = await getWorkspaceByDomain(domain)
  if (!workspaces || workspaces.length === 0) {
    throw new AuthError(
      "workspace_not_found",
      `No workspace exists for domain ${domain}. Ask an admin to create one in xyne first.`,
    )
  }
  const workspace = workspaces[0]!
  const [created] = await createUser(
    db,
    workspace.id,
    email,
    name,
    photoLink,
    UserRole.User,
    workspace.externalId,
  )
  if (!created) {
    throw new AuthError("user_create_failed", "Could not create user.")
  }
  return generateSession(created, "google")
}

// Keycloak: workspace is fixed via env (KEYCLOAK_WORKSPACE_EXTERNAL_ID).
// Mirror xyne's behavior — reject cross-workspace login.
export const issueSessionForKeycloak = async (params: {
  email: string
  name: string
  workspaceExternalId: string
}): Promise<{ accessToken: string; refreshToken: string }> => {
  const { email, name, workspaceExternalId } = params

  const existing = await getUserByEmailInsensitive(db, email)
  let user = existing[0]
  if (user) {
    if (user.workspaceExternalId !== workspaceExternalId) {
      throw new AuthError(
        "workspace_mismatch",
        "User belongs to a different workspace.",
      )
    }
  } else {
    const workspace = await getWorkspaceByExternalId(db, workspaceExternalId)
    if (!workspace) {
      throw new AuthError(
        "workspace_not_found",
        "Configured Keycloak workspace was not found.",
      )
    }
    const [created] = await createUser(
      db,
      workspace.id,
      email,
      name,
      "",
      UserRole.User,
      workspace.externalId,
    )
    if (!created) {
      throw new AuthError("user_create_failed", "Could not create user.")
    }
    user = created
  }

  return generateSession(user, "keycloak")
}
