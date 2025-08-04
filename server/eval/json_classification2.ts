import pc from "picocolors"
import { generateSearchQueryOrAnswerFromConversation, jsonParseLLMOutput } from "@/ai/provider"
import { Models, type ModelParams } from "@/ai/types"
import fs from "fs"
import path from "path"
import { userContext } from "@/ai/context"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"
import type { Message } from "@aws-sdk/client-bedrock-runtime"
import { sleep } from "bun"
import { searchQueryPrompt } from "@/ai/prompts"

const Logger = getLogger(Subsystem.Eval)
const { defaultBestModel } = config
const modelId = defaultBestModel || Models.Claude_3_5_Sonnet

const myEmail = "oindrila.banerjee@juspay.in"
const workspaceId = "ozki1ibjyrmv7vyc9iukgxpf"

if (!myEmail) throw new Error("Please set the email")
if (!workspaceId) throw new Error("Please add the workspaceId")

type Data = {
  input: string
  expected: {
    answer: string | null
    queryRewrite: string | null
    temporalDirection: string | null
    isFollowUp: boolean
    type: string
    filterQuery: string
    filters: {
      app: string
      entity: string
      startTime: string | null
      endTime: string | null
      count: number | null
      sortDirection: string | null
      intent: Record<string, string[]>
    } | null
  }
  messages?: Message[]
  reasoning?: boolean
}

type QueryRouterLLMResponse = {
  answer: string | null
  queryRewrite: string | null
  temporalDirection: string | null
  isFollowUp: boolean
  type: string
  filterQuery: string
  filters: {
    app: string
    entity: string
    startTime: string | null
    endTime: string | null
    count: number | null
    sortDirection: string | null
    intent: Record<string, string[]>
  } | null
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
    let parsedData: any[]
    try {
      parsedData = JSON.parse(data)
    } catch (error) {
      Logger.error(`Failed to parse test-queries.json: ${error}`)
      throw new Error("Invalid JSON in test-queries.json")
    }
    if (!Array.isArray(parsedData))
      throw new Error("Test data must be an array")

    // Transform the expected JSON to match QueryRouterLLMResponse structure
    return parsedData.map((item: any) => {
      const expected = item.expected || {}
      const args = expected.arguments || {}
      return {
        input: item.input || "",
        expected: {
          answer: expected.answer ?? null,
          queryRewrite: expected.queryRewrite ?? null,
          temporalDirection: expected.temporalDirection ?? null,
          isFollowUp: expected.isFollowUp ?? false,
          type: expected.type ?? "SearchWithFilters",
          filterQuery: args.filter_query ?? "",
          filters: args.app
            ? {
                app: args.app ?? "",
                entity: args.entity ?? "",
                startTime: args.startTime ?? null,
                endTime: args.endTime ?? null,
                count: args.limit ?? null,
                sortDirection: args.order_direction ?? null,
                intent: args.intent ?? {},
              }
            : null,
        },
        messages: item.messages,
        reasoning: item.reasoning,
      }
    })
  } catch (error) {
    Logger.error(`Error loading test data: ${error}`)
    throw error
  }
}

function compareArguments(
  expectedArgs: Record<string, any> | null | undefined,
  actualArgs: Record<string, any> | null | undefined,
): number {
  // Handle null or undefined inputs
  if (!expectedArgs && !actualArgs) return 1
  if (!expectedArgs || !actualArgs) return 0

  let matched = 0
  const expectedKeys = Object.keys(expectedArgs)
  for (const key of expectedKeys) {
    if (key in actualArgs) {
      if (Array.isArray(expectedArgs[key]) && Array.isArray(actualArgs[key])) {
        // Compare arrays (e.g., intent.from, intent.subject) case-insensitively
        const expectedArray = expectedArgs[key].map((val: any) =>
          typeof val === "string" ? val.toLowerCase() : val
        )
        const actualArray = actualArgs[key].map((val: any) =>
          typeof val === "string" ? val.toLowerCase() : val
        )
        const arrayMatch = expectedArray.length === actualArray.length &&
          expectedArray.every((val: any, i: number) => val === actualArray[i])
        matched += arrayMatch ? 1 : 0
      } else if (typeof expectedArgs[key] === "object" && typeof actualArgs[key] === "object") {
        const nestedScore = compareArguments(expectedArgs[key], actualArgs[key])
        matched += nestedScore
      } else if (expectedArgs[key] === actualArgs[key] || (expectedArgs[key] === null && actualArgs[key] === null)) {
        matched++
      }
    }
  }
  return expectedKeys.length === 0 ? 1 : matched / expectedKeys.length
}

