import { UnifiedWebScraper, ScrapingMode } from "./unified-scraper.js"

async function demonstrateUnifiedScraper() {
  console.log("🚀 Unified Web Scraper Demo")
  console.log("===============================\n")

  const testUrls = ["https://example.com", "https://httpbin.org/html"]

  try {
    // Example 1: Basic scraping
    console.log("📋 Example 1: Basic Scraping")
    console.log("-----------------------------")
    const basicResults = await UnifiedWebScraper.scrapeBasic(
      testUrls.slice(0, 1),
      {
        delay: 500,
      },
    )
    console.log(`✅ Basic scraping completed: ${basicResults.length} pages`)
    console.log(
      `📄 Content length: ${basicResults[0]?.content.length || 0} characters\n`,
    )

    // Example 2: Stealth scraping
    console.log("🥷 Example 2: Stealth Scraping")
    console.log("-------------------------------")
    const stealthResults = await UnifiedWebScraper.scrapeStealth(
      testUrls.slice(0, 1),
      {
        delay: 1000,
        headless: true,
      },
    )
    console.log(`✅ Stealth scraping completed: ${stealthResults.length} pages`)
    console.log(
      `📄 Content length: ${stealthResults[0]?.content.length || 0} characters\n`,
    )

    // Example 3: Aggressive stealth scraping
    console.log("🔥 Example 3: Aggressive Stealth Scraping")
    console.log("------------------------------------------")
    const aggressiveResults = await UnifiedWebScraper.scrapeAggressiveStealth(
      testUrls.slice(0, 1),
      {
        delay: 2000,
        headless: true,
        scrollToTriggerLazyLoad: true,
        waitForDynamicContent: true,
      },
    )
    console.log(
      `✅ Aggressive stealth scraping completed: ${aggressiveResults.length} pages`,
    )
    console.log(
      `📄 Content length: ${aggressiveResults[0]?.content.length || 0} characters`,
    )
    console.log(
      `⚡ Interactions performed: ${aggressiveResults[0]?.metadata.interactionsPerformed?.join(", ") || "none"}\n`,
    )

    // Example 4: Manual configuration
    console.log("⚙️  Example 4: Manual Configuration")
    console.log("------------------------------------")
    const scraper = new UnifiedWebScraper({
      mode: ScrapingMode.STEALTH,
      delay: 1500,
      stealthMode: true,
      randomUserAgent: true,
      headless: true,
      viewport: { width: 1366, height: 768 },
    })

    const manualResults = await scraper.scrapeMultipleUrls(testUrls.slice(0, 1))
    await scraper.close()

    console.log(
      `✅ Manual configuration completed: ${manualResults.length} pages`,
    )
    console.log(
      `📄 Content length: ${manualResults[0]?.content.length || 0} characters\n`,
    )

    // Summary
    console.log("📊 Summary")
    console.log("----------")
    console.log(`🔹 All scraping modes successfully tested`)
    console.log(`🔹 Basic mode: Fast and simple`)
    console.log(`🔹 Stealth mode: Anti-detection techniques`)
    console.log(`🔹 Aggressive stealth: Maximum evasion + interactions`)
    console.log(`🔹 Manual config: Full control over options\n`)

    console.log("✨ All examples completed successfully!")
  } catch (error) {
    console.error("❌ Demo failed:", error)
  }
}

// Run the demo
demonstrateUnifiedScraper()
