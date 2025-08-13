import {
  answerContextMap,
  answerContextMapFromFragments,
  cleanContext,
  constructToolContext,
  userContext,
} from "@/ai/context"
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
import { cleanBuffer } from "@/api/chat/chat"
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
  type AttachmentMetadata,
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
  getThreadContext,
  isContextSelected,
  textToImageCitationIndex,
  UnderstandMessageAndAnswer,
  UnderstandMessageAndAnswerForGivenContext,
} from "./chat"
import { agentTools } from "./tools"
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

const checkAndYieldCitationsForAgent = async function* (
  textInput: string,
  yieldedCitations: Set<number>,
  results: MinimalAgentFragment[],
  baseIndex: number = 0,
  yieldedImageCitations?: Set<number>,
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
        // Fix citation indexing to use 0-based array indexing
        const item = results[citationIndex - 1] // Citations are 1-based, arrays are 0-based

        if (!item?.source?.docId) {
          loggerWithChild({ email: email }).error(
            "[checkAndYieldCitationsForAgent] No item found for citation or missing docId",
            { citationIndex, resultsLength: results.length, item },
          )
          continue
        }

        if (!item.source?.url) {
          loggerWithChild({ email: email }).info(
            "[checkAndYieldCitationsForAgent] No url found for citation, using docId",
            { citationIndex, docId: item.source.docId },
          )
        }

        try {
          yield {
            citation: {
              index: citationIndex,
              item: item.source,
            },
          }
          yieldedCitations.add(citationIndex)
        } catch (error) {
          loggerWithChild({ email: email }).error(
            error,
            "[checkAndYieldCitationsForAgent] Error yielding citation",
            { citationIndex, error: getErrorMessage(error) },
          )
        }
      }
    } else if (imgMatch && yieldedImageCitations) {
      const parts = imgMatch[1].split("_")
      if (parts.length >= 2) {
        const docIndex = parseInt(parts[0], 10)
        const imageIndex = parseInt(parts[1], 10)
        const citationIndex = docIndex + baseIndex
        if (!yieldedImageCitations.has(citationIndex)) {
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
            yieldedImageCitations.add(citationIndex)
          } else {
            loggerWithChild({ email: email }).error(
              "Found a citation index but could not find it in the search result ",
              citationIndex,
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
  // Use the provided toolOutput (which contains properly formatted web scraper content)
  // instead of recreating context from fragments, which loses the formatting
  const context =
    toolOutput || answerContextMapFromFragments(results, maxDefaultSummary)
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

  const previousResultsLength = 0 // todo fix this
  let buffer = ""
  let currentAnswer = ""
  let parsed = { answer: "" }
  let thinking = ""
  let reasoning = config.isReasoning
  let yieldedCitations = new Set<number>()
  let yieldedImageCitations = new Set<number>()
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
        // JSON parsing similar to other parts of the codebase
        try {
          const cleanedBuffer = cleanBuffer(buffer)
          parsed = jsonParseLLMOutput(cleanedBuffer, ANSWER_TOKEN) || {}
          if (parsed.answer && currentAnswer !== parsed.answer) {
            if (currentAnswer === "") {
              // First valid answer - send the whole thing
              yield { text: parsed.answer }
            } else {
              // Subsequent chunks - send only the new part
              const newText = parsed.answer.slice(currentAnswer.length)
              if (newText) {
                yield { text: newText }
              }
            }
            currentAnswer = parsed.answer
          }

          // Only process citations if JSON parsing was successful
          yield* checkAndYieldCitationsForAgent(
            parsed.answer || currentAnswer,
            yieldedCitations,
            results,
            previousResultsLength,
            yieldedImageCitations,
            email ?? "",
          )
        } catch (jsonParseError) {
          // If JSON parsing fails, fall back to streaming the raw text
          yield { text: chunk.text }

          // Still try to process citations from the raw text chunk, but safely
          try {
            yield* checkAndYieldCitationsForAgent(
              chunk.text,
              yieldedCitations,
              results,
              previousResultsLength,
              yieldedImageCitations,
              email ?? "",
            )
          } catch (citationError) {
            // Log citation processing errors but don't crash
            Logger.warn(
              `Citation processing error: ${getErrorMessage(citationError)}`,
            )
          }
        }
      } catch (e) {
        Logger.error(`Error processing LLM output: ${getErrorMessage(e)}`)
        // Still yield the chunk text to prevent complete failure
        yield { text: chunk.text }
        continue
      }
    }

    if (chunk.cost) {
      yield { cost: chunk.cost }
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
  message: string,
  planningContext: string,
  gatheredFragments: MinimalAgentFragment[],
  messagesWithNoErrResponse: Message[],
  logAndStreamReasoning: (step: AgentReasoningStep) => Promise<void>,
  sub: string,
  attachmentFileIds?: string[],
  agentContext?: string,
): Promise<SynthesisResponse | null> {
  let parseSynthesisOutput: SynthesisResponse | null = null

  try {
    await logAndStreamReasoning({
      type: AgentReasoningStepType.Synthesis,
      details: `Synthesizing answer from ${gatheredFragments.length} fragments...`,
    })

    const synthesisResponse = await generateSynthesisBasedOnToolOutput(
      "", // userCtx - empty for now as we don't have access to user context in this scope
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
      agentContext,
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

  // Post-synthesis validation: Override obvious synthesis mistakes for web scraper content
  if (parseSynthesisOutput && gatheredFragments.length > 0) {
    const webScraperFragments = gatheredFragments.filter(
      (fragment) => fragment.id && fragment.id.includes("web_scraper"),
    )

    if (webScraperFragments.length > 0) {
      const totalContentLength = gatheredFragments.reduce(
        (sum, fragment) => sum + (fragment.content?.length || 0),
        0,
      )

      // Check for inaccessible content patterns (login pages, redirects, etc.)
      const hasInaccessibleContent = webScraperFragments.some((fragment) => {
        const content = fragment.content?.toLowerCase() || ""
        const title = fragment.source?.title || ""
        const url = fragment.source?.url || ""

        // More specific patterns for actual login/authentication pages
        const isLoginPage =
          (content.includes("sign in") &&
            content.includes("email") &&
            content.includes("password") &&
            content.includes("google")) ||
          (content.includes("login") &&
            content.includes("password") &&
            content.includes("username") &&
            content.length < 1000) ||
          (content.includes("authentication required") &&
            content.includes("please log in") &&
            content.includes("login page")) ||
          (content.includes("access denied") &&
            content.length < 300 &&
            content.includes("unauthorized")) // Very specific error pages

        // Explicit private/restricted URL patterns
        const isPrivateUrl =
          (typeof url === "string" && url.includes("mail.google.com")) ||
          (typeof url === "string" &&
            url.includes("drive.google.com") &&
            url.includes("sharing")) ||
          (typeof title === "string" &&
            title.toLowerCase().includes("gmail")) ||
          (typeof title === "string" &&
            title.toLowerCase().includes("sign in to google"))

        // Check for actual error pages (very short content with specific error messages)
        const isErrorPage =
          content.length < 200 &&
          (content.includes("403 forbidden") ||
            content.includes("401 unauthorized") ||
            content.includes("404 not found"))

        const result = isLoginPage || isPrivateUrl || isErrorPage

        // Debug logging when content is flagged as inaccessible
        if (result) {
          console.log(
            `[DEBUG] Flagged as inaccessible: URL=${url}, Title=${title}, Content length=${content.length}`,
          )
          console.log(
            `[DEBUG] Reasons: loginPage=${isLoginPage}, privateUrl=${isPrivateUrl}, errorPage=${isErrorPage}`,
          )
          console.log(
            `[DEBUG] Content preview: ${content.substring(0, 200)}...`,
          )
        }

        return result
      })

      // If we detected inaccessible content (like Gmail login), mark as not found to stop the loop
      if (
        hasInaccessibleContent &&
        parseSynthesisOutput.synthesisState === ContextSysthesisState.Partial
      ) {
        await logAndStreamReasoning({
          type: AgentReasoningStepType.LogMessage,
          message: `Override synthesis decision: Web scraper hit inaccessible content (login page/authentication), marking as not found to prevent infinite loop.`,
        })

        parseSynthesisOutput = {
          synthesisState: ContextSysthesisState.NotFound,
          answer:
            "The URL appears to be inaccessible or requires authentication. Unable to retrieve the requested information from this source.",
        }
      }
      // Override synthesis decision if we have substantial accessible web scraper content
      else if (
        (parseSynthesisOutput.synthesisState ===
          ContextSysthesisState.Partial ||
          parseSynthesisOutput.synthesisState ===
            ContextSysthesisState.NotFound) &&
        totalContentLength > 500 &&
        !hasInaccessibleContent
      ) {
        await logAndStreamReasoning({
          type: AgentReasoningStepType.LogMessage,
          message: `Override synthesis decision: Web scraper provided substantial accessible content (${totalContentLength} chars), marking as complete.`,
        })

        parseSynthesisOutput = {
          synthesisState: ContextSysthesisState.Complete,
          answer: "", // Clear the incorrect answer so final answer generation can use the scraped content
        }
      }
    }
  }

  // Additional check: If synthesis keeps returning "information_not_found" and we're dealing with CLEARLY private URLs
  if (
    parseSynthesisOutput &&
    parseSynthesisOutput.synthesisState === ContextSysthesisState.NotFound &&
    gatheredFragments.some((f) => {
      const url = f.source?.url || ""
      const title = f.source?.title || ""
      const content = f.content?.toLowerCase() || ""

      // Only trigger for CLEARLY private/auth-required content
      const isClearlyPrivate =
        (typeof url === "string" && url.includes("mail.google.com")) ||
        (typeof url === "string" &&
          url.includes("drive.google.com") &&
          url.includes("sharing")) ||
        (typeof title === "string" && title.toLowerCase().includes("gmail")) ||
        (typeof title === "string" &&
          title.toLowerCase().includes("sign in to google")) ||
        (content.includes("authentication required") &&
          content.includes("please log in") &&
          content.includes("login page") &&
          content.length < 300)

      return isClearlyPrivate
    })
  ) {
    await logAndStreamReasoning({
      type: AgentReasoningStepType.LogMessage,
      message: `Synthesis correctly identified authentication-required content as not found. Stopping further attempts.`,
    })

    parseSynthesisOutput = {
      synthesisState: ContextSysthesisState.NotFound,
      answer:
        "The referenced URLs require authentication or are private. I cannot access Gmail links or other private URLs directly. Please provide publicly accessible URLs or share the specific content you'd like me to analyze.",
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

    let ctx = userContext(userAndWorkspace)

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
        let agentLog: string[] = [] // For building the prompt context
        let structuredReasoningSteps: AgentReasoningStep[] = [] // For structured reasoning steps
        const logAndStreamReasoning = async (
          reasoningStep: AgentReasoningStep,
        ) => {
          const humanReadableLog = convertReasoningStepToText(reasoningStep)
          agentLog.push(humanReadableLog)
          structuredReasoningSteps.push(reasoningStep)
          await stream.writeSSE({
            event: ChatSSEvents.Reasoning,
            data: convertReasoningStepToText(reasoningStep),
          })
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
            message: `Analyzing your query...`,
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
          let answer = ""
          let currentAnswer = ""
          let citations = []
          let imageCitations: any = []
          let citationMap: Record<number, number> = {}
          let citationValues: Record<number, string> = {}
          let thinking = ""
          let reasoning =
            ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning
          let gatheredFragments: MinimalAgentFragment[] = []
          let excludedIds: string[] = [] // To track IDs of retrieved documents
          let agentScratchpad = "" // To build the reasoning history for the prompt
          let planningContext = "" // To build the context for planning
          let toolsPrompt = "" // To build the context for available tools
          let fallbackReasoning: string | undefined = undefined // To store fallback reasoning
          let lastToolOutput = "" // To store the raw result from the last tool execution
          const previousToolCalls: {
            tool: string
            args: Record<string, "any">
            failureCount: number
          }[] = []
          const MAX_CONSECUTIVE_TOOL_FAILURES = 2

          while (iterationCount <= maxIterations && !answered) {
            if (stream.closed) {
              loggerWithChild({ email: sub }).info(
                "[MessageWithToolsApi] Stream closed during conversation search loop. Breaking.",
              )
              wasStreamClosedPrematurely = true
              break
            }
            iterationCount++

            // On the first iteration, check if this is a "@" reference case and synthesize the context.
            // If the synthesized context is insufficient, continue gathering more context in subsequent iterations.
            if (hasReferencedContext && iterationCount === 1) {
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

                  // CRITICAL: Check if document contains URLs that need scraping before synthesis
                  const documentContent = planningContext.toLowerCase()
                  const hasUrlsNeedingScraping =
                    documentContent.includes("http://") ||
                    documentContent.includes("https://") ||
                    documentContent.includes("link to") ||
                    documentContent.includes("see:") ||
                    documentContent.includes("read more") ||
                    documentContent.includes("tutorial") ||
                    documentContent.includes(".pdf") ||
                    documentContent.includes("watch how") ||
                    documentContent.includes("guide at")

                  if (hasUrlsNeedingScraping) {
                    console.log(
                      `[DEBUG] Document contains URLs needing scraping. Content preview: ${documentContent.substring(0, 200)}...`,
                    )
                    await logAndStreamReasoning({
                      type: AgentReasoningStepType.LogMessage,
                      message:
                        "Document contains URLs that need scraping. Skipping synthesis and proceeding to tool selection.",
                    })
                    continue // Skip synthesis and go to tool selection
                  }

                  const parseSynthesisOutput = await performSynthesis(
                    message,
                    planningContext,
                    gatheredFragments,
                    messagesWithNoErrResponse,
                    logAndStreamReasoning,
                    sub,
                    attachmentFileIds,
                    agentPromptForLLM,
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

                  if (isContextSufficient) {
                    // Context is complete. We can break the loop and generate the final answer.
                    await logAndStreamReasoning({
                      type: AgentReasoningStepType.LogMessage,
                      message:
                        "Context is sufficient. Proceeding to generate final answer.",
                    })
                    break
                  }
                  continue
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

            let loopWarningPrompt = ""
            const reasoningHeader = `
            --- AGENT REASONING SO FAR ---
            Below is the step-by-step reasoning you've taken so far. Use this to inform your next action.
            ${structuredReasoningSteps
              .map(convertReasoningStepToText)
              .join("\n")}
            `
            const evidenceSummary =
              gatheredFragments.length > 0
                ? `\n--- CURRENTLY GATHERED EVIDENCE (for final answer generation) ---\n` +
                  gatheredFragments
                    .map(
                      (f, i) =>
                        `[Fragment ${i + 1}] (Source Doc ID: ${
                          f.source.docId
                        })\n` +
                        `  - Title: ${f.source.title || "Untitled"}\n` +
                        // Truncate content in the scratchpad to keep the prompt concise.
                        // The full content is available in `planningContext` for the final answer.
                        `  - Content Snippet: "${f.content.substring(0, 100)}..."`,
                    )
                    .join("\n\n")
                : "\n--- NO EVIDENCE GATHERED YET ---"

            // Check for consecutive failures and add warning
            const lastToolCall = previousToolCalls[previousToolCalls.length - 1]
            if (
              lastToolCall &&
              lastToolCall.failureCount >= MAX_CONSECUTIVE_TOOL_FAILURES
            ) {
              loopWarningPrompt = `
                   ---
                   **Critique Past Actions:** You have repeatedly called the tool '${
                     lastToolCall.tool
                   }' with arguments ${JSON.stringify(
                     lastToolCall.args,
                   )} and it has failed or yielded insufficient results ${
                     lastToolCall.failureCount
                   } times consecutively. You are stuck in a loop. You MUST choose a DIFFERENT TOOL or escalate to a "no answer found" state if no other tools are viable.
                   ---
                `
              await logAndStreamReasoning({
                type: AgentReasoningStepType.LogMessage,
                message: `Detected ${lastToolCall.failureCount} consecutive failures for tool ${lastToolCall.tool}. Attempting to change strategy.`,
              })
            } else if (previousToolCalls.length) {
              loopWarningPrompt = `
                   ---
                   **Critique Past Actions:** You have already called some tools ${previousToolCalls
                     .map(
                       (toolCall, idx) =>
                         `[Iteration-${idx}] Tool: ${
                           toolCall.tool
                         }, Args: ${JSON.stringify(toolCall.args)}`,
                     )
                     .join(
                       "\n",
                     )}  and the result was insufficient. You are in a loop. You MUST choose a appropriate tool to resolve user query.
                 You **MUST** change your strategy.
                  For example: 
                    1.  Choose a **DIFFERENT TOOL**.
                    2.  Use the **SAME TOOL** but with **DIFFERENT Parameters**.
                    3.  Use just different **offset**  if you think if the tool selected is correct and you need to goto next page to find better context.
  
                  Do NOT make these call again. Formulate a new, distinct plan.
                   ---
                `
            }

            agentScratchpad = evidenceSummary + "\n\n" + reasoningHeader
            toolsPrompt = ""
            // TODO: make more sense to move this inside prompt such that format of output can be written together.
            if (Object.keys(finalToolsList).length > 0) {
              toolsPrompt = `While answering check if any below given AVAILABLE_TOOLS can be invoked to get more context to answer the user query more accurately, this is very IMPORTANT so you should check this properly based on the given tools information. 
                AVAILABLE_TOOLS:\n\n`

              // Format each client's tools
              for (const [connectorId, { tools }] of Object.entries(
                finalToolsList,
              )) {
                if (tools.length > 0) {
                  for (const tool of tools) {
                    const parsedTool = selectToolSchema.safeParse(tool)
                    if (parsedTool.success && parsedTool.data.toolSchema) {
                      toolsPrompt += `${constructToolContext(
                        parsedTool.data.toolSchema,
                        parsedTool.data.toolName,
                        parsedTool.data.description ?? "",
                      )}\n\n`
                    }
                  }
                }
              }
            }

            // filter out conversational tool if it is not the first iteration
            const xyneToolNames =
              iterationCount !== 1
                ? Object.keys(internalTools).filter(
                    (v) => v !== XyneTools.Conversational,
                  )
                : Object.keys(internalTools)
            const xyneTools = Object.fromEntries(
              xyneToolNames.map((toolName) => [
                toolName,
                internalTools[toolName],
              ]),
            )
            const toolSelection = await generateToolSelectionOutput(
              message,
              `${ctx}\n\nDOCUMENT CONTENT:\n${planningContext}`,
              toolsPrompt,
              agentScratchpad,
              {
                modelId: defaultFastModel,
                stream: false,
                json: true,
                reasoning: false,
                messages: messagesWithNoErrResponse,
              },
              agentPromptForLLM,
              loopWarningPrompt,
              { internal: xyneTools },
              isDebugMode,
            )

            if (
              toolSelection?.queryRewrite &&
              toolSelection.queryRewrite.length
            ) {
              await logAndStreamReasoning({
                type: AgentReasoningStepType.AnalyzingQuery,
                details: `Query rewrite detected: ${toolSelection.queryRewrite}`,
              })
              streamSpan
                .startSpan("query_rewrite")
                .setAttribute("query_rewrite", toolSelection.queryRewrite)
              message = toolSelection.queryRewrite
            }

            if (toolSelection && toolSelection.tool) {
              await logAndStreamReasoning({
                type: AgentReasoningStepType.Iteration,
                iteration: iterationCount,
              })

              if (toolSelection.reasoning) {
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.LogMessage,
                  message: `Reasoning: ${toolSelection.reasoning}`,
                })
              }

              const toolName = toolSelection.tool
              const toolParams = toolSelection.arguments

              // Update previousToolCalls with failure tracking
              const lastCallIndex = previousToolCalls.length - 1
              if (
                lastCallIndex >= 0 &&
                previousToolCalls[lastCallIndex].tool === toolName &&
                JSON.stringify(previousToolCalls[lastCallIndex].args) ===
                  JSON.stringify(toolParams)
              ) {
                previousToolCalls[lastCallIndex].failureCount++
              } else {
                previousToolCalls.push({
                  tool: toolName,
                  args: toolParams,
                  failureCount: 0, // Reset failure count for a new tool/args combination
                })
              }

              if (toolName === XyneTools.Conversational) {
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.LogMessage,
                  message: `Tool ${toolName} selected.`,
                })
                break
              }

              await logAndStreamReasoning({
                type: AgentReasoningStepType.Planning,
                details: `Planning next step with ${gatheredFragments.length} context fragments.`,
              })
              loggerWithChild({ email: sub }).info(
                `Tool selection #${toolName} with params: ${JSON.stringify(
                  toolParams,
                )}`,
              )

              let toolExecutionResponse: {
                result: string
                contexts?: MinimalAgentFragment[]
                error?: string
              } | null = null

              const toolExecutionSpan = streamSpan.startSpan(
                `execute_tool_${toolName}`,
              )

              if (agentTools[toolName]) {
                if (excludedIds.length > 0) {
                  toolParams.excludedIds = excludedIds
                }
                if ("limit" in toolParams) {
                  if (
                    toolParams.limit &&
                    toolParams.limit > maxUserRequestCount
                  ) {
                    await logAndStreamReasoning({
                      type: AgentReasoningStepType.LogMessage,
                      message: `Detected perPage ${toolParams.perPage} in arguments for tool ${toolName}`,
                    })
                    toolParams.limit = maxUserRequestCount
                    await logAndStreamReasoning({
                      type: AgentReasoningStepType.LogMessage,
                      message: `Limited perPage for tool ${toolName} to ${maxUserRequestCount}`,
                    })
                  }
                }

                await logAndStreamReasoning({
                  type: AgentReasoningStepType.ToolExecuting,
                  toolName: toolName as AgentToolName,
                })

                await logAndStreamReasoning({
                  type: AgentReasoningStepType.ToolParameters,
                  parameters: {
                    ...toolParams,
                    excludedIds: excludedIds.length
                      ? `Excluded ${excludedIds.length} previous ${excludedIds.length === 1 ? "result" : "results"} to avoid duplication`
                      : "None",
                  },
                })
                try {
                  toolExecutionResponse = await agentTools[toolName].execute(
                    toolParams,
                    toolExecutionSpan,
                    email,
                    ctx,
                    agentPromptForLLM,
                    message,
                  )
                } catch (error) {
                  const errMessage = getErrorMessage(error)
                  loggerWithChild({ email: sub }).error(
                    error,
                    `Critical error executing internal agent tool ${toolName}: ${errMessage}`,
                  )
                  toolExecutionResponse = {
                    result: `Execution of tool ${toolName} failed critically.`,
                    error: errMessage,
                  }
                }
              } else if (Object.keys(finalToolsList).length > 0) {
                let foundClient: Client | null = null
                let connectorId: string | null = null

                // Find the client for the requested tool (your logic is good)
                for (const [connId, { tools, client }] of Object.entries(
                  finalToolsList,
                )) {
                  if (
                    tools.some(
                      (tool) =>
                        selectToolSchema.safeParse(tool).success &&
                        selectToolSchema.safeParse(tool).data?.toolName ===
                          toolName,
                    )
                  ) {
                    foundClient = client
                    connectorId = connId
                    break
                  }
                }

                if (!foundClient || !connectorId) {
                  const errorMsg = `Tool "${toolName}" was selected by the agent but is not an available tool.`
                  loggerWithChild({ email: sub }).error(errorMsg)
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.ValidationError,
                    details: errorMsg,
                  })
                  // Set an error response so the agent knows its plan failed and can re-plan
                  toolExecutionResponse = {
                    result: `Error: Could not find the specified tool '${toolName}'.`,
                    error: "Tool not found",
                  }
                } else {
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.ToolExecuting,
                    toolName: toolName as AgentToolName, // We can cast here as it's a string from the LLM
                  })
                  try {
                    // TODO: Implement your parameter validation logic here before calling the tool.
                    if ("perPage" in toolParams) {
                      if (toolParams.perPage && toolParams.perPage > 10) {
                        await logAndStreamReasoning({
                          type: AgentReasoningStepType.LogMessage,
                          message: `Detected perPage ${toolParams.perPage} in arguments for tool ${toolName}`,
                        })
                        toolParams.perPage = 10 // Limit to 10 per page
                        await logAndStreamReasoning({
                          type: AgentReasoningStepType.LogMessage,
                          message: `Limited perPage for tool ${toolName} to 10`,
                        })
                      }
                    }
                    const mcpToolResponse: any = await foundClient.callTool({
                      name: toolName,
                      arguments: toolParams,
                    })

                    let formattedContent = "Tool returned no parsable content."
                    let newFragments: MinimalAgentFragment[] = []
                    const isValidJSON = (str: string) => {
                      try {
                        JSON.parse(str)
                        return true
                      } catch (e) {
                        return false
                      }
                    }
                    try {
                      if (
                        mcpToolResponse.content &&
                        mcpToolResponse.content[0] &&
                        mcpToolResponse.content[0].text
                      ) {
                        const parsedJson = isValidJSON(
                          mcpToolResponse.content[0].text,
                        )
                          ? JSON.parse(mcpToolResponse.content[0].text)
                          : mcpToolResponse.content[0].text
                        if (isCustomMCP) {
                          const baseFragmentId = `mcp-${connectorId}-${toolName}`
                          // Convert the formatted response into a standard MinimalAgentFragment
                          let mainContentParts = []
                          if (parsedJson.title)
                            mainContentParts.push(`Title: ${parsedJson.title}`)
                          if (parsedJson.body)
                            mainContentParts.push(`Body: ${parsedJson.body}`)
                          if (parsedJson.name)
                            mainContentParts.push(`Name: ${parsedJson.name}`)
                          if (parsedJson.description)
                            mainContentParts.push(
                              `Description: ${parsedJson.description}`,
                            )

                          if (mainContentParts.length > 2) {
                            formattedContent = mainContentParts.join("\n")
                          } else {
                            formattedContent = `Tool Response: ${
                              typeof parsedJson !== "string"
                                ? flattenObject(parsedJson)
                                    .map(([key, value]) => `- ${key}: ${value}`)
                                    .join("\n")
                                : parsedJson
                            }`
                          }

                          newFragments.push({
                            id: `${baseFragmentId}-generic`,
                            content: formattedContent,
                            source: {
                              app: Apps.MCP,
                              docId: "",
                              title: `Response from ${toolName}`,
                              entity: SystemEntity.SystemInfo,
                              url:
                                parsedJson.html_url ||
                                parsedJson.url ||
                                undefined,
                            },
                            confidence: 0.8,
                          })
                        } else {
                          const baseFragmentId = `mcp-${connectorId}-${toolName}`
                          ;({ formattedContent, newFragments } =
                            mapGithubToolResponse(
                              toolName,
                              parsedJson,
                              baseFragmentId,
                              sub,
                            ))
                        }
                      }
                    } catch (parsingError) {
                      loggerWithChild({ email: sub }).error(
                        parsingError,
                        `Could not parse response from MCP tool ${toolName} as JSON.`,
                      )
                      formattedContent =
                        "Tool response was not valid JSON and could not be processed."
                    }

                    // Populate the unified response object for the MCP tool
                    toolExecutionResponse = {
                      result: `Tool ${toolName} executed. \n Summary: ${formattedContent.substring(
                        0,
                        200,
                      )}...`,
                      contexts: newFragments,
                    }
                  } catch (error) {
                    const errMessage = getErrorMessage(error)
                    loggerWithChild({ email: sub }).error(
                      error,
                      `Error invoking external tool ${toolName}: ${errMessage}`,
                    )
                    // Populate the unified response with the error
                    toolExecutionResponse = {
                      result: `Execution of tool ${toolName} failed.`,
                      error: errMessage,
                    }
                  }
                }
              } else {
                // This case handles when a tool was specified by the LLM,
                // but it's not an internal tool AND (finalToolsList is empty OR the tool is not in finalToolsList)
                const errorMsg = `Tool "${toolName}" was selected by the agent but is not an available or configured tool.`
                loggerWithChild({ email: sub }).error(errorMsg)
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.ValidationError,
                  details: errorMsg,
                })
                toolExecutionResponse = {
                  result: `Error: Could not find the specified tool '${toolName}'.`,
                  error: "Tool not found or not configured",
                }
              }
              toolExecutionSpan.end()

              if (toolExecutionResponse) {
                // Store the raw tool output for potential use in final answer generation
                if (toolExecutionResponse.result) {
                  lastToolOutput = toolExecutionResponse.result
                }

                await logAndStreamReasoning({
                  type: AgentReasoningStepType.ToolResult,
                  toolName: toolName as AgentToolName,
                  resultSummary: toolExecutionResponse.result,
                  itemsFound: toolExecutionResponse.contexts?.length || 0,
                  error: toolExecutionResponse.error,
                })

                // If the tool execution resulted in an error or no new contexts, increment failure count
                const currentToolCall =
                  previousToolCalls[previousToolCalls.length - 1]
                if (
                  currentToolCall &&
                  (toolExecutionResponse.error ||
                    !toolExecutionResponse.contexts ||
                    toolExecutionResponse.contexts.length === 0)
                ) {
                  currentToolCall.failureCount++
                } else if (currentToolCall) {
                  // If successful, reset failure count for this tool
                  currentToolCall.failureCount = 0
                }

                if (toolExecutionResponse.error) {
                  // Check for repeated web scraper authentication failures
                  if (
                    toolName === "web_scraper" &&
                    (toolExecutionResponse.error.includes("authentication") ||
                      toolExecutionResponse.error.includes(
                        "require authentication",
                      ) ||
                      toolExecutionResponse.result?.includes(
                        "Cannot scrape the following URLs as they require authentication",
                      ))
                  ) {
                    const webScraperFailures = previousToolCalls.filter(
                      (call) =>
                        call.tool === "web_scraper" && call.failureCount > 0,
                    ).length

                    if (webScraperFailures >= 2) {
                      await logAndStreamReasoning({
                        type: AgentReasoningStepType.LogMessage,
                        message: `Detected repeated web scraper authentication failures. Stopping attempts to prevent infinite loop.`,
                      })
                      // Force break the loop by marking as answered with a clear message
                      answered = true
                      answer =
                        "The URLs you've referenced require authentication or are private (like Gmail links). I cannot access these URLs directly. Please provide publicly accessible URLs or share the specific content you'd like me to analyze."
                      break
                    }
                  }

                  if (iterationCount < maxIterations) {
                    continue // Continue to the next iteration to re-plan
                  } else {
                    // If we fail on the last iteration, we have to stop.
                    await logAndStreamReasoning({
                      type: AgentReasoningStepType.LogMessage,
                      message:
                        "Tool failed on the final iteration. Generating answer with available context.",
                    })
                  }
                }

                if (
                  toolExecutionResponse.contexts &&
                  toolExecutionResponse.contexts.length > 0
                ) {
                  const newFragments = toolExecutionResponse.contexts
                  gatheredFragments.push(...newFragments)

                  const newIds = newFragments.map((f) => f.id).filter(Boolean) // Use the fragment's own unique ID
                  excludedIds = [...new Set([...excludedIds, ...newIds])]
                }
              } else {
                // This case should ideally not be reached if the logic above correctly sets toolExecutionResponse.
                // However, as a fallback, log an error and potentially continue or break.
                const criticalErrorMsg = `Critical error: toolExecutionResponse is null after attempting tool execution for "${toolName}".`
                loggerWithChild({ email: sub }).error(criticalErrorMsg)
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.ValidationError,
                  details: criticalErrorMsg,
                })
                // Decide if we should continue to re-plan or break the loop.
                // For now, let's assume we should try to re-plan if not max iterations.
                if (iterationCount < maxIterations) {
                  continue
                }
              }

              // if the timestamp range was specified and no results were found
              // then  that no results were found in this timastamp range
              const hasTimestampFilter = toolParams?.from || toolParams?.to
              if (hasTimestampFilter && !gatheredFragments.length) {
                const fromDate = new Date(
                  toolParams?.from || 0,
                ).toLocaleDateString()
                const toDate = new Date(
                  toolParams?.to || Date.now(),
                ).toLocaleDateString()

                const appName = toolParams.app
                  ? `${toolParams.app} data`
                  : "content"

                const context = {
                  id: "",
                  content: `No ${appName} found within the specified date range (${fromDate} to ${toDate}). No further action needed - this simply means there was no activity during this time period.`,
                  source: {} as any,
                  confidence: 0,
                }
                gatheredFragments.push(context)
              }

              planningContext = gatheredFragments.length
                ? gatheredFragments
                    .map(
                      (f, i) =>
                        `[${i + 1}] ${
                          f.source.title || `Source ${f.source.docId}`
                        }: ${f.content}`,
                    )
                    .join("\n")
                : ""

              if (planningContext.length) {
                const parseSynthesisOutput = await performSynthesis(
                  message,
                  planningContext,
                  gatheredFragments,
                  messagesWithNoErrResponse,
                  logAndStreamReasoning,
                  sub,
                  attachmentFileIds,
                  agentPromptForLLM,
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

                if (isContextSufficient) {
                  // Context is complete. We can break the loop and generate the final answer.
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.LogMessage,
                    message:
                      "Context is sufficient. Proceeding to generate final answer.",
                  })
                  // The `continuationIterator` logic will now run after the loop breaks.
                } else {
                  // Context is Partial or NotFound. The loop will continue.
                  if (iterationCount < maxIterations) {
                    await logAndStreamReasoning({
                      type: AgentReasoningStepType.BroadeningSearch,
                      details: `Context is insufficient. Planning iteration ${
                        iterationCount + 1
                      }.`,
                    })
                    continue
                  } else {
                    // Follow-back tool activation: when iterations are exhausted and synthesis is not complete
                    if (planningContext.length > 0) {
                      try {
                        await logAndStreamReasoning({
                          type: AgentReasoningStepType.LogMessage,
                          message:
                            "Max iterations reached with incomplete synthesis. Activating follow-back search strategy...",
                        })

                        // Show what tools were used and their results
                        const toolExecutions = structuredReasoningSteps.filter(
                          (step) =>
                            step.type ===
                              AgentReasoningStepType.ToolExecuting ||
                            step.type === AgentReasoningStepType.ToolResult,
                        )

                        if (toolExecutions.length > 0) {
                          await logAndStreamReasoning({
                            type: AgentReasoningStepType.LogMessage,
                            message: `Previous search attempts: Used ${toolExecutions.filter((s) => s.type === AgentReasoningStepType.ToolExecuting).length} tools, gathered ${gatheredFragments.length} context fragments.`,
                          })
                        }

                        // Prepare fallback tool parameters with more detailed context
                        const toolLog = structuredReasoningSteps
                          .filter(
                            (step) =>
                              step.type ===
                                AgentReasoningStepType.ToolExecuting ||
                              step.type === AgentReasoningStepType.ToolResult,
                          )
                          .map(convertReasoningStepToText)
                          .join("\n")

                        const fallbackParams = {
                          originalQuery: message,
                          agentScratchpad: agentScratchpad,
                          toolLog: toolLog,
                          gatheredFragments: planningContext,
                        }

                        await logAndStreamReasoning({
                          type: AgentReasoningStepType.ToolExecuting,
                          toolName: AgentToolName.FallBack,
                        })

                        // Execute fallback tool
                        const fallbackResponse = await agentTools[
                          "fall_back"
                        ].execute(
                          fallbackParams,
                          streamSpan.startSpan("fallback_search_execution"),
                          email,
                          ctx,
                          agentPromptForLLM,
                          message,
                        )

                        await logAndStreamReasoning({
                          type: AgentReasoningStepType.ToolResult,
                          toolName: AgentToolName.FallBack,
                          resultSummary: fallbackResponse.result,
                          itemsFound: fallbackResponse.contexts?.length || 0,
                          error: fallbackResponse.error,
                        })

                        // Store fallback reasoning separately - don't add to gathered fragments
                        if (fallbackResponse.fallbackReasoning) {
                          fallbackReasoning = fallbackResponse.fallbackReasoning

                          await logAndStreamReasoning({
                            type: AgentReasoningStepType.LogMessage,
                            message: `✓ Fallback analysis completed! Generated detailed reasoning about search limitations.`,
                          })

                          await logAndStreamReasoning({
                            type: AgentReasoningStepType.LogMessage,
                            message:
                              "Will provide explanation about why we couldn't find sufficient information.",
                          })
                        } else {
                          await logAndStreamReasoning({
                            type: AgentReasoningStepType.LogMessage,
                            message:
                              "Fallback analysis completed but no reasoning generated.",
                          })
                        }
                      } catch (followBackError) {
                        Logger.error(
                          followBackError,
                          "Error during followBack tool execution",
                        )
                        await logAndStreamReasoning({
                          type: AgentReasoningStepType.LogMessage,
                          message: `Follow-back search failed: ${getErrorMessage(followBackError)}. Will generate best-effort answer.`,
                        })
                      }
                    } else {
                      await logAndStreamReasoning({
                        type: AgentReasoningStepType.LogMessage,
                        message:
                          "Max iterations reached with no context gathered. Will generate best-effort answer.",
                      })
                    }
                  }
                }
              } else {
                // This `else` block runs if `planningContext` is empty after a tool call.
                // This means we have found nothing so far. We must continue.
                if (iterationCount < maxIterations) {
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.BroadeningSearch,
                    details: "No context found yet. Planning next iteration.",
                  })
                  continue
                }
              }

              answered = true

              if (answer.length) {
                break
              }
            } else {
              // If no tool was selected, it's also a form of being stuck or unable to proceed.
              // Increment failure count for the "no tool selected" state if it's consecutive.
              const lastCall = previousToolCalls[previousToolCalls.length - 1]
              if (lastCall && lastCall.tool === "NoToolSelected") {
                lastCall.failureCount++
              } else {
                previousToolCalls.push({
                  tool: "NoToolSelected",
                  args: {},
                  failureCount: 1,
                })
              }

              if (iterationCount < maxIterations) {
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.LogMessage,
                  message: `No tool selected. Re-planning.`,
                })
                const parseSynthesisOutput = await performSynthesis(
                  message,
                  planningContext,
                  gatheredFragments,
                  messagesWithNoErrResponse,
                  logAndStreamReasoning,
                  sub,
                  attachmentFileIds,
                  agentPromptForLLM,
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

                if (isContextSufficient) {
                  // Context is complete. We can break the loop and generate the final answer.
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.LogMessage,
                    message:
                      "Context is sufficient. Proceeding to generate final answer.",
                  })
                  break
                }
                continue
              } else {
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.LogMessage,
                  message: `No tool selected for ${iterationCount}. Generating answer with available context.`,
                })
                answered = true // Break the loop to generate the final answer
              }
            }
          }

          const continuationIterator = getToolContinuationIterator(
            message,
            ctx,
            toolsPrompt,
            lastToolOutput || planningContext || "",
            gatheredFragments,
            agentPromptForLLM,
            messagesWithNoErrResponse,
            fallbackReasoning,
            attachmentFileIds,
            email,
          )
          for await (const chunk of continuationIterator) {
            try {
              if (stream.closed) {
                loggerWithChild({ email: sub }).info(
                  "[MessageApi] Stream closed during conversation search loop. Breaking.",
                )
                wasStreamClosedPrematurely = true
                break
              }
              if (chunk.text) {
                // if (reasoning && chunk.reasoning) {
                //   thinking += chunk.text
                //   stream.writeSSE({
                //     event: ChatSSEvents.Reasoning,
                //     data: chunk.text,
                //   })
                //   // reasoningSpan.end()
                // }
                // if (!chunk.reasoning) {
                //   answer += chunk.text
                //   stream.writeSSE({
                //     event: ChatSSEvents.ResponseUpdate,
                //     data: chunk.text,
                //   })
                // }
                answer += chunk.text

                // Additional safeguard: If we have web scraper content but answer contains PDF access errors, log it
                if (
                  gatheredFragments.some(
                    (f) => f.id && f.id.includes("web_scraper"),
                  ) &&
                  answer.toLowerCase().includes("cannot access") &&
                  answer.toLowerCase().includes("pdf")
                ) {
                  loggerWithChild({ email: sub }).warn(
                    `[DEBUG] Detected PDF access error in answer despite having web scraper content. Answer: ${answer.substring(0, 200)}...`,
                  )
                }

                await stream.writeSSE({
                  event: ChatSSEvents.ResponseUpdate,
                  data: chunk.text,
                })
              }
              if (chunk.citation) {
                const { index, item } = chunk.citation
                citations.push(item)
                citationMap[index] = citations.length - 1
                loggerWithChild({ email: sub }).info(
                  `Found citations and sending it, current count: ${citations.length}`,
                )
                await stream.writeSSE({
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
                await stream.writeSSE({
                  event: ChatSSEvents.ImageCitationUpdate,
                  data: JSON.stringify(chunk.imageCitation),
                })
              }

              if (chunk.cost) {
                costArr.push(chunk.cost)
              }
            } catch (chunkProcessingError) {
              loggerWithChild({ email: sub }).error(
                chunkProcessingError,
                `Error processing chunk in continuation iterator: ${getErrorMessage(chunkProcessingError)}`,
              )
              // Continue processing other chunks instead of failing completely
              continue
            }
          }

          loggerWithChild({ email: sub }).info(
            `[MessageApi] Continuation iterator completed. Answer length: ${answer.length}, wasStreamClosedPrematurely: ${wasStreamClosedPrematurely}, gatheredFragments: ${gatheredFragments.length}`,
          )

          if (answer || wasStreamClosedPrematurely) {
            // Determine if a message (even partial) should be saved
            // TODO: incase user loses permission
            // to one of the citations what do we do?
            // somehow hide that citation and change
            // the answer to reflect that
            const reasoningLog = structuredReasoningSteps
              .map(convertReasoningStepToText)
              .join("\n")

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
              thinking: reasoningLog,
              modelId:
                ragPipelineConfig[RagPipelineStages.AnswerOrRewrite].modelId,
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
            loggerWithChild({ email: sub }).info(
              `[MessageApi] Inserted trace for message ${msg.externalId} (premature: ${wasStreamClosedPrematurely}).`,
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
          loggerWithChild({ email: sub }).error(
            error,
            `Streaming Error: ${(error as Error).message} ${
              (error as Error).stack
            }`,
          )
          streamErrorSpan.end()
          streamSpan.end()
          rootSpan.end()
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

          // Ensure stream is removed from the map on completion or error
          if (streamKey && activeStreams.has(streamKey)) {
            activeStreams.delete(streamKey)
            loggerWithChild({ email: sub }).info(
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
        loggerWithChild({ email: sub }).error(
          err,
          `Streaming Error: ${err.message} ${(err as Error).stack}`,
        )

        // Ensure stream is removed from the map in the error callback too
        if (streamKey && activeStreams.has(streamKey)) {
          activeStreams.delete(streamKey)
          loggerWithChild({ email: sub }).info(
            `Removed stream ${streamKey} from active streams map in error callback.`,
          )
        }
        streamErrorSpan.end()
        rootSpan.end()
      },
    )
  } catch (error) {
    loggerWithChild({ email: email }).error(
      error,
      `MessageApi Error occurred.. ${error}`,
    )
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
        loggerWithChild({ email: email }).error(
          error,
          "You exceeded your current quota",
        )
        if (stream) {
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: errFromMap,
          })
        }
      }
    } else {
      loggerWithChild({ email: email }).error(
        error,
        `Message Error: ${errMsg} ${(error as Error).stack}`,
      )
      throw new HTTPException(500, {
        message: "Could not create message or Chat",
      })
    }
    // Ensure stream is removed from the map in the top-level catch block
    if (streamKey && activeStreams.has(streamKey)) {
      activeStreams.delete(streamKey)
      loggerWithChild({ email: email }).info(
        `Removed stream ${streamKey} from active streams map in top-level catch.`,
      )
    }
    errorSpan.end()
    rootSpan.end()
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

  const previousResultsLength = 0
  let buffer = ""
  let thinking = ""
  let reasoning = isReasoning
  let yieldedCitations = new Set<number>()
  let yieldedImageCitations = new Set<number>()

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
              previousResultsLength,
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
                previousResultsLength,
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
            previousResultsLength,
            yieldedImageCitations,
            email ?? "",
          )
        }
      }

      if (chunk.cost) {
        yield { cost: chunk.cost }
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
        }

        if (answer) {
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
          })
          assistantMessageId = msg.externalId
        } else {
          const errorMessage =
            "There seems to be an issue on our side. Please try again after some time."
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
              app: "",
              entity: "",
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
                  app: parsed.filters?.app as Apps,
                  entity: parsed.filters?.entity as any,
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
