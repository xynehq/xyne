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
  DeleteDocument,
  updateUserQueryHistory,
  searchVespaAgent,
  getFolderItems,
  GetDocumentsByDocIds,
} from "@/search/vespa"
import { z } from "zod"
import config from "@/config"
import { HTTPException } from "hono/http-exception"
import {
  userSchema,
  APP_INTEGRATION_MAPPING,
  type VespaSearchResponse,
  type VespaUser,
  SlackEntity,
  SearchModes,
  fileSchema,
  DriveEntity,
} from "@xyne/vespa-ts/types"

import {
  VespaAutocompleteResponseToResult,
  VespaSearchResponseToSearchResult,
} from "@xyne/vespa-ts/mappers"
import {
  analyzeQueryForNamesAndEmails,
  analyzeQueryMetadata,
  askQuestion,
} from "@/ai/provider"
import { Models } from "@/ai/types"
import {
  answerContextMap,
  answerMetadataContextMap,
  cleanContext,
  userContext,
} from "@/ai/context"
import { AnswerSSEvents, AuthType, ConnectorStatus } from "@/shared/types"
import { agentPromptPayloadSchema } from "@/shared/types"
import { streamSSE } from "hono/streaming"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { getPublicUserAndWorkspaceByEmail, getUserByEmail } from "@/db/user"
import { db } from "@/db/client"
import type { PublicUserWorkspace } from "@/db/schema"
import { getErrorMessage } from "@/utils"
import { QueryCategory } from "@/ai/types"
import {
  getUserPersonalization,
  getUserPersonalizationByEmail,
  getUserPersonalizationAlpha,
} from "@/db/personalization"
import { getAgentByExternalId } from "@/db/agent"
import { getWorkspaceByExternalId } from "@/db/workspace"
import { Apps } from "@/shared/types"
import type {
  VespaSearchResult,
  VespaSearchResults,
  VespaSearchResultsSchema,
} from "@xyne/vespa-ts/types"
import { getConnectorByAppAndEmailId } from "@/db/connector"
import { chunkDocument } from "@/chunks"
import { getAppSyncJobsByEmail } from "@/db/syncJob"
import { getTracer } from "@/tracer"
import { getDateForAI } from "@/utils/index"
const loggerWithChild = getLoggerWithChild(Subsystem.Api)

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

export const followUpQuestionsSchema = z.object({
  chatId: z.string().min(1),
  messageId: z.string().min(1),
})

export const chatBookmarkSchema = z.object({
  chatId: z.string(),
  bookmark: z.boolean(),
})

export const chatRenameSchema = z.object({
  chatId: z.string().min(1),
  title: z.string().min(1),
})

export const highlightSchema = z.object({
  chunkText: z.string().min(1).max(10_000),
  documentContent: z.string().min(1),
  options: z.object({
    caseSensitive: z.boolean().default(false),
    fuzzyMatching: z.boolean().default(true),
    errorTolerance: z.number().min(0).max(10).default(2),
    maxPatternLength: z.number().min(1).max(128).default(32),
  }).default({
    caseSensitive: false,
    fuzzyMatching: true,
    errorTolerance: 2,
    maxPatternLength: 32,
  }),
})

export const chatStopSchema = z.object({
  chatId: z.string().min(1),
})

export const chatTraceSchema = z.object({
  chatId: z.string().min(1),
  messageId: z.string().min(1),
})

export const chatDeleteSchema = z.object({
  chatId: z.string().min(1),
})

export const chatTitleSchema = z.object({
  chatId: z.string().min(1),
  message: z.string().min(1),
})

export const chatHistorySchema = z.object({
  page: z
    .string()
    .default("0")
    .transform((value) => parseInt(value, 10))
    .refine((value) => !isNaN(value), {
      message: "Page must be a valid number",
    }),
  from: z
    .string()
    .optional()
    .transform((val) => (val ? new Date(val) : undefined)),
  to: z
    .string()
    .optional()
    .transform((val) => (val ? new Date(val) : undefined)),
})

export const dashboardDataSchema = z.object({
  from: z
    .string()
    .optional()
    .transform((val) => (val ? new Date(val) : undefined)),
  to: z
    .string()
    .optional()
    .transform((val) => (val ? new Date(val) : undefined)),
})

export const sharedAgentUsageSchema = z.object({
  from: z
    .string()
    .optional()
    .transform((val) => (val ? new Date(val) : undefined)),
  to: z
    .string()
    .optional()
    .transform((val) => (val ? new Date(val) : undefined)),
})

