/**
 * listCustomAgents tool - pi-mono version
 *
 * Lists available custom agents that can be delegated to
 */

import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"

const listCustomAgentsParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Optional search query to filter agents by name or description",
    }),
  ),
})

export const listCustomAgentsTool = createXyneTool(
  "listCustomAgents",
  "List available custom AI agents that can be delegated to for specialized tasks. Use this when you need to find an agent with specific capabilities.",
  listCustomAgentsParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    const { xyneState, persistState } = ctx

    try {
      // Return the available agents from state
      const agents = xyneState.availableAgents || []

      // Filter by query if provided
      const filteredAgents = params.query
        ? agents.filter(
            (agent) =>
              agent.agentName
                .toLowerCase()
                .includes(params.query!.toLowerCase()) ||
              (agent.description
                ?.toLowerCase()
                .includes(params.query!.toLowerCase()) ??
                false),
          )
        : agents

      return {
        content: [
          {
            type: "text",
            text: `Found ${filteredAgents.length} available custom agents.`,
          },
        ],
        details: {
          agents: filteredAgents.map((agent) => ({
            agentId: agent.agentId,
            agentName: agent.agentName,
            description: agent.description,
            capabilities: agent.capabilities,
          })),
          query: params.query,
          toolName: "listCustomAgents",
        },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      return {
        content: [
          { type: "text", text: `Failed to list custom agents: ${errMsg}` },
        ],
        isError: true,
        details: { toolName: "listCustomAgents", error: errMsg },
      }
    }
  },
)
