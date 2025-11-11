/**
 * MessageAgents - JAF-Based Agentic Architecture Implementation
 * 
 * New agentic flow with:
 * - Single agent with toDoWrite for planning
 * - Automatic turn-end review
 * - Enhanced onBeforeToolExecution and onAfterToolExecution hooks
 * - Complete telemetry tracking
 * - Task-based sequential execution
 */

import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import { HTTPException } from "hono/http-exception"
import type {
  AgentRunContext,
  PlanState,
  ToolExecutionRecord,
  ReviewResult,
  AutoReviewInput,
  ToolFailureInfo,
  ToolExpectation,
  ToolExpectationAssignment,
} from "./agent-schemas"
import { ToolExpectationSchema, ReviewResultSchema } from "./agent-schemas"
import { getTracer } from "@/tracer"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem, type UserMetadataType } from "@/types"
import config from "@/config"
import { Models, type ModelParams } from "@/ai/types"
import {
  runStream,
  generateRunId,
  generateTraceId,
  getTextContent,
  ToolResponse,
  type Agent as JAFAgent,
  type Message as JAFMessage,
  type RunConfig as JAFRunConfig,
  type RunState as JAFRunState,
  type Tool,
  type ToolCall,
  type ToolResult,
} from "@xynehq/jaf"
import { makeXyneJAFProvider } from "./jaf-provider"
import {
  buildInternalJAFTools,
  type JAFAdapterCtx,
  buildContextSection,
} from "./jaf-adapter"
import { getErrorMessage } from "@/utils"
import { ChatSSEvents } from "@/shared/types"
import type { MinimalAgentFragment, Citation, ImageCitation } from "./types"
import {
  extractBestDocumentIndexes,
  getProviderByModel,
  jsonParseLLMOutput,
} from "@/ai/provider"
import { answerContextMap, userContext } from "@/ai/context"
import { ConversationRole } from "@aws-sdk/client-bedrock-runtime"
import type { Message } from "@aws-sdk/client-bedrock-runtime"
import {
  TOOL_SCHEMAS,
  generateToolDescriptions,
  validateToolInput,
  ListCustomAgentsOutputSchema,
  type ListCustomAgentsOutput,
  ReviewAgentOutputSchema,
  type ToolOutput,
} from "./tool-schemas"
import { searchToCitation } from "./utils"
import { GetDocumentsByDocIds } from "@/search/vespa"
import type { VespaSearchResult, VespaSearchResults } from "@xyne/vespa-ts/types"
import { expandSheetIds } from "@/search/utils"
import { parseAttachmentMetadata } from "@/utils/parseAttachment"
import { db } from "@/db/client"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getUserAccessibleAgents } from "@/db/userAgentPermission"
import { ExecuteAgentForWorkflow } from "@/api/agent/workflowAgentUtils"
import { getDateForAI } from "@/utils/index"

const { defaultBestModel, defaultFastModel, JwtPayloadKey } = config
const Logger = getLogger(Subsystem.Chat)
const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

/**
 * Initialize AgentRunContext with default values
 */
function initializeAgentContext(
  userEmail: string,
  workspaceId: string,
  userId: number,
  chatExternalId: string,
  messageText: string,
  attachments: Array<{ fileId: string; isImage: boolean }>,
  options?: {
    userContext?: string
    agentPrompt?: string
    workspaceNumericId?: number
  }
): AgentRunContext {
  return {
    user: {
      email: userEmail,
      workspaceId,
      id: String(userId),
      numericId: userId,
      workspaceNumericId: options?.workspaceNumericId,
    },
    chat: {
      externalId: chatExternalId,
      metadata: {},
    },
    message: {
      text: messageText,
      attachments,
      timestamp: new Date().toISOString(),
    },
    plan: null,
    currentSubTask: null,
    userContext: options?.userContext ?? "",
    agentPrompt: options?.agentPrompt,
    clarifications: [],
    ambiguityResolved: false,
    toolCallHistory: [],
    contextFragments: [],
    seenDocuments: new Set<string>(),
    totalLatency: 0,
    totalCost: 0,
    tokenUsage: {
      input: 0,
      output: 0,
    },
    availableAgents: [],
    usedAgents: [],
    enabledTools: new Set<string>(),
    failedTools: new Map<string, ToolFailureInfo>(),
    retryCount: 0,
    maxRetries: 3,
    review: {
      lastReviewTurn: null,
      reviewFrequency: 5,
      lastReviewSummary: null,
    },
    decisions: [],
  }
}

/**
 * Perform automatic turn-end review (STUB for now)
 * Called deterministically after every turn
 */
async function performAutomaticReview(
  input: AutoReviewInput,
  fullContext: AgentRunContext
): Promise<ReviewResult> {
  try {
    const review = await runReviewLLM(fullContext, {
      focus: "turn_end",
      turnNumber: input.turnNumber,
      expectedResults: input.expectedResults,
    })
    return review
  } catch (error) {
    Logger.error(error, "Automatic review failed, falling back to default response")
    return {
      status: "ok",
      qualityScore: 0.6,
      completeness: 0.6,
      relevance: 0.6,
      needsMoreData: false,
      gaps: [],
      suggestedActions: [],
      recommendation: "proceed",
      notes: `Automatic review fallback for turn ${input.turnNumber}: ${getErrorMessage(error)}`,
    }
  }
}

type AttachmentPhaseMetadata = {
  initialAttachmentPhase?: boolean
  initialAttachmentSummary?: string
}

function getAttachmentPhaseMetadata(
  context: AgentRunContext
): AttachmentPhaseMetadata {
  return (context.chat.metadata as AttachmentPhaseMetadata) || {}
}

async function vespaResultToAttachmentFragment(
  child: VespaSearchResult,
  idx: number,
  userMetadata: UserMetadataType,
  query: string
): Promise<MinimalAgentFragment> {
  const docId =
    (child.fields as Record<string, unknown>)?.docId ||
    `attachment_fragment_${idx}`

  return {
    id: String(docId),
    content: await answerContextMap(
      child as VespaSearchResults,
      userMetadata,
      0,
      true,
      undefined,
      query
    ),
    source: searchToCitation(child as VespaSearchResults),
    confidence: 1,
  }
}

