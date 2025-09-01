export interface KeycloakConfig {
  enabled: boolean
  baseUrl: string
  adminRealm: string
  adminUsername: string
  adminPassword: string
  clientId: string
  clientSecret: string
  defaultRealm: string
}

export const getKeycloakConfig = (): KeycloakConfig => {
  return {
    enabled: process.env.KEYCLOAK_ENABLED === "true",
    baseUrl: process.env.KEYCLOAK_BASE_URL || "http://localhost:8081",
    adminRealm: process.env.KEYCLOAK_ADMIN_REALM || "master",
    adminUsername: process.env.KEYCLOAK_ADMIN_USERNAME || "admin",
    adminPassword: process.env.KEYCLOAK_ADMIN_PASSWORD || "admin",
    clientId: process.env.KEYCLOAK_CLIENT_ID || "oa-backend",
    clientSecret: process.env.KEYCLOAK_CLIENT_SECRET || "",
    defaultRealm: process.env.KEYCLOAK_DEFAULT_REALM || "xyne-shared",
  }
}