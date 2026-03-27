/**
 * Pi-Mono Agent Runner - Event-Based Version
 *
 * This wraps pi-mono's MessageAgentsPiMono core logic in an async generator.
 * Uses event emitters to bridge pi-mono's callback-based events to async iteration.
 */

import { EventEmitter } from "events"
import type { XyneAgentState } from "./adapter"
import { createXyneAgentSession } from "./core/runtime"
import type { AgentSession as PiMonoAgentSession } from "@mariozechner/pi-coding-agent"
import { buildXyneSystemPrompt } from "./prompts/xyne-prompts"
import { createEventRouter } from "./core/event-router"
import { createXyneEventHandlers } from "./xyne-handlers"
import {
  searchGlobalTool,
  searchGmailTool,
  searchDriveFilesTool,
  searchCalendarEventsTool,
  searchGoogleContactsTool,
  getSlackRelatedMessagesTool,
  lsKnowledgeBaseTool,
  searchKnowledgeBaseTool,
  searchChatHistoryTool,
  toDoWriteTool,
  fallBackTool,
  synthesizeFinalAnswerTool,
  listCustomAgentsTool,
  runPublicAgentTool,
} from "./tools"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Chat)

export interface RunPiMonoAgentInput {
  email: string
  workspaceId: string
  userId: string
  message: string
  chatExternalId: string
  agentId?: string
  model?: string
  timezone?: string
  conversationHistory?: Array<{ role: string; content: string }>
}

export type AgentEvent =
  | { type: "token"; content: string }
  | { type: "reasoning"; payload: any }
  | { type: "complete"; answer: string }
  | { type: "error"; error: Error }

/**
 * Run the pi-mono agent
 * 
 * Usage:
 *   for await (const event of runPiMonoAgent(input)) {
 *     // handle event
 *   }
 */
export function runPiMonoAgent(
  input: RunPiMonoAgentInput
): AsyncIterable<AgentEvent> {
  const eventEmitter = new EventEmitter()
  const events: AgentEvent[] = []
  let completed = false
  let error: Error | null = null

  // Start the agent execution
  executeAgent(input, eventEmitter).then(() => {
    completed = true
  }).catch((err) => {
    error = err instanceof Error ? err : new Error(String(err))
    completed = true
  })

  // Return async iterator
  return {
    [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      return {
        async next(): Promise<IteratorResult<AgentEvent>> {
          // Wait for events or completion
          while (events.length === 0 && !completed) {
            await new Promise(resolve => setTimeout(resolve, 10))
          }

          // Return queued event
          if (events.length > 0) {
            const event = events.shift()!
            return { value: event, done: false }
          }

          // Check for error
          if (error) {
            throw error
          }

          // Done
          return { value: undefined, done: true }
        },
      }
    },
  }

  // Collect events from emitter
  eventEmitter.on("event", (event: AgentEvent) => {
    events.push(event)
  })
}

async function executeAgent(
  input: RunPiMonoAgentInput,
  eventEmitter: EventEmitter
): Promise<void> {
  console.log(`[PiMonoAgent] Starting execution`)
  
  try {
    const customTools = [
      searchGlobalTool, searchGmailTool, searchDriveFilesTool,
      searchCalendarEventsTool, searchGoogleContactsTool,
      getSlackRelatedMessagesTool, lsKnowledgeBaseTool,
      searchKnowledgeBaseTool, searchChatHistoryTool,
      toDoWriteTool, fallBackTool, synthesizeFinalAnswerTool,
      listCustomAgentsTool, runPublicAgentTool,
    ]

    const baseUrl = config.LiteLLMBaseUrl?.endsWith("/v1")
      ? config.LiteLLMBaseUrl
      : `${config.LiteLLMBaseUrl}/v1`

    const { createInitialXyneState, setXyneState, registerSession, unregisterSession, setPersistFunction, setRuntime } = await import("./adapter")
    
    const xyneState = createInitialXyneState(
      input.email,
      input.workspaceId,
      input.userId,
      input.chatExternalId,
      input.message,
      new Date().toISOString(),
    )

    xyneState.user.workspaceNumericId = parseInt(input.workspaceId) || undefined
    xyneState.modelId = input.model || config.defaultBestModel

    const sessionId = input.chatExternalId
    registerSession(sessionId, xyneState, async () => {})
    setPersistFunction(async () => {})

    const systemPrompt = buildXyneSystemPrompt({
      state: xyneState,
      toolNames: customTools.map(t => t.name),
      dateForAI: new Date().toISOString(),
      delegationEnabled: true,
    })

    const session = await createXyneAgentSession({
      model: input.model || config.defaultBestModel,
      systemPrompt,
      tools: customTools,
      state: xyneState,
      baseUrl,
      apiKey: config.LiteLLMApiKey,
    })

    const piSession = session.getUnderlyingSession() as PiMonoAgentSession
    setXyneState(piSession, xyneState)

    let answer = ""
    let agentCompleted = false

    // Set up callbacks to emit events
    setRuntime({
      streamAnswerText: async (text: string) => {
        if (!text) return
        answer += text
        eventEmitter.emit("event", { type: "token", content: text })
      },
      emitReasoning: async (payload: any) => {
        eventEmitter.emit("event", { type: "reasoning", payload })
      },
    })

    // Create completion promise
    const completionPromise = new Promise<void>((resolve, reject) => {
      const eventHandlers = createXyneEventHandlers({
        message: input.message,
        customTools,
        dateForAI: new Date().toISOString(),
        agentCompletionResolve: () => {
          agentCompleted = true
          resolve()
        },
        agentCompletionReject: reject,
        state: xyneState,
        stream: { closed: false, writeSSE: async () => {} },
        session: piSession,
        stateManager: { persist: async () => {} },
        reasoningEmitter: async (payload) => {
          eventEmitter.emit("event", { type: "reasoning", payload })
        },
        setAgentCompleted: (c) => { agentCompleted = c },
        buildSystemPrompt: (s, toolNames, date, delegation) =>
          buildXyneSystemPrompt({ state: s, toolNames, dateForAI: date, delegationEnabled: delegation }),
      })

      const router = createEventRouter({ session: piSession, handlers: eventHandlers })
      router.start()
    })

    await completionPromise

    eventEmitter.emit("event", { type: "complete", answer })
    unregisterSession(sessionId)

    console.log(`[PiMonoAgent] Completed. Answer length: ${answer.length}`)

  } catch (err) {
    console.error(`[PiMonoAgent] Error:`, err)
    eventEmitter.emit("event", { 
      type: "error", 
      error: err instanceof Error ? err : new Error(String(err))
    })
  }
}
