import pc from "picocolors"
import { db } from "@/db/client"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { generateTitleUsingQuery } from "@/ai/provider"
import { userContext } from "@/ai/context"
import { getLogger } from "@/logger"
import fs from "fs"
import path from "path"
import { sleep } from "bun"
import { HTTPException } from "hono/http-exception"
import { MessageRole, Subsystem } from "@/types"
import type { SelectChat, SelectMessage } from "../db/schema"
import { getTracer, type Tracer } from "@/tracer"
import { ragPipelineConfig, RagPipelineStages } from "@/api/chat/types"
import { getAgentByExternalIdWithPermissionCheck } from "@/db/agent"
import { insertChat, updateChatByExternalIdWithAuth } from "@/db/chat"
import { getChatMessagesWithAuth, insertMessage } from "@/db/message"
import {
  UnderstandMessageAndAnswer,
  UnderstandMessageAndAnswerForGivenContext,
} from "@/api/chat/chat"
import { AgentMessageApi } from "@/api/agent-message" // Import the API function
import { Context } from "hono" // Assuming Hono context type

const Logger = getLogger(Subsystem.Eval)
const myEmail = process.env.EVAL_EMAIL || "email@example.com"
const workspaceId = process.env.EVAL_WORKSPACE_ID || "ht........."
const sleepDuration = Number(process.env.EVAL_SLEEP_MS) || 5000
const maxMessages = Number(process.env.EVAL_MAX_MESSAGES) || 8

if (!myEmail) throw new Error("Please set the EVAL_EMAIL environment variable")
if (!workspaceId)
  throw new Error("Please set the EVAL_WORKSPACE_ID environment variable")

interface Data {
  input: string
  chatId?: string
  modelId?: string
  isReasoningEnabled?: boolean
  agentId?: string
  attachmentFileIds?: string[]
  expected: {
    answer: string
    citations?: string[]
    reasoning?: string
  }
  messages?: SelectMessage[]
}

interface EvaluationResult {
  input: string
  chatId?: string
  expected: Data["expected"]
  output: {
    answer: string
    citations: string[]
    reasoning: string
    messageId?: string
    chatId?: string
  }
  score: number
  rawOutput?: string
  error?: string
}

const loadTestData = (): Data[] => {
  try {
    const filePath =
      process.env.EVAL_DATA_PATH ||
      path.join(
        __dirname,
        "..",
        "..",
        "eval-data",
        "agent-message-test-queries.json",
      )
    const data = fs.readFileSync(filePath, "utf-8")
    const parsedData = JSON.parse(data)
    if (!Array.isArray(parsedData))
      throw new Error("Test data must be an array")
    return parsedData
  } catch (error) {
    Logger.error(`Error loading test data: ${error}`)
    throw error
  }
}

const data = loadTestData()
if (!data.length) throw new Error("Data is not set for the evals")

// Improved scoring with weights
function compareAnswers(expected: string, actual: string): number {
  if (!expected || !actual) return 0
  const expectedLower = expected.toLowerCase().trim()
  const actualLower = actual.toLowerCase().trim()
  // Simple Levenshtein-like similarity (placeholder; consider using a library like 'fast-levenshtein')
  let matches = 0
  const minLength = Math.min(expectedLower.length, actualLower.length)
  for (let i = 0; i < minLength; i++) {
    if (expectedLower[i] === actualLower[i]) matches++
  }
  return matches / Math.max(expectedLower.length, actualLower.length)
}

function compareCitations(expected: string[], actual: string[]): number {
  if (!expected || !actual) return 0
  const matched = actual.filter((citation) =>
    expected.includes(citation),
  ).length
  return expected.length ? matched / expected.length : 1
}

function compareReasoning(expected: string, actual: string): number {
  if (!expected || !actual) return 0
  const expectedLower = expected.toLowerCase().trim()
  const actualLower = actual.toLowerCase().trim()
  return expectedLower.includes(actualLower) ||
    actualLower.includes(expectedLower)
    ? 1
    : 0
}

function evaluateResponse({
  output,
  expected,
  input,
}: {
  output: EvaluationResult["output"]
  expected: Data["expected"]
  input: string
}): { score: number } {
  console.log("####### EVALUATING AGENT MESSAGE RESPONSE ########")
  console.log(`Input: ${input}`)
  console.log(`Generated answer: ${output.answer || "none"}`)
  console.log(`Expected answer: ${expected.answer}`)
  console.log(`Generated citations: ${JSON.stringify(output.citations)}`)
  console.log(`Expected citations: ${JSON.stringify(expected.citations || [])}`)
  console.log(`Generated reasoning: ${output.reasoning || "none"}`)
  console.log(`Expected reasoning: ${expected.reasoning || "none"}`)

  const answerWeight = 0.5
  const citationWeight = 0.3
  const reasoningWeight = 0.2

  const answerScore = compareAnswers(expected.answer, output.answer)
  const citationScore = compareCitations(
    expected.citations || [],
    output.citations,
  )
  const reasoningScore = expected.reasoning
    ? compareReasoning(expected.reasoning, output.reasoning)
    : 1

  const overallScore =
    answerScore * answerWeight +
    citationScore * citationWeight +
    reasoningScore * reasoningWeight

  console.log(
    pc.green(
      `Answer match score: ${(answerScore * 100).toFixed(1)}%, Citation match score: ${(citationScore * 100).toFixed(1)}%, Reasoning match score: ${(reasoningScore * 100).toFixed(1)}%`,
    ),
  )
  console.log(pc.blue(`Overall score: ${(overallScore * 100).toFixed(1)}%`))

  if (overallScore >= 0.9) {
    console.log(pc.green("✅ Excellent match"))
  } else if (overallScore >= 0.6) {
    console.log(pc.yellow("⚠️ Partial match"))
  } else {
    console.log(pc.red("❌ Poor match"))
  }

  return { score: overallScore }
}

