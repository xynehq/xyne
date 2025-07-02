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
import {
  chatContainerSchema,
  chatMessageSchema,
  chatUserSchema,
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

  constructor(endpoint?: string) {
    this.maxRetries = config.vespaMaxRetryAttempts || 3
    this.retryDelay = config.vespaRetryDelay || 1000 // milliseconds
    this.vespaEndpoint = endpoint || `http://${config.vespaBaseHost}:8080`
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
        Logger.error(
          `Vespa search failed - Status: ${response.status}, StatusText: ${errorText}`,
        )
        Logger.error(`Vespa error body: ${errorBody}`)
        throw new Error(
          `Failed to fetch documents in searchVespa: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }

      const result = await response.json()
      return result
    } catch (error: any) {
      Logger.error(`VespaClient.search error:`, error)
      throw new Error(`Vespa search error: ${error.message}`)
    }
  }
  private async fetchDocumentBatch(
    schema: VespaSchema,
    options: VespaConfigValues,
    limit: number,
    offset: number,
    email: string,
  ): Promise<any[]> {
    const yqlQuery = `select * from sources ${schema} where true`
    const searchPayload = {
      yql: yqlQuery,
      hits: limit,
      offset,
      timeout: "10s",
    }

    const response = await this.search<VespaSearchResponse>(searchPayload)
    return (response.root?.children || []).map((doc) => {
      // Use optional chaining and nullish coalescing to safely extract fields
      const { matchfeatures, ...fieldsWithoutMatch } = doc.fields as any
      return fieldsWithoutMatch
    })
  }

  async getAllDocumentsParallel(
    schema: VespaSchema,
    options: VespaConfigValues,
    concurrency: number = 3,
    email: string,
  ): Promise<any[]> {
    // First get document count
    const countResponse = await this.getDocumentCount(schema, options, email)
    const totalCount = countResponse?.root?.fields?.totalCount || 0

    if (totalCount === 0) return []

    // Calculate optimal batch size and create batch tasks
    const batchSize = 350
    const tasks = []

    for (let offset = 0; offset < totalCount; offset += batchSize) {
      tasks.push(() =>
        this.fetchDocumentBatch(schema, options, batchSize, offset, email),
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
        Logger.info(`Document ${document.docId} inserted successfully`)
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
        const errorBody = await response.text()
        Logger.error(
          `AutoComplete failed - Status: ${response.status}, StatusText: ${errorText}`,
        )
        Logger.error(`AutoComplete error body: ${errorBody}`)
        throw new Error(
          `Failed to perform autocomplete search: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }

      const data = await response.json()
      return data
    } catch (error) {
      Logger.error(`VespaClient.autoComplete error:`, error)
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

  async getDocumentCount(
    schema: VespaSchema,
    options: VespaConfigValues,
    email: string,
  ) {
    try {
      // Encode the YQL query to ensure it's URL-safe
      const yql = encodeURIComponent(
        `select * from sources ${schema} where uploadedBy contains '${email}'`,
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
    options: VespaConfigValues & { docIds: string[]; generateAnswerSpan: Span },
  ): Promise<VespaSearchResponse> {
    const { docIds, generateAnswerSpan } = options
    const yqlIds = docIds.map((id) => `docId contains '${id}'`).join(" or ")
    const yqlMailIds = docIds
      .map((id) => `mailId contains '${id}'`)
      .join(" or ")
    const yqlQuery = `select * from sources * where (${yqlIds}) or (${yqlMailIds})`
    const url = `${this.vespaEndpoint}/search/`

    try {
      const payload = {
        yql: yqlQuery,
        hits: docIds?.length,
        maxHits: docIds?.length,
      }

      generateAnswerSpan.setAttribute("vespaPayload", JSON.stringify(payload))

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
    const { docId, namespace, schema } = options // Extract namespace and schema again
    const url = `${this.vespaEndpoint}/document/v1/${namespace}/${schema}/docid/${docId}` // Revert to original URL construction
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

  async ifMailDocumentsExist(mailIds: string[]): Promise<
    Record<
      string,
      {
        docId: string
        exists: boolean
        updatedAt: number | null
        userMap: Record<string, string>
      }
    >
  > {
    // Construct the YQL query
    const yqlIds = mailIds.map((id) => `"${id}"`).join(", ")
    const yqlQuery = `select docId, mailId, updatedAt,userMap from sources mail where mailId in (${yqlIds})`
    const url = `${this.vespaEndpoint}/search/`

    try {
      const payload = {
        yql: yqlQuery,
        hits: mailIds.length,
        maxHits: mailIds.length + 1,
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
      // Extract found documents with their mailId and updatedAt
      const foundDocs =
        result.root?.children?.map((hit: any) => ({
          docId: hit.fields?.docId as string, // fixed typo: fields, not field
          mailId: hit.fields?.mailId as string,
          updatedAt: hit.fields?.updatedAt as number | undefined,
          userMap: hit.fields?.userMap as Record<string, string>, // undefined if not present
        })) || []

      // Build the result map using original mailIds as keys
      const existenceMap = mailIds.reduce(
        (acc, id) => {
          const cleanedId = id.replace(/<(.*?)>/, "$1")
          const foundDoc = foundDocs.find(
            (doc: { mailId: string }) => doc.mailId === cleanedId,
          )
          acc[id] = {
            docId: foundDoc?.docId ?? "",
            exists: !!foundDoc,
            updatedAt: foundDoc?.updatedAt ?? null,
            userMap: foundDoc?.userMap, // null if not found or no updatedAt
          }
          return acc
        },
        {} as Record<
          string,
          {
            docId: string
            exists: boolean
            updatedAt: number | null
            userMap: Record<string, string>
          }
        >,
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

  async ifMailDocExist(email: string, docId: string): Promise<boolean> {
    // Construct the YQL query using userMap with sameElement
    const yqlQuery = `select docId from mail where userMap contains sameElement(key contains "${email}", value contains "${docId}")`

    const url = `${this.vespaEndpoint}/search/?yql=${encodeURIComponent(yqlQuery)}&hits=1`

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

      // Check if document exists
      return !!result.root?.children?.[0]
    } catch (error) {
      const errMessage = getErrorMessage(error)
      Logger.error(error, `Error checking documents existence: ${errMessage}`)
      throw error
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

  async getDocumentsBythreadId(
    threadId: string[],
  ): Promise<VespaSearchResponse> {
    const yqlIds = threadId
      .map((id) => `threadId contains '${id}'`)
      .join(" or ")
    const yqlQuery = `select * from sources ${chatMessageSchema} where (${yqlIds})`
    const url = `${this.vespaEndpoint}/search/`
    try {
      const payload = {
        yql: yqlQuery,
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
      throw new Error(`Error fetching documents with threadId: ${errMessage}`)
    }
  }

  async getEmailsByThreadIds(
    threadIds: string[],
    email: string,
  ): Promise<VespaSearchResponse> {
    const yqlIds = threadIds
      .map((id) => `threadId contains '${id}'`)
      .join(" or ")
    // Include permissions check to ensure user has access to these emails
    const yqlQuery = `select * from sources mail where (${yqlIds}) and permissions contains @email`
    const url = `${this.vespaEndpoint}/search/`
    console.log(`getEmailsByThreadIds - YQL Query: ${yqlQuery}`)
    try {
      const payload = {
        yql: yqlQuery,
        email: email, // Pass the user's email for permissions check
        hits: 200, // Increased limit to fetch more thread emails
        "ranking.profile": "unranked", // Use unranked for simple retrieval
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
        const errorBody = await response.text()
        Logger.error(
          `getEmailsByThreadIds - Query failed: ${response.status} ${response.statusText} - ${errorBody}`
        )
        throw new Error(
          `Search query failed: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }

      const result = await response.json()
      
      Logger.info(
        `getEmailsByThreadIds - Results: ${result?.root?.children?.length || 0} emails found for threadIds: ${JSON.stringify(threadIds)}`
      )
      
      return result
    } catch (error) {
      const errMessage = getErrorMessage(error)
      Logger.error(
        `getEmailsByThreadIds - Error: ${errMessage} for threadIds: ${JSON.stringify(threadIds)}`
      )
      throw new Error(`Error fetching emails by threadIds: ${errMessage}`)
    }
  }

  async getChatUserByEmail(email: string): Promise<VespaSearchResponse> {
    const yqlQuery = `select docId from sources ${chatUserSchema} where email contains '${email}'`
    const url = `${this.vespaEndpoint}/search/`
    try {
      const payload = {
        yql: yqlQuery,
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
      throw new Error(`Error fetching user with email ${email}: ${errMessage}`)
    }
  }

  async getChatContainerIdByChannelName(
    channelName: string,
  ): Promise<VespaSearchResponse> {
    const yqlQuery = `select docId from sources ${chatContainerSchema} where name contains '${channelName}'`
    const url = `${this.vespaEndpoint}/search/`
    try {
      const payload = {
        yql: yqlQuery,
      }
      console.log(yqlQuery)

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
      throw new Error(
        `Error fetching channelId with channel name ${channelName}: ${errMessage}`,
      )
    }
  }
}

export default VespaClient
