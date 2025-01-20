//@ts-nocheck
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
import { Factuality, Levenshtein, type Score } from "autoevals"
import pc from "picocolors"
import {
  baselineRAG,
  baselineRAGJson,
  generateSearchQueryOrAnswerFromConversation,
  jsonParseLLMOutput,
  queryRewriter,
  queryRouterJsonStream,
  QueryType,
  temporalEventClassification,
} from "./provider"
import { Models, type TemporalClassifier, type TimeDirection } from "./types"
import fs from "fs"
import path from "path"
import { searchVespa } from "@/search/vespa"
import { answerContextMap, cleanContext, userContext } from "./context"
import type { z } from "zod"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"
import { splitGroupedCitationsWithSpaces } from "@/utils"
import type { ConversationRole, Message } from "@aws-sdk/client-bedrock-runtime"
import { UnderstandMessageAndAnswer } from "@/api/chat"
import { getDateForAI } from "@/utils/index"

const modelId = Models.Claude_3_5_Haiku

// for permission aware Evals
// add this value to run
const myEmail = ""

// workspace external Id
const workspaceId = ""

if (!myEmail) {
  throw new Error("Please set the email")
}

if (!workspaceId) {
  throw new Error("Please add the workspaceId")
}

const data: Data[] = []
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
  scores: any[]
}

