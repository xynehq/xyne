// Unified scraper exports
export {
  UnifiedWebScraper,
  ScrapingMode,
  // Backward compatibility exports (all point to unified scraper now)
  RecursiveLinkScraper,
  StealthRecursiveLinkScraper,
  AggressiveStealthScraper,
} from "./unified-scraper.js"
export type { UnifiedScrapingOptions, ScrapedData } from "./unified-scraper.js"

// Re-export for legacy compatibility
export type { UnifiedScrapingOptions as ScrapingOptions } from "./unified-scraper.js"
