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
import {
  AnswerSSEvents,
  attachmentMetadataSchema,
  AuthType,
  ConnectorStatus,
} from "@/shared/types"
import { agentPromptPayloadSchema } from "@/shared/types"
import { streamSSE } from "hono/streaming"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem, type UserMetadataType } from "@/types"
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

export const chatStopSchema = z.object({
  chatId: z.string().min(1),
})

export const chatClarificationSchema = z.object({
  chatId: z.string().min(1),
  clarificationId: z.string().min(1),
  selectedOption: z.object({
    selectedOptionId: z.string().min(1),
    selectedOption: z.string().min(1),
    customInput: z.string().optional(),
  }),
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
  ownerEmail: z.string().optional(),
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
  ownerEmail: z.string().optional(),
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
  isFollowUp: z
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

export const handleAttachmentDeleteSchema = z.object({
  attachment: attachmentMetadataSchema,
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
      const [driveConnector, gmailConnector, calendarConnector] =
        await Promise.all([
          getAppSyncJobsByEmail(
            db,
            Apps.GoogleDrive,
            config.CurrentAuthType,
            email,
          ),
          getAppSyncJobsByEmail(db, Apps.Gmail, config.CurrentAuthType, email),
          getAppSyncJobsByEmail(
            db,
            Apps.GoogleCalendar,
            config.CurrentAuthType,
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
  const userTimezone = userAndWorkspace.user?.timeZone || "Asia/Kolkata"
  const dateForAI = getDateForAI({ userTimeZone: userTimezone })
  const userMetadata: UserMetadataType = { userTimezone, dateForAI }
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
    (
      await Promise.all(
        results.root.children.map(
          async (v) =>
            await answerContextMap(v as VespaSearchResults, userMetadata),
        ),
      )
    ).join("\n"),
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
        `Index ${i} \n ${answerMetadataContextMap(v as VespaSearchResults, userMetadata.dateForAI, userMetadata.userTimezone)}`,
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
    (
      await Promise.all(
        results.root.children
          .filter((v, i) => output?.contextualChunks.includes(i))
          .map(
            async (v) =>
              await answerContextMap(v as VespaSearchResults, userMetadata),
          ),
      )
    ).join("\n"),
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
