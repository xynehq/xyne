import React from "react"

import { UserRole } from "shared/types"

// This type should ideally match the user object from your authentication context.
// We define a minimal version of it here for prop validation.
type AuthUser = {
  role: UserRole
}

type RoleGuardProps = {
  user: AuthUser | null | undefined
  allowedRoles: UserRole[]
  children: React.ReactNode
}

/**
 * A component that renders its children only if the provided user's role
 * is included in the list of allowed roles.
 *
 * @example
 * <RoleGuard user={currentUser} allowedRoles={[UserRole.SuperAdmin]}>
 *   <AdminDashboard />
 * </RoleGuard>
 *
 * @param {AuthUser | null | undefined} user The user object from an auth context.
 * @param {UserRole[]} allowedRoles An array of roles permitted to see the content.
 * @param {React.ReactNode} children The content to render if the user is authorized.
 */
export const RoleGuard: React.FC<RoleGuardProps> = ({
  user,
  allowedRoles,
  children,
}) => {
  // Do not render if there is no user or if the roles list is empty.
  if (!user || allowedRoles.length === 0) {
    return null
  }

  const isAuthorized = allowedRoles.includes(user.role)

  return isAuthorized ? <>{children}</> : null
}
