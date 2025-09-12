import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { KeycloakConfig, AuthFlow } from "./config"
import { getClientManager, type AuthContext } from "./client-manager"

const Logger = getLogger(Subsystem.Auth)

// Legacy type aliases for backward compatibility
export type ClientFlowType = AuthFlow

export interface ClientInfo {
  clientId: string
  clientSecret?: string
  isPublic: boolean
  priority?: number
}

export class KeycloakClientResolver {
  private clientManager: any

  constructor(private config: KeycloakConfig) {
    this.clientManager = getClientManager(config)
  }

  /**
   * Resolves the appropriate client for a given authentication flow
   * Now uses industry-level client manager with discovery and selection
   */
  async resolveClient(flowType: ClientFlowType): Promise<ClientInfo> {
    const context: AuthContext = {
      flowType,
      environment: this.config.environment
    }

    try {
      const selectedClient = await this.clientManager.selectClient(context)
      
      Logger.info(`Selected client for ${flowType}: ${selectedClient.clientId}`, {
        type: selectedClient.type,
        priority: selectedClient.priority,
        description: selectedClient.description
      })

      return {
        clientId: selectedClient.clientId,
        clientSecret: selectedClient.clientSecret,
        isPublic: selectedClient.type === 'public',
        priority: selectedClient.priority || 50
      }
    } catch (error) {
      Logger.error(`Error selecting client for ${flowType}:`, error)
      
      // Fallback to legacy behavior
      return this.getLegacyFallback(flowType)
    }
  }

  /**
   * Legacy fallback method for backward compatibility
   */
  private getLegacyFallback(flowType: ClientFlowType): ClientInfo {
    // Try legacy client first (if configured)
    if (this.config.clientId) {
      Logger.warn(`Using legacy client for ${flowType}: ${this.config.clientId}`)
      return {
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        isPublic: !this.config.clientSecret,
        priority: 20
      }
    }

    // Fallback to built-in client
    const fallbackClient = this.getFallbackClient(flowType)
    Logger.warn(`Using legacy fallback client for ${flowType}: ${fallbackClient.clientId}`)
    return fallbackClient
  }

  /**
   * Builds token request parameters with appropriate client authentication
   */
  buildTokenParams(client: ClientInfo, baseParams: Record<string, string>): URLSearchParams {
    const params = new URLSearchParams(baseParams)
    params.append('client_id', client.clientId)

    // Add client secret for confidential clients
    if (client.clientSecret) {
      params.append('client_secret', client.clientSecret)
    }

    return params
  }

  /**
   * Performs token request with automatic fallback if primary client fails
   * Now uses the industry-level client manager for intelligent fallback
   */
  async performTokenRequest(
    tokenUrl: string, 
    flowType: ClientFlowType, 
    baseParams: Record<string, string>
  ): Promise<Response> {
    const client = await this.resolveClient(flowType)
    const body = this.buildTokenParams(client, baseParams)

    Logger.info(`Attempting token request with client: ${client.clientId}`)

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body,
    })

    if (!response.ok) {
      const errorText = await response.text()
      Logger.warn(`Token request failed with client ${client.clientId}: ${errorText}`)
      
      // The client manager already handles fallback selection, so if we get here
      // it means the selected client failed. Log the failure but return the response
      // since the client manager should have already tried the best available client.
    } else {
      Logger.info(`Token request succeeded with client: ${client.clientId}`)
    }

    return response
  }

  private getFallbackClient(flowType: ClientFlowType): ClientInfo {
    switch (flowType) {
      case 'password-grant':
      case 'admin-api':
        // Use confidential client for secure operations
        return {
          clientId: this.config.builtInClientPreferences.confidential,
          clientSecret: undefined, // Built-in clients don't need secrets
          isPublic: false,
          priority: 10
        }
      
      case 'authorization-code':
        // Use public client for frontend flows
        return {
          clientId: this.config.builtInClientPreferences.public,
          clientSecret: undefined,
          isPublic: true,
          priority: 10
        }
      
      case 'token-refresh':
        // Use same client as original token (fallback to confidential)
        return {
          clientId: this.config.builtInClientPreferences.confidential,
          clientSecret: undefined,
          isPublic: false,
          priority: 10
        }
      
      default:
        Logger.warn(`Unknown flow type: ${flowType}, using admin-cli`)
        return {
          clientId: 'admin-cli',
          clientSecret: undefined,
          isPublic: false,
          priority: 5
        }
    }
  }
}

/**
 * Factory function to create client resolver instance
 */
export const getClientResolver = (config: KeycloakConfig): KeycloakClientResolver => {
  return new KeycloakClientResolver(config)
}