function evaluateResponse({
  output,
  expected,
  input,
}: {
  output: QueryRouterLLMResponse
  expected: Data["expected"]
  input: string
}) {
  console.log("####### EVALUATING SEARCH OR ANSWER OUTPUT ########")
  console.log("Generated output:", JSON.stringify(output, null, 2))
  console.log("Expected output:", JSON.stringify(expected, null, 2))

  let answerScore = 0
  if (expected.answer === output.answer || (expected.answer === null && output.answer === null)) {
    answerScore = 1
  }

  let queryRewriteScore = 0
  if (expected.queryRewrite === output.queryRewrite || (expected.queryRewrite === null && output.queryRewrite === null)) {
    queryRewriteScore = 1
  }

  let temporalDirectionScore = 0
  if (expected.temporalDirection === output.temporalDirection || (expected.temporalDirection === null && output.temporalDirection === null)) {
    temporalDirectionScore = 1
  }

  let isFollowUpScore = 0
  if (expected.isFollowUp === output.isFollowUp) {
    isFollowUpScore = 1
  }

  let typeScore = 0
  if (expected.type === output.type) {
    typeScore = 1
  }

  let filterQueryScore = 0
  if (expected.filterQuery === output.filterQuery) {
    filterQueryScore = 1
  }

  let filtersScore = 0
  if (expected.filters && output.filters) {
    filtersScore = compareArguments(expected.filters, output.filters)
  } else if (!expected.filters && !output.filters) {
    filtersScore = 1
  } else {
    filtersScore = 0
  }

  const overallScore = (answerScore + queryRewriteScore + temporalDirectionScore + isFollowUpScore + typeScore + filterQueryScore + filtersScore) / 7

  console.log(
    pc.green(
      `Answer match score: ${(answerScore * 100).toFixed(1)}%, ` +
      `Query rewrite score: ${(queryRewriteScore * 100).toFixed(1)}%, ` +
      `Temporal direction score: ${(temporalDirectionScore * 100).toFixed(1)}%, ` +
      `IsFollowUp score: ${(isFollowUpScore * 100).toFixed(1)}%, ` +
      `Type score: ${(typeScore * 100).toFixed(1)}%, ` +
      `Filter query score: ${(filterQueryScore * 100).toFixed(1)}%, ` +
      `Filters score: ${(filtersScore * 100).toFixed(1)}%`,
    ),
  )

  if (overallScore === 1) {
    console.log(pc.green("✅ Full match"))
  } else if (overallScore > 0) {
    console.log(pc.yellow("⚠️ Partial match"))
  } else {
    console.log(pc.red("❌ No match"))
  }

  return { score: overallScore }
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
    "search-or-answer",
    fileName,
  )

  const evalResultsDir = path.join(
    process.cwd(),
    "eval-results",
    "search-or-answer",
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
    output: QueryRouterLLMResponse
    score: number
    rawOutput?: string
    reasoningOutput?: string
  })[] = []

  for await (const item of loadTestData()) {
    Logger.info(`Processing query: "${item.input}"`)
    Logger.info(
      `Model params: ${JSON.stringify({ modelId, stream: true, json: true, reasoning: item.reasoning, messages: item.messages }, null, 2)}`,
    )

    await sleep(5000)

    const searchOrAnswerOutput = await generateSearchQueryOrAnswerFromConversation(
      item.input,
      userCtx,
      {
        modelId,
        stream: true,
        json: true,
        reasoning: item.reasoning ?? false,
        messages: item.messages || [],
        prompt: searchQueryPrompt(userCtx),
      },
    )

    let output: QueryRouterLLMResponse = {
      answer: null,
      queryRewrite: null,
      temporalDirection: null,
      isFollowUp: false,
      type: "",
      filterQuery: "",
      filters: null,
    }
    let buffer = ""
    let reasoningOutput = ""
    let reasoningActive = item.reasoning ?? false

    for await (const chunk of searchOrAnswerOutput) {
      if (chunk.text) {
        if (reasoningActive && chunk.reasoning) {
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

    Logger.info(`Raw LLM output for query "${item.input}": ${buffer}`)
    if (reasoningOutput) Logger.info(`Reasoning output: ${reasoningOutput}`)

    try {
      output = jsonParseLLMOutput(buffer) || {
        answer: null,
        queryRewrite: null,
        temporalDirection: null,
        isFollowUp: false,
        type: "",
        filterQuery: "",
        filters: null,
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
      score: Math.round(score * 100),
      rawOutput: buffer,
      reasoningOutput,
    })
  }

  const avgScore = results.reduce((a, c) => a + c.score, 0) / results.length
  console.log(`Search or Answer eval score: ${avgScore}`)

  const savedFileName = saveEvalResults(
    { averageScore: avgScore, results },
    "search-or-answer-eval",
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