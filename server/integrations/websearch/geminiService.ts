import { GoogleGenAI, FunctionCallingConfigMode } from "@google/genai"
import { writeFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"
import axios from "axios"
import type {
  GroundingMetadata,
  GeminiResponse,
  WebSearchRequest,
  WebSearchResult,
  UrlWithMetadata,
} from "./types.js"
import { enhanceQueryWithContext } from "./queryEnhancer.js"
import { getLogger } from "../../logger/index.js"
import { Subsystem } from "../../types.js"
import config from "../../config.js"

const Logger = getLogger(Subsystem.Search)

// Simple rate limiter implementation
class SimpleRateLimiter {
  private requests: number[] = []
  private readonly maxRequests: number
  private readonly windowMs: number

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests
    this.windowMs = windowMs
  }

  async waitForSlot(): Promise<void> {
    const now = Date.now()

    // Remove expired requests from the window
    this.requests = this.requests.filter((time) => now - time < this.windowMs)

    // If we're at the limit, wait until the oldest request expires
    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0]
      const waitTime = this.windowMs - (now - oldestRequest) + 100 // Add 100ms buffer

      if (waitTime > 0) {
        Logger.debug(`Rate limit reached, waiting ${waitTime}ms`)
        await new Promise((resolve) => setTimeout(resolve, waitTime))
        return this.waitForSlot() // Recursively check again
      }
    }

    // Record this request
    this.requests.push(now)
  }
}

// Create rate limiter instance - 8 requests per minute to be conservative
const geminiRateLimiter = new SimpleRateLimiter(8, 60 * 1000)

/**
 * Resolve redirect URLs to their actual destination URLs (optimized for speed)
 * Handles vertexaisearch.cloud.google.com and other redirect services
 */
async function resolveRedirectUrls(urls: string[]): Promise<string[]> {
  const redirectPatterns = [
    "vertexaisearch.cloud.google.com",
    "google.com/url",
    "google.com/search",
    "redirect",
    "link.medium.com",
    "t.co/",
    "bit.ly/",
    "tinyurl.com",
    "shorturl.at",
  ]

  // Process URLs concurrently for maximum speed
  const resolutionPromises = urls.map(async (url) => {
    try {
      // Check if URL needs resolution
      const needsResolution = redirectPatterns.some((pattern) =>
        url.toLowerCase().includes(pattern.toLowerCase()),
      )

      if (!needsResolution) {
        return url
      }

      Logger.debug(`Resolving redirect URL: ${url}`)

      // Try to resolve the redirect
      const resolvedUrl = await resolveRedirectUrl(url)
      if (resolvedUrl && resolvedUrl !== url) {
        Logger.debug(`Resolved ${url} -> ${resolvedUrl}`)
        return resolvedUrl
      }

      // If resolution fails, try to extract from query parameters
      const extractedUrl = extractUrlFromRedirect(url)
      if (extractedUrl && extractedUrl !== url) {
        Logger.debug(`Extracted from redirect: ${url} -> ${extractedUrl}`)
        return extractedUrl
      }

      // Keep original URL as fallback
      return url
    } catch (error) {
      Logger.warn(`Failed to resolve redirect URL ${url}: ${error}`)
      return url
    }
  })

  // Wait for all URL resolutions to complete concurrently
  const results = await Promise.allSettled(resolutionPromises)

  return results
    .map((result) => (result.status === "fulfilled" ? result.value : null))
    .filter((url): url is string => url !== null)
}

/**
 * Resolve a single redirect URL by following HTTP redirects
 */
