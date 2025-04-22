import {
  Apps,
  CalendarEntity,
  DriveEntity,
  eventSchema,
  MailEntity,
  fileSchema,
  mailSchema,
  userQuerySchema,
  userSchema,
  mailAttachmentSchema,
  chatUserSchema,
  chatMessageSchema,
  codeRustSchema,
  codeApiDocsSchema,
  CodeEntity,
} from "@/search/types"
import type {
  VespaAutocompleteResponse,
  VespaFile,
  VespaMail,
  VespaSearchResult,
  VespaSearchResponse,
  VespaUser,
  VespaGetResult,
  Entity,
  VespaEvent,
  VespaUserQueryHistory,
  VespaSchema,
  VespaMailAttachment,
  VespaChatContainer,
  Inserts,
  VespaSearchResults,
  AppEntityCounts, // Import AppEntityCounts
  LanguageCounts,
  VespaCodeApiDocs, // Import LanguageCounts
} from "@/search/types"
import { getErrorMessage } from "@/utils"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import {
  ErrorDeletingDocuments,
  ErrorGettingDocument,
  ErrorUpdatingDocument,
  ErrorRetrievingDocuments,
  ErrorPerformingSearch,
  ErrorInsertingDocument,
} from "@/errors"
import { getTracer, type Span, type Tracer } from "@/tracer"
import crypto from "crypto"
import VespaClient from "@/search/vespaClient"

const vespa = new VespaClient()
const { isCodeSearchOnly } = config // Import the config flag

// Define your Vespa endpoint and schema name
const vespaEndpoint = `http://${config.vespaBaseHost}:8080`
export const NAMESPACE = "namespace" // Replace with your actual namespace
const CLUSTER = "my_content"

const Logger = getLogger(Subsystem.Vespa).child({ module: "vespa" })

const MAX_INSERT_RETRIES = 3 // Maximum number of retries for insertion
const INITIAL_INSERT_DELAY_MS = 200 // Initial delay in milliseconds

// Helper function for delays
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Deletes all documents from the specified schema and namespace in Vespa.
 */
async function deleteAllDocuments() {
  try {
    await vespa.deleteAllDocuments({
      cluster: CLUSTER,
      namespace: NAMESPACE,
      schema: fileSchema,
    })
  } catch (error) {
    throw new ErrorDeletingDocuments({
      cause: error as Error,
      sources: AllSources,
    })
  }
}

export const insertDocument = async (document: VespaFile) => {
  try {
    await vespa.insertDocument(document, {
      namespace: NAMESPACE,
      schema: fileSchema,
    })
  } catch (error) {
    throw new ErrorInsertingDocument({
      docId: document.docId,
      cause: error as Error,
      sources: fileSchema,
    })
  }
}

// generic insert method with retry logic for ECONNRESET
export const insert = async (document: Inserts, schema: VespaSchema) => {
  let retries = 0
  let currentDelay = INITIAL_INSERT_DELAY_MS

  while (retries < MAX_INSERT_RETRIES) {
    try {
      await vespa.insert(document, { namespace: NAMESPACE, schema })
      // If successful, exit the loop
      if (retries > 0) {
        Logger.info(
          `Successfully inserted document ${document.docId} after ${retries} retries.`,
        )
      }
      return
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error))
      // Check if the error is ECONNRESET and if we have retries left
      // @ts-ignore - Check if code property exists on the cause
      if (cause?.code === "ECONNRESET" && retries < MAX_INSERT_RETRIES - 1) {
        retries++
        Logger.warn(
          `ECONNRESET detected during insert for docId ${document.docId}. Retrying (${retries}/${MAX_INSERT_RETRIES - 1})... Waiting ${currentDelay}ms.`,
        )
        await delay(currentDelay)
        // Exponential backoff
        currentDelay *= 2
      } else {
        // If it's not ECONNRESET or retries are exhausted, log and throw the error
        const finalErrorMessage = `Failed to insert document ${document.docId} after ${retries} retries. Last error: ${getErrorMessage(cause)}`
        Logger.error({
          msg: finalErrorMessage,
          error: cause,
          docId: document.docId,
          schema: schema,
        })
        throw new ErrorInsertingDocument({
          docId: document.docId,
          cause: cause,
          sources: schema,
          message: finalErrorMessage, // Add more context to the error
        })
      }
    }
  }
}

export const insertUser = async (user: VespaUser) => {
  try {
    await vespa.insertUser(user, { namespace: NAMESPACE, schema: userSchema })
  } catch (error) {
    throw new ErrorInsertingDocument({
      docId: user.docId,
      cause: error as Error,
      sources: userSchema,
    })
  }
}

