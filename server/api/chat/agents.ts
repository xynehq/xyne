import {
  answerContextMap,
  answerContextMapFromFragments,
  cleanContext,
  constructToolContext,
  userContext,
} from "@/ai/context"
import {
  generateAgentStepSummaryPromptJson,
  generateConsolidatedStepSummaryPromptJson,
} from "@/ai/agentPrompts"
import {
  // baselineRAGIterationJsonStream,
  baselineRAGJsonStream,
  generateSearchQueryOrAnswerFromConversation,
  generateTitleUsingQuery,
  jsonParseLLMOutput,
  mailPromptJsonStream,
  temporalPromptJsonStream,
  queryRewriter,
  generateAnswerBasedOnToolOutput,
  meetingPromptJsonStream,
  generateToolSelectionOutput,
  generateSynthesisBasedOnToolOutput,
  baselineRAGOffJsonStream,
} from "@/ai/provider"
import {
  getConnectorByExternalId,
  getConnectorByApp,
  getConnectorById,
} from "@/db/connector"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import {
  Models,
  QueryType,
  type ConverseResponse,
  type QueryRouterLLMResponse,
  type QueryRouterResponse,
  type TemporalClassifier,
  type UserQuery,
} from "@/ai/types"
import {
  deleteMessagesByChatId,
  getChatByExternalId,
  getPublicChats,
  insertChat,
  updateChatByExternalIdWithAuth,
  updateMessageByExternalId,
} from "@/db/chat"
import { db } from "@/db/client"
import {
  insertMessage,
  getMessageByExternalId,
  getChatMessagesBefore,
  updateMessage,
  getChatMessagesWithAuth,
} from "@/db/message"
import { getToolsByConnectorId, syncConnectorTools } from "@/db/tool"
import {
  selectPublicChatSchema,
  selectPublicMessagesSchema,
  messageFeedbackEnum,
  type SelectChat,
  type SelectMessage,
  selectMessageSchema,
} from "@/db/schema"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getLogger, getLoggerWithChild } from "@/logger"
import {
  AgentReasoningStepType,
  AgentToolName,
  ChatSSEvents,
  ContextSysthesisState,
  OpenAIError,
  XyneTools,
  type AgentReasoningStep,
  type MessageReqType,
} from "@/shared/types"
import {
  MessageRole,
  Subsystem,
  MCPClientConfig,
  MCPClientStdioConfig,
} from "@/types"
import {
  delay,
  getErrorMessage,
  getRelativeTime,
  interpretDateFromReturnedTemporalValue,
  splitGroupedCitationsWithSpaces,
} from "@/utils"
import {
  ToolResultContentBlock,
  type ConversationRole,
  type Message,
} from "@aws-sdk/client-bedrock-runtime"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE, type SSEStreamingApi } from "hono/streaming" // Import SSEStreamingApi
import { z } from "zod"
import type { chatSchema, MessageRetryReqType } from "@/api/search"
import { getTracer, type Span, type Tracer } from "@/tracer"
import {
  searchVespa,
  SearchModes,
  searchVespaInFiles,
  getItems,
  GetDocumentsByDocIds,
  getDocumentOrNull,
  searchVespaThroughAgent,
  searchVespaAgent,
  SearchVespaThreads,
  getAllDocumentsForAgent,
  searchSlackInVespa,
} from "@/search/vespa"
import {
  Apps,
  CalendarEntity,
  chatMessageSchema,
  chatUserSchema,
  chatContainerSchema,
  dataSourceFileSchema,
  DriveEntity,
  entitySchema,
  eventSchema,
  fileSchema,
  GooglePeopleEntity,
  isValidApp,
  isValidEntity,
  mailAttachmentSchema,
  MailEntity,
  mailSchema,
  SystemEntity,
  VespaSearchResultsSchema,
  type VespaSearchResult,
} from "@/search/types"
import { APIError } from "openai"
import {
  insertChatTrace,
  deleteChatTracesByChatExternalId,
  updateChatTrace,
} from "@/db/chatTrace"
import type { AttachmentMetadata } from "@/shared/types"
import { storeAttachmentMetadata } from "@/db/attachment"
import { parseAttachmentMetadata } from "@/utils/parseAttachment"
import { isCuid } from "@paralleldrive/cuid2"
import {
  getAgentByExternalId,
  getAgentByExternalIdWithPermissionCheck,
  type SelectAgent,
} from "@/db/agent"
import { selectToolSchema, type SelectTool } from "@/db/schema/McpConnectors"
import { activeStreams } from "./stream"
import {
  ragPipelineConfig,
  RagPipelineStages,
  type AgentTool,
  type ImageCitation,
  type MinimalAgentFragment,
} from "./types"
import {
  convertReasoningStepToText,
  extractFileIdsFromMessage,
  extractImageFileNames,
  flattenObject,
  getCitationToImage,
  handleError,
  isMessageWithContext,
  mimeTypeMap,
  processMessage,
  searchToCitation,
} from "./utils"
export const textToCitationIndex = /\[(\d+)\]/g
import config from "@/config"
import {
  buildContext,
  buildUserQuery,
  cleanBuffer,
  getThreadContext,
  isContextSelected,
  textToImageCitationIndex,
  UnderstandMessageAndAnswer,
  UnderstandMessageAndAnswerForGivenContext,
} from "./chat"
import { agentTools } from "./tools"
// JAF integration imports
import {
  runStream,
  generateRunId,
  generateTraceId,
  type Agent as JAFAgent,
  type Tool as JAFTool,
  type Message as JAFMessage,
  type RunConfig as JAFRunConfig,
  type RunState as JAFRunState,
  type RunResult as JAFRunResult,
  type TraceEvent as JAFTraceEvent,
  type JAFError,
} from "@xynehq/jaf"
// Replace LiteLLM provider with Xyne-backed JAF provider
import { makeXyneJAFProvider } from "./jaf-provider"
import {
  buildInternalJAFTools,
  buildMCPJAFTools,
  type FinalToolsList as JAFinalToolsList,
  type JAFAdapterCtx,
  buildToolsOverview,
  buildContextSection,
} from "@/api/chat/jaf-adapter"
import { internalTools, mapGithubToolResponse } from "@/api/chat/mapper"
const {
  JwtPayloadKey,
  chatHistoryPageSize,
  defaultBestModel,
  defaultFastModel,
  maxDefaultSummary,
  chatPageSize,
  isReasoning,
  fastModelReasoning,
  StartThinkingToken,
  EndThinkingToken,
  maxValidLinks,
  maxUserRequestCount,
} = config
const Logger = getLogger(Subsystem.Chat)
const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

