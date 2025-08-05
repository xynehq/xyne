/**
 * URL Metadata Extraction for Web Search
 *
 * Uses axios and cheerio to extract proper titles and metadata from URLs
 * for better citations in web search results.
 */

import axios from "axios"
import { load } from "cheerio"
import { getLogger } from "../../logger/index.js"
import { Subsystem } from "../../types.js"

const Logger = getLogger(Subsystem.Search).child({
  module: "urlMetadata",
})

export interface UrlMetadata {
  title: string
  description?: string
  siteName: string
  domain: string
  favicon?: string
  author?: string
  publishedDate?: string
  canonicalUrl?: string
}

export interface UrlMetadataOptions {
  timeout?: number
  userAgent?: string
  followRedirects?: boolean
}

const DEFAULT_OPTIONS: Required<UrlMetadataOptions> = {
  timeout: 3000, // Reduced to 3 seconds for faster responses
  userAgent: "Mozilla/5.0 (compatible; Xyne-Search/1.0; +https://xyne.ai)",
  followRedirects: true,
}

/**
 * Extract metadata from a URL for better citations
 */
export async function extractUrlMetadata(
  url: string,
  options: UrlMetadataOptions = {},
): Promise<UrlMetadata> {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  try {
    // Validate URL
    const urlObj = new URL(url)
    if (!["http:", "https:"].includes(urlObj.protocol)) {
      throw new Error(`Unsupported protocol: ${urlObj.protocol}`)
    }

    Logger.debug(`Extracting metadata from URL: ${url}`)

    // Fast-fetch strategy: Get only first few KB for title extraction
    const response = await axios.get(url, {
      timeout: opts.timeout,
      maxContentLength: 20000, // Reduced to 20KB for faster processing
      maxRedirects: opts.followRedirects ? 2 : 0, // Reduced redirects
      headers: {
        "User-Agent": opts.userAgent,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate",
        Range: "bytes=0-19999", // Try to get only first 20KB
      },
      validateStatus: (status) => status < 400,
      // Additional timeout and abort controls
      responseType: "text",
    })

    if (!response.data) {
      throw new Error("Empty response from URL")
    }

    // Parse HTML with cheerio
    const $ = load(response.data)

    // Extract domain and site information
    const domain = urlObj.hostname.replace("www.", "")
    const siteName = extractSiteName(domain, $)

    // Extract title with fallbacks
    const title = extractTitle($, siteName, url)

    // Extract metadata
    const metadata = extractMetadata($, urlObj)

    const result: UrlMetadata = {
      title,
      siteName,
      domain,
      ...metadata,
    }

    Logger.debug(`Successfully extracted metadata from ${url}`, {
      title: result.title,
      siteName: result.siteName,
      domain: result.domain,
    })

    return result
  } catch (error) {
    Logger.warn(`Failed to extract metadata from ${url}:`, error)

    // Fallback to domain-based metadata
    const urlObj = new URL(url)
    const domain = urlObj.hostname.replace("www.", "")
    const siteName = createFallbackSiteName(domain)

    return {
      title: `${siteName} - Web Content`,
      siteName,
      domain,
      canonicalUrl: url,
    }
  }
}

/**
 * Extract site name from domain and HTML
 */
function extractSiteName(domain: string, $: ReturnType<typeof load>): string {
  // Try to get site name from various sources
  const ogSiteName = $('meta[property="og:site_name"]').attr("content")
  const twitterSite = $('meta[name="twitter:site"]')
    .attr("content")
    ?.replace("@", "")
  const applicationName = $('meta[name="application-name"]').attr("content")

  if (ogSiteName?.trim()) return ogSiteName.trim()
  if (twitterSite?.trim()) return twitterSite.trim()
  if (applicationName?.trim()) return applicationName.trim()

  return createFallbackSiteName(domain)
}

/**
 * Create fallback site name from domain
 */
function createFallbackSiteName(domain: string): string {
  const domainParts = domain.split(".")
  let siteName = domainParts[0]

  // Handle special domains
  const specialDomains: Record<string, string> = {
    github: "GitHub",
    stackoverflow: "Stack Overflow",
    stackexchange: "Stack Exchange",
    wikipedia: "Wikipedia",
    medium: "Medium",
    youtube: "YouTube",
    reddit: "Reddit",
    linkedin: "LinkedIn",
    facebook: "Facebook",
    twitter: "Twitter",
    x: "X (Twitter)",
    instagram: "Instagram",
    pinterest: "Pinterest",
    tumblr: "Tumblr",
    quora: "Quora",
    hackernews: "Hacker News",
    ycombinator: "Y Combinator",
    news: "News",
    techcrunch: "TechCrunch",
    wired: "Wired",
    arstechnica: "Ars Technica",
    theverge: "The Verge",
    engadget: "Engadget",
    cnn: "CNN",
    bbc: "BBC",
    nytimes: "The New York Times",
    washingtonpost: "The Washington Post",
    forbes: "Forbes",
    bloomberg: "Bloomberg",
    reuters: "Reuters",
    wsj: "The Wall Street Journal",
  }

  const knownSite = specialDomains[siteName.toLowerCase()]
  if (knownSite) return knownSite

  // Capitalize first letter
  return siteName.charAt(0).toUpperCase() + siteName.slice(1)
}

