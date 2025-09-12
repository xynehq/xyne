export interface KeycloakClient {
  clientId: string
  clientSecret?: string
  type: 'public' | 'confidential' | 'bearer-only'
  flows: AuthFlow[]
  environment?: string[]
  roles?: string[]
  priority?: number  // Higher priority = preferred
  description?: string
}

export type AuthFlow = 
  | 'authorization-code'
  | 'password-grant' 
  | 'client-credentials'
  | 'refresh-token'
  | 'token-refresh'
  | 'token-exchange'
  | 'admin-api'

export type ClientSelectionStrategy = 
  | 'static'           // Use configured clients only
  | 'dynamic'          // Auto-discover from Keycloak
  | 'hybrid'           // Configured + discovered
  | 'built-in-only'    // Only use built-in clients

export interface KeycloakConfig {
  enabled: boolean
  baseUrl: string
  adminRealm: string
  adminUsername: string
  adminPassword: string
  defaultRealm: string
  
  // Multi-client support
  clients: KeycloakClient[]
  clientSelectionStrategy: ClientSelectionStrategy
  
  // Environment-based client management
  environment?: string  // 'development' | 'staging' | 'production'
  
  // Built-in client preferences
  builtInClientPreferences: {
    public: string       // Default: 'account'
    confidential: string // Default: 'admin-cli'  
    serviceAccount: string // Default: 'admin-cli'
  }
  
  // Auto-discovery settings
  autoDiscovery: {
    enabled: boolean
    cacheTtl: number  // Cache TTL in seconds
    retryInterval: number // Retry failed discoveries
  }
  
  // Legacy support (will be migrated to clients array)
  clientId?: string
  clientSecret?: string
}

const parseClients = (): KeycloakClient[] => {
  const clients: KeycloakClient[] = []
  
  // Primary: Parse from KEYCLOAK_CLIENTS array (JSON format)
  const clientsJson = process.env.KEYCLOAK_CLIENTS
  if (clientsJson) {
    try {
      const parsedClients = JSON.parse(clientsJson)
      if (Array.isArray(parsedClients)) {
        clients.push(...parsedClients.map((client, index) => ({
          ...client,
          priority: client.priority || (100 - index * 10), // Auto-assign decreasing priority
          description: client.description || `Configured client #${index + 1}`
        })))
        console.log(`✅ Loaded ${parsedClients.length} clients from KEYCLOAK_CLIENTS`)
      } else {
        console.warn('⚠️ KEYCLOAK_CLIENTS must be an array, ignoring')
      }
    } catch (error) {
      console.warn('⚠️ Invalid KEYCLOAK_CLIENTS JSON format, ignoring:', error)
    }
  }
  
  // Secondary: Individual client environment variables (for simpler setups)
  const individualClients = parseIndividualClients()
  for (const client of individualClients) {
    if (!clients.find(c => c.clientId === client.clientId)) {
      clients.push(client)
    }
  }
  
  // Legacy support: Single client from old env vars (lowest priority)
  const legacyClient = parseLegacyClient()
  if (legacyClient && !clients.find(c => c.clientId === legacyClient.clientId)) {
    clients.push(legacyClient)
  }
  
  return clients
}

const parseIndividualClients = (): KeycloakClient[] => {
  const clients: KeycloakClient[] = []
  let index = 1
  
  // Support multiple clients via numbered env vars
  while (true) {
    const suffix = index === 1 ? '' : `_${index}`
    const clientId = process.env[`KEYCLOAK_CLIENT${suffix}_ID`]
    
    if (!clientId) break
    
    const clientSecret = process.env[`KEYCLOAK_CLIENT${suffix}_SECRET`]
    const clientType = process.env[`KEYCLOAK_CLIENT${suffix}_TYPE`] as any || (clientSecret ? 'confidential' : 'public')
    const clientFlows = process.env[`KEYCLOAK_CLIENT${suffix}_FLOWS`]?.split(',') as AuthFlow[] || ['authorization-code', 'password-grant', 'refresh-token']
    const clientEnv = process.env[`KEYCLOAK_CLIENT${suffix}_ENVIRONMENT`]?.split(',')
    const clientPriority = parseInt(process.env[`KEYCLOAK_CLIENT${suffix}_PRIORITY`] || String(90 - (index - 1) * 10))
    
    clients.push({
      clientId,
      clientSecret,
      type: clientType,
      flows: clientFlows,
      environment: clientEnv,
      priority: clientPriority,
      description: `Individual client #${index}`
    })
    
    index++
  }
  
  if (clients.length > 0) {
    console.log(`✅ Loaded ${clients.length} clients from individual env vars`)
  }
  
  return clients
}

const parseLegacyClient = (): KeycloakClient | null => {
  const legacyClientId = process.env.KEYCLOAK_CLIENT_ID
  if (!legacyClientId) return null
  
  console.log('⚠️ Using legacy KEYCLOAK_CLIENT_ID (consider migrating to KEYCLOAK_CLIENTS array)')
  
  return {
    clientId: legacyClientId,
    clientSecret: process.env.KEYCLOAK_CLIENT_SECRET,
    type: process.env.KEYCLOAK_CLIENT_SECRET ? 'confidential' : 'public',
    flows: ['authorization-code', 'password-grant', 'refresh-token'],
    priority: 50, // Medium priority for legacy client
    description: 'Legacy single client (deprecated)'
  }
}

