/**
 * listCustomAgents tool - pi-mono version
 *
 * Lists available custom agents that can be delegated to
 * Includes both regular custom agents and MCP virtual agents
 */

import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"
import { listCustomAgentsSuitable } from "../agent-selection"
import { ReasoningSteps, emitReasoningEvent } from "@/api/chat/reasoning-steps"
import { getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"

const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

const listCustomAgentsParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Optional search query to filter agents by name or description",
    }),
  ),
  requiredCapabilities: Type.Optional(
    Type.Array(Type.String(), {
      description: "Required capabilities for the agent",
    }),
  ),
  maxAgents: Type.Optional(
    Type.Number({
      description: "Maximum number of agents to return",
      default: 5,
    }),
  ),
})

export const listCustomAgentsTool = createXyneTool(
  "listCustomAgents",
  "List available custom AI agents that can be delegated to for specialized tasks. Use this when you need to find an agent with specific capabilities.",
  listCustomAgentsParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    const { xyneState, persistState, runtime } = ctx
    const logger = loggerWithChild({ email: xyneState.user.email })

    try {
      // Emit searching event
      if (runtime?.emitReasoning) {
        await runtime.emitReasoning(ReasoningSteps.agentSearching())
      }

      logger.info(
        {
          query: params.query,
          requiredCapabilities: params.requiredCapabilities,
          maxAgents: params.maxAgents,
          availableMcpAgents: xyneState.mcpAgents.length,
        },
        "[listCustomAgents] Searching for suitable agents",
      )

      // Call the selection logic
      const result = await listCustomAgentsSuitable({
        query: params.query || xyneState.message.text || "",
        userEmail: xyneState.user.email,
        workspaceExternalId: xyneState.user.workspaceId,
        workspaceNumericId: xyneState.user.workspaceNumericId,
        userId: parseInt(xyneState.user.id),
        requiredCapabilities: params.requiredCapabilities,
        maxAgents: params.maxAgents,
        mcpAgents: xyneState.mcpAgents,
      })

      // Store the available agents in state
      if (result.agents) {
        xyneState.availableAgents = result.agents.map((agent) => ({
          agentId: agent.agentId,
          agentName: agent.agentName,
          description: agent.description,
          capabilities: agent.capabilities,
        }))

        // Persist state changes
        await persistState()

        logger.info(
          {
            agentCount: result.agents.length,
            agentIds: result.agents.map((a) => a.agentId),
            totalEvaluated: result.totalEvaluated,
          },
          "[listCustomAgents] Found suitable agents",
        )

        // Emit agents found event
        if (runtime?.emitReasoning) {
          await runtime.emitReasoning(
            ReasoningSteps.agentsFound(
              result.agents.length,
              result.agents.map((a) => a.agentName),
            ),
          )
        }
      } else {
        logger.info(
          { totalEvaluated: result.totalEvaluated },
          "[listCustomAgents] No suitable agents found",
        )

        // Emit no agents found event
        if (runtime?.emitReasoning) {
          await runtime.emitReasoning(ReasoningSteps.agentsFound(0, undefined))
        }
      }

      // Format the response
      const agentList = result.agents
        ? result.agents
            .map(
              (agent, idx) =>
                `${idx + 1}. ${agent.agentName} (${agent.agentId})
Description: ${agent.description || "N/A"}
Capabilities: ${agent.capabilities.join(", ") || "N/A"}
Suitability: ${Math.round(agent.suitabilityScore * 100)}%
Confidence: ${Math.round(agent.confidence * 100)}%`,
            )
            .join("\n\n")
        : "No suitable agents found."

      const summaryText = result.agents
        ? `Found ${result.agents.length} suitable agent${result.agents.length === 1 ? "" : "s"} out of ${result.totalEvaluated} evaluated.`
        : `No suitable agents found out of ${result.totalEvaluated} evaluated.`

      return {
        content: [
          {
            type: "text",
            text: `${summaryText}\n\n${agentList}`,
          },
        ],
        details: {
          toolName: "listCustomAgents",
          agents: result.agents,
          totalEvaluated: result.totalEvaluated,
          query: params.query,
          requiredCapabilities: params.requiredCapabilities,
        },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      logger.error(error, "[listCustomAgents] Failed to list agents")

      return {
        content: [
          {
            type: "text",
            text: `Failed to list custom agents: ${errMsg}`,
          },
        ],
        isError: true,
        details: {
          toolName: "listCustomAgents",
          error: errMsg,
        },
      }
    }
  },
)
