import type { TxnOrClient } from "@/types"
import { createId } from "@paralleldrive/cuid2"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import {
  selectToolSchema,
  tools,
  type InsertTool,
  type SelectTool,
} from "./schema/McpConnectors"
export { tools } // Re-export the 'tools' table schema object
const Logger = getLogger(Subsystem.Db).child({ module: "tool" })

/**
 * Insert a new tool into the database
 */
export const insertTool = async (
  trx: TxnOrClient,
  tool: Omit<InsertTool, "id">,
): Promise<SelectTool> => {
  const toolWithExternalId = { ...tool, externalId: createId() }
  const toolArr = await trx.insert(tools).values(toolWithExternalId).returning()

  if (!toolArr || !toolArr.length) {
    throw new Error('Error in insert of tool "returning"')
  }

  const parsedData = selectToolSchema.safeParse(toolArr[0])
  if (!parsedData.success) {
    throw new Error(
      `Could not get tool after inserting: ${parsedData.error.toString()}`,
    )
  }

  return parsedData.data
}

/**
 * Get all tools for a workspace
 */
export const getWorkspaceTools = async (
  trx: TxnOrClient,
  workspaceId: number,
): Promise<SelectTool[]> => {
  const toolRecords = await trx
    .select()
    .from(tools)
    .where(eq(tools.workspaceId, workspaceId))

  return z.array(selectToolSchema).parse(toolRecords)
}

/**
 * Get tools filtered by connector Id
 */
export const getToolsByConnectorId = async (
  trx: TxnOrClient,
  workspaceId: number,
  connectorId: number,
): Promise<SelectTool[]> => {
  const toolRecords = await trx
    .select()
    .from(tools)
    .where(
      and(
        eq(tools.workspaceId, workspaceId),
        eq(tools.connectorId, connectorId),
      ),
    )

  return z.array(selectToolSchema).parse(toolRecords)
}

/**
 * Get tools filtered by tool name
 */
export const getToolsByName = async (
  trx: TxnOrClient,
  workspaceId: number,
  toolName: string,
): Promise<SelectTool[]> => {
  const toolRecords = await trx
    .select()
    .from(tools)
    .where(
      and(eq(tools.workspaceId, workspaceId), eq(tools.toolName, toolName)),
    )

  return z.array(selectToolSchema).parse(toolRecords)
}

/**
 * Get a specific tool by connector Id and tool name
 */
export const getToolByConnectorIdAndToolName = async (
  trx: TxnOrClient,
  workspaceId: number,
  connectorId: number,
  toolName: string,
): Promise<SelectTool | null> => {
  const toolRecords = await trx
    .select()
    .from(tools)
    .where(
      and(
        eq(tools.workspaceId, workspaceId),
        eq(tools.connectorId, connectorId),
        eq(tools.toolName, toolName),
      ),
    )

  if (!toolRecords || !toolRecords.length) {
    return null
  }

  return selectToolSchema.parse(toolRecords[0])
}

/**
 * Update an existing tool
 */
export const updateTool = async (
  trx: TxnOrClient,
  toolId: number,
  updateData: Partial<Omit<InsertTool, "id" | "workspaceId">>,
): Promise<SelectTool> => {
  const updatedTools = await trx
    .update(tools)
    .set({
      ...updateData,
      updatedAt: new Date(),
    })
    .where(eq(tools.id, toolId))
    .returning()

  if (!updatedTools || !updatedTools.length) {
    throw new Error("Could not update the tool")
  }

  const [toolVal] = updatedTools
  const parsedRes = selectToolSchema.safeParse(toolVal)

  if (!parsedRes.success) {
    throw new Error(`zod error: Invalid tool: ${parsedRes.error.toString()}`)
  }

  return parsedRes.data
}

/**
 * Delete a tool by ID
 */
export const deleteToolById = async (
  trx: TxnOrClient,
  toolId: number,
): Promise<void> => {
  await trx.delete(tools).where(eq(tools.id, toolId))
}

/**
 * Delete tools by connector Id
 * Useful when removing a connector and all its associated tools
 */
export const deleteToolsByConnectorId = async (
  trx: TxnOrClient,
  workspaceId: number,
  connectorId: number,
): Promise<number> => {
  const result = await trx
    .delete(tools)
    .where(
      and(
        eq(tools.workspaceId, workspaceId),
        eq(tools.connectorId, connectorId),
      ),
    )
    .returning({ id: tools.id })

  return result.length // Return number of deleted records
}

/**
 * Check if a tool exists by connector id and tool name
 */
export const toolExists = async (
  trx: TxnOrClient,
  workspaceId: number,
  connectorId: number,
  toolName: string,
): Promise<boolean> => {
  const result = await trx
    .select({ id: tools.id })
    .from(tools)
    .where(
      and(
        eq(tools.workspaceId, workspaceId),
        eq(tools.connectorId, connectorId),
        eq(tools.toolName, toolName),
      ),
    )

  return result.length > 0
}

/**
 * Upsert a tool (create if it doesn't exist, update if it does)
 */
