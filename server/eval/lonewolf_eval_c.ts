import pc from "picocolors"
import {
  generateSearchQueryOrAnswerFromConversation,
  generateTitleUsingQuery,
} from "@/ai/provider"
import { Models, type ModelParams } from "@/ai/types"
import fs from "fs"
import path from "path"
import { userContext } from "@/ai/context"
import { getLogger } from "@/logger"
import { MessageRole, Subsystem } from "@/types"
import config from "@/config"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"
import type { ConversationRole, Message } from "@aws-sdk/client-bedrock-runtime"
import { sleep } from "bun"
import {
  UnderstandMessageAndAnswer,
  UnderstandMessageAndAnswerForGivenContext,
} from "@/api/chat/chat"
import { ragPipelineConfig, RagPipelineStages } from "@/api/chat/types"
import {
  extractFileIdsFromMessage,
  isMessageWithContext,
} from "@/api/chat/utils"

const Logger = getLogger(Subsystem.Eval)
const { defaultBestModel } = config
const modelId = defaultBestModel || Models.Claude_3_5_Sonnet

const myEmail = "email@example.com"
const workspaceId = "ht........."

if (!myEmail) throw new Error("Please set the email")
if (!workspaceId) throw new Error("Please add the workspaceId")

type EvalData = {
  input: string
  chatId?: string
  modelId?: string
  isReasoningEnabled?: boolean
  agentId?: string
  attachmentFileIds?: string[]
  previousMessages?: Array<{
    role: string
    content: string
    messageRole: MessageRole
    fileIds?: string[]
  }>
  expected: {
    hasAnswer: boolean
    answerType: "conversation" | "rag" | "context"
    hasCitations: boolean
    citationCount?: number
    hasTitle?: boolean
    queryRewrite?: string
    errorExpected?: boolean
    errorMessage?: string
  }
  context?: {
    fileIds?: string[]
    hasContext: boolean
  }
}

type EvalResult = {
  input: string
  output: {
    answer?: string
    citations?: any[]
    title?: string
    queryRewrite?: string
    answerType: "conversation" | "rag" | "context" | "error"
    reasoning?: string
    cost?: number
    error?: string
  }
  expected: EvalData["expected"]
  score: number
  metrics: {
    answerTypeMatch: boolean
    citationMatch: boolean
    hasAnswerMatch: boolean
    titleMatch: boolean
    queryRewriteMatch: boolean
    errorMatch: boolean
  }
  rawOutput?: string
  processingTime: number
}

const loadTestData = (): EvalData[] => {
  try {
    const filePath = path.join(
      __dirname,
      "..",
      "..",
      "eval-data",
      "test-queries.json",
    )
    const data = fs.readFileSync(filePath, "utf-8")
    const parsedData = JSON.parse(data)
    if (!Array.isArray(parsedData))
      throw new Error("Test data must be an array")
    return parsedData
  } catch (error) {
    console.error("Error loading test data:", error)
    throw error
  }
}

const data = loadTestData()
if (!data.length) throw new Error("Data is not set for the evals")

