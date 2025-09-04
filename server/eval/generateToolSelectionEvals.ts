import { z } from "zod"
import { Models } from "@/ai/types"
import fs from "fs"
import path from "path"
import { userContext } from "@/ai/context"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { agentTools } from "@/api/chat/tools"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"
import type { Message as BedrockMessage } from "@aws-sdk/client-bedrock-runtime"
import { n as rougeN } from "js-rouge"
import {
  runStream,
  type Agent,
  type RunState,
  type RunConfig,
  type Message as JAFMessage,
  type Tool,
  ToolResponse,
} from "@xynehq/jaf"
import {
  buildInternalJAFTools,
  buildMCPJAFTools,
  type JAFAdapterCtx,
  buildToolsOverview,
} from "@/api/chat/jaf-adapter"
import { makeXyneJAFProvider } from "@/api/chat/jaf-provider"
import { constructToolContext } from "@/ai/context"
import { jsonParseLLMOutput } from "@/ai/provider"
import { nanoid } from "nanoid"

const Logger = getLogger(Subsystem.Eval)
const { defaultBestModel } = config
const modelId = defaultBestModel || Models.Claude_3_5_Sonnet

const myEmail = "user@juspay.in"
const workspaceExternalId = "b7******"

if (!myEmail) throw new Error("Please set the email")
if (!workspaceExternalId) throw new Error("Please add the workspaceExternalId")

