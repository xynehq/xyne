import { createId } from "@paralleldrive/cuid2"
import { and, eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { users } from "@/db/schema/users"
import { workspaces } from "@/db/schema/workspaces"
import { UserRole } from "@/shared/types"

type KeycloakRealmRepresentation = {
  realm: string
  enabled?: boolean
  [key: string]: unknown
}

type KeycloakClientRepresentation = {
  id?: string
  clientId?: string
  enabled?: boolean
  protocol?: string
  publicClient?: boolean
  bearerOnly?: boolean
  standardFlowEnabled?: boolean
  implicitFlowEnabled?: boolean
  directAccessGrantsEnabled?: boolean
  serviceAccountsEnabled?: boolean
  clientAuthenticatorType?: string
  redirectUris?: string[]
  webOrigins?: string[]
  rootUrl?: string
  baseUrl?: string
  secret?: string
  attributes?: Record<string, string>
  [key: string]: unknown
}

type KeycloakUserRepresentation = {
  id?: string
  username?: string
  email?: string
  enabled?: boolean
  firstName?: string
  lastName?: string
  [key: string]: unknown
}

type KeycloakRoleRepresentation = {
  id?: string
  name: string
  [key: string]: unknown
}

type BootstrapConfig = {
  keycloakInternalBaseUrl: string
  keycloakAdmin: string
  keycloakAdminPassword: string
  realm: string
  clientId: string
  clientSecret: string
  workspaceExternalId: string
  bootstrapEmail: string
  bootstrapName: string
  bootstrapPassword: string
  workspaceName: string
  workspaceDomain: string
  resetAdminPassword: boolean
  appHost: string
  redirectUri: string
  postLogoutRedirectUris: string[]
  databaseUrl: string
}

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "")

const buildUrl = (baseUrl: string, path: string) =>
  `${trimTrailingSlash(baseUrl)}${path}`

const requiredEnv = (name: string, fallback?: string): string => {
  const value = process.env[name]?.trim() || fallback
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

const booleanEnv = (name: string, defaultValue: boolean) => {
  const value = process.env[name]?.trim()
  if (value === undefined || value === "") {
    return defaultValue
  }
  return value === "true"
}

const uniqueValues = (values: string[]) => Array.from(new Set(values))

const getBootstrapConfig = (): BootstrapConfig => {
  const keycloakPort = process.env.KEYCLOAK_PORT?.trim() || "8082"
  const keycloakPublicBaseUrl = requiredEnv(
    "KEYCLOAK_PUBLIC_BASE_URL",
    `http://localhost:${keycloakPort}`,
  )
  const keycloakInternalBaseUrl = requiredEnv(
    "KEYCLOAK_INTERNAL_BASE_URL",
    keycloakPublicBaseUrl,
  )
  const appHost = trimTrailingSlash(
    requiredEnv("HOST", "http://localhost:3000"),
  )
  const logoutRedirectUrl =
    process.env.KEYCLOAK_LOGOUT_REDIRECT_URL?.trim() || "/auth"
  const postLogoutRedirectUris = uniqueValues([
    new URL(logoutRedirectUrl, `${appHost}/`).toString(),
    ...(process.env.NODE_ENV === "production"
      ? []
      : [new URL(logoutRedirectUrl, "http://localhost:5173/").toString()]),
  ])

  return {
    keycloakInternalBaseUrl,
    keycloakAdmin: requiredEnv("KEYCLOAK_ADMIN", "admin"),
    keycloakAdminPassword: requiredEnv("KEYCLOAK_ADMIN_PASSWORD", "admin"),
    realm: requiredEnv("KEYCLOAK_REALM", "xyne-shared"),
    clientId: requiredEnv("KEYCLOAK_CLIENT_ID", "xyne-web"),
    clientSecret: requiredEnv("KEYCLOAK_CLIENT_SECRET"),
    workspaceExternalId: requiredEnv(
      "KEYCLOAK_WORKSPACE_EXTERNAL_ID",
      "xyne-shared-workspace",
    ),
    bootstrapEmail: requiredEnv(
      "XYNE_BOOTSTRAP_ADMIN_EMAIL",
      "admin@xyne.local",
    ).toLowerCase(),
    bootstrapName: requiredEnv("XYNE_BOOTSTRAP_ADMIN_NAME", "Xyne Admin"),
    bootstrapPassword: requiredEnv("XYNE_BOOTSTRAP_ADMIN_PASSWORD"),
    workspaceName: requiredEnv("XYNE_BOOTSTRAP_WORKSPACE_NAME", "Xyne Shared"),
    workspaceDomain: requiredEnv(
      "XYNE_BOOTSTRAP_WORKSPACE_DOMAIN",
      "xyne.local",
    ),
    resetAdminPassword: booleanEnv(
      "KEYCLOAK_BOOTSTRAP_RESET_ADMIN_PASSWORD",
      false,
    ),
    appHost,
    redirectUri: new URL(
      "/v1/auth/keycloak/callback",
      `${appHost}/`,
    ).toString(),
    postLogoutRedirectUris,
    databaseUrl:
      process.env.DATABASE_URL ||
      `postgres://xyne:xyne@${process.env.DATABASE_HOST || "localhost"}:5432/xyne`,
  }
}

class KeycloakAdminClient {
  private accessToken = ""

  constructor(private readonly config: BootstrapConfig) {}

  async authenticate() {
    const tokenUrl = buildUrl(
      this.config.keycloakInternalBaseUrl,
      "/realms/master/protocol/openid-connect/token",
    )
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: this.config.keycloakAdmin,
        password: this.config.keycloakAdminPassword,
      }),
    })

    if (!response.ok) {
      throw new Error(
        `Failed to authenticate to Keycloak Admin API: ${response.status} ${await response.text()}`,
      )
    }

    const data = (await response.json()) as { access_token?: string }
    if (!data.access_token) {
      throw new Error(
        "Keycloak Admin API token response did not include access_token",
      )
    }
    this.accessToken = data.access_token
  }

  async get<T>(path: string): Promise<T | null> {
    const response = await this.request(path, { method: "GET" })
    if (response.status === 404) {
      return null
    }
    await this.assertOk(response, path)
    return (await response.json()) as T
  }

  async post<T>(path: string, body: unknown): Promise<T | null> {
    const response = await this.request(path, {
      method: "POST",
      body: JSON.stringify(body),
    })
    await this.assertOk(response, path, [200, 201, 204])
    if (response.status === 204) {
      return null
    }
    const contentType = response.headers.get("content-type")
    if (!contentType?.includes("application/json")) {
      return null
    }
    return (await response.json()) as T
  }

  async put(path: string, body: unknown) {
    const response = await this.request(path, {
      method: "PUT",
      body: JSON.stringify(body),
    })
    await this.assertOk(response, path, [200, 204])
  }

  private request(path: string, init: RequestInit) {
    return fetch(buildUrl(this.config.keycloakInternalBaseUrl, path), {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
        ...init.headers,
      },
    })
  }

  private async assertOk(response: Response, path: string, okStatuses = [200]) {
    if (okStatuses.includes(response.status)) {
      return
    }

    throw new Error(
      `Keycloak Admin API request failed for ${path}: ${response.status} ${await response.text()}`,
    )
  }
}

