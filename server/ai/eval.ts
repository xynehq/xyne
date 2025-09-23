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
} from "@xyne/vespa-ts/types"
import OpenAI from "openai"
import pc from "picocolors"
import {
  generateSearchQueryOrAnswerFromConversation,
  getProviderByModel,
  jsonParseLLMOutput,
} from "./provider"
import {
  Models,
  type LLMProvider,
  type ModelParams,
  type QueryRouterLLMResponse,
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
import { UnderstandMessageAndAnswer } from "@/api/chat/chat"
import { getTracer } from "@/tracer"
import { OpenAIProvider } from "./provider/openai"
import { getLogger } from "@/logger"
import { Subsystem, type UserMetadataType } from "@/types"
import config from "@/config"
import { getDateForAI } from "@/utils/index"
const Logger = getLogger(Subsystem.Eval)
const { defaultFastModel } = config
const modelId = defaultFastModel || Models.Claude_3_5_Haiku

// for permission aware Evals
// add this value to run
const myEmail = "user@gmail.com" // Add your email here

// workspace external Id : Adding the workspace id for the evals
const workspaceId = "q7********" // Add your workspace id here

if (!myEmail) {
  throw new Error("Please set the email")
}

if (!workspaceId) {
  throw new Error("Please add the workspaceId")
}

const loadTestData = async (): Promise<Data[]> => {
  try {
    const filePath = path.join("..", "eval-data", "test-queries.json")
    const data = await fs.promises.readFile(filePath, "utf-8")
    const parsedData = JSON.parse(data)

    if (!Array.isArray(parsedData)) {
      throw new Error("Test data must be an array")
    }

    return parsedData
  } catch (error) {
    console.error("Error loading test data:", error)
    throw error
  }
}

const data = await loadTestData()

if (!data.length) {
  throw new Error("Data is not set for the evals")
}

type Data = {
  input: string
  expected: string
}

interface EvalResult {
  id: number
  type: string
  input: string
  output: string
  expected: string
  tags: string
  factuality: number
  duration: number
  cost?: number
  description?: string
  retrievedContext?: SimplifiedSearchResult[]
  conversation?: EvalResult[]
}

type EvalResults = (EvalResult | EvalResult[])[]

type Eval = {
  results: EvalResults
  name: string
  description?: string
  timestamp: number
  modelId: string
}

type LLMResponse = {
  answer: string
  costArr: number[]
  retrievedItems: VespaSearchResults
  maxPageNumber?: number // max page number for iterative
  maxChunksRetrieved?: number // max chunks summary
}

const saveEvalResults = (evaluation: Eval, name: string) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const fileName = `${name}-${timestamp}.json`
  const filePath = path.join(process.cwd(), "eval-results", fileName)

  // Ensure directory exists
  if (!fs.existsSync(path.join(process.cwd(), "eval-results"))) {
    fs.mkdirSync(path.join(process.cwd(), "eval-results"))
  }

  fs.writeFileSync(filePath, JSON.stringify(evaluation, null, 2))
  return fileName
}

interface EvalConfig<T, I, O> {
  data: () => (T | T[])[]
  task: (input: I, context?: Message[]) => Promise<O>
}

