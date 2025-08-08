#!/usr/bin/env node

import { Command } from "commander"
import { UnifiedWebScraper, ScrapingMode } from "./unified-scraper.js"
import fs from "fs/promises"
import path from "path"

const program = new Command()

program
  .name("unified-scraper")
  .description(
    "Unified web scraper with multiple modes: basic, stealth, and aggressive stealth",
  )
  .version("1.0.0")

program
  .command("scrape")
  .description("Scrape URLs with unified scraper")
  .argument("<urls>", "Comma-separated URLs to scrape")
  .option(
    "-m, --mode <mode>",
    "Scraping mode (basic, stealth, aggressive_stealth)",
    "basic",
  )
  .option("-o, --output <dir>", "Output directory", "./scraped_data")
  .option("-d, --delay <ms>", "Delay between requests in milliseconds", "1000")
  .option("--max-pages <num>", "Maximum pages to scrape", "50")
  .option("--headless <bool>", "Run in headless mode", "true")
  .option("--random-ua", "Use random user agents")
  .option("--interact-forms", "Interact with forms (aggressive mode)")
  .option("--click-buttons", "Click buttons (aggressive mode)")
  .option("--scroll-lazy", "Scroll to trigger lazy loading (aggressive mode)")
  .option("--wait-dynamic", "Wait for dynamic content (aggressive mode)")
  .action(async (urls, options) => {
    try {
      const urlList = urls.split(",").map((url: string) => url.trim())

      // Validate mode
      const validModes = Object.values(ScrapingMode)
      if (!validModes.includes(options.mode as ScrapingMode)) {
        console.error(
          `Invalid mode: ${options.mode}. Valid modes: ${validModes.join(", ")}`,
        )
        process.exit(1)
      }

      const scrapingOptions = {
        mode: options.mode as ScrapingMode,
        outputDir: options.output,
        delay: parseInt(options.delay),
        maxPages: parseInt(options.maxPages),
        headless: options.headless === "true",
        randomUserAgent: options.randomUa,
        interactWithForms: options.interactForms,
        clickButtons: options.clickButtons,
        scrollToTriggerLazyLoad: options.scrollLazy,
        waitForDynamicContent: options.waitDynamic,
      }

      console.log(`Starting unified scraper in ${options.mode} mode...`)
      console.log(`URLs to scrape: ${urlList.length}`)
      console.log(`Output directory: ${options.output}`)

      const scraper = new UnifiedWebScraper(scrapingOptions)
      const results = await scraper.scrapeMultipleUrls(urlList)
      await scraper.close()

      // Create output directory
      await fs.mkdir(options.output, { recursive: true })

      // Save results
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
      const outputFile = path.join(
        options.output,
        `scraped_data_${timestamp}.json`,
      )

      await fs.writeFile(outputFile, JSON.stringify(results, null, 2))

      console.log(`\\n✅ Scraping completed!`)
      console.log(`📊 Results:`)
      console.log(`   - URLs scraped: ${results.length}`)
      console.log(
        `   - Total content: ${results.reduce((sum, r) => sum + r.content.length, 0)} characters`,
      )
      console.log(
        `   - Total links found: ${results.reduce((sum, r) => sum + r.links.length, 0)}`,
      )
      console.log(
        `   - Total images found: ${results.reduce((sum, r) => sum + r.images.length, 0)}`,
      )
      console.log(`📁 Output saved to: ${outputFile}`)
    } catch (error) {
      console.error("❌ Scraping failed:", error)
      process.exit(1)
    }
  })

program
  .command("modes")
  .description("List available scraping modes")
  .action(() => {
    console.log("Available scraping modes:")
    console.log("")
    console.log("🔹 basic - Standard scraping without stealth techniques")
    console.log("   • Fast and simple")
    console.log("   • Good for most websites")
    console.log("   • May be detected by anti-bot systems")
    console.log("")
    console.log("🔹 stealth - Stealth scraping with anti-detection techniques")
    console.log("   • Random user agents")
    console.log("   • Hidden webdriver properties")
    console.log("   • Enhanced headers and timing")
    console.log("   • Better for protected sites")
    console.log("")
    console.log("🔹 aggressive_stealth - Advanced stealth with interactions")
    console.log("   • All stealth techniques")
    console.log("   • Form interactions")
    console.log("   • Button clicking")
    console.log("   • Lazy loading triggers")
    console.log("   • Dynamic content waiting")
    console.log("   • Best for heavily protected sites")
  })

// Examples command
program
  .command("examples")
  .description("Show usage examples")
  .action(() => {
    console.log("Usage Examples:")
    console.log("")
    console.log("🔹 Basic scraping:")
    console.log('   npm run dev scrape "https://example.com"')
    console.log("")
    console.log("🔹 Stealth scraping:")
    console.log(
      '   npm run dev scrape "https://example.com" --mode stealth --random-ua',
    )
    console.log("")
    console.log("🔹 Aggressive stealth scraping:")
    console.log(
      '   npm run dev scrape "https://example.com" --mode aggressive_stealth --interact-forms --scroll-lazy',
    )
    console.log("")
    console.log("🔹 Multiple URLs:")
    console.log(
      '   npm run dev scrape "https://site1.com,https://site2.com" --mode stealth',
    )
    console.log("")
    console.log("🔹 Custom options:")
    console.log(
      '   npm run dev scrape "https://example.com" --mode stealth --delay 2000 --output ./my_data',
    )
  })

program.parse()