async function resolveRedirectUrl(url: string): Promise<string> {
  try {
    const response = await axios.head(url, {
      timeout: 2000,
      maxRedirects: 5,
      validateStatus: () => true, // Accept all status codes
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; WebSearchBot/1.0)",
      },
    })

    // Return the final URL after redirects
    return response.request.res.responseUrl || url
  } catch (error: any) {
    // If HEAD fails, try GET with limited data
    try {
      const response = await axios.get(url, {
        timeout: 2000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; WebSearchBot/1.0)",
          Range: "bytes=0-1023", // Only get first 1KB to save bandwidth
        },
      })

      return response.request.res.responseUrl || url
    } catch (getError) {
      Logger.debug(`Failed to resolve redirect for ${url}: ${error.message}`)
      return url
    }
  }
}

/**
 * Extract URLs from redirect query parameters
 * Handles common redirect URL patterns
 */
function extractUrlFromRedirect(redirectUrl: string): string {
  try {
    const urlObj = new URL(redirectUrl)

    // Common query parameter names for the actual URL
    const urlParams = [
      "url",
      "q",
      "u",
      "target",
      "destination",
      "redirect",
      "link",
      "goto",
    ]

    for (const param of urlParams) {
      const value = urlObj.searchParams.get(param)
      if (value) {
        // Decode URL-encoded values
        const decodedValue = decodeURIComponent(value)

        // Validate that it's a proper URL
        try {
          new URL(decodedValue)
          return decodedValue
        } catch {
          // Try without protocol
          try {
            new URL(`https://${decodedValue}`)
            return `https://${decodedValue}`
          } catch {
            continue
          }
        }
      }
    }

    // Special handling for Google redirect URLs
    if (redirectUrl.includes("google.com/url")) {
      const qParam = urlObj.searchParams.get("q")
      if (qParam) {
        try {
          new URL(qParam)
          return qParam
        } catch {
          // Google sometimes double-encodes URLs
          try {
            const doubleDecoded = decodeURIComponent(qParam)
            new URL(doubleDecoded)
            return doubleDecoded
          } catch {
            // Continue to other methods
          }
        }
      }
    }

    // For vertexaisearch URLs, try to extract from the hash or path
    if (redirectUrl.includes("vertexaisearch.cloud.google.com")) {
      // These URLs might have the actual URL encoded in a special way
      // Log the structure for debugging
      Logger.debug(`VertexAI search redirect structure: ${redirectUrl}`)

      // Try to find URL patterns in the path or hash
      const urlMatch = redirectUrl.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/g)
      if (urlMatch && urlMatch.length > 1) {
        // Return the second match (first is usually the redirect domain)
        return urlMatch[1]
      }
    }

    return redirectUrl
  } catch (error) {
    Logger.debug(`Failed to extract URL from redirect ${redirectUrl}: ${error}`)
    return redirectUrl
  }
}

// Helper function to analyze query complexity
function analyzeQueryComplexity(
  query: string,
): "simple" | "moderate" | "complex" {
  const words = query.split(/\s+/).length
  const hasQuestions = /\?/.test(query)
  const hasComparisons =
    /\b(vs|versus|compare|comparison|difference|better|worse|against|between)\b/i.test(
      query,
    )
  const hasMultipleTopics =
    /\b(and|or|also|additionally|furthermore|moreover|besides|including)\b/i.test(
      query,
    )
  const hasTechnicalTerms =
    /\b[A-Z]{2,}|\b\w+\.(com|org|net|edu|gov)\b|\b\d{4}\b|[A-Z][a-z]+[A-Z]/.test(
      query,
    )
  const hasSpecificDemands =
    /\b(explain|analyze|detailed|comprehensive|complete|thorough|extensive|in-depth)\b/i.test(
      query,
    )
  const hasTimeReferences =
    /\b(recent|latest|current|today|yesterday|this year|2024|2025|now)\b/i.test(
      query,
    )
  const hasMultipleConcepts =
    query.split(/\b(how|what|why|when|where|which)\b/i).length > 2

  let complexityScore = 0

  // Word count scoring
  if (words > 15) complexityScore += 3
  else if (words > 8) complexityScore += 2
  else if (words > 4) complexityScore += 1

  // Feature scoring
  if (hasQuestions) complexityScore += 1
  if (hasComparisons) complexityScore += 2
  if (hasMultipleTopics) complexityScore += 2
  if (hasTechnicalTerms) complexityScore += 1
  if (hasSpecificDemands) complexityScore += 2
  if (hasTimeReferences) complexityScore += 1
  if (hasMultipleConcepts) complexityScore += 2

  // Complexity thresholds
  if (complexityScore >= 6) return "complex"
  if (complexityScore >= 3) return "moderate"
  return "simple"
}