function evaluateResponse(result: EvalResult): number {
  const { output, expected, metrics } = result

  console.log("####### EVALUATING AGENT MESSAGE RESPONSE ########")
  console.log("Generated answer type:", output.answerType)
  console.log("Expected answer type:", expected.answerType)
  console.log("Has answer:", !!output.answer)
  console.log("Expected has answer:", expected.hasAnswer)
  console.log("Citations count:", output.citations?.length || 0)
  console.log("Expected citations:", expected.hasCitations ? "yes" : "no")

  let score = 0
  let totalChecks = 0

  // Check answer type match
  metrics.answerTypeMatch = output.answerType === expected.answerType
  if (metrics.answerTypeMatch) score += 1
  totalChecks += 1

  // Check if answer presence matches expectation
  metrics.hasAnswerMatch = !!output.answer === expected.hasAnswer
  if (metrics.hasAnswerMatch) score += 1
  totalChecks += 1

  // Check citations
  const hasCitations = (output.citations?.length || 0) > 0
  metrics.citationMatch = hasCitations === expected.hasCitations
  if (metrics.citationMatch) score += 1
  totalChecks += 1

  // Check citation count if specified
  if (expected.citationCount !== undefined) {
    const citationCountMatch =
      (output.citations?.length || 0) === expected.citationCount
    if (citationCountMatch) score += 1
    totalChecks += 1
  }

  // Check title generation for new chats
  if (expected.hasTitle !== undefined) {
    metrics.titleMatch = !!output.title === expected.hasTitle
    if (metrics.titleMatch) score += 1
    totalChecks += 1
  }

  // Check query rewrite
  if (expected.queryRewrite !== undefined) {
    metrics.queryRewriteMatch =
      !!output.queryRewrite === !!expected.queryRewrite
    if (metrics.queryRewriteMatch) score += 1
    totalChecks += 1
  }

  // Check error handling
  if (expected.errorExpected !== undefined) {
    metrics.errorMatch = !!output.error === expected.errorExpected
    if (metrics.errorMatch) score += 1
    totalChecks += 1
  }

  const finalScore = totalChecks > 0 ? score / totalChecks : 0

  console.log(pc.green(`Score: ${(finalScore * 100).toFixed(1)}%`))
  console.log(`Metrics: ${JSON.stringify(metrics, null, 2)}`)

  if (finalScore >= 0.8) {
    console.log(pc.green("✅ Excellent match"))
  } else if (finalScore >= 0.6) {
    console.log(pc.yellow("⚠️ Good match"))
  } else if (finalScore >= 0.4) {
    console.log(pc.yellow("⚠️ Partial match"))
  } else {
    console.log(pc.red("❌ Poor match"))
  }

  return finalScore
}

function saveEvalResults(
  evaluation: { averageScore: number; results: EvalResult[] },
  name: string,
) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const fileName = `${name}-${timestamp}.json`
  const filePath = path.join(
    process.cwd(),
    "eval-results",
    "agent-message",
    fileName,
  )

  const evalResultsDir = path.join(
    process.cwd(),
    "eval-results",
    "agent-message",
  )
  if (!fs.existsSync(evalResultsDir)) {
    fs.mkdirSync(evalResultsDir, { recursive: true })
    Logger.info(`Created directory: ${evalResultsDir}`)
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(evaluation, null, 2))
    Logger.info(`Evaluation results saved to: ${filePath}`)
    return fileName
  } catch (error) {
    Logger.error(`Failed to save evaluation results to ${filePath}: ${error}`)
    throw error
  }
}