// Generate AI summary for agent reasoning steps
const generateStepSummary = async (
  step: AgentReasoningStep,
  userQuery: string,
  contextInfo?: string,
): Promise<string> => {
  try {
    const prompt = generateAgentStepSummaryPromptJson(
      step,
      userQuery,
      contextInfo,
    )

    // Use a fast model for summary generation
    const summary = await generateSynthesisBasedOnToolOutput(prompt, "", "", {
      modelId: defaultFastModel,
      stream: false,
      json: true,
      reasoning: false,
      messages: [],
    })

    const summaryResponse = summary.text || ""

    // Parse the JSON response
    const parsed = jsonParseLLMOutput(summaryResponse)
    Logger.debug("Parsed reasoning step:", { parsed })
    Logger.debug("Generated summary:", { summary: parsed.summary })
    return parsed.summary || generateFallbackSummary(step)
  } catch (error) {
    Logger.error(`Error generating step summary: ${error}`)
    return generateFallbackSummary(step)
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

const checkAndYieldCitationsForAgent = async function* (
  textInput: string,
  yieldedCitations: Set<number>,
  results: MinimalAgentFragment[],
  yieldedImageCitations?: Map<number, Set<number>>,
  email: string = "",
) {
  const text = splitGroupedCitationsWithSpaces(textInput)
  let match
  let imgMatch
  while (
    (match = textToCitationIndex.exec(text)) !== null ||
    (imgMatch = textToImageCitationIndex.exec(text)) !== null
  ) {
    if (match) {
      const citationIndex = parseInt(match[1], 10)
      if (!yieldedCitations.has(citationIndex)) {
        const item = results[citationIndex - 1]

        if (!item?.source?.docId || !item.source?.url) {
          Logger.info(
            "[checkAndYieldCitationsForAgent] No docId or url found for citation, skipping",
          )
          continue
        }

        yield {
          citation: {
            index: citationIndex,
            item: item.source,
          },
        }
        yieldedCitations.add(citationIndex)
      }
    } else if (imgMatch && yieldedImageCitations) {
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
            try {
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
              }
            } catch (error) {
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
}

const vespaResultToMinimalAgentFragment = (
  child: VespaSearchResult,
  idx: number,
): MinimalAgentFragment => ({
  id: `${(child.fields as any)?.docId || `Frangment_id_${idx}`}`,
  content: answerContextMap(
    child as z.infer<typeof VespaSearchResultsSchema>,
    0,
    true,
  ),
  source: searchToCitation(child as z.infer<typeof VespaSearchResultsSchema>),
  confidence: 1.0,
})

async function* getToolContinuationIterator(
  message: string,
  userCtx: string,
  toolsPrompt: string,
  toolOutput: string,
  results: MinimalAgentFragment[],
  agentPrompt?: string,
  messages: Message[] = [],
  fallbackReasoning?: string,
  attachmentFileIds?: string[],
  email?: string,
): AsyncIterableIterator<
  ConverseResponse & {
    citation?: { index: number; item: any }
    imageCitation?: ImageCitation
  }
> {
  const context = answerContextMapFromFragments(results, maxDefaultSummary)
  const { imageFileNames } = extractImageFileNames(
    context,
    results.map(
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
  const finalImageFileNames = imageFileNames || []

  if (attachmentFileIds?.length) {
    finalImageFileNames.push(
      ...attachmentFileIds.map((fileid, index) => `${index}_${fileid}_${0}`),
    )
  }

  const continuationIterator = generateAnswerBasedOnToolOutput(
    message,
    userCtx,
    {
      modelId: defaultBestModel,
      stream: true,
      json: true,
      reasoning: false,
      messages,
      imageFileNames: finalImageFileNames,
    },
    toolsPrompt,
    context ?? "",
    agentPrompt,
    fallbackReasoning,
  )

  // const previousResultsLength = 0 // todo fix this
  let buffer = ""
  let currentAnswer = ""
  let parsed = { answer: "" }
  let thinking = ""
  let reasoning = config.isReasoning
  let yieldedCitations = new Set<number>()
  let yieldedImageCitations = new Map<number, Set<number>>()
  const ANSWER_TOKEN = '"answer":'

  for await (const chunk of continuationIterator) {
    if (chunk.text) {
      // if (reasoning) {
      //   if (thinking && !chunk.text.includes(EndThinkingToken)) {
      //     thinking += chunk.text
      //     yield* checkAndYieldCitationsForAgent(
      //       thinking,
      //       yieldedCitations,
      //       results,
      //       previousResultsLength,
      //     )
      //     yield { text: chunk.text, reasoning }
      //   } else {
      //     // first time
      //     const startThinkingIndex = chunk.text.indexOf(StartThinkingToken)
      //     if (
      //       startThinkingIndex !== -1 &&
      //       chunk.text.trim().length > StartThinkingToken.length
      //     ) {
      //       let token = chunk.text.slice(
      //         startThinkingIndex + StartThinkingToken.length,
      //       )
      //       if (chunk.text.includes(EndThinkingToken)) {
      //         token = chunk.text.split(EndThinkingToken)[0]
      //         thinking += token
      //       } else {
      //         thinking += token
      //       }
      //       yield* checkAndYieldCitationsForAgent(
      //         thinking,
      //         yieldedCitations,
      //         results,
      //         previousResultsLength,
      //       )
      //       yield { text: token, reasoning }
      //     }
      //   }
      // }
      // if (reasoning && chunk.text.includes(EndThinkingToken)) {
      //   reasoning = false
      //   chunk.text = chunk.text.split(EndThinkingToken)[1].trim()
      // }
      // if (!reasoning) {
      buffer += chunk.text
      try {
        yield { text: chunk.text }

        yield* checkAndYieldCitationsForAgent(
          buffer,
          yieldedCitations,
          results,
          yieldedImageCitations,
          email ?? "",
        )
      } catch (e) {
        Logger.error(`Error parsing LLM output: ${e}`)
        continue
      }
    }

    if (chunk.cost) {
      yield { cost: chunk.cost }
    }
    if (chunk.metadata?.usage) {
      yield { metadata: { usage: chunk.metadata.usage } }
    }
  }
}

type SynthesisResponse = {
  synthesisState:
    | ContextSysthesisState.Complete
    | ContextSysthesisState.Partial
    | ContextSysthesisState.NotFound
  answer: string | null
}

async function performSynthesis(
  ctx: any,
  message: string,
  planningContext: string,
  gatheredFragments: MinimalAgentFragment[],
  messagesWithNoErrResponse: Message[],
  logAndStreamReasoning: (step: AgentReasoningStep) => Promise<void>,
  sub: string,
  attachmentFileIds?: string[],
): Promise<SynthesisResponse | null> {
  let parseSynthesisOutput: SynthesisResponse | null = null

  try {
    await logAndStreamReasoning({
      type: AgentReasoningStepType.Synthesis,
      details: `Synthesizing answer from ${gatheredFragments.length} fragments...`,
    })

    const synthesisResponse = await generateSynthesisBasedOnToolOutput(
      ctx,
      message,
      planningContext,
      {
        modelId: defaultBestModel,
        stream: false,
        json: true,
        reasoning: false,
        messages: messagesWithNoErrResponse,
        imageFileNames: attachmentFileIds?.map(
          (fileId, index) => `${index}_${fileId}_${0}`,
        ),
      },
    )

    if (synthesisResponse.text) {
      try {
        parseSynthesisOutput = jsonParseLLMOutput(synthesisResponse.text)
        if (!parseSynthesisOutput || !parseSynthesisOutput.synthesisState) {
          loggerWithChild({ email: sub }).error(
            "Synthesis response was valid JSON but missing 'synthesisState' key.",
          )
          // Default to partial to force another iteration, which is safer
          parseSynthesisOutput = {
            synthesisState: ContextSysthesisState.Partial,
            answer: null,
          }
        }
      } catch (jsonError) {
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
    }
  } catch (synthesisError) {
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
  }

  return parseSynthesisOutput
}

const addErrMessageToMessage = async (
  lastMessage: SelectMessage,
  errorMessage: string,
) => {
  if (lastMessage.messageRole === MessageRole.User) {
    await updateMessageByExternalId(db, lastMessage?.externalId, {
      errorMessage,
    })
  }
}
export const MessageWithToolsApi = async (c: Context) => {
  const tracer: Tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("MessageWithToolsApi")

  let stream: any
  let chat: SelectChat
  let assistantMessageId: string | null = null
  let streamKey: string | null = null
  let isDebugMode = config.isDebugMode
  let email = ""
  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    email = sub
    loggerWithChild({ email: email }).info("MessageApi..")
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    // @ts-ignore
    const body = c.req.valid("query")
    let isAgentic = c.req.query("agentic") === "true"
    let {
      message,
      chatId,
      modelId,
      isReasoningEnabled,
      toolsList,
      agentId,
    }: MessageReqType = body
    const attachmentMetadata = parseAttachmentMetadata(c)
    const attachmentFileIds = attachmentMetadata.map(
      (m: AttachmentMetadata) => m.fileId,
    )
    const agentPromptValue = agentId && isCuid(agentId) ? agentId : undefined
    // const userRequestsReasoning = isReasoningEnabled // Addressed: Will be used below
    let attachmentStorageError: Error | null = null
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
    loggerWithChild({ email: email }).info(
      `Extracted ${fileIds  } extractedInfo`,
    )
    loggerWithChild({ email: email }).info(
      `Total attachment files received: ${attachmentFileIds.length}`,
    )
    const hasReferencedContext = fileIds && fileIds.length > 0

    if (!message) {
      throw new HTTPException(400, {
        message: "Message is required",
      })
    }
    message = decodeURIComponent(message)
    rootSpan.setAttribute("message", message)

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const { user, workspace } = userAndWorkspace
    let messages: SelectMessage[] = []
    const costArr: number[] = []
    const tokenArr: { inputTokens: number; outputTokens: number }[] = []
    const ctx = userContext(userAndWorkspace)
    let chat: SelectChat

    const chatCreationSpan = rootSpan.startSpan("chat_creation")
    let agentPromptForLLM: string | undefined = undefined
    let agentForDb: SelectAgent | null = null
    if (agentId && isCuid(agentId)) {
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
      if (agentForDb.isRagOn === false) {
        isAgentic = false
      }
      agentPromptForLLM = JSON.stringify(agentForDb)
    }
    const agentIdToStore = agentForDb ? agentForDb.externalId : null
    let title = ""
    if (!chatId) {
      const titleSpan = chatCreationSpan.startSpan("generate_title")
      // let llm decide a title
      const titleResp = await generateTitleUsingQuery(message, {
        modelId: ragPipelineConfig[RagPipelineStages.NewChatTitle].modelId,
        stream: false,
      })
      title = titleResp.title
      const cost = titleResp.cost
      if (cost) {
        costArr.push(cost)
        titleSpan.setAttribute("cost", cost)
      }
      titleSpan.setAttribute("title", title)
      titleSpan.end()

      let [insertedChat, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage]> => {
          const chat = await insertChat(tx, {
            workspaceId: workspace.id,
            workspaceExternalId: workspace.externalId,
            userId: user.id,
            email: user.email,
            title,
            attachments: [],
            ...(agentId ? { agentId: agentIdToStore } : {}),
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
            modelId,
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
      loggerWithChild({ email: sub }).info(
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
            modelId,
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
      loggerWithChild({ email: sub }).info(
        "Existing conversation, fetched previous messages",
      )
      messages = allMessages.concat(insertedMsg) // Update messages array
      chat = existingChat
      chatCreationSpan.end()
    }
    return streamSSE(
      c,
      async (stream) => {
        // Store MCP clients for cleanup to prevent memory leaks
        const mcpClients: Client[] = []
        let finalReasoningLogString = ""
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

          // Stream both summaries
          await stream.writeSSE({
            event: ChatSSEvents.Reasoning,
            data: JSON.stringify({
              text: humanReadableLog,
              step: enhancedStep,
              quickSummary: enhancedStep.stepSummary,
              aiSummary: enhancedStep.aiGeneratedSummary,
            }),
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

            // Use a fast model for summary generation
            const summaryResult = await generateSynthesisBasedOnToolOutput(
              prompt,
              "",
              "",
              {
                modelId: defaultFastModel,
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

            // Stream the iteration summary
            await stream.writeSSE({
              event: ChatSSEvents.Reasoning,
              data: JSON.stringify({
                text: summary,
                step: iterationSummaryStep,
                quickSummary: summary,
                aiSummary: summary,
                isIterationSummary: true,
              }),
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

            await stream.writeSSE({
              event: ChatSSEvents.Reasoning,
              data: JSON.stringify({
                text: fallbackSummary,
                step: fallbackSummaryStep,
                quickSummary: fallbackSummary,
                aiSummary: fallbackSummary,
                isIterationSummary: true,
              }),
            })
          }
        }

        streamKey = `${chat.externalId}` // Create the stream key
        activeStreams.set(streamKey, stream) // Add stream to the map
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
          const finalToolsList: Record<
            string,
            {
              tools: SelectTool[]
              client: Client
            }
          > = {}
          const maxIterations = 10
          let iterationCount = 0
          let answered = false
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
                if ("url" in connector.config) {
                  isCustomMCP = true
                  // MCP SSE
                  const config = connector.config as z.infer<
                    typeof MCPClientConfig
                  >
                  Logger.info(
                    `invoking client initialize for url: ${new URL(config.url)} ${
                      config.url
                    }`,
                  )
                  await client.connect(
                    new SSEClientTransport(new URL(config.url)),
                  )
                } else {
                  // MCP Stdio
                  const config = connector.config as z.infer<
                    typeof MCPClientStdioConfig
                  >
                  Logger.info(
                    `invoking client initialize for command: ${config.command}`,
                  )
                  await client.connect(
                    new StdioClientTransport({
                      command: config.command,
                      args: config.args,
                    }),
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

              finalToolsList[connector.id] = {
                tools: filteredTools,
                client: client,
              }
              // Fetch all available tools from the client
              // TODO: look in the DB. cache logic has to be discussed.
              // const respone = await client.listTools()
              // const clientTools = response.tools

              // // Update tool definitions in the database for future use
              // await syncConnectorTools(
              //   db,
              //   workspace.id,
              //   connector.id,
              //   clientTools.map((tool) => ({
              //     toolName: tool.name,
              //     toolSchema: JSON.stringify(tool),
              //     description: tool.description,
              //   })),
              // )
              // // Create a map for quick lookup
              // const toolSchemaMap = new Map(
              //   clientTools.map((tool) => [tool.name, JSON.stringify(tool)]),
              // )
              // // Filter to only the requested tools, or use all tools if toolNames is empty
              // const filteredTools = []
              // if (toolNames.length === 0) {
              //   // If toolNames is empty, add all tools
              //   for (const [toolName, schema] of toolSchemaMap.entries()) {
              //     filteredTools.push({
              //       name: toolName,
              //       schema: schema || "",
              //     })
              //   }
              // } else {
              //   // Otherwise, filter to only the requested tools
              //   for (const toolName of toolNames) {
              //     if (toolSchemaMap.has(toolName)) {
              //       filteredTools.push({
              //         name: toolName,
              //         schema: toolSchemaMap.get(toolName) || "",
              //       })
              //     } else {
              //       Logger.info(
              //         `[MessageWithToolsApi] Tool schema not found for ${connectorId}:${toolName}.`,
              //       )
              //     }
              //   }
              // }
              // finalToolsList[connectorId] = {
              //   tools: filteredTools,
              //   client: client,
              // }
            }
          }
          // ====== JAF-based agent loop starts here (replaces manual loop) ======
          // Prepare streaming state holders
          let answer = ""
          const citations: any[] = []
          const imageCitations: any[] = []
          const citationMap: Record<number, number> = {}
          const citationValues: Record<number, string> = {}
          let gatheredFragments: MinimalAgentFragment[] = []
          let planningContext = ""
          let parseSynthesisResult = null

          if (hasReferencedContext && iterationCount === 0) {
              const contextFetchSpan = rootSpan.startSpan(
                "fetchDocumentContext",
              )
              await logAndStreamReasoning({
                type: AgentReasoningStepType.Iteration,
                iteration: iterationCount,
              })
              try {
                const results = await GetDocumentsByDocIds(
                  fileIds,
                  contextFetchSpan,
                )
                if (
                  results?.root?.children &&
                  results.root.children.length > 0
                ) {
                  const contextPromises = results?.root?.children?.map(
                    async (v, i) => {
                      let content = answerContextMap(
                        v as z.infer<typeof VespaSearchResultsSchema>,
                        0,
                        true,
                      )
                      if (
                        v.fields &&
                        "sddocname" in v.fields &&
                        v.fields.sddocname === chatContainerSchema &&
                        (v.fields as any).creator
                      ) {
                        const creator = await getDocumentOrNull(
                          chatUserSchema,
                          (v.fields as any).creator,
                        )
                        if (creator) {
                          content += `\nCreator: ${(creator.fields as any).name}`
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
                      if (
                        v.fields &&
                        "sddocname" in v.fields &&
                        v.fields.sddocname === chatContainerSchema
                      ) {
                        const channelId = (v.fields as any).docId

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
                            if (
                              threadMessages &&
                              threadMessages.root.children
                            ) {
                              threadContexts.push(
                                ...threadMessages.root.children,
                              )
                            }
                          }
                        }
                      }
                    }
                  }
                  planningContext = cleanContext(resolvedContexts?.join("\n"))
                  if (chatContexts.length > 0) {
                    planningContext += "\n" + buildContext(chatContexts, 10)
                  }
                  if (threadContexts.length > 0) {
                    planningContext += "\n" + buildContext(threadContexts, 10)
                  }

                  gatheredFragments = results.root.children.map(
                    (child: VespaSearchResult, idx) =>
                      vespaResultToMinimalAgentFragment(child, idx),
                  )
                  if (chatContexts.length > 0) {
                    gatheredFragments.push(
                      ...chatContexts.map((child, idx) =>
                        vespaResultToMinimalAgentFragment(child, idx),
                      ),
                    )
                  }
                  if (threadContexts.length > 0) {
                    gatheredFragments.push(
                      ...threadContexts.map((child, idx) =>
                        vespaResultToMinimalAgentFragment(child, idx),
                      ),
                    )
                  }
                  const parseSynthesisOutput = await performSynthesis(
                    ctx,
                    message,
                    planningContext,
                    gatheredFragments,
                    messagesWithNoErrResponse,
                    logAndStreamReasoning,
                    sub,
                    attachmentFileIds,
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
          const baseCtx: JAFAdapterCtx = {
            email: sub,
            userCtx: ctx,
            agentPrompt: agentPromptForLLM,
            userMessage: message,
          }
          const internalJAFTools: JAFTool<any, JAFAdapterCtx>[] = buildInternalJAFTools(
            baseCtx,
          )
          const mcpJAFTools: JAFTool<any, JAFAdapterCtx>[] =
            buildMCPJAFTools(finalToolsList as unknown as JAFinalToolsList)
          const allJAFTools = [...internalJAFTools, ...mcpJAFTools]

          // Build dynamic instructions that include tools + current context fragments
          const agentInstructions = (_state: any) => {
            const toolOverview = buildToolsOverview(allJAFTools)
            const contextSection = buildContextSection(gatheredFragments)
            const agentSection = agentPromptForLLM
              ? `\n\nAgent Constraints:\n${agentPromptForLLM}`
              : ""
            const synthesisSection = parseSynthesisResult;
            return (
              `You are Xyne, an enterprise search assistant.\n` +
              `- Your first action must be to call an appropriate tool to gather authoritative context before answering.\n` +
              `- Do NOT answer from general knowledge. Always retrieve context via tools first.\n` +
              `- Always cite sources inline using bracketed indices [n] that refer to the Context Fragments list below.\n` +
              `- If context is missing or insufficient, use search/metadata tools to fetch more, or ask a brief clarifying question, then search.\n` +
              `- Be concise, accurate, and avoid hallucinations.\n` +
              `- If there is a parseSynthesisOutput, use it to respond to the user without doing any further tool calls. Add missing citations and return the answer.\n` +
              `\nAvailable Tools:\n${toolOverview}` +
              contextSection +
              agentSection +
              `\n<parseSynthesisOutput>${synthesisSection}</parseSynthesisOutput>`
            )
          }

          const runId = generateRunId()
          const traceId = generateTraceId()
          const initialMessages: JAFMessage[] = messages
            .filter((m) => !m?.errorMessage)
            .map((m) => ({
              role:
                m.messageRole === MessageRole.User
                  ? ("user" as const)
                  : ("assistant" as const),
              content: m.message,
            }))
            
          const jafAgent: JAFAgent<JAFAdapterCtx, string> = {
            name: "xyne-agent",
            instructions: () => agentInstructions(null),
            tools: allJAFTools,
            modelConfig: { name: (defaultBestModel) as unknown as string },
          }

          const modelProvider = makeXyneJAFProvider<JAFAdapterCtx>()

          const agentRegistry = new Map<string, JAFAgent<JAFAdapterCtx, string>>([
            [jafAgent.name, jafAgent],
          ])

          const runState: JAFRunState<JAFAdapterCtx> = {
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
            modelOverride: (defaultBestModel) as unknown as string,
          }

          // Note: ResponseMetadata was already sent above with chatId

          // Stream JAF events → existing SSE protocol
          const yieldedCitations = new Set<number>()
          const yieldedImageCitations = new Map<number, Set<number>>()
          for await (const evt of runStream<JAFAdapterCtx, string>(runState, runCfg)) {
            if (stream.closed) {
              wasStreamClosedPrematurely = true
              break
            }
            switch (evt.type) {
              case "turn_start": {
                await stream.writeSSE({
                  event: ChatSSEvents.Reasoning,
                  data: JSON.stringify({
                    text: `Iteration ${evt.data.turn} started (agent: ${evt.data.agentName})`,
                    step: {
                      type: AgentReasoningStepType.Iteration,
                      iteration: evt.data.turn,
                      status: "in_progress",
                      stepSummary: `Planning search iteration ${evt.data.turn}`,
                    },
                  }),
                })
                break
              }
              case "tool_requests": {
                for (const r of evt.data.toolCalls) {
                  await stream.writeSSE({
                    event: ChatSSEvents.Reasoning,
                    data: JSON.stringify({
                      text: `Tool selected: ${r.name}`,
                      step: {
                        type: AgentReasoningStepType.ToolSelected,
                        toolName: r.name,
                        status: "in_progress",
                        stepSummary: `Executing ${r.name} tool`,
                      },
                    }),
                  })
                  await stream.writeSSE({
                    event: ChatSSEvents.Reasoning,
                    data: JSON.stringify({
                      text: `Parameters: ${JSON.stringify(r.args)}`,
                      step: {
                        type: AgentReasoningStepType.ToolParameters,
                        parameters: r.args,
                        status: "in_progress",
                        stepSummary: "Reviewing tool parameters",
                      },
                    }),
                  })
                }
                break
              }
              case "tool_call_start": {
                await stream.writeSSE({
                  event: ChatSSEvents.Reasoning,
                  data: JSON.stringify({
                    text: `Executing ${evt.data.toolName}...`,
                    step: {
                      type: AgentReasoningStepType.ToolExecuting,
                      toolName: evt.data.toolName,
                      status: "in_progress",
                      stepSummary: `Executing ${evt.data.toolName} tool`,
                    },
                  }),
                })
                break
              }
              case "tool_call_end": {
                type ToolCallEndEventData = Extract<
                  JAFTraceEvent,
                  { type: "tool_call_end" }
                >["data"]
                const contexts = (evt.data as ToolCallEndEventData)?.toolResult?.metadata?.contexts
                if (Array.isArray(contexts) && contexts.length) {
                  gatheredFragments.push(...(contexts as MinimalAgentFragment[]))
                }
                await stream.writeSSE({
                  event: ChatSSEvents.Reasoning,
                  data: JSON.stringify({
                    text: `Tool result: ${evt.data.toolName}`,
                    step: {
                      type: AgentReasoningStepType.ToolResult,
                      toolName: evt.data.toolName,
                      status: evt.data.status || "completed",
                      resultSummary: "Tool execution completed",
                      itemsFound: Array.isArray(contexts) ? contexts.length : undefined,
                      stepSummary: `Found ${Array.isArray(contexts) ? contexts.length : 0} results`,
                    },
                  }),
                })
                break
              }
              case "assistant_message": {
                const content = evt.data.message.content || ""
                if (content && content.length) {
                  // Chunk and stream answer updates; also detect citations on the fly
                  const chunkSize = 200
                  for (let i = 0; i < content.length; i += chunkSize) {
                    const chunk = content.slice(i, i + chunkSize)
                    answer += chunk
                    await stream.writeSSE({
                      event: ChatSSEvents.ResponseUpdate,
                      data: chunk,
                    })

                    // Yield citations as they appear
                    for await (const cit of checkAndYieldCitationsForAgent(
                      answer,
                      yieldedCitations,
                      gatheredFragments,
                      yieldedImageCitations,
                      email ?? "",
                    )) {
                      if (cit.citation) {
                        const { index, item } = cit.citation as any
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
                }
                break
              }
              case "token_usage": {
                tokenArr.push({
                  inputTokens: (evt.data.prompt as number) || 0,
                  outputTokens: (evt.data.completion as number) || 0,
                })
                break
              }
              case "guardrail_violation": {
                await stream.writeSSE({
                  event: ChatSSEvents.Error,
                  data: JSON.stringify({
                    error: "guardrail_violation",
                    message: evt.data.reason,
                  }),
                })
                break
              }
              case "decode_error": {
                await stream.writeSSE({
                  event: ChatSSEvents.Error,
                  data: JSON.stringify({
                    error: "decode_error",
                    message: "Failed to decode model output",
                  }),
                })
                break
              }
              case "handoff_denied": {
                await stream.writeSSE({
                  event: ChatSSEvents.Error,
                  data: JSON.stringify({
                    error: "handoff_denied",
                    message: evt.data.reason,
                  }),
                })
                break
              }
              case "turn_end": {
                // Emit an iteration summary (fallback version)
                await stream.writeSSE({
                  event: ChatSSEvents.Reasoning,
                  data: JSON.stringify({
                    text: `Completed iteration ${evt.data.turn}.`,
                    step: {
                      type: AgentReasoningStepType.LogMessage,
                      status: "completed",
                      message: `Completed iteration ${evt.data.turn}.`,
                      iteration: evt.data.turn,
                      stepSummary: `Completed iteration ${evt.data.turn}.`,
                      isIterationSummary: true,
                    },
                  }),
                })
                break
              }
              case "final_output": {
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
                break
              }
              case "run_end": {
                const outcome = evt.data.outcome as JAFRunResult<string>["outcome"]
                if (outcome?.status === "completed") {
                  const totalCost = costArr.reduce((sum, cost) => sum + cost, 0)
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
                    message: processMessage(answer, citationMap),
                    thinking: "",
                    modelId: defaultBestModel,
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
                  await stream.writeSSE({ event: ChatSSEvents.End, data: "" })
                } else {
                  // Error outcome: stream error and do not insert assistant message
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
                  const err = outcome?.error as JAFError | undefined
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
                          await stream.writeSSE({
                            event: ChatSSEvents.Reasoning,
                            data: JSON.stringify({
                              text: "Max iterations reached with incomplete synthesis. Activating follow-back search strategy...",
                              step: {
                                type: AgentReasoningStepType.LogMessage,
                                message: "Max iterations reached with incomplete synthesis. Activating follow-back search strategy...",
                                status: "in_progress",
                                stepSummary: "Activating fallback search",
                              },
                            }),
                          })

                          // Extract all context from runState.messages array
                          const allMessages = runState.messages || []
                          const agentScratchpad = allMessages
                            .map((msg, index) => `${msg.role}: ${msg.content}`)
                            .join('\n')
                          console.log("Agent scratchpad:", agentScratchpad)
                          console.log('all messages:', allMessages)

                          // Build tool log from any tool executions in the conversation
                          const toolLog = allMessages
                            .filter(msg => msg.role === 'tool' || (msg as any).tool_calls || (msg as any).tool_call_id)
                            .map((msg, index) => `Tool Execution ${index + 1}: ${msg.content}`)
                            .join('\n')
                          console.log("Tool log:", toolLog)
                          // Prepare fallback tool parameters with context from runState.messages
                          const fallbackParams = {
                            originalQuery: message,
                            agentScratchpad: agentScratchpad,
                            toolLog: toolLog,
                            gatheredFragments: gatheredFragments,
                          }

                          await stream.writeSSE({
                            event: ChatSSEvents.Reasoning,
                            data: JSON.stringify({
                              text: `Executing fallback tool with context from ${allMessages.length} messages...`,
                              step: {
                                type: AgentReasoningStepType.ToolExecuting,
                                toolName: "fall_back",
                                status: "in_progress",
                                stepSummary: "Executing fallback tool",
                              },
                            }),
                          })

                          // Execute fallback tool directly
                          const fallbackResponse = await agentTools["fall_back"].execute(
                            fallbackParams,
                            streamSpan.startSpan("fallback_search_execution"),
                            email,
                            ctx,
                            agentPromptForLLM,
                            message,
                          )

                          await stream.writeSSE({
                            event: ChatSSEvents.Reasoning,
                            data: JSON.stringify({
                              text: `Fallback tool execution completed`,
                              step: {
                                type: AgentReasoningStepType.ToolResult,
                                toolName: "fall_back",
                                status: "completed",
                                resultSummary: fallbackResponse.result || "Fallback response generated",
                                itemsFound: fallbackResponse.contexts?.length || 0,
                                stepSummary: `Generated fallback response`,
                              },
                            }),
                          })

                          // Stream the fallback response if available
                          if (fallbackResponse.fallbackReasoning || fallbackResponse.result) {
                            const fallbackAnswer = fallbackResponse.fallbackReasoning || fallbackResponse.result || ""
                            
                            await stream.writeSSE({
                              event: ChatSSEvents.ResponseUpdate,
                              data: fallbackAnswer,
                            })

                            // Handle any contexts returned by fallback tool
                            if (fallbackResponse.contexts && Array.isArray(fallbackResponse.contexts)) {
                              fallbackResponse.contexts.forEach((context: any, index: number) => {
                                citations.push(context)
                                citationMap[citations.length] = citations.length - 1
                              })
                              
                              if (citations.length > 0) {
                                await stream.writeSSE({
                                  event: ChatSSEvents.CitationsUpdate,
                                  data: JSON.stringify({
                                    contextChunks: citations,
                                    citationMap,
                                  }),
                                })
                              }
                            }

                            if (fallbackAnswer.trim()) {
                              // Insert successful fallback message
                              const totalCost = costArr.reduce((sum, cost) => sum + cost, 0)
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
                                thinking: "",
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
                              await stream.writeSSE({ event: ChatSSEvents.End, data: "" })
                              return // Successfully handled with fallback response
                            }
                          }
                        } catch (fallbackError) {
                          Logger.error(fallbackError, "Error during MaxTurnsExceeded fallback tool execution")
                          await stream.writeSSE({
                            event: ChatSSEvents.Reasoning,
                            data: JSON.stringify({
                              text: `Fallback search failed: ${getErrorMessage(fallbackError)}. Will generate best-effort answer.`,
                              step: {
                                type: AgentReasoningStepType.LogMessage,
                                message: `Fallback search failed: ${getErrorMessage(fallbackError)}`,
                                status: "error",
                                stepSummary: "Fallback search failed",
                              },
                            }),
                          })
                          // Fall through to default error handling if fallback fails
                        }
                        
                        // Default error handling if fallback fails or produces no response
                        errMsg = `Max turns exceeded: ${err.turns}`
                        break
                      default:
                        errMsg = errTag
                    }
                  }
                  const errPayload = {
                    error: errTag,
                    message: errMsg,
                  }
                  await stream.writeSSE({
                    event: ChatSSEvents.Error,
                    data: JSON.stringify(errPayload),
                  })
                  await addErrMessageToMessage(lastMessage, JSON.stringify(errPayload))
                  await stream.writeSSE({ event: ChatSSEvents.End, data: "" })
                }
                break
              }
            }
          }

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
  context: string,
  results: MinimalAgentFragment[],
  agentPrompt?: string,
  messages: Message[] = [],
  imageFileNames: string[] = [],
  attachmentFileIds?: string[],
  email?: string,
  isReasoning = true,
): AsyncIterableIterator<
  ConverseResponse & {
    citation?: { index: number; item: any }
    imageCitation?: ImageCitation
  }
> {
  const ragOffIterator = baselineRAGOffJsonStream(
    message,
    userCtx,
    context,
    {
      modelId: defaultBestModel,
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
  let email = ""

  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    email = sub
    loggerWithChild({ email: email }).info("AgentMessageApiRagOff..")
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    // @ts-ignore
    const body = c.req.valid("query")
    const attachmentMetadata = parseAttachmentMetadata(c)
    const attachmentFileIds = attachmentMetadata.map(
      (m: AttachmentMetadata) => m.fileId,
    )
    let {
      message,
      chatId,
      modelId,
      isReasoningEnabled,
      agentId,
    }: MessageReqType = body
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId, // This workspaceId is the externalId from JWT
      email,
    )
    const { user, workspace } = userAndWorkspace // workspace.id is the numeric ID
    let agentPromptForLLM: string | undefined = undefined
    let agentForDb: SelectAgent | null = null
    if (agentId && isCuid(agentId)) {
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
    let chat: SelectChat

    const chatCreationSpan = rootSpan.startSpan("chat_creation")

    let title = ""
    if (!chatId) {
      const titleSpan = chatCreationSpan.startSpan("generate_title")
      // let llm decide a title
      const titleResp = await generateTitleUsingQuery(message, {
        modelId: ragPipelineConfig[RagPipelineStages.NewChatTitle].modelId,
        stream: false,
      })
      title = titleResp.title
      let attachmentStorageError: Error | null = null
      const cost = titleResp.cost
      if (cost) {
        costArr.push(cost)
        titleSpan.setAttribute("cost", cost)
      }
      titleSpan.setAttribute("title", title)
      titleSpan.end()

      let [insertedChat, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage]> => {
          const chat = await insertChat(tx, {
            workspaceId: workspace.id,
            workspaceExternalId: workspace.externalId,
            userId: user.id,
            email: user.email,
            title,
            attachments: [],
            agentId: agentIdToStore,
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
            modelId,
            fileIds: fileIds,
          })

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
            modelId,
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
    return streamSSE(c, async (stream) => {
      streamKey = `${chat.externalId}` // Create the stream key
      activeStreams.set(streamKey, stream) // Add stream to the map
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
        )
        dataSourceSpan.end()
        loggerWithChild({ email: sub }).info(
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
            fragments = allChunks.root.children.map((child, idx) =>
              vespaResultToMinimalAgentFragment(child, idx),
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
        if (attachmentFileIds?.length) {
          finalImageFileNames.push(
            ...attachmentFileIds.map(
              (fileid, index) => `${index}_${fileid}_${0}`,
            ),
          )
        }

        const ragOffIterator = nonRagIterator(
          message,
          ctx,
          context,
          fragments,
          agentPromptForLLM,
          messagesWithNoErrResponse,
          finalImageFileNames,
          attachmentFileIds,
          email,
          isReasoningEnabled,
        )
        let answer = ""
        let citations: any[] = []
        let imageCitations: any[] = []
        let citationMap: Record<number, number> = {}
        let citationValues: Record<number, any> = {}
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
            loggerWithChild({ email: sub }).info(
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
            modelId: defaultBestModel,
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
            modelId: defaultBestModel,
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
            modelId: defaultBestModel,
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
  } catch (error) {
    // ... (error handling as in AgentMessageApi)
  }
}

export const AgentMessageApi = async (c: Context) => {
  // we will use this in catch
  // if the value exists then we send the error to the frontend via it
  const tracer: Tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("AgentMessageApi")

  let stream: any
  let chat: SelectChat
  let assistantMessageId: string | null = null
  let streamKey: string | null = null
  let email = ""

  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    email = sub
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    // @ts-ignore
    const body = c.req.valid("query")
    const attachmentMetadata = parseAttachmentMetadata(c)
    const attachmentFileIds = attachmentMetadata.map(
      (m: AttachmentMetadata) => m.fileId,
    )
    let attachmentStorageError: Error | null = null
    let {
      message,
      chatId,
      modelId,
      isReasoningEnabled,
      agentId,
    }: MessageReqType = body
    // const agentPrompt = agentId && isCuid(agentId) ? agentId : "";
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId, // This workspaceId is the externalId from JWT
      email,
    )
    const { user, workspace } = userAndWorkspace // workspace.id is the numeric ID

    let agentPromptForLLM: string | undefined = undefined
    let agentForDb: SelectAgent | null = null
    if (agentId && isCuid(agentId)) {
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
      if (config.ragOffFeature && agentForDb.isRagOn === false) {
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

    const isMsgWithContext = isMessageWithContext(message)
    const extractedInfo = isMsgWithContext
      ? await extractFileIdsFromMessage(message, email)
      : {
          totalValidFileIdsFromLinkCount: 0,
          fileIds: [],
        }
    const fileIds = extractedInfo?.fileIds
    const agentDocs = agentForDb?.docIds || []

    //add docIds of agents here itself
    const totalValidFileIdsFromLinkCount =
      extractedInfo?.totalValidFileIdsFromLinkCount

    let messages: SelectMessage[] = []
    const costArr: number[] = []
    const tokenArr: { inputTokens: number; outputTokens: number }[] = []
    const ctx = userContext(userAndWorkspace)
    let chat: SelectChat

    const chatCreationSpan = rootSpan.startSpan("chat_creation")

    let title = ""
    if (!chatId) {
      const titleSpan = chatCreationSpan.startSpan("generate_title")
      // let llm decide a title
      const titleResp = await generateTitleUsingQuery(message, {
        modelId: ragPipelineConfig[RagPipelineStages.NewChatTitle].modelId,
        stream: false,
      })
      title = titleResp.title
      const cost = titleResp.cost
      if (cost) {
        costArr.push(cost)
        titleSpan.setAttribute("cost", cost)
      }
      titleSpan.setAttribute("title", title)
      titleSpan.end()

      let [insertedChat, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage]> => {
          const chat = await insertChat(tx, {
            workspaceId: workspace.id,
            workspaceExternalId: workspace.externalId,
            userId: user.id,
            email: user.email,
            title,
            attachments: [],
            agentId: agentIdToStore,
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
            modelId,
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
            modelId,
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
      loggerWithChild({ email: sub }).info(
        "Existing conversation, fetched previous messages",
      )
      messages = allMessages.concat(insertedMsg) // Update messages array
      chat = existingChat
      chatCreationSpan.end()
    }
    return streamSSE(
      c,
      async (stream) => {
        streamKey = `${chat.externalId}` // Create the stream key
        activeStreams.set(streamKey, stream) // Add stream to the map
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

          if (
            (isMsgWithContext && fileIds && fileIds?.length > 0) ||
            (attachmentFileIds && attachmentFileIds?.length > 0)
          ) {
            Logger.info(
              "User has selected some context with query, answering only based on that given context",
            )
            let answer = ""
            let citations = []
            let imageCitations: any = []
            let citationMap: Record<number, number> = {}
            let thinking = ""
            let reasoning =
              userRequestsReasoning &&
              ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning
            const conversationSpan = streamSpan.startSpan("conversation_search")
            conversationSpan.setAttribute("answer", answer)
            conversationSpan.end()

            const ragSpan = streamSpan.startSpan("rag_processing")

            const understandSpan = ragSpan.startSpan("understand_message")

            const iterator = UnderstandMessageAndAnswerForGivenContext(
              email,
              ctx,
              message,
              0.5,
              fileIds,
              userRequestsReasoning,
              understandSpan,
              [],
              attachmentFileIds,
              agentPromptForLLM,
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
            let citationValues: Record<number, string> = {}
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
                modelId:
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
                  !(msg.messageRole === MessageRole.Assistant && !msg.message),
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
            const searchOrAnswerIterator =
              generateSearchQueryOrAnswerFromConversation(message, ctx, {
                modelId:
                  ragPipelineConfig[RagPipelineStages.AnswerOrSearch].modelId,
                stream: true,
                json: true,
                reasoning:
                  userRequestsReasoning &&
                  ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning,
                messages: limitedMessages,
                agentPrompt: agentPromptForLLM,
              })

            // TODO: for now if the answer is from the conversation itself we don't
            // add any citations for it, we can refer to the original message for citations
            // one more bug is now llm automatically copies the citation text sometimes without any reference
            // leads to [NaN] in the answer
            let currentAnswer = ""
            let answer = ""
            let citations = []
            let imageCitations: any = []
            let citationMap: Record<number, number> = {}
            let queryFilters = {
              apps: [],
              entities: [],
              startTime: "",
              endTime: "",
              count: 0,
              sortDirection: "",
            }
            let parsed = {
              answer: "",
              queryRewrite: "",
              temporalDirection: null,
              filter_query: "",
              type: "",
              intent: {},
              filters: queryFilters,
            }

            let thinking = ""
            let reasoning =
              userRequestsReasoning &&
              ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning
            let buffer = ""
            const conversationSpan = streamSpan.startSpan("conversation_search")
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

            conversationSpan.setAttribute("answer_found", parsed.answer)
            conversationSpan.setAttribute("answer", answer)
            conversationSpan.setAttribute("query_rewrite", parsed.queryRewrite)
            conversationSpan.end()

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
              const classification: TemporalClassifier & QueryRouterResponse = {
                direction: parsed.temporalDirection,
                type: parsed.type as QueryType,
                filterQuery: parsed.filter_query,
                filters: {
                  ...(parsed?.filters ?? {}),
                  apps: parsed.filters?.apps || [],
                  entities: parsed.filters?.entities as any,
                  intent: parsed.intent || {},
                },
              }

              Logger.info(
                `Classifying the query as:, ${JSON.stringify(classification)}`,
              )
              const understandSpan = ragSpan.startSpan("understand_message")
              const iterator = UnderstandMessageAndAnswer(
                email,
                ctx,
                message,
                classification,
                limitedMessages,
                0.5,
                userRequestsReasoning,
                understandSpan,
                agentPromptForLLM,
              )
              stream.writeSSE({
                event: ChatSSEvents.Start,
                data: "",
              })

              answer = ""
              thinking = ""
              reasoning = isReasoning && userRequestsReasoning
              citations = []
              citationMap = {}
              let citationValues: Record<number, string> = {}
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
                modelId:
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
            Logger.info(`Removed stream ${streamKey} from active streams map.`)
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
