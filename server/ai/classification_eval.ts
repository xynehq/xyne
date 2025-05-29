import {
  Apps,
  CalendarEntity,
  eventSchema,
  fileSchema,
  MailEntity,
  mailSchema,
  userSchema,
  VespaSearchResultsSchema,
  type VespaEventSearch,
  type VespaFileSearch,
  type VespaMailSearch,
  type VespaSearchResult,
  type VespaSearchResults,
  type VespaUser,
} from "@/search/types"
import OpenAI from "openai"
import pc from "picocolors"
import {
  generateSearchQueryOrAnswerFromConversation,
  getProviderByModel,
  jsonParseLLMOutput,
} from "./provider"
import {
  Models,
  QueryType,
  type LLMProvider,
  type ModelParams,
  type QueryRouterResponse,
  type TemporalClassifier,
  type TimeDirection,
} from "./types"
import fs from "fs"
import path from "path"
import { searchVespa } from "@/search/vespa"
import { answerContextMap, cleanContext, userContext } from "./context"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"
import { ConversationRole, type Message } from "@aws-sdk/client-bedrock-runtime"
import { UnderstandMessageAndAnswer } from "@/api/chat"
import { getTracer } from "@/tracer"
import { OpenAIProvider } from "./provider/openai"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
const Logger = getLogger(Subsystem.Eval)
const { defaultFastModel, defaultBestModel } = config
const modelId = defaultFastModel || Models.Claude_3_5_Haiku

// for permission aware Evals
// add this value to run
const myEmail = "junaid.s@xynehq.com" // Add your email here

// workspace external Id : Adding the workspace id for the evals
const workspaceId = "orq3jslp9udetix9912ueb6s" // Add your workspace id here

if (!myEmail) {
  throw new Error("Please set the email")
}

if (!workspaceId) {
  throw new Error("Please add the workspaceId")
}

type TClassification = TemporalClassifier & { type: QueryType } & {
  filters: Omit<QueryRouterResponse["filters"], "count" | "sortDirection"> & {
    count: number | null
    sortDirection: boolean | null
  }
}
type Data = {
  input: string
  expected: TClassification
}

const data: Data[] = [
  {
    input: "what is kalp's email",
    expected: {
      direction: null,
      type: QueryType.RetrieveMetadata,
      filter_query: "kalp",
      filters: {
        app: Apps.Gmail,
        entity: MailEntity.Email,
        startTime: null,
        endTime: null,
        count: null,
        sortDirection: null,
        multipleAppAndEntity: false,
      },
    },
  },
]

if (!data.length) {
  throw new Error("Data is not set for the evals")
}

// Source: https://github.com/braintrustdata/autoevals/blob/main/templates/factuality.yaml
const evaluateSystemPrompt = (
  input: string,
  expected: string,
  output: string,
) =>
  `You are comparing a submitted answer to an expert answer on a given question. Here is the data:
[BEGIN DATA]
************
[Question]: ${input}
************
[Expert]: ${expected}
************
[Submission]: ${output}
************
[END DATA]

Compare the factual content of the submitted answer with the expert answer. Ignore any differences in style, grammar, or punctuation.
The submitted answer may either be a subset or superset of the expert answer, or it may conflict with it. Determine which case applies. Answer the question by selecting one of the following options:
(A) The submitted answer is a subset of the expert answer and is fully consistent with it.
(B) The submitted answer is a superset of the expert answer and is fully consistent with it.
(C) The submitted answer contains all the same details as the expert answer.
(D) There is a disagreement between the submitted answer and the expert answer.
(E) The answers differ, but these differences don't matter from the perspective of factuality.

RESPOND WITH ONLY THE LETTER (A, B, C, D, or E) that best describes the relationship between the answers.`

const FactualityScorer = async (
  params: ModelParams,
  args: {
    input: string
    expected: TClassification
    output: TClassification
  },
) => {
  const openAiKey = process.env.OPENAI_API_KEY
  let provider: LLMProvider | null = null

  if (!openAiKey) {
    if (!params.modelId) params.modelId = modelId
    provider = getProviderByModel(params.modelId)
    Logger.info(
      "OpenAI key not found for evaluation, going with bedrock models",
    )
  } else {
    provider = new OpenAIProvider(new OpenAI({ apiKey: openAiKey }))
    Logger.info("Evaluating with openai")
    params.modelId = Models.Gpt_4o_mini
  }

  params.systemPrompt = evaluateSystemPrompt(
    args.input,
    JSON.stringify(args.expected),
    JSON.stringify(args.output),
  )
  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: "now evaluate the system prompt, just respond with the letters",
      },
    ],
  }

  const { text, cost } = await provider.converse([baseMessage], params)

  return { text, cost }
}