export const deduplicateAutocomplete = (
  resp: VespaAutocompleteResponse,
): VespaAutocompleteResponse => {
  const { root } = resp
  if (!root.children) {
    return resp
  }
  const uniqueResults = []
  const emails = new Set()
  for (const child of root.children) {
    // @ts-ignore
    const email = child.fields.email
    if (email && !emails.has(email)) {
      emails.add(email)
      uniqueResults.push(child)
    } else if (!email) {
      uniqueResults.push(child)
    }
  }
  resp.root.children = uniqueResults
  return resp
}

const AllSources = [
  fileSchema,
  userSchema,
  mailSchema,
  eventSchema,
  mailAttachmentSchema,
  chatUserSchema,
  chatMessageSchema,
].join(", ")

const CodeSources = [codeApiDocsSchema, codeRustSchema].join(", ")

export const autocomplete = async (
  query: string,
  email: string,
  limit: number = 5,
): Promise<VespaAutocompleteResponse> => {
  const sources = AllSources.split(", ")
    .filter((s) => s !== chatMessageSchema)
    .join(", ")
  // Construct the YQL query for fuzzy prefix matching with maxEditDistance:2
  // the drawback here is that for user field we will get duplicates, for the same
  // email one contact and one from user directory
  const yqlQuery = `select * from sources ${sources}, ${userQuerySchema}
    where
        (title_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
        and permissions contains @email)
        or
        (
            (name_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
            and owner contains @email)
            or
            (email_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
            and owner contains @email)
        )
        or
        (
            (name_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
            and app contains "${Apps.GoogleWorkspace}")
            or
            (email_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
            and app contains "${Apps.GoogleWorkspace}")
        )
        or
        (subject_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
        and permissions contains @email)
        or
        (name_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
        and permissions contains @email)
        or
        (query_text contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
        and owner contains @email)
        or
        (
          (
            name_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query)) or
            email_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
          )
          and permissions contains @email
        )
        `

  const searchPayload = {
    yql: yqlQuery,
    query,
    email,
    hits: limit,
    "ranking.profile": "autocomplete",
    "presentation.summary": "autocomplete",
  }
  try {
    return await vespa.autoComplete(searchPayload)
  } catch (error) {
    throw new ErrorPerformingSearch({
      message: `Error performing autocomplete search`,
      cause: error as Error,
      sources: "file",
    })
    // TODO: instead of null just send empty response
    throw error
  }
}

/**
 * Interface for structured API route result
 */
export interface ApiRouteResult {
  path: string
  method: string
  operationId?: string
  summary?: string
  description?: string
  handler?: string
  parameters?: any[]
  requestBody?: any
  responses?: Record<string, any>
  handlerSourceFile?: string
  handlerSourceLine?: number
  score: number
}

/**
 * Search for API routes matching the query
 * @param query User query about API routes
 * @param limit Maximum number of results to return
 * @returns Top matching API routes with scores
 */
export async function searchApiDocs(
  query: string,
  email: string,
  limit: number = 4,
): Promise<ApiRouteResult[]> {
  try {
    Logger.info({ query, limit }, "Searching API docs")

    // Use the searchVespa function targeting only codeApiDocs schema
    const results = await searchVespa(
      query,
      email,
      Apps.Code,
      CodeEntity.ApiDocs,
      {
        limit,
        targetSchemas: [codeApiDocsSchema],
        alpha: 0.5, // Adjust relevance scoring weights
        codeOnlySearch: true,
      },
    )

    if (!results?.root?.children || results.root.children.length === 0) {
      Logger.info("No API docs found matching query")
      return []
    }

    // Transform Vespa results into structured API route data
    return results.root.children.map((result) => {
      const fields = result.fields as VespaCodeApiDocs

      return {
        path: fields.path || "",
        method: fields.method || "",
        operationId: fields.openapi_operationId,
        summary: fields.openapi_summary,
        description: fields.openapi_description,
        handler: fields.handler,
        parameters: fields.openapi_parameters_json
          ? JSON.parse(fields.openapi_parameters_json)
          : [],
        requestBody: fields.openapi_requestBody_json
          ? JSON.parse(fields.openapi_requestBody_json)
          : undefined,
        responses: fields.openapi_responses_json
          ? JSON.parse(fields.openapi_responses_json)
          : {},
        handlerSourceFile: fields.handler_source_file,
        handlerSourceLine: fields.handler_source_line,
        score: result.relevance || 0,
      }
    })
  } catch (error) {
    Logger.error({ error }, "Error searching API docs")
    return []
  }
}

