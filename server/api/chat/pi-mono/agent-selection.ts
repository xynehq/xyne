/**
 * Agent Selection for Pi-Mono
 *
 * Lists and selects custom agents suitable for a given query
 * Includes both regular custom agents and MCP virtual agents
 */

import { getUserAccessibleAgents } from "@/db/userAgentPermission"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"
import {
  getUserConnectorState,
  createEmptyConnectorState,
} from "@/api/chat/resource-access"
import { getProviderByModel, jsonParseLLMOutput } from "@/ai/provider"
import { Models, type ModelParams } from "@/ai/types"
import { ConversationRole, type Message } from "@aws-sdk/client-bedrock-runtime"
import { getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import type { MCPVirtualAgentRuntime } from "./adapter"
import type { ToolOutput } from "@/api/chat/tool-schemas"

const { defaultFastModel, defaultBestModel } = config

const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

/**
 * Resource access summary for an agent
 */
export interface ResourceAccessSummary {
  app: string
  status: "available" | "missing" | "partial"
  availableItems?: string[]
  missingItems?: string[]
  note?: string
}

/**
 * Agent brief for LLM selection
 */
export interface AgentBrief {
  agentId: string
  agentName: string
  description: string
  capabilities: string[]
  domains: string[]
  estimatedCost: "low" | "medium" | "high"
  averageLatency: number
  isPublic: boolean
  resourceAccess?: ResourceAccessSummary[]
}

/**
 * Selected agent output
 */
export interface SelectedAgent {
  agentId: string
  agentName: string
  description: string
  capabilities: string[]
  domains: string[]
  suitabilityScore: number
  confidence: number
  estimatedCost: "low" | "medium" | "high"
  averageLatency: number
  resourceAccess?: ResourceAccessSummary[]
}

/**
 * List custom agents output
 */
export interface ListCustomAgentsOutput {
  agents: SelectedAgent[] | null
  totalEvaluated: number
}

/**
 * Parameters for listing custom agents
 */
export interface ListCustomAgentsParams {
  query: string
  userEmail: string
  workspaceExternalId: string
  workspaceNumericId?: number
  userId?: number
  requiredCapabilities?: string[]
  maxAgents?: number
  mcpAgents?: MCPVirtualAgentRuntime[]
}

/**
 * Extract integration keys from appIntegrations
 */
function extractIntegrationKeys(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry))
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
  }
  return []
}

/**
 * Derive domains from integrations
 */
function deriveDomainsFromIntegrations(integrations: string[]): string[] {
  if (!integrations.length) return ["generic"]
  return integrations.map((integration) => integration.toLowerCase())
}

/**
 * Evaluate agent resource access
 */
async function evaluateAgentResourceAccess(params: {
  agent: any
  userEmail: string
  connectorState: any
}): Promise<ResourceAccessSummary[]> {
  const summaries: ResourceAccessSummary[] = []
  const integrations = extractIntegrationKeys(params.agent.appIntegrations)

  for (const integration of integrations) {
    const integrationLower = integration.toLowerCase()
    let status: ResourceAccessSummary["status"] = "missing"
    const availableItems: string[] = []
    const missingItems: string[] = []

    // Map integration to connector flags
    const connectorMap: Record<string, string> = {
      gmail: "gmailSynced",
      google_drive: "googleDriveSynced",
      google_calendar: "googleCalendarSynced",
      google_workspace: "googleWorkspaceSynced",
      slack: "slackConnected",
    }

    const connectorFlag = connectorMap[integrationLower]
    if (connectorFlag) {
      if (params.connectorState[connectorFlag]) {
        status = "available"
        availableItems.push(integration)
      } else {
        status = "missing"
        missingItems.push(integration)
      }
    } else {
      // Unknown integration, mark as available (assume no connector needed)
      status = "available"
      availableItems.push(integration)
    }

    summaries.push({
      app: integration,
      status,
      availableItems: availableItems.length > 0 ? availableItems : undefined,
      missingItems: missingItems.length > 0 ? missingItems : undefined,
      note: status === "missing" ? "Connector not configured" : undefined,
    })
  }

  return summaries
}

/**
 * Build agent brief
 */
