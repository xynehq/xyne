import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { ToolRegistry } from "./types"

// Import all tool implementations
import { EmailTool } from "./email"
import { AiAgentTool } from "./ai-agent"
import { FormTool } from "./form"
import { DelayTool } from "./delay"
import { SlackTool } from "./slack"
import { GmailTool } from "./gmail"
import { AgentTool } from "./agent"
import { MergedNodeTool } from "./merged-node"
import { SwitchTool } from "./switch"
import { ManualTriggerTool } from "./manual-trigger"
import { SchedulerTriggerTool } from "./scheduler-trigger"
import { WebhookTool } from "./webhook"
import { HttpRequestTool } from "./http-request"
import { JiraTool } from "./jira"

// Create tool registry - centralized access point for all workflow tools
export const toolRegistry: ToolRegistry = {
  [ToolType.EMAIL]: new EmailTool(),
  [ToolType.AI_AGENT]: new AiAgentTool(),
  [ToolType.FORM]: new FormTool(),
  [ToolType.DELAY]: new DelayTool(),
  [ToolType.SLACK]: new SlackTool(),
  [ToolType.GMAIL]: new GmailTool(),
  [ToolType.AGENT]: new AgentTool(),
  [ToolType.MERGED_NODE]: new MergedNodeTool(),
  [ToolType.SWITCH]: new SwitchTool(),
  [ToolType.MANUAL_TRIGGER]: new ManualTriggerTool(),
  [ToolType.SCHEDULER_TRIGGER]: new SchedulerTriggerTool(),
  [ToolType.WEBHOOK]: new WebhookTool(),
  [ToolType.HTTP_REQUEST]: new HttpRequestTool(),
  [ToolType.JIRA]: new JiraTool(),
}

// Helper function to get a tool by type
export function getTool(toolType: ToolType) {
  const tool = toolRegistry[toolType]
  if (!tool) {
    throw new Error(`Tool type '${toolType}' not found in registry`)
  }
  return tool
}

// Helper function to check if a tool type is supported
export function isToolSupported(toolType: string): toolType is ToolType {
  return Object.values(ToolType).includes(toolType as ToolType)
}

// Helper function to get all supported tool types
export function getSupportedToolTypes(): ToolType[] {
  return Object.values(ToolType)
}


// Helper function to get tool category from the file itself
export function getToolCategory(toolType: ToolType): ToolCategory {
  const tool = getTool(toolType)
  return tool.category
}

// Helper function to get all tools with their categories
export function getToolsWithCategories(): Array<{ type: ToolType; category: ToolCategory; name: string }> {
  return Object.entries(toolRegistry).map(([toolType, tool]) => ({
    type: toolType as ToolType,
    category: tool.category,
    name: toolType.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, l => l.toUpperCase())
  }))
}

// Helper function to get tools by category
export function getToolsByCategory(category: ToolCategory): ToolType[] {
  return Object.entries(toolRegistry)
    .filter(([_, tool]) => tool.category === category)
    .map(([toolType, _]) => toolType as ToolType)
}

// Export all tool types and configs for external use
export * from "./types"
export * from "./email"
export * from "./ai-agent"
export * from "./form"
export * from "./delay"
export * from "./slack"
export * from "./gmail"
export * from "./agent"
export * from "./merged-node"
export * from "./switch"
export * from "./manual-trigger"
export * from "./scheduler-trigger"
export * from "./webhook"
export * from "./http-request"
export * from "./jira"