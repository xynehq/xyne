import {
  answerContextMap,
  answerContextMapFromFragments,
  cleanContext,
  userContext,
} from "@/ai/context"
import { AgentCreationSource } from "@/db/schema"
import {
  agentInstructionsPrompt,
  generateAgentStepSummaryPromptJson,
  generateConsolidatedStepSummaryPromptJson,
  hitlClarificationDescription,
} from "@/ai/agentPrompts"
import {
  generateSearchQueryOrAnswerFromConversation,
  jsonParseLLMOutput,
  generateSynthesisBasedOnToolOutput,
  baselineRAGOffJsonStream,
  agentWithNoIntegrationsQuestion,
  extractBestDocumentIndexes,
} from "@/ai/provider"
import { getConnectorById } from "@/db/connector"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js"
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import {
  Models,
  QueryType,
  type ConverseResponse,
  type QueryRouterLLMResponse,
  type QueryRouterResponse,
  type TemporalClassifier,
} from "@/ai/types"
import {
  insertChat,
  updateChatByExternalIdWithAuth,
  updateMessageByExternalId,
} from "@/db/chat"
import { db } from "@/db/client"
import { insertMessage, getChatMessagesWithAuth } from "@/db/message"
import { getToolsByConnectorId } from "@/db/tool"
import { type SelectChat, type SelectMessage } from "@/db/schema"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getLogger, getLoggerWithChild } from "@/logger"
import {
  AgentReasoningStepType,
  ApiKeyScopes,
  ChatSSEvents,
  ContextSysthesisState,
  KnowledgeBaseEntity,
  type AgentReasoningStep,
  type MessageReqType,
} from "@/shared/types"
import { MessageRole, Subsystem, type UserMetadataType } from "@/types"
import { getErrorMessage, splitGroupedCitationsWithSpaces } from "@/utils"
import {
  type ConversationRole,
  type Message,
} from "@aws-sdk/client-bedrock-runtime"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming" // Import SSEStreamingApi
import { z } from "zod"
import { getTracer, type Tracer } from "@/tracer"
import {
  GetDocumentsByDocIds,
  getDocumentOrNull,
  searchVespaAgent,
  SearchVespaThreads,
  getAllDocumentsForAgent,
  searchSlackInVespa,
} from "@/search/vespa"
import {
  Apps,
  chatUserSchema,
  chatContainerSchema,
  VespaChatContainerSearchSchema,
  VespaChatUserSchema,
  type VespaSearchResult,
  type VespaSearchResults,
  AttachmentEntity,
} from "@xyne/vespa-ts/types"
import { APIError } from "openai"
import { insertChatTrace } from "@/db/chatTrace"
import type { AttachmentMetadata, SelectPublicAgent } from "@/shared/types"
import { storeAttachmentMetadata } from "@/db/attachment"
import { parseAttachmentMetadata } from "@/utils/parseAttachment"
import { isCuid } from "@paralleldrive/cuid2"
import {
  getAgentByExternalIdWithPermissionCheck,
  type SelectAgent,
} from "@/db/agent"
import { activeStreams } from "./stream"
import {
  ragPipelineConfig,
  RagPipelineStages,
  type Citation,
  type ImageCitation,
  type MinimalAgentFragment,
} from "./types"
import {
  collectFollowupContext,
  convertReasoningStepToText,
  extractFileIdsFromMessage,
  extractImageFileNames,
  extractItemIdsFromPath,
  getCitationToImage,
  handleError,
  isMessageWithContext,
  mimeTypeMap,
  processMessage,
  searchToCitation,
  parseAppSelections,
  isAppSelectionMap,
} from "./utils"
import { textToCitationIndex, textToImageCitationIndex } from "./utils"
import config from "@/config"
import { getModelValueFromLabel } from "@/ai/modelConfig"
import {
  buildContext,
  buildUserQuery,
  getThreadContext,
  isContextSelected,
  UnderstandMessageAndAnswer,
  generateAnswerFromDualRag,
  UnderstandMessageAndAnswerForGivenContext,
} from "./chat"
// JAF integration imports
import {
  runStream,
  generateRunId,
  generateTraceId,
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
} from "@xynehq/jaf"
// Replace LiteLLM provider with Xyne-backed JAF provider
import { makeXyneJAFProvider } from "./jaf-provider"
import {
  buildMCPJAFTools,
  type FinalToolsList as JAFinalToolsList,
  type JAFAdapterCtx,
  buildToolsOverview,
  buildContextSection,
} from "@/api/chat/jaf-adapter"
import { getRecordBypath } from "@/db/knowledgeBase"
import { getDateForAI } from "@/utils/index"
import { validateVespaIdInAgentIntegrations } from "@/search/utils"
import { getAuth, safeGet } from "../agent"
import { applyFollowUpContext } from "@/utils/parseAttachment"
import { expandSheetIds } from "@/search/utils"
import { googleTools, searchGlobalTool } from "@/api/chat/tools/index"
import { fallbackTool } from "./tools/global"
import { getSlackRelatedMessagesTool } from "./tools/slack/getSlackMessages"
import { JafStreamer } from "./jaf-stream"
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
const Logger = getLogger(Subsystem.Chat)
const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

type ChatContainerFields = z.infer<typeof VespaChatContainerSearchSchema>
type ChatUserFields = z.infer<typeof VespaChatUserSchema>

const isChatContainerFields = (value: unknown): value is ChatContainerFields =>
  isRecord(value) && VespaChatContainerSearchSchema.safeParse(value).success

const isChatUserFields = (value: unknown): value is ChatUserFields =>
  isRecord(value) && VespaChatUserSchema.safeParse(value).success

// Generate AI summary for agent reasoning steps
const generateStepSummary = async (
  step: AgentReasoningStep,
  userQuery: string,
  dateForAI: string,
  contextInfo?: string,
  modelId?: string,
): Promise<string> => {
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
      dateForAI,
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
    const finalSummary = parsed.summary || generateFallbackSummary(step)
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
    const fallbackSummary = generateFallbackSummary(step)
    span.setAttribute("fallback_summary", fallbackSummary)
    span.setAttribute("used_fallback", true)
    span.end()
    return fallbackSummary
  }
}

// Generate fallback summary when AI generation fails
const generateFallbackSummary = (step: AgentReasoningStep): string => {
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
    default:
      return "Processing step"
  }
}

// Create mock agent from form data for testing
const createMockAgentFromFormData = (
  agentPromptPayload: any,
  user: any,
  workspace: any,
  email: string,
): { agentForDb: SelectAgent; agentPromptForLLM: string } => {
  try {
    const formData = agentPromptPayload

    // Create mock SelectAgent from form data without DB call
    const agentForDb = {
      name: formData.name || "Test Agent",
      description: formData.description || null,
      prompt: formData.prompt || null,
      model: formData.model || Models.Claude_Sonnet_4,
      isPublic: formData.isPublic || false,
      isRagOn: formData.isRagOn !== false,
      appIntegrations: formData.appIntegrations || null,
      docIds: formData.docIds || null,
      // Dummy values for required DB fields
      id: -1,
      createdAt: new Date(),
      updatedAt: new Date(),
      userId: user.id,
      deletedAt: null,
      externalId: `test-agent-${Date.now()}`,
      workspaceId: workspace.id,
      allowWebSearch: formData.allowWebSearch || null,
      creation_source: AgentCreationSource.DIRECT,
    }

    const agentPromptForLLM = JSON.stringify(agentForDb)
    loggerWithChild({ email }).info(
      "Created mock agent from form data for testing",
    )

    return { agentForDb, agentPromptForLLM }
  } catch (error) {
    loggerWithChild({ email }).error(
      error,
      "Failed to parse agentPromptPayload",
    )
    throw new HTTPException(400, {
      message: "Invalid agent form data provided",
    })
  }
}

// Check if agent has no app integrations and should use the no-integrations flow
export const checkAgentWithNoIntegrations = (
  agentForDb: SelectAgent | SelectPublicAgent | null,
): boolean => {
  if (!agentForDb?.appIntegrations) return true

  if (typeof agentForDb.appIntegrations === "object") {
    if (Object.keys(agentForDb.appIntegrations).length === 0) return true

    return Object.values(agentForDb.appIntegrations).every(
      (config) =>
        !config.selectedAll && (!config.itemIds || config.itemIds.length === 0),
    )
  }

  return false
}

export const checkAndYieldCitationsForAgent = async function* (
  textInput: string,
  yieldedCitations: Set<number>,
  results: MinimalAgentFragment[],
  yieldedImageCitations?: Map<number, Set<number>>,
  email: string = "",
): AsyncGenerator<
  {
    citation?: { index: number; item: Citation }
    imageCitation?: ImageCitation
  },
  void,
  unknown
> {
  const tracer = getTracer("chat")
  const span = tracer.startSpan("checkAndYieldCitationsForAgent")

  try {
    span.setAttribute("text_input_length", textInput.length)
    span.setAttribute("results_count", results.length)
    span.setAttribute("yielded_citations_size", yieldedCitations.size)
    span.setAttribute("has_image_citations", !!yieldedImageCitations)
    span.setAttribute("user_email", email)

    const text = splitGroupedCitationsWithSpaces(textInput)
    let match
    let imgMatch
    let citationsProcessed = 0
    let imageCitationsProcessed = 0
    let citationsYielded = 0
    let imageCitationsYielded = 0

    while (
      (match = textToCitationIndex.exec(text)) !== null ||
      (imgMatch = textToImageCitationIndex.exec(text)) !== null
    ) {
      if (match) {
        citationsProcessed++
        const citationIndex = parseInt(match[1], 10)
        if (!yieldedCitations.has(citationIndex)) {
          const item = results[citationIndex - 1]

          if (!item?.source?.docId || !item.source?.url) {
            Logger.info(
              "[checkAndYieldCitationsForAgent] No docId or url found for citation, skipping",
            )
            continue
          }

          // we dont want citations for attachments in the chat
          if (
            Object.values(AttachmentEntity).includes(
              item.source.entity as AttachmentEntity,
            )
          ) {
            continue
          }

          yield {
            citation: {
              index: citationIndex,
              item: item.source,
            },
          }
          yieldedCitations.add(citationIndex)
          citationsYielded++
        }
      } else if (imgMatch && yieldedImageCitations) {
        imageCitationsProcessed++
        const parts = imgMatch[1].split("_")
        if (parts.length >= 2) {
          const docIndex = parseInt(parts[0], 10)
          const imageIndex = parseInt(parts[1], 10)
          if (
            !yieldedImageCitations.has(docIndex) ||
            !yieldedImageCitations.get(docIndex)?.has(imageIndex)
          ) {
            const item = results[docIndex]
            if (item) {
              const imageProcessingSpan = span.startSpan(
                "process_image_citation",
              )
              try {
                imageProcessingSpan.setAttribute("citation_key", imgMatch[1])
                imageProcessingSpan.setAttribute("doc_index", docIndex)
                imageProcessingSpan.setAttribute("image_index", imageIndex)

                const imageData = await getCitationToImage(
                  imgMatch[1],
                  {
                    id: item.id,
                    relevance: item.confidence,
                    fields: {
                      docId: item.source.docId,
                    } as any,
                  } as VespaSearchResult,
                  email,
                )
                if (imageData) {
                  if (!imageData.imagePath || !imageData.imageBuffer) {
                    loggerWithChild({ email: email }).error(
                      "Invalid imageData structure returned",
                      { citationKey: imgMatch[1], imageData },
                    )
                    imageProcessingSpan.setAttribute(
                      "processing_success",
                      false,
                    )
                    imageProcessingSpan.setAttribute(
                      "error_reason",
                      "invalid_image_data",
                    )
                    imageProcessingSpan.end()
                    continue
                  }
                  yield {
                    imageCitation: {
                      citationKey: imgMatch[1],
                      imagePath: imageData.imagePath,
                      imageData: imageData.imageBuffer.toString("base64"),
                      ...(imageData.extension
                        ? { mimeType: mimeTypeMap[imageData.extension] }
                        : {}),
                      item: item.source,
                    },
                  }
                  imageCitationsYielded++
                  imageProcessingSpan.setAttribute("processing_success", true)
                  imageProcessingSpan.setAttribute(
                    "image_size",
                    imageData.imageBuffer.length,
                  )
                  imageProcessingSpan.setAttribute(
                    "image_extension",
                    imageData.extension || "unknown",
                  )
                }
                imageProcessingSpan.end()
              } catch (error) {
                imageProcessingSpan.addEvent("image_processing_error", {
                  message: getErrorMessage(error),
                  stack: (error as Error).stack || "",
                })
                imageProcessingSpan.setAttribute("processing_success", false)
                imageProcessingSpan.end()

                loggerWithChild({ email: email }).error(
                  error,
                  "Error processing image citation",
                  { citationKey: imgMatch[1], error: getErrorMessage(error) },
                )
              }
              if (!yieldedImageCitations.has(docIndex)) {
                yieldedImageCitations.set(docIndex, new Set<number>())
              }
              yieldedImageCitations.get(docIndex)?.add(imageIndex)
            } else {
              loggerWithChild({ email: email }).warn(
                "Found a citation index but could not find it in the search result ",
                imageIndex,
                results.length,
              )
              continue
            }
          }
        }
      }
    }

    span.setAttribute("citations_processed", citationsProcessed)
    span.setAttribute("image_citations_processed", imageCitationsProcessed)
    span.setAttribute("citations_yielded", citationsYielded)
    span.setAttribute("image_citations_yielded", imageCitationsYielded)
    span.end()
  } catch (error) {
    span.addEvent("error", {
      message: getErrorMessage(error),
      stack: (error as Error).stack || "",
    })
    span.end()
    throw error
  }
}

const vespaResultToMinimalAgentFragment = async (
  child: VespaSearchResult,
  idx: number,
  userMetadata: UserMetadataType,
  query: string,
): Promise<MinimalAgentFragment> => ({
  id: `${(child.fields as any)?.docId || `Frangment_id_${idx}`}`,
  content: await answerContextMap(
    child as VespaSearchResults,
    userMetadata,
    0,
    true,
    undefined,
    query,
  ),
  source: searchToCitation(child as VespaSearchResults),
  confidence: 1.0,
})

type SynthesisResponse = {
  synthesisState:
    | ContextSysthesisState.Complete
    | ContextSysthesisState.Partial
    | ContextSysthesisState.NotFound
  answer: string | null
}

async function performSynthesis(
  ctx: any,
  dateForAI: string,
  message: string,
  planningContext: string,
  gatheredFragments: MinimalAgentFragment[],
  messagesWithNoErrResponse: Message[],
  logAndStreamReasoning: (step: AgentReasoningStep) => Promise<void>,
  sub: string,
  attachmentFileIds?: string[],
  modelId?: string,
): Promise<SynthesisResponse | null> {
  const tracer = getTracer("chat")
  const span = tracer.startSpan("performSynthesis")

  let parseSynthesisOutput: SynthesisResponse | null = null

  try {
    span.setAttribute("message_length", message.length)
    span.setAttribute("planning_context_length", planningContext.length)
    span.setAttribute("gathered_fragments_count", gatheredFragments.length)
    span.setAttribute("messages_count", messagesWithNoErrResponse.length)
    span.setAttribute("user_email", sub)
    span.setAttribute(
      "has_attachment_file_ids",
      !!(attachmentFileIds && attachmentFileIds.length > 0),
    )
    span.setAttribute(
      "attachment_file_ids_count",
      attachmentFileIds?.length || 0,
    )

    await logAndStreamReasoning({
      type: AgentReasoningStepType.Synthesis,
      details: `Synthesizing answer from ${gatheredFragments.length} fragments...`,
    })

    const synthesisSpan = span.startSpan("synthesis_llm_call")
    const synthesisResponse = await generateSynthesisBasedOnToolOutput(
      ctx,
      dateForAI,
      message,
      planningContext,
      {
        modelId: (modelId as Models) || defaultBestModel,
        stream: false,
        json: true,
        reasoning: false,
        messages: messagesWithNoErrResponse,
        imageFileNames: attachmentFileIds?.map(
          (fileId, index) => `${index}_${fileId}_${0}`,
        ),
      },
    )
    synthesisSpan.setAttribute("model_id", defaultBestModel)
    synthesisSpan.setAttribute(
      "response_length",
      synthesisResponse.text?.length || 0,
    )
    synthesisSpan.end()

    if (synthesisResponse.text) {
      const parseSpan = span.startSpan("parse_synthesis_response")
      try {
        parseSynthesisOutput = jsonParseLLMOutput(synthesisResponse.text)
        parseSpan.setAttribute("parse_success", !!parseSynthesisOutput)
        parseSpan.setAttribute(
          "has_synthesis_state",
          !!(parseSynthesisOutput && parseSynthesisOutput.synthesisState),
        )
        parseSpan.setAttribute(
          "synthesis_state",
          parseSynthesisOutput?.synthesisState || "unknown",
        )
        parseSpan.setAttribute(
          "has_answer",
          !!(parseSynthesisOutput && parseSynthesisOutput.answer),
        )

        if (!parseSynthesisOutput || !parseSynthesisOutput.synthesisState) {
          loggerWithChild({ email: sub }).error(
            "Synthesis response was valid JSON but missing 'synthesisState' key.",
          )
          // Default to partial to force another iteration, which is safer
          parseSynthesisOutput = {
            synthesisState: ContextSysthesisState.Partial,
            answer: null,
          }
          parseSpan.setAttribute("fallback_used", true)
          parseSpan.setAttribute("fallback_reason", "missing_synthesis_state")
        }
        parseSpan.end()
      } catch (jsonError) {
        parseSpan.addEvent("json_parse_error", {
          message: getErrorMessage(jsonError),
          stack: (jsonError as Error).stack || "",
        })
        parseSpan.setAttribute("parse_success", false)
        parseSpan.end()

        loggerWithChild({ email: sub }).error(
          jsonError,
          "Failed to parse synthesis LLM output as JSON.",
        )
        // If parsing fails, we cannot trust the context. Treat it as notFound to be safe.
        parseSynthesisOutput = {
          synthesisState: ContextSysthesisState.NotFound,
          answer: parseSynthesisOutput?.answer || "",
        }
      }
    } else {
      loggerWithChild({ email: sub }).error(
        "Synthesis LLM call returned no text.",
      )
      parseSynthesisOutput = {
        synthesisState: ContextSysthesisState.Partial,
        answer: "",
      }
      span.setAttribute("no_text_response", true)
    }

    span.setAttribute(
      "final_synthesis_state",
      parseSynthesisOutput?.synthesisState || "unknown",
    )
    span.setAttribute(
      "final_answer_length",
      parseSynthesisOutput?.answer?.length || 0,
    )
    span.end()
  } catch (synthesisError) {
    span.addEvent("synthesis_error", {
      message: getErrorMessage(synthesisError),
      stack: (synthesisError as Error).stack || "",
    })

    loggerWithChild({ email: sub }).error(
      synthesisError,
      "Error during synthesis LLM call.",
    )
    await logAndStreamReasoning({
      type: AgentReasoningStepType.LogMessage,
      message: `Synthesis failed: No relevant information found. Attempting to gather more data.`,
    })
    // If the call itself fails, we must assume the context is insufficient.
    parseSynthesisOutput = {
      synthesisState: ContextSysthesisState.Partial,
      answer: parseSynthesisOutput?.answer || "",
    }
    span.setAttribute("error_fallback_used", true)
    span.end()
  }

  return parseSynthesisOutput
}

