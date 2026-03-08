import { getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import { type TraceEvent, getTextContent } from "@xynehq/jaf"

const loggerWithChild = getLoggerWithChild(Subsystem.Chat, {
  module: "jaf-logging",
})

export type JAFTraceLoggingContext = {
  chatId: string
  email: string
  flow: "MessageAgents" | "DelegatedAgenticRun"
  runId: string
}

function truncateValue(value: string, maxLength = 160): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1)}…`
}

function summarizeToolResultPayload(result: any): string {
  if (!result) {
    return "No result returned."
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

function formatToolArgumentsForLogging(args: Record<string, unknown>): string {
  if (!args || typeof args !== "object") {
    return "{}"
  }
  const entries = Object.entries(args)
  if (entries.length === 0) {
    return "{}"
  }
  const parts = entries.map(([key, value]) => {
    let serialized: string
    if (typeof value === "string") {
      serialized = `"${truncateValue(value, 80)}"`
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      serialized = String(value)
    } else {
      try {
        serialized = truncateValue(JSON.stringify(value), 80)
      } catch {
        serialized = "[unserializable]"
      }
    }
    return `${key}: ${serialized}`
  })
  const combined = parts.join(", ")
  return truncateValue(combined, 400)
}

export function logJAFTraceEvent(
  context: JAFTraceLoggingContext,
  event: TraceEvent,
): void {
  if (event.type === "before_tool_execution") {
    return
  }

  const logger = loggerWithChild({ email: context.email })
  const baseLog = {
    chatId: context.chatId,
    eventType: event.type,
    flow: context.flow,
    runId: context.runId,
  }

  switch (event.type) {
    case "run_start":
      logger.info(baseLog, "[JAF] Run started")
      return

    case "run_end": {
      const outcome = (
        event.data as { outcome?: { status?: string; error?: any } }
      )?.outcome
      const runEndLog = {
        ...baseLog,
        errorDetail:
          outcome?.status === "error"
            ? getErrorMessage(outcome?.error)
            : undefined,
        errorTag:
          outcome?.status === "error" &&
          outcome?.error &&
          typeof outcome.error === "object" &&
          "_tag" in outcome.error
            ? String((outcome.error as { _tag?: string })._tag)
            : undefined,
        outcomeStatus: outcome?.status ?? "unknown",
      }
      if (outcome?.status === "error") {
        logger.error(runEndLog, "[JAF] Run ended with error")
      } else {
        logger.info(runEndLog, "[JAF] Run completed")
      }
      return
    }

    case "guardrail_violation":
      logger.warn(
        {
          ...baseLog,
          reason: event.data.reason,
          stage: event.data.stage,
        },
        "[JAF] Guardrail violation",
      )
      return

    case "handoff_denied":
      logger.warn(
        {
          ...baseLog,
          from: event.data.from,
          reason: event.data.reason,
          to: event.data.to,
        },
        "[JAF] Handoff denied",
      )
      return

    case "decode_error":
      logger.error(
        {
          ...baseLog,
          errors: event.data.errors,
        },
        "[JAF] Decode error",
      )
      return

    case "turn_start":
      logger.debug(
        {
          ...baseLog,
          agentName: event.data.agentName,
          turn: event.data.turn,
        },
        "[JAF] Turn started",
      )
      return

    case "turn_end":
      logger.debug(
        {
          ...baseLog,
          turn: event.data.turn,
        },
        "[JAF] Turn ended",
      )
      return

    case "tool_requests":
      logger.debug(
        {
          ...baseLog,
          toolCount: event.data.toolCalls.length,
          toolNames: event.data.toolCalls.map((toolCall) => toolCall.name),
        },
        "[JAF] Tool requests planned",
      )
      return

    case "tool_call_start":
      logger.debug(
        {
          ...baseLog,
          args: formatToolArgumentsForLogging(
            (event.data.args ?? {}) as Record<string, unknown>,
          ),
          toolName: event.data.toolName,
        },
        "[JAF] Tool call started",
      )
      return

    case "tool_call_end":
      if (event.data.error) {
        logger.error(
          {
            ...baseLog,
            error: event.data.error,
            executionTimeMs: event.data.executionTime,
            resultPreview: summarizeToolResultPayload(event.data.result),
            status: event.data.status ?? "error",
            toolName: event.data.toolName,
          },
          "[JAF] Tool call failed",
        )
      } else {
        logger.debug(
          {
            ...baseLog,
            executionTimeMs: event.data.executionTime,
            resultPreview: summarizeToolResultPayload(event.data.result),
            status: event.data.status ?? "completed",
            toolName: event.data.toolName,
          },
          "[JAF] Tool call completed",
        )
      }
      return

    case "assistant_message": {
      const content = getTextContent(event.data.message.content) || ""
      logger.debug(
        {
          ...baseLog,
          contentLength: content.length,
          contentPreview: truncateValue(content, 200),
          hasToolCalls:
            Array.isArray(event.data.message?.tool_calls) &&
            (event.data.message.tool_calls?.length ?? 0) > 0,
        },
        "[JAF] Assistant message received",
      )
      return
    }

    case "token_usage":
      logger.debug(
        {
          ...baseLog,
          completionTokens: event.data.completion ?? 0,
          promptTokens: event.data.prompt ?? 0,
          totalTokens: event.data.total ?? 0,
        },
        "[JAF] Token usage recorded",
      )
      return

    case "clarification_requested":
      logger.debug(
        {
          ...baseLog,
          clarificationId: event.data.clarificationId,
          optionsCount: event.data.options.length,
          question: truncateValue(event.data.question, 200),
        },
        "[JAF] Clarification requested",
      )
      return

    case "clarification_provided":
      logger.debug(
        {
          ...baseLog,
          clarificationId: event.data.clarificationId,
          selectedId: event.data.selectedId,
        },
        "[JAF] Clarification provided",
      )
      return

    case "final_output":
      logger.debug(
        {
          ...baseLog,
          outputLength:
            typeof event.data.output === "string"
              ? event.data.output.length
              : 0,
        },
        "[JAF] Final output emitted",
      )
      return

    default:
      logger.debug(baseLog, "[JAF] Trace event received")
      return
  }
}
