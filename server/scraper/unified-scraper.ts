import { PlaywrightCrawler, Dataset } from "crawlee"
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright"
import fs from "fs/promises"
import path from "path"
import { URL } from "url"
import csv from "csv-parser"
import { createReadStream } from "fs"

// Unified scraping modes
export enum ScrapingMode {
  BASIC = "basic",
  STEALTH = "stealth",
  AGGRESSIVE_STEALTH = "aggressive_stealth",
}

export interface UnifiedScrapingOptions {
  // Core options
  maxDepth: number
  maxPages: number
  outputDir: string
  includeImages: boolean
  includeDocuments: boolean
  contentOnly: boolean
  allowedDomains?: string[]
  excludePatterns?: RegExp[]
  delay?: number
  userAgent?: string

  // Mode selection
  mode: ScrapingMode

  // Stealth options (used in STEALTH and AGGRESSIVE_STEALTH modes)
  stealthMode: boolean
  headless: boolean
  proxy?: string
  randomUserAgent: boolean
  viewport?: { width: number; height: number }

  // Aggressive interaction options (used in AGGRESSIVE_STEALTH mode)
  interactWithForms: boolean
  clickButtons: boolean
  scrollToTriggerLazyLoad: boolean
  waitForDynamicContent: boolean
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
    depth: number
    parentUrl?: string
    botDetectionTriggered?: boolean
    captchaSolved?: boolean
    interactionsPerformed?: string[]
    headers?: Record<string, string>
  }
}

export class UnifiedWebScraper {
  private options: UnifiedScrapingOptions
  private visitedUrls: Set<string> = new Set()
  private dataset: Dataset<ScrapedData> | null = null
  private browser: Browser | null = null
  private context: BrowserContext | null = null

  constructor(options: Partial<UnifiedScrapingOptions> = {}) {
    this.options = {
      maxDepth: 2,
      maxPages: 100,
      outputDir: "./scraped_data",
      includeImages: true,
      includeDocuments: true,
      contentOnly: false,
      delay: 1000,
      mode: ScrapingMode.BASIC,
      stealthMode: false,
      headless: true,
      randomUserAgent: false,
      interactWithForms: false,
      clickButtons: false,
      scrollToTriggerLazyLoad: false,
      waitForDynamicContent: false,
      ...options,
    }
  }