export enum SearchModes {
  NativeRank = "default_native",
  BM25 = "default_bm25",
  AI = "default_ai",
}

type YqlProfile = {
  profile: SearchModes
  yql: string
}

// TODO: it seems the owner part is complicating things
export const HybridDefaultProfile = (
  hits: number,
  app: Apps | null,
  entity: Entity | null,
  profile: SearchModes = SearchModes.NativeRank,
  timestampRange?: { to: number | null; from: number | null } | null,
  excludedIds?: string[],
  notInMailLabels?: string[],
): YqlProfile => {
  let hasAppOrEntity = !!(app || entity)
  let fileTimestamp = ""
  let mailTimestamp = ""
  let userTimestamp = ""
  let eventTimestamp = ""

  if (timestampRange && !timestampRange.from && !timestampRange.to) {
    throw new Error("Invalid timestamp range")
  }

  let fileTimestampConditions: string[] = []
  let mailTimestampConditions: string[] = []
  let userTimestampConditions: string[] = []
  let eventTimestampConditions: string[] = []

  if (timestampRange && timestampRange.from) {
    fileTimestampConditions.push(`updatedAt >= ${timestampRange.from}`)
    mailTimestampConditions.push(`timestamp >= ${timestampRange.from}`)
    userTimestampConditions.push(`creationTime >= ${timestampRange.from}`)
    eventTimestampConditions.push(`startTime >= ${timestampRange.from}`) // Using startTime for events
  }
  if (timestampRange && timestampRange.to) {
    fileTimestampConditions.push(`updatedAt <= ${timestampRange.to}`)
    mailTimestampConditions.push(`timestamp <= ${timestampRange.to}`)
    userTimestampConditions.push(`creationTime <= ${timestampRange.to}`)
    eventTimestampConditions.push(`startTime <= ${timestampRange.to}`)
  }

  if (timestampRange && timestampRange.from && timestampRange.to) {
    fileTimestamp = fileTimestampConditions.join(" and ")
    mailTimestamp = mailTimestampConditions.join(" and ")
    userTimestamp = userTimestampConditions.join(" and ")
    eventTimestamp = eventTimestampConditions.join(" and ")
  } else {
    fileTimestamp = fileTimestampConditions.join("")
    mailTimestamp = mailTimestampConditions.join("")
    userTimestamp = userTimestampConditions.join("")
    eventTimestamp = eventTimestampConditions.join("")
  }

  let appOrEntityFilter =
    `${app ? "and app contains @app" : ""} ${entity ? "and entity contains @entity" : ""}`.trim()

  let exclusionCondition = ""
  if (excludedIds && excludedIds.length > 0) {
    exclusionCondition = excludedIds
      .map((id) => `docId contains '${id}'`)
      .join(" or ")
  }

  let mailLabelQuery = ""
  if (notInMailLabels && notInMailLabels.length > 0) {
    mailLabelQuery = `and !(${notInMailLabels.map((label) => `labels contains '${label}'`).join(" or ")})`
  }

  // the last 2 'or' conditions are due to the 2 types of users, contacts and admin directory present in the same schema
  return {
    profile: profile,
    yql: `
        select * from sources ${AllSources}
        where ((
          (
            (
              ({targetHits:${hits}}userInput(@query))
              or
              ({targetHits:${hits}}nearestNeighbor(chunk_embeddings, e))
            )
            ${timestampRange ? `and (${fileTimestamp} or ${mailTimestamp} or ${eventTimestamp})` : ""}
            and permissions contains @email ${mailLabelQuery}
            ${appOrEntityFilter}
          )
            or
            (
              (
              ({targetHits:${hits}}userInput(@query))
              or
              ({targetHits:${hits}}nearestNeighbor(text_embeddings, e))
            )
              ${appOrEntityFilter}
              and permissions contains @email
            )
          or
          (
            ({targetHits:${hits}}userInput(@query))
            ${timestampRange ? `and ${userTimestamp}` : ""}
            ${!hasAppOrEntity ? `and app contains "${Apps.GoogleWorkspace}"` : `${appOrEntityFilter} and permissions contains @email`}
          )
          or
          (
            ({targetHits:${hits}}userInput(@query))
            and owner contains @email
            ${timestampRange ? `and ${userTimestamp}` : ""}
            ${appOrEntityFilter}
          )
        )
        ${exclusionCondition ? `and !(${exclusionCondition})` : ""})`,
  }
}

