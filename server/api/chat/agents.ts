import {
  answerContextMap,
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
} from "@/ai/provider"
import { getConnectorByExternalId, getConnectorByApp } from "@/db/connector"
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
  deleteChatByExternalId,
  deleteMessagesByChatId,
  getChatByExternalId,
  getPublicChats,
  insertChat,
  updateChatByExternalId,
  updateMessageByExternalId,
} from "@/db/chat"
import { db } from "@/db/client"
import {
  getChatMessages,
  insertMessage,
  getMessageByExternalId,
  getChatMessagesBefore,
  updateMessage,
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
  type AgentReasoningStep,
  type MessageReqType,
} from "@/shared/types"
import { MessageRole, Subsystem } from "@/types"
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
} from "@/search/vespa"
import {
  Apps,
  CalendarEntity,
  chatMessageSchema,
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
} from "@/search/types"
import { APIError } from "openai"
import {
  getChatTraceByExternalId,
  insertChatTrace,
  deleteChatTracesByChatExternalId,
  updateChatTrace,
} from "@/db/chatTrace"

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
  type MinimalAgentFragment,
} from "./types"
import {
  convertReasoningStepToText,
  extractFileIdsFromMessage,
  flattenObject,
  handleError,
  isMessageWithContext,
  processMessage,
  searchToCitation,
} from "./utils"
export const textToCitationIndex = /\[(\d+)\]/g
import config from "@/config"
import {
  buildUserQuery,
  isContextSelected,
  UnderstandMessageAndAnswer,
  UnderstandMessageAndAnswerForGivenContext,
} from "./chat"
import { agentTools } from "./tools"
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
const checkAndYieldCitationsForAgent = function* (
  textInput: string,
  yieldedCitations: Set<number>,
  results: MinimalAgentFragment[],
  baseIndex: number = 0,
) {
  const text = splitGroupedCitationsWithSpaces(textInput)
  let match
  while ((match = textToCitationIndex.exec(text)) !== null) {
    const citationIndex = parseInt(match[1], 10)
    if (!yieldedCitations.has(citationIndex)) {
      const item = results[citationIndex - 1]
      console.log(results, citationIndex - 1)
      if (item.source.docId) {
        yield {
          citation: {
            index: citationIndex,
            item: item.source,
          },
        }
        yieldedCitations.add(citationIndex)
      } else {
        Logger.error(
          "Found a citation index but could not find it in the search result ",
          citationIndex,
          results.length,
        )
      }
    }
  }
}

async function* getToolContinuationIterator(
  message: string,
  userCtx: string,
  toolsPrompt: string,
  toolOutput: string,
  results: MinimalAgentFragment[],
  agentPrompt?: string, // New optional parameter
): AsyncIterableIterator<
  ConverseResponse & { citation?: { index: number; item: any } }
