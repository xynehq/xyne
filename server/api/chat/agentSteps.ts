import { SSEStreamingApi } from "hono/streaming"
import { Models } from "@/ai/types"
import {
    generateConsolidatedStepSummaryPromptJson,
    generateAgentStepSummaryPromptJson,
} from "@/ai/agentPrompts"
import config from "@/config"
import {
    jsonParseLLMOutput,
    generateSynthesisBasedOnToolOutput,
} from "@/ai/provider"
import {
    AgentReasoningStepType,
    ChatSSEvents,
    type AgentReasoningStep,
} from "@/shared/types"
import { getTracer } from "@/tracer"
import { getLogger, Subsystem } from "@/logger"
import { getErrorMessage } from "@/utils"
import { convertReasoningStepToText } from "./utils"

const { defaultFastModel } = config
const Logger = getLogger(Subsystem.Chat)

export interface AgentStepsDependencies {
    stream: SSEStreamingApi
    thinking: { value: string }
    dateForAI: string
    actualModelId: string | null
}

export class AgentSteps {
    private stream: SSEStreamingApi
    public thinking: { value: string }
    private dateForAI: string
    private actualModelId: string | null
    public structuredReasoningSteps: AgentReasoningStep[]
    public currentTurn: { value: number }
    private currentTurnAllSteps: AgentReasoningStep[]
    private turnStepsMap: Map<number, AgentReasoningStep[]>
    // JAF structure: Each run has up to 10 turns, each turn can have multiple tool calls
    // Track tool calls per turn for limiting display
    private currentTurnToolCalls: number
    private readonly MAX_TOOL_CALLS_PER_TURN = 5 // Limit displayed tool calls per turn

    constructor(dependencies: AgentStepsDependencies) {
        this.stream = dependencies.stream
        this.thinking = dependencies.thinking
        this.dateForAI = dependencies.dateForAI
        this.actualModelId = dependencies.actualModelId
        this.structuredReasoningSteps = []
        this.currentTurn = { value: 0 }
        this.currentTurnAllSteps = []
        this.turnStepsMap = new Map<number, AgentReasoningStep[]>()
        this.currentTurnToolCalls = 0
    }

    // Generate AI summary for agent reasoning steps
    async generateStepSummary(
        step: AgentReasoningStep,
        userQuery: string,
        contextInfo?: string,
        modelId?: string,
    ): Promise<string> {
        const tracer = getTracer("chat")
        const span = tracer.startSpan("generateStepSummary")

        try {
            span.setAttribute("step_type", step.type)
            span.setAttribute("step_iteration", step.iteration || 0)
            span.setAttribute("user_query_length", userQuery.length)
            span.setAttribute("has_context_info", !!contextInfo)

            const prompt = generateAgentStepSummaryPromptJson(
                step,
                userQuery,
                contextInfo,
            )

            // Use a fast model for summary generation
            const summarySpan = span.startSpan("synthesis_call")
            const summary = await generateSynthesisBasedOnToolOutput(
                prompt,
                this.dateForAI,
                "",
                "",
                {
                    modelId: (modelId as Models) || defaultFastModel,
                    stream: false,
                    json: true,
                    reasoning: false,
                    messages: [],
                },
            )
            summarySpan.setAttribute("model_id", defaultFastModel)
            summarySpan.end()

            const summaryResponse = summary.text || ""
            span.setAttribute("summary_response_length", summaryResponse.length)

            // Parse the JSON response
            const parseSpan = span.startSpan("parse_json_response")
            const parsed = jsonParseLLMOutput(summaryResponse)
            parseSpan.setAttribute("parse_success", !!parsed)
            parseSpan.setAttribute("has_summary", !!(parsed && parsed.summary))
            parseSpan.end()

            Logger.debug("Parsed reasoning step:", { parsed })
            Logger.debug("Generated summary:", { summary: parsed.summary })
            const finalSummary = parsed.summary || this.generateFallbackSummary(step)
            span.setAttribute("final_summary_length", finalSummary.length)
            span.setAttribute("used_fallback", !parsed.summary)
            span.end()
            return finalSummary
        } catch (error) {
            span.addEvent("error", {
                message: getErrorMessage(error),
                stack: (error as Error).stack || "",
            })
            Logger.error(`Error generating step summary: ${error}`)
            const fallbackSummary = this.generateFallbackSummary(step)
            span.setAttribute("fallback_summary", fallbackSummary)
            span.setAttribute("used_fallback", true)
            span.end()
            return fallbackSummary
        }
    }