const HybridDefaultProfileAppEntityCounts = (
  hits: number,
  timestampRange: { to: number; from: number } | null,
  notInMailLabels?: string[],
): YqlProfile => {
  let fileTimestamp = ""
  let mailTimestamp = ""
  let userTimestamp = ""

  if (timestampRange && !timestampRange.from && !timestampRange.to) {
    throw new Error("Invalid timestamp range")
  }

  let fileTimestampConditions: string[] = []
  let mailTimestampConditions: string[] = []
  let userTimestampConditions: string[] = []

  if (timestampRange && timestampRange.from) {
    fileTimestampConditions.push(`updatedAt >= ${timestampRange.from}`)
    mailTimestampConditions.push(`timestamp >= ${timestampRange.from}`)
    userTimestampConditions.push(`creationTime >= ${timestampRange.from}`)
  }
  if (timestampRange && timestampRange.to) {
    fileTimestampConditions.push(`updatedAt <= ${timestampRange.to}`)
    mailTimestampConditions.push(`timestamp <= ${timestampRange.to}`)
    userTimestampConditions.push(`creationTime <= ${timestampRange.to}`)
  }

  if (timestampRange && timestampRange.from && timestampRange.to) {
    fileTimestamp = fileTimestampConditions.join(" and ")
    mailTimestamp = mailTimestampConditions.join(" and ")
    userTimestamp = userTimestampConditions.join(" and ")
  } else {
    fileTimestamp = fileTimestampConditions.join("")
    mailTimestamp = mailTimestampConditions.join("")
    userTimestamp = userTimestampConditions.join("")
  }

  let mailLabelQuery = ""
  if (notInMailLabels && notInMailLabels.length > 0) {
    mailLabelQuery = `and !(${notInMailLabels.map((label) => `labels contains '${label}'`).join(" or ")})`
  }

  return {
    profile: SearchModes.NativeRank,
    yql: `select * from sources ${AllSources}
            where ((({targetHits:${hits}}userInput(@query))
            or ({targetHits:${hits}}nearestNeighbor(chunk_embeddings, e))) ${timestampRange ? ` and (${fileTimestamp} or ${mailTimestamp}) ` : ""} and permissions contains @email ${mailLabelQuery})
            or (
              (
                ({targetHits:${hits}}userInput(@query))
              or
                ({targetHits:${hits}}nearestNeighbor(text_embeddings, e))
              )
              and permissions contains @email
            )
            or (({targetHits:${hits}}userInput(@query)) ${timestampRange ? `and ${userTimestamp} ` : ""} and app contains "${Apps.GoogleWorkspace}")
            or
            (({targetHits:${hits}}userInput(@query)) and owner contains @email ${timestampRange ? `and ${userTimestamp} ` : ""})
            limit 0
            | all(
                group(app) each(
                group(entity) each(output(count()))
                )
            )`,
  }
}

// Profile for grouping code results by language
const HybridCodeLanguageGroupProfile = (
  hits: number,
  timestampRange: { to: number | null; from: number | null } | null,
): YqlProfile => {
  let timestampCondition = ""
  if (timestampRange) {
    let conditions: string[] = []
    // Assuming code schemas might have an 'updatedAt' or similar field.
    // Adjust if the actual field name is different.
    if (timestampRange.from) {
      conditions.push(`updatedAt >= ${timestampRange.from}`)
    }
    if (timestampRange.to) {
      conditions.push(`updatedAt <= ${timestampRange.to}`)
    }
    if (conditions.length > 0) {
      timestampCondition = `and (${conditions.join(" and ")})`
    }
  }

  // Target only the codeRustSchema for language grouping
  return {
    profile: SearchModes.NativeRank, // Or another appropriate profile
    yql: `select * from sources ${CodeSources}
            where (
              (userInput(@query))
              or
              ({targetHits:${hits}}nearestNeighbor(code_chunk_embeddings, q_embedding)) or
              ({targetHits:${hits}}nearestNeighbor(api_doc_embedding, q_embedding))
            )
            ${timestampCondition}
            limit 0
            | all(
                group(language) each(output(count()))
            )`,
  }
}

