import llama3Tokenizer from "llama3-tokenizer-js"
import { encode } from "gpt-tokenizer"

import type { Context } from "hono"
import {
  autocomplete,
  deduplicateAutocomplete,
  groupVespaSearch,
  searchVespa,
  searchUsersByNamesAndEmails,
  getTimestamp,
  insert,
  GetDocument,
  UpdateDocument,
  updateUserQueryHistory,
} from "@/search/vespa"
import { z } from "zod"
import config from "@/config"
import { HTTPException } from "hono/http-exception"
import {
  userQuerySchema,
  userSchema,
  type VespaSearchResponse,
  type VespaUser,
} from "@/search/types"
import {
  VespaAutocompleteResponseToResult,
  VespaSearchResponseToSearchResult,
} from "@/search/mappers"
import {
  analyzeQueryForNamesAndEmails,
  analyzeQueryMetadata,
  askQuestion,
} from "@/ai/provider"
import {
  answerContextMap,
  answerMetadataContextMap,
  cleanContext,
  userContext,
} from "@/ai/context"
import { VespaSearchResultsSchema } from "@/search/types"
import { AnswerSSEvents } from "@/shared/types"
import { streamSSE } from "hono/streaming"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getPublicUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"
import type { PublicUserWorkspace } from "@/db/schema"
import { getErrorMessage } from "@/utils"
import { QueryCategory } from "@/ai/types"
const Logger = getLogger(Subsystem.Api)

const { JwtPayloadKey, maxTokenBeforeMetadataCleanup, defaultFastModel } =
  config

export const autocompleteSchema = z.object({
  query: z.string().min(2),
})

export const userQueryHistorySchema = z.object({
  docId: z.string().optional(),
  query: z.string(),
  timestamp: z.number().optional(),
})

export const chatSchema = z.object({
  chatId: z.string().min(1),
})

export const chatBookmarkSchema = z.object({
  chatId: z.string(),
  bookmark: z.boolean(),
})

export const chatRenameSchema = z.object({
  chatId: z.string().min(1),
  title: z.string().min(1),
})

export const chatDeleteSchema = z.object({
  chatId: z.string().min(1),
})

export const chatHistorySchema = z.object({
  page: z
    .string()
    .default("0")
    .transform((value) => parseInt(value, 10))
    .refine((value) => !isNaN(value), {
      message: "Page must be a valid number",
    }),
})

export const messageSchema = z.object({
  message: z.string().min(1),
  chatId: z.string().optional(),
  modelId: z.string().min(1),
})
export type MessageReqType = z.infer<typeof messageSchema>

export const messageRetrySchema = z.object({
  messageId: z.string().min(1),
})