/**
 * Extract title with multiple fallback strategies
 */
function extractTitle(
  $: ReturnType<typeof load>,
  siteName: string,
  url: string,
): string {
  // Try multiple title sources in order of preference
  const titleSources = [
    () => $('meta[property="og:title"]').attr("content"),
    () => $('meta[name="twitter:title"]').attr("content"),
    () => $("title").text(),
    () => $("h1").first().text(),
    () => $('meta[name="title"]').attr("content"),
    () => $('[role="heading"][aria-level="1"]').text(),
    () => $(".title, .entry-title, .post-title, .article-title").first().text(),
  ]

  for (const getTitle of titleSources) {
    const title = getTitle()?.trim()
    if (title && title.length > 3) {
      // Clean up the title
      const cleanTitle = title
        .replace(/\s+/g, " ")
        .replace(/^\W+|\W+$/g, "")
        .trim()

      if (cleanTitle.length > 3) {
        // Remove site name suffix if present
        const patterns = [
          new RegExp(`\\s*[|\\-–—]\\s*${siteName}\\s*$`, "i"),
          new RegExp(`\\s*[|\\-–—]\\s*${siteName.toLowerCase()}\\s*$`, "i"),
        ]

        let finalTitle = cleanTitle
        for (const pattern of patterns) {
          finalTitle = finalTitle.replace(pattern, "").trim()
        }

        return finalTitle || cleanTitle
      }
    }
  }

  // Ultimate fallback
  try {
    const urlObj = new URL(url)
    const pathParts = urlObj.pathname.split("/").filter(Boolean)
    if (pathParts.length > 0) {
      const lastPart = pathParts[pathParts.length - 1]
      const titleFromPath = lastPart
        .replace(/[-_]/g, " ")
        .replace(/\.[^.]*$/, "")
        .replace(/\b\w/g, (l) => l.toUpperCase())

      if (titleFromPath.length > 3) {
        return titleFromPath
      }
    }
  } catch {
    // ignore URL parsing errors
  }

  return `${siteName} Content`
}

/**
 * Extract metadata from the webpage
 */
function extractMetadata(
  $: ReturnType<typeof load>,
  urlObj: URL,
): Partial<UrlMetadata> {
  const metadata: Partial<UrlMetadata> = {}

  // Description
  const description =
    $('meta[property="og:description"]').attr("content") ||
    $('meta[name="twitter:description"]').attr("content") ||
    $('meta[name="description"]').attr("content")

  if (description?.trim()) {
    metadata.description = description.trim()
  }

  // Author
  const author =
    $('meta[name="author"]').attr("content") ||
    $('meta[property="article:author"]').attr("content") ||
    $('[rel="author"]').text()?.trim() ||
    $(".author, .byline, .by-author").first().text()?.trim()

  if (author?.trim()) {
    metadata.author = author.trim()
  }

  // Published date
  const publishedDate =
    $('meta[property="article:published_time"]').attr("content") ||
    $('meta[name="publish_date"]').attr("content") ||
    $("time[datetime]").attr("datetime") ||
    $("time[pubdate]").attr("datetime")

  if (publishedDate?.trim()) {
    metadata.publishedDate = publishedDate.trim()
  }

  // Canonical URL
  const canonicalUrl = $('link[rel="canonical"]').attr("href")
  if (canonicalUrl?.trim()) {
    try {
      metadata.canonicalUrl = new URL(canonicalUrl, urlObj.origin).href
    } catch {
      // ignore invalid canonical URLs
    }
  }

  // Favicon
  const favicon =
    $('link[rel="icon"]').attr("href") ||
    $('link[rel="shortcut icon"]').attr("href") ||
    $('link[rel="apple-touch-icon"]').attr("href")

  if (favicon?.trim()) {
    try {
      metadata.favicon = new URL(favicon, urlObj.origin).href
    } catch {
      // ignore invalid favicon URLs
    }
  }

  return metadata
}

