import {
  Apps,
  CalendarEntity,
  DriveEntity,
  eventSchema,
  fileSchema,
  MailEntity,
  mailSchema,
  userSchema,
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

// Define your Vespa endpoint and schema name
const vespaEndpoint = `http://${config.vespaBaseHost}:8080`
const NAMESPACE = "namespace" // Replace with your actual namespace
const CLUSTER = "my_content"

const Logger = getLogger(Subsystem.Vespa).child({ module: "vespa" })

function handleVespaGroupResponse(
  response: VespaSearchResponse,
): AppEntityCounts {
  const appEntityCounts: AppEntityCounts = {}

  // Navigate to the first level of groups
  const groupRoot = response.root.children?.[0] // Assuming this is the group:root level
  if (!groupRoot || !("children" in groupRoot)) return appEntityCounts // Safeguard for empty responses

  // Navigate to the app grouping (e.g., grouplist:app)
  const appGroup = groupRoot.children?.[0]
  if (!appGroup || !("children" in appGroup)) return appEntityCounts // Safeguard for missing app group

  // Iterate through the apps
  // @ts-ignore
  for (const app of appGroup.children) {
    const appName = app.value as string // Get the app name
    appEntityCounts[appName] = {} // Initialize the app entry

    // Navigate to the entity grouping (e.g., grouplist:entity)
    const entityGroup = app.children?.[0]
    if (!entityGroup || !("children" in entityGroup)) continue // Skip if no entities

    // Iterate through the entities
    // @ts-ignore
    for (const entity of entityGroup.children) {
      const entityName = entity.value as string // Get the entity name
      const count = entity.fields?.["count()"] || 0 // Get the count or default to 0
      appEntityCounts[appName][entityName] = count // Assign the count to the app-entity pair
    }
  }

  return appEntityCounts // Return the final map
}

/**
 * Deletes all documents from the specified schema and namespace in Vespa.
 */
async function deleteAllDocuments() {
  // Construct the DELETE URL
  const url = `${vespaEndpoint}/document/v1/${NAMESPACE}/${fileSchema}/docid?selection=true&cluster=${CLUSTER}`

  try {
    const response: Response = await fetch(url, {
      method: "DELETE",
    })

    if (response.ok) {
      Logger.info("All documents deleted successfully.")
    } else {
      const errorText = response.statusText
      throw new Error(
        `Failed to delete documents: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }
  } catch (error) {
    Logger.error(
      `Error deleting documents:, ${error} ${(error as Error).stack}`,
    )
    throw new ErrorDeletingDocuments({
      cause: error as Error,
      sources: AllSources,
    })
  }
}

export const insertDocument = async (document: VespaFile) => {
  try {
    const response = await fetch(
      `${vespaEndpoint}/document/v1/${NAMESPACE}/${fileSchema}/docid/${document.docId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields: document }),
      },
    )

    const data = await response.json()

    if (response.ok) {
      Logger.info(`Document ${document.docId} inserted successfully`)
    } else {
      Logger.error(`Error inserting document ${document.docId}`)
    }
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(`Error inserting document ${document.docId}: ${errMessage}`)
    throw new ErrorInsertingDocument({
      docId: document.docId,
      cause: error as Error,
      sources: fileSchema,
    })
  }
}

