import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { KeycloakConfig, KeycloakClient, AuthFlow, ClientSelectionStrategy } from "./config"

const Logger = getLogger(Subsystem.Auth)

export interface AuthContext {
  environment?: string
  userRoles?: string[]
  flowType: AuthFlow
  userAgent?: string
  clientHint?: string
}

export interface ClientValidationResult {
  client: KeycloakClient
  available: boolean
  lastChecked: Date
  error?: string
}

interface DiscoveryCache {
  clients: KeycloakClient[]
  lastUpdated: Date
  ttl: number
}

export class IndustryKeycloakClientManager {
  private config: KeycloakConfig
  private discoveryCache: DiscoveryCache | null = null
  private validationCache = new Map<string, ClientValidationResult>()

  constructor(config: KeycloakConfig) {
    this.config = config
  }

  /**
   * Get all available clients using the configured strategy
   */
  async getAvailableClients(refresh = false): Promise<KeycloakClient[]> {
    const clients: KeycloakClient[] = []

    // Start with configured clients
    if (this.config.clientSelectionStrategy !== 'built-in-only') {
      clients.push(...this.config.clients)
    }

    // Add discovered clients if enabled
    if (this.config.autoDiscovery.enabled && 
        (this.config.clientSelectionStrategy === 'dynamic' || 
         this.config.clientSelectionStrategy === 'hybrid')) {
      
      const discoveredClients = await this.discoverClients(refresh)
      
      // Merge discovered clients (avoid duplicates)
      for (const discoveredClient of discoveredClients) {
        if (!clients.find(c => c.clientId === discoveredClient.clientId)) {
          clients.push(discoveredClient)
        }
      }
    }

    // Always include built-in clients as fallback
    clients.push(...this.getBuiltInClients())

    return this.deduplicateClients(clients)
  }

  /**
   * Select the best client for a specific authentication flow
   */
  async selectClient(context: AuthContext): Promise<KeycloakClient> {
    const availableClients = await this.getAvailableClients()
    
    Logger.info(`Selecting client for flow: ${context.flowType}`, {
      environment: context.environment,
      availableClients: availableClients.length,
      strategy: this.config.clientSelectionStrategy
    })

    // Filter clients that support the required flow
    const compatibleClients = availableClients.filter(client => 
      this.isClientCompatible(client, context)
    )

    if (compatibleClients.length === 0) {
      Logger.warn(`No compatible clients found for flow: ${context.flowType}`)
      // Return built-in fallback
      return this.getBuiltInFallback(context.flowType)
    }

    // Sort by priority and environment match
    const sortedClients = this.sortClientsByPreference(compatibleClients, context)

    // Try clients in order until one works
    for (const client of sortedClients) {
      if (await this.validateClient(client)) {
        Logger.info(`Selected client: ${client.clientId}`, {
          type: client.type,
          priority: client.priority,
          description: client.description
        })
        return client
      }
    }

    // All clients failed, use built-in fallback
    Logger.warn(`All compatible clients failed, using built-in fallback`)
    return this.getBuiltInFallback(context.flowType)
  }

