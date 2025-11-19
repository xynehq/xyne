import {
  AgentCreationSource,
  type SelectUser,
  type SelectWorkspace,
} from "@/db/schema"

import { db } from "@/db/client"
import { insertMessage, getChatMessagesWithAuth } from "@/db/message"
import { type SelectChat } from "@/db/schema"
import { getLogger } from "@/logger"
import {
  AgentReasoningStepType,
  ApiKeyScopes,
  ChatSSEvents,
  type AgentReasoningStep,
} from "@/shared/types"
import { MessageRole, Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"

import { SSEStreamingApi, streamSSE } from "hono/streaming" // Import SSEStreamingApi
import { type Span, type Tracer } from "@/tracer"

import { insertChatTrace } from "@/db/chatTrace"
import { activeStreams } from "./stream"
import {
  type Citation,
  type ImageCitation,
  type MinimalAgentFragment,
} from "./types"
import {
  addErrMessageToMessage,
  checkAndYieldCitationsForAgent,
  processMessage,
} from "./utils"
import config from "@/config"
import {
  runStream,
  getTextContent,
  type Agent as JAFAgent,
  type Message as JAFMessage,
  type RunConfig as JAFRunConfig,
  type RunState as JAFRunState,
  type RunResult as JAFRunResult,
  type TraceEvent as JAFTraceEvent,
  type TraceEvent,
  ToolResponse,
  type ToolResult,
  type ToolCall,
  InterruptionStatus,
} from "@xynehq/jaf"
import {
  buildMCPJAFTools,
  type FinalToolsList as JAFinalToolsList,
  type JAFAdapterCtx,
} from "@/api/chat/jaf-adapter"
import { fallbackTool } from "./tools/global"
import { AgentSteps } from "./agentSteps"
const {
  JwtPayloadKey,
  defaultBestModel,
  defaultFastModel,
  maxDefaultSummary,
  isReasoning,
  StartThinkingToken,
  EndThinkingToken,
  maxValidLinks,
} = config

type ChatContext = {
  email: string
  gatheredFragments: MinimalAgentFragment[]
  seenDocuments: Set<string>
  wasStreamClosedPrematurely: boolean
  tracer: Tracer
  thinking: string
  answer: string
  citations: Citation[]
  imageCitations: ImageCitation[]
  citationMap: Record<number, number>
  citationValues: Record<number, Citation>
  yieldedCitations: Set<number>
  yieldedImageCitations: Map<number, Set<number>>
  tokenArr: { inputTokens: number; outputTokens: number }[]
  chat: SelectChat
  costArr: number[]
  user: SelectUser
  workspace: SelectWorkspace
  assistantMessageId: string | null
  streamKey: string
  message: string
  modelId: string | null
  jafStreamingSpan: Span
  turnSpan: Span | undefined
  agentSteps: AgentSteps
  toolContextsMap: Record<string, number>
}

const Logger = getLogger(Subsystem.Chat)
export const JafStreamer = async (
  runState: JAFRunState<JAFAdapterCtx>,
  runConfig: JAFRunConfig<JAFAdapterCtx>,
  baseCtx: JAFAdapterCtx,
  stream: SSEStreamingApi,
  options: ChatContext,
): Promise<void> => {
  let {
    email,
    wasStreamClosedPrematurely,
    tracer,
    gatheredFragments,
    seenDocuments,
    thinking,
    answer,
    imageCitations,
    citations,
    citationMap,
    citationValues,
    yieldedCitations,
    yieldedImageCitations,
    tokenArr,
    chat,
    costArr,
    user,
    workspace,
    assistantMessageId,
    streamKey,
    message,
    modelId,
    jafStreamingSpan,
    turnSpan,
    agentSteps,
    toolContextsMap,
  } = options

  let currentTurn = 0
  let totalToolCalls = 0
  for await (const evt of runStream<JAFAdapterCtx, string>(
    runState,
    runConfig,
    async (event: TraceEvent) => {
      if (event.type !== "before_tool_execution") return

      const { args = {} } = event.data ?? {}
      const docIds = gatheredFragments?.map((v) => v.id).filter(Boolean) ?? []
      const seenDocIds = Array.from(seenDocuments)
      // to exclude docs which already retrieved in prev iteration
      const modifiedArgs = docIds.length
        ? { ...args, excludedIds: [...docIds, ...seenDocIds] }
        : args

      return modifiedArgs
    },
  )) {
    if (stream.closed) {
      wasStreamClosedPrematurely = true
      break
    }
    switch (evt.type) {
      case "turn_start": {
        currentTurn = evt.data.turn
        turnSpan = jafStreamingSpan.startSpan(`turn_${currentTurn}`)
        turnSpan.setAttribute("turn_number", currentTurn)
        turnSpan.setAttribute("agent_name", evt.data.agentName)
        await agentSteps.logAndStreamReasoning(
          {
            type: AgentReasoningStepType.Iteration,
            iteration: evt.data.turn,
            status: "in_progress",
          },
          message,
        )
        break
      }
      case "tool_requests": {
        const toolRequestsSpan = turnSpan?.startSpan("tool_requests")
        totalToolCalls += evt.data.toolCalls.length
        toolRequestsSpan?.setAttribute("tool_calls_count", evt.data.toolCalls.length)
        toolRequestsSpan?.setAttribute("total_tool_calls", totalToolCalls)

        for (const r of evt.data.toolCalls) {
          const toolSelectionSpan = toolRequestsSpan?.startSpan("tool_selection")
          toolSelectionSpan?.setAttribute("tool_name", r.name)
          toolSelectionSpan?.setAttribute(
            "args_count",
            Object.keys(r.args || {}).length,
          )
          toolSelectionSpan?.setAttribute("args", JSON.stringify(r.args))
          await agentSteps.logAndStreamReasoning(
            {
              type: AgentReasoningStepType.ToolSelected,
              toolName: r.name,
              status: "in_progress",
            },
            message,
          )
  
          await agentSteps.logAndStreamReasoning(
            {
              type: AgentReasoningStepType.ToolParameters,
              parameters: r.args,
              status: "in_progress",
            },
            message,
          )
          toolSelectionSpan?.end()
        }
        toolRequestsSpan?.end()
        break
      }
      case "tool_call_start": {
        const toolStartSpan = turnSpan?.startSpan("tool_call_start")
        toolStartSpan?.setAttribute("tool_name", evt.data.toolName)
        await agentSteps.logAndStreamReasoning(
          {
            type: AgentReasoningStepType.ToolExecuting,
            toolName: evt.data.toolName,
            status: "in_progress",
          },
          message,
        )
        toolStartSpan?.end()
        break
      }
      case "tool_call_end": {
        const toolStatus = typeof evt.data.status === "string" 
          ? (evt.data.status === "completed" || evt.data.status === "failed" || evt.data.status === "in_progress" 
              ? evt.data.status 
              : "completed")
          : "completed"
        const contextsLength = toolContextsMap[`${currentTurn}_${evt.data.toolName}`] || 0
        await agentSteps.logAndStreamReasoning(
          {
            type: AgentReasoningStepType.ToolResult,
            toolName: evt.data.toolName,
            resultSummary: `Tool execution completed${contextsLength > 0 ? ` - Found ${contextsLength} result${contextsLength !== 1 ? 's' : ''}` : ''}`,
            itemsFound: contextsLength,
            status: toolStatus,
          },
          message,
        )
        break
      }
      case "assistant_message": {
        const messageSpan = turnSpan?.startSpan("assistant_message")
        const content = getTextContent(evt.data.message.content) || ""
        const hasToolCalls =
          Array.isArray(evt.data.message?.tool_calls) &&
          (evt.data.message.tool_calls?.length ?? 0) > 0

        if (!content || content.length === 0) {
          break
        }

        if (hasToolCalls) {
          // Treat assistant content that accompanies tool calls as planning/reasoning,
          // not as final answer text. Emit as a reasoning step and do not send 'u' updates.
          await agentSteps.logAndStreamReasoning(
            {
              type: AgentReasoningStepType.LogMessage,
              message: content,
              status: "in_progress",
            },
            message,
          )
          break
        }

        // No tool calls: stream as user-visible answer text, with on-the-fly citations
        const chunkSize = 200
        for (let i = 0; i < content.length; i += chunkSize) {
          const chunk = content.slice(i, i + chunkSize)
          answer += chunk
          await stream.writeSSE({
            event: ChatSSEvents.ResponseUpdate,
            data: chunk,
          })

          for await (const cit of checkAndYieldCitationsForAgent(
            answer,
            yieldedCitations,
            gatheredFragments,
            yieldedImageCitations,
            email ?? "",
          )) {
            if (cit.citation) {
              const { index, item } = cit.citation
              citations.push(item)
              citationMap[index] = citations.length - 1
              await stream.writeSSE({
                event: ChatSSEvents.CitationsUpdate,
                data: JSON.stringify({
                  contextChunks: citations,
                  citationMap,
                }),
              })
              citationValues[index] = item
            }
            if (cit.imageCitation) {
              imageCitations.push(cit.imageCitation)
              await stream.writeSSE({
                event: ChatSSEvents.ImageCitationUpdate,
                data: JSON.stringify(cit.imageCitation),
              })
            }
          }
        }
        messageSpan?.setAttribute("content_length", content.length)
        messageSpan?.setAttribute("answer_length", answer.length)
        messageSpan?.setAttribute("citations_count", citations.length)
        messageSpan?.setAttribute("image_citations_count", imageCitations.length)
        messageSpan?.end()
        break
      }
      case "token_usage": {
        const tokenUsageSpan = jafStreamingSpan.startSpan("token_usage")
        const inputTokens = (evt.data.prompt as number) || 0
        const outputTokens = (evt.data.completion as number) || 0
        tokenArr.push({
          inputTokens,
          outputTokens,
        })
        tokenUsageSpan.setAttribute("input_tokens", inputTokens)
        tokenUsageSpan.setAttribute("output_tokens", outputTokens)
        tokenUsageSpan.setAttribute("total_tokens", inputTokens + outputTokens)
        tokenUsageSpan.end()
        break
      }
      case "guardrail_violation": {
        const guardrailSpan = jafStreamingSpan.startSpan("guardrail_violation")
        guardrailSpan.setAttribute("reason", evt.data.reason)
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: JSON.stringify({
            error: "guardrail_violation",
            message: evt.data.reason,
          }),
        })
        guardrailSpan.end()
        break
      }
      case "decode_error": {
        const decodeErrorSpan = jafStreamingSpan.startSpan("decode_error")
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: JSON.stringify({
            error: "decode_error",
            message: "Failed to decode model output",
          }),
        })
        decodeErrorSpan.end()
        break
      }
      case "handoff_denied": {
        const handoffSpan = jafStreamingSpan.startSpan("handoff_denied")
        handoffSpan.setAttribute("reason", evt.data.reason)
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: JSON.stringify({
            error: "handoff_denied",
            message: evt.data.reason,
          }),
        })
        handoffSpan.end()
        break
      }
      case "clarification_requested": {
        const clarificationSpan = jafStreamingSpan.startSpan(
          "clarification_requested",
        )
        clarificationSpan.setAttribute(
          "clarification_id",
          evt.data.clarificationId,
        )
        clarificationSpan.setAttribute("question", evt.data.question)
        clarificationSpan.setAttribute("options_count", evt.data.options.length)
        await stream.writeSSE({
          event: ChatSSEvents.ClarificationRequested,
          data: JSON.stringify({
            clarificationId: evt.data.clarificationId,
            question: evt.data.question,
            options: evt.data.options,
            context: evt.data.context,
          }),
        })
        clarificationSpan.end()
        break
      }
      case "clarification_provided": {
        const clarificationProvidedSpan = jafStreamingSpan.startSpan(
          "clarification_provided",
        )
        clarificationProvidedSpan.setAttribute(
          "clarification_id",
          evt.data.clarificationId,
        )
        clarificationProvidedSpan.setAttribute(
          "selected_id",
          evt.data.selectedId,
        )

        await stream.writeSSE({
          event: ChatSSEvents.ClarificationProvided,
          data: JSON.stringify({
            clarificationId: evt.data.clarificationId,
            selectedId: evt.data.selectedId,
          }),
        })

        await agentSteps.logAndStreamReasoning(
          {
            type: AgentReasoningStepType.LogMessage,
            message: `User provided clarification: ${evt.data.selectedId}`,
            stepSummary: "User clarification received",
            status: "completed",
          },
          message,
        )
        clarificationProvidedSpan?.end()
        break
      }
      case "final_output": {
        const finalOutputSpan = jafStreamingSpan.startSpan("final_output")
        const out = evt.data.output
        if (typeof out === "string" && out.trim().length) {
          // Ensure any remainder is streamed
          const remaining = out.slice(answer.length)
          if (remaining.length) {
            await stream.writeSSE({
              event: ChatSSEvents.ResponseUpdate,
              data: remaining,
            })
            answer = out
          }
        }
        // Store the actual output instead of just length
        finalOutputSpan.setAttribute(
          "final_output",
          typeof out === "string" ? out : "",
        )
        finalOutputSpan.setAttribute(
          "final_output_length",
          typeof out === "string" ? out.length : 0,
        )
        finalOutputSpan.setAttribute(
          "citation_map",
          JSON.stringify(citationMap),
        )
        finalOutputSpan.setAttribute(
          "citation_values",
          JSON.stringify(citationValues),
        )
        finalOutputSpan.setAttribute("citations_count", citations.length)
        finalOutputSpan.setAttribute(
          "image_citations_count",
          imageCitations.length,
        )
        finalOutputSpan.end()
        break
      }
      case "run_end": {
        const runEndSpan = jafStreamingSpan.startSpan("run_end")
        const outcome = evt.data.outcome as JAFRunResult<string>["outcome"]
        const finalState = evt.data.finalState
        runEndSpan.setAttribute("outcome_status", outcome?.status || "unknown")

        if (outcome?.status === "completed") {
          const costCalculationSpan = runEndSpan.startSpan("cost_calculation")
          const totalCost = costArr.reduce((sum, cost) => sum + cost, 0)
          const totalTokens = tokenArr.reduce(
            (sum, t) => sum + t.inputTokens + t.outputTokens,
            0,
          )
          costCalculationSpan.setAttribute("total_cost", totalCost)
          costCalculationSpan.setAttribute("total_tokens", totalTokens)
          costCalculationSpan.setAttribute("total_tool_calls", totalToolCalls)
          costCalculationSpan.setAttribute("final_answer_length", answer.length)
          costCalculationSpan.setAttribute("citations_count", citations.length)
          costCalculationSpan.end()

          const dbInsertSpan = runEndSpan.startSpan("insert_assistant_message")
          const msg = await insertMessage(db, {
            chatId: chat.id,
            userId: user.id,
            workspaceExternalId: workspace.externalId,
            chatExternalId: chat.externalId,
            messageRole: MessageRole.Assistant,
            email: user.email,
            sources: citations,
            imageCitations: imageCitations,
            message: processMessage(answer, citationMap),
            thinking: agentSteps.thinking.value,
            modelId: defaultBestModel,
            cost: totalCost.toString(),
            tokensUsed: totalTokens,
          })
          assistantMessageId = msg.externalId
          dbInsertSpan.setAttribute("message_external_id", assistantMessageId)
          dbInsertSpan.end()

          const traceInsertSpan = runEndSpan.startSpan("insert_chat_trace")
          const traceJson = tracer.serializeToJson()
          await insertChatTrace({
            workspaceId: workspace.id,
            userId: user.id,
            chatId: chat.id,
            messageId: msg.id,
            chatExternalId: chat.externalId,
            email: user.email,
            messageExternalId: msg.externalId,
            traceJson,
          })
          traceInsertSpan.end()

          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chat.externalId,
              messageId: assistantMessageId,
            }),
          })
          await stream.writeSSE({ event: ChatSSEvents.End, data: "" })
        } else if (outcome?.status === "interrupted") {
          const interruptedSpan = runEndSpan.startSpan("interrupted_handling")

          // Check if it's a clarification interruption
          const clarificationInterruption = outcome.interruptions?.find(
            (i) => i.type === "clarification_required",
          )

          if (clarificationInterruption) {
            interruptedSpan.setAttribute(
              "interruption_type",
              "clarification_required",
            )
            interruptedSpan.setAttribute(
              "clarification_id",
              clarificationInterruption.clarificationId,
            )

            // HITL: Store the full interrupted state and set up callback for resumption
            if (streamKey) {
              const activeStreamState = activeStreams.get(streamKey)
              if (activeStreamState) {
                activeStreamState.jafInterruptedState = finalState
                activeStreamState.jafConfig = runConfig
                activeStreamState.waitingForClarification = true

                // Create a promise that will be resolved when user provides clarification
                const clarificationPromise = new Promise<{
                  clarificationId: string
                  selectedOption: {
                    selectedOptionId: string
                    selectedOption: string
                    customInput?: string
                  }
                }>((resolve) => {
                  activeStreamState.clarificationCallback = (
                    clarificationId: string,
                    selectedOption,
                  ) => {
                    Logger.info("Clarification callback invoked", {
                      chatId: chat.externalId,
                      clarificationId,
                      selectedOption,
                    })
                    resolve({ clarificationId, selectedOption })
                  }
                })

                Logger.info(
                  "Stored JAF interrupted state - stream paused, waiting for user clarification",
                  {
                    chatId: chat.externalId,
                    clarificationId: clarificationInterruption.clarificationId,
                    stateMessages: finalState.messages.length,
                    turnCount: finalState.turnCount,
                  },
                )

                // HITL: PAUSE and wait for clarification (DO NOT END STREAM)
                try {
                  const { clarificationId, selectedOption } =
                    await clarificationPromise

                  Logger.info(
                    "Clarification received, resuming JAF execution",
                    {
                      chatId: chat.externalId,
                      clarificationId,
                      selectedOption,
                    },
                  )

                  // Send clarification provided event to frontend
                  await stream.writeSSE({
                    event: ChatSSEvents.ClarificationProvided,
                    data: JSON.stringify({
                      clarificationId,
                      selectedId: selectedOption.selectedOptionId,
                    }),
                  })

                  // Add reasoning about the clarification
                  const clarificationText = selectedOption.customInput
                    ? `${selectedOption.selectedOption}: "${selectedOption.customInput}"`
                    : selectedOption.selectedOption

                  const reasoningData = JSON.stringify({
                    text: `User selected: ${clarificationText}`,
                    step: {
                      type: AgentReasoningStepType.LogMessage,
                      status: "completed",
                      message: `User provided clarification: ${clarificationText}`,
                      stepSummary: "User clarification received",
                    },
                  })
                  agentSteps.thinking.value += `${reasoningData}\n`
                  await stream.writeSSE({
                    event: ChatSSEvents.Reasoning,
                    data: reasoningData,
                  })

                  // Resume JAF with the clarification
                  // First, we need to add the awaiting_clarification message to the state
                  // JAF expects this message to exist so it can update it with the user's selection

                  // Find the last assistant message with tool_calls
                  const lastAssistantMessage = [...finalState.messages]
                    .reverse()
                    .find(
                      (msg) =>
                        msg.role === "assistant" &&
                        msg.tool_calls &&
                        msg.tool_calls.length > 0,
                    )

                  // Find the tool_call_id for the request_user_clarification tool
                  const clarificationToolCall =
                    lastAssistantMessage?.tool_calls?.find(
                      (tc: any) =>
                        tc.function.name === "request_user_clarification",
                    )

                  if (!clarificationToolCall) {
                    throw new Error(
                      "Could not find request_user_clarification tool call in interrupted state",
                    )
                  }

                  // Create the awaiting_clarification message that JAF expects
                  const awaitingClarificationMessage = {
                    role: "tool" as const,
                    content: JSON.stringify({
                      status: InterruptionStatus.AwaitingClarification,
                      clarification_id: clarificationId,
                      message: "Waiting for user to provide clarification",
                    }),
                    tool_call_id: clarificationToolCall.id,
                  }

                  const resumedRunState: JAFRunState<JAFAdapterCtx> = {
                    ...finalState,
                    // Add the awaiting_clarification message to the history
                    messages: [
                      ...finalState.messages,
                      awaitingClarificationMessage,
                    ],
                    // Add the user's selection to the clarifications map
                    // If custom input is provided, use that; otherwise use the selected option ID
                    clarifications: new Map([
                      ...(finalState.clarifications || []),
                      [
                        clarificationId,
                        selectedOption.customInput ||
                          selectedOption.selectedOptionId,
                      ],
                    ]),
                  }

                  // Continue with a new runStream using the resumed state
                  // Process the resumed JAF stream with the same event handling logic
                  return JafStreamer(
                    resumedRunState,
                    runConfig,
                    baseCtx,
                    stream,
                    { ...options },
                  )
                } catch (error) {
                  Logger.error(
                    "Error waiting for or processing clarification",
                    {
                      chatId: chat.externalId,
                      error: getErrorMessage(error),
                    },
                  )
                  await stream.writeSSE({
                    event: ChatSSEvents.Error,
                    data: "Failed to receive clarification response",
                  })
                  await stream.writeSSE({
                    event: ChatSSEvents.End,
                    data: "",
                  })
                }
              }
            }

            // Don't send End event here - we're waiting for clarification
          } else {
            // Handle other interruption types (e.g., tool approval)
            interruptedSpan.setAttribute("interruption_type", "other")
            Logger.info("Run interrupted for non-clarification reason", {
              interruptionsCount: (outcome as any).interruptions?.length || 0,
            })
            await stream.writeSSE({ event: ChatSSEvents.End, data: "" })
          }

          interruptedSpan.end()
        } else {
          // Error outcome: stream error and do not insert assistant message
          const errorHandlingSpan = runEndSpan.startSpan("error_handling")
          const allMessages = await getChatMessagesWithAuth(
            db,
            chat?.externalId,
            email,
          )
          const lastMessage = allMessages[allMessages.length - 1]
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chat.externalId,
              messageId: lastMessage.externalId,
            }),
          })
          // Check the status before accessing error property
          const err = outcome?.status === "error" ? outcome.error : undefined
          const errTag = err?._tag || "run_error"
          let errMsg = "Model did not return a response."
          if (err) {
            switch (err._tag) {
              case "ModelBehaviorError":
              case "ToolCallError":
              case "HandoffError":
                errMsg = err.detail
                break
              case "InputGuardrailTripwire":
              case "OutputGuardrailTripwire":
                errMsg = err.reason
                break
              case "DecodeError":
                errMsg = "Failed to decode model output"
                break
              case "AgentNotFound":
                errMsg = `Agent not found: ${err.agentName}`
                break
              case "MaxTurnsExceeded":
                // Execute fallback tool directly using messages from runState
                try {
                  let data = JSON.stringify({
                    text: "Max iterations reached with incomplete synthesis. Activating follow-back search strategy...",
                    step: {
                      type: AgentReasoningStepType.LogMessage,
                      message:
                        "Max iterations reached with incomplete synthesis. Activating follow-back search strategy...",
                      status: "in_progress",
                      stepSummary: "Activating fallback search",
                    },
                  })
                  agentSteps.thinking.value += `${data}\n`
                  await stream.writeSSE({
                    event: ChatSSEvents.Reasoning,
                    data: data,
                  })

                  // Extract all context from runState.messages array
                  const allMessages = runState.messages || []
                  const agentScratchpad = allMessages
                    .map(
                      (msg, index) =>
                        `${msg.role}: ${getTextContent(msg.content)}`,
                    )
                    .join("\n")
                  console.log("Agent scratchpad:", agentScratchpad)
                  console.log("all messages:", allMessages)

                  // Build tool log from any tool executions in the conversation
                  const toolLog = allMessages
                    .filter(
                      (msg) =>
                        msg.role === "tool" ||
                        msg.tool_calls ||
                        msg.tool_call_id,
                    )
                    .map(
                      (msg, index) =>
                        `Tool Execution ${index + 1}: ${getTextContent(msg.content)}`,
                    )
                    .join("\n")
                  // Prepare fallback tool parameters with context from runState.messages
                  const fallbackParams = {
                    originalQuery: message,
                    agentScratchpad: agentScratchpad,
                    toolLog: toolLog,
                    gatheredFragments: gatheredFragments
                      .map((v) => v.content)
                      .join("\n"),
                  }

                  data = JSON.stringify({
                    text: `Executing fallback tool with context from ${allMessages.length} messages...`,
                    step: {
                      type: AgentReasoningStepType.ToolExecuting,
                      toolName: "fall_back",
                      status: "in_progress",
                      stepSummary: "Executing fallback tool",
                    },
                  })
                  agentSteps.thinking.value += `${data}\n`
                  await stream.writeSSE({
                    event: ChatSSEvents.Reasoning,
                    data: data,
                  })

                  // Execute fallback tool directly
                  const fallbackResponse = (await fallbackTool.execute(
                    fallbackParams,
                    baseCtx,
                  )) as ToolResult<{ fallbackReasoning: string }>

                  data = JSON.stringify({
                    text: `Fallback tool execution completed`,
                    step: {
                      type: AgentReasoningStepType.ToolResult,
                      toolName: "fall_back",
                      status: "completed",
                      resultSummary:
                        fallbackResponse.data || "Fallback response generated",
                      itemsFound: gatheredFragments.length || 0,
                      stepSummary: `Generated fallback response`,
                    },
                  })
                  agentSteps.thinking.value += `${data}\n`
                  await stream.writeSSE({
                    event: ChatSSEvents.Reasoning,
                    data: data,
                  })

                  const fallbackReasoning = fallbackResponse.metadata
                    ? fallbackResponse.metadata["fallbackReasoning"]
                    : ""
                  // Stream the fallback response if available
                  if (fallbackReasoning || fallbackResponse.data) {
                    const fallbackAnswer =
                      fallbackReasoning || fallbackResponse.data || ""

                    await stream.writeSSE({
                      event: ChatSSEvents.ResponseUpdate,
                      data: fallbackAnswer,
                    })

                    // Handle any contexts returned by fallback tool
                    // if (
                    //   fallbackResponse.contexts &&
                    //   Array.isArray(fallbackResponse.contexts)
                    // ) {
                    //   fallbackResponse.contexts.forEach((context) => {
                    //     citations.push(context.source)
                    //     citationMap[citations.length] =
                    //       citations.length - 1
                    //   })

                    //   if (citations.length > 0) {
                    //     await stream.writeSSE({
                    //       event: ChatSSEvents.CitationsUpdate,
                    //       data: JSON.stringify({
                    //         contextChunks: citations,
                    //         citationMap,
                    //       }),
                    //     })
                    //   }
                    // }

                    if (fallbackAnswer.trim()) {
                      // Insert successful fallback message
                      const totalCost = costArr.reduce(
                        (sum, cost) => sum + cost,
                        0,
                      )
                      const totalTokens = tokenArr.reduce(
                        (sum, t) => sum + t.inputTokens + t.outputTokens,
                        0,
                      )
                      const msg = await insertMessage(db, {
                        chatId: chat.id,
                        userId: user.id,
                        workspaceExternalId: workspace.externalId,
                        chatExternalId: chat.externalId,
                        messageRole: MessageRole.Assistant,
                        email: user.email,
                        sources: citations,
                        imageCitations: imageCitations,
                        message: processMessage(fallbackAnswer, citationMap),
                        thinking: thinking,
                        modelId: modelId || defaultBestModel,
                        cost: totalCost.toString(),
                        tokensUsed: totalTokens,
                      })
                      assistantMessageId = msg.externalId
                      await stream.writeSSE({
                        event: ChatSSEvents.ResponseMetadata,
                        data: JSON.stringify({
                          chatId: chat.externalId,
                          messageId: assistantMessageId,
                        }),
                      })
                      await stream.writeSSE({
                        event: ChatSSEvents.End,
                        data: "",
                      })
                      return // Successfully handled with fallback response
                    }
                  }
                } catch (fallbackError) {
                  Logger.error(
                    fallbackError,
                    "Error during MaxTurnsExceeded fallback tool execution",
                  )

                  const data = JSON.stringify({
                    text: `Fallback search failed: ${getErrorMessage(fallbackError)}. Will generate best-effort answer.`,
                    step: {
                      type: AgentReasoningStepType.LogMessage,
                      message: `Fallback search failed: ${getErrorMessage(fallbackError)}`,
                      status: "error",
                      stepSummary: "Fallback search failed",
                    },
                  })
                  agentSteps.thinking.value += `${data}\n`
                  await stream.writeSSE({
                    event: ChatSSEvents.Reasoning,
                    data: data,
                  })
                  // Fall through to default error handling if fallback fails
                }
                break
              default:
                errMsg = errTag
            }
          }
          const errPayload = {
            error: errTag,
            message: errMsg,
          }
          errorHandlingSpan.setAttribute("error_tag", errTag)
          errorHandlingSpan.setAttribute("error_message", errMsg)
          errorHandlingSpan.end()

          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: JSON.stringify(errPayload),
          })
          await addErrMessageToMessage(lastMessage, JSON.stringify(errPayload))
          await stream.writeSSE({ event: ChatSSEvents.End, data: "" })
        }
        runEndSpan.end()
        break
      }
    }
  }
}