const realmPath = (realm: string) =>
  `/admin/realms/${encodeURIComponent(realm)}`

const realmResourcePath = (realm: string, resource: string) =>
  `${realmPath(realm)}${resource}`

const ensureRealm = async (
  keycloak: KeycloakAdminClient,
  config: BootstrapConfig,
) => {
  const existingRealm = await keycloak.get<KeycloakRealmRepresentation>(
    realmPath(config.realm),
  )

  if (!existingRealm) {
    await keycloak.post("/admin/realms", {
      realm: config.realm,
      enabled: true,
    })
    console.log(`Created Keycloak realm ${config.realm}`)
    return
  }

  if (existingRealm.enabled !== true) {
    await keycloak.put(realmPath(config.realm), {
      ...existingRealm,
      enabled: true,
    })
    console.log(`Enabled Keycloak realm ${config.realm}`)
  } else {
    console.log(`Keycloak realm ${config.realm} already exists`)
  }
}

const getClientByClientId = async (
  keycloak: KeycloakAdminClient,
  realm: string,
  clientId: string,
) => {
  const clients = await keycloak.get<KeycloakClientRepresentation[]>(
    realmResourcePath(
      realm,
      `/clients?clientId=${encodeURIComponent(clientId)}`,
    ),
  )
  return clients?.find((client) => client.clientId === clientId) || null
}

const getClientOrThrow = async (
  keycloak: KeycloakAdminClient,
  realm: string,
  clientId: string,
) => {
  const client = await getClientByClientId(keycloak, realm, clientId)
  if (!client?.id) {
    throw new Error(
      `Keycloak client ${clientId} was not found in realm ${realm}`,
    )
  }
  return client
}