async function prepareInitialAttachmentContext(
  fileIds: string[],
  userMetadata: UserMetadataType,
  query: string
): Promise<{ fragments: MinimalAgentFragment[]; summary: string } | null> {
  if (!fileIds?.length) {
    return null
  }

  const tracer = getTracer("chat")
  const span = tracer.startSpan("prepare_initial_attachment_context")

  try {
    const results = await GetDocumentsByDocIds(fileIds, span)
    const children = results?.root?.children || []
    if (children.length === 0) {
      return null
    }

    const fragments = await Promise.all(
      children.map((child, idx) =>
        vespaResultToAttachmentFragment(
          child as VespaSearchResult,
          idx,
          userMetadata,
          query
        )
      )
    )

    const summary = `User provided ${fragments.length} attachment fragment${
      fragments.length === 1 ? "" : "s"
    } for the first turn.`
    return { fragments, summary }
  } catch (error) {
    span.addEvent("attachment_context_error", {
      message: getErrorMessage(error),
    })
    Logger.error(error, "Failed to load attachment context")
    return null
  } finally {
    span.end()
  }
}

/**
 * onBeforeToolExecution Hook Implementation
 * Handles:
 * - Input validation against schemas
 * - Duplicate detection
 * - Failed tool budget check (3-strike rule)
 * - excludedIds injection
 */
export async function beforeToolExecutionHook(
  toolName: string,
  args: any,
  context: AgentRunContext,
  emitSSE?: (event: string, data: any) => Promise<void>
): Promise<any | null> {
  // 0. Validate input against schema
  const validation = validateToolInput(toolName, args)
  if (!validation.success) {
    if (emitSSE) {
      await emitSSE(
        ChatSSEvents.Reasoning,
        `⚠️ Invalid input for ${toolName}: ${validation.error.message}`
      )
    }
    Logger.warn(
      `Tool input validation failed for ${toolName}: ${validation.error.message}`
    )
    // Don't block - let tool handle invalid input, but log it
  }

  // 1. Duplicate detection
  const isDuplicate = context.toolCallHistory.some(
    (record) =>
      record.toolName === toolName &&
      JSON.stringify(record.arguments) === JSON.stringify(args) &&
      record.status === "success" &&
      Date.now() - record.startedAt.getTime() < 60000 // 1 minute
  )

  if (isDuplicate) {
    if (emitSSE) {
      await emitSSE(
        ChatSSEvents.Reasoning,
        `⚠️ Skipping duplicate ${toolName} call`
      )
    }
    return null // Skip execution
  }

  // 2. Failed tool budget check
  const failureInfo = context.failedTools.get(toolName)
  if (failureInfo && failureInfo.count >= 3) {
    if (emitSSE) {
      await emitSSE(
        ChatSSEvents.Reasoning,
        `⚠️ ${toolName} has failed ${failureInfo.count} times, blocked`
      )
    }
    return null // Skip execution
  }

  // 3. Add excludedIds to prevent re-fetching seen documents
  if (args.excludedIds !== undefined) {
    const seenIds = Array.from(context.seenDocuments)
    return {
      ...args,
      excludedIds: [...(args.excludedIds || []), ...seenIds],
    }
  }

  return args
}

/**
 * onAfterToolExecution Hook Implementation
 * Handles:
 * - ToolExecutionRecord creation and logging
 * - Context extraction and filtering
 * - Metrics update
 * - Failure tracking
 * - SSE event emission
 */
export async function afterToolExecutionHook(
  toolName: string,
  result: any,
  hookContext: {
    toolCall: ToolCall
    args: any
    state: JAFRunState<AgentRunContext>
    agentName: string
    executionTime: number
    status: string | ToolResult
  },
  userMessage: string,
  messagesWithNoErrResponse: Message[],
  gatheredFragmentskeys: Set<string>,
  expectedResult: ToolExpectation | undefined,
  emitSSE?: (event: string, data: any) => Promise<void>
): Promise<string | null> {
  const { state, executionTime, status, args } = hookContext
  const context = state.context as AgentRunContext

  // 1. Create execution record
  const record: ToolExecutionRecord = {
    toolName,
    connectorId: result?.metadata?.connectorId || null,
    agentName: hookContext.agentName,
    arguments: args,
    expectedResults: expectedResult,
    startedAt: new Date(Date.now() - executionTime),
    durationMs: executionTime,
    estimatedCostUsd: result?.metadata?.estimatedCostUsd || 0,
    resultSummary: JSON.stringify(result?.data || {}).slice(0, 200),
    fragmentsAdded: result?.metadata?.fragmentsAdded || [],
    status: status === "success" ? "success" : "error",
    error:
      status !== "success"
        ? {
            code: result?.error?.code || "UNKNOWN",
            message: result?.error?.message || "Unknown error",
          }
        : undefined,
  }

  // 2. Add to history
  context.toolCallHistory.push(record)

  // 3. Update metrics
  context.totalLatency += executionTime
  context.totalCost += record.estimatedCostUsd

  // 4. Track failures
  if (status !== "success") {
    const existing = context.failedTools.get(toolName) || {
      count: 0,
      lastError: "",
      lastAttempt: 0,
    }
    context.failedTools.set(toolName, {
      count: existing.count + 1,
      lastError: record.error!.message,
      lastAttempt: Date.now(),
    })
  }

  // 5. Extract and filter contexts
  const contexts = result?.metadata?.contexts
  if (Array.isArray(contexts) && contexts.length > 0) {
    const filteredContexts = contexts.filter(
      (c: MinimalAgentFragment) => !gatheredFragmentskeys.has(c.id)
    )

    if (filteredContexts.length > 0) {
      const contextStrings = filteredContexts.map(
        (v: MinimalAgentFragment) => {
          context.seenDocuments.add(v.id)
          return `
            title: ${v.source.title}\n
            content: ${v.content}\n
          `
        }
      )

      try {
        // Use extractBestDocumentIndexes to filter to best documents
        const bestDocIndexes = await extractBestDocumentIndexes(
          userMessage,
          contextStrings,
          {
            modelId: config.defaultBestModel,
            json: false,
            stream: false,
          },
          messagesWithNoErrResponse
        )

        if (bestDocIndexes.length > 0) {
          const selectedDocs: MinimalAgentFragment[] = []

          bestDocIndexes.forEach((idx) => {
            if (idx >= 1 && idx <= filteredContexts.length) {
              const doc: MinimalAgentFragment = filteredContexts[idx - 1]
              const key = doc.id
              if (!gatheredFragmentskeys.has(key)) {
                context.contextFragments.push(doc)
                gatheredFragmentskeys.add(key)
              }
              selectedDocs.push(doc)
            }
          })

          // Update record with actual fragments added
          record.fragmentsAdded = selectedDocs.map((d) => d.id)

          // Emit SSE event (ToolMetric event to be added to ChatSSEvents later)
          // if (emitSSE) {
          //   await emitSSE(ChatSSEvents.ToolMetric, {
          //     toolName,
          //     durationMs: executionTime,
          //     cost: record.estimatedCostUsd,
          //     status,
          //     fragmentsAdded: record.fragmentsAdded.length,
          //   })
          // }

          return selectedDocs.map((doc) => doc.content).join("\n")
        }
      } catch (error) {
        // Fallback: add all contexts if extraction fails
        filteredContexts.forEach((doc: MinimalAgentFragment) => {
          const key = doc.id
          if (!gatheredFragmentskeys.has(key)) {
            context.contextFragments.push(doc)
            gatheredFragmentskeys.add(key)
          }
        })
        record.fragmentsAdded = filteredContexts.map((d: MinimalAgentFragment) => d.id)
      }
    }
  }

  // Emit metrics even if no contexts (ToolMetric event to be added to ChatSSEvents later)
  // if (emitSSE) {
  //   await emitSSE(ChatSSEvents.ToolMetric, {
  //     toolName,
  //     durationMs: executionTime,
  //     cost: record.estimatedCostUsd,
  //     status,
  //     fragmentsAdded: record.fragmentsAdded.length,
  //   })
  // }

  return null
}

