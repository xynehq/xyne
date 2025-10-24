import { ToolType } from "@/types/workflowTypes"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.WorkflowApi)

/**
 * Checks if a workflow template contains webhook tools
 * @param tools Array of workflow tools to check
 * @returns True if any tool is a webhook
 */
export function hasWebhookTools(tools: Array<{ type: string }>): boolean {
  return tools.some(tool => tool.type === ToolType.WEBHOOK)
}

/**
 * Makes an internal API call to reload webhooks
 * This triggers the existing /workflow/webhook-api/reload endpoint functionality
 */
export async function triggerWebhookReload(): Promise<{ success: boolean; count?: number; error?: string }> {
  try {
    Logger.info("🔄 Triggering webhook reload...")
    
    // Make internal HTTP request to the webhook reload endpoint
    const response = await fetch('http://localhost:3000/workflow/webhook-api/reload', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    })
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    
    const result = await response.json()
    Logger.info(`✅ Webhook reload completed: ${result.count} webhooks loaded`)
    
    return {
      success: result.success,
      count: result.count,
      error: result.error
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    Logger.error(`Failed to trigger webhook reload: ${errorMessage}`)
    
    return {
      success: false,
      error: errorMessage
    }
  }
}