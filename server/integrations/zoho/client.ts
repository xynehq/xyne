import axios, { type AxiosInstance, type AxiosError } from "axios"
import querystring from "querystring"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type {
  ZohoTokenResponse,
  ZohoTicket,
  ZohoThread,
  ZohoAttachment,
  ZohoTicketListResponse,
  ZohoThreadListResponse,
  ZohoCommentListResponse,
  ZohoDeskConfig,
  ZohoIngestionOptions,
  ZohoErrorResponse,
} from "./types"

const logger = getLogger(Subsystem.Integrations).child({
  module: "zoho-client",
})

export class ZohoDeskClient {
  private config: ZohoDeskConfig
  private accessToken: string | null = null
  private tokenExpiresAt: number | null = null
  private apiClient: AxiosInstance
  private accountsClient: AxiosInstance

  // Rate limiting: 2 second delay between API calls
  private static lastApiCallTime: number = 0
  private static readonly API_DELAY_MS = 2000 // 2 seconds between calls

  // Global token refresh mutex to prevent concurrent refresh requests
  private static globalAccessToken: string | null = null
  private static globalTokenExpiresAt: number | null = null
  private static ongoingRefresh: Promise<string> | null = null

  constructor(config: ZohoDeskConfig) {
    this.config = {
      apiDomain: "desk.zoho.com",
      accountsDomain: "accounts.zoho.com",
      ...config,
    }

    // API client for Zoho Desk API
    this.apiClient = axios.create({
      baseURL: `https://${this.config.apiDomain}/api/v1`,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
      },
    })

    // Accounts client for OAuth
    this.accountsClient = axios.create({
      baseURL: `https://${this.config.accountsDomain}/oauth/v2`,
      timeout: 30000, // 30 seconds for OAuth token refresh (Zoho can be slow)
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    })

