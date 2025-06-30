import pc from "picocolors"
import { generateToolSelectionOutput, jsonParseLLMOutput } from "@/ai/provider"
import { Models, type ModelParams } from "@/ai/types"
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
import { sleep } from "bun"

const Logger = getLogger(Subsystem.Eval)
const { defaultBestModel } = config
const modelId = defaultBestModel || Models.Claude_3_5_Sonnet

const myEmail = "oindrila.b@xynehq.com"
const workspaceId = "ht7mi36kwbjxmr7nfcpkdtkr"

if (!myEmail) throw new Error("Please set the email")
if (!workspaceId) throw new Error("Please add the workspaceId")

type Data = {
  input: string
  expected: { tool: string; arguments: Record<string, any> }
  messages?: Message[]
  reasoning?: boolean
}

type SelectTool = {
  toolName: string
  toolSchema: string
  description?: string
  externalId?: string
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

function evaluateResponse({
  output,
  expected,
  input,
}: {
  output: { answer?: string; tool?: string; arguments?: Record<string, any> }
  expected: { tool: string; arguments: Record<string, any> }
  input: string
}) {
  console.log("####### EVALUATING TOOL SELECTION ########")
  console.log("Generated tool:", output.tool || "none")
  console.log("Expected tool:", expected.tool)

  let score = 0
  if (output.tool && expected.tool) {
    // Allow time_search as an alternative to search for queries with "recent"
    const isValidTool =
      output.tool === expected.tool ||
      (expected.tool === "search" &&
        output.tool === "time_search" &&
        input.toLowerCase().includes("recent"))

    if (isValidTool) {
      score = 1
      console.log(pc.green("Tool selection matched!"))
    } else {
      console.log(
        pc.red(
          `Mismatch → expected tool: "${expected.tool}", got tool: "${output.tool}"`,
        ),
      )
    }
  } else {
    console.log(
      pc.red(
        `Mismatch → expected tool: "${expected.tool}", got ${output.tool ? `"${output.tool}"` : "none"}`,
      ),
    )
  }

  return { score }
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

  // Ensure eval-results directory exists
  const evalResultsDir = path.join(
    process.cwd(),
    "eval-results",
    "tools",
    "compare",
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

async function runEvaluation(userCtx: string) {
  const results: (Data & {
    output: any
    score: number
    rawOutput?: string
    reasoningOutput?: string
  })[] = []

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
  Logger.info("Tools available for evaluation:\n" + toolsPrompt)
  Logger.info("User context:\n" + userCtx)

  for await (const item of data) {
    Logger.info(`Processing query: "${item.input}"`)
    Logger.info(
      `Model params: ${JSON.stringify({ modelId, stream: true, json: true, reasoning: item.reasoning, messages: item.messages }, null, 2)}`,
    )

    await sleep(5000)

    const toolSelectionOutput = await generateToolSelectionOutput(
      item.input,
      userCtx,
      toolsPrompt,
      "", // No agentScratchpad since we only want initial tool selection
      {
        modelId: modelId,
        stream: true,
        json: true,
        reasoning: item.reasoning ?? false,
        messages: item.messages || [],
      },
    )

    let output: { answer?: string; tool?: string; arguments?: any } = {
      answer: null,
      tool: null,
      arguments: null,
    }
    let buffer = ""
    let reasoningOutput = ""
    let reasoningActive = item.reasoning ?? false

    if (
      toolSelectionOutput &&
      typeof toolSelectionOutput === "object" &&
      typeof toolSelectionOutput[Symbol.asyncIterator] === "function"
    ) {
      // Handle streaming case
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
      // Handle direct (non-streaming) object output
      buffer = JSON.stringify(toolSelectionOutput)
    }

    Logger.info(`Raw LLM output for query "${item.input}": ${buffer}`)
    if (reasoningOutput) Logger.info(`Reasoning output: ${reasoningOutput}`)

    try {
      output = jsonParseLLMOutput(buffer) || {
        answer: null,
        tool: null,
        arguments: null,
      }
      Logger.info(`Parsed output: ${JSON.stringify(output, null, 2)}`)
    } catch (err) {
      Logger.error(
        `Failed to parse LLM output for query "${item.input}": ${buffer}`,
      )
      Logger.error(`Error: ${err}`)
    }

    const { score } = evaluateResponse({
      output,
      expected: item.expected,
      input: item.input,
    })

    results.push({
      ...item,
      output,
      score: score * 100,
      rawOutput: buffer,
      reasoningOutput,
    })
  }

  const avgScore = results.reduce((a, c) => a + c.score, 0) / results.length
  console.log(`Tool Selection eval score: ${avgScore}`)

  const savedFileName = saveEvalResults(
    { averageScore: avgScore, results },
    "tool-selection-eval",
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
    Logger.error("Failed to fetch user and workspace:", error)
    throw error
  }
}

await callRunEvaluation()