export const AutocompleteApi = async (c: Context) => {
  try {
    const { sub } = c.get(JwtPayloadKey)
    const email = sub
    // @ts-ignore
    const body = c.req.valid("json")
    const { query } = body
    let results = await autocomplete(query, email, 5)
    if (!results) {
      return c.json({ children: [] })
    }
    results = deduplicateAutocomplete(results)
    const newResults = VespaAutocompleteResponseToResult(results)
    return c.json(newResults)
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(
      error,
      `Autocomplete Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not fetch autocomplete results",
    })
  }
}

export const SearchApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  const email = sub
  let {
    query,
    groupCount: gc,
    offset,
    page,
    app,
    entity,
    lastUpdated,
    isQueryTyped,
    // @ts-ignore
  } = c.req.valid("query")
  if(!page) {
    // @ts-ignore
    page = config.page
  }
  let groupCount: any = {}
  let results: VespaSearchResponse = {} as VespaSearchResponse
  const timestampRange = getTimestamp(lastUpdated)
    ? { from: getTimestamp(lastUpdated)!, to: new Date().getTime() }
    : null
  const decodedQuery = decodeURIComponent(query)
  if (gc) {
    const tasks: Array<any> = [
      groupVespaSearch(decodedQuery, email, page, timestampRange),
      searchVespa(
        decodedQuery,
        email,
        app,
        entity,
        page,
        offset,
        0.5,
        timestampRange,
      ),
    ]

    // ensure only update when query is typed
    if (isQueryTyped) {
      tasks.push(updateUserQueryHistory(decodedQuery, email))
    }
    ;[groupCount, results] = await Promise.all(tasks)
  } else {
    results = await searchVespa(
      decodedQuery,
      email,
      app,
      entity,
      page,
      offset,
      0.5,
      timestampRange,
    )
  }

  // TODO: deduplicate for google admin and contacts
  const newResults = VespaSearchResponseToSearchResult(results)
  newResults.groupCount = groupCount
  return c.json(newResults)
}

export const AnswerApi = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  const email = sub
  // @ts-ignore
  const { query, app, entity } = c.req.valid("query")
  const decodedQuery = decodeURIComponent(query)
  const [userAndWorkspace, results]: [
    PublicUserWorkspace,
    VespaSearchResponse,
  ] = await Promise.all([
    getPublicUserAndWorkspaceByEmail(db, workspaceId, email),
    searchVespa(decodedQuery, email, app, entity, config.answerPage, 0),
  ])

  const costArr: number[] = []

  const ctx = userContext(userAndWorkspace)
  const initialPrompt = `context about user asking the query\n${ctx}\nuser's query: ${query}`
  // could be called parallely if not for userAndWorkspace
  let { result, cost } = await analyzeQueryForNamesAndEmails(initialPrompt, {
    modelId: defaultFastModel,
    stream: false,
    json: true,
  })
  if (cost) {
    costArr.push(cost)
  }
  const initialContext = cleanContext(
    results.root.children
      .map((v) =>
        answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>),
      )
      .join("\n"),
  )

  const tokenLimit = maxTokenBeforeMetadataCleanup
  let useMetadata = false
  Logger.info(`User Asked: ${decodedQuery}`)
  // if we don't use this, 3.4 seems like a good approx value
  if (
    llama3Tokenizer.encode(initialContext).length > tokenLimit ||
    encode(initialContext).length > tokenLimit
  ) {
    useMetadata = true
  }

  let users: z.infer<typeof VespaSearchResultsSchema>[] = []
  if (result.category === QueryCategory.Self) {
    // here too I can talk about myself and others
    // eg: when did I send xyz person their offer letter
    const { mentionedNames, mentionedEmails } = result
    users = (
      await searchUsersByNamesAndEmails(
        mentionedNames,
        mentionedEmails,
        mentionedNames.length + 1 || mentionedEmails.length + 1 || 2,
      )
    ).root.children as z.infer<typeof VespaSearchResultsSchema>[]
  } else if (
    result.category === QueryCategory.InternalPerson ||
    result.category === QueryCategory.ExternalPerson
  ) {
    const { mentionedNames, mentionedEmails } = result
    users = (
      await searchUsersByNamesAndEmails(
        mentionedNames,
        mentionedEmails,
        mentionedNames.length + 1 || mentionedEmails.length + 1 || 2,
      )
    ).root.children as z.infer<typeof VespaSearchResultsSchema>[]
  }

  let existingUserIds = new Set<string>()
  if (users.length) {
    existingUserIds = new Set(
      results.root.children
        .filter(
          (v): v is z.infer<typeof VespaSearchResultsSchema> =>
            (v.fields as VespaUser).sddocname === userSchema,
        )
        .map((v) => v.fields.docId),
    )
  }

  const newUsers = users.filter(
    (user: z.infer<typeof VespaSearchResultsSchema>) =>
      !existingUserIds.has(user.fields.docId),
  )
  if (newUsers.length) {
    newUsers.forEach((user) => {
      results.root.children.push(user)
    })
  }
  const metadataContext = results.root.children
    .map((v, i) =>
      cleanContext(
        `Index ${i} \n ${answerMetadataContextMap(v as z.infer<typeof VespaSearchResultsSchema>)}`,
      ),
    )
    .join("\n\n")

  const analyseRes = await analyzeQueryMetadata(decodedQuery, metadataContext, {
    modelId: defaultFastModel,
    stream: true,
    json: true,
  })
  let output = analyseRes[0]
  cost = analyseRes[1]
  if (cost) {
    costArr.push(cost)
  }

  const finalContext = cleanContext(
    results.root.children
      .filter((v, i) => output?.contextualChunks.includes(i))
      .map((v) =>
        answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>),
      )
      .join("\n"),
  )

  return streamSSE(c, async (stream) => {
    Logger.info("SSE stream started")
    // Stream the initial context information
    await stream.writeSSE({
      data: ``,
      event: AnswerSSEvents.Start,
    })
    if (output?.canBeAnswered && output.contextualChunks.length) {
      const interator = askQuestion(decodedQuery, finalContext, {
        modelId: defaultFastModel,
        userCtx: ctx,
        stream: true,
        json: true,
      })
      for await (const { text, metadata, cost } of interator) {
        if (text) {
          await stream.writeSSE({
            event: AnswerSSEvents.AnswerUpdate,
            data: text,
          })
        }
        if (cost) {
          costArr.push(cost)
        }
      }

      Logger.info(
        `costArr: ${costArr} \n Total Cost: ${costArr.reduce((prev, curr) => prev + curr, 0)}`,
      )
    }
    await stream.writeSSE({
      data: "Answer complete",
      event: AnswerSSEvents.End,
    })

    Logger.info("SSE stream ended")
    stream.onAbort(() => {
      Logger.error("SSE stream aborted")
    })
  })
}