async function buildAgentBrief(
  agent: any,
  resourceAccess?: ResourceAccessSummary[],
): Promise<AgentBrief> {
  const integrations = extractIntegrationKeys(agent.appIntegrations)
  const domains = deriveDomainsFromIntegrations(integrations)
  const capabilities = integrations.length ? integrations : domains

  return {
    agentId: agent.externalId,
    agentName: agent.name,
    description: agent.description || "",
    capabilities,
    domains,
    estimatedCost: agent.allowWebSearch ? "high" : "medium",
    averageLatency: 4500,
    isPublic: agent.isPublic,
    resourceAccess,
  }
}

/**
 * Summarize resource access for prompt
 */
function summarizeResourceAccess(access?: ResourceAccessSummary[]): string {
  if (!access || access.length === 0) {
    return "unknown"
  }

  return access
    .map((entry) => {
      const detailParts: string[] = []
      if (entry.availableItems?.length) {
        detailParts.push(`${entry.availableItems.length} ok`)
      }
      if (entry.missingItems?.length) {
        detailParts.push(`${entry.missingItems.length} blocked`)
      }
      if (entry.note && detailParts.length === 0) {
        detailParts.push(entry.note)
      }
      const detail =
        detailParts.length > 0 ? ` (${detailParts.join(", ")})` : ""
      return `${entry.app}:${entry.status}${detail}`
    })
    .join("; ")
}

/**
 * Format agent briefs for LLM prompt
 */
function formatAgentBriefsForPrompt(briefs: AgentBrief[]): string {
  return briefs
    .map(
      (brief, idx) =>
        `${idx + 1}. ${brief.agentName} (${brief.agentId})
Description: ${brief.description || "N/A"}
Capabilities: ${brief.capabilities.join(", ") || "N/A"}
Domains: ${brief.domains.join(", ")}
Estimated cost: ${brief.estimatedCost}
Resource readiness: ${summarizeResourceAccess(brief.resourceAccess)}`,
    )
    .join("\n\n")
}

/**
 * Build heuristic agent selection (fallback when LLM fails)
 */
function buildHeuristicAgentSelection(
  briefs: AgentBrief[],
  query: string,
  maxAgents: number,
  totalEvaluated: number,
): ListCustomAgentsOutput {
  const tokens = query.toLowerCase().split(/\s+/)
  const scored = briefs.map((brief) => {
    const text =
      `${brief.agentName} ${brief.description} ${brief.capabilities.join(" ")}`.toLowerCase()
    const baseScore =
      tokens.reduce((acc, token) => (text.includes(token) ? acc + 1 : acc), 0) /
      Math.max(tokens.length, 1)
    const penalty = brief.resourceAccess?.some(
      (entry) => entry.status === "missing",
    )
      ? 0.3
      : brief.resourceAccess?.some((entry) => entry.status === "partial")
        ? 0.15
        : 0
    const score = Math.max(baseScore - penalty, 0)
    return { brief, score }
  })

  const selected = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxAgents)
    .map(({ brief, score }) => ({
      agentId: brief.agentId,
      agentName: brief.agentName,
      description: brief.description,
      capabilities: brief.capabilities,
      domains: brief.domains,
      suitabilityScore: Math.min(Math.max(score, 0.2), 1),
      confidence: Math.min(Math.max(score + 0.1, 0.3), 1),
      estimatedCost: brief.estimatedCost,
      averageLatency: brief.averageLatency,
      resourceAccess: brief.resourceAccess,
    }))

  return {
    agents: selected.length ? selected : null,
    totalEvaluated,
  }
}

/**
 * List custom agents suitable for a query
 */