// TODO: extract out the fetch and make an api client
export const groupVespaSearch = async (
  query: string,
  email: string,
  limit = config.page,
  {
    alpha = 0.5,
    timestampRange = null,
    excludedIds = [],
    notInMailLabels = [],
    rankProfile = SearchModes.NativeRank,
    requestDebug = false, // Destructure requestDebug here
    codeOnlySearch, // Add codeOnlySearch to parameters
  }: Partial<VespaQueryConfig & { codeOnlySearch?: boolean }>, // Add to type
): Promise<AppEntityCounts> => {
  if (codeOnlySearch) {
    Logger.info("Performing code-only search.")
    // Reverted YQL: Removed explicit 'matchfeatures' from select
    const yql = `select * from sources
    ${CodeSources} where (userInput(@query) or
    ({targetHits:${limit}}nearestNeighbor(code_chunk_embeddings, q_embedding)) or
    ({targetHits:${limit}}nearestNeighbor(api_doc_embedding, q_embedding)))
      limit 0
      | all(
          group(app) each(
            group(entity) each(output(count()))
        )
      );`
    const minimalPayload = {
      yql,
      query,
      // Add required inputs for the hybrid rank profile, specifying the code-embedder
    }

    const hybridDefaultPayload = {
      yql,
      query,
      email,
      "input.query(alpha)": alpha,
      "ranking.profile": "default",
      "input.query(q_embedding)": "embed(code-embedder, @query)",
    }
    Logger.debug({ msg: "Code search payload", payload: minimalPayload }) // Log payload
    try {
      return await vespa.groupSearch(hybridDefaultPayload)
    } catch (error) {
      Logger.error({
        msg: "Error during code search execution",
        error: getErrorMessage(error),
        stack: (error as Error).stack,
      }) // Enhanced error logging
      throw new ErrorPerformingSearch({
        cause: error as Error,
        sources: CodeSources, // Specify the source
      })
    }
  }
  let { yql, profile } = HybridDefaultProfileAppEntityCounts(
    limit,
    timestampRange ?? null,
  )

  const hybridDefaultPayload = {
    yql,
    query,
    email,
    "ranking.profile": profile,
    // Specify hf-embedder for the general search input 'e'
    "input.query(e)": "embed(hf-embedder, @query)",
  }
  try {
    return await vespa.groupSearch(hybridDefaultPayload)
  } catch (error) {
    throw new ErrorPerformingSearch({
      cause: error as Error,
      sources: AllSources,
    })
  }
}

type VespaQueryConfig = {
  limit: number
  offset: number
  alpha: number
  timestampRange: { from: number; to: number } | null
  excludedIds: string[]
  notInMailLabels: string[]
  rankProfile: SearchModes
  requestDebug: boolean
  span: Span | null
  codeOnlySearch: boolean
  targetSchemas?: VespaSchema[]
}

type VespaGroupQueryConfig = {
  alpha: number
  timestampRange: { from: number; to: number } | null
  rankProfile: SearchModes
}

export const searchVespa = async (
  query: string,
  email: string,
  app: Apps | null,
  entity: Entity | null,
  {
    alpha = 0.5,
    limit = config.page,
    offset = 0,
    timestampRange = null,
    excludedIds = [],
    notInMailLabels = [],
    rankProfile = SearchModes.NativeRank,
    requestDebug = false, // Destructure requestDebug here
    codeOnlySearch, // Add codeOnlySearch to parameters
    span = null,
    targetSchemas = [],
  }: Partial<VespaQueryConfig>,
): Promise<VespaSearchResponse> => {
  const isDebugMode = config.isDebugMode || requestDebug || false

  console.log("code only search", codeOnlySearch)
  if (codeOnlySearch) {
    let schemas = targetSchemas.length ? targetSchemas.join(", ") : CodeSources
    console.log(schemas)
    Logger.info("Performing code-only search.")
    const yql = `select * from sources ${schemas} where (userInput(@query) or
    ({targetHits:${limit}}nearestNeighbor(code_chunk_embeddings, q_embedding)) or
    ({targetHits:${limit}}nearestNeighbor(api_doc_embedding, q_embedding)));`
    const minimalPayload = {
      yql,
      query,
      "input.query(q_embedding)": "embed(code-embedder, @query)",
      "input.query(alpha)": alpha, // Use the provided alpha value
      hits: limit,
      offset,
      "ranking.profile": "default",
      ...(isDebugMode ? { "ranking.listFeatures": true, tracelevel: 4 } : {}),
    }
    Logger.debug({ msg: "Code search payload", payload: minimalPayload }) // Log payload
    try {
      return await vespa.search<VespaSearchResponse>(minimalPayload)
    } catch (error) {
      Logger.error({
        msg: "Error during code search execution",
        error: getErrorMessage(error),
        stack: (error as Error).stack,
      }) // Enhanced error logging
      throw new ErrorPerformingSearch({
        cause: error as Error,
        sources: CodeSources, // Specify the source
      })
    }
  }
  let { yql, profile } = HybridDefaultProfile(
    limit,
    app,
    entity,
    rankProfile,
    timestampRange,
    excludedIds,
    notInMailLabels,
  )

  const hybridDefaultPayload = {
    yql,
    query,
    email,
    "ranking.profile": profile,
    // Specify hf-embedder for the general search input 'e'
    "input.query(e)": "embed(hf-embedder, @query)",
    "input.query(alpha)": alpha,
    hits: limit,
    ...(offset
      ? {
          offset,
        }
      : {}),
    ...(app ? { app } : {}),
    ...(entity ? { entity } : {}),
    ...(isDebugMode ? { "ranking.listFeatures": true, tracelevel: 4 } : {}),
  }
  span?.setAttribute("vespaPayload", JSON.stringify(hybridDefaultPayload))
  try {
    return await vespa.search<VespaSearchResponse>(hybridDefaultPayload)
  } catch (error) {
    throw new ErrorPerformingSearch({
      cause: error as Error,
      sources: AllSources,
    })
  }
}