function saveEvalResults(
  evaluation: { averageScore: number; results: EvaluationResult[] },
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

// Mock Context for AgentMessageApi
function createMockContext(item: Data): Context {
  return {
    get: (_key: string) => ({
      sub: myEmail,
      workspaceId,
    }),
    req: {
      valid: (_schema: string) => ({
        message: item.input,
        chatId: item.chatId,
        modelId:
          item.modelId ||
          ragPipelineConfig[RagPipelineStages.AnswerOrRewrite].modelId,
        isReasoningEnabled: item.isReasoningEnabled ?? false, // Fixed typo: falseFacets -> isReasoningEnabled
        agentId: item.agentId,
      }),
      query: (key?: string) => {
        if (key === "attachmentFileIds") {
          return item.attachmentFileIds?.join(",") || ""
        }
        return ""
      },
    },
    // Mock required Hono Context properties
    env: {},
    finalized: false,
    error: undefined,
    event: {} as any, // Replace with actual event type if known
    json: async (data: any) => data,
    text: async (data: string) => data,
    status: (code: number) => ({ status: () => code }) as any,
    header: () => ({}) as any,
    // Add minimal streamSSE mock for AgentMessageApi
    streamSSE: async (
      _c: any,
      callback: (stream: {
        writeSSE: (event: { event: string; data: string }) => Promise<void>
        closed: boolean
        on: (event: string, handler: (data: any) => void) => void
      }) => Promise<void>,
      errorCallback: (err: Error, stream: any) => Promise<void>,
    ) => {
      const stream = {
        writeSSE: async (event: { event: string; data: string }) => {
          // Simulate SSE write (can be logged or collected for testing)
          console.log(`Mock SSE event: ${event.event}, data: ${event.data}`)
        },
        closed: false,
        on: (event: string, handler: (data: any) => void) => {
          // Simulate event listener for streaming
          // In a real test, you might trigger handlers based on test logic
        },
      }
      try {
        await callback(stream)
      } catch (err) {
        await errorCallback(err as Error, stream)
      }
      return { status: () => 200 } as any // Mock response
    },
    // Add other required Context methods/properties as needed
    set: () => {},
    get var() {
      return {}
    },
    redirect: async () => ({}) as any,
    notFound: async () => ({}) as any,
  } as unknown as Context // Cast to unknown first to bypass strict type checking
}

async function runEvaluation(userCtx: string) {
  const tracer: Tracer = getTracer("eval-agent-message")
  const results: EvaluationResult[] = []

  const userAndWorkspace = await getUserAndWorkspaceByEmail(
    db,
    workspaceId,
    myEmail,
  )
  const { user, workspace } = userAndWorkspace

  for await (const item of data) {
    const rootSpan = tracer.startSpan("AgentMessageEval")
    rootSpan.setAttribute("email", myEmail)
    rootSpan.setAttribute("workspaceId", workspaceId)
    rootSpan.setAttribute("input", item.input)

    Logger.info(`Processing query: "${item.input}"`)

    let answer = ""
    let citations: string[] = []
    let reasoning = ""
    let assistantMessageId: string | null = null
    let chatId = item.chatId

    try {
      // Call AgentMessageApi directly
      const mockContext = createMockContext(item)
      let streamClosed = false

      await AgentMessageApi(mockContext).streamSSE(
        async (stream) => {
          stream.on("data", (event: { event: string; data: string }) => {
            if (streamClosed) return
            if (event.event === "ResponseUpdate") {
              answer += event.data
            } else if (event.event === "CitationsUpdate") {
              const { contextChunks } = JSON.parse(event.data)
              citations = contextChunks
            } else if (event.event === "Reasoning") {
              reasoning += event.data
            } else if (event.event === "ResponseMetadata") {
              const metadata = JSON.parse(event.data)
              assistantMessageId = metadata.messageId
              chatId = metadata.chatId
            } else if (event.event === "End") {
              streamClosed = true
            }
          })
        },
        async (error, stream) => {
          Logger.error(`Stream error for query "${item.input}": ${error}`)
          streamClosed = true
        },
      )

      // Wait for stream to complete
      await new Promise((resolve) => setTimeout(resolve, 10000)) // Adjust timeout as needed

      const output = {
        answer,
        citations,
        reasoning,
        messageId: assistantMessageId,
        chatId,
      }
      const { score } = evaluateResponse({
        output,
        expected: item.expected,
        input: item.input,
      })

      results.push({
        input: item.input,
        chatId,
        expected: item.expected,
        output,
        score: Math.round(score * 100),
        rawOutput: answer,
      })

      rootSpan.end()
      await sleep(sleepDuration) // Rate limiting
    } catch (error) {
      Logger.error(`Error processing query "${item.input}": ${error}`)
      results.push({
        input: item.input,
        chatId,
        expected: item.expected,
        output: {
          answer: "",
          citations: [],
          reasoning: "",
          chatId,
          messageId: null,
        },
        score: 0,
        rawOutput: "",
        error: error instanceof Error ? error.message : String(error),
      })
      rootSpan.end()
    }
  }

  const avgScore = results.reduce((a, c) => a + c.score, 0) / results.length
  console.log(`Agent Message eval score: ${(avgScore * 100).toFixed(1)}%`)

  const savedFileName = saveEvalResults(
    { averageScore: avgScore, results },
    "agent-message-eval",
  )
  console.log(`Results saved to: ${savedFileName}`)
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
    Logger.error(`Failed to fetch user and workspace: ${error}`)
    throw error
  }
}

await callRunEvaluation()