async function simulateAgentMessageFlow(
  evalItem: EvalData,
  userCtx: string,
  agentPrompt?: string,
): Promise<EvalResult> {
  const startTime = Date.now()

  const result: EvalResult = {
    input: evalItem.input,
    output: {
      answerType: "error",
      cost: 0,
    },
    expected: evalItem.expected,
    score: 0,
    metrics: {
      answerTypeMatch: false,
      citationMatch: false,
      hasAnswerMatch: false,
      titleMatch: false,
      queryRewriteMatch: false,
      errorMatch: false,
    },
    processingTime: 0,
  }

  try {
    let message = decodeURIComponent(evalItem.input)
    const costArr: number[] = []

    // Step 1: Generate title if new chat
    if (!evalItem.chatId) {
      Logger.info("Generating title for new chat...")
      const titleResp = await generateTitleUsingQuery(message, {
        modelId: ragPipelineConfig[RagPipelineStages.NewChatTitle].modelId,
        stream: false,
      })
      result.output.title = titleResp.title
      if (titleResp.cost) costArr.push(titleResp.cost)
      Logger.info(`Generated title: ${result.output.title}`)
    }

    // Step 2: Check if message has context
    const isMsgWithContext = isMessageWithContext(message)
    const extractedInfo = isMsgWithContext
      ? await extractFileIdsFromMessage(message)
      : {
          totalValidFileIdsFromLinkCount: 0,
          fileIds: [],
        }

    const fileIds = extractedInfo?.fileIds || []
    const attachmentFileIds = evalItem.attachmentFileIds || []

    // Step 3: Process based on context availability
    if (
      (isMsgWithContext && fileIds.length > 0) ||
      attachmentFileIds.length > 0
    ) {
      Logger.info("Processing message with context...")
      result.output.answerType = "context"

      // Simulate context-based processing
      const iterator = UnderstandMessageAndAnswerForGivenContext(
        myEmail,
        userCtx,
        message,
        0.5,
        fileIds,
        evalItem.isReasoningEnabled || false,
        undefined, // span
        [], // messages
        attachmentFileIds,
        agentPrompt,
      )

      let answer = ""
      let thinking = ""
      let citations: any[] = []
      let citationMap: Record<number, number> = {}

      for await (const chunk of iterator) {
        if (chunk.text) {
          if (evalItem.isReasoningEnabled && chunk.reasoning) {
            thinking += chunk.text
          } else if (!chunk.reasoning) {
            answer += chunk.text
          }
        }
        if (chunk.cost) {
          costArr.push(chunk.cost)
        }
        if (chunk.citation) {
          const { index, item } = chunk.citation
          citations.push(item)
          citationMap[index] = citations.length - 1
        }
      }

      result.output.answer = answer
      result.output.citations = citations
      result.output.reasoning = thinking
    } else {
      Logger.info("Processing message without specific context...")

      // Step 4: Convert previous messages to conversation format
      const messagesWithNoErrResponse = (evalItem.previousMessages || []).map(
        (msg) => ({
          role: msg.messageRole,
          content: [{ text: msg.content }],
        }),
      )

      // Step 5: Check if answer exists in conversation or needs query rewrite
      const formattedMessages: Message[] = messagesWithNoErrResponse
        .slice(-8)
        .map((msg) => ({
          role: msg.role as ConversationRole,
          content: msg.content.map((c) => ({
            type: "text",
            text: c.text,
          })),
        }))

      const searchOrAnswerIterator =
        generateSearchQueryOrAnswerFromConversation(message, userCtx, {
          modelId: ragPipelineConfig[RagPipelineStages.AnswerOrSearch].modelId,
          stream: true,
          json: true,
          reasoning: evalItem.isReasoningEnabled || false,
          messages: formattedMessages,
          agentPrompt: agentPrompt,
        })

      let buffer = ""
      let thinking = ""
      let reasoning = evalItem.isReasoningEnabled || false
      let parsed: any = {
        answer: "",
        queryRewrite: "",
        temporalDirection: null,
        filter_query: "",
        type: "",
        intent: {},
        filters: {},
      }

      for await (const chunk of searchOrAnswerIterator) {
        if (chunk.text) {
          if (reasoning && chunk.text.includes("</think>")) {
            reasoning = false
            const parts = chunk.text.split("</think>")
            if (parts[0]) thinking += parts[0]
            if (parts[1]) buffer += parts[1].trim()
          } else if (reasoning) {
            thinking += chunk.text
          } else {
            buffer += chunk.text
          }
        }
        if (chunk.cost) {
          costArr.push(chunk.cost)
        }
      }

      try {
        parsed = JSON.parse(buffer) || {}
      } catch (err) {
        Logger.error(`Failed to parse conversation analysis: ${buffer}`)
      }

      if (parsed.answer) {
        // Answer found in conversation
        result.output.answerType = "conversation"
        result.output.answer = parsed.answer
        result.output.reasoning = thinking
      } else {
        // Need to use RAG
        Logger.info("Using RAG pipeline...")
        result.output.answerType = "rag"
        result.output.queryRewrite = parsed.queryRewrite || undefined

        const rewrittenMessage = parsed.queryRewrite || message
        const classification = {
          direction: parsed.temporalDirection,
          type: parsed.type,
          filterQuery: parsed.filter_query,
          filters: parsed.filters || {},
        }

        const formattedMessage: Message[] = messagesWithNoErrResponse
          .slice(-8)
          .map((msg) => ({
            role: msg.role as ConversationRole, // make sure MessageRole can be cast to ConversationRole
            content: msg.content.map((c) => ({
              type: "text",
              text: c.text,
            })),
          }))

        const ragIterator = UnderstandMessageAndAnswer(
          myEmail,
          userCtx,
          rewrittenMessage,
          classification,
          formattedMessage,
          0.5,
          evalItem.isReasoningEnabled || false,
          undefined, // span
          agentPrompt,
        )

        let answer = ""
        let ragThinking = ""
        let citations: any[] = []
        let citationMap: Record<number, number> = {}

        for await (const chunk of ragIterator) {
          if (chunk.text) {
            if (evalItem.isReasoningEnabled && chunk.reasoning) {
              ragThinking += chunk.text
            } else if (!chunk.reasoning) {
              answer += chunk.text
            }
          }
          if (chunk.cost) {
            costArr.push(chunk.cost)
          }
          if (chunk.citation) {
            const { index, item } = chunk.citation
            citations.push(item)
            citationMap[index] = citations.length - 1
          }
        }

        result.output.answer = answer
        result.output.citations = citations
        result.output.reasoning = ragThinking
      }
    }

    result.output.cost = costArr.reduce((sum, cost) => sum + cost, 0)
  } catch (error) {
    Logger.error(`Error in agent message flow: ${error}`)
    result.output.error = (error as Error).message
    result.output.answerType = "error"
  }

  result.processingTime = Date.now() - startTime
  return result
}

