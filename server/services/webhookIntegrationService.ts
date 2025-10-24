import { db } from "@/db/client"
import { workflowTool, workflowStepTemplate } from "@/db/schema/workflows"
import { eq } from "drizzle-orm"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { ToolType } from "@/types/workflowTypes"
import { webhookRegistry } from "@/services/webhookRegistry"

const Logger = getLogger(Subsystem.WorkflowApi)

export interface WebhookToolConfig {
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

export class WebhookIntegrationService {
  private static instance: WebhookIntegrationService

  static getInstance(): WebhookIntegrationService {
    if (!WebhookIntegrationService.instance) {
      WebhookIntegrationService.instance = new WebhookIntegrationService()
    }
    return WebhookIntegrationService.instance
  }

  async createWebhookTool(
    workflowTemplateId: string,
    config: WebhookToolConfig,
    userId: number,
    workspaceId: number
  ): Promise<{ toolId: string; webhookUrl: string }> {
    try {
      // Create the webhook tool in the database
      const [tool] = await db
        .insert(workflowTool)
        .values({
          type: ToolType.WEBHOOK,
          userId: userId,
          workspaceId: workspaceId,
          value: {
            path: config.path,
            webhookUrl: config.webhookUrl
          },
          config: {
            httpMethod: config.httpMethod,
            authentication: config.authentication,
            selectedCredential: config.selectedCredential,
            responseMode: config.responseMode,
            headers: config.headers || {},
            queryParams: config.queryParams || {},
            options: config.options || {}
          }
        })
        .returning()

      // Register the webhook with the registry
      await webhookRegistry.registerWebhook(
        config.path,
        workflowTemplateId,
        tool.id,
        config
      )

      Logger.info(`Created webhook tool ${tool.id} for template ${workflowTemplateId}`)

      return {
        toolId: tool.id,
        webhookUrl: config.webhookUrl
      }

    } catch (error) {
      Logger.error(`Failed to create webhook tool: ${error}`)
      throw new Error(`Failed to create webhook tool: ${error}`)
    }
  }

  async updateWebhookTool(
    toolId: string,
    config: Partial<WebhookToolConfig>
  ): Promise<{ toolId: string; webhookUrl?: string }> {
    try {
      // Get existing tool
      const [existingTool] = await db
        .select()
        .from(workflowTool)
        .where(eq(workflowTool.id, toolId))
        .limit(1)

      if (!existingTool || existingTool.type !== ToolType.WEBHOOK) {
        throw new Error(`Webhook tool ${toolId} not found`)
      }

      const existingValue = existingTool.value as any
      const existingConfig = existingTool.config as any

      // Unregister old webhook if path is changing
      if (config.path && config.path !== existingValue?.path) {
        await webhookRegistry.unregisterWebhook(existingValue.path)
      }

      // Update the tool
      const updatedValue = {
        ...existingValue,
        ...(config.path && { path: config.path }),
        ...(config.webhookUrl && { webhookUrl: config.webhookUrl })
      }

      const updatedConfig = {
        ...existingConfig,
        ...(config.httpMethod && { httpMethod: config.httpMethod }),
        ...(config.authentication && { authentication: config.authentication }),
        ...(config.selectedCredential !== undefined && { selectedCredential: config.selectedCredential }),
        ...(config.responseMode && { responseMode: config.responseMode }),
        ...(config.headers && { headers: config.headers }),
        ...(config.queryParams && { queryParams: config.queryParams }),
        ...(config.options && { options: config.options })
      }

      await db
        .update(workflowTool)
        .set({
          value: updatedValue,
          config: updatedConfig,
          updatedAt: new Date()
        })
        .where(eq(workflowTool.id, toolId))

      // Re-register webhook with new configuration
      if (config.path) {
        const fullConfig = { ...existingConfig, ...updatedConfig, path: config.path }
        // Get workflow template ID from step template
        const templateId = await this.getWorkflowTemplateIdFromTool(toolId)
        
        if (templateId) {
          await webhookRegistry.registerWebhook(
            config.path,
            templateId,
            toolId,
            fullConfig as WebhookToolConfig
          )
        }
      }

      Logger.info(`Updated webhook tool ${toolId}`)

      return {
        toolId,
        webhookUrl: config.webhookUrl
      }

    } catch (error) {
      Logger.error(`Failed to update webhook tool: ${error}`)
      throw new Error(`Failed to update webhook tool: ${error}`)
    }
  }