export const addErrMessageToMessage = async (
  lastMessage: SelectMessage,
  errorMessage: string,
) => {
  if (lastMessage.messageRole === MessageRole.User) {
    await updateMessageByExternalId(db, lastMessage?.externalId, {
      errorMessage,
    })
  }
}
/**
 * MessageWithToolsApi - Advanced JAF-powered chat with MCP tool integration
 *
 * Used when: isAgentic && !enableWebSearch && !deepResearchEnabled
 *
 * Features:
 * - JAF (Juspay Agentic Framework) agent orchestration
 * - MCP client integration for external tools
 * - Iterative search with context synthesis
 * - Advanced reasoning step tracking
 * - Fallback search on max iterations
 * - Real-time tool execution feedback
 *
 * Flow: Auth → MCP setup → JAF agent config → Tool execution → Context building → Response
 *
 * @param c - Hono Context with request data
 * @returns StreamSSE with JAF execution events
 */
export const MessageWithToolsApi = async (c: Context) => {
  const tracer: Tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("MessageWithToolsApi")

  let assistantMessageId: string | null = null
  let streamKey: string | null = null
  let isDebugMode = config.isDebugMode
  let email = ""
  try {
    const initSpan = rootSpan.startSpan("initialization")
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    email = sub
    loggerWithChild({ email: email }).info("MessageApi..")
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)
    rootSpan.setAttribute("debug_mode", isDebugMode)

    // @ts-ignore
    const body = c.req.valid("query")
    let isAgentic = c.req.query("agentic") === "true"
    let {
      message,
      chatId,
      selectedModelConfig,
      toolsList,
      agentId,
      isFollowUp,
    }: MessageReqType = body

    // Parse the model configuration JSON
    let modelId: string | null = null
    let isReasoningEnabled = false
    let enableWebSearch = false
    let isDeepResearchEnabled = false

    type ModelConfig = {
      model?: string
      reasoning?: boolean
      websearch?: boolean
      deepResearch?: boolean
      capabilities?: string[] | { [key: string]: boolean }
    }

    if (selectedModelConfig) {
      try {
        const modelConfig = JSON.parse(selectedModelConfig) as ModelConfig
        modelId = modelConfig.model || null

        // Handle new direct boolean format
        isReasoningEnabled = modelConfig.reasoning === true
        enableWebSearch = modelConfig.websearch === true
        isDeepResearchEnabled = modelConfig.deepResearch === true

        // For deep research, always use Claude Sonnet 4 regardless of UI selection
        if (isDeepResearchEnabled) {
          modelId = "Claude Sonnet 4"
          loggerWithChild({ email: email }).info(
            `[MessageWithToolsApi] Deep research enabled - forcing model to Claude Sonnet 4`,
          )
        }

        // Check capabilities - handle both array and object formats for backward compatibility
        if (
          modelConfig.capabilities &&
          !isReasoningEnabled &&
          !enableWebSearch &&
          !isDeepResearchEnabled
        ) {
          if (Array.isArray(modelConfig.capabilities)) {
            isReasoningEnabled = modelConfig.capabilities.includes("reasoning")
            enableWebSearch = modelConfig.capabilities.includes("websearch")
            isDeepResearchEnabled =
              modelConfig.capabilities.includes("deepResearch")
          } else if (typeof modelConfig.capabilities === "object") {
            isReasoningEnabled = modelConfig.capabilities.reasoning === true
            enableWebSearch = modelConfig.capabilities.websearch === true
            isDeepResearchEnabled =
              modelConfig.capabilities.deepResearch === true
          }

          // For deep research from old format, also force Claude Sonnet 4
          if (isDeepResearchEnabled) {
            modelId = "Claude Sonnet 4"
          }
        }

        loggerWithChild({ email: email }).info(
          `[MessageWithToolsApi] Parsed model config: model="${modelId}", reasoning=${isReasoningEnabled}, websearch=${enableWebSearch}, deepResearch=${isDeepResearchEnabled}`,
        )
      } catch (error) {
        console.error("Failed to parse selectedModelConfig:", error)
      }
    }

    // Convert friendly model label to actual model value
    let actualModelId = modelId ? getModelValueFromLabel(modelId) : null
    if (modelId) {
      if (!actualModelId && modelId in Models) {
        actualModelId = modelId as Models
      } else if (!actualModelId) {
        throw new HTTPException(400, { message: `Invalid model: ${modelId}` })
      }
    } else {
      actualModelId = defaultBestModel
    }

    let attachmentMetadata = parseAttachmentMetadata(c)
    let imageAttachmentFileIds = attachmentMetadata
      .filter((m) => m.isImage)
      .map((m) => m.fileId)
    const nonImageAttachmentFileIds = attachmentMetadata
      .filter((m) => !m.isImage)
      .flatMap((m) => expandSheetIds(m.fileId))
    let attachmentStorageError: Error | null = null

    const contextExtractionSpan = initSpan.startSpan("context_extraction")
    const isMsgWithContext = isMessageWithContext(message)
    const extractedInfo = isMsgWithContext
      ? await extractFileIdsFromMessage(message, email)
      : {
          totalValidFileIdsFromLinkCount: 0,
          fileIds: [],
        }
    let fileIds = extractedInfo?.fileIds
    if (nonImageAttachmentFileIds && nonImageAttachmentFileIds.length > 0) {
      fileIds = [...fileIds, ...nonImageAttachmentFileIds]
    }
    const totalValidFileIdsFromLinkCount =
      extractedInfo?.totalValidFileIdsFromLinkCount
    loggerWithChild({ email: email }).info(`Extracted ${fileIds} extractedInfo`)
    loggerWithChild({ email: email }).info(
      `Total attachment files received: ${attachmentMetadata.length}`,
    )

    // Handle isFollowUp functionality - get context from previous user message
    if (isFollowUp && chatId) {
      try {
        const updatedContext = await applyFollowUpContext(chatId, email)

        fileIds = [...fileIds, ...updatedContext.fileIds]
        imageAttachmentFileIds.push(...updatedContext.imageAttachmentFileIds)
        attachmentMetadata.push(...updatedContext.attachmentMetadata)

        // Dedup
        fileIds = Array.from(new Set(fileIds))
        imageAttachmentFileIds = Array.from(new Set(imageAttachmentFileIds))
        let byId = new Map(attachmentMetadata.map((a) => [a.fileId, a]))
        attachmentMetadata = Array.from(byId.values())
      } catch (error) {
        loggerWithChild({ email: email }).error(
          error,
          `Error getting context from previous user message for isFollowUp: ${getErrorMessage(error)}`,
        )
        // Continue execution even if we can't get previous context
      }
    }

    const hasReferencedContext = fileIds && fileIds.length > 0
    contextExtractionSpan.setAttribute("file_ids_count", fileIds?.length || 0)
    contextExtractionSpan.setAttribute(
      "has_referenced_context",
      hasReferencedContext,
    )
    contextExtractionSpan.setAttribute(
      "is_message_with_context",
      isMsgWithContext,
    )
    contextExtractionSpan.setAttribute(
      "total_valid_file_ids_from_link_count",
      totalValidFileIdsFromLinkCount,
    )
    contextExtractionSpan.setAttribute(
      "extracted_file_ids",
      JSON.stringify(fileIds || []),
    )
    contextExtractionSpan.end()

    if (!message) {
      throw new HTTPException(400, {
        message: "Message is required",
      })
    }
    message = decodeURIComponent(message)
    rootSpan.setAttribute("message", message)

    const userLookupSpan = initSpan.startSpan("user_workspace_lookup")
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const { user, workspace } = userAndWorkspace
    userLookupSpan.setAttribute("user_id", user.id)
    userLookupSpan.setAttribute("workspace_id", workspace.id)
    userLookupSpan.end()

    let messages: SelectMessage[] = []
    const costArr: number[] = []
    const tokenArr: { inputTokens: number; outputTokens: number }[] = []
    const ctx = userContext(userAndWorkspace)
    const userTimezone = user?.timeZone || "Asia/Kolkata"
    const dateForAI = getDateForAI({ userTimeZone: userTimezone })
    const userMetadata: UserMetadataType = { userTimezone, dateForAI }
    let chat: SelectChat
    initSpan.end()

    const chatCreationSpan = rootSpan.startSpan("chat_creation")
    let agentPromptForLLM: string | undefined = undefined
    let agentForDb: SelectAgent | null = null

    if (agentId && isCuid(agentId)) {
      const agentLookupSpan = chatCreationSpan.startSpan("agent_lookup")
      // Use the numeric workspace.id for the database query with permission check
      agentForDb = await getAgentByExternalIdWithPermissionCheck(
        db,
        agentId,
        workspace.id,
        user.id,
      )
      if (!agentForDb) {
        agentLookupSpan.end()
        throw new HTTPException(403, {
          message: "Access denied: You don't have permission to use this agent",
        })
      }
      if (agentForDb.isRagOn === false) {
        isAgentic = false
      }
      agentPromptForLLM = JSON.stringify(agentForDb)
      agentLookupSpan.setAttribute("agent_external_id", agentForDb.externalId)
      agentLookupSpan.setAttribute("is_rag_on", agentForDb.isRagOn)
      agentLookupSpan.end()
    }
    const agentIdToStore = agentForDb ? agentForDb.externalId : null
    let title = ""
    let thinking = ""
    if (!chatId) {
      const dbTransactionSpan = chatCreationSpan.startSpan(
        "db_transaction_new_chat",
      )
      let [insertedChat, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage]> => {
          const chat = await insertChat(tx, {
            workspaceId: workspace.id,
            workspaceExternalId: workspace.externalId,
            userId: user.id,
            email: user.email,
            title: "Untitled",
            attachments: [],
            ...(agentId ? { agentId: agentIdToStore as string } : {}),
          })

          const insertedMsg = await insertMessage(tx, {
            chatId: chat.id,
            userId: user.id,
            chatExternalId: chat.externalId,
            workspaceExternalId: workspace.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: [],
            message,
            modelId: (actualModelId as Models) || defaultBestModel,
            fileIds: fileIds,
          })
          // Store attachment metadata for user message if attachments exist
          if (attachmentMetadata && attachmentMetadata.length > 0) {
            try {
              await storeAttachmentMetadata(
                tx,
                insertedMsg.externalId,
                attachmentMetadata,
                email,
              )
            } catch (error) {
              attachmentStorageError = error as Error
              loggerWithChild({ email: email }).error(
                error,
                `Failed to store attachment metadata for user message ${insertedMsg.externalId}`,
              )
            }
          }
          return [chat, insertedMsg]
        },
      )
      dbTransactionSpan.setAttribute(
        "chat_external_id",
        insertedChat.externalId,
      )
      dbTransactionSpan.setAttribute(
        "message_external_id",
        insertedMsg.externalId,
      )
      dbTransactionSpan.end()

      loggerWithChild({ email: sub }).info(
        "First mesage of the conversation, successfully created the chat",
      )
      chat = insertedChat
      messages.push(insertedMsg) // Add the inserted message to messages array
      chatCreationSpan.end()
    } else {
      const dbTransactionSpan = chatCreationSpan.startSpan(
        "db_transaction_existing_chat",
      )
      let [existingChat, allMessages, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage[], SelectMessage]> => {
          // we are updating the chat and getting it's value in one call itself

          let existingChat = await updateChatByExternalIdWithAuth(
            db,
            chatId,
            email,
            {},
          )
          let allMessages = await getChatMessagesWithAuth(tx, chatId, email)

          let insertedMsg = await insertMessage(tx, {
            chatId: existingChat.id,
            userId: user.id,
            workspaceExternalId: workspace.externalId,
            chatExternalId: existingChat.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: [],
            message,
            modelId: (actualModelId as Models) || defaultBestModel,
            fileIds,
          })
          // Store attachment metadata for user message if attachments exist
          if (attachmentMetadata && attachmentMetadata.length > 0) {
            try {
              await storeAttachmentMetadata(
                tx,
                insertedMsg.externalId,
                attachmentMetadata,
                email,
              )
            } catch (error) {
              attachmentStorageError = error as Error
              loggerWithChild({ email }).error(
                error,
                `Failed to store attachment metadata for user message ${insertedMsg.externalId}`,
              )
            }
          }
          return [existingChat, allMessages, insertedMsg]
        },
      )
      dbTransactionSpan.setAttribute(
        "chat_external_id",
        existingChat.externalId,
      )
      dbTransactionSpan.setAttribute(
        "message_external_id",
        insertedMsg.externalId,
      )
      dbTransactionSpan.setAttribute(
        "previous_messages_count",
        allMessages.length,
      )
      dbTransactionSpan.end()

      loggerWithChild({ email: sub }).info(
        "Existing conversation, fetched previous messages",
      )
      messages = allMessages.concat(insertedMsg) // Update messages array
      chat = existingChat
      chatCreationSpan.end()
    }
    return streamSSE(c, async (stream) => {
      // Store MCP clients for cleanup to prevent memory leaks
      const mcpClients: Client[] = []
      let structuredReasoningSteps: AgentReasoningStep[] = [] // For structured reasoning steps
      // Track steps per iteration for limiting display
      let currentIterationSteps = 0
      let currentIterationNumber = 0
      const MAX_STEPS_PER_ITERATION = 3
      let currentIterationAllSteps: AgentReasoningStep[] = [] // Track all steps in current iteration for summary

      const logAndStreamReasoning = async (
        reasoningStep: AgentReasoningStep,
        userQuery: string = message, // Default to the current message
      ): Promise<void> => {
        const stepId = `step_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        const timestamp = Date.now()

        // Check if this is a new iteration
        if (reasoningStep.type === AgentReasoningStepType.Iteration) {
          // Generate summary for previous iteration if it exists
          if (
            currentIterationNumber > 0 &&
            currentIterationAllSteps.length > 0
          ) {
            await generateAndStreamIterationSummary(
              currentIterationNumber,
              currentIterationAllSteps,
              userQuery,
            )
          }

          currentIterationNumber =
            reasoningStep.iteration ?? currentIterationNumber + 1
          currentIterationSteps = 0 // Reset step counter for new iteration
          currentIterationAllSteps = [] // Reset all steps for new iteration
        } else {
          // Track all steps in current iteration for summary
          currentIterationAllSteps.push(reasoningStep)

          // Skip steps beyond the limit for current iteration
          if (currentIterationSteps >= MAX_STEPS_PER_ITERATION) {
            // For skipped steps, only generate fallback summary (no AI call)
            const enhancedStep: AgentReasoningStep = {
              ...reasoningStep,
              stepId,
              timestamp,
              status: "in_progress",
              stepSummary: generateFallbackSummary(reasoningStep), // Only fallback summary
            }

            const humanReadableLog = convertReasoningStepToText(enhancedStep)
            structuredReasoningSteps.push(enhancedStep)
            return // Don't stream to frontend
          }
          currentIterationSteps++
        }

        // Generate AI summary ONLY for displayed steps (first 3 per iteration)
        const aiGeneratedSummary = await generateStepSummary(
          reasoningStep,
          userQuery,
          dateForAI,
          undefined,
          actualModelId || undefined,
        )

        const enhancedStep: AgentReasoningStep = {
          ...reasoningStep,
          stepId,
          timestamp,
          status: "in_progress",
          stepSummary: generateFallbackSummary(reasoningStep), // Quick fallback
          aiGeneratedSummary, // AI-generated summary only for displayed steps
        }

        const humanReadableLog = convertReasoningStepToText(enhancedStep)
        structuredReasoningSteps.push(enhancedStep)
        const data = JSON.stringify({
          text: humanReadableLog,
          step: enhancedStep,
          quickSummary: enhancedStep.stepSummary,
          aiSummary: enhancedStep.aiGeneratedSummary,
        })
        thinking += `${data}\n`
        // Stream both summaries
        await stream.writeSSE({
          event: ChatSSEvents.Reasoning,
          data: data,
        })
      }

      // Helper function to create iteration summary steps
      const createIterationSummaryStep = (
        summary: string,
        iterationNumber: number,
      ): AgentReasoningStep => ({
        type: AgentReasoningStepType.LogMessage,
        stepId: `iteration_summary_${iterationNumber}_${Date.now()}`,
        timestamp: Date.now(),
        status: "completed",
        iteration: iterationNumber,
        message: summary,
        stepSummary: summary,
        aiGeneratedSummary: summary,
        isIterationSummary: true,
      })

      // Generate and stream iteration summary
      const generateAndStreamIterationSummary = async (
        iterationNumber: number,
        allSteps: AgentReasoningStep[],
        userQuery: string,
      ): Promise<void> => {
        try {
          const prompt = generateConsolidatedStepSummaryPromptJson(
            allSteps,
            userQuery,
            iterationNumber,
            `Iteration ${iterationNumber} complete summary`,
          )

          // Use the selected model or fallback to fast model for summary generation
          const summaryResult = await generateSynthesisBasedOnToolOutput(
            prompt,
            dateForAI,
            "",
            "",
            {
              modelId: (actualModelId as Models) || defaultFastModel,
              stream: false,
              json: true,
              reasoning: false,
              messages: [],
            },
          )

          const summaryResponse = summaryResult.text || ""

          // Parse the JSON response
          const parsed = jsonParseLLMOutput(summaryResponse)
          const summary =
            parsed.summary ||
            `Completed iteration ${iterationNumber} with ${allSteps.length} steps.`

          // Create the iteration summary step
          const iterationSummaryStep = createIterationSummaryStep(
            summary,
            iterationNumber,
          )

          // Add to structured reasoning steps so it gets saved to DB
          structuredReasoningSteps.push(iterationSummaryStep)

          const data = JSON.stringify({
            text: summary,
            step: iterationSummaryStep,
            quickSummary: summary,
            aiSummary: summary,
            isIterationSummary: true,
          })
          thinking += `${data}\n`

          // Stream the iteration summary
          await stream.writeSSE({
            event: ChatSSEvents.Reasoning,
            data: data,
          })
        } catch (error) {
          Logger.error(`Error generating iteration summary: ${error}`)
          // Fallback summary
          const fallbackSummary = `Completed iteration ${iterationNumber} with ${allSteps.length} steps.`

          // Create the fallback iteration summary step
          const fallbackSummaryStep = createIterationSummaryStep(
            fallbackSummary,
            iterationNumber,
          )

          // Add to structured reasoning steps so it gets saved to DB
          structuredReasoningSteps.push(fallbackSummaryStep)

          const data = JSON.stringify({
            text: fallbackSummary,
            step: fallbackSummaryStep,
            quickSummary: fallbackSummary,
            aiSummary: fallbackSummary,
            isIterationSummary: true,
          })

          thinking += `${data}\n`

          await stream.writeSSE({
            event: ChatSSEvents.Reasoning,
            data: data,
          })
        }
      }

      streamKey = `${chat.externalId}` // Create the stream key
      activeStreams.set(streamKey, { stream }) // Add stream to the map with new structure
      loggerWithChild({ email: sub }).info(
        `Added stream ${streamKey} to active streams map.`,
      )
      const streamSpan = rootSpan.startSpan("stream_response")
      streamSpan.setAttribute("chatId", chat.externalId)
      let wasStreamClosedPrematurely = false
      try {
        if (!chatId) {
          const titleUpdateSpan = streamSpan.startSpan("send_title_update")
          await stream.writeSSE({
            data: title,
            event: ChatSSEvents.ChatTitleUpdate,
          })
          titleUpdateSpan.end()
        }

        loggerWithChild({ email: sub }).info("Chat stream started")
        // we do not set the message Id as we don't have it
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({
            chatId: chat.externalId,
          }),
        })

        // Send attachment metadata immediately if attachments exist
        if (attachmentMetadata && attachmentMetadata.length > 0) {
          const userMessage = messages[messages.length - 1]
          await stream.writeSSE({
            event: ChatSSEvents.AttachmentUpdate,
            data: JSON.stringify({
              messageId: userMessage.externalId,
              attachments: attachmentMetadata,
            }),
          })
        }

        // Notify client if attachment storage failed
        if (attachmentStorageError) {
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: JSON.stringify({
              error: "attachment_storage_failed",
              message:
                "Failed to store attachment metadata. Your message was saved but attachments may not be available for future reference.",
              details: attachmentStorageError.message,
            }),
          })
        }

        let messagesWithNoErrResponse = messages
          .slice(0, messages.length - 1)
          .filter((msg) => !msg?.errorMessage)
          .map((m) => ({
            role: m.messageRole as ConversationRole,
            content: [{ text: m.message }],
          }))

        loggerWithChild({ email: sub }).info(
          "Checking if answer is in the conversation or a mandatory query rewrite is needed before RAG",
        )
        const finalToolsList: JAFinalToolsList = {}
        type FinalToolsEntry = JAFinalToolsList[string]
        type AdapterTool = FinalToolsEntry["tools"][number]
        let iterationCount = 0
        let isCustomMCP = false
        await logAndStreamReasoning({
          type: AgentReasoningStepType.LogMessage,
          message: `We're reading your question and figuring out the best way to find the answer — whether it's checking documents, searching emails, or gathering helpful info. This might take a few seconds... hang tight! <br> <br> We’re analyzing your query and choosing the best path forward — whether it’s searching internal docs, retrieving emails, or piecing together context. Hang tight while we think through it step by step.`,
        })
        if (toolsList && toolsList.length > 0) {
          for (const item of toolsList) {
            const { connectorId, tools: toolExternalIds } = item
            // Fetch connector info and create client
            const connector = await getConnectorById(
              db,
              parseInt(connectorId, 10),
              user.id,
            )
            if (!connector) {
              loggerWithChild({ email: sub }).warn(
                `Connector not found or access denied for connectorId: ${connectorId}`,
              )
              continue
            }
            const client = new Client({
              name: `connector-${connectorId}`,
              version: connector.config.version,
            })
            try {
              const loadedConfig = connector.config as {
                url?: string
                command?: string
                args?: string[]
                mode?: "sse" | "streamable-http"
                version: string
              }

              if (loadedConfig.url) {
                // This is an HTTP-based connector (SSE or Streamable)
                isCustomMCP = true
                const loadedUrl = loadedConfig.url
                const loadedMode = loadedConfig.mode || "sse" // Default to 'sse' for old connectors

                let loadedHeaders: Record<string, string> = {}
                if (connector.credentials) {
                  // New format: credentials contain the headers object
                  try {
                    loadedHeaders = JSON.parse(connector.credentials as string)
                  } catch (error) {
                    loggerWithChild({ email: sub }).error(
                      error,
                      `Failed to parse connector credentials for connectorId: ${connectorId}. Using empty headers.`,
                    )
                    loadedHeaders = {}
                  }
                } else if (connector.apiKey) {
                  // Old format: for backwards compatibility
                  loadedHeaders["Authorization"] = `Bearer ${connector.apiKey}`
                }
                loggerWithChild({ email: sub }).info(
                  `Connecting to MCP client at ${loadedUrl} with mode: ${loadedMode}`,
                )

                if (loadedMode === "streamable-http") {
                  const transportOptions: StreamableHTTPClientTransportOptions =
                    {
                      requestInit: {
                        headers: loadedHeaders,
                      },
                    }
                  await client.connect(
                    new StreamableHTTPClientTransport(
                      new URL(loadedUrl),
                      transportOptions,
                    ),
                  )
                } else {
                  // 'sse' mode
                  const transportOptions: SSEClientTransportOptions = {
                    requestInit: {
                      headers: loadedHeaders,
                    },
                  }
                  await client.connect(
                    new SSEClientTransport(
                      new URL(loadedUrl),
                      transportOptions,
                    ),
                  )
                }
              } else if (loadedConfig.command) {
                // This is an Stdio-based connector
                loggerWithChild({ email: sub }).info(
                  `Connecting to MCP Stdio client with command: ${loadedConfig.command}`,
                )
                await client.connect(
                  new StdioClientTransport({
                    command: loadedConfig.command,
                    args: loadedConfig.args || [],
                  }),
                )
              } else {
                throw new Error(
                  "Invalid MCP connector configuration: missing url or command.",
                )
              }
            } catch (error) {
              loggerWithChild({ email: sub }).error(
                error,
                `Failed to connect to MCP client for connector ${connectorId}`,
              )
              continue
            }
            // Store client for cleanup
            mcpClients.push(client)
            const tools = await getToolsByConnectorId(
              db,
              workspace.id,
              connector.id,
            )

            const filteredTools = tools.filter((tool) => {
              const isIncluded = toolExternalIds.includes(tool.externalId!)
              if (!isIncluded) {
                loggerWithChild({ email: sub }).info(
                  `[MessageWithToolsApi] Tool ${tool.externalId}:${tool.toolName} not in requested toolExternalIds.`,
                )
              }
              return isIncluded
            })

            const formattedTools: FinalToolsEntry["tools"] = filteredTools.map(
              (tool): AdapterTool => ({
                toolName: tool.toolName,
                toolSchema: tool.toolSchema,
                description: tool.description ?? undefined,
              }),
            )

            if (formattedTools.length === 0) {
              continue
            }

            const wrappedClient: FinalToolsEntry["client"] = {
              callTool: async ({ name, arguments: toolArguments }) => {
                if (isRecord(toolArguments)) {
                  return client.callTool({
                    name,
                    arguments: toolArguments,
                  })
                }
                return client.callTool({ name })
              },
              close: () => client.close(),
            }

            finalToolsList[String(connector.id)] = {
              tools: formattedTools,
              client: wrappedClient,
            }
          }
        }
        // ====== JAF-based agent loop starts here (replaces manual loop) ======
        const jafProcessingSpan = streamSpan.startSpan("jaf_processing")

        // Prepare streaming state holders
        let answer = ""
        const citations: Citation[] = []
        const imageCitations: ImageCitation[] = []
        const citationMap: Record<number, number> = {}
        const citationValues: Record<number, Citation> = {}
        let gatheredFragments: MinimalAgentFragment[] = []
        const gatheredFragmentskeys = new Set<string>() // to track uniqueness
        const seenDocuments = new Set<string>()
        let planningContext = ""
        let parseSynthesisResult = null

        if (hasReferencedContext && iterationCount === 0) {
          const contextFetchSpan = rootSpan.startSpan("fetchDocumentContext")
          await logAndStreamReasoning({
            type: AgentReasoningStepType.Iteration,
            iteration: iterationCount,
          })
          try {
            const results = await GetDocumentsByDocIds(
              fileIds,
              contextFetchSpan,
            )
            if (results?.root?.children && results.root.children.length > 0) {
              const contextPromises = results?.root?.children?.map(
                async (v, i) => {
                  let content = await answerContextMap(
                    v as VespaSearchResults,
                    userMetadata,
                    0,
                    true,
                    undefined,
                    message,
                  )
                  const chatContainerFields =
                    isChatContainerFields(v.fields) &&
                    v.fields.sddocname === chatContainerSchema
                      ? v.fields
                      : undefined

                  if (chatContainerFields?.creator) {
                    const creator = await getDocumentOrNull(
                      chatUserSchema,
                      chatContainerFields.creator,
                    )
                    if (creator && isChatUserFields(creator.fields)) {
                      content += `\nCreator: ${creator.fields.name}`
                    }
                  }
                  return `Index ${i + 1} \n ${content}`
                },
              )
              const resolvedContexts = contextPromises
                ? await Promise.all(contextPromises)
                : []

              const chatContexts: VespaSearchResult[] = []
              const threadContexts: VespaSearchResult[] = []
              if (results?.root?.children) {
                for (const v of results.root.children) {
                  const chatContainerFields =
                    isChatContainerFields(v.fields) &&
                    v.fields.sddocname === chatContainerSchema
                      ? v.fields
                      : undefined
                  if (chatContainerFields) {
                    const channelId = chatContainerFields.docId

                    if (channelId) {
                      const searchResults = await searchSlackInVespa(
                        message,
                        email,
                        {
                          limit: 10,
                          channelIds: [channelId],
                        },
                      )
                      if (searchResults.root.children) {
                        chatContexts.push(...searchResults.root.children)
                        const threadMessages = await getThreadContext(
                          searchResults,
                          email,
                          contextFetchSpan,
                        )
                        if (threadMessages && threadMessages.root.children) {
                          threadContexts.push(...threadMessages.root.children)
                        }
                      }
                    }
                  }
                }
              }
              planningContext = cleanContext(resolvedContexts?.join("\n"))
              if (chatContexts.length > 0) {
                planningContext +=
                  "\n" + buildContext(chatContexts, 10, userMetadata)
              }
              if (threadContexts.length > 0) {
                planningContext +=
                  "\n" + buildContext(threadContexts, 10, userMetadata)
              }

              gatheredFragments = await Promise.all(
                results.root.children.map(
                  async (child: VespaSearchResult, idx) =>
                    await vespaResultToMinimalAgentFragment(
                      child,
                      idx,
                      userMetadata,
                      message,
                    ),
                ),
              )
              if (chatContexts.length > 0) {
                gatheredFragments.push(
                  ...(await Promise.all(
                    chatContexts.map(
                      async (child, idx) =>
                        await vespaResultToMinimalAgentFragment(
                          child,
                          idx,
                          userMetadata,
                          message,
                        ),
                    ),
                  )),
                )
              }
              if (threadContexts.length > 0) {
                gatheredFragments.push(
                  ...(await Promise.all(
                    threadContexts.map(
                      async (child, idx) =>
                        await vespaResultToMinimalAgentFragment(
                          child,
                          idx,
                          userMetadata,
                          message,
                        ),
                    ),
                  )),
                )
              }
              const parseSynthesisOutput = await performSynthesis(
                ctx,
                getDateForAI({ userTimeZone: userTimezone }),
                message,
                planningContext,
                gatheredFragments,
                messagesWithNoErrResponse,
                logAndStreamReasoning,
                sub,
                imageAttachmentFileIds,
                actualModelId || undefined,
              )
              await logAndStreamReasoning({
                type: AgentReasoningStepType.LogMessage,
                message: `Synthesis result: ${parseSynthesisOutput?.synthesisState || "unknown"}`,
              })
              await logAndStreamReasoning({
                type: AgentReasoningStepType.LogMessage,
                message: ` Synthesis: ${
                  parseSynthesisOutput?.answer || "No Synthesis details"
                }`,
              })
              const isContextSufficient =
                parseSynthesisOutput?.synthesisState ===
                ContextSysthesisState.Complete

              console.log("SYNTHESIS OUTPUT", parseSynthesisOutput?.answer)

              if (isContextSufficient) {
                parseSynthesisResult = JSON.stringify(parseSynthesisOutput)
                // Context is complete. We can break the loop and generate the final answer.
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.LogMessage,
                  message:
                    "Context is sufficient. Proceeding to generate final answer.",
                })
              }
            }
          } catch (error) {
            loggerWithChild({ email: sub }).error(
              error,
              "Failed to fetch document context for agent tools",
            )
          } finally {
            contextFetchSpan?.end()
          }
        }

        // Compose JAF tools: internal + MCP
        const toolsCompositionSpan =
          jafProcessingSpan.startSpan("tools_composition")
        const baseCtx: JAFAdapterCtx = {
          email: sub,
          userCtx: ctx,
          agentPrompt: agentPromptForLLM,
          userMessage: message,
        }
        const internalTools = [
          ...googleTools,
          searchGlobalTool,
          getSlackRelatedMessagesTool,
        ]
        const mcpJAFTools = buildMCPJAFTools(finalToolsList)
        const allJAFTools = [...internalTools, ...mcpJAFTools]
        toolsCompositionSpan.setAttribute(
          "internal_tools_count",
          internalTools.length,
        )
        toolsCompositionSpan.setAttribute("mcp_tools_count", mcpJAFTools.length)
        toolsCompositionSpan.setAttribute(
          "total_tools_count",
          allJAFTools.length,
        )
        toolsCompositionSpan.end()
        const toolOverview = buildToolsOverview(internalTools)
        const contextSection = buildContextSection(gatheredFragments)
        const agentSection = agentPromptForLLM
          ? `\n\nAgent Constraints:\n${agentPromptForLLM}`
          : ""
        const synthesisSection = parseSynthesisResult
        const dateForAI = getDateForAI({ userTimeZone: userTimezone })
        const agentInstructions = agentInstructionsPrompt(
          toolOverview,
          contextSection,
          agentSection,
          dateForAI,
        )

        const jafSetupSpan = jafProcessingSpan.startSpan("jaf_setup")
        const runId = generateRunId()
        const traceId = generateTraceId()
        const initialMessages: JAFMessage[] = messages
          .filter((m) => !m?.errorMessage)
          .map((m) => ({
            role: m.messageRole === MessageRole.User ? "user" : "assistant",
            content: m.message,
          }))

        const jafAgent: JAFAgent<JAFAdapterCtx, string> = {
          name: "xyne-agent",
          instructions: () => agentInstructions,
          tools: allJAFTools,
          modelConfig: { name: defaultBestModel },
        }

        const modelProvider = makeXyneJAFProvider<JAFAdapterCtx>()

        const agentRegistry = new Map<string, JAFAgent<JAFAdapterCtx, string>>([
          [jafAgent.name, jafAgent],
        ])

        let runState: JAFRunState<JAFAdapterCtx> = {
          runId,
          traceId,
          messages: initialMessages,
          currentAgentName: jafAgent.name,
          context: baseCtx,
          turnCount: 0,
        }

        const runCfg: JAFRunConfig<JAFAdapterCtx> = {
          agentRegistry,
          modelProvider,
          maxTurns: 10,
          modelOverride: defaultBestModel,
          allowClarificationRequests: true,
          clarificationDescription: hitlClarificationDescription,
          onAfterToolExecution: async (
            toolName: string,
            result: any,
            context: {
              toolCall: ToolCall
              args: any
              state: JAFRunState<JAFAdapterCtx>
              agentName: string
              executionTime: number
              status: string | ToolResult
            },
          ) => {
            // Return only the best document indexes content as string
            const contexts = result?.metadata?.contexts

            if (Array.isArray(contexts) && contexts.length) {
              const filteredContexts = contexts.filter(
                (v) => !gatheredFragmentskeys.has(v.id),
              )

              const contextStrings = filteredContexts.map(
                (v: MinimalAgentFragment) => {
                  seenDocuments.add(v.id)
                  return `
                    title: ${v.source.title}\n
                    content: ${v.content}\n
                    `
                },
              )

              try {
                const bestDocIndexes = await extractBestDocumentIndexes(
                  message,
                  contextStrings,
                  {
                    modelId: config.defaultBestModel,
                    json: false,
                    stream: false,
                  },
                  messagesWithNoErrResponse,
                )

                if (bestDocIndexes.length) {
                  const selectedDocs: MinimalAgentFragment[] = []

                  bestDocIndexes.forEach((idx) => {
                    if (idx >= 1 && idx <= filteredContexts.length) {
                      const doc: MinimalAgentFragment =
                        filteredContexts[idx - 1]
                      const key = doc.id
                      if (!gatheredFragmentskeys.has(key)) {
                        gatheredFragments.push(doc)
                        gatheredFragmentskeys.add(key)
                      }
                      selectedDocs.push(doc)
                    }
                  })

                  return selectedDocs
                    .map((doc: MinimalAgentFragment) => doc.content)
                    .join("\n")
                } else {
                  Logger.info(
                    "Couldn't retrieve good documents for user's query",
                  )
                  // If no best documents found, return empty string
                  return null
                }
              } catch (error) {
                // adding all context if extracting best document fails
                filteredContexts.forEach((doc: MinimalAgentFragment) => {
                  const key = doc.id
                  if (!gatheredFragmentskeys.has(key)) {
                    gatheredFragments.push(doc)
                    gatheredFragmentskeys.add(key)
                  }
                })

                return null
              }
            }
            return null
          },
        }
        jafSetupSpan.setAttribute("run_id", runId)
        jafSetupSpan.setAttribute("trace_id", traceId)
        jafSetupSpan.setAttribute(
          "initial_messages_count",
          initialMessages.length,
        )
        jafSetupSpan.setAttribute("max_turns", 10)
        jafSetupSpan.end()

        // Note: ResponseMetadata was already sent above with chatId

        // Stream JAF events → existing SSE protocol
        const jafStreamingSpan = jafProcessingSpan.startSpan("jaf_streaming")
        const yieldedCitations = new Set<number>()
        const yieldedImageCitations = new Map<number, Set<number>>()
        let currentTurn = 0
        let totalToolCalls = 0

        await JafStreamer(runState, runCfg, baseCtx, stream, {
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
        })

        jafStreamingSpan.setAttribute("total_turns", currentTurn)
        jafStreamingSpan.setAttribute("total_tool_calls", totalToolCalls)
        jafStreamingSpan.setAttribute("final_answer_length", answer.length)
        jafStreamingSpan.setAttribute("citations_count", citations.length)
        jafStreamingSpan.setAttribute(
          "image_citations_count",
          imageCitations.length,
        )
        jafStreamingSpan.end()

        jafProcessingSpan.end()

        // Early return to skip legacy manual loop
        streamSpan.end()
        rootSpan.end()
        return
      } finally {
        // Cleanup MCP clients to prevent memory leaks
        for (const client of mcpClients) {
          try {
            await client.close()
          } catch (error) {
            loggerWithChild({ email: sub }).error(
              error,
              "Failed to close MCP client",
            )
          }
        }

        // Remove stream from active streams map
        if (streamKey && activeStreams.has(streamKey)) {
          activeStreams.delete(streamKey)
          loggerWithChild({ email: sub }).info(
            `Removed stream ${streamKey} from active streams map.`,
          )
        }

        // Close SSE stream (defensive)
        if (stream) {
          await stream.close()
        }
      }
    })
  } catch (error) {
    loggerWithChild({ email: email }).error(
      error,
      "MessageWithToolsApi failed before stream start",
    )
    // If streaming hasn't started yet, surface a proper HTTP error to the client
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

async function* nonRagIterator(
  message: string,
  userCtx: string,
  dateForAI: string,
  context: string,
  results: MinimalAgentFragment[],
  agentPrompt?: string,
  messages: Message[] = [],
  imageFileNames: string[] = [],
  email?: string,
  isReasoning = true,
  modelId?: string,
): AsyncIterableIterator<
  ConverseResponse & {
    citation?: { index: number; item: Citation }
    imageCitation?: ImageCitation
  }
> {
  const ragOffIterator = baselineRAGOffJsonStream(
    message,
    userCtx,
    dateForAI,
    context,
    {
      modelId: (modelId as Models) || defaultBestModel,
      stream: true,
      json: false,
      reasoning: isReasoning,
      imageFileNames,
    },
    agentPrompt ?? "",
    messages,
  )

  // const previousResultsLength = 0
  let buffer = ""
  let thinking = ""
  let reasoning = isReasoning
  let yieldedCitations = new Set<number>()
  let yieldedImageCitations = new Map<number, Set<number>>()

  for await (const chunk of ragOffIterator) {
    try {
      if (chunk.text) {
        if (reasoning) {
          if (thinking && !chunk.text.includes(EndThinkingToken)) {
            thinking += chunk.text
            yield* checkAndYieldCitationsForAgent(
              thinking,
              yieldedCitations,
              results,
              undefined,
              email!,
            )
            yield { text: chunk.text, reasoning }
          } else {
            const startThinkingIndex = chunk.text.indexOf(StartThinkingToken)
            if (
              startThinkingIndex !== -1 &&
              chunk.text.trim().length > StartThinkingToken.length
            ) {
              let token = chunk.text.slice(
                startThinkingIndex + StartThinkingToken.length,
              )
              if (chunk.text.includes(EndThinkingToken)) {
                token = chunk.text.split(EndThinkingToken)[0]
                thinking += token
              } else {
                thinking += token
              }
              yield* checkAndYieldCitationsForAgent(
                thinking,
                yieldedCitations,
                results,
                undefined,
                email!,
              )
              yield { text: token, reasoning }
            }
          }
        }
        if (reasoning && chunk.text.includes(EndThinkingToken)) {
          reasoning = false
          chunk.text = chunk.text.split(EndThinkingToken)[1].trim()
        }
        if (!reasoning) {
          buffer += chunk.text
          yield { text: chunk.text }

          yield* checkAndYieldCitationsForAgent(
            buffer,
            yieldedCitations,
            results,
            yieldedImageCitations,
            email ?? "",
          )
        }
      }

      if (chunk.cost) {
        yield { cost: chunk.cost }
      }
      if (chunk.metadata) {
        yield { metadata: chunk.metadata }
      }
    } catch (e) {
      Logger.error(`Error processing chunk: ${e}`)
      continue
    }
  }
}

export const AgentMessageApiRagOff = async (c: Context) => {
  const tracer: Tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("AgentMessageApiRagOff")

  let stream: any
  let chat: SelectChat
  let assistantMessageId: string | null = null
  let streamKey: string | null = null
  const { email, workspaceExternalId: workspaceId, via_apiKey } = getAuth(c)
  let body

  try {
    if (!via_apiKey) {
      // @ts-ignore
      body = c.req.valid("query")
    } else {
      // @ts-ignore
      body = c.req.valid("json")
    }
    loggerWithChild({ email: email }).info("AgentMessageApiRagOff..")
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    let {
      message,
      chatId,
      selectedModelConfig,
      agentId,
      streamOff,
      agentPromptPayload,
    }: MessageReqType = body

    // Parse the model configuration JSON
    let modelId: string | null = null
    let isReasoningEnabled = false

    if (selectedModelConfig) {
      try {
        const modelConfig = JSON.parse(selectedModelConfig)
        modelId = modelConfig.model || null

        // Check capabilities - handle both array and object formats
        if (modelConfig.capabilities) {
          if (Array.isArray(modelConfig.capabilities)) {
            isReasoningEnabled = modelConfig.capabilities.includes("reasoning")
          } else if (typeof modelConfig.capabilities === "object") {
            isReasoningEnabled = modelConfig.capabilities.reasoning === true
          }
        }
      } catch (error) {
        console.error("Failed to parse selectedModelConfig:", error)
      }
    }

    // Convert friendly model label to actual model value
    let actualModelId = modelId ? getModelValueFromLabel(modelId) : null
    if (modelId) {
      if (!actualModelId && modelId in Models) {
        actualModelId = modelId as Models
      } else if (!actualModelId) {
        throw new HTTPException(400, { message: `Invalid model: ${modelId}` })
      }
    } else {
      actualModelId = defaultBestModel
    }

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId, // This workspaceId is the externalId from JWT
      email,
    )
    const { user, workspace } = userAndWorkspace // workspace.id is the numeric ID
    let agentPromptForLLM: string | undefined = undefined
    let agentForDb: SelectAgent | null = null

    // Handle test current form config case
    if (agentPromptPayload !== undefined) {
      const mockAgentResult = createMockAgentFromFormData(
        agentPromptPayload,
        user,
        workspace,
        email,
      )
      agentForDb = mockAgentResult.agentForDb
      agentPromptForLLM = mockAgentResult.agentPromptForLLM
    } else if (agentId && isCuid(agentId)) {
      // Use the numeric workspace.id for the database query with permission check
      agentForDb = await getAgentByExternalIdWithPermissionCheck(
        db,
        agentId,
        workspace.id,
        user.id,
      )
      if (!agentForDb) {
        throw new HTTPException(403, {
          message: "Access denied: You don't have permission to use this agent",
        })
      }
      agentPromptForLLM = JSON.stringify(agentForDb)
    }
    const agentIdToStore = agentForDb ? agentForDb.externalId : null
    const userRequestsReasoning = isReasoningEnabled
    if (!message) {
      throw new HTTPException(400, {
        message: "Message is required",
      })
    }
    message = decodeURIComponent(message)
    rootSpan.setAttribute("message", message)
    const isMsgWithContext = isMessageWithContext(message)
    const extractedInfo = isMsgWithContext
      ? await extractFileIdsFromMessage(message, email)
      : {
          totalValidFileIdsFromLinkCount: 0,
          fileIds: [],
        }
    const fileIds = extractedInfo?.fileIds
    const totalValidFileIdsFromLinkCount =
      extractedInfo?.totalValidFileIdsFromLinkCount

    let messages: SelectMessage[] = []
    const costArr: number[] = []
    const tokenArr: { inputTokens: number; outputTokens: number }[] = []
    const ctx = userContext(userAndWorkspace)
    const userTimezone = user?.timeZone || "Asia/Kolkata"
    const dateForAI = getDateForAI({ userTimeZone: userTimezone })
    const userMetadata: UserMetadataType = { userTimezone, dateForAI }
    let chat: SelectChat

    const chatCreationSpan = rootSpan.startSpan("chat_creation")

    let title = ""
    if (!chatId) {
      let [insertedChat, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage]> => {
          const chat = await insertChat(tx, {
            workspaceId: workspace.id,
            workspaceExternalId: workspace.externalId,
            userId: user.id,
            email: user.email,
            title: "Untitled",
            attachments: [],
            agentId: agentIdToStore as string,
            via_apiKey,
          })

          const insertedMsg = await insertMessage(tx, {
            chatId: chat.id,
            userId: user.id,
            chatExternalId: chat.externalId,
            workspaceExternalId: workspace.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: [],
            message,
            modelId: (actualModelId as Models) || defaultBestModel,
            fileIds: fileIds,
          })
          return [chat, insertedMsg]
        },
      )
      Logger.info(
        "First mesage of the conversation, successfully created the chat",
      )
      chat = insertedChat
      messages.push(insertedMsg) // Add the inserted message to messages array
      chatCreationSpan.end()
    } else {
      let [existingChat, allMessages, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage[], SelectMessage]> => {
          // we are updating the chat and getting it's value in one call itself

          let existingChat = await updateChatByExternalIdWithAuth(
            db,
            chatId,
            email,
            {},
          )
          let allMessages = await getChatMessagesWithAuth(tx, chatId, email)

          let insertedMsg = await insertMessage(tx, {
            chatId: existingChat.id,
            userId: user.id,
            workspaceExternalId: workspace.externalId,
            chatExternalId: existingChat.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: [],
            message,
            modelId: (actualModelId as Models) || defaultBestModel,
            fileIds,
          })
          return [existingChat, allMessages, insertedMsg]
        },
      )
      Logger.info("Existing conversation, fetched previous messages")
      messages = allMessages.concat(insertedMsg) // Update messages array
      chat = existingChat
      chatCreationSpan.end()
    }
    if (!streamOff) {
      return streamSSE(c, async (stream) => {
        streamKey = `${chat.externalId}` // Create the stream key
        activeStreams.set(streamKey, { stream }) // Add stream to the map with new structure
        Logger.info(`Added stream ${streamKey} to active streams map.`)
        let wasStreamClosedPrematurely = false
        const streamSpan = rootSpan.startSpan("stream_response")
        streamSpan.setAttribute("chatId", chat.externalId)
        const messagesWithNoErrResponse = messages
          .slice(0, messages.length - 1)
          .filter((msg) => !msg?.errorMessage)
          .map((m) => ({
            role: m.messageRole as ConversationRole,
            content: [{ text: m.message }],
          }))
        try {
          if (!chatId) {
            const titleUpdateSpan = streamSpan.startSpan("send_title_update")
            await stream.writeSSE({
              data: title,
              event: ChatSSEvents.ChatTitleUpdate,
            })
            titleUpdateSpan.end()
          }

          Logger.info("Chat stream started")
          // we do not set the message Id as we don't have it
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chat.externalId,
            }),
          })

          const dataSourceSpan = streamSpan.startSpan("get_all_data_sources")
          const allDataSources = await getAllDocumentsForAgent(
            [Apps.DataSource],
            agentForDb?.appIntegrations as string[],
            400,
            email,
          )
          dataSourceSpan.end()
          loggerWithChild({ email }).info(
            `Found ${allDataSources?.root?.children?.length} data sources for agent`,
          )

          let docIds: string[] = []
          if (
            allDataSources &&
            allDataSources.root &&
            allDataSources.root.children
          ) {
            docIds = [
              ...new Set(
                allDataSources.root.children
                  .map(
                    (child: VespaSearchResult) =>
                      (child.fields as any)?.docId as string,
                  )
                  .filter(Boolean),
              ),
            ]
          }

          let context = ""
          let finalImageFileNames: string[] = []
          let fragments: MinimalAgentFragment[] = []
          if (docIds.length > 0) {
            let previousResultsLength = 0
            const chunksSpan = streamSpan.startSpan("get_documents_by_doc_ids")
            const allChunks = await GetDocumentsByDocIds(docIds, chunksSpan)
            // const allChunksCopy
            chunksSpan.end()
            if (allChunks?.root?.children) {
              const startIndex = 0
              fragments = await Promise.all(
                allChunks.root.children.map(
                  async (child, idx) =>
                    await vespaResultToMinimalAgentFragment(
                      child,
                      idx,
                      userMetadata,
                      message,
                    ),
                ),
              )
              context = answerContextMapFromFragments(
                fragments,
                maxDefaultSummary,
              )

              const { imageFileNames } = extractImageFileNames(
                context,
                fragments.map(
                  (v) =>
                    ({
                      fields: {
                        docId: v.source.docId,
                        title: v.source.title,
                        url: v.source.url,
                      },
                    }) as any,
                ),
              )
              Logger.info(`Image file names in RAG offffff: ${imageFileNames}`)
              finalImageFileNames = imageFileNames || []
              // context = initialContext;
            }
          }

          const ragOffIterator = nonRagIterator(
            message,
            ctx,
            dateForAI,
            context,
            fragments,
            agentPromptForLLM,
            messagesWithNoErrResponse,
            finalImageFileNames,
            email,
            isReasoningEnabled,
            actualModelId || undefined,
          )
          let answer = ""
          let citations: Citation[] = []
          let imageCitations: ImageCitation[] = []
          let citationMap: Record<number, number> = {}
          let citationValues: Record<number, Citation> = {}
          let thinking = ""
          let reasoning = isReasoningEnabled
          for await (const chunk of ragOffIterator) {
            if (stream.closed) {
              Logger.info("[AgentMessageApiRagOff] Stream closed. Breaking.")
              wasStreamClosedPrematurely = true
              break
            }
            if (chunk.text) {
              if (reasoning && chunk.reasoning) {
                thinking += chunk.text
                stream.writeSSE({
                  event: ChatSSEvents.Reasoning,
                  data: chunk.text,
                })
                // reasoningSpan.end()
              }
              if (!chunk.reasoning) {
                answer += chunk.text
                stream.writeSSE({
                  event: ChatSSEvents.ResponseUpdate,
                  data: chunk.text,
                })
              }
            }

            if (chunk.citation) {
              const { index, item } = chunk.citation
              citations.push(item)
              citationMap[index] = citations.length - 1
              loggerWithChild({ email }).info(
                `Found citations and sending it, current count: ${citations.length}`,
              )
              stream.writeSSE({
                event: ChatSSEvents.CitationsUpdate,
                data: JSON.stringify({
                  contextChunks: citations,
                  citationMap,
                }),
              })
              citationValues[index] = item
            }

            if (chunk.imageCitation) {
              loggerWithChild({ email: email }).info(
                `Found image citation, sending it`,
                { citationKey: chunk.imageCitation.citationKey },
              )
              imageCitations.push(chunk.imageCitation)
              stream.writeSSE({
                event: ChatSSEvents.ImageCitationUpdate,
                data: JSON.stringify(chunk.imageCitation),
              })
            }

            if (chunk.cost) {
              costArr.push(chunk.cost)
            }
            if (chunk.metadata?.usage) {
              tokenArr.push({
                inputTokens: chunk.metadata.usage.inputTokens,
                outputTokens: chunk.metadata.usage.outputTokens,
              })
            }
          }

          if (answer) {
            // Calculate total cost and tokens
            const totalCost = costArr.reduce((sum, cost) => sum + cost, 0)
            const totalTokens = tokenArr.reduce(
              (sum, tokens) => sum + tokens.inputTokens + tokens.outputTokens,
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
              message: processMessage(answer, citationMap),
              thinking: thinking,
              modelId: (actualModelId as Models) || defaultBestModel,
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
          } else if (wasStreamClosedPrematurely) {
            // Calculate total cost and tokens
            const totalCost = costArr.reduce((sum, cost) => sum + cost, 0)
            const totalTokens = tokenArr.reduce(
              (sum, tokens) => sum + tokens.inputTokens + tokens.outputTokens,
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
              message: processMessage(answer, citationMap),
              thinking: thinking,
              modelId: (actualModelId as Models) || defaultBestModel,
              cost: totalCost.toString(),
              tokensUsed: totalTokens,
            })
            assistantMessageId = msg.externalId
          } else {
            const errorMessage =
              "There seems to be an issue on our side. Please try again after some time."

            // Calculate total cost and tokens
            const totalCost = costArr.reduce((sum, cost) => sum + cost, 0)
            const totalTokens = tokenArr.reduce(
              (sum, tokens) => sum + tokens.inputTokens + tokens.outputTokens,
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
              message: processMessage(errorMessage, citationMap),
              thinking: thinking,
              modelId: (actualModelId as Models) || defaultBestModel,
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
              event: ChatSSEvents.ResponseUpdate,
              data: errorMessage,
            })
          }

          const endSpan = streamSpan.startSpan("send_end_event")
          await stream.writeSSE({
            data: "",
            event: ChatSSEvents.End,
          })
          endSpan.end()
          streamSpan.end()
          rootSpan.end()
        } catch (error) {
          // ... (error handling as in AgentMessageApi)
        } finally {
          if (streamKey && activeStreams.has(streamKey)) {
            activeStreams.delete(streamKey)
            Logger.info(`Removed stream ${streamKey} from active streams map.`)
          }
        }
      })
    } else {
      const nonStreamSpan = rootSpan.startSpan("nonstream_response")
      nonStreamSpan.setAttribute("chatId", chat.externalId)

      try {
        const messagesWithNoErrResponse = messages
          .slice(0, messages.length - 1)
          .filter((msg) => !msg?.errorMessage)
          .map((m) => ({
            role: m.messageRole as ConversationRole,
            content: [{ text: m.message }],
          }))

        // Build “context + fragments” (same as streaming path) -----------------------
        const dataSourceSpan = nonStreamSpan.startSpan("get_all_data_sources")
        const allDataSources = await getAllDocumentsForAgent(
          [Apps.DataSource],
          agentForDb?.appIntegrations as string[],
          400,
          email,
        )
        dataSourceSpan.end()
        loggerWithChild({ email }).info(
          `Found ${allDataSources?.root?.children?.length} data sources for agent`,
        )

        let docIds: string[] = []
        if (allDataSources?.root?.children) {
          docIds = [
            ...new Set(
              allDataSources.root.children
                .map(
                  (child: VespaSearchResult) =>
                    (child.fields as any)?.docId as string,
                )
                .filter(Boolean),
            ),
          ]
        }

        let context = ""
        let fragments: MinimalAgentFragment[] = []
        const chunksSpan = nonStreamSpan.startSpan("get_documents_by_doc_ids")
        if (docIds.length > 0) {
          const allChunks = await GetDocumentsByDocIds(docIds, chunksSpan)
          if (allChunks?.root?.children) {
            fragments = await Promise.all(
              allChunks.root.children.map(
                async (child, idx) =>
                  await vespaResultToMinimalAgentFragment(
                    child,
                    idx,
                    userMetadata,
                    message,
                  ),
              ),
            )
            context = answerContextMapFromFragments(
              fragments,
              maxDefaultSummary,
            )
          }
        }
        chunksSpan.end()

        let finalImageFileNames: string[] = []
        if (context && fragments.length) {
          const { imageFileNames } = extractImageFileNames(
            context,
            fragments.map(
              (v) =>
                ({
                  fields: {
                    docId: v.source.docId,
                    title: v.source.title,
                    url: v.source.url,
                  },
                }) as any,
            ),
          )
          finalImageFileNames = imageFileNames || []
        }

        // Helper: persist & return JSON once ----------------------------------------
        const finalizeAndRespond = async (params: {
          answer: string
          thinking: string
          citations: Citation[]
          imageCitations: ImageCitation[]
          citationMap: Record<number, number>
          costArr: number[]
          tokenArr: { inputTokens: number; outputTokens: number }[]
        }) => {
          const processed = processMessage(params.answer, params.citationMap)
          const totalCost = params.costArr.reduce((s, c) => s + c, 0)
          const totalTokens = params.tokenArr.reduce(
            (s, t) => s + t.inputTokens + t.outputTokens,
            0,
          )

          const msg = await insertMessage(db, {
            chatId: chat.id,
            userId: user.id,
            workspaceExternalId: workspace.externalId,
            chatExternalId: chat.externalId,
            messageRole: MessageRole.Assistant,
            email: user.email,
            sources: params.citations,
            imageCitations: params.imageCitations,
            message: processed,
            thinking: params.thinking, // ALWAYS include collected thinking
            modelId: (actualModelId as Models) || defaultBestModel,
            cost: totalCost.toString(),
            tokensUsed: totalTokens,
          })
          assistantMessageId = msg.externalId

          nonStreamSpan.end()
          rootSpan.end()

          return c.json({
            chatId: chat.externalId,
            messageId: assistantMessageId,
            answer: processed,
            // thinking: params.thinking,
            citations: params.citations,
            imageCitations: params.imageCitations,
          })
        }

        // Build iterator and collect -------------------------------------------------
        const ragOffIterator = nonRagIterator(
          message,
          ctx,
          dateForAI,
          context,
          fragments,
          agentPromptForLLM,
          messagesWithNoErrResponse,
          finalImageFileNames,
          email,
          isReasoningEnabled,
          actualModelId || undefined,
        )

        const {
          answer,
          thinking,
          citations,
          imageCitations,
          citationMap,
          costArr: costArrCollected,
          tokenArr: tokenArrCollected,
        } = await collectIterator(ragOffIterator)

        if (answer || thinking) {
          return await finalizeAndRespond({
            answer,
            thinking, // always forwarded
            citations,
            imageCitations,
            citationMap,
            costArr: costArr.concat(costArrCollected),
            tokenArr: tokenArr.concat(tokenArrCollected),
          })
        } else {
          // Graceful error response
          const msgText =
            "There seems to be an issue on our side. Please try again after some time."
          nonStreamSpan.end()
          rootSpan.end()
          return c.json(
            {
              chatId: chat.externalId,
              messageId: messages[messages.length - 1]?.externalId,
              error: msgText,
            },
            400,
          )
        }
      } catch (error) {
        const span = nonStreamSpan.startSpan("handle_nonstream_error")
        span.addEvent("error", {
          message: getErrorMessage(error),
          stack: (error as Error).stack || "",
        })
        const errFromMap = handleError(error)
        span.end()
        nonStreamSpan.end()
        rootSpan.end()
        return c.json({ error: errFromMap }, 500)
      }
    }
  } catch (error) {
    // ... (error handling as in AgentMessageApi)
  }
}

/**
 * AgentMessageApi - Legacy agent chat endpoint for simple agent conversations
 *
 * Used when: !isAgentic && !enableWebSearch && !deepResearchEnabled && agentDetails
 *
 * Features:
 * - Basic agent conversations with custom prompts
 * - RAG with document retrieval and citation tracking
 * - Query classification (conversation vs search)
 * - Streaming/non-streaming modes
 * - Context from file references and attachments
 *
 * Flow: Auth → Agent validation → Context extraction → Query classification → RAG processing → Response
 *
 * @param c - Hono Context with JWT payload
 * @returns StreamSSE with chat events or JSON response
 */
export const AgentMessageApi = async (c: Context) => {
  // we will use this in catch
  // if the value exists then we send the error to the frontend via it
  const tracer: Tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("AgentMessageApi")

  let stream: any
  let chat: SelectChat
  let assistantMessageId: string | null = null
  let streamKey: string | null = null
  const { email, workspaceExternalId: workspaceId, via_apiKey } = getAuth(c)
  let body

  try {
    if (!via_apiKey) {
      // @ts-ignore
      body = c.req.valid("query")
    } else {
      // @ts-ignore
      body = c.req.valid("json")
      const apiKeyScopes =
        safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
      const agentAccess =
        safeGet<{ agents?: string[] }>(c, "config")?.agents || []

      // Check if API key has agent chat scope
      if (!apiKeyScopes.includes(ApiKeyScopes.AGENT_CHAT)) {
        return c.json(
          {
            message: "API key does not have scope to chat with agents",
          },
          403,
        )
      }

      // Check agent access: if agentAccess is empty, allow all agents; otherwise check specific access
      //@ts-ignore
      if (agentAccess.length > 0 && !agentAccess.includes(body?.agentId)) {
        return c.json(
          {
            message: "API key is not authorized for this agent",
          },
          403,
        )
      }
    }
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    let attachmentMetadata = parseAttachmentMetadata(c)
    let imageAttachmentFileIds = attachmentMetadata
      .filter((m) => m.isImage)
      .map((m) => m.fileId)
    const nonImageAttachmentFileIds = attachmentMetadata
      .filter((m) => !m.isImage)
      .flatMap((m) => expandSheetIds(m.fileId))
    let attachmentStorageError: Error | null = null
    let {
      message,
      chatId,
      selectedModelConfig,
      agentId,
      agentPromptPayload,
      streamOff,
      path,
      ownerEmail,
    }: MessageReqType = body

    // Parse selectedModelConfig JSON to extract individual values
    let modelId: string | undefined = undefined
    let isReasoningEnabled = false
    let enableWebSearch = false
    let isDeepResearchEnabled = false

    if (selectedModelConfig) {
      try {
        const config = JSON.parse(selectedModelConfig)
        modelId = config.model

        // Handle new direct boolean format
        isReasoningEnabled = config.reasoning === true
        enableWebSearch = config.websearch === true
        isDeepResearchEnabled = config.deepResearch === true

        // For deep research, always use Claude Sonnet 4 regardless of UI selection
        if (isDeepResearchEnabled) {
          modelId = "Claude Sonnet 4"
          loggerWithChild({ email: email }).info(
            `[AgentMessageApi] Deep research enabled - forcing model to Claude Sonnet 4`,
          )
        }

        // Check capabilities - handle both array and object formats for backward compatibility
        if (
          config.capabilities &&
          !isReasoningEnabled &&
          !enableWebSearch &&
          !isDeepResearchEnabled
        ) {
          if (Array.isArray(config.capabilities)) {
            // Array format: ["reasoning", "websearch"]
            isReasoningEnabled = config.capabilities.includes("reasoning")
            enableWebSearch = config.capabilities.includes("websearch")
            isDeepResearchEnabled = config.capabilities.includes("deepResearch")
          } else if (typeof config.capabilities === "object") {
            // Object format: { reasoning: true, websearch: false }
            isReasoningEnabled = config.capabilities.reasoning === true
            enableWebSearch = config.capabilities.websearch === true
            isDeepResearchEnabled = config.capabilities.deepResearch === true
          }

          // For deep research from old format, also force Claude Sonnet 4
          if (isDeepResearchEnabled) {
            modelId = "Claude Sonnet 4"
          }
        }

        loggerWithChild({ email: email }).info(
          `[AgentMessageApi] Parsed model config: model="${modelId}", reasoning=${isReasoningEnabled}, websearch=${enableWebSearch}, deepResearch=${isDeepResearchEnabled}`,
        )
      } catch (e) {
        loggerWithChild({ email }).warn(
          `[AgentMessageApi] Failed to parse selectedModelConfig JSON: ${e}. Using defaults.`,
        )
        modelId = defaultBestModel as string // fallback
      }
    } else {
      // Fallback if no model config provided
      modelId = defaultBestModel as string
      loggerWithChild({ email: email }).info(
        "[AgentMessageApi] No model config provided, using default",
      )
    }

    // Convert friendly model label to actual model value
    let actualModelId: string = modelId || "gemini-2-5-pro"
    if (modelId) {
      // Ensure we always have a string
      const convertedModelId = getModelValueFromLabel(modelId)
      if (convertedModelId) {
        actualModelId = convertedModelId as string // Can be Models enum or string
        loggerWithChild({ email: email }).info(
          `[AgentMessageApi] Converted model label "${modelId}" to value "${actualModelId}"`,
        )
      } else {
        loggerWithChild({ email: email }).warn(
          `[AgentMessageApi] Could not convert model label "${modelId}" to value, will use as-is`,
        )
        actualModelId = modelId // fallback to using the label as-is
      }
    }

    // const agentPrompt = agentId && isCuid(agentId) ? agentId : "";
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId, // This workspaceId is the externalId from JWT
      email,
    )
    const { user, workspace } = userAndWorkspace // workspace.id is the numeric ID

    let agentPromptForLLM: string | undefined = undefined
    let agentForDb: SelectAgent | null = null

    // Handle test current form config case
    if (agentPromptPayload !== undefined) {
      const mockAgentResult = createMockAgentFromFormData(
        agentPromptPayload,
        user,
        workspace,
        email,
      )
      agentForDb = mockAgentResult.agentForDb
      agentPromptForLLM = mockAgentResult.agentPromptForLLM
    } else if (agentId && isCuid(agentId)) {
      // Use the numeric workspace.id for the database query with permission check
      agentForDb = await getAgentByExternalIdWithPermissionCheck(
        db,
        agentId,
        workspace.id,
        user.id,
      )
      if (!agentForDb) {
        throw new HTTPException(403, {
          message: "Access denied: You don't have permission to use this agent",
        })
      }
      agentPromptForLLM = JSON.stringify(agentForDb)
      if (
        config.ragOffFeature &&
        agentForDb.isRagOn === false &&
        !(attachmentMetadata && attachmentMetadata.length > 0)
      ) {
        return AgentMessageApiRagOff(c)
      }
    }
    const agentIdToStore = agentForDb ? agentForDb.externalId : null
    const userRequestsReasoning = isReasoningEnabled
    if (!message) {
      throw new HTTPException(400, {
        message: "Message is required",
      })
    }
    // Truncate table chats,connectors,nessages;
    message = decodeURIComponent(message)
    rootSpan.setAttribute("message", message)
    let ids
    let isValidPath: boolean = false
    if (path) {
      ids = await getRecordBypath(path, db, ownerEmail || "")
      if (ids != null) {
        // Check if the vespaId exists in the agent's app integrations using our validation function
        if (!(await validateVespaIdInAgentIntegrations(agentForDb, ids))) {
          throw new HTTPException(403, {
            message: `Access denied: The path '${path}' is not accessible through this agent's integrations`,
          })
        }
        isValidPath = Boolean(true)
      } else {
        throw new HTTPException(400, {
          message: `The given path:${path} is not a valid path of collection's folder or file`,
        })
      }
    }
    const isMsgWithContext = isMessageWithContext(message)
    const extractedInfo = isMsgWithContext
      ? await extractFileIdsFromMessage(message, email)
      : {
          totalValidFileIdsFromLinkCount: 0,
          fileIds: [],
          collectionFolderIds: [],
        }
    const pathExtractedInfo = isValidPath
      ? await extractItemIdsFromPath(ids ?? "")
      : { collectionFileIds: [], collectionFolderIds: [], collectionIds: [] }
    let fileIds = extractedInfo?.fileIds
    if (nonImageAttachmentFileIds && nonImageAttachmentFileIds.length > 0) {
      fileIds = [...fileIds, ...nonImageAttachmentFileIds]
    }

    const agentDocs = agentForDb?.docIds || []

    //add docIds of agents here itself
    const totalValidFileIdsFromLinkCount =
      extractedInfo?.totalValidFileIdsFromLinkCount

    let messages: SelectMessage[] = []
    const costArr: number[] = []
    const tokenArr: { inputTokens: number; outputTokens: number }[] = []
    const ctx = userContext(userAndWorkspace)
    const userTimezone = user?.timeZone || "Asia/Kolkata"
    const dateForAI = getDateForAI({ userTimeZone: userTimezone })
    const userMetadata: UserMetadataType = { userTimezone, dateForAI }
    let chat: SelectChat

    const chatCreationSpan = rootSpan.startSpan("chat_creation")

    let title = ""
    if (!chatId) {
      let [insertedChat, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage]> => {
          const chat = await insertChat(tx, {
            workspaceId: workspace.id,
            workspaceExternalId: workspace.externalId,
            userId: user.id,
            email: user.email,
            title: "Untitled",
            attachments: [],
            agentId: agentIdToStore as string,
            via_apiKey,
          })

          const insertedMsg = await insertMessage(tx, {
            chatId: chat.id,
            userId: user.id,
            chatExternalId: chat.externalId,
            workspaceExternalId: workspace.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: [],
            message,
            modelId: (modelId as Models) || defaultBestModel,
            fileIds: fileIds,
          })
          // Store attachment metadata for user message if attachments exist
          if (attachmentMetadata && attachmentMetadata.length > 0) {
            try {
              await storeAttachmentMetadata(
                tx,
                insertedMsg.externalId,
                attachmentMetadata,
                email,
              )
            } catch (error) {
              attachmentStorageError = error as Error
              loggerWithChild({ email }).error(
                error,
                `Failed to store attachment metadata for user message ${insertedMsg.externalId}`,
              )
            }
          }
          return [chat, insertedMsg]
        },
      )
      Logger.info(
        "First mesage of the conversation, successfully created the chat",
      )
      chat = insertedChat
      messages.push(insertedMsg) // Add the inserted message to messages array
      chatCreationSpan.end()
    } else {
      let [existingChat, allMessages, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage[], SelectMessage]> => {
          // we are updating the chat and getting it's value in one call itself

          let existingChat = await updateChatByExternalIdWithAuth(
            db,
            chatId,
            email,
            {},
          )
          let allMessages = await getChatMessagesWithAuth(tx, chatId, email)

          let insertedMsg = await insertMessage(tx, {
            chatId: existingChat.id,
            userId: user.id,
            workspaceExternalId: workspace.externalId,
            chatExternalId: existingChat.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: [],
            message,
            modelId: (modelId as Models) || defaultBestModel,
            fileIds,
          })
          // Store attachment metadata for user message if attachments exist
          if (attachmentMetadata && attachmentMetadata.length > 0) {
            try {
              await storeAttachmentMetadata(
                tx,
                insertedMsg.externalId,
                attachmentMetadata,
                email,
              )
            } catch (error) {
              attachmentStorageError = error as Error
              loggerWithChild({ email }).error(
                error,
                `Failed to store attachment metadata for user message ${insertedMsg.externalId}`,
              )
            }
          }
          return [existingChat, allMessages, insertedMsg]
        },
      )
      loggerWithChild({ email: email }).info(
        "Existing conversation, fetched previous messages",
      )
      messages = allMessages.concat(insertedMsg) // Update messages array
      chat = existingChat
      chatCreationSpan.end()
    }
    if (!streamOff) {
      return streamSSE(
        c,
        async (stream) => {
          streamKey = `${chat.externalId}` // Create the stream key
          activeStreams.set(streamKey, { stream }) // Add stream to the map with new structure
          Logger.info(`Added stream ${streamKey} to active streams map.`)
          let wasStreamClosedPrematurely = false
          const streamSpan = rootSpan.startSpan("stream_response")
          streamSpan.setAttribute("chatId", chat.externalId)
          try {
            if (!chatId) {
              const titleUpdateSpan = streamSpan.startSpan("send_title_update")
              await stream.writeSSE({
                data: title,
                event: ChatSSEvents.ChatTitleUpdate,
              })
              titleUpdateSpan.end()
            }

            Logger.info("Chat stream started")
            // we do not set the message Id as we don't have it
            await stream.writeSSE({
              event: ChatSSEvents.ResponseMetadata,
              data: JSON.stringify({
                chatId: chat.externalId,
              }),
            })

            // Send attachment metadata immediately if attachments exist
            if (attachmentMetadata && attachmentMetadata.length > 0) {
              const userMessage = messages[messages.length - 1]
              await stream.writeSSE({
                event: ChatSSEvents.AttachmentUpdate,
                data: JSON.stringify({
                  messageId: userMessage.externalId,
                  attachments: attachmentMetadata,
                }),
              })
            }

            // Notify client if attachment storage failed
            if (attachmentStorageError) {
              await stream.writeSSE({
                event: ChatSSEvents.Error,
                data: JSON.stringify({
                  error: "attachment_storage_failed",
                  message:
                    "Failed to store attachment metadata. Your message was saved but attachments may not be available for future reference.",
                  details: attachmentStorageError.message,
                }),
              })
            }
            // Extract app names from appIntegrations (handles both legacy and new format)
            let agentAppEnums: Apps[] = []
            Logger.info(
              `[Path3] Agent appIntegrations: ${JSON.stringify(
                agentForDb?.appIntegrations,
              )}`,
            )

            if (Array.isArray(agentForDb?.appIntegrations)) {
              // Legacy format: string[] - convert each string to Apps enum
              for (const integration of agentForDb.appIntegrations) {
                if (typeof integration === "string") {
                  const lowerIntegration = integration.toLowerCase()
                  // Map string names to Apps enum (same logic as chat.ts)
                  switch (lowerIntegration) {
                    case Apps.GoogleDrive.toLowerCase():
                    case "googledrive":
                    case "googlesheets":
                      if (!agentAppEnums.includes(Apps.GoogleDrive))
                        agentAppEnums.push(Apps.GoogleDrive)
                      break
                    case Apps.DataSource.toLowerCase():
                      if (!agentAppEnums.includes(Apps.DataSource))
                        agentAppEnums.push(Apps.DataSource)
                      break
                    case Apps.Gmail.toLowerCase():
                    case "gmail":
                      if (!agentAppEnums.includes(Apps.Gmail))
                        agentAppEnums.push(Apps.Gmail)
                      break
                    case Apps.GoogleCalendar.toLowerCase():
                    case "googlecalendar":
                      if (!agentAppEnums.includes(Apps.GoogleCalendar))
                        agentAppEnums.push(Apps.GoogleCalendar)
                      break
                    case Apps.Slack.toLowerCase():
                    case "slack":
                      if (!agentAppEnums.includes(Apps.Slack))
                        agentAppEnums.push(Apps.Slack)
                      break
                  }
                }
              }
            } else if (typeof agentForDb?.appIntegrations === "object") {
              // New format: Record<string, {itemIds, selectedAll}>
              // Parse using parseAppSelections to convert keys to proper Apps enum values
              if (isAppSelectionMap(agentForDb?.appIntegrations)) {
                const { selectedApps } = parseAppSelections(
                  agentForDb.appIntegrations,
                )
                agentAppEnums = [...new Set(selectedApps)]
              } else {
                // Fallback for unexpected format
                agentAppEnums = Object.keys(
                  agentForDb.appIntegrations,
                ) as Apps[]
              }
            }
            //Dual RAG PATH (RAG from both Attachments and app integrations)
            if (
              ((fileIds && fileIds?.length > 0) ||
                (imageAttachmentFileIds &&
                  imageAttachmentFileIds?.length > 0)) &&
              agentForDb?.appIntegrations &&
              agentForDb?.appIntegrations &&
              agentAppEnums.length > 0
            ) {
              // PATH 3: DUAL RAG (NEW!)
              // TODO: there is some repeated code between path 2 and path 3, we can create a helper function for the common parts like File search logic  Context building LLM streaming and iterator processing
              Logger.info(
                `[Path3] User has selected context AND agent has ${agentAppEnums.length} KB integrations, using Dual RAG`,
              )
              let answer = ""
              let citations: Citation[] = []
              let imageCitations: ImageCitation[] = []
              let citationMap: Record<number, number> = {}
              let thinking = ""
              let reasoning =
                userRequestsReasoning &&
                ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning
              const conversationSpan = streamSpan.startSpan(
                "conversation_search",
              )
              conversationSpan.setAttribute("answer", answer)
              conversationSpan.end()

              const ragSpan = streamSpan.startSpan("rag_processing")
              const understandSpan = ragSpan.startSpan("understand_message")

              // 🆕 Call our new Dual RAG function!
              const iterator = generateAnswerFromDualRag(
                message,
                email,
                ctx,
                userMetadata,
                0.5,
                fileIds,
                agentAppEnums,
                userRequestsReasoning,
                agentPromptForLLM,
                understandSpan,
                undefined, // threadIds
                imageAttachmentFileIds,
                undefined, // isMsgWithSources
                actualModelId || config.defaultBestModel,
                isValidPath,
                pathExtractedInfo.collectionFolderIds,
              )

              stream.writeSSE({
                event: ChatSSEvents.Start,
                data: "",
              })

              answer = ""
              thinking = ""
              reasoning = isReasoning && userRequestsReasoning
              citations = []
              imageCitations = []
              citationMap = {}
              let citationValues: Record<number, number> = {}
              let count = 0

              for await (const chunk of iterator) {
                if (stream.closed) {
                  Logger.info(
                    "[AgentMessageApi][Path3] Stream closed during Dual RAG loop. Breaking.",
                  )
                  wasStreamClosedPrematurely = true
                  break
                }
                if (chunk.text) {
                  if (
                    totalValidFileIdsFromLinkCount > maxValidLinks &&
                    count === 0
                  ) {
                    stream.writeSSE({
                      event: ChatSSEvents.ResponseUpdate,
                      data: `Skipping last ${
                        totalValidFileIdsFromLinkCount - maxValidLinks
                      } links as it exceeds max limit of ${maxValidLinks}. `,
                    })
                  }
                  if (reasoning && chunk.reasoning) {
                    thinking += chunk.text
                    stream.writeSSE({
                      event: ChatSSEvents.Reasoning,
                      data: chunk.text,
                    })
                  }
                  if (!chunk.reasoning) {
                    answer += chunk.text
                    stream.writeSSE({
                      event: ChatSSEvents.ResponseUpdate,
                      data: chunk.text,
                    })
                  }
                }
                if (chunk.cost) {
                  costArr.push(chunk.cost)
                }
                if (chunk.metadata?.usage) {
                  tokenArr.push({
                    inputTokens: chunk.metadata.usage.inputTokens,
                    outputTokens: chunk.metadata.usage.outputTokens,
                  })
                }
                if (chunk.citation) {
                  const { index, item } = chunk.citation
                  citations.push(item)
                  citationMap[index] = citations.length - 1
                  Logger.info(
                    `[Path3] Found citations and sending it, current count: ${citations.length}`,
                  )
                  stream.writeSSE({
                    event: ChatSSEvents.CitationsUpdate,
                    data: JSON.stringify({
                      contextChunks: citations,
                      citationMap,
                    }),
                  })
                  citationValues[index] = citations.length - 1
                }
                if (chunk.imageCitation) {
                  loggerWithChild({ email: email }).info(
                    `[Path3] Found image citation (key: ${chunk.imageCitation.citationKey}), sending it`,
                  )
                  imageCitations.push(chunk.imageCitation)
                  stream.writeSSE({
                    event: ChatSSEvents.ImageCitationUpdate,
                    data: JSON.stringify(chunk.imageCitation),
                  })
                }
                count++
              }
              understandSpan.setAttribute("citation_count", citations.length)
              understandSpan.setAttribute(
                "citation_map",
                JSON.stringify(citationMap),
              )
              understandSpan.setAttribute(
                "citation_values",
                JSON.stringify(citationValues),
              )
              understandSpan.end()
              const answerSpan = ragSpan.startSpan("process_final_answer")
              answerSpan.setAttribute(
                "final_answer",
                processMessage(answer, citationMap),
              )
              answerSpan.setAttribute(
                "answer_preview",
                answer.substring(0, 100),
              ) // First 100 chars only
              answerSpan.setAttribute("final_answer_length", answer.length)
              answerSpan.end()
              ragSpan.end()

              if (answer || wasStreamClosedPrematurely) {
                const totalCost = costArr.reduce((sum, cost) => sum + cost, 0)
                const totalTokens = tokenArr.reduce(
                  (sum, tokens) =>
                    sum + tokens.inputTokens + tokens.outputTokens,
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
                  message: processMessage(answer, citationMap),
                  thinking: thinking,
                  modelId:
                    ragPipelineConfig[RagPipelineStages.AnswerOrRewrite]
                      .modelId,
                  cost: totalCost.toString(),
                  tokensUsed: totalTokens,
                })
                assistantMessageId = msg.externalId
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
                Logger.info(
                  `[AgentMessageApi][Path3] Inserted trace for message ${msg.externalId} (premature: ${wasStreamClosedPrematurely}).`,
                )
                await stream.writeSSE({
                  event: ChatSSEvents.ResponseMetadata,
                  data: JSON.stringify({
                    chatId: chat.externalId,
                    messageId: assistantMessageId,
                  }),
                })
              } else {
                const errorSpan = streamSpan.startSpan("handle_no_answer")
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
                await stream.writeSSE({
                  event: ChatSSEvents.Error,
                  data: "Can you please make your query more specific?",
                })
                await addErrMessageToMessage(
                  lastMessage,
                  "Can you please make your query more specific?",
                )

                const traceJson = tracer.serializeToJson()
                await insertChatTrace({
                  workspaceId: workspace.id,
                  userId: user.id,
                  chatId: chat.id,
                  messageId: lastMessage.id,
                  chatExternalId: chat.externalId,
                  email: user.email,
                  messageExternalId: lastMessage.externalId,
                  traceJson,
                })
                errorSpan.end()
              }

              const endSpan = streamSpan.startSpan("send_end_event")
              await stream.writeSSE({
                data: "",
                event: ChatSSEvents.End,
              })
              endSpan.end()
              streamSpan.end()
              rootSpan.end()
            }
            // RAG FROM USER SELECTED CONTEXT ONLY
            else if (
              (fileIds && fileIds?.length > 0) ||
              (imageAttachmentFileIds && imageAttachmentFileIds?.length > 0)
            ) {
              Logger.info(
                "User has selected some context with query, answering only based on that given context",
              )
              let answer = ""
              let citations: Citation[] = []
              let imageCitations: ImageCitation[] = []
              let citationMap: Record<number, number> = {}
              let thinking = ""
              let reasoning =
                userRequestsReasoning &&
                ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning
              const conversationSpan = streamSpan.startSpan(
                "conversation_search",
              )
              conversationSpan.setAttribute("answer", answer)
              conversationSpan.end()

              const ragSpan = streamSpan.startSpan("rag_processing")

              const understandSpan = ragSpan.startSpan("understand_message")

              const iterator = UnderstandMessageAndAnswerForGivenContext(
                email,
                ctx,
                userMetadata,
                message,
                0.5,
                fileIds,
                userRequestsReasoning,
                understandSpan,
                [],
                imageAttachmentFileIds,
                agentPromptForLLM,
                false,
              )
              stream.writeSSE({
                event: ChatSSEvents.Start,
                data: "",
              })

              answer = ""
              thinking = ""
              reasoning = isReasoning && userRequestsReasoning
              citations = []
              imageCitations = []
              citationMap = {}
              let citationValues: Record<number, Citation> = {}
              let count = 0
              for await (const chunk of iterator) {
                if (stream.closed) {
                  Logger.info(
                    "[AgentMessageApi] Stream closed during conversation search loop. Breaking.",
                  )
                  wasStreamClosedPrematurely = true
                  break
                }
                if (chunk.text) {
                  if (
                    totalValidFileIdsFromLinkCount > maxValidLinks &&
                    count === 0
                  ) {
                    stream.writeSSE({
                      event: ChatSSEvents.ResponseUpdate,
                      data: `Skipping last ${
                        totalValidFileIdsFromLinkCount - maxValidLinks
                      } links as it exceeds max limit of ${maxValidLinks}. `,
                    })
                  }
                  if (reasoning && chunk.reasoning) {
                    thinking += chunk.text
                    stream.writeSSE({
                      event: ChatSSEvents.Reasoning,
                      data: chunk.text,
                    })
                  }
                  if (!chunk.reasoning) {
                    answer += chunk.text
                    stream.writeSSE({
                      event: ChatSSEvents.ResponseUpdate,
                      data: chunk.text,
                    })
                  }
                }
                if (chunk.cost) {
                  costArr.push(chunk.cost)
                }
                if (chunk.metadata?.usage) {
                  tokenArr.push({
                    inputTokens: chunk.metadata.usage.inputTokens,
                    outputTokens: chunk.metadata.usage.outputTokens,
                  })
                }
                if (chunk.citation) {
                  const { index, item } = chunk.citation
                  citations.push(item)
                  citationMap[index] = citations.length - 1
                  Logger.info(
                    `Found citations and sending it, current count: ${citations.length}`,
                  )
                  stream.writeSSE({
                    event: ChatSSEvents.CitationsUpdate,
                    data: JSON.stringify({
                      contextChunks: citations,
                      citationMap,
                    }),
                  })
                  citationValues[index] = item
                }
                if (chunk.imageCitation) {
                  loggerWithChild({ email: email }).info(
                    `Found image citation, sending it`,
                    { citationKey: chunk.imageCitation.citationKey },
                  )
                  imageCitations.push(chunk.imageCitation)
                  stream.writeSSE({
                    event: ChatSSEvents.ImageCitationUpdate,
                    data: JSON.stringify(chunk.imageCitation),
                  })
                }
                count++
              }
              understandSpan.setAttribute("citation_count", citations.length)
              understandSpan.setAttribute(
                "citation_map",
                JSON.stringify(citationMap),
              )
              understandSpan.setAttribute(
                "citation_values",
                JSON.stringify(citationValues),
              )
              understandSpan.end()
              const answerSpan = ragSpan.startSpan("process_final_answer")
              answerSpan.setAttribute(
                "final_answer",
                processMessage(answer, citationMap),
              )
              answerSpan.setAttribute("actual_answer", answer)
              answerSpan.setAttribute("final_answer_length", answer.length)
              answerSpan.end()
              ragSpan.end()

              if (answer || wasStreamClosedPrematurely) {
                // TODO: incase user loses permission
                // to one of the citations what do we do?
                // somehow hide that citation and change
                // the answer to reflect that

                // Calculate total cost and tokens
                const totalCost = costArr.reduce((sum, cost) => sum + cost, 0)
                const totalTokens = tokenArr.reduce(
                  (sum, tokens) =>
                    sum + tokens.inputTokens + tokens.outputTokens,
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
                  message: processMessage(answer, citationMap),
                  thinking: thinking,
                  modelId:
                    ragPipelineConfig[RagPipelineStages.AnswerOrRewrite]
                      .modelId,
                  cost: totalCost.toString(),
                  tokensUsed: totalTokens,
                })
                assistantMessageId = msg.externalId
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
                Logger.info(
                  `[AgentMessageApi] Inserted trace for message ${msg.externalId} (premature: ${wasStreamClosedPrematurely}).`,
                )
                await stream.writeSSE({
                  event: ChatSSEvents.ResponseMetadata,
                  data: JSON.stringify({
                    chatId: chat.externalId,
                    messageId: assistantMessageId,
                  }),
                })
              } else {
                const errorSpan = streamSpan.startSpan("handle_no_answer")
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
                await stream.writeSSE({
                  event: ChatSSEvents.Error,
                  data: "Can you please make your query more specific?",
                })
                await addErrMessageToMessage(
                  lastMessage,
                  "Can you please make your query more specific?",
                )

                const traceJson = tracer.serializeToJson()
                await insertChatTrace({
                  workspaceId: workspace.id,
                  userId: user.id,
                  chatId: chat.id,
                  messageId: lastMessage.id,
                  chatExternalId: chat.externalId,
                  email: user.email,
                  messageExternalId: lastMessage.externalId,
                  traceJson,
                })
                errorSpan.end()
              }

              const endSpan = streamSpan.startSpan("send_end_event")
              await stream.writeSSE({
                data: "",
                event: ChatSSEvents.End,
              })
              endSpan.end()
              streamSpan.end()
              rootSpan.end()
            } else {
              const messagesWithNoErrResponse = messages
                .slice(0, messages.length - 1)
                .filter((msg) => !msg?.errorMessage)
                .filter(
                  (msg) =>
                    !(
                      msg.messageRole === MessageRole.Assistant && !msg.message
                    ),
                ) // filter out assistant messages with no content
                .map((msg) => {
                  // If any message from the messagesWithNoErrResponse is a user message, has fileIds and its message is JSON parsable
                  // then we should not give that exact stringified message as history
                  // We convert it into a AI friendly string only for giving it to LLM
                  const fileIds = JSON.parse(JSON.stringify(msg?.fileIds || []))
                  if (
                    msg.messageRole === "user" &&
                    fileIds &&
                    fileIds.length > 0
                  ) {
                    const originalMsg = msg.message
                    const selectedContext = isContextSelected(originalMsg)
                    msg.message = selectedContext
                      ? buildUserQuery(selectedContext)
                      : originalMsg
                  }
                  return {
                    role: msg.messageRole as ConversationRole,
                    content: [{ text: msg.message }],
                  }
                })

              Logger.info(
                "Checking if answer is in the conversation or a mandatory query rewrite is needed before RAG",
              )
              // Limit messages to last 5 for the first LLM call if it's a new chat
              const limitedMessages = messagesWithNoErrResponse.slice(-8)

              // Extract previous classification for pagination and follow-up queries
              let previousClassification: QueryRouterLLMResponse | null = null
              if (messages.length >= 2) {
                const previousUserMessage = messages[messages.length - 2]
                if (
                  previousUserMessage?.queryRouterClassification &&
                  previousUserMessage.messageRole === "user"
                ) {
                  try {
                    const parsedClassification =
                      typeof previousUserMessage.queryRouterClassification ===
                      "string"
                        ? JSON.parse(
                            previousUserMessage.queryRouterClassification,
                          )
                        : previousUserMessage.queryRouterClassification
                    previousClassification =
                      parsedClassification as QueryRouterLLMResponse
                    Logger.info(
                      `Found previous classification in agents: ${JSON.stringify(previousClassification)}`,
                    )
                  } catch (error) {
                    Logger.error(
                      `Error parsing previous classification in agents: ${error}`,
                    )
                  }
                }
              }
              const agentWithNoIntegrations =
                checkAgentWithNoIntegrations(agentForDb)
              let searchOrAnswerIterator

              if (agentWithNoIntegrations) {
                loggerWithChild({ email: email }).info(
                  "Using agent with no integrations for the question",
                )

                searchOrAnswerIterator = agentWithNoIntegrationsQuestion(
                  message,
                  ctx,
                  {
                    modelId:
                      ragPipelineConfig[RagPipelineStages.AnswerOrSearch]
                        .modelId,
                    stream: true,
                    json: false,
                    agentPrompt: agentPromptForLLM,
                    reasoning:
                      userRequestsReasoning &&
                      ragPipelineConfig[RagPipelineStages.AnswerOrSearch]
                        .reasoning,
                    messages: limitedMessages,
                    agentWithNoIntegrations: true,
                  },
                )
              } else {
                searchOrAnswerIterator =
                  generateSearchQueryOrAnswerFromConversation(
                    message,
                    ctx,
                    userMetadata,
                    {
                      modelId:
                        ragPipelineConfig[RagPipelineStages.AnswerOrSearch]
                          .modelId,
                      stream: true,
                      json: true,
                      reasoning:
                        userRequestsReasoning &&
                        ragPipelineConfig[RagPipelineStages.AnswerOrSearch]
                          .reasoning,
                      messages: limitedMessages,
                      agentPrompt: agentPromptForLLM,
                    },
                    undefined,
                    previousClassification,
                  )
              }

              // TODO: for now if the answer is from the conversation itself we don't
              // add any citations for it, we can refer to the original message for citations
              // one more bug is now llm automatically copies the citation text sometimes without any reference
              // leads to [NaN] in the answer
              let currentAnswer = ""
              let answer = ""
              let citations: Citation[] = []
              let imageCitations: ImageCitation[] = []
              let citationMap: Record<number, number> = {}
              let queryFilters = {
                apps: [],
                entities: [],
                startTime: "",
                endTime: "",
                count: 0,
                sortDirection: "",
                mailParticipants: {},
                offset: 0,
              }
              let parsed = {
                isFollowUp: false,
                answer: "",
                queryRewrite: "",
                temporalDirection: null,
                filter_query: "",
                type: "",
                mailParticipants: {},
                filters: queryFilters,
              }

              let thinking = ""
              let reasoning =
                userRequestsReasoning &&
                ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning
              let buffer = ""
              const conversationSpan = streamSpan.startSpan(
                "conversation_search",
              )

              if (agentWithNoIntegrations) {
                loggerWithChild({ email: email }).info(
                  "Processing agent with no integrations response",
                )

                stream.writeSSE({
                  event: ChatSSEvents.Start,
                  data: "",
                })

                for await (const chunk of searchOrAnswerIterator) {
                  if (stream.closed) {
                    Logger.info(
                      "[AgentMessageApi] Stream closed during agent no integrations loop. Breaking.",
                    )
                    wasStreamClosedPrematurely = true
                    break
                  }

                  if (chunk.text) {
                    answer += chunk.text
                    stream.writeSSE({
                      event: ChatSSEvents.ResponseUpdate,
                      data: chunk.text,
                    })
                  }

                  if (chunk.cost) {
                    costArr.push(chunk.cost)
                  }
                  if (chunk.metadata?.usage) {
                    tokenArr.push({
                      inputTokens: chunk.metadata.usage.inputTokens || 0,
                      outputTokens: chunk.metadata.usage.outputTokens || 0,
                    })
                  }
                }

                parsed.answer = answer
              } else {
                for await (const chunk of searchOrAnswerIterator) {
                  if (stream.closed) {
                    Logger.info(
                      "[AgentMessageApi] Stream closed during conversation search loop. Breaking.",
                    )
                    wasStreamClosedPrematurely = true
                    break
                  }
                  if (chunk.text) {
                    if (reasoning) {
                      if (thinking && !chunk.text.includes(EndThinkingToken)) {
                        thinking += chunk.text
                        stream.writeSSE({
                          event: ChatSSEvents.Reasoning,
                          data: chunk.text,
                        })
                      } else {
                        // first time
                        if (!chunk.text.includes(StartThinkingToken)) {
                          let token = chunk.text
                          if (chunk.text.includes(EndThinkingToken)) {
                            token = chunk.text.split(EndThinkingToken)[0]
                            thinking += token
                          } else {
                            thinking += token
                          }
                          stream.writeSSE({
                            event: ChatSSEvents.Reasoning,
                            data: token,
                          })
                        }
                      }
                    }
                    if (reasoning && chunk.text.includes(EndThinkingToken)) {
                      reasoning = false
                      chunk.text = chunk.text.split(EndThinkingToken)[1].trim()
                    }
                    if (!reasoning) {
                      buffer += chunk.text
                      try {
                        parsed = jsonParseLLMOutput(buffer) || {}
                        if (parsed.answer && currentAnswer !== parsed.answer) {
                          if (currentAnswer === "") {
                            Logger.info(
                              "We were able to find the answer/respond to users query in the conversation itself so not applying RAG",
                            )
                            stream.writeSSE({
                              event: ChatSSEvents.Start,
                              data: "",
                            })
                            // First valid answer - send the whole thing
                            stream.writeSSE({
                              event: ChatSSEvents.ResponseUpdate,
                              data: parsed.answer,
                            })
                          } else {
                            // Subsequent chunks - send only the new part
                            const newText = parsed.answer.slice(
                              currentAnswer.length,
                            )
                            stream.writeSSE({
                              event: ChatSSEvents.ResponseUpdate,
                              data: newText,
                            })
                          }
                          currentAnswer = parsed.answer
                        }
                      } catch (err) {
                        const errMessage = (err as Error).message
                        Logger.error(
                          err,
                          `Error while parsing LLM output ${errMessage}`,
                        )
                        continue
                      }
                    }
                  }
                  if (chunk.cost) {
                    costArr.push(chunk.cost)
                  }
                  if (chunk.metadata?.usage) {
                    tokenArr.push({
                      inputTokens: chunk.metadata.usage.inputTokens,
                      outputTokens: chunk.metadata.usage.outputTokens,
                    })
                  }
                }
              }

              conversationSpan.setAttribute("answer_found", parsed.answer)
              conversationSpan.setAttribute("answer", answer)
              conversationSpan.setAttribute(
                "query_rewrite",
                parsed.queryRewrite,
              )
              conversationSpan.end()
              let classification: TemporalClassifier & QueryRouterResponse = {
                direction: parsed.temporalDirection,
                type: parsed.type as QueryType,
                filterQuery: parsed.filter_query,
                isFollowUp: parsed.isFollowUp,
                filters: {
                  ...(parsed?.filters ?? {}),
                  apps: parsed.filters?.apps || [],
                  entities: parsed.filters?.entities as any,
                  mailParticipants: parsed.mailParticipants || {},
                },
              }

              if (parsed.answer === null || parsed.answer === "") {
                const ragSpan = streamSpan.startSpan("rag_processing")
                if (parsed.queryRewrite) {
                  Logger.info(
                    `The query is ambigious and requires a mandatory query rewrite from the existing conversation / recent messages ${parsed.queryRewrite}`,
                  )
                  message = parsed.queryRewrite
                  Logger.info(`Rewritten query: ${message}`)
                  ragSpan.setAttribute("query_rewrite", parsed.queryRewrite)
                } else {
                  Logger.info(
                    "There was no need for a query rewrite and there was no answer in the conversation, applying RAG",
                  )
                }
                const classification: TemporalClassifier & QueryRouterResponse =
                  {
                    direction: parsed.temporalDirection,
                    type: parsed.type as QueryType,
                    filterQuery: parsed.filter_query,
                    filters: {
                      ...(parsed?.filters ?? {}),
                      apps: parsed.filters?.apps || [],
                      entities: parsed.filters?.entities as any,
                      mailParticipants: parsed.mailParticipants || {},
                    },
                  }

                loggerWithChild({ email: email }).info(
                  `Classifying the query as:, ${JSON.stringify(classification)}`,
                )

                ragSpan.setAttribute(
                  "isFollowUp",
                  classification.isFollowUp ?? false,
                )
                const understandSpan = ragSpan.startSpan("understand_message")

                let iterator:
                  | AsyncIterableIterator<
                      ConverseResponse & {
                        citation?: { index: number; item: any }
                        imageCitation?: ImageCitation
                      }
                    >
                  | undefined = undefined

                if (messages.length < 2) {
                  classification.isFollowUp = false // First message or not enough history to be a follow-up
                } else if (classification.isFollowUp) {
                  // Use the NEW classification that already contains:
                  // - Updated filters (with proper offset calculation)
                  // - Preserved app/entity from previous query
                  // - Updated count/pagination info
                  // - All the smart follow-up logic from the LLM

                  const filteredMessages = messages
                    .filter((msg) => !msg?.errorMessage)
                    .filter(
                      (msg) =>
                        !(
                          msg.messageRole === MessageRole.Assistant &&
                          !msg.message
                        ),
                    )

                  // Check for follow-up context carry-forward
                  const workingSet = collectFollowupContext(filteredMessages)

                  const hasCarriedContext =
                    workingSet.fileIds.length > 0 ||
                    workingSet.attachmentFileIds.length > 0
                  if (hasCarriedContext) {
                    fileIds = workingSet.fileIds
                    imageAttachmentFileIds = workingSet.attachmentFileIds
                    loggerWithChild({ email: email }).info(
                      `Carried forward context from follow-up: ${JSON.stringify(workingSet)}`,
                    )
                  }

                  if (
                    (fileIds && fileIds.length > 0) ||
                    (imageAttachmentFileIds &&
                      imageAttachmentFileIds.length > 0)
                  ) {
                    loggerWithChild({ email: email }).info(
                      `Follow-up query with file context detected. Using file-based context with NEW classification: ${JSON.stringify(classification)}, FileIds: ${JSON.stringify([fileIds, imageAttachmentFileIds])}`,
                    )
                    iterator = UnderstandMessageAndAnswerForGivenContext(
                      email,
                      ctx,
                      userMetadata,
                      message,
                      0.5,
                      fileIds as string[],
                      userRequestsReasoning,
                      understandSpan,
                      undefined,
                      imageAttachmentFileIds as string[],
                      agentPromptForLLM,
                      fileIds.some((fileId) => fileId.startsWith("clf-")),
                      actualModelId || config.defaultBestModel,
                    )
                  } else {
                    loggerWithChild({ email: email }).info(
                      `Follow-up query detected.`,
                    )
                    // Use the new classification directly - it already has all the smart follow-up logic
                    // No need to reuse old classification, the LLM has generated an updated one
                  }
                }

                // If no iterator was set above (non-file-context scenario), use the regular flow with the new classification
                if (!iterator) {
                  iterator = UnderstandMessageAndAnswer(
                    email,
                    ctx,
                    userMetadata,
                    message,
                    classification,
                    limitedMessages,
                    0.5,
                    userRequestsReasoning,
                    understandSpan,
                    agentPromptForLLM,
                    actualModelId,
                    pathExtractedInfo,
                  )
                }
                stream.writeSSE({
                  event: ChatSSEvents.Start,
                  data: "",
                })

                answer = ""
                thinking = ""
                reasoning = isReasoning && userRequestsReasoning
                citations = []
                citationMap = {}
                let citationValues: Record<number, Citation> = {}
                for await (const chunk of iterator) {
                  if (stream.closed) {
                    Logger.info(
                      "[MessageApi] Stream closed during conversation search loop. Breaking.",
                    )
                    wasStreamClosedPrematurely = true
                    break
                  }
                  if (chunk.text) {
                    if (reasoning && chunk.reasoning) {
                      thinking += chunk.text
                      stream.writeSSE({
                        event: ChatSSEvents.Reasoning,
                        data: chunk.text,
                      })
                      // reasoningSpan.end()
                    }
                    if (!chunk.reasoning) {
                      answer += chunk.text
                      stream.writeSSE({
                        event: ChatSSEvents.ResponseUpdate,
                        data: chunk.text,
                      })
                    }
                  }
                  if (chunk.cost) {
                    costArr.push(chunk.cost)
                  }
                  if (chunk.metadata?.usage) {
                    tokenArr.push({
                      inputTokens: chunk.metadata.usage.inputTokens,
                      outputTokens: chunk.metadata.usage.outputTokens,
                    })
                  }
                  if (chunk.citation) {
                    const { index, item } = chunk.citation
                    citations.push(item)
                    citationMap[index] = citations.length - 1
                    Logger.info(
                      `Found citations and sending it, current count: ${citations.length}`,
                    )
                    stream.writeSSE({
                      event: ChatSSEvents.CitationsUpdate,
                      data: JSON.stringify({
                        contextChunks: citations,
                        citationMap,
                      }),
                    })
                    citationValues[index] = item
                  }
                  if (chunk.imageCitation) {
                    loggerWithChild({ email: email }).info(
                      `Found image citation, sending it`,
                      { citationKey: chunk.imageCitation.citationKey },
                    )
                    imageCitations.push(chunk.imageCitation)
                    stream.writeSSE({
                      event: ChatSSEvents.ImageCitationUpdate,
                      data: JSON.stringify(chunk.imageCitation),
                    })
                  }
                }
                understandSpan.setAttribute("citation_count", citations.length)
                understandSpan.setAttribute(
                  "citation_map",
                  JSON.stringify(citationMap),
                )
                understandSpan.setAttribute(
                  "citation_values",
                  JSON.stringify(citationValues),
                )
                understandSpan.end()
                const answerSpan = ragSpan.startSpan("process_final_answer")
                answerSpan.setAttribute(
                  "final_answer",
                  processMessage(answer, citationMap),
                )
                answerSpan.setAttribute("actual_answer", answer)
                answerSpan.setAttribute("final_answer_length", answer.length)
                answerSpan.end()
                ragSpan.end()
              } else if (parsed.answer) {
                answer = parsed.answer
              }

              if (answer || wasStreamClosedPrematurely) {
                // Determine if a message (even partial) should be saved
                // TODO: incase user loses permission
                // to one of the citations what do we do?
                // somehow hide that citation and change
                // the answer to reflect that

                // Calculate total cost and tokens
                const totalCost = costArr.reduce((sum, cost) => sum + cost, 0)
                const totalTokens = tokenArr.reduce(
                  (sum, tokens) =>
                    sum + tokens.inputTokens + tokens.outputTokens,
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
                  message: processMessage(answer, citationMap),
                  thinking: thinking,
                  modelId:
                    ragPipelineConfig[RagPipelineStages.AnswerOrRewrite]
                      .modelId,
                  cost: totalCost.toString(),
                  tokensUsed: totalTokens,
                })
                assistantMessageId = msg.externalId

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
                Logger.info(
                  `[AgentMessageApi] Inserted trace for message ${msg.externalId} (premature: ${wasStreamClosedPrematurely}).`,
                )

                await stream.writeSSE({
                  event: ChatSSEvents.ResponseMetadata,
                  data: JSON.stringify({
                    chatId: chat.externalId,
                    messageId: assistantMessageId,
                  }),
                })
              } else {
                const errorSpan = streamSpan.startSpan("handle_no_answer")
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
                await stream.writeSSE({
                  event: ChatSSEvents.Error,
                  data: "Oops, something went wrong. Please try rephrasing your question or ask something else.",
                })
                await addErrMessageToMessage(
                  lastMessage,
                  "Oops, something went wrong. Please try rephrasing your question or ask something else.",
                )

                const traceJson = tracer.serializeToJson()
                await insertChatTrace({
                  workspaceId: workspace.id,
                  userId: user.id,
                  chatId: chat.id,
                  messageId: lastMessage.id,
                  chatExternalId: chat.externalId,
                  email: user.email,
                  messageExternalId: lastMessage.externalId,
                  traceJson,
                })
                errorSpan.end()
              }

              const endSpan = streamSpan.startSpan("send_end_event")
              await stream.writeSSE({
                data: "",
                event: ChatSSEvents.End,
              })
              endSpan.end()
              streamSpan.end()
              rootSpan.end()
            }
          } catch (error) {
            const streamErrorSpan = streamSpan.startSpan("handle_stream_error")
            streamErrorSpan.addEvent("error", {
              message: getErrorMessage(error),
              stack: (error as Error).stack || "",
            })
            const errFomMap = handleError(error)
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
            await stream.writeSSE({
              event: ChatSSEvents.Error,
              data: errFomMap,
            })

            // Add the error message to last user message
            await addErrMessageToMessage(lastMessage, errFomMap)

            await stream.writeSSE({
              data: "",
              event: ChatSSEvents.End,
            })
            Logger.error(
              error,
              `Streaming Error: ${(error as Error).message} ${
                (error as Error).stack
              }`,
            )
            streamErrorSpan.end()
            streamSpan.end()
            rootSpan.end()
          } finally {
            // Ensure stream is removed from the map on completion or error
            if (streamKey && activeStreams.has(streamKey)) {
              activeStreams.delete(streamKey)
              Logger.info(
                `Removed stream ${streamKey} from active streams map.`,
              )
            }
          }
        },
        async (err, stream) => {
          const streamErrorSpan = rootSpan.startSpan(
            "handle_stream_callback_error",
          )
          streamErrorSpan.addEvent("error", {
            message: getErrorMessage(err),
            stack: (err as Error).stack || "",
          })
          const errFromMap = handleError(err)
          // Use the stored assistant message ID if available when handling callback error
          const allMessages = await getChatMessagesWithAuth(
            db,
            chat?.externalId,
            email,
          )
          const lastMessage = allMessages[allMessages.length - 1]
          const errorMsgId = assistantMessageId || lastMessage.externalId
          const errorChatId = chat?.externalId || "unknown"

          if (errorChatId !== "unknown" && errorMsgId !== "unknown") {
            await stream.writeSSE({
              event: ChatSSEvents.ResponseMetadata,
              data: JSON.stringify({
                chatId: errorChatId,
                messageId: errorMsgId,
              }),
            })
            // Try to get the last message again for error reporting
            const allMessages = await getChatMessagesWithAuth(
              db,
              errorChatId,
              email,
            )
            if (allMessages.length > 0) {
              const lastMessage = allMessages[allMessages.length - 1]
              await addErrMessageToMessage(lastMessage, errFromMap)
            }
          }
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: errFromMap,
          })
          await addErrMessageToMessage(lastMessage, errFromMap)

          await stream.writeSSE({
            data: "",
            event: ChatSSEvents.End,
          })
          Logger.error(
            err,
            `Streaming Error: ${err.message} ${(err as Error).stack}`,
          )
          // Ensure stream is removed from the map in the error callback too
          if (streamKey && activeStreams.has(streamKey)) {
            activeStreams.delete(streamKey)
            Logger.info(
              `Removed stream ${streamKey} from active streams map in error callback.`,
            )
          }
          streamErrorSpan.end()
          rootSpan.end()
        },
      )
    } else {
      // --- NON-STREAMING: buffer internal streams, return one JSON response ---
      let wasStreamClosedPrematurely = false // kept for parity with metrics
      const streamSpan = rootSpan.startSpan("nonstream_response")
      streamSpan.setAttribute("chatId", chat.externalId)

      try {
        const messagesWithNoErrResponse = messages
          .slice(0, messages.length - 1)
          .filter((msg) => !msg?.errorMessage)
          .filter(
            (msg) =>
              !(msg.messageRole === MessageRole.Assistant && !msg.message),
          )
          .map((msg) => {
            const fileIds = JSON.parse(JSON.stringify(msg?.fileIds || []))
            if (msg.messageRole === "user" && fileIds && fileIds.length > 0) {
              const originalMsg = msg.message
              const selectedContext = isContextSelected(originalMsg)
              msg.message = selectedContext
                ? buildUserQuery(selectedContext)
                : originalMsg
            }
            return {
              role: msg.messageRole as ConversationRole,
              content: [{ text: msg.message }],
            }
          })

        const limitedMessages = messagesWithNoErrResponse.slice(-8)

        // Extract previous classification for pagination and follow-up queries
        let previousClassification: QueryRouterLLMResponse | null = null
        if (messages.length >= 2) {
          const previousUserMessage = messages[messages.length - 2]
          if (
            previousUserMessage?.queryRouterClassification &&
            previousUserMessage.messageRole === "user"
          ) {
            try {
              const parsedClassification =
                typeof previousUserMessage.queryRouterClassification ===
                "string"
                  ? JSON.parse(previousUserMessage.queryRouterClassification)
                  : previousUserMessage.queryRouterClassification
              previousClassification =
                parsedClassification as QueryRouterLLMResponse
              Logger.info(
                `Found previous classification in agents: ${JSON.stringify(previousClassification)}`,
              )
            } catch (error) {
              Logger.error(
                `Error parsing previous classification in agents: ${error}`,
              )
            }
          }
        }

        // Helper to persist and return JSON in one place
        const finalizeAndRespond = async (params: {
          answer: string
          thinking: string
          citations: Citation[]
          imageCitations: ImageCitation[]
          citationMap: Record<number, number>
          costArr: number[]
          tokenArr: { inputTokens: number; outputTokens: number }[]
        }) => {
          const processed = processMessage(params.answer, params.citationMap)

          const totalCost = params.costArr.reduce((s, c) => s + c, 0)
          const totalTokens = params.tokenArr.reduce(
            (s, t) => s + t.inputTokens + t.outputTokens,
            0,
          )

          const msg = await insertMessage(db, {
            chatId: chat.id,
            userId: user.id,
            workspaceExternalId: workspace.externalId,
            chatExternalId: chat.externalId,
            messageRole: MessageRole.Assistant,
            email: user.email,
            sources: params.citations,
            imageCitations: params.imageCitations,
            message: processed,
            thinking: params.thinking,
            modelId:
              (actualModelId as Models) ||
              ragPipelineConfig[RagPipelineStages.AnswerOrRewrite].modelId,
            cost: totalCost.toString(),
            tokensUsed: totalTokens,
          })
          assistantMessageId = msg.externalId

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

          streamSpan.end()
          rootSpan.end()

          return c.json({
            chatId: chat.externalId,
            messageId: assistantMessageId,
            answer: processed,
            citations: params.citations,
            imageCitations: params.imageCitations,
            // thinking,
          })
        }

        // Path A: user provided explicit context (fileIds / attachments)
        if (
          (fileIds && fileIds.length > 0) ||
          (imageAttachmentFileIds && imageAttachmentFileIds.length > 0)
        ) {
          const ragSpan = streamSpan.startSpan("rag_processing")
          const understandSpan = ragSpan.startSpan("understand_message")

          const iterator = UnderstandMessageAndAnswerForGivenContext(
            email,
            ctx,
            userMetadata,
            message,
            0.5,
            fileIds,
            userRequestsReasoning,
            understandSpan,
            [],
            imageAttachmentFileIds,
            agentPromptForLLM,
          )

          // Collect internal stream
          const {
            answer,
            thinking,
            citations,
            imageCitations,
            citationMap,
            costArr,
            tokenArr,
          } = await collectIterator(iterator)

          understandSpan.end()
          ragSpan.end()

          if (answer || wasStreamClosedPrematurely) {
            return await finalizeAndRespond({
              answer,
              thinking,
              citations,
              imageCitations,
              citationMap,
              costArr,
              tokenArr,
            })
          } else {
            const allMessages = await getChatMessagesWithAuth(
              db,
              chat?.externalId,
              email,
            )
            const lastMessage = allMessages[allMessages.length - 1]
            const msg = "Can you please make your query more specific?"
            await addErrMessageToMessage(lastMessage, msg)
            streamSpan.end()
            rootSpan.end()
            return c.json(
              {
                chatId: chat.externalId,
                messageId: lastMessage.externalId,
                error: msg,
              },
              400,
            )
          }
        }
      } catch (error) {
        const streamErrorSpan = streamSpan.startSpan("handle_nonstream_error")
        streamErrorSpan.addEvent("error", {
          message: getErrorMessage(error),
          stack: (error as Error).stack || "",
        })

        const errFromMap = handleError(error)
        if (chat?.externalId) {
          const allMessages = await getChatMessagesWithAuth(
            db,
            chat?.externalId,
            email,
          )
          const lastMessage = allMessages[allMessages.length - 1]
          await addErrMessageToMessage(lastMessage, errFromMap)
          streamErrorSpan.end()
          streamSpan.end()
          rootSpan.end()
          return c.json(
            {
              chatId: chat.externalId,
              messageId: lastMessage.externalId,
              error: errFromMap,
            },
            500,
          )
        }
        streamErrorSpan.end()
        streamSpan.end()
        rootSpan.end()
        return c.json({ error: errFromMap }, 500)
      }
    }
  } catch (error) {
    const errorSpan = rootSpan.startSpan("handle_top_level_error")
    errorSpan.addEvent("error", {
      message: getErrorMessage(error),
      stack: (error as Error).stack || "",
    })
    const errMsg = getErrorMessage(error)
    // TODO: add more errors like bedrock, this is only openai
    const errFromMap = handleError(error)
    // @ts-ignore
    if (chat?.externalId) {
      const allMessages = await getChatMessagesWithAuth(
        db,
        chat?.externalId,
        email,
      )
      // Add the error message to last user message
      if (allMessages.length > 0) {
        const lastMessage = allMessages[allMessages.length - 1]
        // Use the stored assistant message ID if available for metadata
        const errorMsgId = assistantMessageId || lastMessage.externalId
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({
            chatId: chat.externalId,
            messageId: errorMsgId,
          }),
        })
        await addErrMessageToMessage(lastMessage, errFromMap)
      }
    }
    if (error instanceof APIError) {
      // quota error
      if (error.status === 429) {
        Logger.error(error, "You exceeded your current quota")
        if (stream) {
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: errFromMap,
          })
        }
      }
    } else {
      Logger.error(error, `Message Error: ${errMsg} ${(error as Error).stack}`)
      throw new HTTPException(500, {
        message: "Could not create message or Chat",
      })
    }
    // Ensure stream is removed from the map in the top-level catch block
    if (streamKey && activeStreams.has(streamKey)) {
      activeStreams.delete(streamKey)
      Logger.info(
        `Removed stream ${streamKey} from active streams map in top-level catch.`,
      )
    }
    errorSpan.end()
    rootSpan.end()
  }
}