    // Add response interceptor for error handling
    this.apiClient.interceptors.response.use(
      (response) => response,
      (error: AxiosError<ZohoErrorResponse>) => {
        if (error.response) {
          logger.error("Zoho API error", {
            status: error.response.status,
            errorCode: error.response.data?.errorCode,
            message: error.response.data?.message,
            url: error.config?.url,
          })
        }
        throw error
      },
    )
  }

  /**
   * Refresh the access token using the refresh token
   * Uses a global mutex to prevent concurrent refresh requests across all instances
   */
  async refreshAccessToken(): Promise<string> {
    // If there's an ongoing refresh, wait for it instead of starting a new one
    if (ZohoDeskClient.ongoingRefresh) {
      logger.info(
        "⏳ Token refresh API call already in progress, waiting for it to complete (no duplicate API call)",
      )
      try {
        const token = await ZohoDeskClient.ongoingRefresh
        this.accessToken = token
        this.tokenExpiresAt = ZohoDeskClient.globalTokenExpiresAt
        logger.info("✅ Reused token from ongoing refresh (no API call made)", {
          tokenLength: token.length,
        })
        return token
      } catch (error) {
        // If ongoing refresh failed, we'll try again
        logger.warn("⚠️ Ongoing refresh failed, will retry", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Check if we have a valid global token
    if (
      ZohoDeskClient.globalAccessToken &&
      ZohoDeskClient.globalTokenExpiresAt &&
      ZohoDeskClient.globalTokenExpiresAt > Date.now()
    ) {
      logger.debug(
        "✅ Reusing valid global access token (no API call needed)",
        {
          expiresIn:
            Math.floor(
              (ZohoDeskClient.globalTokenExpiresAt - Date.now()) / 1000,
            ) + "s",
          tokenLength: ZohoDeskClient.globalAccessToken.length,
        },
      )
      this.accessToken = ZohoDeskClient.globalAccessToken
      this.tokenExpiresAt = ZohoDeskClient.globalTokenExpiresAt
      return ZohoDeskClient.globalAccessToken
    }

    // Start a new refresh and store it globally
    logger.info("🔄 No valid global token found - calling Zoho token API", {
      hasRefreshToken: !!this.config.refreshToken,
      hasClientId: !!this.config.clientId,
      hasClientSecret: !!this.config.clientSecret,
      refreshTokenLength: this.config.refreshToken?.length,
    })

    const refreshPromise = (async () => {
      try {
        const tokenData = {
          grant_type: "refresh_token",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: this.config.refreshToken,
        }

        console.log("\n🔑 ZOHO TOKEN REFRESH: Calling Zoho OAuth API")
        console.log(
          `   Endpoint: https://${this.config.accountsDomain}/oauth/v2/token`,
        )
        console.log(`   Timeout: 30 seconds`)
        console.log(
          `   Client ID: ${this.config.clientId?.substring(0, 20)}...`,
        )
        console.log("")

        const response = await this.accountsClient.post<ZohoTokenResponse>(
          "/token",
          querystring.stringify(tokenData),
        )

        console.log("\n✅ ZOHO TOKEN REFRESH: Received response from Zoho")
        console.log(`   Status: ${response.status} ${response.statusText}`)
        console.log(`   Has access_token: ${!!response.data?.access_token}`)
        console.log("")

        // Log full response to see what Zoho actually returns
        logger.info("📥 Received Zoho token response", {
          status: response.status,
          statusText: response.statusText,
          hasData: !!response.data,
          responseDataType: typeof response.data,
          responseData: response.data, // Log FULL response
        })

        // Check for error in response
        if ((response.data as any)?.error) {
          logger.error("❌ Zoho API returned error in response!", {
            error: (response.data as any).error,
            errorDescription: (response.data as any).error_description,
            fullResponse: response.data,
          })
          throw new Error(
            `Zoho API error: ${(response.data as any).error} - ${(response.data as any).error_description || "No description"}`,
          )
        }

        if (!response.data?.access_token) {
          logger.error("❌ Zoho API returned NO access_token!", {
            responseData: JSON.stringify(response.data),
            responseKeys: Object.keys(response.data || {}),
            hasAccessToken: !!response.data?.access_token,
          })
          throw new Error("Zoho API did not return an access_token")
        }

        const accessToken = response.data.access_token
        const expiresIn = response.data.expires_in || 3600
        const expiresAt = Date.now() + expiresIn * 1000

        // Update global token
        ZohoDeskClient.globalAccessToken = accessToken
        ZohoDeskClient.globalTokenExpiresAt = expiresAt

        // Update instance token
        this.accessToken = accessToken
        this.tokenExpiresAt = expiresAt

        logger.info(
          "✅ Zoho access token refreshed via API and stored globally for reuse",
          {
            expiresIn: expiresIn + "s",
            tokenLength: accessToken.length,
            message:
              "All subsequent requests will reuse this token without API calls",
          },
        )

        return accessToken
      } catch (error) {
        console.log("\n❌ ZOHO TOKEN REFRESH: Failed to refresh access token")
        console.log("=".repeat(80))
        console.log(
          `   Error Type: ${error instanceof Error ? error.constructor.name : typeof error}`,
        )
        console.log(
          `   Error Message: ${error instanceof Error ? error.message : String(error)}`,
        )
        if (error instanceof Error && error.stack) {
          console.log(`   Stack Trace:\n${error.stack}`)
        }
        console.log("=".repeat(80))
        console.log("")

        logger.error("❌ Failed to refresh Zoho access token", {
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        })
        throw new Error(`Failed to refresh Zoho access token: ${error}`)
      } finally {
        // Clear the ongoing refresh promise
        ZohoDeskClient.ongoingRefresh = null
      }
    })()

    // Store the ongoing refresh
    ZohoDeskClient.ongoingRefresh = refreshPromise

    return refreshPromise
  }

  /**
   * Apply rate limiting delay between API calls
   */
  private async applyRateLimit(): Promise<void> {
    const now = Date.now()
    const timeSinceLastCall = now - ZohoDeskClient.lastApiCallTime

    if (timeSinceLastCall < ZohoDeskClient.API_DELAY_MS) {
      const delay = ZohoDeskClient.API_DELAY_MS - timeSinceLastCall
      logger.debug(`Rate limiting: waiting ${delay}ms`)
      await this.sleep(delay)
    }

    ZohoDeskClient.lastApiCallTime = Date.now()
  }

  /**
   * Make an authenticated API request
   */
  private async makeRequest<T>(
    method: string,
    endpoint: string,
    params?: any,
    retries = 3,
  ): Promise<T> {
    // Ensure we have a token for first request
    if (!this.accessToken) {
      logger.debug(
        "🔑 Instance has no token yet, checking for global token or refreshing",
        {
          endpoint,
        },
      )
      await this.refreshAccessToken()
      logger.debug("✅ Token obtained", {
        tokenLength: this.accessToken?.length,
      })
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        logger.debug("🔵 Before rate limiting", {
          endpoint,
          attempt,
          tokenExists: !!this.accessToken,
          tokenLength: this.accessToken?.length,
        })

        // Apply rate limiting before each API call
        await this.applyRateLimit()

        logger.debug("🟢 After rate limiting", {
          endpoint,
          attempt,
          tokenExists: !!this.accessToken,
          tokenLength: this.accessToken?.length,
        })

        // Verify token still exists after rate limiting
        if (!this.accessToken) {
          logger.error(
            "❌ Token disappeared after rate limiting! Refreshing again...",
            {
              endpoint,
              attempt,
            },
          )
          await this.refreshAccessToken()
          logger.info("✅ After emergency refresh:", {
            tokenExists: !!this.accessToken,
            tokenLength: this.accessToken?.length,
          })
        }

        // Get token (should exist now)
        const token = this.accessToken!

        logger.debug("🚀 Making API request", {
          endpoint,
          attempt,
          tokenLength: token?.length,
          tokenPreview: token ? token.substring(0, 20) + "..." : "undefined",
        })

        const response = await this.apiClient.request<T>({
          method,
          url: endpoint,
          params,
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
          },
        })

        return response.data
      } catch (error: any) {
        const status = error.response?.status

        // Rate limit handling (HTTP 429)
        if (status === 429) {
          const retryAfter = parseInt(
            error.response.headers["retry-after"] || "60",
          )
          logger.warn(`⚠️ Rate limited, retrying after ${retryAfter}s`, {
            endpoint,
            attempt,
          })
          await this.sleep(retryAfter * 1000)
          continue
        }

        // Token expired (HTTP 401) - only refresh on actual 401 error
        if (status === 401 && attempt < retries) {
          logger.warn("⚠️ Token expired, refreshing and retrying", {
            endpoint,
            attempt,
          })
          await this.refreshAccessToken()
          continue // Next attempt will use the new token
        }

        // Retry on server errors (5xx)
        if (status >= 500 && attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000)
          logger.warn(`⚠️ Server error, retrying after ${delay}ms`, {
            endpoint,
            status,
            attempt,
          })
          await this.sleep(delay)
          continue
        }

        // No more retries
        throw error
      }
    }

    throw new Error(`Max retries exceeded for ${endpoint}`)
  }

  /**
   * Fetch tickets with optional filters
   */
  async fetchTickets(
    options: ZohoIngestionOptions = {},
  ): Promise<ZohoTicketListResponse> {
    const params: any = {
      limit: Math.min(options.limit || 100, 100), // Max 100 per Zoho API
      sortBy: "-modifiedTime", // Sort by modified time descending (newest first)
    }

    if (options.from) {
      params.from = options.from
    }

    if (options.departmentId) {
      params.departmentId = options.departmentId
    }

    logger.info("Fetching Zoho tickets", params)

    return this.makeRequest<ZohoTicketListResponse>("GET", "/tickets", params)
  }

  /**
   * Fetch a single ticket by ID with full details
   */
  async fetchTicketById(ticketId: string): Promise<ZohoTicket> {
    logger.info("Fetching Zoho ticket by ID", { ticketId })

    const params = {
      include: "contacts,products,departments,team,assignee,isRead",
    }

    const response = await this.makeRequest<ZohoTicket>(
      "GET",
      `/tickets/${ticketId}`,
      params,
    )

    // Log the response structure to debug
    logger.info(
      {
        ticketId,
        hasResponse: !!response,
        responseType: typeof response,
        hasTicketNumber: !!(response as any)?.ticketNumber,
        ticketNumber: (response as any)?.ticketNumber,
        responseKeys: response ? Object.keys(response).slice(0, 10) : [], // First 10 keys only
      },
      "📥 Received ticket response from Zoho",
    )

    return response
  }

  /**
   * Fetch threads for a ticket
   */
  async fetchThreads(
    ticketId: string,
    limit = 100,
    from = 1,
  ): Promise<ZohoThreadListResponse> {
    const params = {
      limit: Math.min(limit, 100),
      from,
    }

    logger.info("Fetching threads for ticket", { ticketId, limit, from })

    const response = await this.makeRequest<ZohoThreadListResponse>(
      "GET",
      `/tickets/${ticketId}/threads`,
      params,
    )

    logger.info(
      {
        ticketId,
        from,
        hasResponse: !!response,
        hasData: !!(response as any)?.data,
        dataLength: (response as any)?.data?.length,
      },
      "📥 Received threads response from Zoho",
    )

    return response
  }

  /**
   * Fetch a single thread by ID with full content
   */
  async fetchThreadById(
    ticketId: string,
    threadId: string,
  ): Promise<ZohoThread> {
    const params = {
      include: "plainText", // Include full plain text content
    }

    logger.info("Fetching thread details", { ticketId, threadId })

    const response = await this.makeRequest<ZohoThread>(
      "GET",
      `/tickets/${ticketId}/threads/${threadId}`,
      params,
    )

    return response
  }

  /**
   * Fetch all threads for a ticket with full content (makes individual API calls)
   */
  async fetchAllThreads(ticketId: string): Promise<ZohoThread[]> {
    // Step 1: Get list of thread IDs from list API
    const threadsList: ZohoThread[] = []
    let from = 1
    const limit = 100

    while (true) {
      const response = await this.fetchThreads(ticketId, limit, from)

      if (!response.data || response.data.length === 0) {
        break
      }

      threadsList.push(...response.data)

      // Check if we've fetched all threads
      if (response.data.length < limit) {
        break
      }

      from += limit
    }

    logger.info(
      "📋 Fetched thread list, now fetching full content for each thread",
      {
        ticketId,
        threadCount: threadsList.length,
      },
    )

    // Step 2: Fetch each thread individually to get full content
    const fullThreads: ZohoThread[] = []
    for (let i = 0; i < threadsList.length; i++) {
      const thread = threadsList[i]
      try {
        logger.info(
          `📥 Fetching individual thread ${i + 1}/${threadsList.length}`,
          {
            ticketId,
            threadId: thread.id,
          },
        )
        const fullThread = await this.fetchThreadById(ticketId, thread.id)

        logger.info(`✅ Fetched thread with full content`, {
          ticketId,
          threadId: thread.id,
          hasPlainText: !!fullThread.plainText,
          plainTextLength: fullThread.plainText?.length || 0,
          hasContent: !!fullThread.content,
          hasSummary: !!fullThread.summary,
          summaryLength: fullThread.summary?.length || 0,
        })

        fullThreads.push(fullThread)
      } catch (error) {
        logger.error("❌ Failed to fetch thread details, using summary", {
          ticketId,
          threadId: thread.id,
          error: error instanceof Error ? error.message : String(error),
        })
        // Fallback to summary version if individual fetch fails
        fullThreads.push(thread)
      }
    }

    logger.info("✅ Fetched all threads with full content", {
      ticketId,
      totalThreads: fullThreads.length,
      threadsWithFullText: fullThreads.filter(
        (t) => t.plainText && t.plainText.length > 100,
      ).length,
    })

    return fullThreads
  }

  /**
   * Fetch comments for a ticket
   */
  async fetchComments(
    ticketId: string,
    limit = 100,
    from = 1,
  ): Promise<ZohoCommentListResponse> {
    const params = {
      limit: Math.min(limit, 100),
      from,
    }

    logger.info("Fetching comments for ticket", { ticketId, limit, from })

    const response = await this.makeRequest<ZohoCommentListResponse>(
      "GET",
      `/tickets/${ticketId}/comments`,
      params,
    )

    logger.info(
      {
        ticketId,
        from,
        hasResponse: !!response,
        hasData: !!(response as any)?.data,
        dataLength: (response as any)?.data?.length,
      },
      "📥 Received comments response from Zoho",
    )

    return response
  }

  /**
   * Fetch all comments for a ticket (handles pagination)
   */
  async fetchAllComments(ticketId: string): Promise<ZohoThread[]> {
    const allComments: ZohoThread[] = []
    let from = 1
    const limit = 100

    while (true) {
      const response = await this.fetchComments(ticketId, limit, from)

      if (!response.data || response.data.length === 0) {
        break
      }

      allComments.push(...response.data)

      // Check if we've fetched all comments
      if (response.data.length < limit) {
        break
      }

      from += limit
    }

    logger.info("Fetched all comments for ticket", {
      ticketId,
      totalComments: allComments.length,
    })

    return allComments
  }

  /**
   * Download an attachment
   */
  async downloadAttachment(
    ticketId: string,
    attachmentId: string,
  ): Promise<Buffer> {
    // Ensure we have a token
    if (!this.accessToken) {
      await this.refreshAccessToken()
    }

    // Apply rate limiting
    await this.applyRateLimit()

    // Verify token still exists
    if (!this.accessToken) {
      logger.error("Token disappeared! Refreshing again...")
      await this.refreshAccessToken()
    }

    logger.info("Downloading attachment", { ticketId, attachmentId })

    const response = await this.apiClient.get(
      `/tickets/${ticketId}/attachments/${attachmentId}/content`,
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${this.accessToken}`,
        },
        responseType: "arraybuffer",
      },
    )

    return Buffer.from(response.data)
  }

  /**
   * Download an attachment from a full URL
   */
  async downloadAttachmentFromUrl(url: string): Promise<Buffer> {
    // Ensure we have a token
    if (!this.accessToken) {
      await this.refreshAccessToken()
    }

    // Apply rate limiting
    await this.applyRateLimit()

    // Verify token still exists
    if (!this.accessToken) {
      logger.error("Token disappeared! Refreshing again...")
      await this.refreshAccessToken()
    }

    logger.info("Downloading attachment from URL", { url })

    const response = await this.apiClient.get(url, {
      headers: {
        Authorization: `Zoho-oauthtoken ${this.accessToken}`,
      },
      responseType: "arraybuffer",
    })

    return Buffer.from(response.data)
  }

  /**
   * Fetch ticket-level attachments
   */
  async fetchTicketAttachments(ticketId: string): Promise<ZohoAttachment[]> {
    logger.info("Fetching ticket attachments", { ticketId })

    const response = await this.makeRequest<{ data: ZohoAttachment[] }>(
      "GET",
      `/tickets/${ticketId}/attachments`,
    )

    logger.info(
      {
        ticketId,
        hasResponse: !!response,
        responseType: typeof response,
        hasData: !!(response as any)?.data,
        responseKeys: response ? Object.keys(response) : [],
        dataLength: (response as any)?.data?.length,
      },
      "📥 Received attachments response from Zoho",
    )

    return response.data || []
  }

  /**
   * Fetch user information including department
   * Used during OAuth to get the user's department for permissions
   */
  async fetchUserInfo(): Promise<{
    id: string
    email: string
    name: string
    associatedDepartmentIds: string[]
    associatedDepartments: Array<{ id: string; name: string }>
  }> {
    logger.info("Fetching Zoho user info")

    const params = {
      include: "profile,role,associatedDepartments",
    }

    const response = await this.makeRequest<any>("GET", "/myinfo", params)

    return {
      id: response.id,
      email: response.email,
      name: response.name || response.firstName + " " + response.lastName,
      associatedDepartmentIds: response.associatedDepartmentIds || [],
      associatedDepartments: response.associatedDepartments || [],
    }
  }

  /**
   * Fetch agent information by ID
   */
  async fetchAgentById(agentId: string): Promise<{
    id: string
    email: string
    name: string
  } | null> {
    try {
      logger.info("Fetching agent by ID", { agentId })

      const response = await this.makeRequest<any>("GET", `/agents/${agentId}`)

      return {
        id: response.id,
        email: response.emailId || response.email || "",
        name:
          response.name ||
          `${response.firstName || ""} ${response.lastName || ""}`.trim(),
      }
    } catch (error: any) {
      console.log("\n❌ FAILED TO FETCH AGENT - ERROR DETAILS:")
      console.log("Agent ID:", agentId)
      console.log("Status:", error.response?.status)
      console.log("Error Code:", error.response?.data?.errorCode)
      console.log("Error Message:", error.response?.data?.message)
      console.log(
        "Full Response Data:",
        JSON.stringify(error.response?.data, null, 2),
      )
      console.log("")
      logger.warn("Failed to fetch agent", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
        status: error.response?.status,
        errorCode: error.response?.data?.errorCode,
        errorMessage: error.response?.data?.message,
      })
      return null
    }
  }

  /**
   * Fetch account information by ID
   */
  async fetchAccountById(accountId: string): Promise<{
    id: string
    accountName: string
  } | null> {
    try {
      logger.info("Fetching account by ID", { accountId })

      const response = await this.makeRequest<any>(
        "GET",
        `/accounts/${accountId}`,
      )

      return {
        id: response.id,
        accountName: response.accountName || "",
      }
    } catch (error: any) {
      console.log("\n❌ FAILED TO FETCH ACCOUNT - ERROR DETAILS:")
      console.log("Account ID:", accountId)
      console.log("Status:", error.response?.status)
      console.log("Error Code:", error.response?.data?.errorCode)
      console.log("Error Message:", error.response?.data?.message)
      console.log(
        "Full Response Data:",
        JSON.stringify(error.response?.data, null, 2),
      )
      console.log("")
      logger.warn("Failed to fetch account", {
        accountId,
        error: error instanceof Error ? error.message : String(error),
        status: error.response?.status,
        errorCode: error.response?.data?.errorCode,
        errorMessage: error.response?.data?.message,
      })
      return null
    }
  }

  /**
   * Fetch product information by ID
   */
  async fetchProductById(productId: string): Promise<{
    id: string
    productName: string
  } | null> {
    try {
      logger.info("Fetching product by ID", { productId })

      const response = await this.makeRequest<any>(
        "GET",
        `/products/${productId}`,
      )

      return {
        id: response.id,
        productName: response.productName || "",
      }
    } catch (error: any) {
      console.log("\n❌ FAILED TO FETCH PRODUCT - ERROR DETAILS:")
      console.log("Product ID:", productId)
      console.log("Status:", error.response?.status)
      console.log("Error Code:", error.response?.data?.errorCode)
      console.log("Error Message:", error.response?.data?.message)
      console.log(
        "Full Response Data:",
        JSON.stringify(error.response?.data, null, 2),
      )
      console.log("")
      logger.warn("Failed to fetch product", {
        productId,
        error: error instanceof Error ? error.message : String(error),
        status: error.response?.status,
        errorCode: error.response?.data?.errorCode,
        errorMessage: error.response?.data?.message,
      })
      return null
    }
  }

  /**
   * Fetch team information by ID
   */
  async fetchTeamById(teamId: string): Promise<{
    id: string
    name: string
  } | null> {
    try {
      logger.info("Fetching team by ID", { teamId })

      const response = await this.makeRequest<any>("GET", `/teams/${teamId}`)

      return {
        id: response.id,
        name: response.name || "",
      }
    } catch (error: any) {
      console.log("\n❌ FAILED TO FETCH TEAM - ERROR DETAILS:")
      console.log("Team ID:", teamId)
      console.log("Status:", error.response?.status)
      console.log("Error Code:", error.response?.data?.errorCode)
      console.log("Error Message:", error.response?.data?.message)
      console.log(
        "Full Response Data:",
        JSON.stringify(error.response?.data, null, 2),
      )
      console.log("")
      logger.warn("Failed to fetch team", {
        teamId,
        error: error instanceof Error ? error.message : String(error),
        status: error.response?.status,
        errorCode: error.response?.data?.errorCode,
        errorMessage: error.response?.data?.message,
      })
      return null
    }
  }

  /**
   * Get the current access token
   * Returns null if no token is available yet
   */
  getAccessToken(): string | null {
    return this.accessToken
  }

  /**
   * Create a Zoho client from access token (for OAuth flow)
   * This is used when we have an access token but not a refresh token yet
   */
  static fromAccessToken(accessToken: string, orgId: string): ZohoDeskClient {
    const client = new ZohoDeskClient({
      orgId,
      clientId: "", // Not needed for access token flow
      clientSecret: "",
      refreshToken: "",
    })
    client.accessToken = accessToken
    // Set a far future expiry since we're using it immediately
    client.tokenExpiresAt = Date.now() + 3600 * 1000
    return client
  }

  /**
   * Sleep utility for rate limiting
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