/**
 * Retrieves the total count of documents in the specified schema, namespace, and cluster.
 */
const getDocumentCount = async () => {
  try {
    return await vespa.getDocumentCount(fileSchema, {
      namespace: NAMESPACE,
      cluster: CLUSTER,
    })
  } catch (error) {
    throw new ErrorRetrievingDocuments({
      cause: error as Error,
      sources: "file",
    })
  }
}

export const GetDocument = async (
  schema: VespaSchema,
  docId: string,
): Promise<VespaGetResult> => {
  try {
    const options = { namespace: NAMESPACE, docId, schema }
    return vespa.getDocument(options)
  } catch (error) {
    Logger.error(error, `Error fetching document docId: ${docId}`)
    const errMessage = getErrorMessage(error)
    throw new ErrorGettingDocument({
      docId,
      cause: error as Error,
      sources: schema,
      message: errMessage,
    })
  }
}

export const GetDocumentWithField = async (
  fieldName: string,
  schema: VespaSchema,
  limit: number = 100,
  offset: number = 0,
): Promise<VespaSearchResponse> => {
  try {
    const options = { namespace: NAMESPACE, schema }
    return await vespa.getDocumentsWithField(fieldName, options, limit, offset)
  } catch (error) {
    const errMessage = getErrorMessage(error)
    throw new Error(errMessage)
  }
}

export const UpdateDocumentPermissions = async (
  schema: VespaSchema,
  docId: string,
  updatedPermissions: string[],
) => {
  try {
    const options = { namespace: NAMESPACE, docId, schema }
    await vespa.updateDocumentPermissions(updatedPermissions, options)
  } catch (error) {
    throw new ErrorUpdatingDocument({
      docId,
      cause: error as Error,
      sources: schema,
    })
  }
}

export const UpdateEventCancelledInstances = async (
  schema: VespaSchema,
  docId: string,
  updatedCancelledInstances: string[],
) => {
  try {
    const options = { namespace: NAMESPACE, docId, schema }
    await vespa.updateCancelledEvents(updatedCancelledInstances, options)
  } catch (error) {
    throw new ErrorUpdatingDocument({
      docId,
      cause: error as Error,
      sources: schema,
    })
  }
}

export const UpdateDocument = async (
  schema: VespaSchema,
  docId: string,
  updatedFields: Record<string, any>,
) => {
  try {
    const options = { namespace: NAMESPACE, docId, schema }
    await vespa.updateDocument(updatedFields, options)
  } catch (error) {
    throw new ErrorUpdatingDocument({
      docId,
      cause: error as Error,
      sources: schema,
    })
  }
}

export const DeleteDocument = async (docId: string, schema: VespaSchema) => {
  try {
    const options = { namespace: NAMESPACE, docId, schema }
    await vespa.deleteDocument(options)
  } catch (error) {
    throw new ErrorDeletingDocuments({
      cause: error as Error,
      sources: schema,
    })
  }
}

// Define a type for Language Counts
interface LanguageCounts {
  [language: string]: number
}

// Define a type for Entity Counts (where the key is the entity name and the value is the count)
interface EntityCounts {
  [entity: string]: number
}

// Define a type for App Entity Counts (where the key is the app name and the value is the entity counts)
export interface AppEntityCounts {
  [app: string]: EntityCounts
}