const evaluateRogue = (
  expected: string | null,
  actual: string | null,
): number => {
  if (expected === null && actual === null) {
    return 1
  }
  if (
    !expected ||
    !actual ||
    expected.trim() === "" ||
    actual.trim() === "" ||
    (!expected && actual) ||
    (expected && !actual)
  ) {
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
  messages?: BedrockMessage[]
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
  input: string,
): number {
  // Keys to exclude from comparison (pagination and metadata)
  const excludedKeys = [
    "limit",
    "offset",
    "from",
    "to",
    "excludedIds",
    "order_direction",
  ]

  // Only compare keys that are actually present in expected args, excluding the ones we don't care about
  // Also exclude keys with empty string values
  const expectedKeys = Object.keys(expectedArgs).filter((key) => {
    if (excludedKeys.includes(key)) return false
    // Skip keys with empty string values
    if (expectedArgs[key] === "" || expectedArgs[key] === null) return false
    return true
  })

  Logger.info(`[ARGS COMPARISON] Input: "${input}"`)
  Logger.info(
    `[ARGS COMPARISON] Keys being compared: [${expectedKeys.join(", ")}]`,
  )
  Logger.info(`[ARGS COMPARISON] Keys excluded: [${excludedKeys.join(", ")}]`)
  Logger.info(
    `[ARGS COMPARISON] Keys with empty values skipped: [${Object.keys(
      expectedArgs,
    )
      .filter((key) => expectedArgs[key] === "" || expectedArgs[key] === null)
      .join(", ")}]`,
  )

  if (expectedKeys.length === 0) {
    Logger.info(`[ARGS COMPARISON] No keys to compare, returning perfect score`)
    return 1
  }

  let totalScore = 0
  const comparisonDetails: string[] = []

  for (const key of expectedKeys) {
    let keyScore = 0

    if (key in actualArgs) {
      const expectedValue = expectedArgs[key]
      const actualValue = actualArgs[key]

      // Use ROUGE for filter_query, exact match for everything else
      if (
        key === "filter_query" &&
        typeof expectedValue === "string" &&
        typeof actualValue === "string"
      ) {
        keyScore = evaluateRogue(expectedValue, actualValue)
        if (keyScore < 0) keyScore = 0 // Handle ROUGE errors
        comparisonDetails.push(
          `${key}: ROUGE ${(keyScore * 100).toFixed(1)}% ("${expectedValue}" vs "${actualValue}")`,
        )
      } else {
        // Simple equality check for all other types
        keyScore =
          JSON.stringify(expectedValue) === JSON.stringify(actualValue) ? 1 : 0
        const status = keyScore === 1 ? "✅" : "❌"
        comparisonDetails.push(
          `${status} ${key}: ${keyScore === 1 ? "MATCH" : "MISMATCH"} (${JSON.stringify(expectedValue)} vs ${JSON.stringify(actualValue)})`,
        )
      }
    } else {
      comparisonDetails.push(
        `❌ ${key}: MISSING (expected: ${JSON.stringify(expectedArgs[key])})`,
      )
    }

    totalScore += keyScore
  }

  const finalScore = totalScore / expectedKeys.length
  Logger.info(`[ARGS COMPARISON] Breakdown:`)
  comparisonDetails.forEach((detail) => Logger.info(`  ${detail}`))
  Logger.info(
    `[ARGS COMPARISON] Score: ${totalScore.toFixed(2)}/${expectedKeys.length} = ${(finalScore * 100).toFixed(1)}%\n`,
  )

  return finalScore
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

  // Handle actual tools - could be single tool or array of tools from multiple calls
  const actualTools = Array.isArray(output.tool)
    ? output.tool
    : output.tool
      ? [output.tool]
      : []

  // Check if ANY of the expected tools appear in the actual tool calls
  let toolMatchScore = 0
  let hasCorrectTool = false

  for (const expectedTool of expectedTools) {
    if (actualTools.includes(expectedTool)) {
      hasCorrectTool = true
      break
    }
  }

  // If we found the correct tool, give full score. Otherwise 0.
  toolMatchScore = hasCorrectTool ? 1 : 0

  // Only check arguments if we have the correct tool
  let argsScore = 0
  if (hasCorrectTool && output.arguments && expected.arguments) {
    argsScore = compareArguments(expected.arguments, output.arguments, input)
  } else if (
    hasCorrectTool &&
    (!expected.arguments || Object.keys(expected.arguments).length === 0)
  ) {
    // If correct tool is found but no expected arguments, perfect args score
    Logger.info(
      `[ARGS COMPARISON] Correct tool found, no expected arguments to compare, perfect score`,
    )
    argsScore = 1
  } else if (!hasCorrectTool) {
    Logger.info(
      `[ARGS COMPARISON] Wrong tool selected, skipping argument comparison`,
    )
    argsScore = 0
  } else {
    Logger.info(
      `[ARGS COMPARISON] Correct tool found but missing arguments, score: 0`,
    )
    argsScore = 0
  }

  // ROUGE evaluation for filterQuery - only if correct tool is selected
  let filterQueryScore = 1
  if (
    hasCorrectTool &&
    (expected.filterQuery !== undefined || output.filterQuery !== undefined)
  ) {
    filterQueryScore = evaluateRogue(
      expected.filterQuery || null,
      output.filterQuery || null,
    )
    Logger.info(
      `[FILTER QUERY] Expected: "${expected.filterQuery || "null"}", Actual: "${output.filterQuery || "null"}", Score: ${(filterQueryScore * 100).toFixed(1)}%`,
    )
  } else if (!hasCorrectTool) {
    Logger.info(
      `[FILTER QUERY] Wrong tool selected, skipping filter query comparison`,
    )
    filterQueryScore = 0
  }

  // Log detailed breakdown for debugging
  console.log(
    `Tool Match: ${(toolMatchScore * 100).toFixed(1)}% (Expected: ${expectedTools.join(", ")}, Actual: ${actualTools.join(", ")}, Found: ${hasCorrectTool})`,
  )
  console.log(`Args Match: ${(argsScore * 100).toFixed(1)}%`)
  console.log(`FilterQuery Match: ${(filterQueryScore * 100).toFixed(1)}%`)

  // Weights for different components
  const weights = {
    tool: 0.5, // Tool selection is most important
    arguments: 0.3, // Arguments are important
    filterQuery: 0.2, // Filter query evaluation
  }

  const overallScore =
    toolMatchScore * weights.tool +
    argsScore * weights.arguments +
    filterQueryScore * weights.filterQuery

  const status =
    overallScore === 1
      ? "✅ Perfect"
      : overallScore > 0.8
        ? "🟢 Good"
        : overallScore > 0.5
          ? "🟡 Fair"
          : "🔴 Poor"
  console.log(`Status: ${status} (${(overallScore * 100).toFixed(1)}%)`)

  Logger.info(
    `[EVALUATION SUMMARY] Input: "${input}" | Tool: ${(toolMatchScore * 100).toFixed(1)}% | Args: ${(argsScore * 100).toFixed(1)}% | FilterQuery: ${(filterQueryScore * 100).toFixed(1)}% | Overall: ${(overallScore * 100).toFixed(1)}%`,
  )

  return {
    score: overallScore,
    breakdown: {
      toolMatch: toolMatchScore,
      arguments: argsScore,
      filterQuery: filterQueryScore,
    },
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

function saveEvalTextLog(
  evaluation: { averageScore: number; results: any[] },
  name: string,
) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const fileName = `${name}-${timestamp}.txt`
  const filePath = path.join(
    process.cwd(),
    "eval-results",
    "tools",
    "compare",
    fileName,
  )

  let logContent = ""
  logContent += "=".repeat(80) + "\n"
  logContent += "JAF TOOL SELECTION EVALUATION DETAILED LOG\n"
  logContent += "=".repeat(80) + "\n"
  logContent += `Timestamp: ${new Date().toISOString()}\n`
  logContent += `Model: ${modelId}\n`
  logContent += `Total Evaluations: ${evaluation.results.length}\n`
  logContent += `Overall Score: ${evaluation.averageScore.toFixed(1)}%\n`
  logContent += "=".repeat(80) + "\n\n"

  // Summary by score ranges
  const perfect = evaluation.results.filter((r) => r.score === 100).length
  const good = evaluation.results.filter(
    (r) => r.score > 80 && r.score < 100,
  ).length
  const fair = evaluation.results.filter(
    (r) => r.score > 50 && r.score <= 80,
  ).length
  const poor = evaluation.results.filter((r) => r.score <= 50).length

  logContent += "SCORE DISTRIBUTION:\n"
  logContent += `-`.repeat(40) + "\n"
  logContent += `✅ Perfect (100%): ${perfect}\n`
  logContent += `🟢 Good (81-99%): ${good}\n`
  logContent += `🟡 Fair (51-80%): ${fair}\n`
  logContent += `🔴 Poor (0-50%): ${poor}\n\n`

  // Tool usage summary
  const toolUsage: Record<string, number> = {}
  evaluation.results.forEach((result) => {
    if (result.expected.tool) {
      const tools = Array.isArray(result.expected.tool)
        ? result.expected.tool
        : [result.expected.tool]
      tools.forEach((tool: string) => {
        toolUsage[tool] = (toolUsage[tool] || 0) + 1
      })
    }
  })

  logContent += "TOOL USAGE BREAKDOWN:\n"
  logContent += `-`.repeat(40) + "\n"
  Object.entries(toolUsage)
    .sort(([, a], [, b]) => b - a)
    .forEach(([tool, count]) => {
      logContent += `${tool}: ${count} queries\n`
    })
  logContent += "\n"

  // Detailed results
  logContent += "DETAILED EVALUATION RESULTS:\n"
  logContent += "=".repeat(80) + "\n\n"

  evaluation.results.forEach((result, index) => {
    const status =
      result.score === 100
        ? "✅ Perfect"
        : result.score > 80
          ? "🟢 Good"
          : result.score > 50
            ? "🟡 Fair"
            : "🔴 Poor"

    logContent += `${index + 1}. ${status} (${result.score}%)\n`
    logContent += `-`.repeat(60) + "\n"
    logContent += `Query: "${result.input}"\n`
    logContent += `Expected Tool: ${Array.isArray(result.expected.tool) ? result.expected.tool.join(", ") : result.expected.tool}\n`

    // Show all actual tools called, not just the first one
    const actualToolsDisplay = result.output?.tool
      ? Array.isArray(result.output.tool)
        ? result.output.tool.join(", ")
        : result.output.tool
      : "None"
    logContent += `Actual Tools Called: ${actualToolsDisplay}\n`

    if (result.breakdown) {
      logContent += `Tool Match: ${(result.breakdown.toolMatch * 100).toFixed(1)}%\n`
      logContent += `Args Match: ${(result.breakdown.arguments * 100).toFixed(1)}%\n`
      logContent += `FilterQuery Match: ${(result.breakdown.filterQuery * 100).toFixed(1)}%\n`
    }

    if (
      result.expected.arguments &&
      Object.keys(result.expected.arguments).length > 0
    ) {
      logContent += `Expected Args: ${JSON.stringify(result.expected.arguments, null, 2)}\n`
      logContent += `Actual Args: ${JSON.stringify(result.output?.arguments || {}, null, 2)}\n`
    }

    if (result.rawOutput) {
      logContent += `All Tool Calls Made:\n${result.rawOutput}\n`
    }

    logContent += "\n"
  })

  // Failed cases summary
  const failedCases = evaluation.results.filter((r) => r.score < 80)
  if (failedCases.length > 0) {
    logContent += "CASES NEEDING ATTENTION (< 80%):\n"
    logContent += "=".repeat(80) + "\n"
    failedCases.forEach((result, index) => {
      logContent += `${index + 1}. "${result.input}" - ${result.score}%\n`
      logContent += `   Expected: ${Array.isArray(result.expected.tool) ? result.expected.tool.join(", ") : result.expected.tool}\n`
      logContent += `   Actual: ${result.output?.tool ? (Array.isArray(result.output.tool) ? result.output.tool.join(", ") : result.output.tool) : "None"}\n\n`
    })
  }

  try {
    fs.writeFileSync(filePath, logContent)
    Logger.info(`Text log saved to: ${fileName}`)
    return fileName
  } catch (error) {
    Logger.error(`Failed to save text log to ${filePath}: ${error}`)
    throw error
  }
}

// Mirror the paramsToZod function from jaf-adapter.ts for consistent schema conversion
function paramsToZod(parameters: Record<string, any>): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, spec] of Object.entries(parameters || {})) {
    let schema: z.ZodTypeAny
    switch ((spec.type || "string").toLowerCase()) {
      case "string":
        schema = z.string()
        break
      case "number":
        schema = z.number()
        break
      case "boolean":
        schema = z.boolean()
        break
      case "array":
        schema = z.array(z.any())
        break
      case "object":
        // Ensure top-level parameter properties that are objects are valid JSON Schema objects
        schema = z.object({}).passthrough()
        break
      default:
        schema = z.any()
    }
    if (!spec.required) schema = schema.optional()
    shape[key] = schema.describe(spec.description || "")
  }
  return z.object(shape)
}