// Ultra-fast simplified prompt generation
function generateDynamicPrompt(
  complexity: "simple" | "moderate" | "complex",
): string {
  const basePrompt =
    "Provide a comprehensive answer using multiple verified sources. Use ONLY numbered citations in square brackets like [1], [2], [3] - do NOT use asterisks or other formats."

  switch (complexity) {
    case "simple":
      return `${basePrompt} Provide 3-4 detailed paragraphs with 5-8 sources. Use numbered citations [1], [2], [3] throughout.\n\n`
    case "moderate":
      return `${basePrompt} Provide comprehensive analysis with 4-5 detailed paragraphs. Include multiple perspectives and 8-12 authoritative sources. Use numbered citations [1], [2], [3] throughout.\n\n`
    case "complex":
      return `${basePrompt} Provide detailed comprehensive analysis with 6-8 paragraphs. Include expert perspectives, case studies, and 12-20 diverse sources. Use numbered citations [1], [2], [3] throughout.\n\n`
    default:
      return `${basePrompt} Include detailed explanations with proper source attribution. Use numbered citations [1], [2], [3] format ONLY.\n\n`
  }
}

// Helper functions for cleaner code organization
async function makeGeminiRequest(
  ai: any,
  contents: any,
  timeout: number = 18000,
): Promise<any> {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(`Gemini API request timed out after ${timeout / 1000}s`),
        ),
      timeout,
    )
  })

  const apiCall = ai.models.generateContent({
    model: config.GeminiAIModel || "gemini-2.5-flash",
    contents,
    config: {
      temperature: 0.1,
      topP: 0.8,
      topK: 16, // Reduced from 32 for faster generation
      maxOutputTokens: 3000, // Reduced from 4000 for faster responses
      tools: [{ googleSearch: {} }],
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode.AUTO,
        },
      },
    },
  })

  return Promise.race([apiCall, timeoutPromise])
}

async function processGeminiResponse(response: any): Promise<{
  answer: string
  urls: string[]
  urlsWithMetadata: UrlWithMetadata[]
}> {
  const geminiResponse = response as unknown as GeminiResponse
  const candidate = geminiResponse?.candidates?.[0]
  const answer = candidate?.content?.parts?.[0]?.text || ""
  const grounding = candidate?.groundingMetadata

  Logger.debug(
    `Gemini response debug: candidates=${geminiResponse?.candidates?.length || 0}, answer_length=${answer.length}`,
  )
  if (answer.length === 0) {
    Logger.warn(
      `Empty answer from Gemini. Candidate parts: ${JSON.stringify(candidate?.content?.parts)}`,
    )
  }

  // Save grounding metadata for debugging (optional)
  if (process.env.NODE_ENV === "development" && grounding) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
      const groundingDir = join(process.cwd(), "logs", "grounding")

      // Create directory if it doesn't exist
      if (!existsSync(groundingDir)) {
        mkdirSync(groundingDir, { recursive: true })
      }

      // Clean up old files (keep only last 10 files to prevent disk bloat)
      try {
        const existingFiles = require("fs")
          .readdirSync(groundingDir)
          .filter((file: string) => file.startsWith("grounding_metadata_"))
          .sort()

        if (existingFiles.length > 10) {
          const filesToDelete = existingFiles.slice(
            0,
            existingFiles.length - 10,
          )
          filesToDelete.forEach((file: string) => {
            require("fs").unlinkSync(join(groundingDir, file))
          })
          Logger.debug(`Cleaned up ${filesToDelete.length} old grounding files`)
        }
      } catch (cleanupError) {
        Logger.warn(`Failed to cleanup old grounding files: ${cleanupError}`)
      }

      const groundingFile = join(
        groundingDir,
        `grounding_metadata_${timestamp}.json`,
      )
      writeFileSync(groundingFile, JSON.stringify(grounding, null, 2))
      Logger.debug(`Grounding metadata saved to: ${groundingFile}`)
    } catch (error) {
      Logger.warn(`Failed to save grounding metadata: ${error}`)
    }
  }

  // Extract and resolve URLs from grounding metadata
  const { urls, urlsWithMetadata } = await extractUrlsFromGrounding(grounding)

  return { answer, urls, urlsWithMetadata }
}