> {
  const continuationIterator = generateAnswerBasedOnToolOutput(
    message,
    userCtx,
    {
      modelId: ragPipelineConfig[RagPipelineStages.AnswerOrSearch].modelId,
      stream: true,
      json: true,
      reasoning: false,
    },
    toolsPrompt,
    toolOutput ?? "",
    agentPrompt, // Pass agentPrompt
  )

  const previousResultsLength = 0 // todo fix this
  let buffer = ""
  let currentAnswer = ""
  let parsed = { answer: "" }
  let thinking = ""
  let reasoning = config.isReasoning
  let yieldedCitations = new Set<number>()
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
        parsed = jsonParseLLMOutput(buffer, ANSWER_TOKEN)
        // If we have a null answer, break this inner loop and continue outer loop
        // seen some cases with just "}"
        if (parsed.answer === null || parsed.answer === "}") {
          break
        }

        // If we have an answer and it's different from what we've seen
        if (parsed.answer && currentAnswer !== parsed.answer) {
          if (currentAnswer === "") {
            // First valid answer - send the whole thing
            yield { text: parsed.answer }
          } else {
            // Subsequent chunks - send only the new part
            const newText = parsed.answer.slice(currentAnswer.length)
            yield { text: newText }
          }
          yield* checkAndYieldCitationsForAgent(
            parsed.answer,
            yieldedCitations,
            results,
            previousResultsLength,
          )
          currentAnswer = parsed.answer
        }
      } catch (e) {
        // If we can't parse the JSON yet, continue accumulating
        continue
      }
      // }
    }

    if (chunk.cost) {
      yield { cost: chunk.cost }
    }
  }
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

  let email = ""
  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    email = sub
    loggerWithChild({ email: email }).info("MessageApi..")
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    // @ts-ignore
    const body = c.req.valid("query")
    const isAgentic = c.req.query("agentic") === "true"
    let {
      message,
      chatId,
      modelId,
      isReasoningEnabled,
      toolExternalIds,
      agentId,
    }: MessageReqType = body
    const agentPromptValue = agentId && isCuid(agentId) ? agentId : undefined
    loggerWithChild({ email: sub }).info(
      `getting mcp create with body: ${JSON.stringify(body)}`,
    )
    // const userRequestsReasoning = isReasoningEnabled // Addressed: Will be used below
    const isMsgWithContext = isMessageWithContext(message)
    const extractedInfo = isMsgWithContext
      ? await extractFileIdsFromMessage(message)
      : {
          totalValidFileIdsFromLinkCount: 0,
          fileIds: [],
        }
    const fileIds = extractedInfo?.fileIds
    const totalValidFileIdsFromLinkCount =
      extractedInfo?.totalValidFileIdsFromLinkCount

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

          let existingChat = await updateChatByExternalId(db, chatId, {})
          let allMessages = await getChatMessages(tx, chatId)

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
          const maxIterations = 9
          let iterationCount = 0
          let answered = false

          await logAndStreamReasoning({
            type: AgentReasoningStepType.LogMessage,
            message: `Analyzing your query...`,
          })
          // once we start getting toolsList will remove the above code
          if (toolExternalIds && toolExternalIds.length > 0) {
            // Fetch connector info and create client
            const connector = await getConnectorByApp(
              db,
              user.id,
              Apps.GITHUB_MCP,
            )

            const config = connector.config as any
            const client = new Client({
              name: `connector-${connector.id}`,
              version: config.version,
            })
            await client.connect(
              new StdioClientTransport({
                command: config.command,
                args: config.args,
              }),
            )

            // Fetch all available tools from the client
            // TODO: look in the DB. cache logic has to be discussed.

            const tools = await getToolsByConnectorId(
              db,
              workspace.id,
              connector.id,
            )
            // Filter to only the requested tools, or use all tools if toolNames is empty
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
            // Update tool definitions in the database for future use
            // await syncConnectorTools(
            //   db,
            //   workspace.id,
            //   connector.id,
            //   filteredTools.map((tool) => ({
            //     toolName: tool.tool_name,
            //     toolSchema: JSON.stringify(tool),
            //     description: tool.description ?? "",
            //   })),
            // )
          }
          let answer = ""
          let currentAnswer = ""
          let citations = []
          let citationMap: Record<number, number> = {}
          let citationValues: Record<number, string> = {}
          let thinking = ""
          let reasoning =
            ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning
          let gatheredFragments: MinimalAgentFragment[] = []
          let excludedIds: string[] = [] // To track IDs of retrieved documents
          let agentScratchpad = "" // To build the reasoning history for the prompt
          const previousToolCalls: { tool: string; args: string }[] = []
          while (iterationCount <= maxIterations && !answered) {
            if (stream.closed) {
              loggerWithChild({ email: sub }).info(
                "[MessageApi] Stream closed during conversation search loop. Breaking.",
              )
              wasStreamClosedPrematurely = true
              break
            }
            let buffer = ""
            let parsed = {
              answer: "",
              tool: "",
              arguments: {} as any,
            }
            iterationCount++

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
                        `[Fragment ${i + 1}] (Source Doc ID: ${f.source.docId})\n` +
                        `  - Title: ${f.source.title || "Untitled"}\n` +
                        // Truncate content in the scratchpad to keep the prompt concise.
                        // The full content is available in `planningContext` for the final answer.
                        `  - Content Snippet: "${f.content.substring(0, 100)}"`,
                    )
                    .join("\n\n")
                : "\n--- NO EVIDENCE GATHERED YET ---"

            if (previousToolCalls.length) {
              loopWarningPrompt = `
                   ---
                   **Critique Past Actions:** You have already called some tools ${previousToolCalls.map((toolCall, idx) => `[Iteration-${idx}] Tool: ${toolCall.tool}, Args: ${JSON.stringify(toolCall.args)}`).join("\n")}  and the result was insufficient. You are in a loop. You MUST choose a appropriate tool to resolve user query.
                 You **MUST** change your strategy.
                  For example: 
                    1.  Choose a **DIFFERENT TOOL**.
                    2.  Use the **SAME TOOL** but with **DIFFERENT ARGUMENTS**.
  
                  Do NOT make this call again. Formulate a new, distinct plan.
                   ---
                `
            }

            agentScratchpad =
              evidenceSummary + loopWarningPrompt + reasoningHeader

            let toolsPrompt = ""
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
                      toolsPrompt += `${constructToolContext(parsedTool.data.toolSchema)}\n\n`
                    }
                  }
                }
              }
            }

            const getToolOrAnswerIterator = generateToolSelectionOutput(
              message,
              ctx,
              toolsPrompt,
              agentScratchpad,
              {
                modelId: defaultBestModel,
                stream: true,
                json: true,
                reasoning:
                  ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning,
                messages: messagesWithNoErrResponse,
              },
              agentPromptForLLM,
            )

            for await (const chunk of getToolOrAnswerIterator) {
              if (stream.closed) {
                loggerWithChild({ email: sub }).info(
                  "[MessageApi] Stream closed during conversation search loop. Breaking.",
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
                        loggerWithChild({ email: sub }).info(
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
                    loggerWithChild({ email: sub }).error(
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

            if (parsed.tool && !parsed.answer) {
              await logAndStreamReasoning({
                type: AgentReasoningStepType.Iteration,
                iteration: iterationCount,
              })
              await logAndStreamReasoning({
                type: AgentReasoningStepType.Planning,
                details: `Planning next step with ${gatheredFragments.length} context fragments.`,
              })
              const toolName = parsed.tool
              const toolParams = parsed.arguments
              previousToolCalls.push({
                tool: toolName,
                args: toolParams,
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

                try {
                  toolExecutionResponse = await agentTools[toolName].execute(
                    toolParams,
                    toolExecutionSpan,
                    email,
                    ctx,
                    agentPromptForLLM,
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

                    // --- Process and Normalize the MCP Response ---
                    let formattedContent = "Tool returned no parsable content."
                    let newFragments: MinimalAgentFragment[] = []

                    // Safely parse the response text
                    try {
                      if (
                        mcpToolResponse.content &&
                        mcpToolResponse.content[0] &&
                        mcpToolResponse.content[0].text
                      ) {
                        const parsedJson = JSON.parse(
                          mcpToolResponse.content[0].text,
                        )
                        formattedContent = flattenObject(parsedJson)
                          .map(([key, value]) => `- ${key}: ${value}`)
                          .join("\n")

                        // Convert the formatted response into a standard MinimalAgentFragment
                        const fragmentId = `mcp-${connectorId}-${toolName}}`
                        newFragments.push({
                          id: fragmentId,
                          content: formattedContent,
                          source: {
                            app: Apps.GITHUB_MCP, // Or derive dynamically if possible
                            docId: "", // Use a unique ID for the doc
                            title: `Output from tool: ${toolName}`,
                            entity: SystemEntity.SystemInfo,
                          },
                          confidence: 1.0,
                        })
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
                      result: `Tool ${toolName} executed. \n Summary: ${formattedContent.substring(0, 200)}...`,
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
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.ToolResult,
                  toolName: toolName as AgentToolName,
                  resultSummary: toolExecutionResponse.result,
                  itemsFound: toolExecutionResponse.contexts?.length || 0,
                  error: toolExecutionResponse.error,
                })

                if (toolExecutionResponse.error) {
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

              const planningContext = gatheredFragments.length
                ? gatheredFragments
                    .map(
                      (f, i) =>
                        `[${i + 1}] ${f.source.title || `Source ${f.source.docId}`}: ${
                          f.content
                        }...`,
                    )
                    .join("\n")
                : ""

              if (planningContext.length) {
                type SynthesisResponse = {
                  synthesisState:
                    | ContextSysthesisState.Complete
                    | ContextSysthesisState.Partial
                    | ContextSysthesisState.NotFound
                  answer: string | null
                }
                let parseSynthesisOutput: SynthesisResponse | null = null

                try {
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.Synthesis,
                    details: `Synthesizing answer from ${gatheredFragments.length} fragments...`,
                  })

                  const synthesisResponse =
                    await generateSynthesisBasedOnToolOutput(
                      ctx,
                      message,
                      planningContext,
                      {
                        modelId: defaultFastModel,
                        stream: false,
                        json: true,
                        reasoning: false,
                      },
                    )

                  if (synthesisResponse.text) {
                    try {
                      parseSynthesisOutput = jsonParseLLMOutput(
                        synthesisResponse.text,
                      )
                      if (
                        !parseSynthesisOutput ||
                        !parseSynthesisOutput.synthesisState
                      ) {
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

                await logAndStreamReasoning({
                  type: AgentReasoningStepType.LogMessage,
                  message: `Synthesis result: ${parseSynthesisOutput.synthesisState}`,
                })
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.LogMessage,
                  message: ` Synthesis: ${parseSynthesisOutput.answer || "No Synthesis details"}`,
                })
                const isContextSufficient =
                  parseSynthesisOutput.synthesisState ===
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
                      details: `Context is insufficient. Planning iteration ${iterationCount + 1}.`,
                    })
                    continue
                  } else {
                    // We've hit the max iterations with insufficient context
                    await logAndStreamReasoning({
                      type: AgentReasoningStepType.LogMessage,
                      message:
                        "Max iterations reached with partial context. Will generate best-effort answer.",
                    })
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
              const continuationIterator = getToolContinuationIterator(
                message,
                ctx,
                toolsPrompt,
                planningContext ?? "",
                gatheredFragments,
                agentPromptForLLM,
              )
              for await (const chunk of continuationIterator) {
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
                  stream.writeSSE({
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
                  stream.writeSSE({
                    event: ChatSSEvents.CitationsUpdate,
                    data: JSON.stringify({
                      contextChunks: citations,
                      citationMap,
                    }),
                  })
                  citationValues[index] = item
                }
                if (chunk.cost) {
                  costArr.push(chunk.cost)
                }
              }
              if (answer.length) {
                break
              }
            } else if (parsed.answer) {
              answer = parsed.answer
              break
            }
          }

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
            const allMessages = await getChatMessages(db, chat?.externalId)
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
          const allMessages = await getChatMessages(db, chat?.externalId)
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
        const allMessages = await getChatMessages(db, chat?.externalId)
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
          const allMessages = await getChatMessages(db, errorChatId)
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
      const allMessages = await getChatMessages(db, chat?.externalId)
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

// END OF AgentMessageApi
// The new CombinedAgentSlackApi function will be inserted after this comment.

export const AgentMessageApi = async (c: Context) => {
  // we will use this in catch
  // if the value exists then we send the error to the frontend via it
  const tracer: Tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("AgentMessageApi")

  let stream: any
  let chat: SelectChat
  let assistantMessageId: string | null = null
  let streamKey: string | null = null

  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    // @ts-ignore
    const body = c.req.valid("query")
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
      ? await extractFileIdsFromMessage(message)
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

          let existingChat = await updateChatByExternalId(db, chatId, {})
          let allMessages = await getChatMessages(tx, chatId)

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

          if (isMsgWithContext && fileIds && fileIds?.length > 0) {
            Logger.info(
              "User has selected some context with query, answering only based on that given context",
            )
            let answer = ""
            let citations = []
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
                    data: `Skipping last ${totalValidFileIdsFromLinkCount - maxValidLinks} links as it exceeds max limit of ${maxValidLinks}. `,
                  })
                }
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
              const allMessages = await getChatMessages(db, chat?.externalId)
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
                  ...parsed?.filters,
                  app: parsed.filters?.app as Apps,
                  entity: parsed.filters?.entity as any,
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
              const allMessages = await getChatMessages(db, chat?.externalId)
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
          const allMessages = await getChatMessages(db, chat?.externalId)
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
            `Streaming Error: ${(error as Error).message} ${(error as Error).stack}`,
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
        const allMessages = await getChatMessages(db, chat?.externalId)
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
          const allMessages = await getChatMessages(db, errorChatId)
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
      const allMessages = await getChatMessages(db, chat?.externalId)
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

export const CombinedAgentSlackApi = async (c: Context) => {
  const tracer: Tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("CombinedAgentSlackApi")

  let stream: any
  let chat: SelectChat
  let assistantMessageId: string | null = null
  let streamKey: string | null = null
  console.log("CombinedAgentSlackApi called")
  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub
    rootSpan.setAttribute("email", email)
    rootSpan.setAttribute("workspaceId", workspaceId)

    // @ts-ignore
    const body = c.req.valid("query")
    let {
      message,
      chatId,
      modelId,
      toolExternalIds,
      isReasoningEnabled,
      agentId, // Added for agent processing
    }: MessageReqType = body
    Logger.info(`getting mcp create with body: ${JSON.stringify(body)}`)

    const isMsgWithContext = isMessageWithContext(message)
    const extractedInfo = isMsgWithContext
      ? await extractFileIdsFromMessage(message)
      : {
          totalValidFileIdsFromLinkCount: 0,
          fileIds: [],
        }
    const fileIds = extractedInfo?.fileIds
    // const totalValidFileIdsFromLinkCount = // This was unused in MessageWithToolsApi
    //   extractedInfo?.totalValidFileIdsFromLinkCount

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

    // Agent-specific logic from AgentMessageApi
    let agentPromptForLLM: string | undefined = undefined
    let agentForDb: SelectAgent | null = null
    if (agentId && isCuid(agentId)) {
      agentForDb = await getAgentByExternalId(db, agentId, workspace.id)
      if (agentForDb) {
        // Assuming router already checked for 'slack' integration.
        // If not, a check like below could be added, or throw an error.
        // if (!(agentForDb.appIntegrations && agentForDb.appIntegrations.includes('slack'))) {
        //   Logger.warn(`CombinedAgentSlackApi called for agent ${agentId} without slack integration.`);
        //   // Potentially fall back to AgentMessageApi or error out
        // }
        agentPromptForLLM = JSON.stringify(agentForDb)
      } else {
        Logger.warn(
          `Agent with id ${agentId} not found for workspace ${workspace.id}`,
        )
      }
    }
    const agentIdToStore = agentForDb ? agentForDb.externalId : null

    let messages: SelectMessage[] = []
    const costArr: number[] = []
    const ctx = userContext(userAndWorkspace)

    let title = ""
    const chatCreationSpan = rootSpan.startSpan("chatCreationSpan")
    if (!chatId) {
      const titleSpan = chatCreationSpan.startSpan("generate_title")
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
            agentId: agentIdToStore, // Store agentId with chat
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
          return [chat, insertedMsg]
        },
      )
      Logger.info(
        "First message of the conversation, successfully created the chat",
      )
      chat = insertedChat
      messages.push(insertedMsg)
      chatCreationSpan.end()
    } else {
      let [existingChat, allMessages, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage[], SelectMessage]> => {
          let existingChat = await updateChatByExternalId(db, chatId, {})
          let allMessages = await getChatMessages(tx, chatId)
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
      messages = allMessages.concat(insertedMsg)
      chat = existingChat
      chatCreationSpan.end()
    }
    return streamSSE(
      c,
      async (streamInstance) => {
        // Renamed stream to streamInstance to avoid conflict
        stream = streamInstance // Assign to outer scope stream
        let finalReasoningLogString = ""
        let agentLog: string[] = []
        let structuredReasoningSteps: AgentReasoningStep[] = []
        const logAndStreamReasoning = async (
          reasoningStep: AgentReasoningStep,
        ) => {
          const humanReadableLog = convertReasoningStepToText(reasoningStep)
          agentLog.push(humanReadableLog)
          structuredReasoningSteps.push(reasoningStep)
          await stream.writeSSE({
            // Use the correct stream variable
            event: ChatSSEvents.Reasoning,
            data: convertReasoningStepToText(reasoningStep),
          })
        }

        streamKey = `${chat.externalId}`
        activeStreams.set(streamKey, stream)
        Logger.info(`Added stream ${streamKey} to active streams map.`)
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

          Logger.info("Chat stream started")
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chat.externalId,
            }),
          })

          let messagesWithNoErrResponse = messages
            .slice(0, messages.length - 1)
            .filter((msg) => !msg?.errorMessage)
            .map((m) => ({
              role: m.messageRole as ConversationRole,
              content: [{ text: m.message }],
            }))

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

          await logAndStreamReasoning({
            type: AgentReasoningStepType.LogMessage,
            message: `Analyzing your query...`,
          })

          if (toolExternalIds && toolExternalIds.length > 0) {
            const connector = await getConnectorByApp(
              db,
              user.id,
              Apps.GITHUB_MCP,
            )

            const config = connector.config as any
            const client = new Client({
              name: `connector-${connector.id}`,
              version: config.version,
            })
            await client.connect(
              new StdioClientTransport({
                command: config.command,
                args: config.args,
              }),
            )

            const tools = await getToolsByConnectorId(
              db,
              workspace.id,
              connector.id,
            )
            const filteredTools = tools.filter((tool) => {
              const isIncluded = toolExternalIds.includes(tool.externalId!)
              if (!isIncluded) {
                Logger.info(
                  `[CombinedAgentSlackApi] Tool ${tool.externalId}:${tool.toolName} not in requested toolExternalIds.`,
                )
              }
              return isIncluded
            })

            finalToolsList[connector.id] = {
              tools: filteredTools,
              client: client,
            }
          }
          let answer = ""
          let currentAnswer = ""
          let citations = []
          let citationMap: Record<number, number> = {}
          let citationValues: Record<number, string> = {}
          let thinking = ""
          let reasoning =
            ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning
          let gatheredFragments: MinimalAgentFragment[] = []
          let excludedIds: string[] = []
          let agentScratchpad = ""
          const previousToolCalls: { tool: string; args: string }[] = []
          while (iterationCount <= maxIterations && !answered) {
            if (stream.closed) {
              Logger.info(
                "[CombinedAgentSlackApi] Stream closed during conversation search loop. Breaking.",
              )
              wasStreamClosedPrematurely = true
              break
            }
            let buffer = ""
            let parsed = {
              answer: "",
              tool: "",
              arguments: {} as any,
            }
            iterationCount++

            let loopWarningPrompt = ""
            const evidenceSummary =
              gatheredFragments.length > 0
                ? `\n--- CURRENTLY GATHERED EVIDENCE (for final answer generation) ---\n` +
                  gatheredFragments
                    .map(
                      (f, i) =>
                        `[Fragment ${i + 1}] (Source Doc ID: ${f.source.docId})\n` +
                        `  - Title: ${f.source.title || "Untitled"}\n` +
                        `  - Content Snippet: "${f.content}"`,
                    )
                    .join("\n\n")
                : "\n--- NO EVIDENCE GATHERED YET ---"

            if (previousToolCalls.length) {
              loopWarningPrompt = `
                   ---
                   **CRITICAL WARNING:** You have already called some tools ${previousToolCalls.map((toolCall, idx) => `[Iteration-${idx}] Tool: ${toolCall.tool}, Args: ${JSON.stringify(toolCall.args)}`).join("\n")}  and the result was insufficient. You are in a loop. You MUST choose a appropriate tool to resolve user query.
                 You **MUST** change your strategy.
                  For example: 
                    1.  Choose a **DIFFERENT TOOL** (e.g., use a broader 'search' instead of 'metadata_retrieval').
                    2.  Use the **SAME TOOL** but with **DIFFERENT ARGUMENTS** (e.g., change keywords, remove filters, adjust the time range).
  
                  Do NOT make this call again. Formulate a new, distinct plan.
                   ---
                `
            }

            agentScratchpad =
              evidenceSummary +
              loopWarningPrompt +
              structuredReasoningSteps
                .map(convertReasoningStepToText)
                .join("\n")
            let toolsPrompt = ""
            if (Object.keys(finalToolsList).length > 0) {
              toolsPrompt = `While answering check if any below given AVAILABLE_TOOLS can be invoked to get more context to answer the user query more accurately, this is very IMPORTANT so you should check this properly based on the given tools information. 
                AVAILABLE_TOOLS:\n\n`
              for (const [connectorId, { tools }] of Object.entries(
                finalToolsList,
              )) {
                if (tools.length > 0) {
                  for (const tool of tools) {
                    const parsedTool = selectToolSchema.safeParse(tool)
                    if (parsedTool.success && parsedTool.data.toolSchema) {
                      toolsPrompt += `${constructToolContext(parsedTool.data.toolSchema)}\n\n`
                    }
                  }
                }
              }
            }

            const getToolOrAnswerIterator = generateToolSelectionOutput(
              message,
              ctx,
              toolsPrompt,
              agentScratchpad,
              {
                modelId: defaultBestModel,
                stream: true,
                json: true,
                reasoning:
                  ragPipelineConfig[RagPipelineStages.AnswerOrSearch].reasoning,
                messages: messagesWithNoErrResponse,
              },
              agentPromptForLLM, // Pass agentPromptForLLM
            )
            for await (const chunk of getToolOrAnswerIterator) {
              if (stream.closed) {
                Logger.info(
                  "[CombinedAgentSlackApi] Stream closed during conversation search loop. Breaking.",
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
                          "Direct answer from tool selection, not applying RAG.",
                        )
                        stream.writeSSE({
                          event: ChatSSEvents.Start,
                          data: "",
                        })
                        stream.writeSSE({
                          event: ChatSSEvents.ResponseUpdate,
                          data: parsed.answer,
                        })
                      } else {
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

            if (parsed.tool && !parsed.answer) {
              await logAndStreamReasoning({
                type: AgentReasoningStepType.Iteration,
                iteration: iterationCount,
              })
              await logAndStreamReasoning({
                type: AgentReasoningStepType.Planning,
                details: `Planning next step with ${gatheredFragments.length} context fragments.`,
              })
              const toolName = parsed.tool
              const toolParams = parsed.arguments
              previousToolCalls.push({
                tool: toolName,
                args: toolParams,
              })
              Logger.info(
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
                if (!toolParams?.filter_query) {
                  toolParams.filter_query = message
                }
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.ToolExecuting,
                  toolName: toolName as AgentToolName,
                })
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.ToolParameters,
                  parameters: toolParams as {},
                })
                try {
                  toolExecutionResponse = await agentTools[toolName].execute(
                    toolParams,
                    toolExecutionSpan,
                    email,
                    ctx,
                    agentPromptForLLM ?? "",
                  )
                } catch (error) {
                  const errMessage = getErrorMessage(error)
                  Logger.error(
                    error,
                    `Critical error executing internal agent tool ${toolName}: ${errMessage}`,
                  )
                  toolExecutionResponse = {
                    result: `Execution of tool ${toolName} failed critically.`,
                    error: errMessage,
                  }
                }
              } else {
                let foundClient: Client | null = null
                let connectorId: string | null = null
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
                  Logger.error(errorMsg)
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.ValidationError,
                    details: errorMsg,
                  })
                  toolExecutionResponse = {
                    result: `Error: Could not find the specified tool '${toolName}'.`,
                    error: "Tool not found",
                  }
                } else {
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.ToolExecuting,
                    toolName: toolName as AgentToolName,
                  })
                  try {
                    if ("perPage" in toolParams) {
                      if (toolParams.perPage && toolParams.perPage > 10) {
                        await logAndStreamReasoning({
                          type: AgentReasoningStepType.LogMessage,
                          message: `Detected perPage ${toolParams.perPage} in arguments for tool ${toolName}`,
                        })
                        toolParams.perPage = 10
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

                    try {
                      if (
                        mcpToolResponse.content &&
                        mcpToolResponse.content[0] &&
                        mcpToolResponse.content[0].text
                      ) {
                        const parsedJson = JSON.parse(
                          mcpToolResponse.content[0].text,
                        )
                        formattedContent = flattenObject(parsedJson)
                          .map(([key, value]) => `- ${key}: ${value}`)
                          .join("\n")
                        const fragmentId = `mcp-${connectorId}-${toolName}}`
                        newFragments.push({
                          id: fragmentId,
                          content: formattedContent,
                          source: {
                            app: Apps.GITHUB_MCP,
                            docId: "",
                            title: `Output from tool: ${toolName}`,
                            entity: SystemEntity.SystemInfo,
                          },
                          confidence: 1.0,
                        })
                      }
                    } catch (parsingError) {
                      Logger.error(
                        parsingError,
                        `Could not parse response from MCP tool ${toolName} as JSON.`,
                      )
                      formattedContent =
                        "Tool response was not valid JSON and could not be processed."
                    }
                    toolExecutionResponse = {
                      result: `Tool ${toolName} executed. \n Summary: ${formattedContent.substring(0, 200)}...`,
                      contexts: newFragments,
                    }
                  } catch (error) {
                    const errMessage = getErrorMessage(error)
                    Logger.error(
                      error,
                      `Error invoking external tool ${toolName}: ${errMessage}`,
                    )
                    toolExecutionResponse = {
                      result: `Execution of tool ${toolName} failed.`,
                      error: errMessage,
                    }
                  }
                }
              }
              toolExecutionSpan.end()

              await logAndStreamReasoning({
                type: AgentReasoningStepType.ToolResult,
                toolName: toolName as AgentToolName,
                resultSummary: toolExecutionResponse.result,
                itemsFound: toolExecutionResponse.contexts?.length || 0,
                error: toolExecutionResponse.error,
              })

              if (toolExecutionResponse.error) {
                if (iterationCount < maxIterations) {
                  continue
                } else {
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
                const newIds = newFragments.map((f) => f.id).filter(Boolean)
                excludedIds = [...new Set([...excludedIds, ...newIds])]
              }

              const planningContext = gatheredFragments.length
                ? gatheredFragments
                    .map(
                      (f, i) =>
                        `[${i + 1}] ${f.source.title || `Source ${f.source.docId}`}: ${
                          f.content
                        }...`,
                    )
                    .join("\n")
                : ""

              if (planningContext.length) {
                type SynthesisResponse = {
                  synthesisState:
                    | ContextSysthesisState.Complete
                    | ContextSysthesisState.Partial
                    | ContextSysthesisState.NotFound
                  answer: string | null
                }
                let parseSynthesisOutput: SynthesisResponse | null = null

                try {
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.Synthesis,
                    details: `Synthesizing answer from ${gatheredFragments.length} fragments...`,
                  })

                  const synthesisResponse =
                    await generateSynthesisBasedOnToolOutput(
                      ctx,
                      message,
                      planningContext,
                      {
                        modelId: defaultBestModel,
                        stream: false,
                        json: true,
                        reasoning: false,
                      },
                      agentPromptForLLM, // Pass agentPromptForLLM
                    )

                  if (synthesisResponse.text) {
                    try {
                      parseSynthesisOutput = jsonParseLLMOutput(
                        synthesisResponse.text,
                      )
                      if (
                        !parseSynthesisOutput ||
                        !parseSynthesisOutput.synthesisState
                      ) {
                        Logger.error(
                          "Synthesis response was valid JSON but missing 'synthesisState' key.",
                        )
                        parseSynthesisOutput = {
                          synthesisState: ContextSysthesisState.Partial,
                          answer: null,
                        }
                      }
                    } catch (jsonError) {
                      Logger.error(
                        jsonError,
                        "Failed to parse synthesis LLM output as JSON.",
                      )
                      parseSynthesisOutput = {
                        synthesisState: ContextSysthesisState.NotFound,
                        answer: parseSynthesisOutput?.answer || "",
                      }
                    }
                  } else {
                    Logger.error("Synthesis LLM call returned no text.")
                    parseSynthesisOutput = {
                      synthesisState: ContextSysthesisState.Partial,
                      answer: "",
                    }
                  }
                } catch (synthesisError) {
                  Logger.error(
                    synthesisError,
                    "Error during synthesis LLM call.",
                  )
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.LogMessage,
                    message: `Synthesis failed: No relevant information found. Attempting to gather more data.`,
                  })
                  parseSynthesisOutput = {
                    synthesisState: ContextSysthesisState.Partial,
                    answer: parseSynthesisOutput?.answer || "",
                  }
                }

                await logAndStreamReasoning({
                  type: AgentReasoningStepType.LogMessage,
                  message: `Synthesis result: ${parseSynthesisOutput.synthesisState}`,
                })
                await logAndStreamReasoning({
                  type: AgentReasoningStepType.LogMessage,
                  message: ` Synthesis: ${parseSynthesisOutput.answer || "No Synthesis details"}`,
                })
                const isContextSufficient =
                  parseSynthesisOutput.synthesisState ===
                  ContextSysthesisState.Complete

                if (isContextSufficient) {
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.LogMessage,
                    message:
                      "Context is sufficient. Proceeding to generate final answer.",
                  })
                } else {
                  if (iterationCount < maxIterations) {
                    await logAndStreamReasoning({
                      type: AgentReasoningStepType.BroadeningSearch,
                      details: `Context is insufficient. Planning iteration ${iterationCount + 1}.`,
                    })
                    continue
                  } else {
                    await logAndStreamReasoning({
                      type: AgentReasoningStepType.LogMessage,
                      message:
                        "Max iterations reached with partial context. Will generate best-effort answer.",
                    })
                  }
                }
              } else {
                if (iterationCount < maxIterations) {
                  await logAndStreamReasoning({
                    type: AgentReasoningStepType.BroadeningSearch,
                    details: "No context found yet. Planning next iteration.",
                  })
                  continue
                }
              }

              answered = true
              const continuationIterator = getToolContinuationIterator(
                message,
                ctx,
                toolsPrompt,
                planningContext ?? "",
                gatheredFragments,
                agentPromptForLLM, // Pass agentPromptForLLM
              )
              for await (const chunk of continuationIterator) {
                if (stream.closed) {
                  Logger.info(
                    "[CombinedAgentSlackApi] Stream closed during continuation. Breaking.",
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
                if (chunk.cost) {
                  costArr.push(chunk.cost)
                }
              }
              if (answer.length) {
                break
              }
            } else if (parsed.answer) {
              answer = parsed.answer
              break
            }
          }

          if (answer || wasStreamClosedPrematurely) {
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
            Logger.info(
              `[CombinedAgentSlackApi] Inserted trace for message ${msg.externalId} (premature: ${wasStreamClosedPrematurely}).`,
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
            const allMessages = await getChatMessages(db, chat?.externalId)
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
          const allMessages = await getChatMessages(db, chat?.externalId)
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
          if (streamKey && activeStreams.has(streamKey)) {
            activeStreams.delete(streamKey)
            Logger.info(`Removed stream ${streamKey} from active streams map.`)
          }
        }
      },
      async (err, streamInstance) => {
        // Renamed stream to streamInstance
        stream = streamInstance // Assign to outer scope stream
        const streamErrorSpan = rootSpan.startSpan(
          "handle_stream_callback_error",
        )
        streamErrorSpan.addEvent("error", {
          message: getErrorMessage(err),
          stack: (err as Error).stack || "",
        })
        const errFromMap = handleError(err)
        const allMessages = await getChatMessages(db, chat?.externalId)
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
          const freshMessages = await getChatMessages(db, errorChatId)
          if (freshMessages.length > 0) {
            const freshLastMessage = freshMessages[freshMessages.length - 1]
            await addErrMessageToMessage(freshLastMessage, errFromMap)
          }
        }
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: errFromMap,
        })
        // await addErrMessageToMessage(lastMessage, errFromMap) // Potentially redundant if freshLastMessage is same

        await stream.writeSSE({
          data: "",
          event: ChatSSEvents.End,
        })
        Logger.error(
          err,
          `Streaming Error: ${err.message} ${(err as Error).stack}`,
        )
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
    Logger.info(
      `CombinedAgentSlackApi Error occurred: ${getErrorMessage(error)}`,
    )
    const errorSpan = rootSpan.startSpan("handle_top_level_error")
    errorSpan.addEvent("error", {
      message: getErrorMessage(error),
      stack: (error as Error).stack || "",
    })
    const errFromMap = handleError(error)
    // @ts-ignore
    if (chat?.externalId && stream) {
      // Check if stream is initialized
      const allMessages = await getChatMessages(db, chat.externalId)
      if (allMessages.length > 0) {
        const lastMessage = allMessages[allMessages.length - 1]
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
      if (error.status === 429) {
        Logger.error(error, "You exceeded your current quota")
        if (stream) {
          // Check if stream is initialized
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: errFromMap,
          })
        }
      }
    } else {
      Logger.error(
        error,
        `Message Error: ${getErrorMessage(error)} ${(error as Error).stack}`,
      )
      // Avoid throwing HTTPException if stream has started, as headers might be sent.
      // Instead, try to send error over SSE if possible.
      if (stream) {
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: "An unexpected server error occurred.",
        })
        await stream.writeSSE({ data: "", event: ChatSSEvents.End })
      } else {
        throw new HTTPException(500, {
          message: "Could not create message or Chat",
        })
      }
    }
    if (streamKey && activeStreams.has(streamKey)) {
      activeStreams.delete(streamKey)
      Logger.info(
        `Removed stream ${streamKey} from active streams map in top-level catch.`,
      )
    }
    errorSpan.end()
    rootSpan.end()
    // If stream exists and an error is thrown after headers are sent, Hono might handle it.
    // If no stream, rethrow is fine.
    if (!stream) {
      throw error // Rethrow if we haven't started streaming
    }
  }
}
