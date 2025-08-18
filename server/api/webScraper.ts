import { UnifiedWebScraper } from "../scraper/unified-scraper.js"

export interface ScrapedResult {
  url: string
  title: string
  content: string
  error?: string
}

export interface ScrapeOptions {
  stealth?: boolean
  maxPages?: number
  contentOnly?: boolean
  enableCrawling?: boolean
  query?: string
}

export async function scrapeUrlContent(
  urls: string[],
  email: string,
  options: ScrapeOptions = {},
): Promise<ScrapedResult[]> {
  const {
    stealth = false,
    maxPages = 10,
    contentOnly = false,
    enableCrawling = false,
    query,
  } = options

  try {
    console.log(
      `[webScraper] Starting intelligent scraping for ${urls.length} URLs with options:`,
      {
        ...options,
      },
    )

    // Auto-enable crawling if query is provided (user likely looking for specific info)
    const shouldEnableCrawling = enableCrawling || (query && query.length > 0)

    // Create scraper with intelligent escalation
    const scraper = new UnifiedWebScraper({
      delay: stealth ? 2000 : 1000,
      headless: true,
      maxDepth: shouldEnableCrawling ? 3 : 1, // Deeper crawling if query provided
      maxPages: shouldEnableCrawling ? Math.max(maxPages, 15) : 5, // More pages if crawling
      enableCrawling: false, // Start with basic scraping, escalate if needed
    })

    // Use intelligent escalation (basic -> crawling if needed)
    const results = await scraper.scrapeWithIntelligentEscalation(urls, query)
    await scraper.close()

    // Convert to expected format and filter out only truly unusable content
    const formattedResults: ScrapedResult[] = results
      .map((result) => ({
        url: result.url,
        title: result.title,
        content: result.content,
      }))
      .filter((result) => {
        // Only filter out results that are truly unusable
        const isReallyBlocked =
          result.title === "Error" || // Actual scraping error
          result.content.length < 50 || // Extremely short content
          (result.content.length < 200 && // Short content that looks like pure bot protection
            (result.title.toLowerCase().includes("just a moment") ||
              result.content.toLowerCase().includes("verify you are human") ||
              result.content
                .toLowerCase()
                .includes("please wait while we are checking") ||
              result.content.toLowerCase().includes("access denied")))

        // Don't filter out content just because Cloudflare/bot protection was detected
        // if we still extracted substantial content (like our 9,108 char news page)
        const hasSubstantialContent = result.content.length >= 200
        const shouldKeep = !isReallyBlocked || hasSubstantialContent

        if (!shouldKeep) {
          console.log(
            `[webScraper] Filtering out unusable content for ${result.url} (length: ${result.content.length})`,
          )
        } else if (
          result.content.toLowerCase().includes("cloudflare") ||
          result.content.toLowerCase().includes("security check")
        ) {
          console.log(
            `[webScraper] Keeping content despite bot detection for ${result.url} (length: ${result.content.length})`,
          )
        }

        return shouldKeep
      })

    console.log(
      `[webScraper] Successfully scraped ${formattedResults.length} URLs (${results.length - formattedResults.length} filtered out)`,
    )

    // Log if crawling was triggered
    const crawledResults = results.filter((r) => r.metadata.isCrawled)
    if (crawledResults.length > 0) {
      console.log(
        `[webScraper] Crawling found ${crawledResults.length} additional pages through link following`,
      )
    }

    return formattedResults
  } catch (error) {
    console.error(`[webScraper] Error scraping URLs:`, error)

    // Return error results for each URL
    return urls.map((url) => ({
      url,
      title: "Error",
      content: "",
      error: error instanceof Error ? error.message : "Unknown error",
    }))
  }
}