export const agentChatMessageSchema = z.object({
  message: z.string(),
  chatId: z.string().optional(),
  path: z.string().optional(),
  modelId: z.string().min(1),
  isReasoningEnabled: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return false
      return val.toLowerCase() === "true"
    }),
  agentId: z.string(),
  streamOff: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return false
      return val.toLowerCase() === "true"
    }),
})

export const messageSchema = z.object({
  message: z.string().min(1),
  path: z.string().optional(),
  chatId: z.string().optional(),
  selectedModelConfig: z.string().optional(), // JSON string containing model config
  agentId: z.string().optional(),
  toolsList: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        try {
          return JSON.parse(val)
        } catch {
          return undefined
        }
      }
      return val
    },
    z
      .array(
        z.object({
          connectorId: z.string(),
          tools: z.array(z.string()),
        }),
      )
      .optional(),
  ),
  agentPromptPayload: agentPromptPayloadSchema.optional(),
  streamOff: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return false
      return val.toLowerCase() === "true"
    }),
})
export type MessageReqType = z.infer<typeof messageSchema>

export const messageRetrySchema = z.object({
  messageId: z.string().min(1),
  agentId: z.string().optional(),
  agentic: z.string().optional().default("false"),
  selectedModelConfig: z.string().optional(),
})

export type MessageRetryReqType = z.infer<typeof messageRetrySchema>

// Schema for prompt generation request
export const generatePromptSchema = z.object({
  requirements: z.string().min(1, "Requirements are required"),
  modelId: z
    .string()
    .optional()
    .refine(
      (value) => !value || Object.values(Models).includes(value as Models),
      {
        message: "Invalid modelId parameter",
      },
    ),
})

export type GeneratePromptPayload = z.infer<typeof generatePromptSchema>

