import { ToolType } from "@/types/workflowTypes"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import WebhookHandler from "@/services/WebhookHandler"

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
 * Triggers webhook reload by calling the WebhookHandler directly
 */
export async function triggerWebhookReload(): Promise<{ success: boolean; count?: number; error?: string }> {
  try {
    Logger.info("🔄 Triggering webhook reload...")
    
    // Call WebhookHandler directly instead of making HTTP request
    const result = await WebhookHandler.reloadWebhooks()
    Logger.info(`✅ Webhook reload completed: ${result.count} webhooks loaded`)
    
    return result
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    Logger.error(`Failed to trigger webhook reload: ${errorMessage}`)
    
    return {
      success: false,
      error: errorMessage
    }
  }
}