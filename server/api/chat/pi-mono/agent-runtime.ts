/**
 * Pi-Mono Agent Runtime Integration
 *
 * Integration with @mariozechner/pi-coding-agent SDK
 * Uses AgentSession for managing agent lifecycle and tool execution
 */

import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type AgentSession,
  type CreateAgentSessionResult,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import type { XyneAgentState } from "./adapter"

const Logger = getLogger(Subsystem.Chat)

/**
 * System prompt builder for the pi-mono agent
 */
function buildSystemPrompt(xyneState: XyneAgentState): string {
  const basePrompt = `You are Xyne, an AI assistant that helps users by searching their connected applications and data sources.

CORE BEHAVIOR:
1. ALWAYS start by calling toDoWrite to create a plan
2. Execute tools sequentially based on the plan
3. Use search tools to gather information
4. Call synthesizeFinalAnswer when ready to respond
5. Be concise and focused in your searches

AVAILABLE TOOLS:
- toDoWrite: Create execution plan (MUST call first)
- searchGlobal: Search across all apps
- searchGmail: Search emails
- searchDriveFiles: Search Google Drive
- searchCalendarEvents: Search calendar
- searchGoogleContacts: Search contacts
- getSlackRelatedMessages: Search Slack
- lsKnowledgeBase: Browse KB structure
- searchKnowledgeBase: Search KB content
- searchChatHistory: Search past conversations
- listCustomAgents: List available agents
- runPublicAgent: Delegate to an agent
- fallBack: If search fails
- synthesizeFinalAnswer: Final response (MUST call last)

PLANNING:
- Break complex queries into subtasks
- Use appropriate tools for each subtask
- Adjust plan if initial approach fails`

  // Add user context if available
  if (xyneState.userContext) {
    return `${basePrompt}\n\nUSER CONTEXT:\n${xyneState.userContext}`
  }

  // Add agent-specific prompt if available
  if (xyneState.dedicatedAgentSystemPrompt) {
    return `${basePrompt}\n\nAGENT CONTEXT:\n${xyneState.dedicatedAgentSystemPrompt}`
  }

  return basePrompt
}

/**
 * Initialize and create a pi-mono AgentSession
 */
export async function createPiMonoAgentSession(
  tools: ToolDefinition<any, any, any>[],
  xyneState: XyneAgentState,
  modelId?: string,
): Promise<CreateAgentSessionResult> {
  const resolvedModelId =
    modelId || xyneState.modelId || config.defaultBestModelAgenticMode

  // Build session options - pass tools as customTools
  const sessionOptions: CreateAgentSessionOptions = {
    model: resolvedModelId as any,
    customTools: tools as any,
  }

  Logger.info(
    {
      modelId: resolvedModelId,
      toolCount: tools.length,
      chatId: xyneState.chat.externalId,
    },
    "Creating pi-mono AgentSession",
  )

  // Create the agent session using pi-mono SDK
  const result = await createAgentSession(sessionOptions)

  return result
}

/**
 * Run the agent with a user message
 */
export async function runPiMonoAgent(
  session: AgentSession,
  userMessage: string,
  _xyneState: XyneAgentState,
  _onEvent: (event: string, data: any) => void,
  _signal?: AbortSignal,
) {
  try {
    Logger.info(
      {
        messageLength: userMessage.length,
        chatId: _xyneState.chat.externalId,
      },
      "Running pi-mono agent",
    )

    // Send the user message to the agent session
    await session.prompt(userMessage)

    // Return a simplified response structure
    return {
      text: "Response streamed via events",
      toolCalls: [],
    }
  } catch (error) {
    Logger.error(error, "Pi-mono agent run failed")
    throw error
  }
}

// Re-export types from pi-mono for convenience
export type {
  AgentSession,
  CreateAgentSessionResult,
  CreateAgentSessionOptions,
  ToolDefinition,
}
export { createAgentSession }

/**
 * Legacy exports for backward compatibility
 * @deprecated Use createPiMonoAgentSession instead
 */
export const initializePiMonoAgent = createPiMonoAgentSession

/**
 * Legacy PiMonoAgent class for backward compatibility
 * @deprecated Use AgentSession directly
 */
export class PiMonoAgent {
  static builder() {
    return {
      withModel: (modelId: string) => ({
        withTools: (tools: ToolDefinition<any, any, any>[]) => ({
          withSystemMessage: (_message: string) => ({
            withMaxTokens: (_tokens: number) => ({
              withTemperature: (_temp: number) => ({
                build: () => ({
                  run: async (_userMessage: string, _options?: any) => ({
                    text: "Pi-mono agent runtime stub - implement with createAgentSession",
                    toolCalls: [],
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }
  }
}
