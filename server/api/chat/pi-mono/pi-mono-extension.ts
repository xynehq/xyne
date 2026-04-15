import type { ReasoningEmitter } from "@/api/chat/reasoning-steps"
import { ReasoningSteps, emitReasoningEvent } from "@/api/chat/reasoning-steps"
import type { MinimalAgentFragment } from "@/api/chat/types"
import type {
  BeforeAgentStartEvent,
  BeforeProviderRequestEvent,
  ExtensionAPI,
  SessionBeforeCompactEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent"
import type { XyneAgentState } from "./adapter"
import { trackFragments } from "./citation-state"
import { toolEventRegistry } from "./tool-event-mapper/index"
import { formatFragmentsForLLM } from "./tools/tool-utils"

const CITATION_STEER_THRESHOLD = 40

const CITATION_FORMAT_STEER_MESSAGE = [
  "IMPORTANT CITATION REMINDER: You have gathered many fragments.",
  "Each fragment has a citationDocId (e.g. 5) and chunks labeled [chunk:N] (e.g. [chunk:20]).",
  "To cite, combine them: K[5_20]. CORRECT: K[2_3], K[5_0], K[41_50].",
  "WRONG: K[5_chunkIndex], (citation5), (citations26-35), [citation16].",
  "NEVER write the literal word 'chunkIndex' — always use the actual number from [chunk:N].",
  "STRICT LIMIT: Maximum 1–2 citations per sentence or bullet. Pick the best 1–2 sources only. Do NOT list every matching fragment.",
].join(" ")

interface ExtensionState {
  xyneState: XyneAgentState
  currentTurn: { value: number }
  agenticModelId: string
  message: string
  email: string
  emitReasoningStep: ReasoningEmitter
}

// Global state ref - required because extensions are factory functions
let extensionStateRef: ExtensionState | null = null
let citationReminderSent = false

export function setExtensionState(state: ExtensionState): void {
  extensionStateRef = state
  citationReminderSent = false
}

export function getExtensionState(): ExtensionState | null {
  return extensionStateRef
}

export function clearExtensionState(): void {
  extensionStateRef = null
  citationReminderSent = false
}

export default function xyneExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
    const state = extensionStateRef
    if (!state) return undefined

    const { xyneState, emitReasoningStep } = state
    const attachmentContext = xyneState.attachmentContext

    // If no attachment context or no fragments, return undefined (no-op)
    if (!attachmentContext || attachmentContext.fragments.length === 0) {
      return undefined
    }

    // Push fragments into allFragments for citation tracking
    xyneState.allFragments.push(...attachmentContext.fragments)

    // Emit reasoning event for attachment extraction
    await emitReasoningStep(
      ReasoningSteps.attachmentExtracted(attachmentContext.fragments.length),
    )
    const startIndex = xyneState.allFragments.length + 1
    const fragmentCount = attachmentContext.fragments.length

    const textFragments = formatFragmentsForLLM(
      attachmentContext.fragments,
      startIndex,
    )

    attachmentContext.fragments.forEach(
      (fragment: { id: string }, idx: number) => {
        const citationDocId = startIndex + idx
        xyneState.citationDocIdMapping.set(citationDocId, fragment.id)
      },
    )

    xyneState.attachmentContext = undefined

    return {
      message: {
        customType: "attachment_context",
        content: textFragments,
        display: false,
        details: { fragmentCount },
      },
    }
  })

  pi.on(
    "tool_call",
    async (event: ToolCallEvent): Promise<ToolCallEventResult | undefined> => {
      const state = extensionStateRef
      if (!state) return

      return toolEventRegistry.handleToolCall(event, {
        emitReasoningStep: state.emitReasoningStep,
        xyneState: state.xyneState,
        sendSteerMessage: (msg: string) =>
          pi.sendMessage(
            { customType: "steer_message", content: msg, display: false },
            { deliverAs: "steer" },
          ),
      })
    },
  )

  pi.on("tool_result", async (event: ToolResultEvent) => {
    const state = extensionStateRef
    if (!state) return

    await toolEventRegistry.handleToolResult(event, {
      emitReasoningStep: state.emitReasoningStep,
      xyneState: state.xyneState,
    })

    const details = event.details as Record<string, unknown> | undefined

    if (details?.fragments && Array.isArray(details.fragments)) {
      const fragments = details.fragments as MinimalAgentFragment[]
      const startIndex = state.xyneState.allFragments.length + 1

      trackFragments(fragments, startIndex, state.xyneState)

      const totalFragments = state.xyneState.allFragments.length
      if (totalFragments >= CITATION_STEER_THRESHOLD && !citationReminderSent) {
        citationReminderSent = true
        pi.sendMessage(
          {
            customType: "citation_format_reminder",
            content: CITATION_FORMAT_STEER_MESSAGE,
            display: false,
          },
          { deliverAs: "steer" },
        )
      }
    }

    return {
      content: event.content,
      details: event.details,
      isError: event.isError,
    }
  })

  const THINKING_BUDGETS: Record<string, number> = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
  }

  pi.on(
    "before_provider_request",
    async (event: BeforeProviderRequestEvent) => {
      const payload = event.payload as Record<string, unknown> | undefined
      if (!payload || typeof payload !== "object") return payload

      const { chat_template_kwargs, reasoning_effort, ...rest } = payload

      const templateKwargs: Record<string, unknown> = {
        ...(chat_template_kwargs as Record<string, unknown>),
      }

      const effortLevel = reasoning_effort as string | undefined
      const enableThinking = !!effortLevel && effortLevel !== "off"

      // Only apply reasoning_effort conversion if not already set
      if (effortLevel !== undefined && !templateKwargs.enable_thinking) {
        templateKwargs.enable_thinking = enableThinking

        if (enableThinking) {
          const budget =
            THINKING_BUDGETS[effortLevel] ?? THINKING_BUDGETS.medium
          templateKwargs.thinking_budget = budget

          if (effortLevel === "minimal" || effortLevel === "low") {
            templateKwargs.low_effort = true
          }
        }
      } else if (effortLevel === undefined) {
        templateKwargs.enable_thinking = false
      }

      if (Object.keys(templateKwargs).length === 0) return payload

      return {
        ...rest,
        extra_body: {
          ...(rest.extra_body as Record<string, unknown>),
          chat_template_kwargs: templateKwargs,
        },
      }
    },
  )

  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent) => {
    const state = extensionStateRef
    if (state) {
      const messagesSummarized =
        event.preparation.messagesToSummarize.length +
        event.preparation.turnPrefixMessages.length
      emitReasoningEvent(
        state.emitReasoningStep,
        ReasoningSteps.contextCompacted(
          event.preparation.tokensBefore,
          messagesSummarized,
        ),
      )
    }
    return
  })
}
