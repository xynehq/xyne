import { UnifiedWebScraper, ScrapingMode } from "../scraper/unified-scraper.js"

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
}

export async function scrapeUrlContent(
  urls: string[],
  email: string,
  options: ScrapeOptions = {},
): Promise<ScrapedResult[]> {
  const { stealth = false, maxPages = 5, contentOnly = false } = options

  // Auto-enable stealth for known problematic sites
  const needsStealthSites = [
    "medium.com",
    "linkedin.com",
    "twitter.com",
    "x.com",
    "facebook.com",
  ]
  const autoStealth =
    stealth ||
    urls.some((url) =>
      needsStealthSites.some((site) => url.toLowerCase().includes(site)),
    )

  try {
    console.log(`[webScraper] Scraping ${urls.length} URLs with options:`, {
      ...options,
      autoStealth,
    })

    // Create scraper with appropriate mode
    const scraper = new UnifiedWebScraper({
      mode: autoStealth ? ScrapingMode.AGGRESSIVE_STEALTH : ScrapingMode.BASIC,
      maxPages,
      delay: autoStealth ? 2000 : 1000,
      stealthMode: autoStealth,
      randomUserAgent: true,
      headless: true,
      contentOnly,
      // Enable aggressive interactions for problematic sites
      interactWithForms: false,
      clickButtons: false,
      scrollToTriggerLazyLoad: autoStealth,
      waitForDynamicContent: autoStealth,
    })

    const results = await scraper.scrapeMultipleUrls(urls)
    await scraper.close()

    // Convert to expected format and filter out blocked content
    const formattedResults: ScrapedResult[] = results
      .map((result) => ({
        url: result.url,
        title: result.title,
        content: result.content,
      }))
      .filter((result) => {
        // Filter out obvious bot detection pages
        const isBlocked =
          result.title.toLowerCase().includes("just a moment") ||
          result.content.toLowerCase().includes("verify you are human") ||
          result.content.toLowerCase().includes("cloudflare") ||
          result.content.toLowerCase().includes("security check")

        if (isBlocked) {
          console.log(
            `[webScraper] Detected bot protection for ${result.url}, content may be incomplete`,
          )
        }

        return !isBlocked
      })

    console.log(
      `[webScraper] Successfully scraped ${formattedResults.length} URLs (${results.length - formattedResults.length} blocked)`,
    )
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
