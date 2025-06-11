import type { SelectTool } from "@/db/schema/McpConnectors"
import { deleteToolById, getWorkspaceTools, upsertTool } from "@/db/tool"
import type { TxnOrClient } from "@/types"

import { and, eq } from "drizzle-orm"
import { z } from "zod"

//todo: refactor this file to use the new tool schema
/**
 * Synchronize tools for a client with the database
 * This will add new tools, update existing ones, and remove tools that are no longer available
 */
// export const syncClientTools = async (
//   trx: TxnOrClient,
//   workspaceId: number,
//   clientName: string,
//   currentTools: Array<{
//     toolName: string
//     toolSchema: string
//     description?: string
//   }>,
// ): Promise<void> => {
//   // 1. Get existing tools for this client from the database
//   const existingTools = await getToolsByClient(trx, workspaceId, clientName)

//   // Create sets for efficient lookup
//   const existingToolNames = new Set(existingTools.map((tool) => tool.toolName))
//   const currentToolNames = new Set(currentTools.map((tool) => tool.toolName))

//   // 2. Add or update tools
//   for (const tool of currentTools) {
//     await upsertTool(trx, {
//       workspaceId,
//       clientName,
//       toolName: tool.toolName,
//       toolSchema: tool.toolSchema,
//       description: tool.description || null,
//     })
//   }

//   // 3. Find tools that need to be removed (in DB but not in current list)
//   const toolsToRemove = existingTools.filter(
//     (tool) => !currentToolNames.has(tool.toolName),
//   )

//   // 4. Remove tools that are no longer available
//   for (const tool of toolsToRemove) {
//     await deleteToolById(trx, tool.id)
//   }
// }

/**
 * Synchronize tools for multiple clients
 * Useful when you have tools from multiple clients to sync at once
 */
// export const syncMultipleClientTools = async (
//   trx: TxnOrClient,
//   workspaceId: number,
//   clientTools: Record<
//     string,
//     Array<{
//       toolName: string
//       toolSchema: string
//       description?: string
//     }>
//   >,
// ): Promise<void> => {
//   for (const [clientName, tools] of Object.entries(clientTools)) {
//     await syncClientTools(trx, workspaceId, clientName, tools)
//   }
// }

/**
 * Get all tools formatted for LLM prompt
 * Returns a structured prompt section with all available tools by client
 */
// export const getToolsPrompt = async (
//   trx: TxnOrClient,
//   workspaceId: number,
// ): Promise<string> => {
//   const allTools = await getWorkspaceTools(trx, workspaceId)

//   if (!allTools.length) {
//     return ""
//   }

//   // Group tools by client
//   const toolsByClient: Record<string, Array<SelectTool>> = {}

//   for (const tool of allTools) {
//     if (!toolsByClient[tool.clientName]) {
//       toolsByClient[tool.clientName] = []
//     }
//     toolsByClient[tool.clientName].push(tool)
//   }

//   // Build the prompt
//   let prompt = "AVAILABLE_TOOLS\n\n"

//   for (const [clientName, clientTools] of Object.entries(toolsByClient)) {
//     prompt += `# Client: ${clientName}\n\n`

//     for (const tool of clientTools) {
//       prompt += `## Tool: ${tool.toolName}\n`
//       if (tool.description) {
//         prompt += `Description: ${tool.description}\n`
//       }
//       prompt += `${tool.toolSchema}\n\n`
//     }
//   }

//   return prompt
// }
