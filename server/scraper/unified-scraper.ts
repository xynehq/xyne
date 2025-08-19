import { Dataset } from "crawlee"
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright"

export interface ScrapingOptions {
  delay?: number
  userAgent?: string
  headless?: boolean
  maxDepth?: number
  maxPages?: number
  enableCrawling?: boolean
}

export interface ScrapedData {
  url: string
  title: string
  content: string
  links: string[]
  images: string[]
  documents: string[]
  metadata: {
    timestamp: string
    statusCode?: number
    contentLength?: number
    depth?: number
    isCrawled?: boolean
    botDetected?: boolean
    isRelevant?: boolean
  }
}

export class UnifiedWebScraper {
  private options: ScrapingOptions
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private dataset: Dataset<ScrapedData> | null = null

  constructor(options: ScrapingOptions = {}) {
    this.options = {
      delay: 1000,
      headless: true,
      maxDepth: 4,
      maxPages: 8,
      enableCrawling: false,
      ...options,
    }
  }

  private async ensureBrowserReady(): Promise<void> {
    if (!this.browser || !this.browser.isConnected() || !this.context) {
      console.log("Browser not available or disconnected, initializing...")
      try {
        await this.close()
        await this.initializeBrowser()
      } catch (initError) {
        console.error("Failed to reinitialize browser:", initError)
        throw new Error(`Browser initialization failed: ${initError}`)
      }
    }
  }

  private async detectBotProtection(page: Page): Promise<boolean> {
    try {
      const content = await page.content()
      const title = await page.title()

      const botPatterns = [
        /just a moment/i,
        /cloudflare/i,
        /security check/i,
        /verify you are human/i,
        /access denied/i,
        /blocked/i,
        /captcha/i,
        /robot/i,
        /please enable javascript/i,
        /403 forbidden/i,
        /503 service unavailable/i,
      ]

      const isBlocked = botPatterns.some(
        (pattern) => pattern.test(title) || pattern.test(content),
      )

      const hasCloudflareChallenge =
        content.includes("cf-browser-verification") ||
        content.includes("cf-challenge") ||
        content.includes("Please wait while we are checking your browser")

      return isBlocked || hasCloudflareChallenge
    } catch (error) {
      console.warn("Error detecting bot protection:", error)
      return false
    }
  }

