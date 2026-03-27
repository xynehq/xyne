/**
 * Agent Context Assembler
 *
 * Assembles context for agentic chat mode
 * Includes agent configuration, allowed apps, constraints
 */

import {
  BaseContextAssembler,
  type RequestContext,
} from "./context-assembler.interface"
import type {
  AssembledChatContext,
  AgentConfig,
  ResourceConstraints,
} from "../../../models"
import { Apps } from "@xyne/vespa-ts/types"

export interface AgentContextAssemblyOptions {
  /** Load agent configuration by ID */
  agentId: string
  /** Include resource constraints */
  includeConstraints?: boolean
  /** Include allowed apps */
  includeAllowedApps?: boolean
}

export class AgentContextAssembler extends BaseContextAssembler {
  private agentOptions: AgentContextAssemblyOptions

  constructor(
    baseOptions: import("./context-assembler.interface").ContextAssemblyOptions,
    agentOptions: AgentContextAssemblyOptions,
  ) {
    super({
      ...baseOptions,
      includeAgentConfig: true,
    })
    this.agentOptions = agentOptions
  }

  async assemble(
    requestContext: RequestContext,
  ): Promise<AssembledChatContext> {
    // First assemble base context
    const baseAssembler = new (
      await import("./normal-context-assembler")
    ).NormalContextAssembler(this.options)
    const baseContext = await baseAssembler.assemble(requestContext)

    // Add agent-specific context
    const agentConfig = await this.loadAgentConfig(requestContext)

    return {
      ...baseContext,
      agentConfig,
    }
  }

  async validate(requestContext: RequestContext): Promise<void> {
    await super.validate(requestContext)

    if (!this.agentOptions.agentId) {
      throw new Error("Agent ID is required for agent context assembly")
    }
  }

  private async loadAgentConfig(
    requestContext: RequestContext,
  ): Promise<AgentConfig> {
    const { persistence, user } = requestContext

    // Fetch agent with permission check
    const agent = await persistence.getAgentById?.(
      this.agentOptions.agentId,
      user.workspaceId,
    )

    if (!agent) {
      throw new Error(`Agent not found: ${this.agentOptions.agentId}`)
    }

    // Parse app integrations (allowed apps)
    const allowedApps = agent.allowedApps
      ? this.parseAppIntegrations(agent.allowedApps)
      : undefined

    // Parse resource constraints if present
    const resourceConstraints: ResourceConstraints | undefined =
      agent.resourceConstraints ? agent.resourceConstraints : undefined

    return {
      id: agent.id || this.agentOptions.agentId,
      name: agent.name || "Agent",
      prompt: agent.prompt || "",
      systemPrompt: agent.systemPrompt,
      model: agent.model,
      tools: agent.tools,
      allowedApps,
      resourceConstraints,
    }
  }

  private parseAppIntegrations(integrations: string[]): Apps[] {
    // Parse app integration strings to Apps enum values
    const appMap: Record<string, Apps> = {
      gmail: Apps.Gmail,
      drive: Apps.GoogleDrive,
      slack: Apps.Slack,
      calendar: Apps.GoogleCalendar,
      knowledge_base: Apps.KnowledgeBase,
      zoho_desk: Apps.ZohoDesk,
    }

    return integrations
      .map((app) => appMap[app.toLowerCase()])
      .filter((app): app is Apps => !!app)
  }
}