type PendingExpectation = ToolExpectationAssignment

export function extractExpectedResults(text: string): PendingExpectation[] {
  const expectations: PendingExpectation[] = []
  if (!text) return expectations

  const expectationRegex = /<expected_results>([\s\S]*?)<\/expected_results>/gi
  let match: RegExpExecArray | null

  while ((match = expectationRegex.exec(text)) !== null) {
    const body = match[1]?.trim()
    if (!body) continue

    const parsed = safeJsonParse(body)
    const entries = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as any)?.toolExpectations)
        ? (parsed as any).toolExpectations
        : []

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue
      const toolName = typeof entry.toolName === "string" ? entry.toolName.trim() : ""
      if (!toolName) continue

      const expectationCandidate = {
        goal: (entry as any).goal,
        successCriteria: (entry as any).successCriteria,
        failureSignals: (entry as any).failureSignals,
        stopCondition: (entry as any).stopCondition,
        evidencePlan: (entry as any).evidencePlan,
      }

      const validation = ToolExpectationSchema.safeParse(expectationCandidate)
      if (!validation.success) {
        Logger.warn(
          { toolName, error: validation.error.format() },
          "Invalid expected_results entry emitted by agent"
        )
        continue
      }

      expectations.push({ toolName, expectation: validation.data })
    }
  }

  return expectations
}