async function extractUrlsFromGrounding(grounding: any): Promise<{
  urls: string[]
  urlsWithMetadata: UrlWithMetadata[]
}> {
  let urls: string[] = []
  let urlsWithMetadata: UrlWithMetadata[] = []

  if (!grounding) {
    return { urls, urlsWithMetadata }
  }

  try {
    const initialUrls: string[] = []
    const urlContentMap = new Map<string, string>()

    if (grounding.groundingChunks && Array.isArray(grounding.groundingChunks)) {
      for (const chunk of grounding.groundingChunks) {
        const uri =
          chunk.web?.uri ||
          chunk.web?.url ||
          chunk.uri ||
          chunk.url ||
          chunk.webSearchResult?.uri ||
          chunk.webSearchResult?.url ||
          chunk.source?.uri ||
          chunk.source?.url

        if (uri && typeof uri === "string" && uri.length > 0) {
          initialUrls.push(uri)

          const content =
            chunk.web?.content ||
            chunk.content ||
            chunk.text ||
            chunk.webSearchResult?.content ||
            chunk.webSearchResult?.snippet ||
            chunk.source?.content

          if (content && typeof content === "string") {
            const cleanContent = content
              .replace(/\s+/g, " ")
              .replace(/\n+/g, " ")
              .trim()

            const truncatedContent =
              cleanContent.length > 150
                ? cleanContent.substring(0, 147) + "..."
                : cleanContent

            urlContentMap.set(uri, truncatedContent)
          }
        }
      }
    }

    // Resolve redirect URLs to actual source URLs
    urls = await resolveRedirectUrls(initialUrls)

    // Remove duplicates and invalid URLs
    urls = [...new Set(urls)].filter((url) => {
      try {
        new URL(url)
        return true
      } catch {
        return false
      }
    })

    Logger.debug(`Extracted ${urls.length} resolved source URLs from grounding`)

    // Create URL metadata with domain names and content
    urlsWithMetadata = urls.map((url) => {
      try {
        const urlObj = new URL(url)
        const domain = urlObj.hostname.replace("www.", "")
        const siteName = domain.split(".")[0]
        const capitalizedSiteName =
          siteName.charAt(0).toUpperCase() + siteName.slice(1)

        let content = urlContentMap.get(url)
        if (!content) {
          for (const [
            originalUrl,
            originalContent,
          ] of urlContentMap.entries()) {
            if (
              originalUrl === url ||
              url.includes(new URL(originalUrl).hostname)
            ) {
              content = originalContent
              break
            }
          }
        }

        return {
          url,
          title: capitalizedSiteName,
          siteName: capitalizedSiteName,
          content: content || undefined,
        }
      } catch {
        return {
          url,
          title: "Web Source",
          siteName: "Web Source",
          content: urlContentMap.get(url) || undefined,
        }
      }
    })

    Logger.debug(
      `Created fast domain-based metadata with content for ${urlsWithMetadata.length} URLs`,
    )
  } catch (error) {
    Logger.warn(`Failed to extract URLs from grounding: ${error}`)

    // Fallback to simple extraction
    urls =
      grounding?.groundingChunks
        ?.map((chunk: any) => chunk.web?.uri)
        .filter((uri: any): uri is string => typeof uri === "string") || []

    urlsWithMetadata = urls.map((url) => {
      try {
        const urlObj = new URL(url)
        const domain = urlObj.hostname.replace("www.", "")
        const siteName = domain.charAt(0).toUpperCase() + domain.slice(1)
        return { url, title: siteName, siteName, content: undefined }
      } catch {
        return {
          url,
          title: "Web Content",
          siteName: "Web",
          content: undefined,
        }
      }
    })
  }

  return { urls, urlsWithMetadata }
}

