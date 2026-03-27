import { createEventHandler } from "./core/event-router"
import type { XyneAgentState, ToolExpectationAssignment } from "./adapter"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { ChatSSEvents } from "@/shared/types"
import { ReasoningSteps, emitReasoningEvent } from "@/api/chat/reasoning-steps"
import {
  extractExpectedResults,
  consumePendingExpectation,
  recordExpectationsForTurn,
} from "./review"
import { buildPiMonoSystemPrompt } from "./prompts/xyne-prompts"

const Logger = getLogger(Subsystem.Chat)
const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

// ============================================================================
// DETAILED LOGGING HELPERS (mirrors JAF's logging approach)
// ============================================================================

/**
 * Build a snapshot of the current context state for logging
 */
function buildContextTraceSnapshot(
  context: XyneAgentState,
): Record<string, unknown> {
  return {
    chatId: context.chat?.externalId,
    turnCount: context.turnCount,
    currentSubTask: context.currentSubTask,
    seenDocumentsCount: context.seenDocuments?.size ?? 0,
    seenDocumentsSample: Array.from(context.seenDocuments || []).slice(0, 10),
    allFragmentsCount: context.allFragments?.length ?? 0,
    allImagesCount: context.allImages?.length ?? 0,
    recentImagesCount: context.recentImages?.length ?? 0,
    currentTurnFragmentCount:
      context.currentTurnArtifacts?.fragments?.length ?? 0,
    currentTurnImageCount: context.currentTurnArtifacts?.images?.length ?? 0,
    currentTurnToolOutputCount:
      context.currentTurnArtifacts?.toolOutputs?.length ?? 0,
    currentTurnExpectationCount:
      context.currentTurnArtifacts?.expectations?.length ?? 0,
    toolCallHistoryCount: context.toolCallHistory?.length ?? 0,
    failedToolsCount: context.failedTools?.size ?? 0,
    availableAgentsCount: context.availableAgents?.length ?? 0,
    usedAgentsCount: context.usedAgents?.length ?? 0,
    ambiguityResolved: context.ambiguityResolved,
    finalSynthesisRequested: context.finalSynthesis?.requested,
    finalSynthesisCompleted: context.finalSynthesis?.completed,
    finalSynthesisAckReceived: context.finalSynthesis?.ackReceived,
  }
}

/**
 * Log context mutations with detailed state information (mirrors JAF's logContextMutation)
 */
function logContextMutation(
  context: XyneAgentState,
  message: string,
  details: Record<string, unknown> = {},
): void {
  loggerWithChild({ email: context.user?.email }).info(
    {
      ...buildContextTraceSnapshot(context),
      ...details,
    },
    message,
  )
}

/**
 * Normalize excluded IDs for logging
 */
function normalizeExcludedIdsForLogging(excludedIds: unknown): string[] {
  if (Array.isArray(excludedIds)) {
    return excludedIds
      .map((value) =>
        typeof value === "string"
          ? value
          : value === null || value === undefined
            ? ""
            : String(value),
      )
      .filter(Boolean)
  }
  if (excludedIds === null || excludedIds === undefined) {
    return []
  }
  const normalized =
    typeof excludedIds === "string" ? excludedIds : String(excludedIds)
  return normalized ? [normalized] : []
}

/**
 * Summarize tool result payload for logging
 */
function summarizeToolResultPayload(result: any): string {
  if (!result) {
    return "No result returned."
  }
  const truncateValue = (value: string, maxLength = 160): string => {
    if (value.length <= maxLength) return value
    return `${value.slice(0, maxLength - 1)}…`
  }

  const summaryCandidates: Array<unknown> = [
    result?.data?.summary,
    result?.data?.result,
  ]
  for (const candidate of summaryCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return truncateValue(candidate.trim(), 200)
    }
  }
  if (typeof result?.data === "string") {
    return truncateValue(result.data, 200)
  }
  try {
    return truncateValue(JSON.stringify(result?.data ?? result), 200)
  } catch {
    return "Result unavailable."
  }
}