const ensureClient = async (
  keycloak: KeycloakAdminClient,
  config: BootstrapConfig,
) => {
  const desiredClient: KeycloakClientRepresentation = {
    clientId: config.clientId,
    enabled: true,
    protocol: "openid-connect",
    publicClient: false,
    bearerOnly: false,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    clientAuthenticatorType: "client-secret",
    redirectUris: [config.redirectUri],
    webOrigins: [config.appHost],
    rootUrl: config.appHost,
    baseUrl: config.appHost,
    secret: config.clientSecret,
    attributes: {
      "pkce.code.challenge.method": "S256",
      "post.logout.redirect.uris": config.postLogoutRedirectUris.join("##"),
    },
  }

  const existingClient = await getClientByClientId(
    keycloak,
    config.realm,
    config.clientId,
  )

  if (!existingClient) {
    await keycloak.post(
      realmResourcePath(config.realm, "/clients"),
      desiredClient,
    )
    console.log(`Created Keycloak client ${config.clientId}`)
  } else {
    await keycloak.put(
      realmResourcePath(config.realm, `/clients/${existingClient.id}`),
      {
        ...existingClient,
        ...desiredClient,
        attributes: {
          ...(existingClient.attributes || {}),
          ...desiredClient.attributes,
        },
      },
    )
    console.log(`Updated Keycloak client ${config.clientId}`)
  }
}

const getUserByEmail = async (
  keycloak: KeycloakAdminClient,
  realm: string,
  email: string,
) => {
  const usersByUsername = await keycloak.get<KeycloakUserRepresentation[]>(
    realmResourcePath(
      realm,
      `/users?username=${encodeURIComponent(email)}&exact=true`,
    ),
  )
  const usernameMatch = usersByUsername?.find(
    (user) => user.username?.toLowerCase() === email.toLowerCase(),
  )
  if (usernameMatch) {
    return usernameMatch
  }

  const usersByEmail = await keycloak.get<KeycloakUserRepresentation[]>(
    realmResourcePath(
      realm,
      `/users?email=${encodeURIComponent(email)}&exact=true`,
    ),
  )
  return (
    usersByEmail?.find(
      (user) => user.email?.toLowerCase() === email.toLowerCase(),
    ) || null
  )
}

const resetUserPassword = async (
  keycloak: KeycloakAdminClient,
  realm: string,
  userId: string,
  password: string,
) => {
  await keycloak.put(
    realmResourcePath(realm, `/users/${userId}/reset-password`),
    {
      type: "password",
      value: password,
      temporary: false,
    },
  )
}

