/**
 * URL Content Extraction Module
 *
 * Handles URL content extraction with proper title fetching and citation management
 * for data source integration using axios and cheerio.
 */

import axios from "axios"
import { load } from "cheerio"
import { getLogger } from "../../logger/index.js"
import { Subsystem } from "../../types.js"
import { ContentExtractionError, FileProcessingError } from "./errors.js"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "urlExtractor",
})

export interface ExtractedUrlContent {
  title: string
  content: string
  url: string
  domain: string
  siteName: string
  description?: string
  author?: string
  publishedDate?: string
  canonicalUrl?: string
  favicon?: string
}

export interface UrlExtractionOptions {
  timeout?: number
  maxContentLength?: number
  userAgent?: string
  followRedirects?: boolean
  extractMetadata?: boolean
}

const DEFAULT_OPTIONS: Required<UrlExtractionOptions> = {
  timeout: 30000, // 30 seconds
  maxContentLength: 500000, // 500KB max content
  userAgent: "Mozilla/5.0 (compatible; Xyne-Bot/1.0; +https://xyne.ai)",
  followRedirects: true,
  extractMetadata: true,
}

/**
 * Extract content and title from a URL with comprehensive metadata
 */
export async function extractUrlContent(
  url: string,
  options: UrlExtractionOptions = {},
): Promise<ExtractedUrlContent> {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  try {
    // Validate URL
    const urlObj = new URL(url)
    if (!["http:", "https:"].includes(urlObj.protocol)) {
      throw new ContentExtractionError(
        `Unsupported protocol: ${urlObj.protocol}`,
        "URL",
      )
    }

    Logger.debug(`Extracting content from URL: ${url}`)

    // Fetch the webpage
    const response = await axios.get(url, {
      timeout: opts.timeout,
      maxContentLength: opts.maxContentLength,
      maxRedirects: opts.followRedirects ? 5 : 0,
      headers: {
        "User-Agent": opts.userAgent,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate",
        DNT: "1",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      },
      validateStatus: (status) => status < 400,
    })

    if (!response.data) {
      throw new ContentExtractionError("Empty response from URL", "URL")
    }

    // Parse HTML with cheerio
    const $ = load(response.data)

    // Extract domain and site information
    const domain = urlObj.hostname.replace("www.", "")
    const siteName = extractSiteName(domain, $)

    // Extract title with fallbacks
    const title = extractTitle($, siteName, url)

    // Extract main content
    const content = extractMainContent($)

    if (!content || content.trim().length < 50) {
      throw new ContentExtractionError(
        "Insufficient content extracted from URL",
        "URL",
      )
    }

    // Extract metadata if requested
    let metadata: Partial<ExtractedUrlContent> = {}
    if (opts.extractMetadata) {
      metadata = extractMetadata($, urlObj)
    }

    const result: ExtractedUrlContent = {
      title,
      content: content.trim(),
      url: response.config.url || url, // Use final URL after redirects
      domain,
      siteName,
      ...metadata,
    }

    Logger.info(`Successfully extracted content from ${url}`, {
      title: result.title,
      contentLength: result.content.length,
      domain: result.domain,
    })

    return result
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const statusCode = error.response?.status
      const statusText = error.response?.statusText

      if (statusCode === 404) {
        throw new ContentExtractionError(`URL not found (404): ${url}`, "URL")
      } else if (statusCode === 403) {
        throw new ContentExtractionError(
          `Access forbidden (403): ${url}`,
          "URL",
        )
      } else if (statusCode === 429) {
        throw new ContentExtractionError(`Rate limited (429): ${url}`, "URL")
      } else if (error.code === "ENOTFOUND") {
        throw new ContentExtractionError(`Domain not found: ${url}`, "URL")
      } else if (error.code === "ECONNREFUSED") {
        throw new ContentExtractionError(`Connection refused: ${url}`, "URL")
      } else if (error.code === "ETIMEDOUT") {
        throw new ContentExtractionError(`Request timeout: ${url}`, "URL")
      } else {
        throw new ContentExtractionError(
          `Network error accessing ${url}: ${statusCode ? `${statusCode} ${statusText}` : error.message}`,
          "URL",
        )
      }
    }

    if (error instanceof ContentExtractionError) {
      throw error
    }

    throw new ContentExtractionError(
      `Failed to extract content from ${url}: ${error instanceof Error ? error.message : String(error)}`,
      "URL",
    )
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

  if (ogSiteName && ogSiteName.trim()) return ogSiteName.trim()
  if (twitterSite && twitterSite.trim()) return twitterSite.trim()
  if (applicationName && applicationName.trim()) return applicationName.trim()

  // Fallback to domain-based name
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
    instagram: "Instagram",
    pinterest: "Pinterest",
    tumblr: "Tumblr",
    quora: "Quora",
    hackernews: "Hacker News",
    news: "News",
    techcrunch: "TechCrunch",
    wired: "Wired",
    arstechnica: "Ars Technica",
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
        return `${titleFromPath} - ${siteName}`
      }
    }
  } catch {
    // ignore URL parsing errors
  }

  return `${siteName} - Web Content`
}

/**
 * Extract main content from the webpage
 */
function extractMainContent($: ReturnType<typeof load>): string {
  // Remove unwanted elements
  $(
    "script, style, nav, header, footer, aside, .sidebar, .ads, .advertisement, .social-share, .comments, .comment, noscript, iframe",
  ).remove()

  // Try to find main content areas in order of preference
  const contentSelectors = [
    "main",
    '[role="main"]',
    ".main-content",
    ".content",
    ".post-content",
    ".entry-content",
    ".article-content",
    ".story-content",
    ".page-content",
    "#content",
    "#main",
    "article",
    ".article",
    ".post",
    ".entry",
    ".story",
  ]

  for (const selector of contentSelectors) {
    const element = $(selector).first()
    if (element.length > 0) {
      const text = element.text().trim()
      if (text.length > 200) {
        return cleanExtractedText(text)
      }
    }
  }

  // Fallback to body content
  const bodyText = $("body").text().trim()
  return cleanExtractedText(bodyText)
}

/**
 * Clean and normalize extracted text
 */
function cleanExtractedText(text: string): string {
  return text
    .replace(/\s+/g, " ") // Normalize whitespace
    .replace(/\n\s*\n/g, "\n\n") // Normalize paragraph breaks
    .replace(/^\s+|\s+$/g, "") // Trim
    .slice(0, 50000) // Limit length to prevent memory issues
}

/**
 * Extract metadata from the webpage
 */
function extractMetadata(
  $: ReturnType<typeof load>,
  urlObj: URL,
): Partial<ExtractedUrlContent> {
  const metadata: Partial<ExtractedUrlContent> = {}

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
    $('[rel="author"]').text() ||
    $(".author, .byline, .by-author").first().text()

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
 * Validate if a string is a valid URL
 */
export function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str)
    return ["http:", "https:"].includes(url.protocol)
  } catch {
    return false
  }
}

/**
 * Create a proper citation from extracted URL content
 */
export function createUrlCitation(content: ExtractedUrlContent): {
  title: string
  url: string
  description: string
  author?: string
  publishedDate?: string
  siteName: string
} {
  return {
    title: content.title,
    url: content.canonicalUrl || content.url,
    description: content.description || `Content from ${content.siteName}`,
    author: content.author,
    publishedDate: content.publishedDate,
    siteName: content.siteName,
  }
}
