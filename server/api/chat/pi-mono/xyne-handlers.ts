import { createEventHandler } from "./core/event-router"
import type { XyneAgentState } from "./adapter"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { ChatSSEvents } from "@/shared/types"
import { ReasoningSteps, emitReasoningEvent } from "@/api/chat/reasoning-steps"
import {
  extractMetadataConstraintsFromUserMessage,
  rankFragmentsByMetadataConstraints,
} from "@/api/chat/message-agents-metadata"

const Logger = getLogger(Subsystem.Chat)

export interface XyneHandlerConfig {
  state: XyneAgentState
  stream: {
    closed: boolean
    writeSSE: (data: { event: string; data: string }) => Promise<void>
  }
  session: any
  stateManager: {
    persist: (sessionId?: string) => Promise<void>
  }
  reasoningEmitter: (payload: any) => Promise<void>
  customTools: any[]
  dateForAI: string
  message: string
  agentCompletionResolve: (() => void) | null
  agentCompletionReject: ((err: Error) => void) | null
  setAgentCompleted: (completed: boolean) => void
  buildSystemPrompt: (
    state: XyneAgentState,
    toolNames: string[],
    date: string,
    delegation: boolean,
  ) => string
}

export function createXyneEventHandlers(config: XyneHandlerConfig) {
  const {
    state,
    stream,
    session,
    reasoningEmitter,
    customTools,
    dateForAI,
    message,
    agentCompletionResolve,
    agentCompletionReject,
    setAgentCompleted,
    buildSystemPrompt,
  } = config

  return [
    createEventHandler<XyneAgentState>({
      agent_start: async () => {
        Logger.info("Pi-mono agent started")
        await emitReasoningEvent(
          reasoningEmitter,
          ReasoningSteps.turnStarted(1),
        )
        return false
      },

      tool_execution_start: async (event) => {
        const toolName = event.toolName
        Logger.info({ toolName, args: event.args }, "TOOL EXECUTION STARTED")
        await emitReasoningEvent(
          reasoningEmitter,
          ReasoningSteps.toolSelected(toolName),
        )
        return false
      },

      tool_execution_end: async (event) => {
        const toolName = event.toolName
        const isError = event.isError
        Logger.info(
          { toolName, isError, hasResult: !!event.result },
          "TOOL EXECUTION ENDED",
        )

        state.toolCallHistory.push({
          toolName,
          isError,
          timestamp: Date.now(),
        })

        await emitReasoningEvent(
          reasoningEmitter,
          ReasoningSteps.toolCompleted(toolName, isError),
        )

        if (toolName === "todo_write" && !isError) {
          await emitReasoningEvent(
            reasoningEmitter,
            ReasoningSteps.planCreated("Execute search plan", [
              {
                id: "1",
                description: "Search for information",
                status: "in_progress",
              },
            ]),
          )
        }
        return false
      },

      tool_call: async (event) => {
        const toolName = event.toolName || (event as any).name
        const args =
          event.args || (event as any).arguments || (event as any).input

        if (args && typeof args === "object") {
          if (
            (toolName.startsWith("search") && "excludedIds" in args) ||
            args.excludedIds === undefined
          ) {
            const providedExcludedIds = Array.isArray(args.excludedIds)
              ? args.excludedIds
              : []
            const seenDocIds = Array.from(state.seenDocuments || [])
            const mergedExcludedIds = Array.from(
              new Set([...providedExcludedIds, ...seenDocIds]),
            )

            if (mergedExcludedIds.length > 0) {
              args.excludedIds = mergedExcludedIds
              if (event.args) (event as any).args = args
              else if ((event as any).arguments) (event as any).arguments = args
              else if ((event as any).input) (event as any).input = args
            }
          }
        }

        Logger.info({ toolName, args }, "TOOL CALL EVENT")
        return false
      },

      message_update: async (event) => {
        const assistantEvent = event.assistantMessageEvent
        if (assistantEvent?.type === "text_delta") {
          const delta = assistantEvent.delta || ""
          // Capture agent thinking for fallback synthesis
          state.thinkingLog = (state.thinkingLog || "") + delta
          Logger.debug(
            { deltaLength: delta.length },
            "Message update delta received",
          )
        }
        return false
      },

      turn_start: async (event) => {
        Logger.info({ turn: event.turnIndex }, "Pi-mono turn started")
        const updatedPrompt = buildSystemPrompt(
          state,
          customTools.map((tool: any) => tool.name),
          dateForAI,
          true,
        )
        session.agent.setSystemPrompt(updatedPrompt)
        return false
      },

      turn_end: async (event) => {
        const turnIndex = event.turnIndex
        Logger.info({ turn: turnIndex }, "Pi-mono turn ended")

        const unranked = Array.from(
          state.currentTurnArtifacts.unrankedFragmentsByTool.values(),
        ).flat()

        try {
          if (unranked.length > 0) {
            const metadataConstraints =
              extractMetadataConstraintsFromUserMessage(message)
            const { rankedCandidates } = rankFragmentsByMetadataConstraints(
              unranked,
              metadataConstraints,
            )

            const bestFragments = rankedCandidates
              .filter((c: any) => c.compliant)
              .map((c: any) => c.fragment)

            if (bestFragments.length > 0) {
              state.allFragments.push(...bestFragments)
              await emitReasoningEvent(
                reasoningEmitter,
                ReasoningSteps.documentsRanking(),
              )
            } else if (!metadataConstraints.strict) {
              state.allFragments.push(...unranked)
              await emitReasoningEvent(
                reasoningEmitter,
                ReasoningSteps.documentsRanking(),
              )
            }
          }
        } catch (rankingErr) {
          Logger.warn(rankingErr, "Fragment ranking failed")
          if (unranked.length > 0) {
            state.allFragments.push(...unranked)
            await emitReasoningEvent(
              reasoningEmitter,
              ReasoningSteps.documentsRanking(),
            )
          }
        }

        state.currentTurnArtifacts.unrankedFragmentsByTool.clear()
        state.currentTurnArtifacts.toolOutputs = []
        state.currentTurnArtifacts.executionToolsCalled = 0
        state.currentTurnArtifacts.todoWriteCalled = false

        return false
      },

      assistant_message: async (event) => {
        const content = event.message?.content
        Logger.info(
          { hasContent: !!content, contentLength: content?.length },
          "Pi-mono assistant message",
        )
        return false
      },

      agent_end: async () => {
        Logger.info("Pi-mono agent ended")
        setAgentCompleted(true)
        if (agentCompletionResolve) {
          agentCompletionResolve()
        }
        return false
      },

      error: async (event) => {
        const errorData = (event as any).error || {}
        Logger.error({ error: errorData }, "Pi-mono error")
        if (!stream.closed) {
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: JSON.stringify({
              error: "agent_error",
              message: errorData.message || "Unknown error",
            }),
          })
        }

        setAgentCompleted(true)
        if (agentCompletionReject) {
          agentCompletionReject(new Error(errorData.message || "Agent Error"))
        }
        return false
      },
    }),
  ]
}