// Mock tool builder function that prevents actual database queries, we don't want to hit the DB during evals
function buildMockJAFTools(baseCtx: JAFAdapterCtx): Tool<any, JAFAdapterCtx>[] {
  const tools: Tool<any, JAFAdapterCtx>[] = []

  // Create mock versions of all agent tools
  for (const [name, at] of Object.entries(agentTools)) {
    // Skip the fallbackTool and get_user_info as it's no longer needed (same filtering as buildInternalJAFTools)
    if (name === "fall_back" || name === "get_user_info") {
      continue
    }
    
    tools.push({
      schema: {
        name,
        description: at.description,
        parameters: paramsToZod(at.parameters || {}),
      },
      async execute(args, context) {
        // Log the tool call for debugging but don't execute
        Logger.info(
          `[MOCK TOOL] ${name} called with args:`,
          JSON.stringify(args, null, 2),
        )

        // Return a generic success response without executing the real tool
        return ToolResponse.success(
          `Mock execution of ${name} - tool selection captured`,
          {
            toolName: name,
            contexts: [], // Empty contexts since we're not actually querying
          },
        )
      },
    })
  }

  Logger.info(
    `[MOCK TOOLS] Created ${tools.length} mock tools: ${tools.map((t) => t.schema.name).join(", ")}`,
  )
  return tools
}