// Collects an internal streaming iterator into one object.
async function collectIterator<
  TChunk extends {
    text?: string
    reasoning?: boolean
    cost?: number
    metadata?: { usage?: { inputTokens: number; outputTokens: number } }
    citation?: { index: number; item: Citation }
    imageCitation?: ImageCitation
  },
>(iterator: AsyncIterable<TChunk>, opts?: { maxBytes?: number }) {
  let answer = ""
  let thinking = ""
  let citations: Citation[] = []
  let imageCitations: ImageCitation[] = []
  let citationMap: Record<number, number> = {}
  let costArr: number[] = []
  let tokenArr: { inputTokens: number; outputTokens: number }[] = []
  let size = 0

  for await (const chunk of iterator) {
    if (chunk.text) {
      if (chunk.reasoning) {
        thinking += chunk.text
      } else {
        answer += chunk.text
      }
    }
    if (chunk.cost) costArr.push(chunk.cost)
    if (chunk.metadata?.usage) {
      tokenArr.push({
        inputTokens: chunk.metadata.usage.inputTokens,
        outputTokens: chunk.metadata.usage.outputTokens,
      })
    }
    if (chunk.citation) {
      const { index, item } = chunk.citation
      citations.push(item)
      citationMap[index] = citations.length - 1
    }
    if (chunk.imageCitation) {
      imageCitations.push(chunk.imageCitation)
    }
  }

  return {
    answer,
    thinking,
    citations,
    imageCitations,
    citationMap,
    costArr,
    tokenArr,
  }
}