function consumePendingExpectation(
  queue: PendingExpectation[],
  toolName: string
): PendingExpectation | undefined {
  if (!toolName) return undefined
  const idx = queue.findIndex(
    (entry) => entry.toolName.toLowerCase() === toolName.toLowerCase()
  )
  if (idx === -1) {
    return undefined
  }
  return queue.splice(idx, 1)[0]
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function summarizePlan(plan: PlanState | null): string {
  if (!plan) return "No plan available."
  const steps = plan.subTasks
    .map(
      (task, idx) =>
        `${idx + 1}. [${task.status}] ${task.description}${
          task.toolsRequired?.length
            ? ` (tools: ${task.toolsRequired.join(", ")})`
            : ""
        }`
    )
    .join("\n")
  return `Goal: ${plan.goal}\n${steps}`
}

function summarizeExpectations(
  expectations?: ToolExpectationAssignment[]
): string {
  if (!expectations || expectations.length === 0) {
    return "No explicit expected results provided."
  }

  return expectations
    .map((entry, idx) => {
      const expectation = entry.expectation
      const success = expectation.successCriteria.join("; ")
      const failures = expectation.failureSignals?.length
        ? `\n   Failure Signals: ${expectation.failureSignals.join("; ")}`
        : ""
      const stop = expectation.stopCondition
        ? `\n   Stop Condition: ${expectation.stopCondition}`
        : ""
      return `${idx + 1}. Tool: ${entry.toolName}\n   Goal: ${expectation.goal}\n   Success Criteria: ${success}${failures}${stop}`
    })
    .join("\n")
}

function summarizeToolHistory(
  records: ToolExecutionRecord[],
  limit = 8
): string {
  if (!records.length) {
    return "No tool executions yet."
  }

  return records
    .slice(-limit)
    .map((record, idx) => {
      const expectationSummary = record.expectedResults
        ? `Expected: ${record.expectedResults.goal}`
        : "Expected: not provided"
      return `${idx + 1}. ${record.toolName} (${record.status})\nArgs: ${JSON.stringify(
        record.arguments
      )}\n${expectationSummary}\nResult: ${record.resultSummary}`
    })
    .join("\n\n")
}

function summarizeFragments(
  fragments: MinimalAgentFragment[],
  limit = 5
): string {
  if (!fragments.length) return "No context fragments gathered yet."
  return fragments
    .slice(-limit)
    .map(
      (fragment, idx) =>
        `${idx + 1}. ${fragment.source.title || fragment.id} -> ${
          fragment.content?.slice(0, 200) || ""
        }`
    )
    .join("\n")
}

async function runReviewLLM(
  context: AgentRunContext,
  options?: {
    focus?: string
    turnNumber?: number
    maxFindings?: number
    expectedResults?: ToolExpectationAssignment[]
  }
): Promise<ReviewResult> {
  const modelId =
    (defaultFastModel as Models) || (defaultBestModel as Models)
  const params: ModelParams = {
    modelId,
    json: true,
    stream: false,
    temperature: 0,
    maxTokens: 800,
    systemPrompt: `You are a senior reviewer ensuring agentic executions satisfy their expected results. 
Respond strictly in JSON adhering to this schema: ${JSON.stringify({
      status: "ok",
      qualityScore: 0,
      completeness: 0,
      relevance: 0,
      needsMoreData: false,
      gaps: [],
      suggestedActions: [],
      recommendation: "proceed",
      notes: "string",
    })}`,
  }

  const payload = [
    `Focus: ${options?.focus ?? "general"}`,
    options?.turnNumber ? `Turn: ${options.turnNumber}` : "",
    `Expected Results:\n${summarizeExpectations(options?.expectedResults)}`,
    `Plan:\n${summarizePlan(context.plan)}`,
    `Recent Tool Calls:\n${summarizeToolHistory(
      context.toolCallHistory,
      options?.maxFindings ?? 8
    )}`,
    `Context Fragments:\n${summarizeFragments(context.contextFragments)}`,
  ]
    .filter(Boolean)
    .join("\n\n")

  const messages: Message[] = [
    {
      role: ConversationRole.USER,
      content: [
        {
          text: payload,
        },
      ],
    },
  ]

  const { text } = await getProviderByModel(modelId).converse(
    messages,
    params
  )

  if (!text) {
    throw new Error("LLM returned empty review response")
  }

  const parsed = jsonParseLLMOutput(text)
  const validation = ReviewResultSchema.safeParse(parsed)
  if (!validation.success) {
    throw new Error("Review result does not match schema")
  }
  return validation.data
}

function buildInternalToolAdapters(): Tool<unknown, AgentRunContext>[] {
  const internalTools = buildInternalJAFTools()
  return internalTools.map((tool) => ({
    schema: tool.schema,
    async execute(args, context) {
      const adapterCtx: JAFAdapterCtx = {
        email: context.user.email,
        userCtx: context.userContext,
        agentPrompt: context.agentPrompt,
        userMessage: context.message.text,
      }
      return tool.execute(
        args,
        adapterCtx as unknown as JAFAdapterCtx
      )
    },
  }))
}

function buildCustomAgentTools(): Array<Tool<unknown, AgentRunContext>> {
  return [
    createListCustomAgentsTool(),
    createRunPublicAgentTool(),
    createReviewTool(),
  ]
}

function createListCustomAgentsTool(): Tool<unknown, AgentRunContext> {
  return {
    schema: {
      name: "list_custom_agents",
      description: TOOL_SCHEMAS.list_custom_agents.description,
      parameters: TOOL_SCHEMAS.list_custom_agents.inputSchema,
    },
    async execute(args, context) {
      const validation = validateToolInput<{
        query: string
        requiredCapabilities?: string[]
        maxAgents?: number
      }>("list_custom_agents", args)

      if (!validation.success) {
        return ToolResponse.error(
          "INVALID_INPUT",
          validation.error.message
        )
      }

      const result = await listCustomAgentsSuitable({
        query: validation.data.query,
        userEmail: context.user.email,
        workspaceExternalId: context.user.workspaceId,
        workspaceNumericId: context.user.workspaceNumericId,
        userId: context.user.numericId,
        requiredCapabilities: validation.data.requiredCapabilities,
        maxAgents: validation.data.maxAgents,
      })

      context.availableAgents = result.agents
      return ToolResponse.success(result.result, {
        metadata: result,
      })
    },
  }
}

function createRunPublicAgentTool(): Tool<unknown, AgentRunContext> {
  return {
    schema: {
      name: "run_public_agent",
      description: TOOL_SCHEMAS.run_public_agent.description,
      parameters: TOOL_SCHEMAS.run_public_agent.inputSchema,
    },
    async execute(args, context) {
      const validation = validateToolInput<{
        agentId: string
        query: string
        context?: string
        maxTokens?: number
      }>("run_public_agent", args)

      if (!validation.success) {
        return ToolResponse.error(
          "INVALID_INPUT",
          validation.error.message
        )
      }

      if (!context.ambiguityResolved) {
        return ToolResponse.error(
          "AMBIGUITY_NOT_RESOLVED",
          "Resolve ambiguity before running a custom agent."
        )
      }

      const agentCapability = context.availableAgents.find(
        (agent) => agent.agentId === validation.data.agentId
      )
      if (!agentCapability) {
        return ToolResponse.error(
          "UNKNOWN_AGENT",
          "Call list_custom_agents before executing a custom agent."
        )
      }

      const toolOutput = await executeCustomAgent({
        agentId: validation.data.agentId,
        query: validation.data.query,
        contextSnippet: validation.data.context,
        maxTokens: validation.data.maxTokens,
        userEmail: context.user.email,
        workspaceExternalId: context.user.workspaceId,
      })

      context.usedAgents.push(agentCapability.agentId)

      return ToolResponse.success(toolOutput.result, {
        metadata: {
          ...toolOutput.metadata,
          agentId: validation.data.agentId,
        },
        data: toolOutput,
      })
    },
  }
}

function createReviewTool(): Tool<unknown, AgentRunContext> {
  return {
    schema: {
      name: "review_agent",
      description: TOOL_SCHEMAS.review_agent.description,
      parameters: TOOL_SCHEMAS.review_agent.inputSchema,
    },
    async execute(args, context) {
      const validation = validateToolInput<{
        focus?: string
        includePlan?: boolean
        maxFindings?: number
      }>("review_agent", args)

      if (!validation.success) {
        return ToolResponse.error(
          "INVALID_INPUT",
          validation.error.message
        )
      }

      const review = await runReviewLLM(context, {
        focus: validation.data.focus,
        maxFindings: validation.data.maxFindings,
      })

      context.review.lastReviewSummary = review.notes

      const reviewOutput = {
        result: review.notes,
        recommendation: review.recommendation,
        metExpectations: review.gaps.length === 0,
        unmetExpectations: review.gaps,
        gaps: review.gaps,
        suggestedActions: review.suggestedActions.map(
          (action) => `${action.type}: ${action.reason}`
        ),
      }

      const outputValidation =
        ReviewAgentOutputSchema.safeParse(reviewOutput)
      if (!outputValidation.success) {
          Logger.warn(
            { error: outputValidation.error.format() },
            "Review tool output failed schema validation"
          )
      }

      return ToolResponse.success(review.notes, {
        metadata: reviewOutput,
        data: review,
      })
    },
  }
}

/**
 * Build dynamic agent instructions including plan state and tool descriptions
 */
function buildAttachmentDirective(context: AgentRunContext): string {
  const { initialAttachmentPhase, initialAttachmentSummary } =
    getAttachmentPhaseMetadata(context)
  if (!initialAttachmentPhase) {
    return ""
  }

  const summaryLine =
    initialAttachmentSummary ||
    "User provided attachment context for this opening turn."

  return `
# ATTACHMENT-FIRST TURN
- ${summaryLine}
- Attempt to answer using ONLY the attachment context fragments listed below.
- If they fully answer the query, respond directly without calling tools.
- If they are insufficient, explain what is missing, then call toDoWrite to plan additional research before invoking other tools.
- Capture any useful facts from the attachments so they remain available in later turns.
`.trim()
}

function buildAgentInstructions(
  context: AgentRunContext,
  enabledToolNames: string[],
  dateForAI: string,
  agentPrompt?: string
): string {
  // Use schema-based tool descriptions for better LLM understanding
  const toolDescriptions = enabledToolNames.length > 0
    ? generateToolDescriptions(enabledToolNames)
    : "No tools available yet. "
  
  const contextSection = buildContextSection(context.contextFragments)
  const agentSection = agentPrompt ? `\n\nAgent Constraints:\n${agentPrompt}` : ""
  const attachmentDirective = buildAttachmentDirective(context)
  
  let planSection = "\n<plan>\n"
  if (context.plan) {
    planSection += `Goal: ${context.plan.goal}\n\n`
    planSection += "Steps:\n"
    context.plan.subTasks.forEach((task, i) => {
      const status =
        task.status === "completed" ? "✓" :
        task.status === "in_progress" ? "→" :
        task.status === "failed" ? "✗" : "○"
      planSection += `${i + 1}. [${status}] ${task.description}\n`
      if (task.toolsRequired && task.toolsRequired.length > 0) {
        planSection += `   Tools: ${task.toolsRequired.join(", ")}\n`
      }
    })
    planSection += "\n</plan>\n"
  } else {
    planSection += "No plan exists yet. Use toDoWrite to create one.\n</plan>\n"
  }

  return `
You are Xyne, an enterprise search assistant with agentic capabilities.

The current date is: ${dateForAI}

<context>
User: ${context.user.email}
Workspace: ${context.user.workspaceId}
</context>

${planSection}

<available_tools>
${toolDescriptions}
</available_tools>

${contextSection}

${agentSection}

${attachmentDirective ? `${attachmentDirective}\n` : ""}

# PLANNING
- ALWAYS start by creating a plan using toDoWrite
- Break the goal into clear, sequential tasks (one sub-goal per task)
- Each task represents one sub-goal that must be completed before moving to the next
- Within a task, identify all tools needed to achieve that sub-goal
- Update plan as you learn more

# EXECUTION STRATEGY
- Execute ONE TASK AT A TIME in sequential order
- Complete each task fully before moving to the next
- Within a single task, you may call multiple tools if they all contribute to that task's sub-goal
- Do NOT mix tools from different sub-goals in the same task

# TOOL CALLS & EXPECTATIONS
- Use the model's native function/tool-call interface. Provide clean JSON arguments.
- Do NOT wrap tool calls in custom XML—JAF already handles execution.
- After you decide which tools to call, emit a standalone expected-results block summarizing what each tool should achieve:
<expected_results>
[
  {
    "toolName": "searchGlobal",
    "goal": "Find Q4 ARR mentions",
    "successCriteria": ["ARR keyword present", "Dated Q4"],
    "failureSignals": ["No ARR context"],
    "stopCondition": "After 2 unsuccessful searches"
  }
]
</expected_results>
- Include one entry per tool invocation you intend to make. These expectations feed automatic review, so keep them specific and measurable.

# QUALITY
- Always cite sources using [n] notation that refer to the Context Fragments list
- Craft specific queries for tools
- Adjust strategy based on results
- Don't retry failing tools more than 3 times

# IMPORTANT Citation Format:
- Use square brackets with the context index number: [1], [2], etc.
- Place citations right after the relevant statement
- NEVER group multiple indices in one bracket like [1, 2] or [1, 2, 3]
- Example: "The project deadline was moved to March [3] and the team agreed [5]"
`.trim()
}

/**
 * MessageAgents - New JAF-based agentic flow
 * 
 * This is the new implementation that will eventually replace MessageWithToolsApi
 * Activated via a flag/parameter in the request
 */
export async function MessageAgents(c: Context): Promise<Response> {
  const tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("MessageAgents")

  const { sub: email, workspaceId } = c.get(JwtPayloadKey)
  
  try {
    loggerWithChild({ email }).info("MessageAgents - New agentic flow starting")
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    // Parse request body to get actual query
    // @ts-ignore
    const body = c.req.valid("query")
    let { message, chatId }: { message: string; chatId?: string } = body
    
    if (!message) {
      throw new HTTPException(400, { message: "Message is required" })
    }
    
    message = decodeURIComponent(message)
    rootSpan.setAttribute("message", message)
    rootSpan.setAttribute("chatId", chatId || "new")

    const attachmentMetadata = parseAttachmentMetadata(c)
    const attachmentsForContext = attachmentMetadata.map((meta) => ({
      fileId: meta.fileId,
      isImage: meta.isImage,
    }))
    const referencedFileIds = Array.from(
      new Set(
        attachmentMetadata
          .filter((meta) => !meta.isImage)
          .flatMap((meta) => expandSheetIds(meta.fileId))
      )
    )

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email
    )
    const { user, workspace } = userAndWorkspace
    const userTimezone = user?.timeZone || "UTC"
    const dateForAI = getDateForAI({ userTimeZone: userTimezone })
    const userMetadata: UserMetadataType = {
      userTimezone,
      dateForAI,
    }
    const userCtxString = userContext(userAndWorkspace)
    
    return streamSSE(c, async (stream) => {
      try {
        // Initialize context with actual data
        const agentContext = initializeAgentContext(
          email,
          workspaceId,
          user.id,
          chatId || `chat-${Date.now()}`,
          message,
          attachmentsForContext,
          {
            userContext: userCtxString,
            workspaceNumericId: workspace.id,
          }
        )

        const internalTools = buildInternalToolAdapters()
        const customTools = buildCustomAgentTools()
        const allTools: Tool<unknown, AgentRunContext>[] = [
          ...internalTools,
          ...customTools,
        ]
        agentContext.enabledTools = new Set(
          allTools.map((tool) => tool.schema.name)
        )

        // Track gathered fragments
        const gatheredFragmentsKeys = new Set<string>()

        let initialAttachmentContext: {
          fragments: MinimalAgentFragment[]
          summary: string
        } | null = null

        if (referencedFileIds.length > 0) {
          initialAttachmentContext = await prepareInitialAttachmentContext(
            referencedFileIds,
            userMetadata,
            message
          )
        }
        if (initialAttachmentContext) {
          initialAttachmentContext.fragments.forEach((fragment) => {
            agentContext.contextFragments.push(fragment)
            agentContext.seenDocuments.add(fragment.id)
            gatheredFragmentsKeys.add(fragment.id)
          })
          agentContext.chat.metadata = {
            ...agentContext.chat.metadata,
            initialAttachmentPhase: true,
            initialAttachmentSummary: initialAttachmentContext.summary,
          }
        }

        // Build dynamic instructions
        const instructions = () =>
          buildAgentInstructions(
            agentContext,
            allTools.map((tool) => tool.schema.name),
            dateForAI
          )

        // Set up JAF agent
        const jafAgent: JAFAgent<AgentRunContext, string> = {
          name: "xyne-agent",
          instructions,
          tools: allTools,
          modelConfig: { name: defaultBestModel },
        }

        // Set up model provider
        const modelProvider = makeXyneJAFProvider<AgentRunContext>()

        // Set up agent registry
        const agentRegistry = new Map<string, JAFAgent<AgentRunContext, string>>([
          [jafAgent.name, jafAgent],
        ])

        // Initialize run state
        const runId = generateRunId()
        const traceId = generateTraceId()
        const initialMessages: JAFMessage[] = [
          {
            role: "user",
            content: message, // Use actual user message
          },
        ]

        const runState: JAFRunState<AgentRunContext> = {
          runId,
          traceId,
          messages: initialMessages,
          currentAgentName: jafAgent.name,
          context: agentContext,
          turnCount: 0,
        }

        // Configure run with hooks
        const runCfg: JAFRunConfig<AgentRunContext> = {
          agentRegistry,
          modelProvider,
          maxTurns: 10,
          modelOverride: defaultBestModel,
          
          // After tool execution hook
          onAfterToolExecution: async (
            toolName: string,
            result: any,
            hookContext: any
          ) => {
            const callId = hookContext?.toolCall?.id as string | undefined
            let expectationForCall: ToolExpectation | undefined
            if (callId && expectedResultsByCallId.has(callId)) {
              expectationForCall = expectedResultsByCallId.get(callId)
              expectedResultsByCallId.delete(callId)
            }
            const content = await afterToolExecutionHook(
              toolName,
              result,
              hookContext,
              message,
              initialMessages,
              gatheredFragmentsKeys,
              expectationForCall,
              async (event, data) => {
                await stream.writeSSE({ event, data: JSON.stringify(data) })
              }
            )
            
            // Special handling for toDoWrite to extract plan
            if (toolName === "toDoWrite" && result) {
              const planData = typeof result === 'object' && 'data' in result 
                ? result.data?.plan || result.data 
                : null
              if (planData) {
                const context = hookContext.state.context as AgentRunContext
                context.plan = {
                  id: planData.id || `plan_${Date.now()}`,
                  goal: planData.goal,
                  subTasks: planData.subTasks || planData.tasks || [],
                  chainOfThought: planData.reasoning || "",
                  needsClarification: planData.needsClarification || false,
                  clarificationPrompt: planData.clarificationPrompt || null,
                  candidateAgents: planData.candidateAgents || [],
                  createdAt: planData.createdAt || Date.now(),
                  updatedAt: Date.now(),
                }
              }
            }
            
            return content
          },
        }

        // Send initial metadata (without messageId yet - will send after storing)
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({
            chatId: agentContext.chat.externalId,
          }),
        })

        // Execute JAF run with streaming
        let currentTurn = 0
        let answer = ""
        const citations: Citation[] = []
        const citationMap: Record<number, number> = {}
        let assistantMessageId: string | null = null
        const pendingExpectations: PendingExpectation[] = []
        const expectationHistory = new Map<number, PendingExpectation[]>()
        const expectedResultsByCallId = new Map<string, ToolExpectation>()

        for await (const evt of runStream<AgentRunContext, string>(
          runState,
          runCfg
        )) {
          if (stream.closed) break

          switch (evt.type) {
            case "turn_start":
              currentTurn = evt.data.turn
              await stream.writeSSE({
                event: ChatSSEvents.Reasoning,
                data: JSON.stringify({
                  text: `Turn ${currentTurn} started`,
                  iteration: currentTurn,
                }),
              })
              break

            case "tool_requests":
              for (const toolCall of evt.data.toolCalls) {
                const assignedExpectation = consumePendingExpectation(
                  pendingExpectations,
                  toolCall.name
                )
                if (assignedExpectation) {
                  expectedResultsByCallId.set(
                    toolCall.id,
                    assignedExpectation.expectation
                  )
                }
                await stream.writeSSE({
                  event: ChatSSEvents.Reasoning,
                  data: JSON.stringify({
                    text: `Tool selected: ${toolCall.name}`,
                    toolName: toolCall.name,
                  }),
                })
              }
              break

            case "tool_call_start":
              await stream.writeSSE({
                event: ChatSSEvents.Reasoning,
                data: JSON.stringify({
                  text: `Executing ${evt.data.toolName}...`,
                  toolName: evt.data.toolName,
                }),
              })
              break

            case "tool_call_end":
              await stream.writeSSE({
                event: ChatSSEvents.Reasoning,
                data: JSON.stringify({
                  text: `Tool ${evt.data.toolName} completed`,
                  toolName: evt.data.toolName,
                  status: evt.data.status,
                }),
              })
              break

            case "turn_end":
              // DETERMINISTIC REVIEW: Run after every turn completes
              await stream.writeSSE({
                event: ChatSSEvents.Reasoning,
                data: JSON.stringify({
                  text: `Turn ${evt.data.turn} completed. Running automatic review...`,
                  iteration: evt.data.turn,
                }),
              })
              
              const reviewResult = await performAutomaticReview(
                {
                  turnNumber: evt.data.turn,
                  contextFragments: agentContext.contextFragments,
                  toolCallHistory: agentContext.toolCallHistory,
                  plan: agentContext.plan,
                  expectedResults:
                    expectationHistory.get(evt.data.turn) || [],
                },
                agentContext
              )
              
              // Update context with review results
              agentContext.review.lastReviewSummary = reviewResult.notes
              agentContext.review.lastReviewTurn = evt.data.turn
              
              // Stream review results to client
              await stream.writeSSE({
                event: ChatSSEvents.Reasoning,
                data: JSON.stringify({
                  text: `Review complete: ${reviewResult.recommendation}`,
                  reviewSummary: reviewResult.notes,
                  qualityScore: reviewResult.qualityScore,
                  completeness: reviewResult.completeness,
                  relevance: reviewResult.relevance,
                  gaps: reviewResult.gaps,
                }),
              })

              const attachmentState = getAttachmentPhaseMetadata(agentContext)
              if (attachmentState.initialAttachmentPhase) {
                agentContext.chat.metadata = {
                  ...agentContext.chat.metadata,
                  initialAttachmentPhase: false,
                }
              }
              
              // If review suggests replanning, update the plan
              if (reviewResult.recommendation === 'replan' && reviewResult.updatedPlan) {
                agentContext.plan = reviewResult.updatedPlan
                await stream.writeSSE({
                  event: ChatSSEvents.Reasoning,
                  data: JSON.stringify({
                    text: 'Plan updated based on review feedback',
                    updatedPlan: reviewResult.updatedPlan,
                  }),
                })
              }
              pendingExpectations.length = 0
              break

            case "assistant_message":
              const content = getTextContent(evt.data.message.content) || ""
              if (content) {
                const extractedExpectations = extractExpectedResults(content)
                if (extractedExpectations.length > 0) {
                  pendingExpectations.push(...extractedExpectations)
                  const accumulated = expectationHistory.get(currentTurn) || []
                  accumulated.push(...extractedExpectations)
                  expectationHistory.set(currentTurn, accumulated)
                }
                answer += content
                await stream.writeSSE({
                  event: ChatSSEvents.ResponseUpdate,
                  data: content,
                })
              }
              break

            case "final_output":
              const output = evt.data.output
              if (typeof output === "string" && output.length > 0) {
                const remaining = output.slice(answer.length)
                if (remaining) {
                  await stream.writeSSE({
                    event: ChatSSEvents.ResponseUpdate,
                    data: remaining,
                  })
                }
              }
              break

            case "run_end":
              const outcome = evt.data.outcome
              if (outcome?.status === "completed") {
                // Store the response in database to prevent vanishing
                // TODO: Implement full DB integration similar to MessageWithToolsApi
                // For now, store basic message data
                loggerWithChild({ email }).info("Storing assistant response in database")
                
                // Calculate costs and tokens
                const totalCost = agentContext.totalCost
                const totalTokens = agentContext.tokenUsage.input + agentContext.tokenUsage.output
                
                // TODO: Import and use insertMessage from @/db/message
                // const msg = await insertMessage(db, {
                //   chatId: chat.id,
                //   userId: user.id,
                //   workspaceExternalId: workspace.externalId,
                //   chatExternalId: agentContext.chat.externalId,
                //   messageRole: MessageRole.Assistant,
                //   email: user.email,
                //   sources: citations,
                //   message: answer,
                //   thinking: "", // TODO: Collect thinking/reasoning
                //   modelId: defaultBestModel,
                //   cost: totalCost.toString(),
                //   tokensUsed: totalTokens,
                // })
                // assistantMessageId = msg.externalId
                
                // For now, log the response
                loggerWithChild({ email }).info({
                  answer,
                  citations: citations.length,
                  cost: totalCost,
                  tokens: totalTokens,
                }, "Response generated successfully")
                
                // Send final metadata with messageId
                await stream.writeSSE({
                  event: ChatSSEvents.ResponseMetadata,
                  data: JSON.stringify({
                    chatId: agentContext.chat.externalId,
                    messageId: assistantMessageId || "temp-message-id",
                  }),
                })
                
                await stream.writeSSE({
                  event: ChatSSEvents.End,
                  data: "",
                })
              } else if (outcome?.status === "error") {
                const err = outcome.error
                const errMsg = err?._tag === "MaxTurnsExceeded"
                  ? `Max turns exceeded: ${err.turns}`
                  : "Execution error"
                
                await stream.writeSSE({
                  event: ChatSSEvents.Error,
                  data: JSON.stringify({ error: err?._tag, message: errMsg }),
                })
                await stream.writeSSE({
                  event: ChatSSEvents.End,
                  data: "",
                })
              }
              break
          }
        }

        rootSpan.end()
      } catch (error) {
        loggerWithChild({ email }).error(error, "MessageAgents stream error")
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: JSON.stringify({
            error: "stream_error",
            message: getErrorMessage(error),
          }),
        })
        await stream.writeSSE({
          event: ChatSSEvents.End,
          data: "",
        })
        rootSpan.end()
      }
    })
  } catch (error) {
    loggerWithChild({ email }).error(error, "MessageAgents failed")
    rootSpan.end()
    throw error
  }
}