export async function listCustomAgentsSuitable(
  params: ListCustomAgentsParams,
): Promise<ListCustomAgentsOutput> {
  const logger = loggerWithChild({ email: params.userEmail })
  const maxAgents = Math.min(Math.max(params.maxAgents ?? 5, 1), 10)

  let workspaceDbId = params.workspaceNumericId
  let userDbId = params.userId

  // Load user/workspace if IDs not provided
  if (!workspaceDbId || !userDbId) {
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      params.workspaceExternalId,
      params.userEmail,
    )
    workspaceDbId = Number(userAndWorkspace.workspace.id)
    userDbId = Number(userAndWorkspace.user.id)
  }

  // Get accessible agents from DB
  const accessibleAgents = await getUserAccessibleAgents(
    db,
    userDbId!,
    workspaceDbId!,
    25,
    0,
  )

  // Get connector state
  let connectorState = createEmptyConnectorState()
  try {
    connectorState = await getUserConnectorState(db, params.userEmail)
  } catch (error) {
    logger.warn(error, "Failed to load connector state")
  }

  // Build briefs for regular agents
  const resourceAccessByAgent = new Map<string, ResourceAccessSummary[]>()
  const briefs = await Promise.all(
    accessibleAgents.map(async (agent) => {
      let resourceAccess: ResourceAccessSummary[] = []
      try {
        resourceAccess = await evaluateAgentResourceAccess({
          agent,
          userEmail: params.userEmail,
          connectorState,
        })
      } catch (error) {
        logger.warn(error, "Failed to evaluate resource access", {
          agentId: agent.externalId,
        })
      }
      resourceAccessByAgent.set(String(agent.externalId), resourceAccess)
      return buildAgentBrief(agent, resourceAccess)
    }),
  )

  // Build briefs for MCP virtual agents
  const mcpBriefs: AgentBrief[] =
    params.mcpAgents?.map((agent) => ({
      agentId: agent.agentId,
      agentName: agent.connectorName || `Connector ${agent.connectorId}`,
      description:
        agent.description ||
        `MCP agent wrapping ${agent.tools.length} tool${agent.tools.length === 1 ? "" : "s"}.`,
      capabilities: agent.tools.map((t) => t.toolName),
      domains: ["mcp"],
      estimatedCost: "medium",
      averageLatency: 4500,
      isPublic: true,
      resourceAccess: [], // MCP agents don't have resource access constraints
    })) || []

  // Combine all briefs
  const combinedBriefs = [...briefs, ...mcpBriefs]
  const totalEvaluated = accessibleAgents.length + mcpBriefs.length

  // If no agents found, return empty
  if (combinedBriefs.length === 0) {
    return {
      agents: null,
      totalEvaluated: 0,
    }
  }

  // Use LLM for selection
  const systemPrompt = [
    "You are routing queries to the best custom agent.",
    "Return JSON with keys agents (array|null) and totalEvaluated.",
    "Each agent entry must include: agentId, agentName, description, capabilities[], domains[], suitabilityScore (0-1), confidence (0-1), estimatedCost ('low'|'medium'|'high'), averageLatency (ms).",
    `Select up to ${maxAgents} agents.`,
    "If no agent is unquestionably suitable, set agents to null.",
    "Only include an agent when you can cite concrete capability matches; otherwise leave it out.",
    "You may return multiple agents when several are clearly relevant—rank the strongest ones first.",
  ].join(" ")

  const payload = [
    `User Query: ${params.query}`,
    params.requiredCapabilities?.length
      ? `Required capabilities: ${params.requiredCapabilities.join(", ")}`
      : "Required capabilities: none specified",
    "Agents:",
    formatAgentBriefsForPrompt(combinedBriefs),
  ].join("\n\n")

  const modelId = (defaultFastModel as Models) || (defaultBestModel as Models)

  const modelParams: ModelParams = {
    modelId,
    json: true,
    stream: false,
    temperature: 0,
    max_new_tokens: 800,
    systemPrompt,
  }

  try {
    const messages: Message[] = [
      {
        role: ConversationRole.USER,
        content: [{ text: payload }],
      },
    ]

    const provider = getProviderByModel(modelId)
    const { text } = await provider.converse(messages, modelParams)

    const parsed = jsonParseLLMOutput(text || "")

    // Validate the output structure
    if (
      parsed &&
      typeof parsed === "object" &&
      "agents" in parsed &&
      (parsed.agents === null || Array.isArray(parsed.agents))
    ) {
      const trimmedAgentsRaw = parsed.agents
        ? (parsed.agents as any[]).slice(0, maxAgents)
        : []
      const trimmedAgents =
        trimmedAgentsRaw.length > 0 ? trimmedAgentsRaw : null

      // Enrich with resource access
      const enrichedAgents = trimmedAgents
        ? trimmedAgents.map((agent) => ({
            ...agent,
            resourceAccess: resourceAccessByAgent.get(agent.agentId) ?? [],
          }))
        : null

      return {
        agents: enrichedAgents,
        totalEvaluated,
      }
    }

    logger.warn(
      { parsed },
      "LLM agent selection output invalid structure, falling back to heuristic",
    )
  } catch (error) {
    logger.error(error, "LLM agent selection failed, falling back to heuristic")
  }

  // Fallback to heuristic selection
  logger.info(
    {
      query: params.query,
      totalAgents: combinedBriefs.length,
      maxAgents,
    },
    "Using heuristic agent selection (LLM-based selection not available or failed)",
  )

  return buildHeuristicAgentSelection(
    combinedBriefs,
    params.query,
    maxAgents,
    totalEvaluated,
  )
}