async function runEvaluation(userCtx: string) {
  const results: (Data & {
    output: any
    score: number
    breakdown?: {
      toolMatch: number
      arguments: number
      filterQuery: number
    }
    rawOutput?: string
    reasoningOutput?: string
  })[] = []

  Logger.info("Starting JAF-based tool selection evaluation...")

  // Setup JAF components
  const baseCtx: JAFAdapterCtx = {
    email: myEmail,
    userCtx: userCtx,
    agentPrompt: undefined,
    userMessage: "",
  }

  // Build mock JAF tools to prevent database queries during evaluation
  const internalJAFTools = buildMockJAFTools(baseCtx) // Mock tools - no DB queries!

  const allJAFTools = [...internalJAFTools] // No MCP tools for eval

  for (const [index, item] of data.entries()) {
    Logger.info(`Processing query ${index + 1}/${data.length}: "${item.input}"`)

    try {
      // Update context for this specific query
      const queryCtx: JAFAdapterCtx = {
        ...baseCtx,
        userMessage: item.input,
      }

      // Build dynamic instructions that include tools
      const agentInstructions = () => {
        const toolOverview = buildToolsOverview(allJAFTools)
        return (
          `You are Xyne, an enterprise search assistant.\n` +
          `- Your first action must be to call an appropriate tool to gather authoritative context before answering.\n` +
          `- Do NOT answer from general knowledge. Always retrieve context via tools first.\n` +
          `- Always cite sources inline using bracketed indices [n] that refer to the Context Fragments list below.\n` +
          `- If context is missing or insufficient, use search/metadata tools to fetch more, or ask a brief clarifying question, then search.\n` +
          `- Be concise, accurate, and avoid hallucinations.\n` +
          `\nAvailable Tools:\n${toolOverview}`
        )
      }

      const runId = nanoid()
      const traceId = nanoid()

      // Convert messages to JAF format
      const initialMessages: JAFMessage[] = (item.messages || []).map((m) => ({
        role: m.role === "user" ? ("user" as const) : ("assistant" as const),
        content:
          typeof m.content === "string"
            ? m.content
            : m.content?.[0]?.text || "",
      }))

      // Add the current query as the last message
      initialMessages.push({
        role: "user" as const,
        content: item.input,
      })

      const jafAgent: Agent<JAFAdapterCtx, string> = {
        name: "xyne-eval-agent",
        instructions: agentInstructions,
        tools: allJAFTools,
        modelConfig: { name: modelId as string },
      }

      const modelProvider = makeXyneJAFProvider<JAFAdapterCtx>()

      const agentRegistry = new Map<string, Agent<JAFAdapterCtx, string>>([
        [jafAgent.name, jafAgent],
      ])

      const runState: RunState<JAFAdapterCtx> = {
        runId: runId as any,
        traceId: traceId as any,
        messages: initialMessages,
        currentAgentName: jafAgent.name,
        context: queryCtx,
        turnCount: 0,
      }

      const runCfg: RunConfig<JAFAdapterCtx> = {
        agentRegistry,
        modelProvider,
        maxTurns: 3, // Limit turns for evaluation
        modelOverride: modelId as string,
      }

      // Capture tool calls from JAF events
      let capturedToolCalls: Array<{ name: string; args: any }> = []
      let reasoningOutput = ""

      // Stream JAF events to capture tool selections
      for await (const evt of runStream<JAFAdapterCtx, string>(
        runState,
        runCfg,
      )) {
        switch (evt.type) {
          case "tool_requests": {
            // Capture tool requests - this is what we want to evaluate
            for (const toolCall of evt.data.toolCalls) {
              capturedToolCalls.push({
                name: toolCall.name,
                args: toolCall.args,
              })
            }
            break
          }
          case "assistant_message": {
            // Capture any reasoning if present
            if (evt.data.message.content) {
              reasoningOutput += evt.data.message.content
            }
            break
          }
          case "run_end": {
            // Stop processing when run ends
            break
          }
        }
        if (capturedToolCalls.length > 0) {
          Logger.info(
            `[JAF STREAM] Stopping JAF stream after capturing tool requests`,
          )
          // If we've captured tool calls, we can stop early since we only allow 1 turn
          break
        }
      }

      // Convert captured tool calls to evaluation format
      let output: {
        tool?: string | string[]
        arguments?: any
        filterQuery?: string | null
      } = {
        tool: undefined,
        arguments: undefined,
        filterQuery: undefined,
      }

      if (capturedToolCalls.length > 0) {
        // Keep all tool names for comprehensive evaluation
        const toolNames = capturedToolCalls.map((tc) => tc.name)
        output.tool = toolNames // Always use array to show all calls made

        // Use arguments from the first tool call that matches expected tool
        const expectedTools = Array.isArray(item.expected.tool)
          ? item.expected.tool
          : [item.expected.tool]

        // Find the first tool call that matches one of the expected tools
        const matchingCall = capturedToolCalls.find((call) =>
          expectedTools.includes(call.name),
        )

        if (matchingCall && matchingCall.args) {
          output.arguments = matchingCall.args

          // Extract filterQuery if present in arguments
          if (matchingCall.args?.filterQuery) {
            output.filterQuery = matchingCall.args.filterQuery
          }
        } else if (capturedToolCalls[0].args) {
          // Fallback to first call's args if no matching tool found
          output.arguments = capturedToolCalls[0].args

          if (capturedToolCalls[0].args?.filterQuery) {
            output.filterQuery = capturedToolCalls[0].args.filterQuery
          }
        }

        Logger.info(
          `[TOOL CAPTURE] Captured ${capturedToolCalls.length} tool calls: ${toolNames.join(", ")}`,
        )
        if (matchingCall) {
          Logger.info(
            `[TOOL CAPTURE] Using arguments from matching tool: ${matchingCall.name}`,
          )
        } else {
          Logger.info(
            `[TOOL CAPTURE] No matching tool found, using arguments from first call: ${capturedToolCalls[0].name}`,
          )
        }
      }

      const { score, breakdown } = evaluateResponse({
        output,
        expected: item.expected,
        input: item.input,
      })

      results.push({
        ...item,
        output,
        score: Math.round(score * 100),
        breakdown,
        rawOutput: JSON.stringify(capturedToolCalls, null, 2),
        reasoningOutput,
      })
    } catch (error) {
      Logger.error(`Error evaluating query "${item.input}":`, error)

      results.push({
        ...item,
        output: null,
        score: 0,
        breakdown: { toolMatch: 0, arguments: 0, filterQuery: 0 },
        rawOutput: "",
        reasoningOutput: "",
      })
    }
  }

  const avgScore = results.reduce((a, c) => a + c.score, 0) / results.length

  // Console output similar to chain classification
  console.log("\n=== JAF TOOL SELECTION EVALUATION RESULTS ===")
  console.log(`Overall Score: ${avgScore.toFixed(1)}%`)
  console.log(`Total Evaluations: ${results.length}`)
  console.log(`Model: ${modelId}`)

  const evaluation = { averageScore: avgScore, results }

  const savedFileName = saveEvalResults(evaluation, "jaf-tool-selection-eval")
  const savedTextLog = saveEvalTextLog(evaluation, "jaf-tool-selection-eval")

  console.log(`Results saved to: ${savedFileName}`)
  console.log(`Text log saved to: ${savedTextLog}`)

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
    console.log("Starting tool selection evaluation...")
    console.log(`Loaded ${data.length} test queries`)

    const results = await callRunEvaluation()
    console.log(
      `\nEvaluation completed with score: ${results.avgScore.toFixed(1)}%`,
    )
    process.exit(0)
  } catch (error) {
    console.error("Evaluation failed:", error)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

export { callRunEvaluation as runToolSelectionEval }
