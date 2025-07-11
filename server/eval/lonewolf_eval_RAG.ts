import pc from "picocolors"
import fs from "fs"
import path from "path"
import { userContext } from "@/ai/context"
import { getLogger } from "@/logger"
import { MessageRole, Subsystem } from "@/types"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"
import { sleep } from "bun"
import { isCuid } from "@paralleldrive/cuid2"
import { HTTPException } from "hono/http-exception"
import config from "@/config"
import { getAgentByExternalIdWithPermissionCheck } from "@/db/agent"
import { ChatSSEvents, } from "@/shared/types"
import type { ConversationRole } from "@aws-sdk/client-bedrock-runtime"

import {
  // baselineRAGIterationJsonStream,
  generateSearchQueryOrAnswerFromConversation,
} from "@/ai/provider"


const { defaultBestModel} = config;
const myEmail = "oindrila.banerjee@juspay.in"
const workspaceId = "i3acjjlykgjyamw51qbwhhiu"
const agentId = "" // This is the externalId of the agent
const modelId = defaultBestModel
const Logger = getLogger(Subsystem.Eval)
let agentPromptForLLM: string | undefined = undefined

if (!myEmail) throw new Error("Please set the email")
if (!workspaceId) throw new Error("Please add the workspaceId")
if (!agentId) throw new Error("Please add the valid agentid")

type EvalData = {
  input: string
  expected: string
}

type EvalResult = {
  input: string
  expected: string
  output: string
  score: number
  processingTime: number
}

// Simple Levenshtein distance function for partial matching
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = []

  // Initialize matrix
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j
  }

  // Fill matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        )
      }
    }
  }

  return matrix[b.length][a.length]
}

// Calculate similarity score (0 to 1) based on Levenshtein distance
function calculateSimilarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2
  const shorter = str1.length > str2.length ? str2 : str1
  if (longer.length === 0) return 1.0
  const distance = levenshteinDistance(longer, shorter)
  return (longer.length - distance) / longer.length
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
    return parsedData.map(item => ({
      input: item.input,
      expected: item.expected.answer
    }))
  } catch (error) {
    console.error("Error loading test data:", error)
    throw error
  }
}

const data = loadTestData()
if (!data.length) throw new Error("Data is not set for the evals")