function isRetryableError(error: any): boolean {
  return (
    error?.message?.includes("rate limit") ||
    error?.message?.includes("quota") ||
    error?.message?.includes("429") ||
    error?.status === 429 ||
    error?.message?.includes("timeout") ||
    error?.message?.includes("timed out") ||
    error?.code === "TIMEOUT" ||
    error?.message?.includes("network") ||
    error?.message?.includes("connection") ||
    error?.code === "ENOTFOUND" ||
    error?.code === "ECONNRESET"
  )
}

function calculateRetryDelay(error: any, retryCount: number): number {
  const isRateLimit =
    error?.message?.includes("rate limit") ||
    error?.message?.includes("quota") ||
    error?.message?.includes("429") ||
    error?.status === 429

  if (isRateLimit) {
    return Math.min(5000 * Math.pow(2, retryCount), 30000)
  }

  return Math.min(1000 * Math.pow(2, retryCount), 10000) + Math.random() * 1000
}

export async function queryGeminiWithGrounding(
  userQuery: string,
  context: string = "",
  previousQuery?: string,
  previousAnswer?: string,
): Promise<{
  answer: string
  urls: string[]
  urlsWithMetadata?: UrlWithMetadata[]
}> {
  try {
    // Get API key from config system
    let apiKey = config.GeminiApiKey

    // Check if API key is properly configured
    if (!apiKey || apiKey.trim() === "" || apiKey === "undefined") {
      Logger.error("GEMINI_API_KEY is not properly configured")
      throw new Error(`GEMINI_API_KEY is not configured properly. Please:
1. Get a valid API key from Google AI Studio (https://aistudio.google.com/app/apikey)
2. Set the GEMINI_API_KEY environment variable or update the config
3. Ensure the API key has the necessary permissions for Gemini API and search grounding`)
    }

    // Quick API key validation
    if (!apiKey.startsWith("AIza") || apiKey.length < 35) {
      Logger.error(
        `Invalid API key format: starts with AIza: ${apiKey.startsWith("AIza")}, length: ${apiKey.length}`,
      )
      throw new Error(
        `Invalid GEMINI_API_KEY format. Please ensure you have a valid Google Gemini API key from https://aistudio.google.com/app/apikey`,
      )
    }

    const ai = new GoogleGenAI({
      apiKey: apiKey.trim(),
    })

    // Enhance query with context if this is a followup
    let enhancedQuery = userQuery
    if (previousQuery && previousAnswer) {
      enhancedQuery = enhanceQueryWithContext(
        userQuery,
        previousAnswer,
        previousQuery,
      )
      if (enhancedQuery !== userQuery) {
        Logger.debug(`Enhanced query: "${userQuery}" → "${enhancedQuery}"`)
      }
    }

    // Dynamic prompt based on query complexity
    const queryComplexity = analyzeQueryComplexity(enhancedQuery)
    const promptPrefix = generateDynamicPrompt(queryComplexity)

    const contents = [
      ...(context ? [{ role: "user", parts: [{ text: context }] }] : []),
      { role: "user", parts: [{ text: promptPrefix + enhancedQuery }] },
    ]

    Logger.info(`Starting Gemini web search for query: "${enhancedQuery}"`)

    // Wait for rate limiter slot
    await geminiRateLimiter.waitForSlot()

    // Simplified retry logic with proper error handling
    let retryCount = 0
    const maxRetries = 2

    while (retryCount <= maxRetries) {
      try {
        // Use extended timeout on retry after first timeout
        const timeout = retryCount === 0 ? 18000 : 25000
        const response = await makeGeminiRequest(ai, contents, timeout)

        // Process response using unified function
        const result = await processGeminiResponse(response)

        Logger.info(
          `Gemini web search completed. Found ${result.urls.length} references from grounding`,
        )
        return result
      } catch (error: any) {
        const shouldRetry = isRetryableError(error) && retryCount < maxRetries

        // Log detailed error information
        Logger.warn(
          `Gemini API error (attempt ${retryCount + 1}/${maxRetries + 1}): ${error?.message || "Unknown error"}`,
          {
            errorType: error?.message?.includes("rate limit")
              ? "rate_limit"
              : error?.message?.includes("timeout")
                ? "timeout"
                : error?.message?.includes("network")
                  ? "network"
                  : "unknown",
            errorCode: error?.code,
            errorStatus: error?.status,
            retryCount,
            query: enhancedQuery,
          },
        )

        if (shouldRetry) {
          retryCount++
          const delayMs = calculateRetryDelay(error, retryCount)
          Logger.warn(
            `Retrying in ${Math.round(delayMs)}ms (attempt ${retryCount}/${maxRetries + 1})`,
          )
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          continue
        }

        // If we've exhausted retries, throw with context but don't let it cascade as "error occurred"
        const enhancedError = new Error(
          `Web search temporarily unavailable: ${error?.message || "Unknown error"}. Please try again in a moment.`,
        )
        enhancedError.stack = error?.stack
        throw enhancedError
      }
    }

    throw new Error(
      "Web search service is temporarily unavailable. Please try again in a moment.",
    )
  } catch (error: any) {
    // **CRITICAL FIX FOR AGENTIC MODE**: Ensure errors don't show as generic "error occurred"
    Logger.error(error, `Gemini web search failed for query: "${userQuery}"`)

    // Re-throw with user-friendly message that won't trigger generic error handling
    if (error.message.includes("API key")) {
      throw new Error("Web search configuration issue. Please contact support.")
    } else if (
      error.message.includes("rate limit") ||
      error.message.includes("quota")
    ) {
      throw new Error(
        "Web search rate limit reached. Please try again in a few minutes.",
      )
    } else if (error.message.includes("timeout")) {
      throw new Error(
        "Web search request timed out. Please try a simpler query or try again later.",
      )
    } else {
      throw new Error(
        "Web search is temporarily unavailable. Please try again in a moment.",
      )
    }
  }
}