export interface XyneHandlerConfig {
  state: XyneAgentState
  stream: {
    closed: boolean
    writeSSE: (data: { event: string; data: string }) => Promise<void>
  }
  session: any
  delegationEnabled: boolean
  stateManager: {
    persist: (sessionId?: string) => Promise<void>
  }
  reasoningEmitter: (payload: any) => Promise<void>
  customTools: any[]
  dateForAI: string
  message: string
  email: string
  agentCompletionResolve: (() => void) | null
  agentCompletionReject: ((err: Error) => void) | null
  setAgentCompleted: (completed: boolean) => void
  buildSystemPrompt: (
    state: XyneAgentState,
    toolNames: string[],
    date: string,
    delegation: boolean,
  ) => string
  currentTurn: { value: number }
  syntheticToolCallSeq: { value: number }
  expectationBuffer: ToolExpectationAssignment[]
  mainRunId: string
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
    email,
    agentCompletionResolve,
    agentCompletionReject,
    setAgentCompleted,
    buildSystemPrompt,
    currentTurn,
    syntheticToolCallSeq,
    expectationBuffer,
    mainRunId,
    delegationEnabled,
  } = config

  return [
    createEventHandler<XyneAgentState>({
      agent_start: async () => {
        loggerWithChild({ email }).info("Pi-mono agent started")
        logContextMutation(state, "[agent_start] Agent session started", {
          message,
          toolCount: customTools.length,
          delegationEnabled,
        })
        await emitReasoningEvent(
          reasoningEmitter,
          ReasoningSteps.turnStarted(1),
        )
        return false
      },

      tool_execution_start: async (event) => {
        const toolName = event.toolName
        const toolArgs = (event.args || {}) as Record<string, any>

        // DETAILED LOGGING: Before tool execution (mirrors JAF's beforeToolExecutionHook)
        logContextMutation(
          state,
          `[beforeToolExecutionHook] Received tool args`,
          {
            toolName,
            args: toolArgs,
            incomingExcludedIds: toolArgs.excludedIds || [],
            incomingExcludedIdsCount: Array.isArray(toolArgs.excludedIds)
              ? toolArgs.excludedIds.length
              : 0,
          },
        )

        // Handle excludedIds deduplication like JAF
        if (toolArgs && typeof toolArgs === "object") {
          const providedExcludedIds = Array.isArray(toolArgs.excludedIds)
            ? toolArgs.excludedIds
            : []
          const seenDocIds = Array.from(state.seenDocuments || [])
          const normalizedIncoming =
            normalizeExcludedIdsForLogging(providedExcludedIds)

          if (normalizedIncoming.length === 0) {
            logContextMutation(
              state,
              `[beforeToolExecutionHook] excludedIds not provided on tool args`,
              {
                toolName,
                args: toolArgs,
                seenDocumentIds: seenDocIds,
              },
            )
          }

          // Merge excluded IDs
          const mergedExcludedIds = Array.from(
            new Set([...providedExcludedIds, ...seenDocIds]),
          )
          if (mergedExcludedIds.length > 0) {
            toolArgs.excludedIds = mergedExcludedIds
            ;(event as any).args = toolArgs
          }
        }

        loggerWithChild({ email }).info(
          { toolName, args: event.args },
          "🔧 TOOL EXECUTION STARTED",
        )

        // Add toolExecutionId for tool calls
        const toolExecutionId = `tool-${mainRunId}-${currentTurn.value}-${syntheticToolCallSeq.value++}`

        // Assign expectation to tool call
        const assignedExpectation = consumePendingExpectation(
          state.pendingExpectations,
          toolName,
        )
        if (assignedExpectation) {
          state.expectedResultsByCallId.set(
            toolExecutionId,
            assignedExpectation.expectation,
          )
        }

        await emitReasoningEvent(reasoningEmitter, {
          ...ReasoningSteps.toolSelected(toolName),
          toolExecutionId,
        })
        return false
      },

      tool_execution_end: async (event) => {
        const toolName = event.toolName
        const isError = event.isError
        const result = event.result as any

        // DETAILED LOGGING: After tool execution (mirrors JAF's afterToolExecutionHook)
        const resultSummary = summarizeToolResultPayload(result)
        const resultType = typeof result
        const resultStatus = isError ? "error" : "success"

        // FIX: Extract and track seen document IDs from search results for deduplication
        let extractedDocIds: string[] = []
        if (
          !isError &&
          result?.details?.fragments &&
          Array.isArray(result.details.fragments)
        ) {
          const fragments = result.details.fragments
          extractedDocIds = fragments
            .map((f: any) => {
              // Extract docId from fragment.source.docId or fragment.id
              const sourceDocId = f?.source?.docId
              const fragmentId = f?.id
              // Prefer source.docId (the actual document ID), fallback to fragment id
              return sourceDocId || fragmentId
            })
            .filter(
              (id: any): id is string =>
                typeof id === "string" && id.length > 0,
            )

          // Add extracted document IDs to seenDocuments for deduplication
          if (extractedDocIds.length > 0 && state.seenDocuments) {
            const beforeCount = state.seenDocuments.size
            for (const docId of extractedDocIds) {
              state.seenDocuments.add(docId)
            }
            const addedCount = state.seenDocuments.size - beforeCount

            if (addedCount > 0) {
              logContextMutation(
                state,
                `[afterToolExecutionHook] Added document IDs to seenDocuments`,
                {
                  toolName,
                  addedCount,
                  totalSeen: state.seenDocuments.size,
                  sampleIds: extractedDocIds.slice(0, 5),
                },
              )
            }
          }
        }

        logContextMutation(
          state,
          `[afterToolExecutionHook] Processing tool result`,
          {
            toolName,
            turnNumber: currentTurn.value,
            status: resultStatus,
            executionTime: 0, // Pi-mono doesn't provide execution time directly
            hasResult: !!result,
            resultType,
            resultStatus,
            resultExcludedIds: extractedDocIds,
            seenDocumentIds: Array.from(state.seenDocuments || new Set()).slice(
              0,
              20,
            ),
          },
        )

        // Add to tool execution history
        state.toolCallHistory.push({
          toolName,
          connectorId: null,
          agentName: "pi-mono",
          arguments: (event as any).args || {},
          turnNumber: currentTurn.value,
          startedAt: new Date(),
          durationMs: 0,
          estimatedCostUsd: 0,
          status: isError ? "error" : "success",
        })

        // Record in expectation history
        if (state.pendingExpectations.length > 0) {
          const matchedExpectation = state.pendingExpectations.find(
            (e: ToolExpectationAssignment) => e.toolName === toolName,
          )
          if (matchedExpectation) {
            state.expectedResultsByCallId.set(
              `tool-${currentTurn.value}-${toolName}`,
              matchedExpectation.expectation,
            )
          }
        }

        // Log tool output summary
        logContextMutation(
          state,
          `[afterToolExecutionHook] Recorded tool output for current turn`,
          {
            toolName,
            turnNumber: currentTurn.value,
            toolFragmentsCount: extractedDocIds.length,
            toolFragmentIds: extractedDocIds.slice(0, 10),
            resultSummary: resultSummary.substring(0, 200),
          },
        )

        loggerWithChild({ email }).info(
          { toolName, isError, hasResult: !!result },
          "🔧 TOOL EXECUTION ENDED",
        )

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

        // Fix 6: beforeToolExecutionHook — Prevent fetching duplicate documents
        if (args && typeof args === "object") {
          // Only apply to search tools that accept excludedIds
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
              // Mutate the event so Pi-Mono uses the updated args
              if (event.args) (event as any).args = args
              else if ((event as any).arguments) (event as any).arguments = args
              else if ((event as any).input) (event as any).input = args
            }
          }
        }

        loggerWithChild({ email }).info(
          { toolName, args },
          "🔧 TOOL CALL EVENT",
        )
        return false
      },

      message_update: async (event) => {
        const assistantEvent = event.assistantMessageEvent
        if (assistantEvent?.type === "text_delta") {
          const delta = assistantEvent.delta || ""

          // IMPORTANT: After synthesis completes, the pi-mono agent may generate
          // follow-up text (e.g., "I found one relevant result..."). This MUST
          // be suppressed — only the synthesis LLM output should reach the user.
          // The synthesis tool streams directly via runtime.streamAnswerText(),
          // so we should NEVER stream agent text here.
          // All agent text goes to thinkingLog only.
          state.thinkingLog = (state.thinkingLog || "") + delta

          // Extract expectations from assistant text
          const extracted = extractExpectedResults(state.thinkingLog)
          if (extracted.length > 0) {
            state.pendingExpectations.push(...extracted)
            expectationBuffer.push(...extracted)
            await emitReasoningEvent(
              reasoningEmitter,
              ReasoningSteps.expectationsSet(),
            )
          }
        }
        return false
      },

      turn_start: async (event) => {
        // Increment turn counter since pi-mono doesn't provide turnIndex directly
        currentTurn.value++
        const turnIndex = currentTurn.value
        loggerWithChild({ email }).info(
          { turn: turnIndex },
          "Pi-mono turn started",
        )
        state.turnCount = turnIndex

        logContextMutation(state, "[turn_start] Turn started", {
          turnIndex,
          expectationBufferSize: expectationBuffer.length,
          pendingExpectationsCount: state.pendingExpectations.length,
          allFragmentsCount: state.allFragments.length,
        })

        // Flush expectation buffer into history for this turn
        if (expectationBuffer.length > 0) {
          recordExpectationsForTurn(
            state.expectationHistory,
            turnIndex,
            expectationBuffer.splice(0, expectationBuffer.length),
          )
        }

        // Dynamically rebuild the JAF-compliant prompt with latest State
        const updatedPrompt = buildSystemPrompt(
          state,
          customTools.map((tool: any) => tool.name),
          dateForAI,
          delegationEnabled,
        )

        // Update system prompt via the underlying agent (takes effect on next LLM call)
        if (session.agent?.setSystemPrompt) {
          session.agent.setSystemPrompt(updatedPrompt)
        }

        return false
      },

      turn_end: async (event) => {
        // Use currentTurn counter which was incremented in turn_start
        const turnIndex = currentTurn.value
        loggerWithChild({ email }).info(
          { turn: turnIndex },
          "Pi-mono turn ended (extension handles ranking/review/cleanup)",
        )

        logContextMutation(state, "[turn_end] Turn ended", {
          turnIndex,
          finalFragmentsCount: state.allFragments.length,
          toolCallHistoryCount: state.toolCallHistory.length,
          pendingExpectationsCount: state.pendingExpectations.length,
          finalSynthesisRequested: state.finalSynthesis?.requested,
          finalSynthesisCompleted: state.finalSynthesis?.completed,
        })

        // NOTE: All turn-end processing (ranking, review, cleanup) is handled
        // by the pi-mono extension (pi-mono-extension.ts) which blocks until
        // completion before allowing the next turn to proceed.
        // The extension handles:
        // - Fragment ranking via rankFragmentsByMetadataConstraints
        // - Adding best fragments to state.allFragments
        // - Cleanup of currentTurnArtifacts

        return false
      },

      assistant_message: async (event) => {
        const content = event.message?.content
        loggerWithChild({ email }).info(
          { hasContent: !!content, contentLength: content?.length },
          "Pi-mono assistant message",
        )
        logContextMutation(
          state,
          "[assistant_message] Assistant message received",
          {
            contentLength: content?.length || 0,
            thinkingLogLength: state.thinkingLog?.length || 0,
          },
        )
        return false
      },

      agent_end: async () => {
        loggerWithChild({ email }).info("Pi-mono agent ended")
        logContextMutation(state, "[agent_end] Agent session ended", {
          finalTurnCount: state.turnCount,
          totalFragments: state.allFragments.length,
          totalToolCalls: state.toolCallHistory.length,
          finalSynthesisCompleted: state.finalSynthesis?.completed,
        })
        setAgentCompleted(true)
        if (agentCompletionResolve) {
          agentCompletionResolve()
        }
        return false
      },

      error: async (event) => {
        const errorData = (event as any).error || {}
        loggerWithChild({ email }).error({ error: errorData }, "Pi-mono error")
        logContextMutation(state, "[error] Agent error occurred", {
          errorMessage: errorData.message || "Unknown error",
          currentTurn: currentTurn.value,
          turnCount: state.turnCount,
          toolCallHistoryCount: state.toolCallHistory.length,
        })
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
