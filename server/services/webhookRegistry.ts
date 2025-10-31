import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.WorkflowApi)

// WebhookConfig type definition
type WebhookConfig = {
  webhookUrl: string
  httpMethod: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
  path: string
  authentication: "none" | "basic" | "bearer" | "api_key"
  selectedCredential?: string
  responseMode: "immediately" | "wait_for_completion" | "custom"
  options?: Record<string, any>
  headers?: Record<string, string>
  queryParams?: Record<string, string>
  requestBody?: string
}

// Webhook registration service (moved from webhook.ts to avoid circular imports)
class WebhookRegistrationService {
  private static instance: WebhookRegistrationService
  private registeredWebhooks: Map<string, {
    workflowTemplateId: string
    toolId: string
    config: WebhookConfig
    httpMethod: string
  }> = new Map()

  static getInstance(): WebhookRegistrationService {
    if (!WebhookRegistrationService.instance) {
      WebhookRegistrationService.instance = new WebhookRegistrationService()
    }
    return WebhookRegistrationService.instance
  }

  async registerWebhook(
    path: string, 
    workflowTemplateId: string, 
    toolId: string, 
    config: WebhookConfig
  ): Promise<void> {
    // Validate path format
    const cleanPath = path.startsWith('/') ? path : `/${path}`
    
    // Check if path is already registered
    if (this.registeredWebhooks.has(cleanPath)) {
      throw new Error(`Webhook path ${cleanPath} is already registered`)
    }

    // Register the webhook
    this.registeredWebhooks.set(cleanPath, {
      workflowTemplateId,
      toolId,
      config,
      httpMethod: config.httpMethod
    })

    Logger.info(`Registered webhook: ${cleanPath} -> Template: ${workflowTemplateId}`)
  }

  async unregisterWebhook(path: string): Promise<boolean> {
    const cleanPath = path.startsWith('/') ? path : `/${path}`
    const deleted = this.registeredWebhooks.delete(cleanPath)
    if (deleted) {
      Logger.info(`Unregistered webhook: ${cleanPath}`)
    }
    return deleted
  }

  getWebhook(path: string) {
    const cleanPath = path.startsWith('/') ? path : `/${path}`
    return this.registeredWebhooks.get(cleanPath)
  }

  getAllWebhooks() {
    return Array.from(this.registeredWebhooks.entries()).map(([path, data]) => ({
      path,
      ...data
    }))
  }

  clearAll() {
    this.registeredWebhooks.clear()
  }
}

// Get singleton instance and export
export const webhookRegistry = WebhookRegistrationService.getInstance()
export type { WebhookConfig }