type ListAgentsParams = {
  query: string
  userEmail: string
  workspaceExternalId: string
  workspaceNumericId?: number
  userId?: number
  requiredCapabilities?: string[]
  maxAgents?: number
}

export async function listCustomAgentsSuitable(
  params: ListAgentsParams
): Promise<ListCustomAgentsOutput> {
  const maxAgents = Math.min(Math.max(params.maxAgents ?? 5, 1), 10)
  let workspaceDbId = params.workspaceNumericId
  let userDbId = params.userId

  if (!workspaceDbId || !userDbId) {
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      params.workspaceExternalId,
      params.userEmail
    )
    workspaceDbId = userAndWorkspace.workspace.id
    userDbId = userAndWorkspace.user.id
  }

  const accessibleAgents = await getUserAccessibleAgents(
    db,
    userDbId!,
    workspaceDbId!,
    25,
    0
  )

  if (!accessibleAgents.length) {
    return {
      result: "No custom agents available for this workspace.",
      agents: [],
      totalEvaluated: 0,
    }
  }

  const briefs = accessibleAgents.map((agent) =>
    buildAgentBrief(agent)
  )

  const systemPrompt = [
    "You are routing queries to the best custom agent.",
    "Return JSON with keys result, agents[], totalEvaluated.",
    "Each agent entry must include: agentId, agentName, description, capabilities[], domains[], suitabilityScore (0-1), confidence (0-1), estimatedCost ('low'|'medium'|'high'), averageLatency (ms).",
    `Select up to ${maxAgents} agents.`,
  ].join(" ")

  const payload = [
    `User Query: ${params.query}`,
    params.requiredCapabilities?.length
      ? `Required capabilities: ${params.requiredCapabilities.join(", ")}`
      : "Required capabilities: none specified",
    "Agents:",
    formatAgentBriefsForPrompt(briefs),
  ].join("\n\n")

  const modelId =
    (defaultFastModel as Models) || (defaultBestModel as Models)
  const modelParams: ModelParams = {
    modelId,
    json: true,
    stream: false,
    temperature: 0,
    maxTokens: 800,
    systemPrompt,
  }

  try {
    const messages: Message[] = [
      {
        role: ConversationRole.USER,
        content: [{ text: payload }],
      },
    ]

    const { text } = await getProviderByModel(modelId).converse(
      messages,
      modelParams
    )

    const parsed = jsonParseLLMOutput(text || "")
    const validation = ListCustomAgentsOutputSchema.safeParse(parsed)
    if (validation.success) {
      const trimmedAgents = validation.data.agents.slice(0, maxAgents)
      return {
        result: validation.data.result,
        agents: trimmedAgents,
        totalEvaluated: accessibleAgents.length,
      }
    }

    Logger.warn(
      { issue: validation.error.format() },
      "LLM agent selection output invalid, falling back to heuristic scoring"
    )
  } catch (error) {
    Logger.error(
      { err: error },
      "LLM agent selection failed, falling back to heuristic scoring"
    )
  }

  return buildHeuristicAgentSelection(
    briefs,
    params.query,
    maxAgents,
    accessibleAgents.length
  )
}

