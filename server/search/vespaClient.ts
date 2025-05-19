import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type {
  VespaAutocompleteResponse,
  VespaFile,
  VespaMail,
  VespaSearchResponse,
  VespaUser,
  VespaGetResult,
  VespaEvent,
  VespaUserQueryHistory,
  VespaSchema,
  VespaMailAttachment,
  VespaChatContainer,
  Inserts,
} from "@/search/types"
import { getErrorMessage } from "@/utils"
import type { AppEntityCounts } from "@/search/vespa"
import { handleVespaGroupResponse } from "@/search/mappers"
import { getTracer, type Span, type Tracer } from "@/tracer"
import crypto from "crypto"
const Logger = getLogger(Subsystem.Vespa).child({ module: "vespa" })

type VespaConfigValues = {
  namespace?: string
  schema?: VespaSchema
  cluster?: string
}

class VespaClient {
  private maxRetries: number
  private retryDelay: number
  private vespaEndpoint: string

  constructor() {
    this.maxRetries = config.vespaMaxRetryAttempts || 3
    this.retryDelay = config.vespaRetryDelay || 1000 // milliseconds
    this.vespaEndpoint = `http://${config.vespaBaseHost}:8080`
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    retryCount = 0,
  ): Promise<Response> {
    const nonRetryableStatusCodes = [404]
    try {
      const response = await fetch(url, options)
      if (!response.ok) {
        // Don't need to retry for non-retryable status codes
        if (nonRetryableStatusCodes.includes(response.status)) {
          throw new Error(
            `Non-retryable error: ${response.status} ${response.statusText}`,
          )
        }

        // Retry for 429 (Too Many Requests) or 5xx errors
        if (
          (response.status === 429 || response.status >= 500) &&
          retryCount < this.maxRetries
        ) {
          Logger.info("retrying due to status: ", response.status)
          await this.delay(this.retryDelay * Math.pow(2, retryCount))
          return this.fetchWithRetry(url, options, retryCount + 1)
        }
      }

      return response
    } catch (error) {
      const errorMessage = getErrorMessage(error)

      if (
        retryCount < this.maxRetries &&
        !errorMessage.includes("Non-retryable error")
      ) {
        await this.delay(this.retryDelay * Math.pow(2, retryCount)) // Exponential backoff
        return this.fetchWithRetry(url, options, retryCount + 1)
      }
      throw error
    }
  }

