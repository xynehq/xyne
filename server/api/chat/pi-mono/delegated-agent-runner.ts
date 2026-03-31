/**
 * Delegated Agent Runner for Pi-Mono
 *
 * Executes custom agents using pi-mono runtime
 * Handles both regular custom agents and MCP virtual agents
 */

import { Type } from "@sinclair/typebox"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent"
import { generateRunId } from "@xynehq/jaf"
import { getModelValueFromLabel } from "@/ai/modelConfig"
import { Models } from "@/ai/types"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getAgentByExternalIdWithPermissionCheck } from "@/db/agent"
import { db } from "@/db/client"
import { getUserConnectorState } from "@/api/chat/resource-access"
import { retrieveEpisodicMemories } from "@/services/episodicMemoryRetriever"
import { getChatExternalIdsByAgentId } from "@/db/chat"
import { getDateForAI } from "@/utils/index"
import { userContext } from "@/ai/context"
import type { ToolOutput } from "@/api/chat/tool-schemas"
import type {
  Citation,
  MinimalAgentFragment,
  ImageCitation,
} from "@/api/chat/types"
import { Apps } from "@xyne/vespa-ts/types"
import type { ReasoningEmitter } from "@/api/chat/reasoning-steps"
import { ReasoningSteps, emitReasoningEvent } from "@/api/chat/reasoning-steps"
import config from "@/config"
import type { XyneAgentState } from "./adapter"
import {
  createInitialXyneState,
  registerSession,
  setXyneState,
  unregisterSession,
  setRuntime,
} from "./adapter"
import {
  executeMcpVirtualAgent,
  type MCPVirtualAgentRuntime,
} from "./mcp-tools"
import { getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"

const {
  defaultBestModel,
  defaultBestModelAgenticMode,
  LiteLLMBaseUrl,
  LiteLLMApiKey,
} = config

const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

/**
 * Options for running a delegated agent
 */
export interface DelegatedAgentRunOptions {
  agentId: string
  query: string
  userEmail: string
  workspaceExternalId: string
  maxTokens?: number
  parentTurn?: number
  mcpAgents?: MCPVirtualAgentRuntime[]
  stopSignal?: AbortSignal
  reasoningEmitter?: ReasoningEmitter
  delegationRunId?: string
  parentXyneState?: XyneAgentState // Parent state for context
}

/**
 * Build enriched query with plan context
 */
export function buildDelegatedAgentQuery(
  baseQuery: string,
  parentState?: XyneAgentState,
): string {
  const parts = [baseQuery.trim()]

  if (parentState?.currentSubTask) {
    parts.push(`Active sub-task: ${parentState.currentSubTask}`)
  }

  if (parentState?.plan?.goal) {
    parts.push(`Overall goal: ${parentState.plan.goal}`)
  }

  if (parentState?.message?.text) {
    parts.push(`Original user question: ${parentState.message.text}`)
  }

  return parts.filter(Boolean).join("\n\n")
}

/**
 * Execute MCP virtual agent
 */
async function executeMcpAgentWithTracking(
  agentId: string,
  query: string,
  options: {
    mcpAgents: MCPVirtualAgentRuntime[]
    userEmail: string
    maxTokens?: number
    reasoningEmitter?: ReasoningEmitter
    delegationRunId?: string
  },
): Promise<ToolOutput> {
  const logger = loggerWithChild({ email: options.userEmail })

  // Emit agent delegated event
  if (options.reasoningEmitter && options.delegationRunId) {
    const mcpAgent = options.mcpAgents.find((a) => a.agentId === agentId)
    await emitReasoningEvent(options.reasoningEmitter, {
      ...ReasoningSteps.agentDelegated(
        mcpAgent?.connectorName || agentId,
        options.delegationRunId,
      ),
      agent: mcpAgent?.connectorName || agentId,
      delegationRunId: options.delegationRunId,
    })
  }

  // Execute the MCP agent
  const result = await executeMcpVirtualAgent(agentId, query, {
    mcpAgents: options.mcpAgents,
    userEmail: options.userEmail,
    maxTokens: options.maxTokens,
  })

  // Emit agent completed event
  if (options.reasoningEmitter && options.delegationRunId) {
    const mcpAgent = options.mcpAgents.find((a) => a.agentId === agentId)
    await emitReasoningEvent(options.reasoningEmitter, {
      ...ReasoningSteps.agentCompleted(
        mcpAgent?.connectorName || agentId,
        options.delegationRunId,
      ),
      agent: mcpAgent?.connectorName || agentId,
      delegationRunId: options.delegationRunId,
    })
  }

  return result
}

/**
 * Run a delegated custom agent using pi-mono runtime
 */
export async function runDelegatedAgentWithPiMono(
  options: DelegatedAgentRunOptions,
): Promise<ToolOutput> {
  const logger = loggerWithChild({ email: options.userEmail })

  // Check if this is an MCP virtual agent
  if (options.agentId.startsWith("mcp:")) {
    return executeMcpAgentWithTracking(options.agentId, options.query, {
      mcpAgents: options.mcpAgents || [],
      userEmail: options.userEmail,
      maxTokens: options.maxTokens,
      reasoningEmitter: options.reasoningEmitter,
      delegationRunId: options.delegationRunId,
    })
  }

  logger.info(
    {
      agentId: options.agentId,
      query: options.query.substring(0, 100),
      parentTurn: options.parentTurn,
    },
    "[DelegatedAgent] Starting delegated agent run",
  )

  try {
    // Load user and workspace
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      options.workspaceExternalId,
      options.userEmail,
    )

    const user = {
      id: Number(userAndWorkspace.user.id),
      email: String(userAndWorkspace.user.email),
      timeZone:
        typeof userAndWorkspace.user.timeZone === "string"
          ? userAndWorkspace.user.timeZone
          : "Asia/Kolkata",
    }

    const workspace = {
      id: Number(userAndWorkspace.workspace.id),
      externalId: String(userAndWorkspace.workspace.externalId),
    }

    // Load agent record
    const agentRecord = await getAgentByExternalIdWithPermissionCheck(
      db,
      options.agentId,
      workspace.id,
      user.id,
    )

    if (!agentRecord) {
      return {
        result: "Agent execution failed",
        error: `Access denied: You don't have permission to use agent ${options.agentId}`,
        metadata: { agentId: options.agentId, parentTurn: options.parentTurn },
      }
    }

    const agentPromptForLLM = JSON.stringify(agentRecord)
    const dedicatedAgentSystemPrompt =
      typeof agentRecord.prompt === "string" &&
      agentRecord.prompt.trim().length > 0
        ? agentRecord.prompt.trim()
        : undefined

    // Load connector state
    let connectorState
    try {
      connectorState = await getUserConnectorState(db, options.userEmail)
    } catch (error) {
      logger.warn(error, "[DelegatedAgent] Failed to load connector state")
      connectorState = {
        gmailSynced: false,
        googleDriveSynced: false,
        googleCalendarSynced: false,
        googleWorkspaceSynced: false,
        slackConnected: false,
      }
    }

    // Get agent's allowed apps from appIntegrations
    const allowedAgentApps = deriveAllowedAgentApps(agentPromptForLLM)

    // Build user context
    const userCtxString = userContext(userAndWorkspace)
    const userTimezone = user.timeZone || "Asia/Kolkata"
    const dateForAI = getDateForAI({ userTimeZone: userTimezone })

    // Generate chat ID for this delegated run
    const chatExternalId = `delegate-${generateRunId()}`

    // Initialize agent state
    const agentState = createInitialXyneState(
      options.userEmail,
      options.workspaceExternalId,
      String(user.id),
      user.id,
      chatExternalId,
      options.query,
      new Date().toISOString(),
    )

    // Configure delegation settings
    agentState.delegationEnabled = false // Delegated agents don't delegate further
    agentState.ambiguityResolved = true
    agentState.maxOutputTokens = options.maxTokens
    agentState.mcpAgents = options.mcpAgents || []
    agentState.userContext = userCtxString
    agentState.agentPrompt = agentPromptForLLM
    agentState.dedicatedAgentSystemPrompt = dedicatedAgentSystemPrompt
    agentState.user.workspaceNumericId = workspace.id
    agentState.chat.id = undefined // No actual chat record for delegated runs

    // Load episodic memories scoped to this agent's chat history
    try {
      const delegatedAgentChatIds = await getChatExternalIdsByAgentId(
        db,
        options.agentId,
        options.userEmail,
      )

      const episodicMemories = await retrieveEpisodicMemories({
        query: options.query,
        email: options.userEmail,
        workspaceId: options.workspaceExternalId,
        chatIds: delegatedAgentChatIds,
        limit: 5,
      })

      if (episodicMemories.length > 0) {
        agentState.episodicMemoriesText = episodicMemories
          .map(
            (m) =>
              `- [${m.memoryType}] ${m.memoryText} (chatId: ${m.sourceChatId})`,
          )
          .join("\n")
      }
    } catch (error) {
      logger.warn(error, "[DelegatedAgent] Failed to load episodic memories")
    }

    // Generate delegation run ID
    const delegationRunId = options.delegationRunId || generateRunId()

    // Emit agent delegated event
    if (options.reasoningEmitter) {
      const agentName =
        (agentRecord as any).name || options.agentId || "Delegated agent"
      await emitReasoningEvent(options.reasoningEmitter, {
        ...ReasoningSteps.agentDelegated(agentName, delegationRunId),
        agent: agentName,
        delegationRunId,
        parentAgent: "Main",
      })
    }

    // Build tools for this agent (filtered by connector availability and agent's allowed apps)
    const baseTools = buildXyneTools()
    const internalTools = filterToolsByAvailability(baseTools, {
      connectorState,
      allowedAgentApps,
      email: options.userEmail,
      agentId: options.agentId,
    })

    // Filter out delegation tools for nested agents
    const toolsWithoutDelegation = internalTools.filter(
      (t: any) => t.name !== "listCustomAgents" && t.name !== "runPublicAgent",
    )

    // Add MCP tools if available
    const allTools = [...toolsWithoutDelegation]

    const persistFn = async (state: XyneAgentState) => {
      logger.debug("[DelegatedAgent] Persisting state")
    }

    // Build system prompt
    const systemPrompt = buildDelegatedAgentSystemPrompt(
      agentState,
      toolsWithoutDelegation.map((t: any) => t.name),
      dateForAI,
      dedicatedAgentSystemPrompt,
    )

    // Initialize pi-mono session
    const baseUrl = LiteLLMBaseUrl?.endsWith("/v1")
      ? LiteLLMBaseUrl
      : `${LiteLLMBaseUrl}/v1`

    const authStorage = AuthStorage.create()
    if (LiteLLMApiKey) {
      authStorage.set("litellm", {
        type: "api_key",
        key: LiteLLMApiKey,
      })
    }

    const modelRegistry = new ModelRegistry(authStorage)

    // Resolve model
    const delegateModelId =
      getModelValueFromLabel(defaultBestModelAgenticMode) ||
      getModelValueFromLabel(defaultBestModel) ||
      Models.Gpt_4o

    const piModel = {
      id: delegateModelId,
      name: delegateModelId,
      api: "openai-completions",
      provider: "litellm",
      baseUrl: baseUrl,
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: options.maxTokens || 4096,
      compat: {
        supportsStore: false,
        supportsStreaming: true,
        supportsToolStreaming: true,
      },
    } as any

    // Create resource loader with agent's system prompt
    const resourceLoader = new DefaultResourceLoader({
      cwd: "/tmp",
      systemPrompt: systemPrompt,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    })
    await resourceLoader.reload()

    // Create pi-mono session
    const { session: piSession } = await createAgentSession({
      model: piModel,
      tools: [], // Disable default tools
      customTools: allTools,
      resourceLoader: resourceLoader,
      authStorage,
      modelRegistry,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: false, maxRetries: 3, baseDelayMs: 1000 },
      }),
    })

    const sessionId = piSession.sessionManager.getSessionId()
    registerSession(sessionId, agentState, persistFn)
    piSession.agent.setSystemPrompt(systemPrompt)
    setXyneState(piSession as any, agentState)

    // Set up runtime callbacks
    let answer = ""
    const citations: Citation[] = []
    const imageCitations: ImageCitation[] = []
    let totalCost = 0

    // Create scoped emitter that includes delegation info
    const scopedEmitter: ReasoningEmitter = options.reasoningEmitter
      ? async (payload) => {
          const agentName =
            (agentRecord as any).name || options.agentId || "Delegated agent"
          await options.reasoningEmitter!({
            ...payload,
            agent: agentName,
            delegationRunId,
            parentAgent: "Main",
          })
        }
      : async () => {}

    setRuntime({
      streamAnswerText: async (text: string) => {
        answer += text
      },
      emitReasoning: async (payload: any) => {
        await scopedEmitter(payload)
      },
    })

    // Track completion
    let agentCompleted = false
    let agentFailed = false
    let errorMessage = ""

    // Subscribe to events
    piSession.subscribe(async (event: any) => {
      if (options.stopSignal?.aborted) {
        agentFailed = true
        errorMessage = "Stop requested"
        return
      }

      try {
        switch (event.type) {
          case "agent_start": {
            await emitReasoningEvent(
              scopedEmitter,
              ReasoningSteps.turnStarted(1),
            )
            break
          }

          case "tool_execution_start": {
            await emitReasoningEvent(
              scopedEmitter,
              ReasoningSteps.toolSelected(event.toolName),
            )
            break
          }

          case "tool_execution_end": {
            await emitReasoningEvent(
              scopedEmitter,
              ReasoningSteps.toolCompleted(event.toolName, event.isError),
            )
            break
          }

          case "turn_start": {
            // Dynamically rebuild prompt with latest state
            const updatedPrompt = buildDelegatedAgentSystemPrompt(
              agentState,
              allTools.map((t: any) => t.name),
              dateForAI,
              dedicatedAgentSystemPrompt,
            )
            piSession.agent.setSystemPrompt(updatedPrompt)
            break
          }

          case "agent_end": {
            agentCompleted = true
            break
          }

          case "error": {
            agentFailed = true
            errorMessage = event.error?.message || "Unknown error"
            break
          }
        }
      } catch (handlerError) {
        logger.error(handlerError, "[DelegatedAgent] Event handler error")
      }
    })

    // Start the conversation
    const promptPromise = piSession.prompt(options.query)

    // Handle stop signal
    if (options.stopSignal) {
      const stopHandler = () => {
        promptPromise.catch(() => {}) // Ignore rejection
      }
      options.stopSignal.addEventListener("abort", stopHandler)
    }

    // Wait for completion with timeout
    const completionTimeoutMs = 10 * 60 * 1000 // 10 minutes
    try {
      await Promise.race([
        promptPromise,
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error("Agent completion timeout")),
            completionTimeoutMs,
          ),
        ),
      ])
    } catch (timeoutErr) {
      logger.error(timeoutErr, "[DelegatedAgent] Timeout")
      if (!agentCompleted) {
        agentFailed = true
        errorMessage = "Agent completion timeout"
      }
    }

    // Clean up
    unregisterSession(sessionId)

    // Emit completion event
    if (options.reasoningEmitter) {
      const agentName =
        (agentRecord as any).name || options.agentId || "Delegated agent"
      await emitReasoningEvent(options.reasoningEmitter, {
        ...ReasoningSteps.agentCompleted(agentName, delegationRunId),
        agent: agentName,
        delegationRunId,
      })
    }

    if (agentFailed) {
      return {
        result: "Agent execution failed",
        error: errorMessage,
        metadata: {
          agentId: options.agentId,
          parentTurn: options.parentTurn,
          delegationRunId,
        },
      }
    }

    // Build fragments from agent's accumulated fragments
    const fragments = agentState.allFragments || []

    // Build result
    const result: ToolOutput = {
      result: answer || "Agent completed without output",
      contexts: fragments.map((f) => ({
        id: f.id,
        content: f.content,
        source: {
          docId: f.source?.docId || f.id,
          title: f.source?.title || "Document",
          url: f.source?.url || "",
          app: String(f.source?.app || "unknown"),
          entity: f.source?.entity,
          itemId: f.source?.itemId,
          clId: f.source?.clId,
          page_title: f.source?.page_title,
          threadId: f.source?.threadId,
          parentThreadId: f.source?.parentThreadId,
        },
        confidence: f.confidence,
      })),
      metadata: {
        agentId: options.agentId,
        citations,
        imageCitations,
        cost: totalCost,
        tokensUsed: 0, // TODO: Track tokens
        parentTurn: options.parentTurn,
        delegationRunId,
      },
    }

    logger.info(
      {
        agentId: options.agentId,
        resultLength: result.result.length,
        fragmentCount: fragments.length,
        delegationRunId,
      },
      "[DelegatedAgent] Agent completed successfully",
    )

    return result
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error(error, "[DelegatedAgent] Agent execution failed")

    return {
      result: "Agent execution failed",
      error: errorMsg,
      metadata: {
        agentId: options.agentId,
        parentTurn: options.parentTurn,
        delegationRunId: options.delegationRunId,
      },
    }
  }
}