// HITL: API Endpoint to provide clarification response
export const ProvideClarificationApi = async (c: Context) => {
  const { email } = getAuth(c)

  try {
    // @ts-ignore - Assuming validation middleware handles this
    const { chatId, clarificationId, selectedOption } = c.req.valid("json")
    loggerWithChild({ email }).info(
      `[ProvideClarificationApi] Received clarification: chatId=${chatId}, clarificationId=${clarificationId}, selectedOption=${JSON.stringify(selectedOption)}`,
    )

    if (!chatId || !clarificationId || !selectedOption) {
      throw new HTTPException(400, {
        message: "chatId, clarificationId, and selectedOption are required.",
      })
    }

    const streamKey = chatId
    const activeStream = activeStreams.get(streamKey)

    if (!activeStream) {
      throw new HTTPException(404, {
        message: "No active stream found for this chat.",
      })
    }

    if (!activeStream.waitingForClarification) {
      throw new HTTPException(400, {
        message: "This chat is not waiting for clarification.",
      })
    }

    if (activeStream.clarificationCallback) {
      // Call the callback to resume JAF execution
      activeStream.clarificationCallback(clarificationId, selectedOption)

      // Clear the waiting state
      activeStream.waitingForClarification = false
      activeStream.clarificationCallback = undefined

      return c.json({ success: true })
    } else {
      throw new HTTPException(500, {
        message: "Internal error: No clarification callback found.",
      })
    }
  } catch (error) {
    const errMsg = getErrorMessage(error)
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, {
      message: "Could not process clarification.",
    })
  }
}