export const AutocompleteApi = async (c: Context) => {
  let email = ""
  try {
    const { sub } = c.get(JwtPayloadKey)
    email = sub
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
    loggerWithChild({ email: email }).error(
      error,
      `Autocomplete Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not fetch autocomplete results",
    })
  }
}

export const SearchApi = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  const email = sub
  let userAlpha = await getUserPersonalizationAlpha(db, email)

  let {
    query,
    groupCount: gc,
    offset,
    page,
    app,
    entity,
    lastUpdated,
    isQueryTyped,
    debug,
    agentId,
    // @ts-ignore
  } = c.req.valid("query")
  let groupCount: any = {}
  let results: VespaSearchResponse = {} as VespaSearchResponse
  const timestampRange = getTimestamp(lastUpdated)
    ? { from: getTimestamp(lastUpdated)!, to: new Date().getTime() }
    : null
  const decodedQuery = decodeURIComponent(query)

  if (agentId) {
    const workspaceExternalId = workspaceId
    loggerWithChild({ email: email }).info(
      `Performing agent-specific search for agentId (external_id): ${agentId}, query: "${decodedQuery}", user: ${email}, workspaceExternalId: ${workspaceExternalId}`,
    )

    const workspace = await getWorkspaceByExternalId(db, workspaceExternalId)
    if (!workspace) {
      loggerWithChild({ email: email }).warn(
        `Workspace not found for externalId: ${workspaceExternalId}. Falling back to global search.`,
      )
    } else {
      const numericWorkspaceId = workspace.id
      loggerWithChild({ email: email }).info(
        `Workspace found: id=${numericWorkspaceId} for externalId=${workspaceExternalId}. Looking for agent.`,
      )
      // agentId from the frontend is the external_id
      const agent = await getAgentByExternalId(db, agentId, numericWorkspaceId)

      if (
        agent &&
        agent.appIntegrations &&
        Array.isArray(agent.appIntegrations) &&
        agent.appIntegrations.length > 0
      ) {
        const dynamicAllowedApps: Apps[] = []
        const dynamicDataSourceIds: string[] = []

        if (Array.isArray(agent.appIntegrations)) {
          for (const integration of agent.appIntegrations) {
            if (typeof integration === "string") {
              const lowerIntegration = integration.toLowerCase()

              // Handle data source IDs
              if (lowerIntegration.startsWith("ds-")) {
                dynamicDataSourceIds.push(integration)
                if (!dynamicAllowedApps.includes(Apps.DataSource)) {
                  dynamicAllowedApps.push(Apps.DataSource)
                }
                continue
              }

              const mappedApp = APP_INTEGRATION_MAPPING[lowerIntegration]
              if (mappedApp && !dynamicAllowedApps.includes(mappedApp)) {
                dynamicAllowedApps.push(mappedApp)
              } else if (!mappedApp) {
                loggerWithChild({ email: email }).warn(
                  `Unknown app integration string: ${integration} for agent ${agentId}`,
                )
              }
            }
          }
        }

        // Ensure we have at least one app if data sources are present
        if (
          dynamicAllowedApps.length === 0 &&
          dynamicDataSourceIds.length > 0
        ) {
          dynamicAllowedApps.push(Apps.DataSource)
        }
        const channelIds =
          agent.docIds
            ?.filter(
              (doc) =>
                doc.app === Apps.Slack &&
                doc.entity === SlackEntity.Channel &&
                doc.docId,
            )
            .map((doc) => doc.docId) ?? []

        loggerWithChild({ email: email }).info(
          `Agent ${agentId} search: AllowedApps=[${dynamicAllowedApps.join(", ")}], DataSourceIDs=[${dynamicDataSourceIds.join(", ")}], Entity=${entity}. Query: "${decodedQuery}".`,
        )

        results = await searchVespaAgent(
          decodedQuery,
          email,
          null,
          entity,
          dynamicAllowedApps.length > 0 ? dynamicAllowedApps : null,
          {
            alpha: userAlpha,
            limit: page,
            offset: offset,
            requestDebug: debug,
            dataSourceIds: dynamicDataSourceIds,
            timestampRange: timestampRange,
            channelIds: channelIds,
          },
        )
        try {
          const newResults = VespaSearchResponseToSearchResult(
            results,
            {
              chunkDocument: chunkDocument,
            },
            email,
          )
          newResults.groupCount = {} // Agent search currently doesn't provide group counts
          return c.json(newResults)
        } catch (e) {
          loggerWithChild({ email: email }).error(
            e,
            `Error processing/responding to agent search for agentId ${agentId}, query "${decodedQuery}". Results: ${JSON.stringify(results)}`,
          )
          throw new HTTPException(500, {
            message: "Error processing agent search results",
          })
        }
      } else {
        loggerWithChild({ email: email }).warn(
          `Agent ${agentId} not found in workspace ${numericWorkspaceId}, or appIntegrations is missing/empty. Falling back to global search. Agent details: ${JSON.stringify(agent)}`,
        )
      }
    }
  }
  loggerWithChild({ email: email }).info(
    `Performing global search for query: "${decodedQuery}", user: ${email}, app: ${app}, entity: ${entity}`,
  )
  if (gc) {
    let isSlackConnected = false
    let isDriveConnected = false
    let isGmailConnected = false
    let isCalendarConnected = false
    try {
      const connector = await getConnectorByAppAndEmailId(
        db,
        Apps.Slack,
        AuthType.OAuth,
        email,
      )
      isSlackConnected =
        connector && connector.status === ConnectorStatus.Connected
    } catch (error) {
      loggerWithChild({ email: email }).error(
        error,
        "Error fetching Slack connector",
      )
    }
    try {
      const authTypeForSyncJobs =
        process.env.NODE_ENV !== "production"
          ? AuthType.OAuth
          : AuthType.ServiceAccount
      const [driveConnector, gmailConnector, calendarConnector] =
        await Promise.all([
          getAppSyncJobsByEmail(
            db,
            Apps.GoogleDrive,
            authTypeForSyncJobs,
            email,
          ),
          getAppSyncJobsByEmail(db, Apps.Gmail, authTypeForSyncJobs, email),
          getAppSyncJobsByEmail(
            db,
            Apps.GoogleCalendar,
            authTypeForSyncJobs,
            email,
          ),
        ])
      isDriveConnected = Boolean(driveConnector && driveConnector.length > 0)
      isGmailConnected = Boolean(gmailConnector && gmailConnector.length > 0)
      isCalendarConnected = Boolean(
        calendarConnector && calendarConnector.length > 0,
      )
    } catch (error) {
      loggerWithChild({ email: email }).error(
        error,
        "Error fetching google sync Jobs",
      )
    }

    const tasks: Array<any> = [
      groupVespaSearch(
        decodedQuery,
        email,
        config.page,
        isSlackConnected,
        isGmailConnected,
        isCalendarConnected,
        isDriveConnected,
        timestampRange,
      ),
      searchVespa(decodedQuery, email, app, entity, {
        alpha: userAlpha,
        limit: page,
        requestDebug: debug,
        offset,
        timestampRange,
      }),
    ]
    // ensure only update when query is typed
    if (isQueryTyped) {
      tasks.push(updateUserQueryHistory(decodedQuery, email))
    }
    ;[groupCount, results] = await Promise.all(tasks)
  } else {
    results = await searchVespa(decodedQuery, email, app, entity, {
      alpha: userAlpha,
      limit: page,
      requestDebug: debug,
      offset,
      timestampRange,
      rankProfile: SearchModes.BoostTitle,
    })
  }

  // TODO: deduplicate for google admin and contacts

  const newResults = VespaSearchResponseToSearchResult(
    results,
    { chunkDocument: chunkDocument },
    email,
  )
  newResults.groupCount = groupCount
  return c.json(newResults)
}

export const SearchSlackChannels = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  const email = sub
  // @ts-ignore
  const { query } = c.req.valid("query")
  const decodedQuery = decodeURIComponent(query)
  const results = await searchVespa(
    `*${decodedQuery}*`,
    email,
    Apps.Slack,
    SlackEntity.Channel,
    {},
  )
  const newResults = VespaSearchResponseToSearchResult(results, {
    chunkDocument: chunkDocument,
  })
  return c.json(newResults)
}

export const AnswerApi = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  const email = sub
  let userAlpha = await getUserPersonalizationAlpha(db, email)

  // @ts-ignore
  const { query, app, entity } = c.req.valid("query")
  const decodedQuery = decodeURIComponent(query)
  const [userAndWorkspace, results]: [
    PublicUserWorkspace,
    VespaSearchResponse,
  ] = await Promise.all([
    getPublicUserAndWorkspaceByEmail(db, workspaceId, email),
    searchVespa(decodedQuery, email, app, entity, {
      requestDebug: config.isDebugMode,
      limit: config.answerPage,
      alpha: userAlpha,
    }),
  ])

  const costArr: number[] = []

  const ctx = userContext(userAndWorkspace)
  const dateForAI = getDateForAI({userTimeZone: userAndWorkspace.user.timeZone || "Asia/Kolkata"})
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
      .map((v) => answerContextMap(v as VespaSearchResults))
      .join("\n"),
  )

  const tokenLimit = maxTokenBeforeMetadataCleanup
  let useMetadata = false
  loggerWithChild({ email: email }).info(`User Asked: ${decodedQuery}`)
  // if we don't use this, 3.4 seems like a good approx value
  if (
    llama3Tokenizer.encode(initialContext).length > tokenLimit ||
    encode(initialContext).length > tokenLimit
  ) {
    useMetadata = true
  }

  let users: VespaSearchResult[] = []
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
    ).root.children
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
    ).root.children
  }

  let existingUserIds = new Set<string>()
  if (users.length) {
    existingUserIds = new Set(
      results.root.children
        .filter((v) => (v.fields as VespaUser).sddocname === userSchema)
        .map((v: any) => v.fields.docId),
    )
  }

  const newUsers = users.filter(
    (user: any) => !existingUserIds.has(user.fields.docId),
  )
  if (newUsers.length) {
    newUsers.forEach((user) => {
      results.root.children.push(user)
    })
  }
  const metadataContext = results.root.children
    .map((v, i) =>
      cleanContext(
        `Index ${i} \n ${answerMetadataContextMap(v as VespaSearchResults, dateForAI)}`,
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
      .map((v) => answerContextMap(v as VespaSearchResults))
      .join("\n"),
  )

  return streamSSE(c, async (stream) => {
    loggerWithChild({ email: email }).info("SSE stream started")
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

      loggerWithChild({ email: email }).info(
        `costArr: ${costArr} \n Total Cost: ${costArr.reduce(
          (prev, curr) => prev + curr,
          0,
        )}`,
      )
    }
    await stream.writeSSE({
      data: "Answer complete",
      event: AnswerSSEvents.End,
    })

    loggerWithChild({ email: email }).info("SSE stream ended")
    stream.onAbort(() => {
      loggerWithChild({ email: email }).error("SSE stream aborted")
    })
  })
}


export const GetDriveItem = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  const email = sub
  const body = await c.req.json()
  const { parentId } = body
  try {
    const docIds = []
    if (parentId) {
      docIds.push(parentId)
    }
    const resp = await getFolderItems(
      docIds,
      fileSchema,
      DriveEntity.Folder,
      email,
    )
    return c.json(resp)
  } catch (error) {
    loggerWithChild({ email: email }).error(
      `Error fetcing Drive item for parentId:${parentId}`,
    )
    throw new HTTPException(500, {
      message: "Error processing agent search results for Google Drive",
    })
  }
}

export const GetDriveItemsByDocIds = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  const email = sub
  const body = await c.req.json()
  const { docIds } = body

  if (!docIds || !Array.isArray(docIds) || docIds.length === 0) {
    return c.json({ root: { children: [] } })
  }

  try {
    const tracer = getTracer("search")
    const span = tracer.startSpan("GetDriveItemsByDocIds")

    const resp = await GetDocumentsByDocIds(docIds, span)

    span.end()
    return c.json(resp)
  } catch (error) {
    loggerWithChild({ email: email }).error(
      `Error fetching Drive items for docIds:${docIds.join(",")}`,
    )
    throw new HTTPException(500, {
      message: "Error fetching Google Drive items by docIds",
    })
  }
}

// Fuzzy matching implementation using k-errors Bitap algorithm with BigInt
class FuzzyMatcher {
  private maxPatternLength: number;
  private errorTolerance: number;

  constructor(maxPatternLength: number = 128, errorTolerance: number = 5) {
    this.maxPatternLength = maxPatternLength;
    this.errorTolerance = errorTolerance;
  }

  // Create alphabet for Bitap algorithm using BigInt
  private createAlphabet(pattern: string): Map<string, bigint> {
    const alphabet = new Map<string, bigint>();
    const patternLength = Math.min(pattern.length, this.maxPatternLength);
    
    for (let i = 0; i < patternLength; i++) {
      const char = pattern[i];
      if (!alphabet.has(char)) {
        alphabet.set(char, 0n);
      }
      // Set bit j for pattern position j (LSB = position 0, MSB = last char)
      alphabet.set(char, alphabet.get(char)! | (1n << BigInt(i)));
    }
    
    return alphabet;
  }

  // k-errors Bitap algorithm using BigInt for proper bit manipulation
  private matchBitapKErrors(text: string, pattern: string): Array<{index: number, editDistance: number}> {
    const patternLength = Math.min(pattern.length, this.maxPatternLength);
    
    if (patternLength === 0) return [];
    
    // Create alphabet for Bitap - each character maps to a BigInt bitmask
    const alphabet = this.createAlphabet(pattern);
    const matchMask = 1n << BigInt(patternLength - 1); // marks alignment where full pattern matched
    
    // Initialize state vectors R[0..k] as BigInt
    const R: bigint[] = new Array(this.errorTolerance + 1);
    for (let d = 0; d <= this.errorTolerance; d++) {
      R[d] = ~0n; // all 1s in two's complement
    }
    
    const matches: Array<{index: number, editDistance: number}> = [];
    
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const charMask = alphabet.get(char) || 0n;
      
      // Update R[0] for exact matches
      let oldRd1 = R[0];
      R[0] = ((R[0] << 1n) | 1n) & charMask;
      
      // Update R[d] for each error level d = 1..k
      for (let d = 1; d <= this.errorTolerance; d++) {
        const temp = R[d];
        R[d] = (((R[d] << 1n) | 1n) & charMask) | // match or substitution
               (oldRd1 << 1n) |                    // insertion
               oldRd1;                             // deletion
        oldRd1 = temp;
      }
      
      // Check for matches at position i
      for (let d = 0; d <= this.errorTolerance; d++) {
        if ((R[d] & matchMask) !== 0n) {
          const startIndex = i - patternLength + 1;
          matches.push({
            index: startIndex,
            editDistance: d
          });
          break; // Find the smallest d (best match) for this position
        }
      }
    }
    
    return matches;
  }


  // Find all fuzzy matches in text using k-errors Bitap algorithm
  public findAllMatches(text: string, pattern: string): Array<{index: number, similarity: number, length: number}> {
    const matches: Array<{index: number, similarity: number, length: number}> = [];
    
    if (pattern.length > this.maxPatternLength) {
      pattern = pattern.slice(0, this.maxPatternLength);
    }
    
    const patternLength = pattern.length;
    
    // Use k-errors Bitap algorithm to find all matches
    const bitapMatches = this.matchBitapKErrors(text, pattern);

    // Convert to our format with stable similarity calculation
    for (const match of bitapMatches) {
      if (match.index >= 0) {
        const matchedText = text.slice(match.index, match.index + patternLength);
        // Use edit distance for stable similarity: similarity = 1 - (d / m)
        const similarity = Math.max(0, 1 - (match.editDistance / patternLength));
        
        matches.push({
          index: match.index,
          similarity,
          length: patternLength
        });
      }
    }
    
    return matches;
  }
}

export const HighlightApi = async (c: Context) => {
  try {
    const { chunkText, documentContent, options = {} } = await c.req.json();
    
    if (!chunkText || !documentContent) {
      throw new HTTPException(400, {
        message: "Missing required fields: chunkText and documentContent"
      });
    }

    const {
      caseSensitive,
      fuzzyMatching = true,
      errorTolerance = 2,
      maxPatternLength = 32
    } = options;

    // Normalize text for matching
    const normalizeText = (text: string) => {
      return text
        .replace(/[-*•]\s+/g, "")      // strip list bullets
        .replace(/^#+\s+/gm, "")       // strip markdown headers
        .replace(/^\s+/gm, "")         // strip leading whitespace/indentation from each line
        .replace(/\s+/g, " ")          // collapse all whitespace to single spaces
        .replace(/\t/g, " ")           // convert tabs to spaces
        .replace(/\n\s*\n/g, "\n")     // remove empty lines with whitespace
        .trim();
    };

    // Text normalization function with index mapping
    const normalizeTextWithMap = (s: string) => {
      const map: number[] = [];
      const out: string[] = [];
      let i = 0;
      
      while (i < s.length) {
        const ch = s[i];
        
        // Handle whitespace sequences
        if (/\s/.test(ch)) {
          let j = i + 1;
          while (j < s.length && /\s/.test(s[j])) j++;
          
          // Only add a single space if we have content before it
          if (out.length > 0) { 
            out.push(" "); 
            map.push(i); 
          }
          i = j;
        } 
        // Handle list bullets and markdown headers
        else if (ch === '-' || ch === '*' || ch === '•') {
          // Check if this is a list bullet followed by whitespace
          let j = i + 1;
          while (j < s.length && /\s/.test(s[j])) j++;
          if (j > i + 1) {
            // Skip the bullet and whitespace
            i = j;
            continue;
          }
          // Not a list bullet, treat as normal character
          out.push(ch);
          map.push(i);
          i++;
        }
        // Handle markdown headers (#)
        else if (ch === '#') {
          let j = i + 1;
          while (j < s.length && s[j] === '#') j++;
          // Check if this is at start of line and followed by whitespace
          if (i === 0 || s[i-1] === '\n') {
            while (j < s.length && /\s/.test(s[j])) j++;
            // Skip the header markers and whitespace
            i = j;
            continue;
          }
          // Not a header, treat as normal character
          out.push(ch);
          map.push(i);
          i++;
        }
        // Handle tabs
        else if (ch === '\t') {
          out.push(' ');
          map.push(i);
          i++;
        }
        // Handle empty lines with whitespace
        else if (ch === '\n') {
          let j = i + 1;
          while (j < s.length && /\s/.test(s[j])) j++;
          if (j < s.length && s[j] === '\n') {
            // This is an empty line with whitespace, skip it
            i = j;
            continue;
          }
          // Normal newline
          out.push(ch);
          map.push(i);
          i++;
        }
        // Normal character
        else {
          out.push(ch);
          map.push(i);
          i++;
        }
      }
      
      // Remove leading and trailing spaces
      if (out.length && out[0] === " ") { 
        out.shift(); 
        map.shift(); 
      }
      if (out.length && out[out.length - 1] === " ") { 
        out.pop(); 
        map.pop(); 
      }
      
      return { norm: out.join(""), map };
    };

    // Initialize fuzzy matcher
    const fuzzyMatcher = new FuzzyMatcher(maxPatternLength, errorTolerance);
    
    const findAllMatches = (haystack: string, needle: string, indexMap: number[]) => {
      // === Case handling ===
      const rawHayFull = caseSensitive ? haystack : haystack.toLowerCase();
      const rawNeedleFull = caseSensitive ? needle : needle.toLowerCase();

      // Quick length guard
      if (rawNeedleFull.length < 3 || rawNeedleFull.length > rawHayFull.length) return [];

      if (fuzzyMatching) {
        
        // Use fuzzy matching with Bitap algorithm on normalized text
        const matches = fuzzyMatcher.findAllMatches(rawHayFull, rawNeedleFull);
        
        // Filter matches by minimum similarity threshold and map back to original indices
        const minSimilarity = 0.85;
        const allMatches = matches
          .filter(match => {
            const passes = match.similarity >= minSimilarity;
            return passes;
          })
          .map(match => {
            const originalIndex = indexMap[match.index];
            return {
              index: originalIndex, // Map back to original text indices
              similarity: match.similarity,
              length: match.length
            };
          });
        
        // Check if we have any matches
        if (allMatches.length === 0) {
          return [];
        }
        
        // Find the best similarity score
        const bestSimilarity = Math.max(...allMatches.map(match => match.similarity));
        
        // Return only matches with the best similarity score
        const bestMatches = allMatches.filter(match => match.similarity === bestSimilarity);
        
        return bestMatches;
      } else {
        // Fallback to exact matching with KMP for comparison
        const buildLPS = (p: string): number[] => {
          const lps = new Array(p.length).fill(0);
          let len = 0;
          for (let i = 1; i < p.length; ) {
            if (p[i] === p[len]) { lps[i++] = ++len; }
            else if (len !== 0) { len = lps[len - 1]; }
            else { lps[i++] = 0; }
          }
          return lps;
        };
        
        const kmpSearch = (text: string, pattern: string): number[] => {
          const res: number[] = [];
          if (!pattern.length || pattern.length > text.length) return res;
          const lps = buildLPS(pattern);
          let i = 0, j = 0;
          while (i < text.length) {
            if (text[i] === pattern[j]) {
              i++; j++;
              if (j === pattern.length) { res.push(i - j); j = lps[j - 1]; }
            } else if (j !== 0) j = lps[j - 1];
            else i++;
          }
          return res;
        };


        if (rawNeedleFull.length > rawHayFull.length) return [];

        const idxs = kmpSearch(rawHayFull, rawNeedleFull);
        return idxs.map((idx) => ({ index: indexMap[idx], similarity: 1, length: rawNeedleFull.length }));
      }
    };

    // Best span algorithm implementation
    const findBestSpan = (indexLists: number[][]) => {
      if (indexLists.length === 0 || indexLists.some(a => a.length === 0)) return null;

      const merged: Array<{ pos: number, sentenceId: number }> = [];
      for (let sentenceId = 0; sentenceId < indexLists.length; sentenceId++) {
        for (const pos of indexLists[sentenceId]) merged.push({ pos, sentenceId });
      }
      merged.sort((a, b) => a.pos - b.pos);

      const need = indexLists.length;
      let have = 0;
      const cnt = new Map<number, number>();

      let bestL: number | null = null;
      let bestR: number | null = null;
      let l = 0;

      for (let r = 0; r < merged.length; r++) {
        const { pos: posR, sentenceId: sidR } = merged[r];
        cnt.set(sidR, (cnt.get(sidR) || 0) + 1);
        if (cnt.get(sidR) === 1) have++;

        while (have === need) {
          const { pos: posL, sentenceId: sidL } = merged[l];

          // Prefer strictly smaller span; keep the first minimal span for equal spans
          if (
            bestL === null ||
            (posR - posL) < (bestR! - bestL)
          ) {
            bestL = posL;
            bestR = posR;
          }

          cnt.set(sidL, (cnt.get(sidL) || 0) - 1);
          if (cnt.get(sidL) === 0) have--;
          l++;
        }
      }

      if (bestL === null || bestR === null) return null;
      return { bestL, bestR };
    };

    // Function to merge close matches
    const mergeCloseMatches = (matches: Array<{
      startIndex: number;
      endIndex: number;
      similarity: number;
      length: number;
    }>) => {
      if (matches.length === 0) return matches;
      
      // Sort matches by start index
      const sortedMatches = [...matches].sort((a, b) => a.startIndex - b.startIndex);
      const merged: Array<{
        startIndex: number;
        endIndex: number;
        similarity: number;
        length: number;
      }> = [];
      
      let currentMatch = { ...sortedMatches[0] };
      
      for (let i = 1; i < sortedMatches.length; i++) {
        const nextMatch = sortedMatches[i];
        const gap = nextMatch.startIndex - currentMatch.endIndex;
        
        // Merge if matches are close (within 10 characters or overlapping)
        if (gap <= 256) {
          // Extend the current match to include the next one
          currentMatch.endIndex = Math.max(currentMatch.endIndex, nextMatch.endIndex);
          // Use the higher similarity
          currentMatch.similarity = Math.max(currentMatch.similarity, nextMatch.similarity);
          currentMatch.length = Math.max(currentMatch.length, nextMatch.length);
        } else {
          // Add current match and start a new one
          merged.push({ ...currentMatch });
          currentMatch = { ...nextMatch };
        }
      }
      
      // Add the last match
      merged.push(currentMatch);
      
      return merged;
    };
    
    const lines = chunkText.split('\n');
    const allMatchesPerLine: Array<{
      matches: Array<{ index: number, similarity: number, length: number }>;
      originalLine: string;
    }> = [];
    
    // Performance guard: limit number of lines processed
    const MAX_LINES_PROCESSED = 1000;
    const linesToProcess = lines.slice(0, MAX_LINES_PROCESSED);
    
    if (lines.length > MAX_LINES_PROCESSED) {
      console.warn(`Too many lines (${lines.length}), processing only first ${MAX_LINES_PROCESSED}`);
    }
    
    for (const line of linesToProcess) {
      if (line) {
        const { norm: normalizedContent, map: indexMap } = normalizeTextWithMap(documentContent);
        const normalizedLine = normalizeText(line);
        const matches = findAllMatches(normalizedContent, normalizedLine, indexMap);
        
        if (matches.length > 0) {
          allMatchesPerLine.push({
            matches,
            originalLine: line.trim(),
          });
        }
      }
    }

    if (allMatchesPerLine.length > 0) {
      // Extract all match indices for each line
      const indexLists: number[][] = allMatchesPerLine.map(lineData => 
        lineData.matches.map(match => match.index)
      );

      // Find the best span
      const bestSpan = findBestSpan(indexLists);
      
      if (bestSpan) {
        // Apply best span algorithm to find optimal clusters
        const finalMatches: Array<{
          startIndex: number;
          endIndex: number;
          similarity: number;
        }> = [];

        // Create matches for the best span by choosing, for each line, the match
        // inside [bestL, bestR] with the highest similarity.
        const windowMid = (bestSpan.bestL + bestSpan.bestR) / 2;

        for (let i = 0; i < allMatchesPerLine.length; i++) {
          const lineData = allMatchesPerLine[i];

          // Consider only matches that fall within the best span
          const candidates = lineData.matches.filter(m => m.index >= bestSpan.bestL && (m.index + m.length) <= bestSpan.bestR);

          if (candidates.length === 0) {
            // Fallback: choose the candidate whose start is inside the span (end may overflow)
            const loose = lineData.matches.filter(m => m.index >= bestSpan.bestL && m.index <= bestSpan.bestR);
            if (loose.length === 0) continue;
            loose.sort((a, b) => {
              if (b.similarity !== a.similarity) return b.similarity - a.similarity;
              return Math.abs(a.index - windowMid) - Math.abs(b.index - windowMid);
            });
            const selectedMatch = loose[0];
            finalMatches.push({
              startIndex: selectedMatch.index,
              endIndex: selectedMatch.index + selectedMatch.length,
              similarity: selectedMatch.similarity,
            });
            continue;
          }

          // Prefer higher similarity; tie-break by closeness to the window center
          candidates.sort((a, b) => {
            if (b.similarity !== a.similarity) return b.similarity - a.similarity;
            return Math.abs(a.index - windowMid) - Math.abs(b.index - windowMid);
          });

          const selectedMatch = candidates[0];
          finalMatches.push({
            startIndex: selectedMatch.index,
            endIndex: selectedMatch.index + selectedMatch.length,
            similarity: selectedMatch.similarity,
          });
        }

        if (finalMatches.length > 0) {
          // Merge close matches
          const mergedMatches = mergeCloseMatches(finalMatches.map(match => ({ ...match, length: match.endIndex - match.startIndex })));
          
          return c.json({
            success: true,
            matches: mergedMatches
          });
        }
      }
    }

    return c.json({ 
      success: false, 
      message: "No suitable matches found for any lines",
    });

  } catch (error) {
    console.error("Error in highlight endpoint:", error);
    return c.json({ 
      error: "Internal server error during highlighting",
      details: error instanceof Error ? error.message : "Unknown error"
    }, 500);
  }
};