/**
 * Derive allowed agent apps from agent prompt
 */
function deriveAllowedAgentApps(agentPrompt?: string): Set<string> | null {
  if (!agentPrompt) return null

  try {
    const parsed = JSON.parse(agentPrompt)
    const integrations = parsed?.appIntegrations

    if (!integrations) return null

    if (Array.isArray(integrations)) {
      return new Set(integrations.map((i) => String(i).toLowerCase()))
    }

    if (typeof integrations === "object") {
      return new Set(Object.keys(integrations).map((k) => k.toLowerCase()))
    }

    return null
  } catch {
    return null
  }
}

/**
 * Filter tools by availability based on connector state and agent's allowed apps
 */
function filterToolsByAvailability(
  tools: any[],
  params: {
    connectorState: any
    allowedAgentApps: Set<string> | null
    email: string
    agentId?: string
  },
): any[] {
  const TOOL_ACCESS_REQUIREMENTS: Record<
    string,
    { requiredApp?: string; connectorFlag?: string }
  > = {
    searchGmail: { requiredApp: "gmail", connectorFlag: "gmailSynced" },
    searchDriveFiles: {
      requiredApp: "google_drive",
      connectorFlag: "googleDriveSynced",
    },
    searchCalendarEvents: {
      requiredApp: "google_calendar",
      connectorFlag: "googleCalendarSynced",
    },
    searchGoogleContacts: {
      requiredApp: "google_workspace",
      connectorFlag: "googleWorkspaceSynced",
    },
    getSlackRelatedMessages: {
      requiredApp: "slack",
      connectorFlag: "slackConnected",
    },
  }

  return tools.filter((tool) => {
    const rule = TOOL_ACCESS_REQUIREMENTS[tool.name]
    if (!rule) return true

    // Check connector availability
    if (rule.connectorFlag && !params.connectorState[rule.connectorFlag]) {
      return false
    }

    // Check agent's allowed apps
    if (params.allowedAgentApps && params.allowedAgentApps.size > 0) {
      if (
        !rule.requiredApp ||
        !params.allowedAgentApps.has(rule.requiredApp.toLowerCase())
      ) {
        return false
      }
    }

    return true
  })
}