    // Generate fallback summary when AI generation fails
    generateFallbackSummary(step: AgentReasoningStep): string {
        switch (step.type) {
            case AgentReasoningStepType.Iteration:
                return `Planning search iteration ${step.iteration}`
            case AgentReasoningStepType.ToolExecuting:
                return `Executing ${step.toolName} tool`
            case AgentReasoningStepType.ToolResult:
                return `Found ${step.itemsFound || 0} results`
            case AgentReasoningStepType.Synthesis:
                return "Analyzing gathered information"
            case AgentReasoningStepType.BroadeningSearch:
                return "Expanding search scope"
            case AgentReasoningStepType.Planning:
                return "Planning next step"
            case AgentReasoningStepType.AnalyzingQuery:
                return "Understanding your request"
            case AgentReasoningStepType.ToolSelected:
                return `Tool selected: ${step.toolName}`
            case AgentReasoningStepType.ToolParameters:
                return `Tool parameters: ${JSON.stringify(step.parameters)}`
            default:
                return "Processing step"
        }
    }

    // Helper function to create turn summary steps
    createTurnSummaryStep(
        summary: string,
        turnNumber: number,
    ): AgentReasoningStep {
        return {
            type: AgentReasoningStepType.LogMessage,
            stepId: `turn_summary_${turnNumber}_${Date.now()}`,
            timestamp: Date.now(),
            status: "completed",
            iteration: turnNumber, // Use iteration field for turn number compatibility
            message: summary,
            stepSummary: summary,
            aiGeneratedSummary: summary,
            isIterationSummary: true, // Keep same flag name for frontend compatibility
        }
    }

    // Generate and stream turn summary (JAF: each turn can have multiple tool calls)
    async generateAndStreamTurnSummary(
        turnNumber: number,
        allSteps: AgentReasoningStep[],
        userQuery: string,
    ): Promise<void> {
        try {
            const prompt = generateConsolidatedStepSummaryPromptJson(
                allSteps,
                userQuery,
                turnNumber,
                `Turn ${turnNumber} complete summary`,
            )

            // Use the selected model or fallback to fast model for summary generation
            const summaryResult = await generateSynthesisBasedOnToolOutput(
                prompt,
                this.dateForAI,
                "",
                "",
                {
                    modelId: (this.actualModelId as Models) || defaultFastModel,
                    stream: false,
                    json: true,
                    reasoning: false,
                    messages: [],
                },
            )

            const summaryResponse = summaryResult.text || ""

            // Parse the JSON response
            const parsed = jsonParseLLMOutput(summaryResponse)
            const toolCallsCount = allSteps.filter(
                (s) => s.type === AgentReasoningStepType.ToolResult,
            ).length
            const summary =
                parsed.summary ||
                `Completed turn ${turnNumber} with ${toolCallsCount} tool call${toolCallsCount !== 1 ? "s" : ""} and ${allSteps.length} total steps.`

            // Create the turn summary step
            const turnSummaryStep = this.createTurnSummaryStep(summary, turnNumber)

            // Add to structured reasoning steps so it gets saved to DB
            this.structuredReasoningSteps.push(turnSummaryStep)

            const data = JSON.stringify({
                text: summary,
                step: turnSummaryStep,
            })
            this.thinking.value += `${data}\n`

            // Stream the turn summary
            await this.stream.writeSSE({
                event: ChatSSEvents.Reasoning,
                data: data,
            })
        } catch (error) {
            Logger.error(`Error generating turn summary: ${error}`, { error })
            // Fallback summary
            const toolCallsCount = allSteps.filter(
                (s) => s.type === AgentReasoningStepType.ToolResult,
            ).length
            const fallbackSummary = `Completed turn ${turnNumber} with ${toolCallsCount} tool call${toolCallsCount !== 1 ? "s" : ""} and ${allSteps.length} total steps.`

            // Create the fallback turn summary step
            const fallbackSummaryStep = this.createTurnSummaryStep(
                fallbackSummary,
                turnNumber,
            )

            // Add to structured reasoning steps so it gets saved to DB
            this.structuredReasoningSteps.push(fallbackSummaryStep)

            const data = JSON.stringify({
                text: fallbackSummary,
                step: fallbackSummaryStep,
            })

            this.thinking.value += `${data}\n`

            await this.stream.writeSSE({
                event: ChatSSEvents.Reasoning,
                data: data,
            })
        }
    }