  async search<T>(payload: any): Promise<T> {
    const url = `${this.vespaEndpoint}/search/`
    try {
      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorText = response.statusText
        const errorBody = await response.text()
        Logger.error(`Vespa error: ${errorBody}`)
        throw new Error(
          `Failed to fetch documents in searchVespa: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }

      return response.json()
    } catch (error: any) {
      Logger.error(
        error,
        `Error performing search in searchVespa:, ${error} ${(error as Error).stack}`,
      )
      throw new Error(`Vespa search error: ${error.message}`)
    }
  }
  private async fetchDocumentBatch(
    schema: VespaSchema,
    options: VespaConfigValues,
    limit: number,
    offset: number,
  ): Promise<any[]> {
    const yqlQuery = `select * from sources ${schema} where true`
    const searchPayload = {
      yql: yqlQuery,
      hits: limit,
      offset,
      timeout: "10s",
    }

    const response = await this.search<VespaSearchResponse>(searchPayload)
    return (response.root?.children || []).map((doc) => doc.fields)
  }

  async getAllDocumentsParallel(
    schema: VespaSchema,
    options: VespaConfigValues,
    concurrency: number = 3,
  ): Promise<any[]> {
    // First get document count
    const countResponse = await this.getDocumentCount(schema, options)
    const totalCount = countResponse?.root?.fields?.totalCount || 0

    if (totalCount === 0) return []

    // Calculate optimal batch size and create batch tasks
    const batchSize = 500
    const tasks = []

    for (let offset = 0; offset < totalCount; offset += batchSize) {
      tasks.push(() =>
        this.fetchDocumentBatch(schema, options, batchSize, offset),
      )
    }

    // Run tasks with concurrency limit
    const pLimit = (await import("p-limit")).default
    const limit = pLimit(concurrency)
    const results = await Promise.all(tasks.map((task) => limit(task)))

    // Flatten results
    return results.flat()
  }

  async deleteAllDocuments(options: VespaConfigValues): Promise<void> {
    const { cluster, namespace, schema } = options
    // Construct the DELETE URL
    const url = `${this.vespaEndpoint}/document/v1/${namespace}/${schema}/docid?selection=true&cluster=${cluster}`

    try {
      const response: Response = await this.fetchWithRetry(url, {
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
        error,
        `Error deleting documents:, ${error} ${(error as Error).stack}`,
      )
      throw new Error(`Vespa delete error: ${error}`)
    }
  }

  async insertDocument(
    document: VespaFile,
    options: VespaConfigValues,
  ): Promise<void> {
    try {
      const url = `${this.vespaEndpoint}/document/v1/${options.namespace}/${options.schema}/docid/${document.docId}`
      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields: document }),
      })

      if (!response.ok) {
        // Using status text since response.text() return Body Already used Error
        const errorText = response.statusText
        const errorBody = await response.text()
        Logger.error(`Vespa error: ${errorBody}`)
        throw new Error(
          `Failed to  insert document: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }
      const data = await response.json()

      if (response.ok) {
        // Logger.info(`Document ${document.docId} inserted successfully`)
      } else {
        Logger.error(`Error inserting document ${document.docId}`)
      }
    } catch (error) {
      const errMessage = getErrorMessage(error)
      Logger.error(
        error,
        `Error inserting document ${document.docId}: ${errMessage}`,
      )
      throw new Error(
        `Error inserting document ${document.docId}: ${errMessage}`,
      )
    }
  }