// Function to group code search results by language
export const groupCodeByLanguage = async (
  query: string,
  limit = config.page,
  timestampRange?: { to: number; from: number } | null,
): Promise<LanguageCounts> => {
  // Use the specific profile for language grouping
  let { yql, profile } = HybridCodeLanguageGroupProfile(
    limit,
    timestampRange ?? null,
  )

  const payload = {
    yql,
    query,
    "ranking.profile": profile,
    // Specify code-embedder for the code search input 'q_embedding'
    "input.query(q_embedding)": "embed(code-embedder, @query)",
    // Alpha is needed if the profile uses it, even for grouping
    "input.query(alpha)": 0.5, // Default or adjust as needed
  }

  try {
    // Use the generic search method as groupSearch is specific to app/entity
    const response = await vespa.search<VespaSearchResponse>(payload)

    // Process the response to extract language counts
    const languageCounts: LanguageCounts = {}
    // Grouping results are nested within the response structure
    const groupRoot = response.root.children?.[0] // group:root
    if (groupRoot && "children" in groupRoot) {
      const languageGroup = groupRoot.children?.[0] // grouplist:language
      if (languageGroup && "children" in languageGroup) {
        // @ts-ignore - Vespa response structure can be complex
        for (const langGroup of languageGroup.children) {
          const languageName = langGroup.value as string
          const count = langGroup.fields?.["count()"] || 0
          languageCounts[languageName] = count
        }
      }
    }
    return languageCounts
  } catch (error) {
    throw new ErrorPerformingSearch({
      cause: error as Error,
      sources: CodeSources, // Source is specific code schema
      message: "Error grouping code results by language",
    })
  }
}

export const ifDocumentsExist = async (
  docIds: string[],
): Promise<Record<string, { exists: boolean; updatedAt: number | null }>> => {
  try {
    return await vespa.ifDocumentsExist(docIds)
  } catch (error) {
    throw error
  }
}

const getNDocuments = async (n: number) => {
  // Encode the YQL query to ensure it's URL-safe
  const yql = encodeURIComponent(
    `select * from sources ${fileSchema} where true`,
  )

  // Construct the search URL with necessary query parameters
  const url = `${vespaEndpoint}/search/?yql=${yql}&hits=${n}&cluster=${CLUSTER}`

  try {
    const response: Response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    })

    if (!response.ok) {
      const errorText = response.statusText
      throw new Error(
        `Failed to fetch document count: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    const data = await response.json()

    return data
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(error, `Error retrieving document count: , ${errMessage}`)
    throw new ErrorRetrievingDocuments({
      cause: error as Error,
      sources: "file",
    })
  }
}

const hashQuery = (query: string) => {
  return crypto.createHash("sha256").update(query.trim()).digest("hex")
}

export const updateUserQueryHistory = async (query: string, owner: string) => {
  const docId = `query_id-${hashQuery(query + owner)}`
  const timestamp = new Date().getTime()

  try {
    const docExist = await getDocumentOrNull(userQuerySchema, docId)

    if (docExist) {
      const docFields = docExist.fields as VespaUserQueryHistory
      const timeSinceLastUpdate = timestamp - docFields.timestamp
      if (timeSinceLastUpdate > config.userQueryUpdateInterval) {
        await UpdateDocument(userQuerySchema, docId, {
          count: docFields.count + 1,
          timestamp,
        })
      } else {
        Logger.warn(`Skipping update for ${docId}: Under time interval`)
      }
    } else {
      await insert(
        { docId, query_text: query, timestamp, count: 1, owner },
        userQuerySchema,
      )
    }
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(error, `Update user query error: ${errMsg}`, error)
    throw new Error("Failed to update user query history")
  }
}

export const getDocumentOrNull = async (schema: VespaSchema, docId: string) => {
  try {
    return await GetDocument(schema, docId)
  } catch (error) {
    const errMsg = getErrorMessage(error)
    if (errMsg.includes("404 Not Found")) {
      Logger.warn(`Document ${docId} does not exist`)
      return null
    }

    throw error
  }
}

export const searchUsersByNamesAndEmails = async (
  mentionedNames: string[],
  mentionedEmails: string[],
  limit: number = 10,
): Promise<VespaSearchResponse> => {
  // Construct YQL conditions for names and emails
  const nameConditions = mentionedNames.map((name) => {
    // For fuzzy search
    return `(name_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy("${name}")))`
    // For exact match, use:
    // return `(name contains "${name}")`;
  })

  const emailConditions = mentionedEmails.map((email) => {
    // For fuzzy search
    return `(email_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy("${email}")))`
    // For exact match, use:
    // return `(email contains "${email}")`;
  })

  // Combine all conditions with OR operator
  const allConditions = [...nameConditions, ...emailConditions].join(" or ")

  // Build the full YQL query
  const yqlQuery = `select * from sources ${userSchema} where (${allConditions});`

  const searchPayload = {
    yql: yqlQuery,
    hits: limit,
    "ranking.profile": "default",
  }

  try {
    return await vespa.getUsersByNamesAndEmaisl(searchPayload)
  } catch (error) {
    throw error
  }
}

/**
 * Helper function to calculate the timestamp based on LastUpdated value.
 */
export const getTimestamp = (lastUpdated: string): number | null => {
  const now = new Date().getTime() // Convert current time to epoch seconds
  switch (lastUpdated) {
    case "pastDay":
      return now - 24 * 60 * 60 * 1000
    case "pastWeek":
      return now - 7 * 24 * 60 * 60 * 1000
    case "pastMonth":
      return now - 30 * 24 * 60 * 60 * 1000
    case "pastYear":
      return now - 365 * 24 * 60 * 60 * 1000
    case "anytime":
    default:
      return null
  }
}

// export const searchEmployeesViaName = async (
//   name: string,
//   email: string,
//   limit = config.page,
//   offset?: number,
// ): Promise<VespaSearchResponse> => {
//   const url = `${vespaEndpoint}/search/`

//   const yqlQuery = `
//       select * from sources user
//       where name contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))`