// Ultra-fast single search strategy - no multi-search delays
export async function performWebSearch(
  request: WebSearchRequest,
): Promise<WebSearchResult> {
  const {
    query,
    maxResults = 20,
    excludedUrls = [],
    previousQuery,
    previousAnswer,
    context = "",
  } = request

  try {
    const queryComplexity = analyzeQueryComplexity(query)
    Logger.debug(`Query complexity assessed as: ${queryComplexity}`)

    // **ULTRA-FAST: Single search strategy only - no multi-search delays**
    Logger.info(`Performing single ultra-fast search for query: "${query}"`)

    // Single optimized search with enhanced prompt based on complexity
    const enhancedQuery =
      queryComplexity === "complex"
        ? `Provide comprehensive detailed information with multiple reliable sources: ${query}`
        : queryComplexity === "moderate"
          ? `Provide detailed information with authoritative sources: ${query}`
          : `Provide clear information with reliable sources: ${query}`

    const {
      answer: finalAnswer,
      urls: allUrls,
      urlsWithMetadata: allUrlsWithMetadata,
    } = await queryGeminiWithGrounding(
      enhancedQuery,
      context,
      previousQuery,
      previousAnswer,
    )

    Logger.debug(
      `Single search completed with ${allUrls.length} URLs in ultra-fast mode`,
    )

    // Filter out excluded URLs
    const filteredUrls = allUrls.filter(
      (url: string) => !excludedUrls.includes(url),
    )

    if (excludedUrls.length > 0) {
      Logger.debug(
        `After excluding ${excludedUrls.length} URLs: ${filteredUrls.length} remaining`,
      )
    }

    // Dynamic result limiting based on quality and complexity
    const dynamicMaxResults = calculateDynamicMaxResults(
      queryComplexity,
      filteredUrls.length,
      maxResults,
    )
    const limitedUrls = filteredUrls.slice(0, dynamicMaxResults)

    Logger.debug(
      `Dynamic max results: ${dynamicMaxResults}, Final URLs returned: ${limitedUrls.length}`,
    )

    // **ULTRA-FAST METADATA PROCESSING: Use only grounding data, no HTTP requests**
    let urlsWithMetadata: UrlWithMetadata[] = []

    Logger.debug(
      `Creating ultra-fast metadata for ${limitedUrls.length} URLs using grounding data only`,
    )

    // Create a map from collected metadata (from grounding)
    const collectedMetadata = new Map<string, UrlWithMetadata>()
    if (allUrlsWithMetadata) {
      allUrlsWithMetadata.forEach((meta) => {
        if (meta?.url) {
          collectedMetadata.set(meta.url, meta)
        }
      })
    }

    // Create final metadata array using only domain-based fallbacks for missing data
    urlsWithMetadata = limitedUrls.map((url) => {
      const existingMeta = collectedMetadata.get(url)
      if (existingMeta) {
        return existingMeta
      }

      // Ultra-fast domain-based fallback (no HTTP requests)
      try {
        const urlObj = new URL(url)
        const domain = urlObj.hostname.replace("www.", "")
        const siteName = domain.charAt(0).toUpperCase() + domain.slice(1)
        return {
          url,
          title: siteName,
          siteName,
          content: undefined,
        }
      } catch {
        return {
          url,
          title: "Web Content",
          siteName: "Web",
          content: undefined,
        }
      }
    })

    Logger.debug(
      `Ultra-fast created metadata for ${urlsWithMetadata.length} URLs (${urlsWithMetadata.filter((u) => u.content).length} with content)`,
    )

    return {
      answer: finalAnswer,
      urls: limitedUrls,
      urlsWithMetadata,
      references: limitedUrls, // For backward compatibility
    }
  } catch (error: any) {
    Logger.error(error, `Web search failed for query: "${query}"`)

    // **CRITICAL FIX FOR AGENTIC MODE**: Re-throw user-friendly error messages
    throw error // Let the enhanced error messages from queryGeminiWithGrounding pass through
  }
}

// Helper function to calculate dynamic max results
function calculateDynamicMaxResults(
  complexity: string,
  availableUrls: number,
  requestedMax: number,
): number {
  const baseVariation = Math.floor(Math.random() * 3) + 1 // Random 1-3 for less variation

  switch (complexity) {
    case "simple":
      // Simple queries: 5-10 results (increased from 3-8)
      return Math.min(
        Math.max(5 + baseVariation, 5),
        Math.min(10, availableUrls, requestedMax),
      )
    case "moderate":
      // Moderate queries: 8-15 results (increased from 5-12)
      return Math.min(
        Math.max(8 + baseVariation * 2, 8),
        Math.min(15, availableUrls, requestedMax),
      )
    case "complex":
      // Complex queries: 12-25 results (increased from 8-20)
      return Math.min(
        Math.max(12 + baseVariation * 3, 12),
        Math.min(25, availableUrls, requestedMax),
      )
    default:
      return Math.min(requestedMax, availableUrls)
  }
}
