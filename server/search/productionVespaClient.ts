// Production server client for Vespa operations
// This client proxies requests to a production server instead of directly calling Vespa

export class ProductionVespaClient {
  private baseUrl: string
  private apiKey: string

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl
    this.apiKey = apiKey
  }

  // Method to update the API key
  updateApiKey(newApiKey: string): void {
    this.apiKey = newApiKey
  }

  // Helper function to safely serialize objects by removing circular references
  private safeStringify(obj: any): string {
    const seen = new WeakSet()
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular Reference]"
        }
        seen.add(value)
      }
      return value
    })
  }

  public async makeApiCall<T>(endpoint: string, payload: any): Promise<T> {
    const url = `${this.baseUrl}/api/vespa/${endpoint}`
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: this.safeStringify(payload),
      })

      const isJson = response.headers
        .get("content-type")
        ?.includes("application/json")

      if (!response.ok) {
        const errorBody = isJson ? await response.json() : await response.text()
        const errorMessage = `Production server error: ${response.status} ${response.statusText} - ${JSON.stringify(errorBody)}`

        console.error(errorMessage, `API Call failed: POST ${url}`, {
          endpoint,
        })

        throw new Error(errorMessage)
      }

      console.debug(`Production server success for ${endpoint}`)
      return (await response.json()) as T
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `Production server request failed for ${endpoint}: ${message}`,
        { endpoint, error: err },
      )
      throw new Error(
        `Production server request failed for ${endpoint}: ${message}`,
      )
    }
  }

  // Proxy method for search
  async search<T>(payload: any): Promise<T> {
    return this.makeApiCall<T>("search", payload)
  }

  // Proxy method for autocomplete
  async autoComplete(payload: any): Promise<any> {
    return this.makeApiCall<any>("autocomplete", payload)
  }

  // Proxy method for group search
  async groupSearch(payload: any): Promise<any> {
    return this.makeApiCall<any>("group-search", payload)
  }

  // Proxy method for getItems
  async getItems(payload: any): Promise<any> {
    return this.makeApiCall<any>("get-items", payload)
  }

  // Method overloads for getChatContainerIdByChannelName
  async getChatContainerIdByChannelName(channelName: string): Promise<any> {
    return this.makeApiCall<any>("chat-container-by-channel", { channelName })
  }

  // Method overloads for getChatUserByEmail
  async getChatUserByEmail(email: string): Promise<any> {
    return this.makeApiCall<any>("chat-user-by-email", { email })
  }

  // Proxy method for getDocument
  async getDocument(options: any): Promise<any> {
    return this.makeApiCall<any>("get-document", options)
  }

  // Proxy method for getDocumentsByOnlyDocIds
  async getDocumentsByOnlyDocIds(options: any): Promise<any> {
    return this.makeApiCall<any>("get-documents-by-ids", options)
  }

  // Proxy method for getUsersByNamesAndEmails
  async getUsersByNamesAndEmails(payload: any): Promise<any> {
    return this.makeApiCall<any>("get-users-by-names-and-emails", payload)
  }

  // Proxy method for getDocumentsBythreadId
  async getDocumentsBythreadId(threadIds: string[]): Promise<any> {
    return this.makeApiCall<any>("get-documents-by-thread-id", { threadIds })
  }

  // Proxy method for getEmailsByThreadIds
  async getEmailsByThreadIds(threadIds: string[], email: string): Promise<any> {
    return this.makeApiCall<any>("get-emails-by-thread-ids", {
      threadIds,
      email,
    })
  }

  // Proxy method for getDocumentsWithField
  async getDocumentsWithField(
    fieldName: string,
    options: any,
    limit: number = 100,
    offset: number = 0,
  ): Promise<any> {
    return this.makeApiCall<any>("get-documents-with-field", {
      fieldName,
      options,
      limit,
      offset,
    })
  }

  // Proxy method for getRandomDocument
  async getRandomDocument(
    namespace: string,
    schema: string,
    cluster: string,
  ): Promise<any | null> {
    return this.makeApiCall<any>("get-random-document", {
      namespace,
      schema,
      cluster,
    })
  }
}