/**
 * Build system prompt for delegated agent
 */
function buildDelegatedAgentSystemPrompt(
  state: XyneAgentState,
  enabledToolNames: string[],
  dateForAI: string,
  dedicatedAgentSystemPrompt?: string,
): string {
  const toolDescriptions =
    enabledToolNames.length > 0
      ? "You have access to the following tools:\n" +
        enabledToolNames.map((t) => `- ${t}`).join("\n") +
        "\ntool schemas are provided to you."
      : "No tools available."

  const agentSection = dedicatedAgentSystemPrompt
    ? `\n\nAgent-Specific Instructions:\n${dedicatedAgentSystemPrompt}`
    : ""

  const memorySection = state.episodicMemoriesText
    ? `\n\nRelevant Past Experiences:\n${state.episodicMemoriesText}`
    : ""

  const workspaceSection = state.userContext
    ? `\n\nWorkspace Context:\n${state.userContext}`
    : ""

  return [
    "You are a specialized AI agent focused on specific tasks.",
    "",
    `Current date: ${dateForAI}`,
    "",
    "<available_tools>",
    toolDescriptions,
    "</available_tools>",
    agentSection,
    workspaceSection,
    memorySection,
    "",
    "# INSTRUCTIONS",
    "- Focus on your specific domain and expertise.",
    "- Use available tools to gather information and complete tasks.",
    "- Do not delegate to other agents - you are the final executor.",
    "- Respond directly with your answer when you have completed your task.",
    "- Cite sources using the format K[docId_chunkIndex] when referencing documents.",
    "",
    "# TASK",
    state.message.text,
  ].join("\n")
}

/**
 * Build Xyne tools for delegated agent
 * This is a simplified version - the full version imports from tools/
 */
function buildXyneTools(): any[] {
  // Import tools dynamically to avoid circular dependencies
  const tools = require("./tools")
  return [
    tools.searchGlobalTool,
    tools.searchGmailTool,
    tools.searchDriveFilesTool,
    tools.searchCalendarEventsTool,
    tools.searchGoogleContactsTool,
    tools.getSlackRelatedMessagesTool,
    tools.lsKnowledgeBaseTool,
    tools.searchKnowledgeBaseTool,
    tools.searchChatHistoryTool,
    tools.toDoWriteTool,
    tools.fallBackTool,
    // Note: synthesizeFinalAnswerTool removed - agent now responds directly
  ].filter(Boolean)
}
