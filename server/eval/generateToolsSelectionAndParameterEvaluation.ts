import { generateToolSelectionOutput, jsonParseLLMOutput } from "@/ai/provider"
import { Models } from "@/ai/types"
import fs from "fs"
import path from "path"
import { constructToolContext, userContext } from "@/ai/context"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { agentTools } from "@/api/chat/tools"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"
import type { Message } from "@aws-sdk/client-bedrock-runtime"
import { n as rougeN } from 'js-rouge'

const Logger = getLogger(Subsystem.Eval)
const { defaultBestModel } = config
const modelId = defaultBestModel || Models.Claude_3_5_Sonnet

const myEmail = ""
const workspaceExternalId = ""

if (!myEmail) throw new Error("Please set the email")
if (!workspaceExternalId) throw new Error("Please add the workspaceExternalId")

const evaluateRogue = (expected: string | null, actual: string | null): number => {
  if (expected === null && actual === null) {
    return 1
  }
  if (!expected || !actual || expected.trim() === '' || actual.trim() === '' || (!expected && actual) || (expected && !actual)) {
    return 0
  }
  try {
    const f1Score = rougeN(actual, expected, { n: 1 })
    return f1Score 
  } catch (err) {
    Logger.error(`ROUGE-N evaluation failed: ${err}`)
    return -1
  }
}

type Data = {
  input: string
  expected: { 
    tool: string | string[]
    arguments: Record<string, any>
    filterQuery?: string | null
  }
  messages?: Message[]
  reasoning?: boolean
}

const loadTestData = (): Data[] => {
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

function compareArguments(
  expectedArgs: Record<string, any>,
  actualArgs: Record<string, any>,
): number {
  let matched = 0
  // Only check these specific keys
  const allowedKeys = ['app', 'entity', 'filterQuery', 'intent', 'order_direction']
  const expectedKeys = Object.keys(expectedArgs).filter(key => allowedKeys.includes(key))
  
  for (const key of expectedKeys) {
    if (key in actualArgs) matched++
  }
  
  return expectedKeys.length === 0 ? 1 : matched / expectedKeys.length
}

function evaluateResponse({
  output,
  expected,
  input,
}: {
  output: {
    tool?: string | string[]
    arguments?: Record<string, any>
    filterQuery?: string | null
  }
  expected: { 
    tool: string | string[]
    arguments: Record<string, any>
    filterQuery?: string | null
  }
  input: string
}) {
  console.log(`\nEVALUATING: "${input}"`)
  console.log("Expected:", JSON.stringify(expected, null, 2))
  console.log("Actual:", JSON.stringify(output, null, 2))

  const expectedTools = Array.isArray(expected.tool)
    ? expected.tool
    : [expected.tool]
  const actualTools = Array.isArray(output.tool)
    ? output.tool
    : output.tool
      ? [output.tool]
      : []

  let matchedTools = 0
  const matchedToolNames: string[] = []

  for (const tool of expectedTools) {
    if (actualTools.includes(tool)) {
      matchedTools++
      matchedToolNames.push(tool)
    }
  }

  const toolMatchScore = expectedTools.length ? matchedTools / expectedTools.length : 0

  let argsScore = 0
  if (matchedToolNames.length > 0 && output.arguments) {
    argsScore = compareArguments(expected.arguments, output.arguments)
  }

  // ROUGE evaluation for filterQuery
  let filterQueryScore = 1
  if (expected.filterQuery !== undefined || output.filterQuery !== undefined) {
    filterQueryScore = evaluateRogue(expected.filterQuery || null, output.filterQuery || null)
  }

  // Weights for different components
  const weights = {
    tool: 0.5,        // Tool selection is most important
    arguments: 0.3,   // Arguments are important
    filterQuery: 0.2  // Filter query evaluation
  }

  const overallScore = (
    toolMatchScore * weights.tool +
    argsScore * weights.arguments +
    filterQueryScore * weights.filterQuery
  )

  const status = overallScore === 1 ? "✅ Perfect" :
                overallScore > 0.8 ? "🟢 Good" :
                overallScore > 0.5 ? "🟡 Fair" : "🔴 Poor"
  console.log(`Status: ${status} (${(overallScore * 100).toFixed(1)}%)`)

  return { 
    score: overallScore,
    breakdown: {
      toolMatch: toolMatchScore,
      arguments: argsScore,
      filterQuery: filterQueryScore
    }
  }
}

function saveEvalResults(
  evaluation: { averageScore: number; results: any[] },
  name: string,
) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const fileName = `${name}-${timestamp}.json`
  const filePath = path.join(
    process.cwd(),
    "eval-results",
    "tools",
    "compare",
    fileName,
  )

  const evalResultsDir = path.join(
    process.cwd(),
    "eval-results",
    "tools",
    "compare",
  )
  if (!fs.existsSync(evalResultsDir)) {
    fs.mkdirSync(evalResultsDir, { recursive: true })
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(evaluation, null, 2))
    Logger.info(`Results saved to: ${fileName}`)
    return fileName
  } catch (error) {
    Logger.error(`Failed to save evaluation results to ${filePath}: ${error}`)
    throw error
  }
}

