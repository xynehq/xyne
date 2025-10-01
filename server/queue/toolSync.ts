import { getLogger } from "@/logger"
import { Subsystem, type TxnOrClient } from "@/types"
import { db, getConnectorByApp } from "@/db/connector"
import { syncConnectorTools } from "@/db/tool"
import { getErrorMessage } from "@/utils"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { Apps } from "@/shared/types"

const Logger = getLogger(Subsystem.Queue).child({ module: "tool-sync" })

export const handleToolSync = async () => {
  let client: Client | null = null
  try {
    Logger.info("Starting tool synchronization job")

    await db.transaction(async (trx: TxnOrClient) => {
      const connector = await getConnectorByApp(trx, Apps.Github)

      Logger.info({ connector }, "Connector found")

      client = new Client({
        name: `connector-${connector.id}`,
        version: connector.config.version,
      })
      await client.connect(
        new StdioClientTransport({
          command: connector.config.command,
          args: connector.config.args,
        }),
      )
      const response = await client.listTools()
      const clientTools = response.tools
      await syncConnectorTools(
        trx,
        connector.workspaceId,
        connector.id,
        clientTools.map((tool) => ({
          toolName: tool.name,
          description: tool.description,
          toolSchema: JSON.stringify(tool.inputSchema),
        })),
      )
    })

    Logger.info("Tool synchronization job finished successfully")
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    Logger.error(
      error,
      `Unhandled error while syncing tools: ${errorMessage} ${(error as Error).stack}`,
    )
    throw error
  } finally {
    if (client) {
      try {
        await (client as Client)?.close()
      } catch (closeError) {
        Logger.warn(closeError, "Failed to close MCP client")
      }
    }
  }
}