  async deleteWebhookTool(toolId: string): Promise<void> {
    try {
      // Get tool details before deletion
      const [tool] = await db
        .select()
        .from(workflowTool)
        .where(eq(workflowTool.id, toolId))
        .limit(1)

      if (!tool || tool.type !== ToolType.WEBHOOK) {
        throw new Error(`Webhook tool ${toolId} not found`)
      }

      const value = tool.value as any
      
      // Unregister webhook
      if (value?.path) {
        await webhookRegistry.unregisterWebhook(value.path)
      }

      // Delete tool from database
      await db
        .delete(workflowTool)
        .where(eq(workflowTool.id, toolId))

      Logger.info(`Deleted webhook tool ${toolId}`)

    } catch (error) {
      Logger.error(`Failed to delete webhook tool: ${error}`)
      throw new Error(`Failed to delete webhook tool: ${error}`)
    }
  }

  async getWebhookToolConfig(toolId: string): Promise<WebhookToolConfig | null> {
    try {
      const [tool] = await db
        .select()
        .from(workflowTool)
        .where(eq(workflowTool.id, toolId))
        .limit(1)

      if (!tool || tool.type !== ToolType.WEBHOOK) {
        return null
      }

      const value = tool.value as any
      const config = tool.config as any

      return {
        webhookUrl: value?.webhookUrl || '',
        httpMethod: config?.httpMethod || 'POST',
        path: value?.path || '',
        authentication: config?.authentication || 'none',
        selectedCredential: config?.selectedCredential,
        responseMode: config?.responseMode || 'immediately',
        options: config?.options || {},
        headers: config?.headers || {},
        queryParams: config?.queryParams || {}
      }

    } catch (error) {
      Logger.error(`Failed to get webhook tool config: ${error}`)
      return null
    }
  }

  private async getWorkflowTemplateIdFromTool(toolId: string): Promise<string | null> {
    try {
      // This is a simplified approach - in a real implementation you'd properly join the tables
      const steps = await db
        .select()
        .from(workflowStepTemplate)

      for (const step of steps) {
        if (step.toolIds && step.toolIds.includes(toolId)) {
          return step.workflowTemplateId
        }
      }

      return null

    } catch (error) {
      Logger.error(`Failed to get workflow template ID: ${error}`)
      return null
    }
  }

  async registerExistingWebhookTools(): Promise<void> {
    try {
      // This method can be called on startup to register all existing webhook tools
      const webhookTools = await db
        .select()
        .from(workflowTool)
        .where(eq(workflowTool.type, ToolType.WEBHOOK))

      for (const tool of webhookTools) {
        try {
          const config = await this.getWebhookToolConfig(tool.id)
          const templateId = await this.getWorkflowTemplateIdFromTool(tool.id)

          if (config && templateId && config.path) {
            await webhookRegistry.registerWebhook(
              config.path,
              templateId,
              tool.id,
              config
            )
          }
        } catch (error) {
          Logger.error(`Failed to register existing webhook tool ${tool.id}: ${error}`)
        }
      }

      Logger.info(`Registered ${webhookTools.length} existing webhook tools`)

    } catch (error) {
      Logger.error(`Failed to register existing webhook tools: ${error}`)
    }
  }

  async validateWebhookPath(path: string, excludeToolId?: string): Promise<boolean> {
    try {
      const cleanPath = path.startsWith('/') ? path : `/${path}`
      
      // Check if path is already registered in memory
      const existingWebhook = webhookRegistry.getWebhook(cleanPath)
      if (existingWebhook && existingWebhook.toolId !== excludeToolId) {
        return false
      }

      // Check database for tools with this path
      const tools = await db
        .select()
        .from(workflowTool)
        .where(eq(workflowTool.type, ToolType.WEBHOOK))

      for (const tool of tools) {
        if (tool.id === excludeToolId) continue
        
        const value = tool.value as any
        if (value?.path === cleanPath) {
          return false
        }
      }

      return true

    } catch (error) {
      Logger.error(`Failed to validate webhook path: ${error}`)
      return false
    }
  }
}

export default WebhookIntegrationService.getInstance()