const customFactualityScorer = async (params: {
  input: string
  output: TClassification
  expected: TClassification
}) => {
  const { input, output, expected } = params

  console.log("\n=== CUSTOM LLM EVALUATION ===")
  console.log("Input:", input)
  console.log("Generated:", output)
  console.log("Expected:", expected)

  try {
    // Call OpenAI with the AutoEvals factuality prompt
    const response = await FactualityScorer(
      { modelId: modelId, stream: false },
      params,
    )

    console.log(response, "response")
    // Extract the choice from the response
    const content = (response.text && response.text.trim()) || ""
    console.log("Raw LLM response:", response)

    // Map the choice to a score
    const choiceScores: Record<string, number> = {
      A: 0.4,
      B: 0.6,
      C: 1.0,
      D: 0.0,
      E: 1.0,
    }

    let score = 0.5 // Default score
    if (content in choiceScores) {
      score = choiceScores[content]
    } else {
      console.log("Invalid choice received, using default score 0.5")
    }

    console.log("Final factuality score:", score)
    return { score }
  } catch (error: any) {
    console.error("Evaluation API error:", error.message)
    // Return a default score rather than failing
    return { score: 0 }
  }
}
function strictClassificationScorer({
  input,
  output,
  expected,
}: {
  input: string
  output: TClassification
  expected: TClassification
}) {
  const scoreFields: (keyof TClassification)[] = [
    "type",
    "filter_query",
    "direction",
  ]

  let score = 0
  let total = scoreFields.length

  for (const field of scoreFields) {
    if (output[field] === expected[field]) {
      score += 1
    } else {
      console.log(
        pc.red(
          `Mismatch in "${field}" → expected: ${expected[field]}, got: ${output[field]}`,
        ),
      )
    }
  }

  const expectedFilters = expected.filters
  const outputFilters = output.filters
  const filterKeys: (keyof typeof expectedFilters)[] = [
    "app",
    "entity",
    "count" as any,
    "startTime",
    "endTime",
    "sortDirection",
    "multipleAppAndEntity",
  ]

  for (const key of filterKeys) {
    total += 1
    if (outputFilters[key] === expectedFilters[key]) {
      score += 1
    } else {
      console.log(
        pc.yellow(
          `Mismatch in filter "${key}" → expected: ${expectedFilters[key]}, got: ${outputFilters[key]}`,
        ),
      )
    }
  }

  const finalScore = score / total
  return { score: finalScore }
}

// Use our custom implementation
const factualityScorer = strictClassificationScorer

const result: (Data & {
  output: TClassification
  score: number
})[] = []
for (const item of data) {
  const email = myEmail
  const userAndWorkspace = await getUserAndWorkspaceByEmail(
    db,
    workspaceId,
    email,
  )
  const ctx = userContext(userAndWorkspace)

  const searchOrAnswerIterator = generateSearchQueryOrAnswerFromConversation(
    item.input,
    ctx,
    {
      modelId: defaultBestModel,
      stream: false,
      json: true,
      messages: [],
    },
  )

  let queryFilters = {
    app: "",
    entity: "",
    startTime: "",
    endTime: "",
    count: 0,
    sortDirection: false,
  }
  let parsed = {
    answer: "",
    queryRewrite: "",
    temporalDirection: null,
    filter_query: "",
    type: "",
    filters: queryFilters,
  }

  let buffer = ""
  for await (const chunk of searchOrAnswerIterator) {
    if (chunk.text) {
      buffer += chunk.text
      try {
        parsed = jsonParseLLMOutput(buffer)
      } catch (err) {
        const errMessage = (err as Error).message
        continue
      }
    }
  }

  if (Object.keys(parsed).length) {
    const classification: TClassification = {
      direction: parsed.temporalDirection,
      type: parsed.type as QueryType,
      filter_query: parsed.filter_query,
      filters: {
        ...parsed.filters,
        app: parsed.filters.app as Apps,
        entity: parsed.filters.entity as any,
      },
    }

    const factuality = await factualityScorer({
      output: classification,
      expected: item.expected,
      input: item.input,
    })

    result.push({
      input: item.input,
      expected: item.expected,
      output: classification,
      score: (factuality.score ?? 0) * 100,
    })
  }
}

console.log(
  `Classification eval score: ${result.reduce((a, c) => a + c.score, 0) / result.length}`,
)

fs.writeFileSync(
  "classification_eval_result.json",
  JSON.stringify(result, null, 2),
)
