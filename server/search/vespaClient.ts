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
} from "@/search/types"
import { getErrorMessage } from "@/utils"
import type { AppEntityCounts } from "@/search/vespa"
import { handleVespaGroupResponse } from "@/search/mappers"
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

        // For 5xx errors or network issues, we retry it
        if (response.status >= 500 && retryCount < this.maxRetries) {
          await this.delay(this.retryDelay * Math.pow(2, retryCount)) // Exponential backoff
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

      const data = await response.json()

      if (response.ok) {
        if (document.entity === "docs") {
          console.log("\ndocument")
          console.log(document)
          console.log("document")
          Logger.info(`Document ${document.title} inserted successfully`)
        }
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

  async insert(
    document:
      | VespaUser
      | VespaFile
      | VespaMail
      | VespaEvent
      | VespaUserQueryHistory
      | VespaMailAttachment,
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

      const data = await response.json()

      if (response.ok) {
        // Logger.info(`Document ${document.docId} inserted successfully`)
      } else {
        // Using status text since response.text() return Body Already used Error
        const errorText = response.statusText
        Logger.error(
          `Error inserting document ${document.docId} for ${options.schema} ${data.message}`,
        )
        throw new Error(
          `Failed to fetch documents: ${response.status} ${response.statusText} - ${errorText}`,
        )
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
        throw new Error(
          `Failed to fetch document: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }

      const document = await response.json()
      return document
    } catch (error) {
      const errMessage = getErrorMessage(error)
      throw new Error(`Error fetching document docId: ${docId} - ${errMessage}`)
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

  async isDocumentExist(docIds: string[]): Promise<Record<string, boolean>> {
    // Construct the YQL query
    const yqlIds = docIds.map((id) => `"${id}"`).join(", ")
    const yqlQuery = `select docId from sources * where docId in (${yqlIds})`

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

      // Extract the document IDs of the found documents
      const foundIds =
        // @ts-ignore
        result.root.children?.map((hit) => hit.fields.docId) || []

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
      Logger.error(error, `Error checking documents existence:  ${errMessage}`)
      throw error
    }
  }

  async getUsersByNamesAndEmaisl<T>(payload: T) {
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
}

export default VespaClient