  private getRandomUserAgent(): string {
    const userAgents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ]
    return userAgents[Math.floor(Math.random() * userAgents.length)]
  }

  private async setupStealthTechniques(page: Page): Promise<void> {
    if (this.options.mode === ScrapingMode.BASIC) return

    // Advanced stealth techniques
    await page.addInitScript(() => {
      // Remove webdriver property
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      })

      // Mock plugins
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      })

      // Mock languages
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      })

      // Mock permissions
      const originalQuery = window.navigator.permissions.query
      window.navigator.permissions.query = (parameters: any) =>
        originalQuery(parameters)

      // Mock chrome object
      if ((window as any).chrome) {
        Object.defineProperty((window as any).chrome, "runtime", {
          get: () => ({
            onConnect: undefined,
            onMessage: undefined,
          }),
        })
      }

      // Mock screen properties
      Object.defineProperty(window.screen, "colorDepth", {
        get: () => 24,
      })

      // Add mouse movement tracking
      document.addEventListener("mousemove", (e) => {
        // Simulate natural mouse movement
      })
    })

    // Set additional headers
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Upgrade-Insecure-Requests": "1",
    })
  }

  private async performAggressiveInteractions(page: Page): Promise<string[]> {
    if (this.options.mode !== ScrapingMode.AGGRESSIVE_STEALTH) return []

    const interactions: string[] = []

    try {
      // Random scrolling to trigger lazy loading
      if (this.options.scrollToTriggerLazyLoad) {
        await page.evaluate(() => {
          window.scrollTo(0, Math.random() * 500)
        })
        await page.waitForTimeout(500)
        interactions.push("random_scroll")
      }

      // Wait for dynamic content
      if (this.options.waitForDynamicContent) {
        await page.waitForTimeout(2000)
        interactions.push("wait_dynamic_content")
      }

      // Interact with forms
      if (this.options.interactWithForms) {
        try {
          const inputs = await page.$$(
            'input[type="text"], input[type="email"], textarea',
          )
          for (const input of inputs) {
            await input.type("test", { delay: 100 })
            await page.waitForTimeout(200)
          }
          interactions.push("form_interaction")
        } catch (error) {
          // Ignore form interaction errors
        }
      }

      // Click buttons (carefully)
      if (this.options.clickButtons) {
        try {
          const buttons = await page.$$(
            'button:not([type="submit"]), a[role="button"]',
          )
          if (buttons.length > 0) {
            const randomButton =
              buttons[Math.floor(Math.random() * Math.min(buttons.length, 3))]
            await randomButton.click()
            await page.waitForTimeout(1000)
            interactions.push("button_click")
          }
        } catch (error) {
          // Ignore button click errors
        }
      }
    } catch (error) {
      console.warn("Aggressive interaction error:", error)
    }

    return interactions
  }

  private async extractContent(page: Page): Promise<{
    title: string
    content: string
    links: string[]
    images: string[]
    documents: string[]
  }> {
    return await page.evaluate(() => {
      // Enhanced content extraction based on mode

      // Clean up unwanted elements
      const selectorsToRemove = [
        "script",
        "style",
        "nav",
        "footer",
        "aside",
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

      // Extract title
      const title = document.title || ""

      // Extract main content with smart selectors
      let content = ""
      const contentSelectors = [
        // Medium-specific selectors
        "article",
        '[data-testid="storyContent"]',
        ".postArticle-content",
        ".section-content",
        // General content selectors
        "main",
        '[role="main"]',
        ".content",
        ".post-content",
        ".entry-content",
        ".page-content",
        ".article-content",
        "#content",
        // Fallback selectors
        ".container",
        ".wrapper",
        "#main",
      ]

      for (const selector of contentSelectors) {
        const element = document.querySelector(selector)
        if (element) {
          content = (element as HTMLElement).innerText || ""
          break
        }
      }

      // Fallback to body content
      if (!content) {
        content = document.body?.innerText || ""
      }

      // Extract links
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => (a as HTMLAnchorElement).href)
        .filter(
          (href) =>
            href && !href.startsWith("javascript:") && !href.startsWith("#"),
        )
        .filter((href, index, arr) => arr.indexOf(href) === index) // Remove duplicates

      // Extract images
      const images = Array.from(document.querySelectorAll("img[src]"))
        .map((img) => (img as HTMLImageElement).src)
        .filter((src) => src && !src.startsWith("data:"))
        .filter((src, index, arr) => arr.indexOf(src) === index)

      // Extract document links
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
    const launchOptions: any = {
      headless: this.options.headless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    }

    if (this.options.mode !== ScrapingMode.BASIC) {
      // Enhanced stealth options
      launchOptions.args.push(
        "--disable-blink-features=AutomationControlled",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-breakpad",
        "--disable-client-side-phishing-detection",
        "--disable-component-extensions-with-background-pages",
        "--disable-default-apps",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-features=TranslateUI",
        "--disable-hang-monitor",
        "--disable-ipc-flooding-protection",
        "--disable-popup-blocking",
        "--disable-prompt-on-repost",
        "--disable-renderer-backgrounding",
        "--disable-sync",
        "--force-color-profile=srgb",
        "--metrics-recording-only",
        "--no-default-browser-check",
        "--no-first-run",
        "--password-store=basic",
        "--use-mock-keychain",
      )
    }

    this.browser = await chromium.launch(launchOptions)

    const contextOptions: any = {
      userAgent: this.options.randomUserAgent
        ? this.getRandomUserAgent()
        : this.options.userAgent,
      viewport: this.options.viewport || { width: 1920, height: 1080 },
    }

    if (this.options.proxy) {
      contextOptions.proxy = { server: this.options.proxy }
    }

    this.context = await this.browser.newContext(contextOptions)
  }

  async scrapeUrl(url: string): Promise<ScrapedData> {
    if (!this.browser || !this.context) {
      await this.initializeBrowser()
    }

    const page = await this.context!.newPage()

    try {
      await this.setupStealthTechniques(page)

      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      })

      // Wait a bit for dynamic content to load
      await page.waitForTimeout(3000)

      // Try to wait for network idle, but don't fail if it times out
      try {
        await page.waitForLoadState("networkidle", { timeout: 10000 })
      } catch (e) {
        // Continue if networkidle times out - this is common on sites with continuous activity
        console.log(
          "Network idle timeout reached, continuing with extraction...",
        )
      }

      // Perform aggressive interactions if enabled
      const interactions = await this.performAggressiveInteractions(page)

      // Extract content
      const { title, content, links, images, documents } =
        await this.extractContent(page)

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
          depth: 0,
          interactionsPerformed: interactions,
        },
      }

      return scrapedData
    } finally {
      await page.close()
    }
  }

  async scrapeMultipleUrls(urls: string[]): Promise<ScrapedData[]> {
    const results: ScrapedData[] = []

    for (const url of urls) {
      try {
        console.log(`Scraping: ${url}`)
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
      }
    }

    return results
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close()
    }
    if (this.browser) {
      await this.browser.close()
    }
  }

  // Static convenience methods for different modes
  static async scrapeBasic(
    urls: string[],
    options: Partial<UnifiedScrapingOptions> = {},
  ): Promise<ScrapedData[]> {
    const scraper = new UnifiedWebScraper({
      ...options,
      mode: ScrapingMode.BASIC,
    })
    try {
      return await scraper.scrapeMultipleUrls(urls)
    } finally {
      await scraper.close()
    }
  }

  static async scrapeStealth(
    urls: string[],
    options: Partial<UnifiedScrapingOptions> = {},
  ): Promise<ScrapedData[]> {
    const scraper = new UnifiedWebScraper({
      ...options,
      mode: ScrapingMode.STEALTH,
      stealthMode: true,
      randomUserAgent: true,
    })
    try {
      return await scraper.scrapeMultipleUrls(urls)
    } finally {
      await scraper.close()
    }
  }

  static async scrapeAggressiveStealth(
    urls: string[],
    options: Partial<UnifiedScrapingOptions> = {},
  ): Promise<ScrapedData[]> {
    const scraper = new UnifiedWebScraper({
      ...options,
      mode: ScrapingMode.AGGRESSIVE_STEALTH,
      stealthMode: true,
      randomUserAgent: true,
      interactWithForms: true,
      scrollToTriggerLazyLoad: true,
      waitForDynamicContent: true,
    })
    try {
      return await scraper.scrapeMultipleUrls(urls)
    } finally {
      await scraper.close()
    }
  }
}

// Export for backward compatibility
export { UnifiedWebScraper as RecursiveLinkScraper }
export { UnifiedWebScraper as StealthRecursiveLinkScraper }
export { UnifiedWebScraper as AggressiveStealthScraper }