function evaluateResponse(result: EvalResult): number {
  const { output, expected } = result

  console.log("####### EVALUATING AGENT MESSAGE RESPONSE ########")
  console.log("Generated answer:", output)
  console.log("Expected answer:", expected)

  // Normalize strings for comparison
  const normalizedOutput = output.trim().toLowerCase()
  const normalizedExpected = expected.trim().toLowerCase()

  // Exact match check
  const isExactMatch = normalizedOutput === normalizedExpected

  // Partial match check using similarity score
  const similarityThreshold = 0.7 // 70% similarity for partial match
  const similarity = calculateSimilarity(normalizedOutput, normalizedExpected)
  const isPartialMatch = similarity >= similarityThreshold

  // Scoring: 1 for exact match, 0.5 for partial match, 0 for no match
  let score = 0
  if (isExactMatch) {
    score = 1
    console.log(pc.green("✅ Exact match"))
 } else if (isPartialMatch) {
    score = 0.5
    console.log(pc.yellow("⚠️ Partial match"))
    console.log(`Similarity score: ${(similarity * 100).toFixed(1)}%`)
  } else {
    console.log(pc.red("❌ No match"))
    console.log(`Similarity score: ${(similarity * 100).toFixed(1)}%`)
  }

  console.log(pc.green(`Score: ${(score * 100).toFixed(1)}%`))

  return score
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
): Promise<EvalResult> {
  const startTime = Date.now()
  const result: EvalResult = {
    input: evalItem.input,
    expected: evalItem.expected,
    output: "",
    score: 0,
    processingTime: 0,
  }

  try {
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId, // This workspaceId is the externalId from JWT
      myEmail,
    )
    const { user, workspace } = userAndWorkspace

    if (agentId && isCuid(agentId)) {
      // Use the numeric workspace.id for the database query with permission check
      let agentForDb = await getAgentByExternalIdWithPermissionCheck(
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

    const message = decodeURIComponent(evalItem.input)
    let answer = ""

    // Mock message context (simulating a single user message with no prior conversation)
    const messages = [
      {
        messageRole: MessageRole.User,
        message: message,
        fileIds: [],
      },
    ]

    // Process messages to filter out errors and empty assistant messages
    const messagesWithNoErrResponse = messages
      .filter((msg) => !msg?.errorMessage)
      .filter(
        (msg) =>
          !(msg.messageRole === MessageRole.Assistant && !msg.message),
      )
      .map((msg) => {
        const fileIds = JSON.parse(JSON.stringify(msg?.fileIds || []))
        let processedMessage = msg.message
        if (
          msg.messageRole === MessageRole.User &&
          fileIds &&
          fileIds.length > 0
        ) {
          // Simplified: assume no context selection for evaluation
          processedMessage = msg.message
        }
        return {
          role: msg.messageRole as ConversationRole,
          content: [{ text: processedMessage }],
        }
      })

    // Limit messages to last 8 (in this case, just the input message)
    const limitedMessages = messagesWithNoErrResponse.slice(-8)

    // Mock stream for SSE events
    const mockStream: any = {
      writeSSE: (event: { event: string; data: any }) => {
        if (event.event === ChatSSEvents.ResponseUpdate) {
          const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data)
          answer += data
        }
      },
      close: () => {},
      closed: false,
    }

    // Call LLM to generate answer
    Logger.info("Checking if answer is in the conversation or a mandatory query rewrite is needed")
    const searchOrAnswerIterator = generateSearchQueryOrAnswerFromConversation(message, userCtx, {
      modelId: modelId, // Placeholder; replace with actual model ID if needed
      stream: true,
      json: true,
      reasoning: false, // Simplified for evaluation
      messages: limitedMessages,
      agentPrompt: agentPromptForLLM,
    })

    let currentAnswer = ""
    let parsed = {
      answer: "",
      queryRewrite: "",
      temporalDirection: null,
      filter_query: "",
      type: "",
      intent: {},
      filters: {
        app: "",
        entity: "",
        startTime: "",
        endTime: "",
        count: 0,
        sortDirection: "",
      },
    }

    // Process LLM output
    let buffer = ""
    for await (const chunk of searchOrAnswerIterator) {
      if (mockStream.closed) {
        Logger.info("[simulateAgentMessageFlow] Stream closed during conversation search loop. Breaking.")
        break
      }
      if (chunk.text) {
        buffer += chunk.text
        try {
          parsed = JSON.parse(buffer) || {}
          if (parsed.answer && currentAnswer !== parsed.answer) {
            if (currentAnswer === "") {
              Logger.info("Found answer in conversation, sending full response")
              mockStream.writeSSE({
                event: ChatSSEvents.Start,
                data: "",
              })
              mockStream.writeSSE({
                event: ChatSSEvents.ResponseUpdate,
                data: parsed.answer,
              })
            } else {
              const newText = parsed.answer.slice(currentAnswer.length)
              mockStream.writeSSE({
                event: ChatSSEvents.ResponseUpdate,
                data: newText,
              })
            }
            currentAnswer = parsed.answer
          }
        } catch (err) {
          const errMessage = (err as Error).message
          Logger.error(`Error while parsing LLM output: ${errMessage}`)
          continue
        }
      }
    }

    result.output = parsed.answer || "No answer generated"

    console.log("Final answer:", result.output)
  } catch (error) {
    Logger.error(`Error in agent message flow: ${error}`)
    result.output = `Error: ${(error as Error).message}`
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

    const result = await simulateAgentMessageFlow(item, userCtx)

    Logger.info(`Result for "${item.input}":`)
    Logger.info(`- Answer: ${result.output}`)
    Logger.info(`- Processing time: ${result.processingTime}ms`)

    result.score = evaluateResponse(result)
    results.push(result)

    console.log("---")
  }

  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length
  const avgProcessingTime =
    results.reduce((sum, r) => sum + r.processingTime, 0) / results.length

  console.log(pc.green(`\n=== FINAL RESULTS ===`))
  console.log(`Average Score: ${(avgScore * 100).toFixed(1)}%`)
  console.log(`Average Processing Time: ${avgProcessingTime.toFixed(0)}ms`)

  const savedFileName = saveEvalResults(
    { averageScore: avgScore, results },
    "agent-message-eval",
  )

  console.log(`Results saved to: ${savedFileName}`)

  return { avgScore, results, avgProcessingTime }
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