/**
 * Pi-Mono Tools Registration for Chat V2
 *
 * Registers all pi-mono tools with the chat-v2 tool registry.
 * This makes pi-mono tools available for agentic chat in the new architecture.
 */

import { ToolCategory } from "../tool.interface"
import { ToolRegistry } from "../tool-registry"
import { adaptPiMonoTool } from "../pi-mono-tool-adapter"

// Import all pi-mono tools
import {
  searchGlobalTool,
  searchGmailTool,
  searchDriveFilesTool,
  searchCalendarEventsTool,
  searchGoogleContactsTool,
  getSlackRelatedMessagesTool,
  lsKnowledgeBaseTool,
  searchKnowledgeBaseTool,
  searchChatHistoryTool,
  listCustomAgentsTool,
  runPublicAgentTool,
  toDoWriteTool,
  fallBackTool,
  synthesizeFinalAnswerTool,
  askForClarificationTool,
} from "@/api/chat/pi-mono/tools"

/**
 * Register all pi-mono tools with a chat-v2 tool registry
 */
export function registerPiMonoTools(registry: ToolRegistry): void {
  // Search tools
  registry.register(
    adaptPiMonoTool(searchGlobalTool, ToolCategory.Search),
  )
  registry.register(
    adaptPiMonoTool(searchGmailTool, ToolCategory.Search),
  )
  registry.register(
    adaptPiMonoTool(searchDriveFilesTool, ToolCategory.Search),
  )
  registry.register(
    adaptPiMonoTool(searchCalendarEventsTool, ToolCategory.Search),
  )
  registry.register(
    adaptPiMonoTool(searchGoogleContactsTool, ToolCategory.Search),
  )
  registry.register(
    adaptPiMonoTool(getSlackRelatedMessagesTool, ToolCategory.Search),
  )
  registry.register(
    adaptPiMonoTool(lsKnowledgeBaseTool, ToolCategory.Retrieval),
  )
  registry.register(
    adaptPiMonoTool(searchKnowledgeBaseTool, ToolCategory.Search),
  )
  registry.register(
    adaptPiMonoTool(searchChatHistoryTool, ToolCategory.Search),
  )

  // Agent delegation tools
  registry.register(
    adaptPiMonoTool(listCustomAgentsTool, ToolCategory.Delegation),
  )
  registry.register(
    adaptPiMonoTool(runPublicAgentTool, ToolCategory.Delegation),
  )

  // Control flow tools
  registry.register(
    adaptPiMonoTool(toDoWriteTool, ToolCategory.Utility),
  )
  registry.register(
    adaptPiMonoTool(fallBackTool, ToolCategory.Utility),
  )
  registry.register(
    adaptPiMonoTool(synthesizeFinalAnswerTool, ToolCategory.Generation),
  )
  registry.register(
    adaptPiMonoTool(askForClarificationTool, ToolCategory.Utility),
  )

  console.log(`[PiMonoTools] Registered ${registry.count} tools`)
}

/**
 * Create a tool registry with all pi-mono tools pre-registered
 */
export function createPiMonoToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registerPiMonoTools(registry)
  return registry
}