    async logAndStreamReasoning(
        reasoningStep: AgentReasoningStep,
        userQuery: string,
    ): Promise<void> {
        const stepId = `step_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        const timestamp = Date.now()

        if (reasoningStep.type === AgentReasoningStepType.Iteration) {
            // Generate summary for previous turn if it exists
            if (this.currentTurn.value > 0 && this.currentTurnAllSteps.length > 0) {
                await this.generateAndStreamTurnSummary(
                    this.currentTurn.value,
                    this.currentTurnAllSteps,
                    userQuery,
                )
            }

            // Update to new turn
            this.currentTurn.value = reasoningStep.iteration ?? this.currentTurn.value + 1
            this.currentTurnToolCalls = 0 // Reset tool call counter for new turn
            this.currentTurnAllSteps = [] // Reset all steps for new turn

            // Store steps for this turn
            if (!this.turnStepsMap.has(this.currentTurn.value)) {
                this.turnStepsMap.set(this.currentTurn.value, [])
            }
        } else {
            // Track all steps in current turn for summary
            this.currentTurnAllSteps.push(reasoningStep)
            const turnSteps = this.turnStepsMap.get(this.currentTurn.value) || []
            turnSteps.push(reasoningStep)
            this.turnStepsMap.set(this.currentTurn.value, turnSteps)

            // Check if this is a tool-related step (tool calls are the steps in JAF)
            const isToolStep =
                reasoningStep.type === AgentReasoningStepType.ToolSelected ||
                reasoningStep.type === AgentReasoningStepType.ToolExecuting ||
                reasoningStep.type === AgentReasoningStepType.ToolResult

            // For tool-related steps, check if we've exceeded the limit for this turn
            if (isToolStep) {
                // Skip tool calls beyond the limit for current turn
                if (this.currentTurnToolCalls >= this.MAX_TOOL_CALLS_PER_TURN) {
                    // For skipped tool calls, only generate fallback summary (no AI call)
                    const enhancedStep: AgentReasoningStep = {
                        ...reasoningStep,
                        stepId,
                        timestamp,
                        iteration: this.currentTurn.value,
                        status: reasoningStep.status || "in_progress",
                        stepSummary: this.generateFallbackSummary(reasoningStep), // Only fallback summary
                    }

                    // Still track it internally for summaries, but don't stream to frontend
                    this.structuredReasoningSteps.push(enhancedStep)
                    return // Don't stream to frontend
                }
                // Increment tool call counter only for tool-related steps
                this.currentTurnToolCalls++
            }
        }

        // Generate AI summary ONLY for displayed steps (first 5 tool calls per turn)
        const aiGeneratedSummary = await this.generateStepSummary(
            reasoningStep,
            userQuery,
            undefined,
            this.actualModelId || undefined,
        )

        const enhancedStep: AgentReasoningStep = {
            ...reasoningStep,
            stepId,
            timestamp,
            iteration: this.currentTurn.value, // Store turn number in iteration field for compatibility
            status: reasoningStep.status || "in_progress",
            stepSummary: this.generateFallbackSummary(reasoningStep), // Quick fallback
            aiGeneratedSummary, // AI-generated summary only for displayed steps
        }

        const humanReadableLog = convertReasoningStepToText(enhancedStep)
        this.structuredReasoningSteps.push(enhancedStep)
        const data = JSON.stringify({
            text: humanReadableLog,
            step: enhancedStep,
        })
        this.thinking.value += `${data}\n`
        // Stream both summaries
        await this.stream.writeSSE({
            event: ChatSSEvents.Reasoning,
            data: data,
        })
    }
}