// generic insert method
export const insert = async (
  document: VespaUser | VespaFile | VespaMail | VespaEvent,
  schema: string,
) => {
  try {
    const response = await fetch(
      `${vespaEndpoint}/document/v1/${NAMESPACE}/${schema}/docid/${document.docId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields: document }),
      },
    )

    const data = await response.json()

    if (response.ok) {
      Logger.info(`Document ${document.docId} inserted successfully`)
    } else {
      // Using status text since response.text() return Body Already used Error
      const errorText = response.statusText
      Logger.error(
        `Error inserting document ${document.docId} for ${schema} ${data.message}`,
      )
      throw new Error(
        `Failed to fetch documents: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(
      `Error inserting document ${document.docId}: ${errMessage} ${(error as Error).stack}`,
    )
    throw new ErrorInsertingDocument({
      docId: document.docId,
      cause: error as Error,
      sources: schema,
    })
  }
}

export const insertUser = async (user: VespaUser) => {
  try {
    const response = await fetch(
      `${vespaEndpoint}/document/v1/${NAMESPACE}/${userSchema}/docid/${user.docId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields: user }),
      },
    )

    const data = await response.json()

    if (response.ok) {
      Logger.info(`Document ${user.docId} inserted successfully:`, data)
    } else {
      Logger.error(`Error inserting user ${user.docId}: ${data}`, data)
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    Logger.error(`Error inserting user ${user.docId}:`, errorMessage)
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

const AllSources = [fileSchema, userSchema, mailSchema, eventSchema].join(", ")

export const autocomplete = async (
  query: string,
  email: string,
  limit: number = 5,
): Promise<VespaAutocompleteResponse> => {
  // Construct the YQL query for fuzzy prefix matching with maxEditDistance:2
  // the drawback here is that for user field we will get duplicates, for the same
  // email one contact and one from user directory
  const yqlQuery = `select * from sources ${AllSources}
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
        and permissions contains @email);`

  const searchPayload = {
    yql: yqlQuery,
    query: query,
    email,
    hits: limit, // Limit the number of suggestions
    "ranking.profile": "autocomplete", // Use the autocomplete rank profile
    "presentation.summary": "autocomplete",
  }
  try {
    const response = await fetch(`${vespaEndpoint}/search/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(searchPayload),
    })

    if (!response.ok) {
      const errorText = response.statusText
      throw new Error(
        `Failed to perform autocomplete search: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    const data = await response.json()
    return data
  } catch (error) {
    Logger.error(
      `Error performing autocomplete search:, ${error} ${(error as Error).stack} `,
    )
    throw new ErrorPerformingSearch({
      message: `Error performing autocomplete search`,
      cause: error as Error,
      sources: "file",
    })
    // TODO: instead of null just send empty response
    throw error
  }
}

type RankProfile = "default"
type YqlProfile = {
  profile: RankProfile
  yql: string
}

// TODO: it seems the owner part is complicating things
const HybridDefaultProfile = (
  hits: number,
  app: Apps | null,
  entity: Entity | null,
  profile: RankProfile = "default",
  timestampRange?: { to: number; from: number } | null,
  excludedIds?: string[],
  notInMailLabels?: string[],
): YqlProfile => {
  let hasAppOrEntity = !!(app || entity)
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
            ${timestampRange ? `and (${fileTimestamp} or ${mailTimestamp})` : ""}
            and permissions contains @email ${mailLabelQuery}
            ${appOrEntityFilter}
          )
          or
          (
            ({targetHits:${hits}}userInput(@query))
            ${timestampRange ? `and ${userTimestamp}` : ""}
            ${!hasAppOrEntity ? `and app contains "${Apps.GoogleWorkspace}"` : appOrEntityFilter}
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
    profile: "default",
    yql: `select * from sources ${AllSources}
            where ((({targetHits:${hits}}userInput(@query))
            or ({targetHits:${hits}}nearestNeighbor(chunk_embeddings, e))) ${timestampRange ? ` and (${fileTimestamp} or ${mailTimestamp}) ` : ""} and permissions contains @email ${mailLabelQuery})
            or
            (({targetHits:${hits}}userInput(@query)) ${timestampRange ? `and ${userTimestamp} ` : ""} and app contains "${Apps.GoogleWorkspace}")
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

// TODO: extract out the fetch and make an api client
export const groupVespaSearch = async (
  query: string,
  email: string,
  limit = config.page,
  timestampRange?: { to: number; from: number } | null,
): Promise<AppEntityCounts> => {
  const url = `${vespaEndpoint}/search/`
  let { yql, profile } = HybridDefaultProfileAppEntityCounts(
    limit,
    timestampRange ?? null,
  )

  const hybridDefaultPayload = {
    yql,
    query,
    email,
    "ranking.profile": profile,
    "input.query(e)": "embed(@query)",
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(hybridDefaultPayload),
    })
    if (!response.ok) {
      const errorText = response.statusText
      throw new Error(
        `Failed to fetch documents in groupVespaSearch: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    const data = await response.json()
    return handleVespaGroupResponse(data)
  } catch (error) {
    Logger.error(
      `Error performing search groupVespaSearch:, ${error} - ${(error as Error).stack}`,
    )
    throw new ErrorPerformingSearch({
      cause: error as Error,
      sources: AllSources,
    })
  }
}

export const searchVespa = async (
  query: string,
  email: string,
  app: Apps | null,
  entity: Entity | null,
  limit = config.page,
  offset?: number,
  timestampRange?: { from: number; to: number } | null,
  excludedIds?: string[],
  notInMailLabels?: string[],
): Promise<VespaSearchResponse> => {
  const url = `${vespaEndpoint}/search/`

  // Determine the timestamp cutoff based on lastUpdated
  // const timestamp = lastUpdated ? getTimestamp(lastUpdated) : null
  let { yql, profile } = HybridDefaultProfile(
    limit,
    app,
    entity,
    "default",
    timestampRange,
    excludedIds,
    notInMailLabels,
  )

  const hybridDefaultPayload = {
    yql,
    query,
    email,
    "ranking.profile": profile,
    "input.query(e)": "embed(@query)",
    hits: limit,
    alpha: 0.5,
    ...(offset
      ? {
          offset,
        }
      : {}),
    ...(app ? { app } : {}),
    ...(entity ? { entity } : {}),
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(hybridDefaultPayload),
    })
    if (!response.ok) {
      const errorText = response.statusText
      throw new Error(
        `Failed to fetch documents in searchVespa: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    const data = await response.json()
    return data
  } catch (error) {
    Logger.error(
      `Error performing search in searchVespa:, ${error} ${(error as Error).stack}`,
    )
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
  // Encode the YQL query to ensure it's URL-safe
  const yql = encodeURIComponent(
    `select * from sources ${fileSchema} where true`,
  )

  // Construct the search URL with necessary query parameters
  const url = `${vespaEndpoint}/search/?yql=${yql}&hits=0&cluster=${CLUSTER}`

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

    // Extract the total number of hits from the response
    const totalCount = data?.root?.fields?.totalCount

    if (typeof totalCount === "number") {
      Logger.info(
        `Total documents in schema '${fileSchema}' within namespace '${NAMESPACE}' and cluster '${CLUSTER}': ${totalCount}`,
      )
    } else {
      Logger.error(`Unexpected response structure:', ${data}`)
    }
  } catch (error) {
    Logger.error("Error retrieving document count:", error)
    throw new ErrorRetrievingDocuments({
      cause: error as Error,
      sources: "file",
    })
  }
}

export const GetDocument = async (
  schema: string,
  docId: string,
): Promise<VespaGetResult> => {
  const url = `${vespaEndpoint}/document/v1/${NAMESPACE}/${schema}/docid/${docId}`
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    })

    if (!response.ok) {
      const errorText = response.statusText
      throw new Error(
        `Failed to fetch document: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    const document = await response.json()
    return document
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(`Error fetching document ${docId}:  ${errMessage}`)
    throw new ErrorGettingDocument({
      docId,
      cause: error as Error,
      sources: schema,
    })
  }
}

export const UpdateDocumentPermissions = async (
  schema: string,
  docId: string,
  updatedPermissions: string[],
) => {
  const url = `${vespaEndpoint}/document/v1/${NAMESPACE}/${schema}/docid/${docId}`
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          permissions: { assign: updatedPermissions },
        },
      }),
    })

    if (!response.ok) {
      const errorText = response.statusText
      throw new ErrorUpdatingDocument({
        message: `Failed to update document: ${response.status} ${response.statusText} - ${errorText}`,
        docId,
        sources: schema,
      })
    }

    Logger.info(
      `Successfully updated permissions in schema ${schema} for document ${docId}.`,
    )
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(
      `Error updating permissions in schema ${schema} for document ${docId}:`,
      errMessage,
    )
    throw new ErrorUpdatingDocument({
      docId,
      cause: error as Error,
      sources: schema,
    })
  }
}

export const UpdateEventCancelledInstances = async (
  schema: string,
  docId: string,
  updatedCancelledInstances: string[],
) => {
  const url = `${vespaEndpoint}/document/v1/${NAMESPACE}/${schema}/docid/${docId}`
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          cancelledInstances: { assign: updatedCancelledInstances },
        },
      }),
    })

    if (!response.ok) {
      const errorText = response.statusText
      throw new ErrorUpdatingDocument({
        message: `Failed to update document: ${response.status} ${response.statusText} - ${errorText}`,
        docId,
        sources: schema,
      })
    }

    Logger.info(
      `Successfully updated event instances in schema ${schema} for document ${docId}.`,
    )
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(
      `Error updating event instances in schema ${schema} for document ${docId}:`,
      errMessage,
    )
    throw new ErrorUpdatingDocument({
      docId,
      cause: error as Error,
      sources: schema,
    })
  }
}

export const UpdateDocument = async (
  schema: string,
  docId: string,
  updatedFields: Record<string, any>,
) => {
  const url = `${vespaEndpoint}/document/v1/${NAMESPACE}/${schema}/docid/${docId}`
  let fields: string[] = []
  try {
    const updateObject = Object.entries(updatedFields).reduce(
      (prev, [key, value]) => {
        // for logging
        fields.push(key)
        prev[key] = { assign: value }
        return prev
      },
      {} as Record<string, any>,
    )
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: updateObject,
      }),
    })

    if (!response.ok) {
      const errorText = response.statusText
      throw new ErrorUpdatingDocument({
        message: `Failed to update document: ${response.status} ${response.statusText} - ${errorText}`,
        docId,
        sources: schema,
      })
    }

    Logger.info(
      `Successfully updated ${fields} in schema ${schema} for document ${docId}.`,
    )
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(
      `Error updating ${fields} in schema ${schema} for document ${docId}:`,
      errMessage,
    )
    throw new ErrorUpdatingDocument({
      docId,
      cause: error as Error,
      sources: schema,
    })
  }
}

export const DeleteDocument = async (docId: string, schema: string) => {
  const url = `${vespaEndpoint}/document/v1/${NAMESPACE}/${schema}/docid/${docId}`
  try {
    const response = await fetch(url, {
      method: "DELETE",
    })

    if (!response.ok) {
      const errorText = response.statusText
      throw new Error(
        `Failed to delete document: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    Logger.info(`Document ${docId} deleted successfully.`)
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(`Error deleting document ${docId}:  ${errMessage}`)
    throw new ErrorDeletingDocuments({
      cause: error as Error,
      sources: schema,
    })
  }
}

// Define a type for Entity Counts (where the key is the entity name and the value is the count)
interface EntityCounts {
  [entity: string]: number
}

// Define a type for App Entity Counts (where the key is the app name and the value is the entity counts)
export interface AppEntityCounts {
  [app: string]: EntityCounts
}

export const ifDocumentsExist = async (docIds: string[]) => {
  // Construct the YQL query
  const yqlIds = docIds.map((id) => `"${id}"`).join(", ")
  const yqlQuery = `select docId from sources * where docId in (${yqlIds})`

  const url = `${vespaEndpoint}/search/?yql=${encodeURIComponent(yqlQuery)}&hits=${docIds.length}`

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    })

    if (!response.ok) {
      const errorText = response.statusText
      throw new Error(
        `Search query failed: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    const result = await response.json()

    // Extract the document IDs of the found documents
    // @ts-ignore
    const foundIds = result.root.children?.map((hit) => hit.fields.docId) || []

    // Determine which IDs exist and which do not
    const existenceMap = docIds.reduce(
      (acc, id) => {
        acc[id] = foundIds.includes(id)
        return acc
      },
      {} as Record<string, boolean>,
    )

    return existenceMap // { "id:namespace:doctype::1": true, "id:namespace:doctype::2": false, ... }
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(`Error checking documents existence:  ${errMessage}`)
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
    Logger.error(`Error retrieving document count: , ${errMessage}`)
    throw new ErrorRetrievingDocuments({
      cause: error as Error,
      sources: "file",
    })
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
    const response = await fetch(`${vespaEndpoint}/search/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(searchPayload),
    })

    if (!response.ok) {
      const errorText = response.statusText
      throw new Error(
        `Failed to perform user search: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    const data: VespaSearchResponse = await response.json()

    // Parse and return the user results
    // const users: VespaUser[] =
    //   data.root.children?.map((child) => {
    //     const fields = child.fields
    //     return VespaUserSchema.parse(fields)
    //   }) || []

    return data
  } catch (error) {
    Logger.error(`Error searching users: ${error}`)
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
  schema: string
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

  const url = `${vespaEndpoint}/search/`

  const searchPayload = {
    yql,
    email,
    ...(app ? { app } : {}),
    ...(entity ? { entity } : {}),
    "ranking.profile": "unranked",
  }

  try {
    const response: Response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(searchPayload),
    })

    if (!response.ok) {
      const errorText = response.statusText
      throw new Error(
        `Failed to fetch items: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    const data: VespaSearchResponse = await response.json()
    return data
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(`Error fetching items: ${errMessage}`)
    throw new ErrorPerformingSearch({
      cause: error as Error,
      sources: schema,
    })
  }
}