const Eval = async (
  name: string,
  config: EvalConfig<Data, string, LLMResponse>,
  description?: string,
) => {
  const data = config.data()
  const factualityScorer = Factuality.partial({ model: "gpt-4o-mini" })
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
        let factuality: Score
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
            if (
              !error.message.includes("Unknown score choice") ||
              attempts === 5
            ) {
              throw error
            }
            console.log(`Retrying factuality (attempt ${attempts})...`)
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
          factuality: factuality!.score! * 100,
          duration,
        }

        if (response.retrievedItems) {
          evalResult.retrievedContext = simplifySearchResults(
            response.retrievedItems,
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
      let factuality
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
          if (
            !error.message.includes("Unknown score choice") ||
            attempts === 5
          ) {
            throw error
          }
          console.log(`Retrying factuality (attempt ${attempts})...`)
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
        factuality: factuality.score! * 100,
        duration,
      }

      if (response.retrievedItems) {
        evalResult.retrievedContext = simplifySearchResults(
          response.retrievedItems,
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

const basicJsonRagName = "basic-rag-json"
const basicRagName = "basic-rag"
const iterativeJsonRagName = "basic-iterative-rag-json"
const iterativeTimeexpansionJsonRagName = "iterative-time-expansion-rag-json"
const iterativeTimeFilterAndQueryRewriteRagName =
  "iterative-time-filter-query-rewrite"
const pointEventQueryTimeExpansionRagName = "event-query-time-expansion"
const endToEndIntegration = "end-to-end-integration"

const basicJsonRag = async () => {
  const pageSize = 15
  await Eval(
    basicJsonRagName,
    {
      data: (): Data[] => {
        return data
      },
      task: async (input: string): Promise<LLMResponse> => {
        console.log(input)
        let res = await generateAnswerJson(input, 0.5, pageSize)
        return res
      },
      scores: [Factuality],
    },
    `we just ask ai to generate answer or null with ${pageSize} pagesize`,
  )
}

async function generateAnswerJson(
  input: string,
  alpha: number = 0.5,
  pageSize: number = 10,
): Promise<LLMResponse> {
  const email = myEmail
  const message = input
  const results = await searchVespa(
    message,
    email,
    null,
    null,
    pageSize,
    0,
    alpha,
  )
  const initialContext = cleanContext(
    results.root.children
      .map(
        (v, i) =>
          `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, 4)}`,
      )
      .join("\n"),
  )

  const userAndWorkspace = await getUserAndWorkspaceByEmail(
    db,
    workspaceId,
    email,
  )
  const ctx = userContext(userAndWorkspace)
  const { output, cost } = await baselineRAGJson(input, ctx, initialContext, {
    stream: false,
    modelId,
  })
  return {
    answer: output.answer || "I don't know",
    costArr: [cost],
    retrievedItems: results.root.children,
  }
}
const basicRag = async () => {
  await Eval(basicRagName, {
    data: (): Data[] => {
      return data
    },
    task: async (input: string): Promise<LLMResponse> => {
      console.log(input)
      let res = await generateAnswer(input)
      return res
    },
    scores: [Factuality],
  })
}

const iterativeJsonRag = async () => {
  const pageSize = 20
  const maxPageNumber = 5
  const maxSummaryCount = 3
  await Eval(
    iterativeJsonRagName,
    {
      data: (): Data[] => {
        return data
      },
      task: async (input: string): Promise<LLMResponse> => {
        let res = await generateIterative(
          input,
          0.5,
          pageSize,
          maxPageNumber,
          maxSummaryCount,
        )
        return res
      },
      scores: [Factuality],
    },
    `we just ask ai to generate answer or null with ${pageSize} pagesize and iteratively go to the next page till ${maxPageNumber} and summary size ${maxSummaryCount}`,
  )
}

// this change was not there before
// what I'm about to do is first
// get latest results and then get the global results
// then combine them both for the first page results of iterative
// and let the answer come from it
// so basically we don't do answer for just latest
// we risk increasing noise but atleast both cases are catered to
const iterativeTimeExpansionJsonRag = async () => {
  const pageSize = 20
  const maxPageNumber = 5
  const maxSummaryCount = 3
  const monthInMs = 30 * 24 * 60 * 60 * 1000
  const initialRange = 3 * monthInMs // Start with 3 months
  const rangeIncrement = 3 * monthInMs // Increment by 3 months
  const maxRange = 18 * monthInMs // Maximum range of 18 months
  await Eval(
    iterativeTimeexpansionJsonRagName,
    {
      data: (): Data[] => {
        return data
      },
      task: async (input: string): Promise<LLMResponse> => {
        let res = await generateIterativeAndTimeExpansion(
          input,
          0.5,
          pageSize,
          maxPageNumber,
          maxSummaryCount,
        )
        return res
      },
      scores: [Factuality],
    },
    `we just ask ai to generate answer or null with ${pageSize} pagesize and, first check within 4 month range and then iteratively go to the next page till ${maxPageNumber} and summary size ${maxSummaryCount}`,
  )
}
async function generateIterativeTimeFilterAndQueryRewrite(
  input: string,
  alpha: number = 0.5,
  pageSize: number = 10,
  maxPageNumber: number = 3,
  maxSummaryCount: number | undefined,
  // timeRangeConfig: TimeRangeConfig,
): Promise<LLMResponse> {
  // we are not going to do time expansion
  // we are going to do 4 months answer
  // if not found we go back to iterative page search
  const message = input
  const email = myEmail
  let output = { answer: "", costArr: [], retrievedItems: [] }
  const userAndWorkspace = await getUserAndWorkspaceByEmail(
    db,
    workspaceId,
    email,
  )
  const ctx = userContext(userAndWorkspace)

  const monthInMs = 30 * 24 * 60 * 60 * 1000
  const latestResults = (
    await searchVespa(message, email, null, null, pageSize, 0, alpha, {
      from: new Date().getTime() - 4 * monthInMs,
      to: new Date().getTime(),
    })
  ).root.children

  const latestIds = latestResults
    .map((v: VespaSearchResult) => v?.fields.docId)
    .filter((v) => !!v)

  for (var pageNumber = 0; pageNumber < maxPageNumber; pageNumber++) {
    // should only do it once
    if (pageNumber === Math.floor(maxPageNumber / 2)) {
      // get the first page of results
      let results = await searchVespa(
        message,
        email,
        null,
        null,
        pageSize,
        0,
        alpha,
      )
      const initialContext = cleanContext(
        results.root.children
          .map(
            (v, i) =>
              `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, maxSummaryCount)}`,
          )
          .join("\n"),
      )
      const queryResp = await queryRewriter(input, ctx, initialContext, {
        modelId,
        stream: false,
      })
      const queries = queryResp.queries
      for (const query of queries) {
        const latestResults = (
          await searchVespa(query, email, null, null, pageSize, 0, alpha, {
            from: new Date().getTime() - 4 * monthInMs,
            to: new Date().getTime(),
          })
        ).root.children

        let results = await searchVespa(
          query,
          email,
          null,
          null,
          pageSize,
          0,
          alpha,
          null,
          latestResults
            .map((v: VespaSearchResult) => v?.fields.docId)
            .filter((v) => !!v),
        )
        const initialContext = cleanContext(
          results.root.children
            .concat(latestResults)
            .map(
              (v, i) =>
                `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, maxSummaryCount)}`,
            )
            .join("\n"),
        )

        const out = await baselineRAGJson(query, ctx, initialContext, {
          stream: false,
          modelId,
        })
        if (out.output.answer) {
          output.answer = out.output.answer
          output.costArr = [out.cost]
          output.retrievedItems = results.root.children
          return output
        }
      }
    }

    let results
    if (pageNumber === 0) {
      results = await searchVespa(
        message,
        email,
        null,
        null,
        pageSize,
        pageNumber * pageSize,
        alpha,
        null,
        latestIds,
      )
      results.root.children = results.root.children.concat(latestResults)
    } else {
      results = await searchVespa(
        message,
        email,
        null,
        null,
        pageSize,
        pageNumber * pageSize,
        alpha,
      )
    }
    const initialContext = cleanContext(
      results.root.children
        .map(
          (v, i) =>
            `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, maxSummaryCount)}`,
        )
        .join("\n"),
    )

    const out = await baselineRAGJson(input, ctx, initialContext, {
      stream: false,
      modelId,
    })
    if (out.output.answer) {
      output.answer = out.output.answer
      output.costArr = [out.cost]
      output.retrievedItems = results.root.children
      break
    } else {
      continue
    }
  }
  return {
    answer: output.answer || "I don't know",
    costArr: output.costArr || [],
    retrievedItems: output.retrievedItems,
    maxChunksRetrieved: maxSummaryCount,
  }
}
// if we are not able to find the info until certain page number
// we short circuit and try that many pages for a new query
const iterativeWithTimeFilterAndQueryRewrite = async () => {
  const pageSize = 20
  const maxPageNumber = 3
  const maxSummaryCount = 5
  const monthInMs = 30 * 24 * 60 * 60 * 1000
  const initialRange = 3 * monthInMs // Start with 3 months
  const rangeIncrement = 3 * monthInMs // Increment by 3 months
  const maxRange = 18 * monthInMs // Maximum range of 18 months
  await Eval(
    iterativeTimeFilterAndQueryRewriteRagName,
    {
      data: (): Data[] => {
        return data
      },
      task: async (input: string): Promise<LLMResponse> => {
        let res = await generateIterativeTimeFilterAndQueryRewrite(
          input,
          0.5,
          pageSize,
          maxPageNumber,
          maxSummaryCount,
        )
        if (res.answer) {
          res.answer = splitGroupedCitationsWithSpaces(res.answer)
        }
        return res
      },
      scores: [Factuality],
    },
    `we just ask ai to generate answer or null with ${pageSize} pagesize and, first check within 4 month range and then iteratively go to the next page till ${maxPageNumber} and summary size ${maxSummaryCount}
      what we also do is rewrite the query if we didn't find an answer for the first page`,
  )
}

const pointEventQueryTimeExpansion = async () => {
  const pageSize = 20
  const maxPageNumber = 3
  const maxSummaryCount = 3
  const weekInMs = 7 * 24 * 60 * 60 * 1000
  await Eval(
    pointEventQueryTimeExpansionRagName,
    {
      data: (): Data[] => {
        return data
      },
      task: async (input: string): Promise<LLMResponse> => {
        let res = await generatePointQueryTimeExpansion(
          input,
          0.5,
          pageSize,
          maxPageNumber,
          maxSummaryCount,
        )
        return res
      },
      scores: [Factuality],
    },
    `we just ask ai to generate answer or null with summary size ${maxSummaryCount}, point query and time expansion in appropriate direction`,
  )
}

const generatePointQueryTimeExpansion = async (
  input: string,
  alpha: number,
  pageSize: number = 10,
  maxPageNumber: number = 3,
  maxSummaryCount: number | undefined,
) => {
  const email = myEmail
  const message = input
  const directionOutput = await temporalEventClassification(input, {
    modelId,
    stream: false,
  })
  if (directionOutput.direction === null) {
    return {
      answer: "I don't know",
      costArr: [directionOutput.cost],
      retrievedItems: [],
    }
  }

  const userAndWorkspace = await getUserAndWorkspaceByEmail(
    db,
    workspaceId,
    email,
  )
  const ctx = userContext(userAndWorkspace)
  const maxIterations = 10
  const weekInMs = 12 * 24 * 60 * 60 * 1000
  const direction = directionOutput.direction

  let from = new Date().getTime()
  let to = new Date().getTime()
  let lastSearchedTime = direction === "prev" ? from : to
  console.log("direction ", direction)
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const windowSize = (2 + iteration) * weekInMs
    console.log("window size", windowSize)
    if (direction === "prev") {
      to = lastSearchedTime
      from = to - windowSize
      lastSearchedTime = from
    } else {
      from = lastSearchedTime
      to = from + windowSize
      lastSearchedTime = to
    }

    console.log("to ", new Date(to))
    console.log("from ", new Date(from))
    const eventResults = await searchVespa(
      message,
      email,
      Apps.GoogleCalendar,
      null,
      pageSize,
      0,
      alpha,
      { from, to },
    )
    const results = await searchVespa(
      message,
      email,
      null,
      null,
      pageSize,
      0,
      alpha,
      { to, from },
      ["CATEGORY_PROMOTIONS", "UNREAD"],
    )
    if (!results.root.children) {
      results.root.children = []
    }
    results.root.children = results.root.children.concat(
      eventResults.root.children || [],
    )
    // TODO: do this in the vespa queries
    // filter out only gmail and events
    results.root.children = results.root.children.filter((v) => {
      // @ts-ignore
      if (v.fields.app === Apps.Gmail || v.fields.app === Apps.GoogleCalendar) {
        return true
      }
      return false
    })
    console.log("search result count ", results.root.children.length)
    // we couldn't find any gmail or event
    // we continue the expansion
    if (!results.root.children.length) {
      console.log("no gmail or calendar event found")
      continue
    }
    const initialContext = cleanContext(
      results.root.children
        .map(
          (v, i) =>
            `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>, maxSummaryCount)}`,
        )
        .join("\n"),
    )
    // console.log(initialContext)

    const { output, cost } = await baselineRAGJson(input, ctx, initialContext, {
      stream: false,
      modelId,
    })
    if (output.answer) {
      return {
        answer: output.answer,
        costArr: [cost, directionOutput.cost],
        retrievedItems: results.root.children,
      }
    }
  }
  return {
    answer:
      "I could not find any information to answer it, please change your query",
    costArr: [directionOutput.cost],
    retrievedItems: [],
  }
}

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
          ? fileFields.chunks_summary?.slice(0, maxChunksRetrieved)
          : fileFields.chunks_summary,
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
          ? mailFields.chunks_summary?.slice(0, maxChunksRetrieved)
          : mailFields.chunks_summary,
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
        app: fields.app,
        entity: fields.entity,
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
  messages: Message[],
) => {
  const ctx = userCtx
  const costArr = []
  const email = myEmail
  const searchOrAnswerIterator = generateSearchQueryOrAnswerFromConversation(
    message,
    ctx,
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
  let parsed = { answer: "", queryRewrite: "" }
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

  if (parsed.answer === null) {
    // ambigious user message
    if (parsed.queryRewrite) {
      message = parsed.queryRewrite
    }
    const classification: TemporalClassifier & { cost: number } =
      await temporalEventClassification(message, {
        modelId,
        stream: false,
      })
    const iterator = UnderstandMessageAndAnswer(
      email,
      ctx,
      message,
      classification,
      messages,
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
  // return answer
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
        // const formattedMessages = messages ?
        // messages.map((msg, index) => ({
        //   role: "user",
        //   content: [{ text: (msg as Data).input }]
        // })) : [];
        const ctx = userContext(userAndWorkspace)

        const answer = await endToEndFlow(input, ctx, messages || [])

        // For demo purposes, assuming cost of 0.001 per response
        return {
          answer: answer || "I don't know",
          costArr: [0.001],
          retrievedItems: [], // Ideally would track retrieved items from search
        }
      },
      scores: [Factuality],
    },
    `End-to-end integration evaluation including conversations`,
  )
}

// endToEndFactual()
