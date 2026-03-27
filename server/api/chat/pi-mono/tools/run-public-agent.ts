/**
 * runPublicAgent tool - pi-mono version
 *
 * Delegates execution to a specific custom agent or MCP virtual agent
 */

import { Type } from "@sinclair/typebox"
import { generateRunId } from "@xynehq/jaf"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"
import {
  runDelegatedAgentWithPiMono,
  buildDelegatedAgentQuery,
} from "../delegated-agent-runner"
import { ReasoningSteps, emitReasoningEvent } from "@/api/chat/reasoning-steps"
import { getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"

const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

const runPublicAgentParams = Type.Object({
  agentId: Type.String({
    description: "The unique identifier of the agent to run",
    minLength: 1,
  }),
  query: Type.String({
    description: "The task or query to delegate to the agent",
    minLength: 1,
  }),
  context: Type.Optional(
    Type.String({
      description: "Additional context to pass to the agent",
    }),
  ),
  maxTokens: Type.Optional(
    Type.Number({
      description: "Maximum tokens for the agent response",
    }),
  ),
})

export const runPublicAgentTool = createXyneTool(
  "runPublicAgent",
  "Delegate execution to a specific custom AI agent. Use this after selecting an agent from listCustomAgents to perform specialized tasks.",
  runPublicAgentParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    const { xyneState, persistState, runtime } = ctx
    const logger = loggerWithChild({ email: xyneState.user.email })

    try {
      // Check if agent exists and hasn't been used
      const agent = xyneState.availableAgents.find(
        (a) => a.agentId === params.agentId,
      )

      // Handle MCP virtual agents (they won't be in availableAgents)
      const isMcpAgent = params.agentId.startsWith("mcp:")

      if (!agent && !isMcpAgent) {
        return {
          content: [
            {
              type: "text",
              text: `Agent ${params.agentId} not found or not available. Available agents: ${xyneState.availableAgents.map((a) => a.agentName).join(", ") || "none"}`,
            },
          ],
          isError: true,
          details: {
            toolName: "runPublicAgent",
            error: "Agent not found",
            availableAgentIds: xyneState.availableAgents.map((a) => a.agentId),
          },
        }
      }

      // Check if already used (for regular agents)
      if (!isMcpAgent && xyneState.usedAgents.includes(params.agentId)) {
        return {
          content: [
            {
              type: "text",
              text: `Agent ${agent?.agentName || params.agentId} has already been used in this conversation.`,
            },
          ],
          isError: true,
          details: {
            toolName: "runPublicAgent",
            error: "Agent already used",
            usedAgents: xyneState.usedAgents,
          },
        }
      }

      // Check ambiguity is resolved
      if (!xyneState.ambiguityResolved) {
        const clarifications = xyneState.clarifications
          .map((c) => `Q: ${c.question}`)
          .join("; ")
        return {
          content: [
            {
              type: "text",
              text: `Resolve ambiguity before running a custom agent. Unresolved: ${clarifications || "not specified"}`,
            },
          ],
          isError: true,
          details: {
            toolName: "runPublicAgent",
            error: "Ambiguity not resolved",
            clarifications: xyneState.clarifications,
          },
        }
      }

      // Generate delegation ID (unique per call)
      const delegationRunId = generateRunId()

      // Emit agent delegated event via runtime
      if (runtime?.emitReasoning) {
        const agentName =
          agent?.agentName ||
          (isMcpAgent
            ? params.agentId.replace(/^mcp:/, "MCP:")
            : params.agentId)

        await runtime.emitReasoning({
          ...ReasoningSteps.agentDelegated(agentName, delegationRunId),
          agent: agentName,
          delegationRunId,
          parentAgent: "Main",
        })
      }

      // Build enriched query with context
      const enrichedQuery = buildDelegatedAgentQuery(
        params.query,
        params.context
          ? {
              ...xyneState,
              message: { ...xyneState.message, text: params.context },
            }
          : xyneState,
      )

      logger.info(
        {
          agentId: params.agentId,
          query: enrichedQuery.substring(0, 100),
          delegationRunId,
          isMcpAgent,
        },
        "[runPublicAgent] Executing delegated agent",
      )

      // Execute the agent
      const result = await runDelegatedAgentWithPiMono({
        agentId: params.agentId,
        query: enrichedQuery,
        userEmail: xyneState.user.email,
        workspaceExternalId: xyneState.user.workspaceId,
        maxTokens: params.maxTokens,
        parentTurn: undefined, // Could track turns in future
        mcpAgents: xyneState.mcpAgents,
        stopSignal: signal,
        reasoningEmitter: runtime?.emitReasoning
          ? async (payload) => {
              const agentName =
                agent?.agentName ||
                (isMcpAgent
                  ? params.agentId.replace(/^mcp:/, "MCP:")
                  : params.agentId)
              await runtime.emitReasoning!({
                ...payload,
                agent: agentName,
                delegationRunId,
                parentAgent: "Main",
              })
            }
          : undefined,
        delegationRunId,
        parentXyneState: xyneState,
      })

      // Mark agent as used (for regular agents)
      if (!isMcpAgent) {
        xyneState.usedAgents.push(params.agentId)
      }

      // Persist state changes
      await persistState()

      // Add returned fragments to parent state for citation
      if (result.contexts && result.contexts.length > 0) {
        for (const context of result.contexts) {
          // Check for duplicates
          const exists = xyneState.allFragments.some((f) => f.id === context.id)
          if (!exists) {
            xyneState.allFragments.push(context)
          }
        }

        logger.info(
          {
            fragmentCount: result.contexts.length,
            agentId: params.agentId,
          },
          "[runPublicAgent] Added fragments from delegated agent",
        )
      }

      // Format successful response
      return {
        content: [
          {
            type: "text",
            text: result.result,
          },
        ],
        details: {
          toolName: "runPublicAgent",
          agentId: params.agentId,
          agentName: agent?.agentName || params.agentId,
          query: params.query,
          context: params.context,
          delegated: true,
          delegationRunId,
          citations: result.metadata?.citations,
          imageCitations: result.metadata?.imageCitations,
          cost: result.metadata?.cost,
          tokensUsed: result.metadata?.tokensUsed,
        },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      logger.error(
        { error, agentId: params.agentId },
        "[runPublicAgent] Failed to execute agent",
      )

      return {
        content: [{ type: "text", text: `Failed to run agent: ${errMsg}` }],
        isError: true,
        details: {
          toolName: "runPublicAgent",
          error: errMsg,
          agentId: params.agentId,
        },
      }
    }
  },
)