async function runEvaluation(userCtx: string) {
  const results: (Data & {
    output: any
    score: number
    rawOutput?: string
    reasoningOutput?: string
  })[] = []

  Logger.info("Starting tool selection evaluation...")

  let toolsPrompt = ""
  if (Object.keys(agentTools).length > 0) {
    toolsPrompt = `While answering check if any below given AVAILABLE_TOOLS can be invoked to get more context to answer the user query more accurately, this is very IMPORTANT so you should check this properly based on the given tools information. 
 AVAILABLE_TOOLS:\n\n`
    for (const tool of Object.values(agentTools)) {
      toolsPrompt += `${constructToolContext(
        JSON.stringify(tool.parameters),
        tool.name,
        tool.description ?? "",
      )}\n\n`
    }
  }

  for (const [index, item] of data.entries()) {
    Logger.info(`Processing query ${index + 1}/${data.length}: "${item.input}"`)

    try {
      const toolSelectionOutput = await generateToolSelectionOutput(
        item.input,
        userCtx,
        toolsPrompt,
        "",
        {
          modelId,
          stream: true,
          json: true,
          reasoning: item.reasoning ?? false,
          messages: item.messages || [],
        },
      )

      let output: { 
        tool?: string | string[]
        arguments?: any
        filterQuery?: string | null
      } = {
        tool: undefined,
        arguments: undefined,
        filterQuery: undefined,
      }
      let buffer = ""
      let reasoningOutput = ""
      let reasoningActive = item.reasoning ?? false

      const isAsyncIterable = (obj: any): obj is AsyncIterable<any> => {
        return obj && typeof obj === "object" && Symbol.asyncIterator in obj
      }

      if (toolSelectionOutput && isAsyncIterable(toolSelectionOutput)) {
        for await (const chunk of toolSelectionOutput) {
          if (chunk.text) {
            if (reasoningActive) {
              if (chunk.text.includes("<think>")) {
                reasoningOutput += chunk.text
              } else if (chunk.text.includes("</think>")) {
                reasoningActive = false
                const parts = chunk.text.split("</think>")
                if (parts[0]) reasoningOutput += parts[0]
                if (parts[1]) buffer += parts[1].trim()
              } else {
                reasoningOutput += chunk.text
              }
            } else {
              buffer += chunk.text
            }
          }
        }
      } else {
        buffer = typeof toolSelectionOutput === "string" 
          ? toolSelectionOutput 
          : JSON.stringify(toolSelectionOutput)
      }

      try {
        output = jsonParseLLMOutput(buffer) || {
          tool: undefined,
          arguments: undefined,
          filterQuery: undefined,
        }
      } catch (err) {
        Logger.error(`Failed to parse LLM output for query "${item.input}": ${err}`)
      }

      const { score } = evaluateResponse({
        output,
        expected: item.expected,
        input: item.input,
      })

      results.push({
        ...item,
        output,
        score: Math.round(score * 100),
        rawOutput: buffer,
        reasoningOutput,
      })

    } catch (error) {
      Logger.error(`Error evaluating query "${item.input}":`, error)
      
      results.push({
        ...item,
        output: null,
        score: 0,
        rawOutput: "",
        reasoningOutput: "",
      })
    }
  }

  const avgScore = results.reduce((a, c) => a + c.score, 0) / results.length

  // Console output similar to chain classification
  console.log('\n=== TOOL SELECTION EVALUATION RESULTS ===')
  console.log(`Overall Score: ${avgScore.toFixed(1)}%`)
  console.log(`Total Evaluations: ${results.length}`)
  console.log(`Model: ${modelId}`)

  const savedFileName = saveEvalResults(
    { averageScore: avgScore, results },
    "tool-selection-eval",
  )

  console.log(`Results saved to: ${savedFileName}`)
  return { avgScore, results }
}

const callRunEvaluation = async () => {
  try {
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceExternalId,
      myEmail,
    )
    if (!userAndWorkspace) {
      throw new Error(`User not found for email: ${myEmail}`)
    }
    const ctx = userContext(userAndWorkspace)
    return await runEvaluation(ctx)
  } catch (error) {
    Logger.error("Failed to fetch user and workspace:", error)
    throw error
  }
}

async function main() {
  try {
    console.log('Starting tool selection evaluation...')
    console.log(`Loaded ${data.length} test queries`)
    
    const results = await callRunEvaluation()
    console.log(`\nEvaluation completed with score: ${results.avgScore.toFixed(1)}%`)
    process.exit(0)
  } catch (error) {
    console.error('Evaluation failed:', error)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

export { callRunEvaluation as runToolSelectionEval }