async function runEvaluation(userCtx: string) {
  const results: EvalResult[] = []

  Logger.info("Starting Agent Message API evaluation...")
  Logger.info("User context:\n" + userCtx)

  for (const item of data) {
    Logger.info(`Processing query: "${item.input}"`)

    await sleep(2000) // Rate limiting

    const result = await simulateAgentMessageFlow(item, userCtx, item.agentId)

    Logger.info(`Result for "${item.input}":`)
    Logger.info(`- Answer type: ${result.output.answerType}`)
    Logger.info(`- Has answer: ${!!result.output.answer}`)
    Logger.info(`- Citations: ${result.output.citations?.length || 0}`)
    Logger.info(`- Processing time: ${result.processingTime}ms`)
    Logger.info(`- Cost: ${result.output.cost || 0}`)

    result.score = evaluateResponse(result)
    results.push(result)

    console.log("---")
  }

  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length
  const avgProcessingTime =
    results.reduce((sum, r) => sum + r.processingTime, 0) / results.length
  const totalCost = results.reduce((sum, r) => sum + (r.output.cost || 0), 0)

  console.log(pc.green(`\n=== FINAL RESULTS ===`))
  console.log(`Average Score: ${(avgScore * 100).toFixed(1)}%`)
  console.log(`Average Processing Time: ${avgProcessingTime.toFixed(0)}ms`)
  console.log(`Total Cost: ${totalCost.toFixed(4)}`)

  const savedFileName = saveEvalResults(
    { averageScore: avgScore, results },
    "agent-message-eval",
  )

  console.log(`Results saved to: ${savedFileName}`)

  return { avgScore, results, avgProcessingTime, totalCost }
}

const callRunEvaluation = async () => {
  try {
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      myEmail,
    )
    const ctx = userContext(userAndWorkspace)
    await runEvaluation(ctx)
  } catch (error) {
    Logger.error("Failed to fetch user and workspace:", error)
    throw error
  }
}

await callRunEvaluation()
