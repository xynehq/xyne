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
import { n as rougeN } from 'js-rouge'

const Logger = getLogger(Subsystem.Eval)
const { defaultBestModel } = config
const modelId = defaultBestModel || Models.Claude_3_5_Sonnet

const myEmail = ""
const workspaceExternalId = ""

if (!myEmail) throw new Error("Please set the email")
if (!workspaceExternalId) throw new Error("Please add the workspaceExternalId")

type Data = {
  input: string
  expected: {
    queryRewrite: string
    temporalDirection: string | null
    isFollowUp: boolean
    type: string
    filterQuery: string
    filters: {
      app: string
      entity: string
      startTime: string | null
      endTime: string | null
      intent: Record<string, string[]>
      count: number
      sortDirection: string
    }
    reasoning: string | null
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
    sortDirection: string
    intent: Record<string, string[]>
  }
}

// Add proper types at the top
type EvalResult = Data & {
  output: QueryRouterLLMResponse
  score: number
  breakdown: Record<string, number>
  rawOutput?: string
  reasoningOutput?: string
  isSuccessful: boolean
}

type SavedEvalResults = {
  averageScore: number
  results: EvalResult[]
  avgBreakdown: Record<string, number>
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

function compareArguments(
  expectedArgs: Record<string, any>,
  actualArgs: Record<string, any>,
): number {
  let matched = 0
  const expectedKeys = Object.keys(expectedArgs)
  
  if (expectedKeys.length === 0) return 1
  
  for (const key of expectedKeys) {
    if (key in actualArgs) {
      if (Array.isArray(expectedArgs[key]) && Array.isArray(actualArgs[key])) {
        const expectedArray = expectedArgs[key]
        const actualArray = actualArgs[key]
        const arrayMatch = expectedArray.length === actualArray.length &&
          expectedArray.every((val: any, i: number) => val === actualArray[i])
        matched += arrayMatch ? 1 : 0
      } else if (typeof expectedArgs[key] === "object" && typeof actualArgs[key] === "object" && 
                 expectedArgs[key] !== null && actualArgs[key] !== null) {
        const nestedScore = compareArguments(expectedArgs[key], actualArgs[key])
        matched += nestedScore
      } else if (expectedArgs[key] === actualArgs[key] || 
                 (expectedArgs[key] === null && actualArgs[key] === null)) {
        matched++
      }
    }
  }
  return matched / expectedKeys.length
}

function mapExpectedToActual(expected: Data["expected"], actual: QueryRouterLLMResponse) {
  const mappedExpected = {
    queryRewrite: expected.queryRewrite,
    app: expected.filters.app,
    entity: expected.filters.entity,
    filterQuery: expected.filterQuery,
    temporalDirection: expected.temporalDirection || null,
    isFollowUp: actual.isFollowUp,
    type: actual.type,
    count: expected.filters.count,
    sortDirection: expected.filters.sortDirection,
    intent: expected.filters.intent,
    startTime: expected.filters.startTime,
    endTime: expected.filters.endTime,
  }
  
  const mappedActual = {
    queryRewrite: actual.queryRewrite,
    app: actual.filters.app,
    entity: actual.filters.entity,
    filterQuery: actual.filterQuery,
    temporalDirection: actual.temporalDirection || null,
    isFollowUp: actual.isFollowUp,
    type: actual.type,
    count: actual.filters.count,
    sortDirection: actual.filters.sortDirection,
    intent: actual.filters.intent,
    startTime: expected.filters.startTime,
    endTime: expected.filters.endTime,
  }
  
  console.log("Mapped expected:", JSON.stringify(mappedExpected, null, 2))
  console.log("Mapped actual:", JSON.stringify(mappedActual, null, 2))
  return { mappedExpected, mappedActual }
}

const evaluateRogue = (expected: string | null, actual: string | null): number => {
  if (expected === null && actual === null) {
    return 1
  }
  if (!expected || !actual || expected.trim() === '' || actual.trim() === '' || (!expected && actual) || (expected && !actual)) {
    console.log(`Expected: ${expected}, Actual: ${actual}`)
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

  const { mappedExpected, mappedActual } = mapExpectedToActual(expected, output)
  
  console.log("Mapped expected:", JSON.stringify(mappedExpected, null, 2))
  console.log("Mapped actual:", JSON.stringify(mappedActual, null, 2))
  
  let appScore = 0
  if (mappedExpected.app === mappedActual.app || (mappedExpected.app === null && mappedActual.app === null)) {
    appScore = 1
  }

  let entityScore = 0
  if (mappedExpected.entity === mappedActual.entity || (mappedExpected.entity === null && mappedActual.entity === null)) {
    entityScore = 1
  }

  let countScore = 0
  if (mappedExpected.count === mappedActual.count || (mappedExpected.count === null && mappedActual.count === null)) {
    countScore = 1
  }

  let sortDirectionScore = 0
  if (mappedExpected.sortDirection === mappedActual.sortDirection ||
      (mappedExpected.sortDirection === null && mappedActual.sortDirection === null)) {
    sortDirectionScore = 1
  }

  let temporalDirectionScore = 0
  if (mappedExpected.temporalDirection === mappedActual.temporalDirection ||
      (mappedExpected.temporalDirection === null && mappedActual.temporalDirection === null)) {
    temporalDirectionScore = 1
  }

  let isFollowUpScore = 0
  if (mappedExpected.isFollowUp === mappedActual.isFollowUp || 
      (mappedExpected.isFollowUp === null && mappedActual.isFollowUp === null)) {    
    isFollowUpScore = 1
  }

  let typeScore = 0
  if (mappedExpected.type === mappedActual.type || 
      (mappedExpected.type === null && mappedActual.type === null)) {
    typeScore = 1
  }
  
  let startTimeScore = 0
  if (mappedExpected.startTime === mappedActual.startTime || 
      (mappedExpected.startTime === null && mappedActual.startTime === null)) {
    startTimeScore = 1
  }

  let endTimeScore = 0
  if (mappedExpected.endTime === mappedActual.endTime || 
      (mappedExpected.endTime === null && mappedActual.endTime === null)) {
    endTimeScore = 1
  }

  let queryRewriteScore = evaluateRogue(mappedExpected.queryRewrite, mappedActual.queryRewrite)
  let filterQueryScore = evaluateRogue(mappedExpected.filterQuery, mappedActual.filterQuery)

  let intentScore = 0
  if (mappedExpected.intent && mappedActual.intent) {
    intentScore = compareArguments(mappedExpected.intent, mappedActual.intent)
  } else if (!mappedExpected.intent && !mappedActual.intent) {
    intentScore = 1
  } else if (Object.keys(mappedExpected.intent || {}).length === 0 && 
             Object.keys(mappedActual.intent || {}).length === 0) {
    intentScore = 1
  }

  const overallScore = (queryRewriteScore + appScore + entityScore + filterQueryScore + countScore + 
                       sortDirectionScore + intentScore + startTimeScore + endTimeScore + 
                       isFollowUpScore + typeScore + temporalDirectionScore) / 12

  console.log(
    pc.green(
      `Query rewrite score: ${(queryRewriteScore * 100).toFixed(1)}%, ` +
      `App score: ${(appScore * 100).toFixed(1)}%, ` +
      `Entity score: ${(entityScore * 100).toFixed(1)}%, ` +
      `Filter query score: ${(filterQueryScore * 100).toFixed(1)}%, ` +
      `Count score: ${(countScore * 100).toFixed(1)}%, ` +
      `Sort direction score: ${(sortDirectionScore * 100).toFixed(1)}%, ` +
      `Intent score: ${(intentScore * 100).toFixed(1)}%` +
      `Start time score: ${(startTimeScore * 100).toFixed(1)}%, ` +
      `End time score: ${(endTimeScore * 100).toFixed(1)}%, ` +
      `Is follow-up score: ${(isFollowUpScore * 100).toFixed(1)}%, ` +
      `Type score: ${(typeScore * 100).toFixed(1)}%, ` +
      `Temporal direction score: ${(temporalDirectionScore * 100).toFixed(1)}%`,
    ),
  )

  if (overallScore === 1) {
    console.log(pc.green("✅ Full match"))
  } else if (overallScore >= 0.7) {
    console.log(pc.yellow("⚠️ Good match"))
  } else if (overallScore > 0) {
    console.log(pc.yellow("⚠️ Partial match"))
  } else {
    console.log(pc.red("❌ No match"))
  }

  return { 
    score: overallScore,
    breakdown: {
      queryRewrite: queryRewriteScore,
      app: appScore,
      entity: entityScore,
      filterQuery: filterQueryScore,
      count: countScore,
      sortDirection: sortDirectionScore,
      intent: intentScore,
      startTime: startTimeScore,
      endTime: endTimeScore,
      isFollowUp: isFollowUpScore,
      type: typeScore,
      temporalDirection: temporalDirectionScore
    },
    isSuccessful: overallScore === 1
  }
}

function saveEvalResults(
  result: EvalResult, // Changed from 'any' to 'EvalResult'
  filePath: string,
  append: boolean = false
) {
  const evalResultsDir = path.dirname(filePath)
  if (!fs.existsSync(evalResultsDir)) {
    fs.mkdirSync(evalResultsDir, { recursive: true })
    Logger.info(`Created directory: ${evalResultsDir}`)
  }

  try {
    if (append) {
      // Read existing results if file exists
      let existingResults: SavedEvalResults = { 
        averageScore: 0, 
        results: [], 
        avgBreakdown: {} 
      }
      
      if (fs.existsSync(filePath)) {
        const existingData = fs.readFileSync(filePath, 'utf-8')
        existingResults = JSON.parse(existingData) as SavedEvalResults
      }
      
      // Append new result
      existingResults.results.push(result)
      
      // Recalculate average score
      existingResults.averageScore = existingResults.results.reduce((a: number, c: EvalResult) => a + c.score, 0) / existingResults.results.length
      
      // Recalculate average breakdown
      existingResults.avgBreakdown = existingResults.results.reduce((acc: Record<string, number>, result: EvalResult) => {
        Object.keys(result.breakdown).forEach(key => {
          acc[key] = (acc[key] || 0) + result.breakdown[key]
        })
        return acc
      }, {} as Record<string, number>)

      Object.keys(existingResults.avgBreakdown).forEach(key => {
        existingResults.avgBreakdown[key] = Math.round((existingResults.avgBreakdown[key] / existingResults.results.length) * 100)
      })

      fs.writeFileSync(filePath, JSON.stringify(existingResults, null, 2))
    } else {
      const initialResults: SavedEvalResults = {
        averageScore: 0, 
        results: [result], 
        avgBreakdown: {} 
      }
      fs.writeFileSync(filePath, JSON.stringify(initialResults, null, 2))
    }
    Logger.info(`Evaluation results saved to: ${filePath}`)
  } catch (error) {
    Logger.error(`Failed to save evaluation results to ${filePath}: ${error}`)
    throw error
  }
}

async function runEvaluation(userCtx: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const fileName = `json-classification-eval-${timestamp}.json`
  const filePath = path.join(
    process.cwd(),
    "eval-results",
    "json-classification",
    fileName,
  )

  const results: EvalResult[] = [] // Changed from complex inline type to EvalResult[]

  for await (const item of loadTestData()) {
    Logger.info(`Processing query: "${item.input}"`)
    Logger.info(
      `Model params: ${JSON.stringify({ modelId, stream: true, json: true, reasoning: item.reasoning, messages: item.messages }, null, 2)}, \n ${JSON.stringify(item, null, 2)}, \n User context: ${userCtx}, \n Prompt: ${searchQueryPrompt(userCtx)}`,
    )

    await sleep(5000)

    Logger.info(`Passing item: `)

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
      filters: {
        app: "",
        entity: "",
        startTime: null,
        endTime: null,
        count: null,
        sortDirection: "",
        intent: {},
      },
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
        filters: {
          app: "",
          entity: "",
          startTime: null,
          endTime: null,
          count: null,
          sortDirection: "",
          intent: {},
        },
      }
      Logger.info(`Parsed output: ${JSON.stringify(output, null, 2)}`)
    } catch (err) {
      Logger.error(
        `Failed to parse LLM output for query "${item.input}": ${buffer}`,
      )
      Logger.error(`Error: ${err}`)
    }

    const { score, breakdown, isSuccessful } = evaluateResponse({
      output,
      expected: item.expected,
      input: item.input,
    })

    const result = {
      ...item,
      output,
      score: Math.round(score * 100),
      breakdown,
      rawOutput: buffer,
      reasoningOutput,
      isSuccessful
    }

    // Append each result to the file
    saveEvalResults(result, filePath, true)
    results.push(result)
  }

  const avgScore = results.reduce((a, c) => a + c.score, 0) / results.length
  console.log(`Search or Answer eval score: ${avgScore}`)

  // Calculate average breakdown scores
  const avgBreakdown = results.reduce((acc, result) => {
    Object.keys(result.breakdown).forEach(key => {
      acc[key] = (acc[key] || 0) + result.breakdown[key]
    })
    return acc
  }, {} as Record<string, number>)

  Object.keys(avgBreakdown).forEach(key => {
    avgBreakdown[key] = Math.round((avgBreakdown[key] / results.length) * 100)
  })

  console.log("Average breakdown scores:", avgBreakdown)
  console.log(`Results saved to: ${fileName}`)
}

const callRunEvaluation = async () => {
  try {
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceExternalId,
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