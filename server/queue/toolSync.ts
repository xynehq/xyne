import { getLogger } from "@/logger"
import { Subsystem, type TxnOrClient } from "@/types"
import { boss } from "."
import { db, getConnectorByApp } from "@/db/connector"
import { syncConnectorTools } from "@/db/tool"
import { getErrorMessage } from "@/utils"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  syncJobDuration,
  syncJobError,
  syncJobSuccess,
} from "@/metrics/sync/sync-metrics"
import { Apps } from "@/search/types"

const Logger = getLogger(Subsystem.Queue).child({ module: "tool-sync" })

export const handleToolSync = async () => {
  const startTime = Date.now()
  try {
    Logger.info("Starting tool synchronization job")

    await db.transaction(async (trx: TxnOrClient) => {
      const connector = await getConnectorByApp(trx, Apps.GITHUB_MCP)

      Logger.info({ connector }, "Connector found")

      const client = new Client({
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

    const endTime = Date.now()
    syncJobSuccess.inc({ sync_job_name: "tool-sync" }, 1)
    syncJobDuration.observe({ sync_job_name: "tool-sync" }, endTime - startTime)
    Logger.info("Tool synchronization job finished successfully")
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    Logger.error(
      error,
      `Unhandled error while syncing tools: ${errorMessage} ${(error as Error).stack}`,
    )
    syncJobError.inc(
      {
        sync_job_name: "tool-sync",
        sync_job_error_type: `${errorMessage}`,
      },
      1,
    )
  }
}