/**
 * Fast batch extract metadata - simplified to just use axios + cheerio for titles
 */
export async function extractUrlMetadataBatch(
  urls: string[],
  options: UrlMetadataOptions = {},
): Promise<Map<string, UrlMetadata>> {
  const results = new Map<string, UrlMetadata>()

  // Use the simple title extraction with axios + cheerio
  const titleMap = await extractTitlesSimple(urls)

  // Convert to UrlMetadata format
  for (const [url, title] of titleMap) {
    try {
      const domain = new URL(url).hostname.replace("www.", "")
      const siteName = createFallbackSiteName(domain)

      results.set(url, {
        title,
        siteName,
        domain,
        canonicalUrl: url,
      })
    } catch {
      results.set(url, {
        title: title || "Web Content",
        siteName: "Unknown",
        domain: "unknown",
        canonicalUrl: url,
      })
    }
  }

  Logger.info(`Simple extracted titles for ${results.size}/${urls.length} URLs`)
  return results
}

/**
 * Super simple title extraction using axios and cheerio - just get the title fast
 */
export async function extractTitlesSimple(
  urls: string[],
): Promise<Map<string, string>> {
  const results = new Map<string, string>()

  // Process all URLs in parallel with simple axios + cheerio
  const promises = urls.map(async (url) => {
    try {
      // Just use axios to get the HTML
      const response = await axios.get(url, {
        timeout: 800, // Super fast - 800ms max
        maxContentLength: 6144, // Only 6KB
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Xyne/1.0)",
          Accept: "text/html",
        },
        validateStatus: (status) => status < 400,
      })

      // Use cheerio to get title
      const $ = load(response.data.substring(0, 3072)) // Only first 3KB
      let title = $("title").text().trim()

      if (!title) {
        title = $('meta[property="og:title"]').attr("content")?.trim() || ""
      }

      if (title && title.length > 2) {
        // Simple cleanup
        title = title.replace(/\s+/g, " ").trim()
        results.set(url, title)
      } else {
        // Just use domain
        const domain = new URL(url).hostname.replace("www.", "")
        results.set(url, createFallbackSiteName(domain))
      }
    } catch (error) {
      // Simple fallback - just domain name
      try {
        const domain = new URL(url).hostname.replace("www.", "")
        results.set(url, createFallbackSiteName(domain))
      } catch {
        results.set(url, "Web Content")
      }
    }
  })

  // Wait max 2 seconds for all
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise((_, reject) => setTimeout(() => reject(), 2000)),
    ])
  } catch {
    // Timeout - that's ok
  }

  // Make sure all URLs have results
  for (const url of urls) {
    if (!results.has(url)) {
      try {
        const domain = new URL(url).hostname.replace("www.", "")
        results.set(url, createFallbackSiteName(domain))
      } catch {
        results.set(url, "Web Content")
      }
    }
  }

  return results
}

/**
 * Ultra-fast title-only extraction for immediate use
 * Uses minimal data transfer and processing
 */
export async function extractTitleFast(url: string): Promise<string> {
  try {
    const urlObj = new URL(url)
    const domain = urlObj.hostname.replace("www.", "")

    // Try to get just the title quickly
    const response = await axios.get(url, {
      timeout: 1500, // Very fast timeout
      maxContentLength: 10000, // Only first 10KB
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Xyne-Fast/1.0)",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        Range: "bytes=0-9999", // Only first 10KB
      },
      validateStatus: (status) => status < 400,
    })

    // Look for title in the first chunk of HTML
    const htmlChunk = response.data.substring(0, 5000) // Only parse first 5KB
    const titleMatch = htmlChunk.match(/<title[^>]*>([^<]+)<\/title>/i)

    if (titleMatch && titleMatch[1]) {
      let title = titleMatch[1].trim()

      // Quick cleanup
      title = title.replace(/\s+/g, " ").trim()

      // Remove common site name suffixes
      const siteName = createFallbackSiteName(domain)
      title = title
        .replace(new RegExp(`\\s*[|\\-–—]\\s*${siteName}\\s*$`, "i"), "")
        .trim()

      if (title.length > 3) {
        return title
      }
    }

    // Fallback to domain-based title
    return createFallbackSiteName(domain)
  } catch (error) {
    Logger.debug(`Fast title extraction failed for ${url}:`, error)

    // Ultimate fallback - just use domain
    try {
      const urlObj = new URL(url)
      return createFallbackSiteName(urlObj.hostname.replace("www.", ""))
    } catch {
      return "Web Content"
    }
  }
}
