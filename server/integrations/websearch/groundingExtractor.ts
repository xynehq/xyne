import axios from "axios"
import { getLogger } from "../../logger/index.js"
import { Subsystem } from "../../types.js"
import type { GroundingMetadata, UrlWithMetadata } from "./types.js"
import { extractUrlMetadataBatch } from "./urlMetadata.js"

const Logger = getLogger(Subsystem.Search)

/**
 * Extract and resolve actual source URLs from Gemini's grounding metadata
 * Handles redirect URLs like vertexaisearch.cloud.google.com redirects
 */
export async function extractSourceUrlsFromGrounding(
  grounding: GroundingMetadata,
): Promise<{
  sourceUrls: string[]
  urlsWithMetadata: UrlWithMetadata[]
}> {
  try {
    if (!grounding?.groundingChunks || grounding.groundingChunks.length === 0) {
      Logger.debug("No grounding chunks found in metadata")
      return { sourceUrls: [], urlsWithMetadata: [] }
    }

    // Extract initial URLs from grounding chunks
    const initialUrls = grounding.groundingChunks
      .map((chunk: any) => {
        // Try multiple possible paths for the URL
        return (
          chunk.web?.uri ||
          chunk.web?.url ||
          chunk.uri ||
          chunk.url ||
          chunk.webSearchResult?.uri ||
          chunk.webSearchResult?.url
        )
      })
      .filter((uri): uri is string => typeof uri === "string" && uri.length > 0)

    if (initialUrls.length === 0) {
      Logger.debug("No URIs found in grounding chunks")
      return { sourceUrls: [], urlsWithMetadata: [] }
    }

    Logger.debug(`Found ${initialUrls.length} initial URLs from grounding`)

    // Resolve redirect URLs to actual source URLs
    const resolvedUrls = await resolveRedirectUrls(initialUrls)

    // Remove duplicates and invalid URLs
    const uniqueUrls = [...new Set(resolvedUrls)].filter((url) => {
      try {
        new URL(url)
        return true
      } catch {
        return false
      }
    })

    Logger.debug(`Resolved to ${uniqueUrls.length} unique valid URLs`)

    // Extract metadata for all resolved URLs
    let urlsWithMetadata: UrlWithMetadata[] = []
    if (uniqueUrls.length > 0) {
      try {
        const metadataMap = await extractUrlMetadataBatch(uniqueUrls)
        urlsWithMetadata = uniqueUrls.map((url) => {
          const metadata = metadataMap.get(url)
          return {
            url,
            title: metadata?.title,
            siteName: metadata?.siteName,
          }
        })
        Logger.debug(
          `Successfully extracted metadata for ${urlsWithMetadata.filter((u) => u.title).length} URLs`,
        )
      } catch (error) {
        Logger.warn(`Failed to extract URL metadata: ${error}`)
        urlsWithMetadata = uniqueUrls.map((url) => ({ url }))
      }
    }

    return {
      sourceUrls: uniqueUrls,
      urlsWithMetadata,
    }
  } catch (error) {
    Logger.error(`Failed to extract source URLs from grounding: ${error}`)
    return { sourceUrls: [], urlsWithMetadata: [] }
  }
}

/**
 * Resolve redirect URLs to their actual destination URLs
 * Handles vertexaisearch.cloud.google.com and other redirect services
 */
async function resolveRedirectUrls(urls: string[]): Promise<string[]> {
  const resolvedUrls: string[] = []
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

  for (const url of urls) {
    try {
      // Check if URL needs resolution
      const needsResolution = redirectPatterns.some((pattern) =>
        url.toLowerCase().includes(pattern.toLowerCase()),
      )

      if (!needsResolution) {
        resolvedUrls.push(url)
        continue
      }

      Logger.debug(`Resolving redirect URL: ${url}`)

      // Try to resolve the redirect
      const resolvedUrl = await resolveRedirectUrl(url)
      if (resolvedUrl && resolvedUrl !== url) {
        Logger.debug(`Resolved ${url} -> ${resolvedUrl}`)
        resolvedUrls.push(resolvedUrl)
      } else {
        // If resolution fails, try to extract from query parameters
        const extractedUrl = extractUrlFromRedirect(url)
        if (extractedUrl && extractedUrl !== url) {
          Logger.debug(`Extracted from redirect: ${url} -> ${extractedUrl}`)
          resolvedUrls.push(extractedUrl)
        } else {
          // Keep original URL as fallback
          resolvedUrls.push(url)
        }
      }
    } catch (error) {
      Logger.warn(`Failed to resolve redirect URL ${url}: ${error}`)
      // Keep original URL as fallback
      resolvedUrls.push(url)
    }

    // Small delay to avoid overwhelming redirect services
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  return resolvedUrls
}

/**
 * Resolve a single redirect URL by following HTTP redirects
 */
async function resolveRedirectUrl(url: string): Promise<string> {
  try {
    const response = await axios.head(url, {
      timeout: 5000,
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
        timeout: 5000,
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

/**
 * Enhanced grounding metadata extraction that handles complex nested structures
 */
export function extractGroundingData(grounding: any): {
  searchQueries: string[]
  chunks: Array<{
    uri?: string
    title?: string
    content?: string
  }>
} {
  const searchQueries: string[] = []
  const chunks: Array<{ uri?: string; title?: string; content?: string }> = []

  if (!grounding) {
    return { searchQueries, chunks }
  }

  // Extract search queries
  if (grounding.searchQueries) {
    if (Array.isArray(grounding.searchQueries)) {
      searchQueries.push(
        ...grounding.searchQueries.filter((q: any) => typeof q === "string"),
      )
    } else if (typeof grounding.searchQueries === "string") {
      searchQueries.push(grounding.searchQueries)
    }
  }

  // Extract grounding chunks with flexible structure handling
  if (grounding.groundingChunks && Array.isArray(grounding.groundingChunks)) {
    for (const chunk of grounding.groundingChunks) {
      const extractedChunk: { uri?: string; title?: string; content?: string } =
        {}

      // Try multiple possible paths for URI
      extractedChunk.uri =
        chunk.web?.uri ||
        chunk.web?.url ||
        chunk.uri ||
        chunk.url ||
        chunk.webSearchResult?.uri ||
        chunk.webSearchResult?.url ||
        chunk.source?.uri ||
        chunk.source?.url

      // Try multiple possible paths for title
      extractedChunk.title =
        chunk.web?.title ||
        chunk.title ||
        chunk.webSearchResult?.title ||
        chunk.source?.title

      // Try multiple possible paths for content
      extractedChunk.content =
        chunk.web?.content ||
        chunk.content ||
        chunk.text ||
        chunk.webSearchResult?.content ||
        chunk.webSearchResult?.snippet ||
        chunk.source?.content

      // Only add chunk if it has at least a URI
      if (extractedChunk.uri) {
        chunks.push(extractedChunk)
      }
    }
  }

  return { searchQueries, chunks }
}