export const upsertTool = async (
  trx: TxnOrClient,
  tool: Omit<InsertTool, "id">,
): Promise<SelectTool> => {
  const { workspaceId, connectorId, toolName, externalId } = tool

  const existingTool = await getToolByConnectorIdAndToolName(
    trx,
    workspaceId,
    connectorId,
    toolName,
  )

  if (existingTool) {
    // Update existing tool
    return updateTool(trx, existingTool.id, {
      toolSchema: tool.toolSchema,
      description: tool.description,
    })
  } else {
    // Create new tool
    return insertTool(trx, { ...tool, externalId: externalId || createId() })
  }
}

/**
 * Get all tool schemas for a specific connector as a combined string
 * Useful for building prompts with available tools
 */
export const getConnectorToolSchemasAsString = async (
  trx: TxnOrClient,
  workspaceId: number,
  connectorId: number,
): Promise<string> => {
  const clientTools = await getToolsByConnectorId(trx, workspaceId, connectorId)

  if (!clientTools.length) {
    return ""
  }

  // Combine all tool schemas with newlines
  return clientTools
    .map((tool) => `## Tool: ${tool.toolName}\n${tool.toolSchema}`)
    .join("\n\n")
}

/**
 * Get all tool schemas as a structured object by connector
 * For building the finalToolsList that was used in previous examples
 */
export const getAllToolSchemasByConnectorId = async (
  trx: TxnOrClient,
  workspaceId: number,
): Promise<Record<string, { tools: { name: string; schema: string }[] }>> => {
  const allTools = await getWorkspaceTools(trx, workspaceId)

  const toolsByConnector: Record<
    string,
    { tools: { name: string; schema: string }[] }
  > = {}

  // Group tools by connector
  for (const tool of allTools) {
    const { connectorId, toolName, toolSchema } = tool

    if (!toolsByConnector[connectorId]) {
      toolsByConnector[connectorId] = { tools: [] }
    }

    toolsByConnector[connectorId].tools.push({
      name: toolName,
      schema: toolSchema,
    })
  }

  return toolsByConnector
}

/**
 * Synchronize tools for a connector with the database
 * This will add new tools, update existing ones, and remove tools that are no longer available
 *
 * @param trx - Database transaction or client
 * @param workspaceId - Workspace ID
 * @param connectorId - Connector ID
 * @param currentTools - Array of current tools from the connector API
 * @returns Promise<void>
 */
export const syncConnectorTools = async (
  trx: TxnOrClient,
  workspaceId: number,
  connectorId: number,
  currentTools: Array<{
    toolName: string
    toolSchema: string
    description?: string
  }>,
): Promise<void> => {
  try {
    // Step 1: Get existing tools for this connector from the database
    const existingTools = await getToolsByConnectorId(
      trx,
      workspaceId,
      connectorId,
    )

    // Create a map of existing tool names for efficient lookup
    const existingToolMap = new Map(
      existingTools.map((tool) => [tool.toolName, tool]),
    )

    // Create a set of current tool names for efficient lookup
    const currentToolNames = new Set(currentTools.map((tool) => tool.toolName))

    // Step 2: Add or update tools
    const upsertPromises = currentTools.map((tool) =>
      upsertTool(trx, {
        workspaceId,
        connectorId,
        externalId: createId(), // Add this line
        toolName: tool.toolName,
        toolSchema: tool.toolSchema,
        description: tool.description || null,
      }),
    )

    // Wait for all upsert operations to complete
    await Promise.all(upsertPromises)

    // Step 3: Identify tools that need to be removed (in DB but not in current list)
    const toolsToRemove = existingTools.filter(
      (tool) => !currentToolNames.has(tool.toolName),
    )

    // Step 4: Remove tools that are no longer available
    if (toolsToRemove.length > 0) {
      const deletePromises = toolsToRemove.map((tool) =>
        deleteToolById(trx, tool.id),
      )

      // Wait for all delete operations to complete
      await Promise.all(deletePromises)

      // Log the removal of tools
      Logger.info(
        `Removed ${toolsToRemove.length} obsolete tools for connector ${connectorId} in workspace ${workspaceId}`,
      )
    }

    // Log the sync summary
    Logger.info(
      `Synced tools for connector ${connectorId} in workspace ${workspaceId}: ` +
        `${currentTools.length} current tools, ${toolsToRemove.length} removed`,
    )
  } catch (error) {
    // Log and rethrow the error
    Logger.error(
      error,
      `Failed to sync tools for connector ${connectorId} in workspace ${workspaceId}`,
    )
    throw new Error(`Tool synchronization failed: ${(error as Error).message}`)
  }
}

/**
 * Synchronize tools for multiple connectors
 * Useful when you have tools from multiple connectors to sync at once
 */
export const syncMultipleConnectorTools = async (
  trx: TxnOrClient,
  workspaceId: number,
  connectorTools: Record<
    number,
    Array<{
      toolName: string
      toolSchema: string
      description?: string
    }>
  >,
): Promise<void> => {
  // Process each connector's tools
  const syncPromises = Object.entries(connectorTools).map(
    ([connectorId, tools]) =>
      syncConnectorTools(trx, workspaceId, parseInt(connectorId), tools),
  )

  // Wait for all synchronization operations to complete
  await Promise.all(syncPromises)

  Logger.info(
    `Completed tool synchronization for ${Object.keys(connectorTools).length} connectors in workspace ${workspaceId}`,
  )
}