// Add custom Score type definition
type CustomScore = {
  score: number
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
  args: { input: string; expected: string; output: string },
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
    args.expected,
    args.output,
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

const Eval = async (
  name: string,
  config: EvalConfig<Data, string, LLMResponse>,
  description?: string,
) => {
  const data = config.data()

  // Custom LLM-based factuality scorer
  const customFactualityScorer = async (params: {
    input: string
    output: string
    expected: string
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

  // Use our custom implementation
  const factualityScorer = customFactualityScorer

  const results: EvalResults = []
  let resultId = 1

  for (const item of data) {
    if (Array.isArray(item)) {
      // Handle conversation case
      const conversationResults: EvalResult[] = []
      const messages: Message[] = []

      for (const turn of item) {
        const startTime = Date.now()

        const response = await config.task(turn.input, messages)
        messages.push({
          role: "user",
          content: [{ text: turn.input }],
        })

        messages.push({
          role: "assistant",
          content: [{ text: response.answer }],
        })

        let attempts = 0
        let factuality: CustomScore = { score: 0 } // Initialize with a default score
        while (attempts < 5) {
          attempts++
          try {
            factuality = await factualityScorer({
              output: response.answer,
              expected: turn.expected,
              input: turn.input,
            })
            break
          } catch (error: any) {
            console.log(
              `Evaluation error (attempt ${attempts}): ${error.message}`,
            )
            if (attempts === 5) {
              factuality = { score: 0.5 } // Default score after max attempts
            }
          }
        }

        const duration = (Date.now() - startTime) / 1000
        const evalResult: EvalResult = {
          id: resultId++,
          type: name,
          input: turn.input,
          output: response.answer,
          expected: turn.expected,
          tags: "-",
          cost: response.costArr.reduce((acc, value) => acc + value, 0),
          factuality: factuality?.score * 100,
          duration,
        }

        if (response.retrievedItems) {
          evalResult.retrievedContext = simplifySearchResults(
            Array.isArray(response.retrievedItems)
              ? response.retrievedItems
              : [response.retrievedItems],
            response.maxChunksRetrieved,
          )
        }

        conversationResults.push(evalResult)
      }

      results.push(conversationResults)
    } else {
      // Handle single query case
      const startTime = Date.now()
      const response = await config.task(item.input)
      let attempts = 0
      let factuality: CustomScore = { score: 0 }
      while (attempts < 5) {
        attempts++
        try {
          factuality = await factualityScorer({
            output: response.answer,
            expected: item.expected,
            input: item.input,
          })
          break
        } catch (error: any) {
          console.log(
            `Evaluation error (attempt ${attempts}): ${error.message}`,
          )
          if (attempts === 5) {
            factuality = { score: 0.5 } // Default score after max attempts
          }
        }
      }

      const duration = (Date.now() - startTime) / 1000
      const evalResult: EvalResult = {
        id: resultId++,
        type: name,
        input: item.input,
        output: response.answer,
        expected: item.expected,
        tags: "-",
        cost: response.costArr.reduce((acc, value) => acc + value, 0),
        factuality: (factuality?.score || 0.5) * 100,
        duration,
      }

      if (response.retrievedItems) {
        evalResult.retrievedContext = simplifySearchResults(
          Array.isArray(response.retrievedItems)
            ? response.retrievedItems
            : [response.retrievedItems],
          response.maxChunksRetrieved,
        )
      }

      results.push(evalResult)
    }
  }

  const fileName = saveEvalResults(
    {
      name,
      description,
      results,
      timestamp: new Date().getTime(),
      modelId,
    },
    name,
  )
  console.log(`Results saved to: ${fileName}`)
  console.log(results)
  const flatResults = results.flat(1)
  const basicScore =
    flatResults.reduce((acc, v) => acc + v.factuality, 0) / flatResults.length
  console.log(`Basic score: ${pc.greenBright(basicScore.toFixed(2))}`)
}

const endToEndIntegration = "end-to-end-integration"

interface SimplifiedSearchResult {
  type: string
  title?: string
  chunks_summary?: string[]
  description?: string
  app: Apps
  entity: string
  schema: string
  relevance: number
}

function simplifySearchResults(
  items: VespaSearchResults[],
  maxChunksRetrieved?: number,
): SimplifiedSearchResult[] {
  return items.map((item) => {
    const fields = item.fields
    let simplified: SimplifiedSearchResult

    if ((fields as VespaFileSearch).sddocname === fileSchema) {
      const fileFields = fields as VespaFileSearch
      simplified = {
        type: fileSchema,
        title: fileFields.title,
        chunks_summary: maxChunksRetrieved
          ? fileFields.chunks_summary
              ?.slice(0, maxChunksRetrieved)
              .map((chunk) => (typeof chunk === "string" ? chunk : chunk.chunk))
          : fileFields.chunks_summary?.map((chunk) =>
              typeof chunk === "string" ? chunk : chunk.chunk,
            ),
        app: fileFields.app,
        entity: fileFields.entity,
        schema: fileFields.sddocname,
        relevance: item.relevance,
      }
    } else if ((fields as VespaUser).sddocname === userSchema) {
      const userFields = fields as VespaUser
      simplified = {
        type: userSchema,
        title: userFields.name,
        app: userFields.app,
        entity: userFields.entity,
        schema: userFields.sddocname,
        relevance: item.relevance,
      }
    } else if ((fields as VespaMailSearch).sddocname === mailSchema) {
      const mailFields = fields as VespaMailSearch
      simplified = {
        type: mailSchema,
        title: mailFields.subject,
        chunks_summary: maxChunksRetrieved
          ? mailFields.chunks_summary
              ?.slice(0, maxChunksRetrieved)
              .map((chunk) => (typeof chunk === "string" ? chunk : chunk.chunk))
          : mailFields.chunks_summary?.map((chunk) =>
              typeof chunk === "string" ? chunk : chunk.chunk,
            ),
        app: mailFields.app,
        entity: mailFields.entity,
        schema: mailFields.sddocname,
        relevance: item.relevance,
      }
    } else if ((fields as VespaEventSearch).sddocname === eventSchema) {
      const eventFields = fields as VespaEventSearch
      simplified = {
        type: eventSchema,
        title: eventFields.name,
        description: eventFields.description,
        app: eventFields.app,
        entity: eventFields.entity,
        schema: eventFields.sddocname,
        relevance: item.relevance,
      }
    } else {
      // Default case if schema is not recognized
      simplified = {
        type: fields.sddocname,
        app: (fields as { app: Apps }).app,
        entity: (fields as any).entity,
        schema: fields.sddocname,
        relevance: item.relevance,
      }
    }

    return simplified
  })
}

const endToEndFlow = async (
  message: string,
  userCtx: string,
  userMetadata: UserMetadataType,
  messages: Message[],
) => {
  const ctx = userCtx
  const costArr = []
  const email = myEmail
  const searchOrAnswerIterator = generateSearchQueryOrAnswerFromConversation(
    message,
    ctx,
    userMetadata,
    {
      modelId,
      stream: true,
      json: true,
      messages,
    },
  )

  let currentAnswer = ""
  let answer = ""
  let citations = []
  let citationMap: Record<number, number> = {}
  let queryFilters = {
    apps: [],
    entities: [],
    startTime: "",
    endTime: "",
    count: 0,
    offset: 0,
  }
  let parsed = {
    answer: "",
    queryRewrite: "",
    temporalDirection: null,
    filterQuery: "",
    filters: queryFilters,
    type: "",
    from: null,
    to: null,
  }
  let buffer = ""
  for await (const chunk of searchOrAnswerIterator) {
    if (chunk.text) {
      buffer += chunk.text
      try {
        parsed = jsonParseLLMOutput(buffer)
        if (parsed.answer && currentAnswer !== parsed.answer) {
          if (currentAnswer === "") {
          } else {
            // Subsequent chunks - send only the new part
            const newText = parsed.answer.slice(currentAnswer.length)
          }
          currentAnswer = parsed.answer
        }
      } catch (err) {
        const errMessage = (err as Error).message
        continue
      }
    }
    if (chunk.cost) {
      costArr.push(chunk.cost)
    }
  }
  if (parsed.answer === null || parsed.answer === "") {
    if (parsed.queryRewrite) {
      message = parsed.queryRewrite
    }

    const classification: QueryRouterLLMResponse = {
      direction: parsed.temporalDirection,
      type: parsed.type as any,
      filterQuery: parsed.filterQuery,
      filters: {
        ...parsed.filters,
        apps: parsed.filters.apps as Apps[],
        entities: parsed.filters.entities as any,
      },
    }

    const tracer = getTracer("chat")
    const rootSpan = tracer.startSpan("MessageApi")
    const passedSpan = rootSpan.startSpan("rag_processing")
    const ragSpan = passedSpan?.startSpan("iterative_rag")
    const iterator = UnderstandMessageAndAnswer(
      email,
      ctx,
      userMetadata,
      message,
      classification,
      messages,
      0.5,
      false,
      ragSpan,
    )

    answer = ""
    citations = []
    citationMap = {}
    for await (const chunk of iterator) {
      if (chunk.text) {
        answer += chunk.text
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
  } else if (parsed.answer) {
    answer = parsed.answer
  }
  return answer
}

const endToEndFactual = async () => {
  await Eval(
    endToEndIntegration,
    {
      data: (): (Data | Data[])[] => {
        // Return both single queries and conversations
        return data
      },
      task: async (
        input: string,
        messages?: Message[],
      ): Promise<LLMResponse> => {
        const email = myEmail
        const userAndWorkspace = await getUserAndWorkspaceByEmail(
          db,
          workspaceId,
          email,
        )
        const ctx = userContext(userAndWorkspace)
        const userTimezone = userAndWorkspace?.user?.timeZone || "Asia/Kolkata"
        const dateForAI = getDateForAI({ userTimeZone: userTimezone})
        const userMetadata: UserMetadataType = {userTimezone, dateForAI}

        const answer = await endToEndFlow(input, ctx, userMetadata,messages || [])

        // For demo purposes, assuming cost of 0.001 per response
        return {
          answer: answer || "I don't know",
          costArr: [0.001],
          retrievedItems: [] as unknown as VespaSearchResults, // Ideally would track retrieved items from search
        }
      },
    },
    `End-to-end integration evaluation including conversations`,
  )
}

endToEndFactual()