export async function executeCustomAgent(
  params: {
    agentId: string
    query: string
    userEmail: string
    workspaceExternalId: string
    contextSnippet?: string
    maxTokens?: number
  }
): Promise<ToolOutput> {
  const combinedQuery = params.contextSnippet
    ? `${params.query}\n\nAdditional context:\n${params.contextSnippet}`
    : params.query

  try {
    const result = await ExecuteAgentForWorkflow({
      agentId: params.agentId,
      userQuery: combinedQuery,
      workspaceId: params.workspaceExternalId,
      userEmail: params.userEmail,
      isStreamable: false,
      temperature: 0.2,
      max_new_tokens: params.maxTokens,
      attachmentFileIds: [],
      nonImageAttachmentFileIds: [],
    })

    if (!result.success) {
      return {
        result: "Agent execution failed",
        error: result.error || "Unknown error",
        metadata: {
          agentId: params.agentId,
        },
      }
    }

    return {
      result: result.response || "Agent did not return any text.",
      metadata: {
        agentId: params.agentId,
        citations: result.citations,
        imageCitations: result.imageCitations,
        cost: result.cost,
        tokensUsed: result.tokensUsed,
      },
    }
  } catch (error) {
    Logger.error(
      { err: error },
      "executeCustomAgent encountered an error"
    )
    return {
      result: "Agent execution threw an exception",
      error: getErrorMessage(error),
      metadata: {
        agentId: params.agentId,
      },
    }
  }
}

