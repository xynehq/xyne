// import { env, pipeline } from '@xenova/transformers';
// let { pipeline, env } = await import('@xenova/transformers');

import type {
  VespaAutocompleteResponse,
  VespaFile,
  VespaResult,
  VespaSearchResponse,
  VespaUser,
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
const fileSchema = "file" // Replace with your actual schema name
const userSchema = "user"
const NAMESPACE = "namespace" // Replace with your actual namespace
const CLUSTER = "my_content"

const Logger = getLogger(Subsystem.Search).child({ module: "vespa" })

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
      const errorText = await response.text()
      throw new Error(
        `Failed to delete documents: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }
  } catch (error) {
    Logger.error(`Error deleting documents:, ${error}`)
    throw new ErrorDeletingDocuments({
      cause: error as Error,
      sources: "file",
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
      Logger.info(`Document ${document.docId} inserted successfully:, ${data}`)
    } else {
      Logger.error(`Error inserting document ${document.docId}:, ${data}`)
    }
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(`Error inserting document ${document.docId}:, ${errMessage}`)
    throw new ErrorInsertingDocument({
      docId: document.docId,
      cause: error as Error,
      sources: fileSchema,
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
      console.log(`Document ${user.docId} inserted successfully:`, data)
    } else {
      console.error(`Error inserting user ${user.docId}:`, data)
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    console.error(`Error inserting user ${user.docId}:`, errorMessage)
  }
}

export const autocomplete = async (
  query: string,
  email: string,
  limit: number = 5,
): Promise<VespaAutocompleteResponse> => {
  // Construct the YQL query for fuzzy prefix matching with maxEditDistance:2
  const yqlQuery = `select * from sources file, user
        where
            (title_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
            and permissions contains @email)
            or
            (name_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
            or email_fuzzy contains ({maxEditDistance: 2, prefix: true} fuzzy(@query))
            );`

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
      const errorText = await response.text()
      throw new Error(
        `Failed to perform autocomplete search: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    const data = await response.json()
    return data
  } catch (error) {
    Logger.error(`Error performing autocomplete search:, ${error} `)
    throw new ErrorPerformingSearch({
      message: `Error performing autocomplete search`,
      cause: error as Error,
      sources: "file",
    })
    // TODO: instead of null just send empty response
    throw error
  }
}

type YqlProfile = {
  profile: string
  yql: string
}

const HybridDefaultProfile = (hits: number): YqlProfile => {
  return {
    profile: "default",
    yql: `
            select * from sources file, user
            where ((
                ({targetHits:${hits}}userInput(@query))
                or
                ({targetHits:${hits}}nearestNeighbor(chunk_embeddings, e))
            )
            and permissions contains @email)
            or
            ({targetHits:${hits}}userInput(@query))
        `,
  }
}

const HybridDefaultProfileAppEntityCounts = (hits: number): YqlProfile => {
  return {
    profile: "default",
    yql: `select * from sources file, user
            where ((({targetHits:${hits}}userInput(@query))
            or ({targetHits:${hits}}nearestNeighbor(chunk_embeddings, e))) and permissions contains @email)
            or ({targetHits:${hits}}userInput(@query))
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
  app?: string,
  entity?: string,
  limit = config.page,
): Promise<AppEntityCounts> => {
  const url = `${vespaEndpoint}/search/`
  let yqlQuery = HybridDefaultProfileAppEntityCounts(limit).yql

  const hybridDefaultPayload = {
    yql: yqlQuery,
    query,
    email,
    "ranking.profile": HybridDefaultProfileAppEntityCounts(limit).profile,
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
      const errorText = await response.text()
      throw new Error(
        `Failed to fetch documents: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    const data = await response.json()
    return handleVespaGroupResponse(data)
  } catch (error) {
    Logger.error(`Error performing search:, ${error}`)
    throw new ErrorPerformingSearch({
      cause: error as Error,
      sources: fileSchema,
    })
  }
}

export const searchVespa = async (
  query: string,
  email: string,
  app?: string,
  entity?: string,
  limit = config.page,
  offset?: number,
): Promise<VespaSearchResponse | {}> => {
  const url = `${vespaEndpoint}/search/`

  let yqlQuery = HybridDefaultProfile(limit).yql

  if (app && entity) {
    yqlQuery += ` and app contains @app and entity contains @entity`
  }

  const hybridDefaultPayload = {
    yql: yqlQuery,
    query,
    email,
    "ranking.profile": HybridDefaultProfile(limit).profile,
    "input.query(e)": "embed(@query)",
    hits: limit,
    alpha: 0.5,
    ...(offset
      ? {
          offset,
        }
      : {}),
    ...(app && entity ? { app, entity } : {}),
    variables: {
      query,
      app,
      entity,
    },
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
      const errorText = await response.text()
      throw new Error(
        `Failed to fetch documents: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    const data = await response.json()
    return data
  } catch (error) {
    Logger.error(`Error performing search:, ${error}`)
    throw new ErrorPerformingSearch({
      cause: error as Error,
      sources: fileSchema,
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
      const errorText = await response.text()
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

export const GetDocument = async (docId: string): Promise<VespaResult> => {
  const url = `${vespaEndpoint}/document/v1/${NAMESPACE}/${fileSchema}/docid/${docId}`
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
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
      sources: fileSchema,
    })
  }
}

export const UpdateDocumentPermissions = async (
  docId: string,
  updatedPermissions: string[],
) => {
  const url = `${vespaEndpoint}/document/v1/${NAMESPACE}/${fileSchema}/docid/${docId}`
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
      const errorText = await response.text()
      throw new Error(
        `Failed to update document: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    Logger.info(`Successfully updated permissions for document ${docId}.`)
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(
      `Error updating permissions for document ${docId}:`,
      errMessage,
    )
    throw new ErrorUpdatingDocument({
      docId,
      cause: error as Error,
      sources: fileSchema,
    })
  }
}

export const DeleteDocument = async (docId: string) => {
  const url = `${vespaEndpoint}/document/v1/${NAMESPACE}/${fileSchema}/docid/${docId}`
  try {
    const response = await fetch(url, {
      method: "DELETE",
    })

    if (!response.ok) {
      const errorText = await response.text()
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
      sources: fileSchema,
    })
  }
}

// Define a type for Entity Counts (where the key is the entity name and the value is the count)
interface EntityCounts {
  [entity: string]: number
}

// Define a type for App Entity Counts (where the key is the app name and the value is the entity counts)
interface AppEntityCounts {
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
      const errorText = await response.text()
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
      const errorText = await response.text()
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