const ensureKeycloakBootstrapUser = async (
  keycloak: KeycloakAdminClient,
  config: BootstrapConfig,
) => {
  let user = await getUserByEmail(keycloak, config.realm, config.bootstrapEmail)

  const [firstName, ...restName] = config.bootstrapName.split(" ")
  const lastName = restName.join(" ")

  if (!user) {
    await keycloak.post(realmResourcePath(config.realm, "/users"), {
      username: config.bootstrapEmail,
      email: config.bootstrapEmail,
      enabled: true,
      firstName: firstName || config.bootstrapName,
      lastName,
    })
    user = await getUserByEmail(keycloak, config.realm, config.bootstrapEmail)
    if (!user?.id) {
      throw new Error(
        `Created Keycloak user ${config.bootstrapEmail}, but could not read it back`,
      )
    }
    await resetUserPassword(
      keycloak,
      config.realm,
      user.id,
      config.bootstrapPassword,
    )
    console.log(`Created Keycloak bootstrap user ${config.bootstrapEmail}`)
  } else {
    if (!user.id) {
      throw new Error(
        `Keycloak user ${config.bootstrapEmail} did not include id`,
      )
    }

    await keycloak.put(realmResourcePath(config.realm, `/users/${user.id}`), {
      ...user,
      enabled: true,
      email: config.bootstrapEmail,
      username: user.username || config.bootstrapEmail,
      firstName: firstName || config.bootstrapName,
      lastName,
    })

    if (config.resetAdminPassword) {
      await resetUserPassword(
        keycloak,
        config.realm,
        user.id,
        config.bootstrapPassword,
      )
      console.log(
        `Reset Keycloak bootstrap user password for ${config.bootstrapEmail}`,
      )
    } else {
      console.log(
        `Keycloak bootstrap user ${config.bootstrapEmail} already exists; password unchanged`,
      )
    }
  }

  if (!user?.id) {
    throw new Error(`Keycloak user ${config.bootstrapEmail} did not include id`)
  }
  return user.id
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const getClientWithRetry = async (
  keycloak: KeycloakAdminClient,
  realm: string,
  clientId: string,
) => {
  let lastError: unknown
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      return await getClientOrThrow(keycloak, realm, clientId)
    } catch (error) {
      lastError = error
      await sleep(500)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

const ensureRealmAdminRole = async (
  keycloak: KeycloakAdminClient,
  config: BootstrapConfig,
  userId: string,
) => {
  const realmManagementClient = await getClientWithRetry(
    keycloak,
    config.realm,
    "realm-management",
  )

  const role = await keycloak.get<KeycloakRoleRepresentation>(
    realmResourcePath(
      config.realm,
      `/clients/${realmManagementClient.id}/roles/realm-admin`,
    ),
  )
  if (!role) {
    throw new Error("Could not find realm-management realm-admin role")
  }

  const existingRoles = await keycloak.get<KeycloakRoleRepresentation[]>(
    realmResourcePath(
      config.realm,
      `/users/${userId}/role-mappings/clients/${realmManagementClient.id}`,
    ),
  )
  if (existingRoles?.some((existingRole) => existingRole.name === role.name)) {
    console.log(`Keycloak user already has ${role.name} role`)
    return
  }

  await keycloak.post(
    realmResourcePath(
      config.realm,
      `/users/${userId}/role-mappings/clients/${realmManagementClient.id}`,
    ),
    [role],
  )
  console.log(`Assigned Keycloak role ${role.name} to ${config.bootstrapEmail}`)
}

const ensureXyneBootstrapRecords = async (config: BootstrapConfig) => {
  const queryClient = postgres(config.databaseUrl, { idle_timeout: 1 })
  const db = drizzle(queryClient, { schema: { users, workspaces } })

  try {
    let [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.externalId, config.workspaceExternalId))
      .limit(1)

    if (!workspace) {
      const [createdWorkspace] = await db
        .insert(workspaces)
        .values({
          externalId: config.workspaceExternalId,
          createdBy: config.bootstrapEmail,
          domain: config.workspaceDomain,
          name: config.workspaceName,
        })
        .returning()
      workspace = createdWorkspace
      console.log(`Created Xyne workspace ${config.workspaceExternalId}`)
    } else if (
      workspace.name !== config.workspaceName ||
      workspace.domain !== config.workspaceDomain
    ) {
      const [updatedWorkspace] = await db
        .update(workspaces)
        .set({
          name: config.workspaceName,
          domain: config.workspaceDomain,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspace.id))
        .returning()
      workspace = updatedWorkspace
      console.log(`Updated Xyne workspace ${config.workspaceExternalId}`)
    } else {
      console.log(`Xyne workspace ${config.workspaceExternalId} already exists`)
    }

    if (!workspace) {
      throw new Error(
        `Could not ensure Xyne workspace ${config.workspaceExternalId}`,
      )
    }

    const [existingUser] = await db
      .select()
      .from(users)
      .where(sql`LOWER(${users.email}) = LOWER(${config.bootstrapEmail})`)
      .limit(1)

    if (
      existingUser &&
      existingUser.workspaceExternalId !== config.workspaceExternalId
    ) {
      throw new Error(
        `Xyne user ${config.bootstrapEmail} already exists in workspace ${existingUser.workspaceExternalId}, expected ${config.workspaceExternalId}`,
      )
    }

    if (!existingUser) {
      await db.insert(users).values({
        externalId: createId(),
        workspaceId: workspace.id,
        email: config.bootstrapEmail,
        name: config.bootstrapName,
        photoLink: "",
        workspaceExternalId: workspace.externalId,
        lastLogin: new Date(),
        role: UserRole.SuperAdmin,
        refreshToken: "",
      })
      console.log(`Created Xyne SuperAdmin user ${config.bootstrapEmail}`)
      return
    }

    if (
      existingUser.role !== UserRole.SuperAdmin ||
      existingUser.name !== config.bootstrapName ||
      existingUser.workspaceId !== workspace.id
    ) {
      await db
        .update(users)
        .set({
          workspaceId: workspace.id,
          workspaceExternalId: workspace.externalId,
          name: config.bootstrapName,
          role: UserRole.SuperAdmin,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(users.id, existingUser.id),
            eq(users.workspaceExternalId, config.workspaceExternalId),
          ),
        )
      console.log(`Updated Xyne SuperAdmin user ${config.bootstrapEmail}`)
    } else {
      console.log(
        `Xyne SuperAdmin user ${config.bootstrapEmail} already exists`,
      )
    }
  } finally {
    await queryClient.end({ timeout: 5 })
  }
}

const main = async () => {
  const config = getBootstrapConfig()
  const keycloak = new KeycloakAdminClient(config)

  await keycloak.authenticate()
  await ensureRealm(keycloak, config)
  await ensureClient(keycloak, config)
  const userId = await ensureKeycloakBootstrapUser(keycloak, config)
  await ensureRealmAdminRole(keycloak, config, userId)
  await ensureXyneBootstrapRecords(config)

  console.log("Keycloak bootstrap completed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