type AgentBrief = {
  agentId: string
  agentName: string
  description: string
  capabilities: string[]
  domains: string[]
  estimatedCost: "low" | "medium" | "high"
  averageLatency: number
  isPublic: boolean
}

function buildAgentBrief(agent: any): AgentBrief {
  const integrations = extractIntegrationKeys(agent.appIntegrations)
  const domains = deriveDomainsFromIntegrations(integrations)
  const capabilities = integrations.length ? integrations : domains
  return {
    agentId: agent.externalId,
    agentName: agent.name,
    description: agent.description || "",
    capabilities,
    domains,
    estimatedCost: agent.allowWebSearch ? "high" : "medium",
    averageLatency: 4500,
    isPublic: agent.isPublic,
  }
}

function extractIntegrationKeys(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry))
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
  }
  return []
}

function deriveDomainsFromIntegrations(integrations: string[]): string[] {
  if (!integrations.length) return ["generic"]
  return integrations.map((integration) => integration.toLowerCase())
}

function formatAgentBriefsForPrompt(briefs: AgentBrief[]): string {
  return briefs
    .map(
      (brief, idx) =>
        `${idx + 1}. ${brief.agentName} (${brief.agentId})
Description: ${brief.description || "N/A"}
Capabilities: ${brief.capabilities.join(", ") || "N/A"}
Domains: ${brief.domains.join(", ")}
Estimated cost: ${brief.estimatedCost}`
    )
    .join("\n\n")
}

function buildHeuristicAgentSelection(
  briefs: AgentBrief[],
  query: string,
  maxAgents: number,
  totalEvaluated: number
): ListCustomAgentsOutput {
  const tokens = query.toLowerCase().split(/\s+/)
  const scored = briefs.map((brief) => {
    const text =
      `${brief.agentName} ${brief.description} ${brief.capabilities.join(" ")}`.toLowerCase()
    const score =
      tokens.reduce(
        (acc, token) => (text.includes(token) ? acc + 1 : acc),
        0
      ) / Math.max(tokens.length, 1)
    return { brief, score }
  })

  const selected = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxAgents)
    .map(({ brief, score }) => ({
      agentId: brief.agentId,
      agentName: brief.agentName,
      description: brief.description,
      capabilities: brief.capabilities,
      domains: brief.domains,
      suitabilityScore: Math.min(Math.max(score, 0.2), 1),
      confidence: Math.min(Math.max(score + 0.1, 0.3), 1),
      estimatedCost: brief.estimatedCost,
      averageLatency: brief.averageLatency,
    }))

  return {
    result: "Heuristic agent ranking",
    agents: selected,
    totalEvaluated,
  }
}