export const getKeycloakConfig = (): KeycloakConfig => {
  const config: KeycloakConfig = {
    enabled: process.env.KEYCLOAK_ENABLED === "true",
    baseUrl: process.env.KEYCLOAK_BASE_URL || "http://localhost:8081",
    adminRealm: process.env.KEYCLOAK_ADMIN_REALM || "master",
    adminUsername: process.env.KEYCLOAK_ADMIN_USERNAME || "admin",
    adminPassword: process.env.KEYCLOAK_ADMIN_PASSWORD || "admin",
    
    // 🎯 REALM-CENTRIC: The core requirement - realm is mandatory
    defaultRealm: process.env.KEYCLOAK_DEFAULT_REALM || "xyne-shared",
    
    // 🏭 MULTI-CLIENT ARRAY: Clients are optional arrays
    clients: parseClients(),
    clientSelectionStrategy: (process.env.KEYCLOAK_CLIENT_STRATEGY as ClientSelectionStrategy) || 'hybrid',
    environment: process.env.NODE_ENV || process.env.ENVIRONMENT || 'development',
    
    // Built-in client preferences (per realm)
    builtInClientPreferences: {
      public: process.env.KEYCLOAK_BUILTIN_PUBLIC_CLIENT || 'account',
      confidential: process.env.KEYCLOAK_BUILTIN_CONFIDENTIAL_CLIENT || 'admin-cli',
      serviceAccount: process.env.KEYCLOAK_BUILTIN_SERVICE_CLIENT || 'admin-cli',
    },
    
    // Auto-discovery settings
    autoDiscovery: {
      enabled: process.env.KEYCLOAK_AUTO_DISCOVERY !== 'false', // Default: true
      cacheTtl: parseInt(process.env.KEYCLOAK_DISCOVERY_CACHE_TTL || '300'), // 5 minutes
      retryInterval: parseInt(process.env.KEYCLOAK_DISCOVERY_RETRY_INTERVAL || '60'), // 1 minute
    },
    
    // Legacy support (will be deprecated)
    clientId: process.env.KEYCLOAK_CLIENT_ID,
    clientSecret: process.env.KEYCLOAK_CLIENT_SECRET,
  }
  
  // Validate and log configuration
  validateKeycloakConfig(config)
  
  return config
}

export const validateKeycloakConfig = (config: KeycloakConfig): void => {
  const errors: string[] = []
  const warnings: string[] = []
  
  // Core validation: Realm is mandatory
  if (!config.defaultRealm) {
    errors.push('🚨 KEYCLOAK_DEFAULT_REALM is mandatory')
  }
  
  if (!config.baseUrl) {
    errors.push('🚨 KEYCLOAK_BASE_URL is mandatory')
  }
  
  // Client validation: Arrays are optional but should be valid if provided
  if (config.clients.length === 0) {
    warnings.push('⚠️ No clients configured - will use built-in clients only')
  }
  
  // Validate each client
  config.clients.forEach((client, index) => {
    if (!client.clientId) {
      errors.push(`🚨 Client #${index + 1}: clientId is required`)
    }
    
    if (client.type === 'confidential' && !client.clientSecret) {
      warnings.push(`⚠️ Client '${client.clientId}': confidential client without secret`)
    }
    
    if (!client.flows || client.flows.length === 0) {
      warnings.push(`⚠️ Client '${client.clientId}': no flows specified`)
    }
  })
  
  // Strategy validation
  const validStrategies: ClientSelectionStrategy[] = ['static', 'dynamic', 'hybrid', 'built-in-only']
  if (!validStrategies.includes(config.clientSelectionStrategy)) {
    errors.push(`🚨 Invalid client strategy: ${config.clientSelectionStrategy}`)
  }
  
  // Discovery validation
  if (config.autoDiscovery.enabled && (!config.adminUsername || !config.adminPassword)) {
    warnings.push('⚠️ Auto-discovery enabled but admin credentials missing')
  }
  
  // Log results
  if (errors.length > 0) {
    console.error('❌ Keycloak Configuration Errors:')
    errors.forEach(error => console.error(`  ${error}`))
    throw new Error('Invalid Keycloak configuration')
  }
  
  if (warnings.length > 0) {
    console.warn('⚠️ Keycloak Configuration Warnings:')
    warnings.forEach(warning => console.warn(`  ${warning}`))
  }
  
  // Success log
  console.log('✅ Keycloak Configuration Valid:')
  console.log(`  📍 Realm: ${config.defaultRealm}`)
  console.log(`  🏭 Strategy: ${config.clientSelectionStrategy}`)
  console.log(`  🔧 Clients: ${config.clients.length} configured`)
  console.log(`  🔍 Discovery: ${config.autoDiscovery.enabled ? 'enabled' : 'disabled'}`)
  console.log(`  🌍 Environment: ${config.environment}`)
}