//   const hybridDefaultPayload = {
//     yql: yqlQuery,
//     query: name,
//     email,
//     "ranking.profile": HybridDefaultProfile(limit).profile,
//     "input.query(e)": "embed(@query)",
//     hits: limit,
//     alpha: 0.5,
//     ...(offset
//       ? {
//           offset,
//         }
//       : {}),
//     variables: {
//       query,
//     },
//   }
//   try {
//     const response = await fetch(url, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//       },
//       body: JSON.stringify(hybridDefaultPayload),
//     })
//     if (!response.ok) {
//       const errorText = response.statusText
//       throw new Error(
//         `Failed to fetch documents: ${response.status} ${response.statusText} - ${errorText}`,
//       )
//     }

//     const data = await response.json()
//     return data
//   } catch (error) {
//     Logger.error(`Error performing search:, ${error}`)
//     throw new ErrorPerformingSearch({
//       cause: error as Error,
//       sources: AllSources,
//     })
//   }
// }

interface GetItemsParams {
  schema: VespaSchema
  app?: Apps | null
  entity?: Entity | null
  timestampRange: { from: number | null; to: number | null } | null
  limit?: number
  offset?: number
  email: string
  // query: string
}

// TODO: this won't work for user schema
//
export const getItems = async (
  params: GetItemsParams,
): Promise<VespaSearchResponse> => {
  const {
    schema,
    app,
    entity,
    timestampRange,
    limit = config.page,
    offset = 0,
    email,
  } = params

  // Construct conditions based on parameters
  let conditions: string[] = []

  // App condition
  if (app) {
    conditions.push(`app contains @app`)
  }

  // Entity condition
  if (entity) {
    conditions.push(`entity contains @entity`)
  }

  // Permissions or owner condition based on schema
  if (schema !== userSchema) {
    conditions.push(`permissions contains @email`)
  } else {
    // For user schema
    if (app !== Apps.GoogleWorkspace) {
      conditions.push(`owner contains @email`)
    }
  }

  let timestampField = ""

  // Choose appropriate timestamp field based on schema
  if (schema === mailSchema) {
    timestampField = "timestamp"
  } else if (schema === fileSchema) {
    timestampField = "updatedAt"
  } else if (schema === eventSchema) {
    timestampField = "startTime"
  } else if (schema === userSchema) {
    timestampField = "creationTime"
  } else {
    timestampField = "updatedAt"
  }

  // Timestamp conditions
  if (timestampRange) {
    let timeConditions: string[] = []
    if (timestampRange.from) {
      timeConditions.push(
        `${timestampField} >= ${new Date(timestampRange.from).getTime()}`,
      )
    }
    if (timestampRange.to) {
      timeConditions.push(
        `${timestampField} <= ${new Date(timestampRange.to).getTime()}`,
      )
    }
    if (timeConditions.length > 0) {
      conditions.push(`(${timeConditions.join(" and ")})`)
    }
  }

  // Combine conditions
  const whereClause =
    conditions.length > 0 ? `where ${conditions.join(" and ")}` : "where true"

  const orderByClause = timestampField ? `order by ${timestampField} asc` : ""

  // Construct YQL query with limit and offset
  const yql = `select * from sources ${schema} ${whereClause} ${orderByClause} limit ${limit} offset ${offset}`

  const searchPayload = {
    yql,
    email,
    ...(app ? { app } : {}),
    ...(entity ? { entity } : {}),
    "ranking.profile": "unranked",
  }

  try {
    return await vespa.getItems(searchPayload)
  } catch (error) {
    throw new ErrorPerformingSearch({
      cause: error as Error,
      sources: schema,
    })
  }
}