  /**
   * Auto-discover clients from Keycloak admin API
   */
  private async discoverClients(refresh = false): Promise<KeycloakClient[]> {
    // Check cache first
    if (!refresh && this.discoveryCache && 
        Date.now() - this.discoveryCache.lastUpdated.getTime() < this.discoveryCache.ttl * 1000) {
      Logger.debug('Using cached client discovery results')
      return this.discoveryCache.clients
    }

    Logger.info('Discovering clients from Keycloak')

    try {
      // Get admin token for API access
      const adminToken = await this.getAdminToken()
      
      // Fetch clients from Keycloak API
      const clientsUrl = `${this.config.baseUrl}/admin/realms/${this.config.defaultRealm}/clients`
      const response = await fetch(clientsUrl, {
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch clients: ${response.status}`)
      }

      const rawClients = await response.json()
      const discoveredClients = this.parseDiscoveredClients(rawClients)

      // Update cache
      this.discoveryCache = {
        clients: discoveredClients,
        lastUpdated: new Date(),
        ttl: this.config.autoDiscovery.cacheTtl
      }

      Logger.info(`Discovered ${discoveredClients.length} clients from Keycloak`)
      return discoveredClients

    } catch (error) {
      Logger.error('Failed to discover clients from Keycloak:', error)
      
      // Return cached results if available
      if (this.discoveryCache) {
        Logger.warn('Using stale discovery cache due to error')
        return this.discoveryCache.clients
      }
      
      return []
    }
  }

  /**
   * Get admin token for Keycloak API access
   */
  private async getAdminToken(): Promise<string> {
    const tokenUrl = `${this.config.baseUrl}/realms/${this.config.adminRealm}/protocol/openid-connect/token`
    
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: this.config.adminUsername,
        password: this.config.adminPassword
      })
    })

    if (!response.ok) {
      throw new Error(`Failed to get admin token: ${response.status}`)
    }

    const tokens = await response.json()
    return tokens.access_token
  }

  /**
   * Parse raw Keycloak client data into our format
   */
  private parseDiscoveredClients(rawClients: any[]): KeycloakClient[] {
    return rawClients
      .filter(client => 
        client.enabled !== false &&
        !client.bearerOnly &&
        client.clientId &&
        !this.isBuiltInClient(client.clientId)
      )
      .map(client => ({
        clientId: client.clientId,
        clientSecret: client.secret,
        type: client.publicClient ? 'public' : 'confidential',
        flows: this.inferSupportedFlows(client),
        priority: 50, // Medium priority for discovered clients
        description: `Auto-discovered: ${client.description || client.name || client.clientId}`
      }))
  }

  /**
   * Infer supported flows from Keycloak client configuration
   */
  private inferSupportedFlows(client: any): AuthFlow[] {
    const flows: AuthFlow[] = []
    
    if (client.standardFlowEnabled) flows.push('authorization-code')
    if (client.directAccessGrantsEnabled) flows.push('password-grant')
    if (client.serviceAccountsEnabled) flows.push('client-credentials')
    
    // Always support refresh token if any flow is enabled
    if (flows.length > 0) flows.push('refresh-token')
    
    return flows
  }

  /**
   * Get built-in Keycloak clients as fallbacks
   */
  private getBuiltInClients(): KeycloakClient[] {
    return [
      {
        clientId: this.config.builtInClientPreferences.confidential,
        type: 'confidential',
        flows: ['password-grant', 'client-credentials', 'refresh-token', 'admin-api'],
        priority: 10, // Low priority (fallback)
        description: 'Built-in confidential client'
      },
      {
        clientId: this.config.builtInClientPreferences.public,
        type: 'public',
        flows: ['authorization-code', 'refresh-token'],
        priority: 10, // Low priority (fallback)
        description: 'Built-in public client'
      },
      {
        clientId: this.config.builtInClientPreferences.serviceAccount,
        type: 'confidential',
        flows: ['client-credentials', 'admin-api'],
        priority: 5, // Lowest priority
        description: 'Built-in service account client'
      }
    ]
  }

  /**
   * Check if client is compatible with the authentication context
   */
  private isClientCompatible(client: KeycloakClient, context: AuthContext): boolean {
    // Check flow support
    if (!client.flows.includes(context.flowType)) {
      return false
    }

    // Check environment match
    if (context.environment && client.environment && 
        !client.environment.includes(context.environment)) {
      return false
    }

    return true
  }

  /**
   * Sort clients by preference (priority, environment match, etc.)
   */
  private sortClientsByPreference(clients: KeycloakClient[], context: AuthContext): KeycloakClient[] {
    return clients.sort((a, b) => {
      // Higher priority first
      const priorityDiff = (b.priority || 0) - (a.priority || 0)
      if (priorityDiff !== 0) return priorityDiff

      // Environment match preference
      const aEnvMatch = this.getEnvironmentMatch(a, context.environment)
      const bEnvMatch = this.getEnvironmentMatch(b, context.environment)
      if (aEnvMatch !== bEnvMatch) return bEnvMatch - aEnvMatch

      // Prefer configured over discovered over built-in
      const aSource = this.getClientSource(a)
      const bSource = this.getClientSource(b)
      if (aSource !== bSource) return aSource - bSource

      return 0
    })
  }

  private getEnvironmentMatch(client: KeycloakClient, environment?: string): number {
    if (!environment || !client.environment) return 0
    return client.environment.includes(environment) ? 1 : 0
  }

  private getClientSource(client: KeycloakClient): number {
    if (this.config.clients.find(c => c.clientId === client.clientId)) return 0 // Configured
    if (this.isBuiltInClient(client.clientId)) return 2 // Built-in
    return 1 // Discovered
  }

  /**
   * Validate that a client actually works
   */
  private async validateClient(client: KeycloakClient): Promise<boolean> {
    const cacheKey = client.clientId
    const cached = this.validationCache.get(cacheKey)
    
    // Use cached result if recent
    if (cached && Date.now() - cached.lastChecked.getTime() < 60000) { // 1 minute cache
      return cached.available
    }

    try {
      // For built-in clients, assume they're always available
      if (this.isBuiltInClient(client.clientId)) {
        this.validationCache.set(cacheKey, {
          client,
          available: true,
          lastChecked: new Date()
        })
        return true
      }

      // For configured and discovered clients, validate by checking if they exist in Keycloak
      const available = await this.checkClientExists(client)
      
      this.validationCache.set(cacheKey, {
        client,
        available,
        lastChecked: new Date(),
        error: available ? undefined : 'Client not found in Keycloak'
      })

      return available

    } catch (error) {
      this.validationCache.set(cacheKey, {
        client,
        available: false,
        lastChecked: new Date(),
        error: error instanceof Error ? error.message : 'Unknown error'
      })

      return false
    }
  }

  /**
   * Check if a client exists in Keycloak without testing token flows
   */
  private async checkClientExists(client: KeycloakClient): Promise<boolean> {
    try {
      const adminToken = await this.getAdminToken()
      const clientsUrl = `${this.config.baseUrl}/admin/realms/${this.config.defaultRealm}/clients?clientId=${encodeURIComponent(client.clientId)}`
      
      const response = await fetch(clientsUrl, {
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        Logger.warn(`Failed to check client existence: ${response.status}`)
        return false
      }

      const clients = await response.json()
      const clientExists = Array.isArray(clients) && clients.length > 0 && clients[0].enabled

      Logger.debug(`Client ${client.clientId} validation: ${clientExists ? 'exists and enabled' : 'not found or disabled'}`)
      return clientExists

    } catch (error) {
      Logger.error(`Error checking client existence for ${client.clientId}:`, error)
      return false
    }
  }

  /**
   * Get built-in fallback client for a specific flow
   */
  private getBuiltInFallback(flow: AuthFlow): KeycloakClient {
    const builtInClients = this.getBuiltInClients()
    
    // Find the best built-in client for this flow
    const compatible = builtInClients.filter(client => client.flows.includes(flow))
    
    if (compatible.length === 0) {
      // Fallback to admin-cli if nothing else works
      return {
        clientId: 'admin-cli',
        type: 'confidential',
        flows: ['password-grant', 'client-credentials', 'refresh-token', 'admin-api'],
        priority: 1,
        description: 'Emergency fallback client'
      }
    }

    return compatible[0]
  }

  private isBuiltInClient(clientId: string): boolean {
    const builtInIds = [
      'admin-cli', 'account', 'account-console', 'broker', 'realm-management',
      'security-admin-console', this.config.builtInClientPreferences.public,
      this.config.builtInClientPreferences.confidential,
      this.config.builtInClientPreferences.serviceAccount
    ]
    return builtInIds.includes(clientId)
  }

  private deduplicateClients(clients: KeycloakClient[]): KeycloakClient[] {
    const seen = new Set<string>()
    return clients.filter(client => {
      if (seen.has(client.clientId)) return false
      seen.add(client.clientId)
      return true
    })
  }

  /**
   * Get comprehensive status of all clients
   */
  async getClientStatus(): Promise<{
    total: number
    configured: number
    discovered: number
    builtin: number
    available: number
    strategy: ClientSelectionStrategy
    lastDiscovery?: Date
  }> {
    const allClients = await this.getAvailableClients()
    const configured = this.config.clients.length
    const builtin = this.getBuiltInClients().length
    const discovered = this.discoveryCache?.clients.length || 0
    
    // Check availability of all clients
    let available = 0
    for (const client of allClients) {
      if (await this.validateClient(client)) {
        available++
      }
    }

    return {
      total: allClients.length,
      configured,
      discovered,
      builtin,
      available,
      strategy: this.config.clientSelectionStrategy,
      lastDiscovery: this.discoveryCache?.lastUpdated
    }
  }
}

/**
 * Factory function to create client manager
 */
export const getClientManager = (config: KeycloakConfig): IndustryKeycloakClientManager => {
  return new IndustryKeycloakClientManager(config)
}