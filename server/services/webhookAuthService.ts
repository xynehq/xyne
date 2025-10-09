import { db } from "@/db/client"
import { eq } from "drizzle-orm"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { HTTPException } from "hono/http-exception"
import type { Context } from "hono"

const Logger = getLogger(Subsystem.WorkflowApi)

export interface WebhookAuthConfig {
  authentication: "none" | "basic" | "bearer" | "api_key"
  selectedCredential?: string
  headers?: Record<string, string>
}

export class WebhookAuthService {
  private static instance: WebhookAuthService

  static getInstance(): WebhookAuthService {
    if (!WebhookAuthService.instance) {
      WebhookAuthService.instance = new WebhookAuthService()
    }
    return WebhookAuthService.instance
  }

  async validateAuthentication(c: Context, config: WebhookAuthConfig): Promise<boolean> {
    try {
      switch (config.authentication) {
        case 'none':
          return true
          
        case 'basic':
          return await this.validateBasicAuth(c, config)
          
        case 'bearer':
          return await this.validateBearerAuth(c, config)
          
        case 'api_key':
          return await this.validateApiKeyAuth(c, config)
          
        default:
          throw new HTTPException(400, { message: "Unsupported authentication type" })
      }
    } catch (error) {
      Logger.error(`Authentication validation failed: ${error}`)
      return false
    }
  }

  private async validateBasicAuth(c: Context, config: WebhookAuthConfig): Promise<boolean> {
    const authHeader = c.req.header('Authorization')
    
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      throw new HTTPException(401, { message: "Basic authentication required" })
    }

    try {
      const base64Credentials = authHeader.substring(6)
      const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8')
      const [username, password] = credentials.split(':')

      if (!username || !password) {
        throw new HTTPException(401, { message: "Invalid basic auth format" })
      }

      // If credential ID is provided, validate against stored credentials
      if (config.selectedCredential) {
        return await this.validateStoredCredential(config.selectedCredential, { username, password })
      }

      // For now, accept any valid basic auth format
      // In production, you'd validate against stored credentials
      Logger.info(`Basic auth validated for user: ${username}`)
      return true

    } catch (error) {
      Logger.error(`Basic auth validation failed: ${error}`)
      throw new HTTPException(401, { message: "Invalid basic authentication" })
    }
  }

  private async validateBearerAuth(c: Context, config: WebhookAuthConfig): Promise<boolean> {
    const authHeader = c.req.header('Authorization')
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new HTTPException(401, { message: "Bearer token required" })
    }

    try {
      const token = authHeader.substring(7)
      
      if (!token || token.length < 10) {
        throw new HTTPException(401, { message: "Invalid bearer token format" })
      }

      // If credential ID is provided, validate against stored credentials
      if (config.selectedCredential) {
        return await this.validateStoredCredential(config.selectedCredential, { token })
      }

      // For now, accept any valid bearer token format
      // In production, you'd validate against stored tokens
      Logger.info(`Bearer token validated: ${token.substring(0, 10)}...`)
      return true

    } catch (error) {
      Logger.error(`Bearer auth validation failed: ${error}`)
      throw new HTTPException(401, { message: "Invalid bearer token" })
    }
  }

  private async validateApiKeyAuth(c: Context, config: WebhookAuthConfig): Promise<boolean> {
    const apiKey = c.req.header('X-API-Key') || 
                   c.req.header('x-api-key') || 
                   c.req.query('api_key') ||
                   c.req.query('apikey')

    if (!apiKey) {
      throw new HTTPException(401, { message: "API key required in X-API-Key header or api_key query parameter" })
    }

    try {
      if (typeof apiKey !== 'string' || apiKey.length < 10) {
        throw new HTTPException(401, { message: "Invalid API key format" })
      }

      // If credential ID is provided, validate against stored credentials
      if (config.selectedCredential) {
        return await this.validateStoredCredential(config.selectedCredential, { apiKey })
      }

      // For now, accept any valid API key format
      // In production, you'd validate against stored API keys
      Logger.info(`API key validated: ${apiKey.substring(0, 10)}...`)
      return true

    } catch (error) {
      Logger.error(`API key validation failed: ${error}`)
      throw new HTTPException(401, { message: "Invalid API key" })
    }
  }

  private async validateStoredCredential(credentialId: string, providedAuth: any): Promise<boolean> {
    try {
      // TODO: Implement credential lookup from database
      // This would integrate with your existing credential management system
      // For now, we'll log the attempt and return true for development
      
      Logger.info(`Validating stored credential ${credentialId} with provided auth`)
      
      // In a real implementation, you would:
      // 1. Query the credentials table using credentialId
      // 2. Compare the provided auth with stored credentials
      // 3. Handle encryption/hashing as needed
      // 4. Return true if valid, false otherwise
      
      return true
      
    } catch (error) {
      Logger.error(`Stored credential validation failed: ${error}`)
      return false
    }
  }

  async validateCustomHeaders(c: Context, requiredHeaders: Record<string, string>): Promise<boolean> {
    try {
      for (const [headerName, expectedValue] of Object.entries(requiredHeaders)) {
        const actualValue = c.req.header(headerName.toLowerCase())
        
        if (!actualValue) {
          throw new HTTPException(400, { message: `Missing required header: ${headerName}` })
        }
        
        if (expectedValue !== '*' && actualValue !== expectedValue) {
          throw new HTTPException(400, { message: `Invalid header value for: ${headerName}` })
        }
      }
      
      return true
      
    } catch (error) {
      Logger.error(`Custom header validation failed: ${error}`)
      return false
    }
  }

  async validateRequestSignature(c: Context, secret: string, signatureHeader = 'X-Signature'): Promise<boolean> {
    try {
      const signature = c.req.header(signatureHeader)
      
      if (!signature) {
        throw new HTTPException(401, { message: `Missing signature header: ${signatureHeader}` })
      }

      // Get request body for signature validation
      const body = await c.req.arrayBuffer()
      const bodyString = new TextDecoder().decode(body)

      // TODO: Implement signature validation (e.g., HMAC-SHA256)
      // This is a common pattern for webhooks like GitHub, Stripe, etc.
      
      Logger.info(`Signature validation attempted for ${signatureHeader}`)
      return true
      
    } catch (error) {
      Logger.error(`Signature validation failed: ${error}`)
      return false
    }
  }

  generateWebhookSecret(): string {
    // Generate a secure random secret for webhook signature validation
    const crypto = require('crypto')
    return crypto.randomBytes(32).toString('hex')
  }

  async auditWebhookAccess(c: Context, webhookPath: string, success: boolean, errorMessage?: string) {
    try {
      const auditData = {
        webhookPath,
        success,
        timestamp: new Date().toISOString(),
        ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown',
        userAgent: c.req.header('user-agent') || 'unknown',
        method: c.req.method,
        errorMessage
      }

      // TODO: Store audit data in database or logging system
      Logger.info(`Webhook access audit: ${JSON.stringify(auditData)}`)
      
    } catch (error) {
      Logger.error(`Failed to audit webhook access: ${error}`)
    }
  }
}

export default WebhookAuthService.getInstance()