  async insert(document: Inserts, options: VespaConfigValues): Promise<void> {
    try {
      const url = `${this.vespaEndpoint}/document/v1/${options.namespace}/${options.schema}/docid/${document.docId}`
      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields: document }),
      })

      if (!response.ok) {
        // Using status text since response.text() return Body Already used Error
        const errorText = response.statusText
        const errorBody = await response.text()
        Logger.error(`Vespa error: ${errorBody}`)
        throw new Error(
          `Failed to  insert document: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }

      const data = await response.json()

      if (response.ok) {
        // Logger.info(`Document ${document.docId} inserted successfully`)
      } else {
      }
    } catch (error) {
      const errMessage = getErrorMessage(error)
      Logger.error(
        error,
        `Error inserting document ${document.docId}: ${errMessage} ${(error as Error).stack}`,
      )
      throw new Error(
        `Error inserting document ${document.docId}: ${errMessage} ${(error as Error).stack}`,
      )
    }
  }

  async insertUser(user: VespaUser, options: VespaConfigValues): Promise<void> {
    try {
      const url = `${this.vespaEndpoint}/document/v1/${options.namespace}/${options.schema}/docid/${user.docId}`
      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields: user }),
      })

      const data = await response.json()

      if (response.ok) {
        // Logger.info(`Document ${user.docId} inserted successfully:`, data)
      } else {
        Logger.error(`Error inserting user ${user.docId}: ${data}`, data)
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error)
      Logger.error(error, `Error inserting user ${user.docId}:`, errorMessage)
      throw new Error(`Error inserting user ${user.docId}: ${errorMessage}`)
    }
  }

  async autoComplete<T>(searchPayload: T): Promise<VespaAutocompleteResponse> {
    try {
      const url = `${this.vespaEndpoint}/search/`
      const response = await this.fetchWithRetry(url, {
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
        error,
        `Error performing autocomplete search:, ${error} ${(error as Error).stack} `,
      )
      throw new Error(
        `Error performing autocomplete search:, ${error} ${(error as Error).stack} `,
      )
      // TODO: instead of null just send empty response
      throw error
    }
  }

  async groupSearch<T>(payload: T): Promise<AppEntityCounts> {
    try {
      const url = `${this.vespaEndpoint}/search/`
      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
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
        error,
        `Error performing search groupVespaSearch:, ${error} - ${(error as Error).stack}`,
      )
      throw new Error(
        `Error performing search groupVespaSearch:, ${error} - ${(error as Error).stack}`,
      )
    }
  }

  async getDocumentCount(schema: VespaSchema, options: VespaConfigValues) {
    try {
      // Encode the YQL query to ensure it's URL-safe
      const yql = encodeURIComponent(
        `select * from sources ${schema} where true`,
      )
      // Construct the search URL with necessary query parameters
      const url = `${this.vespaEndpoint}/search/?yql=${yql}&hits=0&cluster=${options.cluster}`
      const response: Response = await this.fetchWithRetry(url, {
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
          `Total documents in schema '${schema}' within namespace '${options.namespace}' and cluster '${options.cluster}': ${totalCount}`,
        )
        return data
      } else {
        Logger.error(`Unexpected response structure:', ${data}`)
      }
    } catch (error) {
      const errMessage = getErrorMessage(error)
      Logger.error(error, "Error retrieving document count")
      throw new Error(`Error retrieving document count: ${errMessage}`)
    }
  }

  async getDocument(
    options: VespaConfigValues & { docId: string },
  ): Promise<VespaGetResult> {
    const { docId, namespace, schema } = options
    const url = `${this.vespaEndpoint}/document/v1/${namespace}/${schema}/docid/${docId}`
    try {
      const response = await this.fetchWithRetry(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      })
      if (!response.ok) {
        const errorText = response.statusText
        const errorBody = await response.text()
        throw new Error(
          `Failed to fetch document: ${response.status} ${response.statusText} - ${errorBody}`,
        )
      }

      const document = await response.json()
      return document
    } catch (error) {
      const errMessage = getErrorMessage(error)
      throw new Error(`Error fetching document docId: ${docId} - ${errMessage}`)
    }
  }

  async getDocumentsByOnlyDocIds(
    options: VespaConfigValues & { docIds: string[] },
  ): Promise<VespaSearchResponse> {
    const { docIds } = options
    const yqlIds = docIds.map((id) => `docId contains '${id}'`).join(" or ")
    const yqlQuery = `select * from sources * where (${yqlIds})`
    const url = `${this.vespaEndpoint}/search/`

    try {
      const payload = {
        yql: yqlQuery,
        hits: docIds?.length,
        maxHits: docIds?.length,
      }

      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorText = response.statusText
        throw new Error(
          `Search query failed: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }

      const result = await response.json()
      return result
    } catch (error) {
      const errMessage = getErrorMessage(error)
      throw new Error(`Error fetching documents: ${errMessage}`)
    }
  }

  async updateDocumentPermissions(
    permissions: string[],
    options: VespaConfigValues & { docId: string },
  ): Promise<void> {
    const { docId, namespace, schema } = options

    const url = `${this.vespaEndpoint}/document/v1/${namespace}/${schema}/docid/${docId}`
    try {
      const response = await this.fetchWithRetry(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fields: {
            permissions: { assign: permissions },
          },
        }),
      })

      if (!response.ok) {
        const errorText = response.statusText
        throw new Error(
          `Failed to update document: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }

      Logger.info(
        `Successfully updated permissions in schema ${schema} for document ${docId}.`,
      )
    } catch (error) {
      const errMessage = getErrorMessage(error)
      Logger.error(
        error,
        `Error updating permissions in schema ${schema} for document ${docId}:`,
        errMessage,
      )
      throw new Error(
        `Error updating permissions in schema ${schema} for document ${docId}: ${errMessage}`,
      )
    }
  }

  async updateCancelledEvents(
    cancelledInstances: string[],
    options: VespaConfigValues & { docId: string },
  ): Promise<void> {
    const { docId, namespace, schema } = options
    const url = `${this.vespaEndpoint}/document/v1/${namespace}/${schema}/docid/${docId}`
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fields: {
            cancelledInstances: { assign: cancelledInstances },
          },
        }),
      })

      if (!response.ok) {
        const errorText = response.statusText
        throw new Error(
          `Failed to update document: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }

      Logger.info(
        `Successfully updated event instances in schema ${schema} for document ${docId}.`,
      )
    } catch (error) {
      const errMessage = getErrorMessage(error)
      Logger.error(
        error,
        `Error updating event instances in schema ${schema} for document ${docId}:`,
        errMessage,
      )
      throw new Error(
        `Error updating event instances in schema ${schema} for document ${docId}: ${errMessage}`,
      )
    }
  }

  async updateDocument(
    updatedFields: Record<string, any>,
    options: VespaConfigValues & { docId: string },
  ): Promise<void> {
    const { docId, namespace, schema } = options

    const url = `${this.vespaEndpoint}/document/v1/${namespace}/${schema}/docid/${docId}`
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
      const response = await this.fetchWithRetry(url, {
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
        throw new Error(
          `Failed to update document: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }

      Logger.info(
        `Successfully updated ${fields} in schema ${schema} for document ${docId}.`,
      )
    } catch (error) {
      const errMessage = getErrorMessage(error)
      Logger.error(
        error,
        `Error updating ${fields} in schema ${schema} for document ${docId}:`,
        errMessage,
      )
      throw new Error(
        `Error updating ${fields} in schema ${schema} for document ${docId}: ${errMessage}`,
      )
    }
  }

  async deleteDocument(
    options: VespaConfigValues & { docId: string },
  ): Promise<void> {
    const { docId, namespace, schema } = options
    const url = `${this.vespaEndpoint}/document/v1/${namespace}/${schema}/docid/${docId}`
    try {
      const response = await this.fetchWithRetry(url, {
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
      Logger.error(error, `Error deleting document ${docId}:  ${errMessage}`)
      throw new Error(`Error deleting document ${docId}:  ${errMessage}`)
    }
  }

  async ifDocumentsExistInChatContainer(
    docIds: string[],
  ): Promise<
    Record<
      string,
      { exists: boolean; updatedAt: number | null; permissions: string[] }
    >
  > {
    // If no docIds are provided, return an empty record
    if (!docIds.length) {
      return {}
    }

    // Set a reasonable batch size for each query
    const BATCH_SIZE = 500
    let existenceMap: Record<
      string,
      { exists: boolean; updatedAt: number | null; permissions: string[] }
    > = {}

    // Process docIds in batches
    for (let i = 0; i < docIds.length; i += BATCH_SIZE) {
      const batchDocIds = docIds.slice(i, i + BATCH_SIZE)
      Logger.info(
        `Processing batch ${Math.floor(i / BATCH_SIZE) + 1} with ${batchDocIds.length} document IDs`,
      )

      // Construct the YQL query for this batch
      const yqlIds = batchDocIds.map((id) => `"${id}"`).join(", ")
      const yqlQuery = `select docId, updatedAt, permissions from chat_container where docId in (${yqlIds})`
      const url = `${this.vespaEndpoint}/search/`

      try {
        const payload = {
          yql: yqlQuery,
          hits: batchDocIds.length,
          maxHits: batchDocIds.length + 1,
        }

        const response = await this.fetchWithRetry(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        })

        if (!response.ok) {
          const errorText = response.statusText
          throw new Error(
            `Search query failed: ${response.status} ${response.statusText} - ${errorText}`,
          )
        }

        const result = await response.json()

        // Extract found documents with their docId, updatedAt, and permissions
        const foundDocs =
          result.root?.children?.map((hit: any) => ({
            docId: hit.fields.docId as string,
            updatedAt: hit.fields.updatedAt as number | undefined,
            permissions: hit.fields.permissions as string[] | undefined,
          })) || []

        // Add to the result map for this batch
        const batchExistenceMap = batchDocIds.reduce(
          (acc, id) => {
            const foundDoc = foundDocs.find(
              (doc: { docId: string }) => doc.docId === id,
            )
            acc[id] = {
              exists: !!foundDoc,
              updatedAt: foundDoc?.updatedAt ?? null,
              permissions: foundDoc?.permissions ?? [], // Empty array if not found or no permissions
            }
            return acc
          },
          {} as Record<
            string,
            { exists: boolean; updatedAt: number | null; permissions: string[] }
          >,
        )

        // Merge the batch results into the overall map
        existenceMap = { ...existenceMap, ...batchExistenceMap }
      } catch (error) {
        const errMessage = getErrorMessage(error)
        Logger.error(
          error,
          `Error checking batch of chat container documents existence: ${errMessage}`,
        )
        throw error
      }
    }

    return existenceMap
  }
  // TODO: Add pagination if docId's are more than
  // max hits and merge the finaly Record
  async ifDocumentsExist(
    docIds: string[],
  ): Promise<Record<string, { exists: boolean; updatedAt: number | null }>> {
    // Construct the YQL query
    const yqlIds = docIds.map((id) => `"${id}"`).join(", ")
    const yqlQuery = `select docId, updatedAt from sources * where docId in (${yqlIds})`
    const url = `${this.vespaEndpoint}/search/`

    try {
      const payload = {
        yql: yqlQuery,
        hits: docIds.length,
        maxHits: docIds.length + 1,
      }

      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorText = response.statusText
        throw new Error(
          `Search query failed: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }

      const result = await response.json()

      // Extract found documents with their docId and updatedAt
      const foundDocs =
        result.root?.children?.map((hit: any) => ({
          docId: hit.fields.docId as string,
          updatedAt: hit.fields.updatedAt as number | undefined, // undefined if not present
        })) || []

      // Build the result map
      const existenceMap = docIds.reduce(
        (acc, id) => {
          const foundDoc = foundDocs.find(
            (doc: { docId: string }) => doc.docId === id,
          )
          acc[id] = {
            exists: !!foundDoc,
            updatedAt: foundDoc?.updatedAt ?? null, // null if not found or no updatedAt
          }
          return acc
        },
        {} as Record<string, { exists: boolean; updatedAt: number | null }>,
      )

      return existenceMap
    } catch (error) {
      const errMessage = getErrorMessage(error)
      Logger.error(error, `Error checking documents existence:  ${errMessage}`)
      throw error
    }
  }

  async ifDocumentsExistInSchema(
    schema: string,
    docIds: string[],
  ): Promise<Record<string, { exists: boolean; updatedAt: number | null }>> {
    // Construct the YQL query
    const yqlIds = docIds.map((id) => `"${id}"`).join(", ")
    const yqlQuery = `select docId, updatedAt from sources ${schema} where docId in (${yqlIds})`

    const url = `${this.vespaEndpoint}/search/?yql=${encodeURIComponent(yqlQuery)}&hits=${docIds.length}`

    try {
      const response = await this.fetchWithRetry(url, {
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

      // Extract found documents with their docId and updatedAt
      const foundDocs =
        result.root?.children?.map((hit: any) => ({
          docId: hit.fields.docId as string,
          updatedAt: hit.fields.updatedAt as number | undefined, // undefined if not present
        })) || []

      // Build the result map
      const existenceMap = docIds.reduce(
        (acc, id) => {
          const foundDoc = foundDocs.find(
            (doc: { docId: string }) => doc.docId === id,
          )
          acc[id] = {
            exists: !!foundDoc,
            updatedAt: foundDoc?.updatedAt ?? null, // null if not found or no updatedAt
          }
          return acc
        },
        {} as Record<string, { exists: boolean; updatedAt: number | null }>,
      )

      return existenceMap
    } catch (error) {
      const errMessage = getErrorMessage(error)
      Logger.error(error, `Error checking documents existence:  ${errMessage}`)
      throw error
    }
  }

  async getUsersByNamesAndEmails<T>(payload: T) {
    try {
      const response = await this.fetchWithRetry(
        `${this.vespaEndpoint}/search/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      )

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
      Logger.error(error, `Error searching users: ${error}`)
      throw error
    }
  }

  async getItems<T>(payload: T) {
    try {
      const response: Response = await this.fetchWithRetry(
        `${this.vespaEndpoint}/search/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      )

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
      Logger.error(error, `Error fetching items: ${errMessage}`)
      throw new Error(`Error fetching items: ${errMessage}`)
    }
  }
  /**
   * Get all documents where a specific field exists
   * @param fieldName The name of the field that should exist
   * @param options Configuration for Vespa
   * @param limit Optional maximum number of results to return (default: 100)
   * @param offset Optional offset for pagination (default: 0)
   * @returns The search response containing matching documents
   */
  async getDocumentsWithField(
    fieldName: string,
    options: VespaConfigValues,
    limit: number = 100,
    offset: number = 0,
  ): Promise<VespaSearchResponse> {
    const { namespace, schema, cluster } = options

    const yqlQuery = `select * from sources ${schema} where ${fieldName} matches "."`

    // Construct the search payload - using "unranked" profile to just fetch without scoring
    const searchPayload = {
      yql: yqlQuery,
      "ranking.profile": "unranked",
      timeout: "5s",
      hits: limit,
      offset,
      maxOffset: 1000000,
    }

    if (cluster) {
      // @ts-ignore
      searchPayload.cluster = cluster
    }

    try {
      const response = await this.search<VespaSearchResponse>(searchPayload)

      return response
    } catch (error) {
      const errMessage = getErrorMessage(error)
      Logger.error(
        error,
        `Error retrieving documents with field ${fieldName}: ${errMessage}`,
      )
      throw new Error(
        `Error retrieving documents with field ${fieldName}: ${errMessage}`,
      )
    }
  }

  /**
   * Fetches a single random document from a specific schema using the Document V1 API.
   */
  async getRandomDocument(
    namespace: string,
    schema: string,
    cluster: string,
  ): Promise<any | null> {
    // Returning any for now, structure is { documents: [{ id: string, fields: ... }] }
    const url = `${this.vespaEndpoint}/document/v1/${namespace}/${schema}/docid?selection=true&wantedDocumentCount=100&cluster=${cluster}` // Fetch 100 docs
    Logger.debug(`Fetching 100 random documents from: ${url}`)
    try {
      const response = await this.fetchWithRetry(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      })

      if (!response.ok) {
        const errorText = response.statusText
        const errorBody = await response.text()
        Logger.error(`Vespa error fetching random document: ${errorBody}`)
        throw new Error(
          `Failed to fetch random document: ${response.status} ${response.statusText} - ${errorBody}`,
        )
      }

      const data = await response.json()
      const docs = data?.documents // Get the array of documents

      // Check if the documents array exists and is not empty
      if (!docs || docs.length === 0) {
        Logger.warn(
          { responseData: data },
          "Did not find any documents in random sampling response (requested 100)",
        )
        return null
      }

      // Randomly select one document from the list
      const randomIndex = Math.floor(Math.random() * docs.length)
      const selectedDoc = docs[randomIndex]

      Logger.debug(
        {
          selectedIndex: randomIndex,
          totalDocs: docs.length,
          selectedDocId: selectedDoc?.id,
        },
        "Randomly selected one document from the fetched list",
      )

      return selectedDoc // Return the randomly selected document object { id, fields }
    } catch (error) {
      const errMessage = getErrorMessage(error)
      Logger.error(error, `Error fetching random document: ${errMessage}`)
      // Rethrow or wrap the error as needed
      throw new Error(`Error fetching random document: ${errMessage}`)
    }
  }
}

export default VespaClient