  private async setupAntiDetection(page: Page): Promise<void> {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      })

      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      })

      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      })
    })

    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    })
  }

  private async extractContent(page: Page): Promise<{
    title: string
    content: string
    links: string[]
    images: string[]
    documents: string[]
  }> {
    return await page.evaluate(() => {
      const title = document.title || ""

      let content = ""
      const contentSelectors = [
        ".main-content",
        ".page-content",
        ".content-area",
        ".article-content",
        ".post-content",
        ".entry-content",
        ".section-content",
        ".content-wrapper",
        ".content-container",
        "article",
        ".article",
        ".post",
        ".entry",
        ".page",
        '[role="main"]',
        "main",
        "#main",
        "#content",
        ".content",
        ".container .content",
        ".wrapper .content",
        ".site-content",
        ".primary-content",
        ".container",
        ".wrapper",
        "body .content",
      ]

      for (const selector of contentSelectors) {
        const element = document.querySelector(selector)
        if (element) {
          content = (element as HTMLElement).innerText || ""
          if (content.length > 200) {
            break
          }
        }
      }

      if (!content || content.length < 100) {
        content = document.body?.innerText || ""
      }

      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => (a as HTMLAnchorElement).href)
        .filter(
          (href) =>
            href &&
            !href.startsWith("javascript:") &&
            !href.startsWith("#") &&
            !href.startsWith("mailto:") &&
            !href.startsWith("tel:"),
        )
        .filter((href, index, arr) => arr.indexOf(href) === index)

      const images = Array.from(document.querySelectorAll("img[src]"))
        .map((img) => (img as HTMLImageElement).src)
        .filter((src) => src && !src.startsWith("data:"))
        .filter((src, index, arr) => arr.indexOf(src) === index)

      const documentExtensions = [
        ".pdf",
        ".doc",
        ".docx",
        ".xls",
        ".xlsx",
        ".ppt",
        ".pptx",
        ".txt",
        ".csv",
      ]
      const documents = links.filter((link) =>
        documentExtensions.some((ext) => link.toLowerCase().includes(ext)),
      )

      const selectorsToRemove = [
        "script",
        "style",
        "nav:not(.content-nav)",
        "footer",
        "aside:not(.content-aside)",
        ".ad",
        ".advertisement",
        ".popup",
        ".modal",
        '[class*="cookie"]',
        '[class*="gdpr"]',
        '[id*="cookie"]',
      ]

      selectorsToRemove.forEach((selector) => {
        const elements = document.querySelectorAll(selector)
        elements.forEach((el) => el.remove())
      })

      return {
        title: title.trim(),
        content: content.trim(),
        links,
        images,
        documents,
      }
    })
  }

  private async initializeBrowser(): Promise<void> {
    try {
      if (this.browser && this.browser.isConnected()) {
        try {
          await this.browser.close()
        } catch (closeError) {
          console.warn("Error closing existing browser:", closeError)
        }
      }
      this.browser = null
      this.context = null

      const launchOptions: any = {
        headless: this.options.headless,
        timeout: 30000, // 30 second browser launch timeout
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
          "--disable-blink-features=AutomationControlled",
          "--disable-web-security",
          "--disable-features=VizDisplayCompositor",
        ],
      }

      console.log("Launching browser...")
      this.browser = await chromium.launch(launchOptions)

      const contextOptions: any = {
        userAgent:
          this.options.userAgent ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1920, height: 1080 },
      }

      console.log("Creating browser context...")
      this.context = await this.browser.newContext(contextOptions)

      console.log("Browser initialized successfully")
    } catch (error) {
      console.error("Failed to initialize browser:", error)
      // Clean up on failure
      this.browser = null
      this.context = null
      throw new Error(`Browser initialization failed: ${error}`)
    }
  }

  async scrapeUrl(url: string, depth: number = 0): Promise<ScrapedData> {
    // Always check browser state before creating a page
    await this.ensureBrowserReady()

    let page: Page | null = null

    try {
      page = await this.context!.newPage()

      // Set timeouts
      page.setDefaultTimeout(30000)
      page.setDefaultNavigationTimeout(30000)

      await this.setupAntiDetection(page)

      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      })

      if (!response) {
        throw new Error("Failed to load page - no response")
      }

      if (response.status() >= 400) {
        throw new Error(`HTTP ${response.status()}: ${response.statusText()}`)
      }

      await page.waitForTimeout(2000)

      try {
        await page.waitForLoadState("networkidle", { timeout: 5000 })
      } catch (e) {
        console.log(
          "Network idle timeout reached, continuing with extraction...",
        )
      }

      const { title, content, links, images, documents } =
        await this.extractContent(page)

      const botDetected = await this.detectBotProtection(page)

      if (botDetected) {
        console.warn(
          `Bot protection detected on ${url}, but extracted ${content.length} chars of content`,
        )
      }

      const scrapedData: ScrapedData = {
        url,
        title,
        content,
        links,
        images,
        documents,
        metadata: {
          timestamp: new Date().toISOString(),
          statusCode: response?.status(),
          contentLength: content.length,
          depth,
          isCrawled: depth > 0,
          botDetected,
        },
      }

      return scrapedData
    } catch (error) {
      console.error(`Error scraping ${url}:`, error)
      // Return error data instead of throwing
      return {
        url,
        title: "Error",
        content: "",
        links: [],
        images: [],
        documents: [],
        metadata: {
          timestamp: new Date().toISOString(),
          contentLength: 0,
          depth,
          isCrawled: depth > 0,
          botDetected: false,
        },
      }
    } finally {
      // Safely close the page
      if (page) {
        try {
          await page.close()
        } catch (closeError) {
          console.warn("Error closing page:", closeError)
        }
      }
    }
  }

  async crawlManually(
    startUrls: string[],
    query?: string,
  ): Promise<ScrapedData[]> {
    if (!this.options.enableCrawling) {
      // Fall back to basic scraping if crawling is disabled
      return this.scrapeMultipleUrls(startUrls)
    }

    const results: ScrapedData[] = []

    try {
      console.log("Attempting to crawl with shared browser instance...")

      // Ensure we have a browser instance first
      await this.ensureBrowserReady()

      this.dataset = await Dataset.open("web-crawler-results")

      const visitedUrls = new Set<string>()
      const urlsToVisit = [...startUrls]

      while (
        urlsToVisit.length > 0 &&
        results.length < (this.options.maxPages || 8)
      ) {
        const currentUrl = urlsToVisit.shift()!

        if (visitedUrls.has(currentUrl)) {
          console.log(`Skipping already visited URL: ${currentUrl}`)
          continue
        }

        visitedUrls.add(currentUrl)
        console.log(
          `Manual crawling: ${currentUrl} (page ${visitedUrls.size}/${this.options.maxPages || 8}, queue: ${urlsToVisit.length} remaining)`,
        )

        try {
          try {
            // Check if browser is still connected, reinitialize if needed
            await this.ensureBrowserReady()
          } catch (initError) {
            console.error("Failed to reinitialize browser:", initError)
            continue
          }

          // Calculate proper depth based on position in starting URLs
          let crawlDepth = 0
          if (startUrls.includes(currentUrl)) {
            crawlDepth = 0 // Starting URL
          } else {
            // Calculate actual link depth by tracking URL discovery chain
            crawlDepth =
              Math.floor((visitedUrls.size - startUrls.length) / 3) + 1
            crawlDepth = Math.min(crawlDepth, this.options.maxDepth || 4)
          }
          const data = await this.scrapeUrl(currentUrl, crawlDepth)

          // Check if content is relevant - be much more lenient
          const queryTerms = query
            ? query
                .toLowerCase()
                .split(" ")
                .filter((term) => term.length > 2)
            : []
          const contentLower = data.content.toLowerCase()
          const titleLower = data.title.toLowerCase()

          const isRelevant =
            !query ||
            queryTerms.some(
              (term) =>
                titleLower.includes(term) || contentLower.includes(term),
            )

          // Accept almost any content - be very lenient
          const hasUsefulContent =
            data.content.length > 100 && data.title !== "Error"

          if (hasUsefulContent) {
            data.metadata.isCrawled = true
            data.metadata.depth = visitedUrls.size - 1
            data.metadata.isRelevant = isRelevant
            results.push(data)
            console.log(
              `✓ Crawled content: ${data.content.length} chars, relevant: ${isRelevant}, bot: ${data.metadata.botDetected}`,
            )
          }

          const currentDepth = data.metadata.depth || 0
          if (
            data.links.length > 0 &&
            currentDepth < (this.options.maxDepth || 4)
          ) {
            console.log(
              `Extracting links from ${currentUrl} (depth ${currentDepth}, max depth ${this.options.maxDepth || 4})`,
            )
            console.log(`Found ${data.links.length} total links on page`)

            const newUrls = data.links
              .filter((link) => {
                try {
                  const url = new URL(link)
                  const startDomain = new URL(startUrls[0]).hostname

                  // Allow same domain or related subdomains
                  const isSameDomain = url.hostname === startDomain

                  // Extract base domain (e.g., "example.com" from "www.example.com")
                  const getBaseDomain = (hostname: string) => {
                    const parts = hostname.split(".")
                    if (parts.length >= 2) {
                      return parts.slice(-2).join(".")
                    }
                    return hostname
                  }

                  const startBaseDomain = getBaseDomain(startDomain)
                  const linkBaseDomain = getBaseDomain(url.hostname)
                  const isSameBaseDomain = linkBaseDomain === startBaseDomain

                  const isAllowed = isSameDomain || isSameBaseDomain
                  if (!isAllowed) {
                    console.log(`Skipping external link: ${link}`)
                  }
                  return isAllowed
                } catch {
                  console.log(`Skipping invalid URL: ${link}`)
                  return false
                }
              })
              .filter((link) => {
                const notVisited = !visitedUrls.has(link)
                if (!notVisited) {
                  console.log(`Skipping already visited: ${link}`)
                }
                return notVisited
              })
              .filter((link) => {
                if (query && query.length > 0) {
                  const queryTerms = query
                    .toLowerCase()
                    .split(" ")
                    .filter((term) => term.length > 2)
                  const linkLower = link.toLowerCase()

                  const hasQueryTerms = queryTerms.some((term) =>
                    linkLower.includes(term),
                  )

                  const pathSegments = link
                    .split("/")
                    .filter(
                      (segment) =>
                        segment &&
                        segment.length > 2 &&
                        !segment.match(/^\d+$/),
                    )

                  const relevantKeywords = [
                    ...queryTerms,
                    "about",
                    "service",
                    "product",
                    "solution",
                    "career",
                    "job",
                    "work",
                    "requirement",
                    "qualification",
                    "apply",
                    "application",
                    "contact",
                    "info",
                    "detail",
                    "page",
                    "section",
                    "guide",
                    "help",
                    "support",
                    "faq",
                    "document",
                    "resource",
                    "learn",
                    "training",
                    "program",
                    "course",
                    "overview",
                    "description",
                    "specification",
                    "feature",
                    "benefit",
                    "mission",
                    "explore",
                    "research",
                    "science",
                    "technology",
                    "innovation",
                    // Process/navigation keywords
                    "how",
                    "what",
                    "why",
                    "when",
                    "where",
                    "process",
                    "step",
                    "instruction",
                    "requirement",
                    "criteria",
                    "eligibility",
                    "skill",
                    "experience",
                    // Action keywords
                    "become",
                    "join",
                    "start",
                    "begin",
                    "get",
                    "find",
                    "discover",
                  ]

                  const hasRelevantKeywords = relevantKeywords.some(
                    (keyword) =>
                      linkLower.includes(keyword) ||
                      pathSegments.some((segment) =>
                        segment.toLowerCase().includes(keyword),
                      ),
                  )

                  // Skip only truly irrelevant links
                  const avoidKeywords = [
                    "login",
                    "logout",
                    "signin",
                    "signup",
                    "register",
                    "auth",
                    "privacy",
                    "terms",
                    "cookie",
                    "legal",
                    "disclaimer",
                    "admin",
                    "dashboard",
                    "settings",
                    "config",
                  ]

                  const hasAvoidKeywords = avoidKeywords.some((keyword) =>
                    linkLower.includes(keyword),
                  )

                  // Prioritize query terms, but be very inclusive otherwise
                  const priority = hasQueryTerms
                    ? 3
                    : hasRelevantKeywords
                      ? 2
                      : 1
                  const shouldInclude = priority >= 1 && !hasAvoidKeywords

                  if (!shouldInclude) {
                    console.log(
                      `Filtered out link: ${link} (priority: ${priority}, avoid: ${hasAvoidKeywords})`,
                    )
                  }

                  return shouldInclude
                }
                return true // If no query, accept all links (except avoided ones)
              })
              .slice(0, 8) // Increased to 8 URLs per page for better discovery

            console.log(
              `After filtering: ${newUrls.length} URLs to add to crawl queue`,
            )
            if (newUrls.length > 0) {
              console.log(`Adding URLs to crawl queue:`, newUrls.slice(0, 5)) // Show first 5
              urlsToVisit.push(...newUrls)
            } else {
              console.log(`No new URLs found to crawl from ${currentUrl}`)
            }
          } else {
            console.log(
              `Not extracting links from ${currentUrl}: links=${data.links.length}, depth=${currentDepth}, maxDepth=${this.options.maxDepth || 4}`,
            )
          }

          // Add delay between requests
          await new Promise((resolve) =>
            setTimeout(resolve, this.options.delay || 1000),
          ) // Reduced delay to 1 second
        } catch (error) {
          console.error(`Error manually crawling ${currentUrl}:`, error)
          continue
        }
      }

      console.log(
        `Manual crawler finished. Found ${results.length} relevant pages from ${visitedUrls.size} visited URLs.`,
      )
    } catch (error) {
      console.error("Manual crawler error:", error)
      // Fall back to basic scraping
      console.log("Manual crawling failed, falling back to basic scraping...")
      return this.scrapeMultipleUrls(startUrls)
    }

    return results
  }

  async scrapeWithIntelligentEscalation(
    urls: string[],
    query?: string,
  ): Promise<ScrapedData[]> {
    console.log("Starting with basic scraping...")

    try {
      // First, try basic scraping
      const basicResults = await this.scrapeMultipleUrls(urls)

      // Check if we got meaningful content
      const goodResults = basicResults.filter((result) => {
        if (result.content.length <= 300 || result.title === "Error") {
          return false
        }

        if (!query) {
          return true
        }

        const queryLower = query.toLowerCase()
        const contentLower = result.content.toLowerCase()
        const titleLower = result.title.toLowerCase()
        const urlLower = result.url.toLowerCase()

        // For specific queries (like news, releases, specific years), be more strict
        const specificTerms = queryLower
          .split(" ")
          .filter((term) => {
            // Clean up punctuation and filter by length and common words
            const cleanTerm = term.replace(/[^\w]/g, "") // Remove punctuation
            return (
              cleanTerm.length > 2 &&
              ![
                "what",
                "are",
                "the",
                "how",
                "when",
                "where",
                "why",
                "and",
                "for",
                "with",
              ].includes(cleanTerm)
            )
          })
          .map((term) => term.replace(/[^\w]/g, "")) // Clean all terms

        // Check for content relevance first (most important)
        const hasContentMatch = specificTerms.some((term) =>
          contentLower.includes(term),
        )

        // Check for title relevance
        const hasTitleMatch = specificTerms.some((term) =>
          titleLower.includes(term),
        )

        // URL matching should be secondary and less weighted
        const hasUrlMatch = specificTerms.some((term) =>
          urlLower.includes(term),
        )

        // For multi-term specific queries, be very strict - require multiple terms in content/title
        if (specificTerms.length >= 2) {
          const contentTermMatches = specificTerms.filter((term) =>
            contentLower.includes(term),
          ).length
          const titleTermMatches = specificTerms.filter((term) =>
            titleLower.includes(term),
          ).length
          const totalTermMatches = Math.max(
            contentTermMatches,
            titleTermMatches,
          )

          // For specific queries like "2025 NASA News Releases", require at least 2 terms
          // URL matching alone is not sufficient for multi-term queries
          return totalTermMatches >= 2
        }

        // For simpler queries, allow URL matching as fallback
        return hasContentMatch || hasTitleMatch || hasUrlMatch
      })

      console.log(`📊 Query: "${query}"`)
      console.log(
        `📊 Filtering results: ${basicResults.length} total → ${goodResults.length} good results`,
      )

      if (query) {
        const queryTerms = query
          .toLowerCase()
          .split(" ")
          .filter((term) => {
            const cleanTerm = term.replace(/[^\w]/g, "")
            return (
              cleanTerm.length > 2 &&
              ![
                "what",
                "are",
                "the",
                "how",
                "when",
                "where",
                "why",
                "and",
                "for",
                "with",
              ].includes(cleanTerm)
            )
          })
          .map((term) => term.replace(/[^\w]/g, ""))
        console.log(`🔍 Query terms: [${queryTerms.join(", ")}]`)

        goodResults.forEach((result, i) => {
          const contentLower = result.content.toLowerCase()
          const titleLower = result.title.toLowerCase()
          const contentMatches = queryTerms.filter((term) =>
            contentLower.includes(term),
          )
          const titleMatches = queryTerms.filter((term) =>
            titleLower.includes(term),
          )
          const totalMatches = Math.max(
            contentMatches.length,
            titleMatches.length,
          )
          console.log(`  [${i}] ${result.url}:`)
          console.log(
            `      Content matches: ${contentMatches.length}/${queryTerms.length} [${contentMatches.join(", ")}]`,
          )
          console.log(
            `      Title matches: ${titleMatches.length}/${queryTerms.length} [${titleMatches.join(", ")}]`,
          )
          console.log(
            `      Max matches: ${totalMatches}/${queryTerms.length} (need ≥2 for multi-term query)`,
          )
        })
      }

      // More intelligent crawling trigger - be very aggressive for multi-term queries
      const shouldCrawl =
        query &&
        (goodResults.length === 0 || // No good results at all
          goodResults.length < Math.max(1, Math.ceil(urls.length / 4)) || // Less than 1/4 of URLs had good results
          !goodResults.some((r) => {
            // Check if any result has substantial query-specific content
            const queryTerms = query
              .toLowerCase()
              .split(" ")
              .filter((term) => {
                const cleanTerm = term.replace(/[^\w]/g, "")
                return (
                  cleanTerm.length > 2 &&
                  ![
                    "what",
                    "are",
                    "the",
                    "how",
                    "when",
                    "where",
                    "why",
                    "and",
                    "for",
                    "with",
                  ].includes(cleanTerm)
                )
              })
              .map((term) => term.replace(/[^\w]/g, ""))

            const contentLower = r.content.toLowerCase()

            // For multi-term queries, require multiple query terms to be present in content
            if (queryTerms.length >= 2) {
              const termMatches = queryTerms.filter((term) =>
                contentLower.includes(term),
              ).length
              // Require at least half the query terms to be present in content
              return termMatches >= Math.ceil(queryTerms.length / 2)
            }

            // For single term queries, require at least one match
            return queryTerms.some((term) => contentLower.includes(term))
          }))

      console.log(`🚀 Crawling decision factors:`)
      console.log(`   - Query provided: ${query ? "YES" : "NO"}`)
      console.log(`   - Good results: ${goodResults.length}/${urls.length}`)
      console.log(
        `   - Min threshold: ${Math.max(1, Math.ceil(urls.length / 4))}`,
      )
      console.log(
        `   - Good results below threshold: ${goodResults.length < Math.max(1, Math.ceil(urls.length / 4)) ? "YES" : "NO"}`,
      )

      let substantialContentFound = false
      if (query && goodResults.length > 0) {
        substantialContentFound = goodResults.some((r) => {
          const queryTerms = query
            .toLowerCase()
            .split(" ")
            .filter((term) => {
              const cleanTerm = term.replace(/[^\w]/g, "")
              return (
                cleanTerm.length > 2 &&
                ![
                  "what",
                  "are",
                  "the",
                  "how",
                  "when",
                  "where",
                  "why",
                  "and",
                  "for",
                  "with",
                ].includes(cleanTerm)
              )
            })
            .map((term) => term.replace(/[^\w]/g, ""))
          const contentLower = r.content.toLowerCase()
          if (queryTerms.length >= 2) {
            const termMatches = queryTerms.filter((term) =>
              contentLower.includes(term),
            ).length
            return termMatches >= Math.ceil(queryTerms.length / 2)
          }
          return queryTerms.some((term) => contentLower.includes(term))
        })
      }
      console.log(
        `   - Substantial content found: ${substantialContentFound ? "YES" : "NO"}`,
      )
      console.log(
        `🚀 Final decision: ${shouldCrawl ? "YES - escalating to crawl" : "NO - basic scraping sufficient"}`,
      )

      if (!shouldCrawl) {
        console.log(
          `Basic scraping found ${goodResults.length} good results${query ? " for query" : ""}, no need to crawl`,
        )
        return basicResults
      }

      console.log(
        "Basic scraping insufficient for query, checking if crawling is feasible...",
      )

      // Check if any URLs are accessible at all
      const accessibleUrls = basicResults.filter(
        (result) => result.title !== "Error" && result.content.length > 100,
      )

      if (accessibleUrls.length === 0) {
        console.warn("No URLs are accessible, skipping crawling")
        return basicResults
      }

      console.log(
        `Escalating to crawling for deeper content search (query: "${query}")...`,
      )

      // Enable crawling and try again, but with timeout protection
      this.options.enableCrawling = true

      const crawlPromise = this.crawlManually(urls, query)
      const timeoutPromise = new Promise<ScrapedData[]>(
        (_, reject) =>
          setTimeout(() => reject(new Error("Crawling timeout")), 120000), // Increased to 2 minutes
      )

      let crawlResults: ScrapedData[] = []
      try {
        crawlResults = await Promise.race([crawlPromise, timeoutPromise])
      } catch (error) {
        console.warn("Crawling failed or timed out:", error)
        crawlResults = []
      }

      const allResults = [...basicResults, ...crawlResults]

      const uniqueResults = allResults.filter(
        (result, index, arr) =>
          arr.findIndex((r) => r.url === result.url) === index,
      )

      const crawledRelevantResults = crawlResults.filter(
        (result) =>
          !query || result.content.toLowerCase().includes(query.toLowerCase()),
      )

      if (crawledRelevantResults.length > 0) {
        console.log(
          `Crawling found ${crawledRelevantResults.length} additional relevant results!`,
        )
      }

      console.log(
        `Intelligent escalation complete. Total unique results: ${uniqueResults.length}`,
      )
      return uniqueResults
    } catch (error) {
      console.error("Error in intelligent escalation:", error)
      // Last fallback - try basic scraping one more time
      try {
        return await this.scrapeMultipleUrls(urls)
      } catch (fallbackError) {
        console.error("Final fallback failed:", fallbackError)
        // Return empty results for each URL
        return urls.map((url) => ({
          url,
          title: "Error",
          content: "",
          links: [],
          images: [],
          documents: [],
          metadata: {
            timestamp: new Date().toISOString(),
            contentLength: 0,
            botDetected: false,
          },
        }))
      }
    }
  }

  async scrapeMultipleUrls(urls: string[]): Promise<ScrapedData[]> {
    const results: ScrapedData[] = []

    // Ensure browser is initialized once at the start
    await this.ensureBrowserReady()

    for (const url of urls) {
      try {
        console.log(`Scraping: ${url}`)

        // Check browser state before each URL
        try {
          await this.ensureBrowserReady()
        } catch (initError) {
          console.error("Failed to reinitialize browser:", initError)
          // Add error result and continue
          results.push({
            url,
            title: "Error",
            content: "",
            links: [],
            images: [],
            documents: [],
            metadata: {
              timestamp: new Date().toISOString(),
              contentLength: 0,
              botDetected: false,
            },
          })
          continue
        }

        const data = await this.scrapeUrl(url)
        results.push(data)

        // Add delay between requests
        if (this.options.delay) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.options.delay),
          )
        }
      } catch (error) {
        console.error(`Error scraping ${url}:`, error)
        // Add error result instead of failing completely
        results.push({
          url,
          title: "Error",
          content: "",
          links: [],
          images: [],
          documents: [],
          metadata: {
            timestamp: new Date().toISOString(),
            contentLength: 0,
            botDetected: false,
          },
        })
      }
    }

    return results
  }

  async close(): Promise<void> {
    console.log("Closing browser and context...")
    try {
      if (this.context) {
        try {
          await this.context.close()
          console.log("Context closed successfully")
        } catch (contextError) {
          console.warn("Error closing context:", contextError)
        }
      }

      if (this.browser && this.browser.isConnected()) {
        try {
          await this.browser.close()
          console.log("Browser closed successfully")
        } catch (browserError) {
          console.warn("Error closing browser:", browserError)
        }
      }
    } catch (error) {
      console.error("Error during cleanup:", error)
    } finally {
      this.context = null
      this.browser = null
    }
  }
}
