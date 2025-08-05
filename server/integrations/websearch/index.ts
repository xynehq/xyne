/**
 * Web Search Module
 *
 * Unified web search functionality for the application using Google's Gemini 2.5-flash model
 * with Google Search grounding. This enables real-time web search for current
 * information and recent events.
 */

import { getLogger } from "../../logger/index.js"
import { Subsystem } from "../../types.js"
import type { WebSearchIntegrationConfig } from "./config.js"
import type { WebSearchRequest, WebSearchResult } from "./types.js"

const Logger = getLogger(Subsystem.Search)

// Core functionality exports
export { queryGeminiWithGrounding } from "./geminiService.js"
export {
  enhanceQueryWithContext,
  extractSemanticContext,
  resolveVagueReferences,
  analyzeQueryIntent,
  extractMainSubject,
} from "./queryEnhancer.js"

// Enhanced performWebSearch with fallback handling
export async function performWebSearch(
  request: WebSearchRequest,
): Promise<WebSearchResult> {
  try {
    const { performWebSearch: originalPerformWebSearch } = await import(
      "./geminiService.js"
    )
    const result = await originalPerformWebSearch(request)

    // **ENHANCED VALIDATION**: Check for meaningful content but be more flexible
    if (!result.answer || result.answer.trim().length < 20) {
      Logger.warn(
        "Web search returned very short content, but proceeding with result",
        { answerLength: result.answer?.length || 0 },
      )
      // Don't replace the answer - let the short answer through
      // The agent can handle short answers better than generic fallback messages
    }

    return result
  } catch (error) {
    const originalError =
      error instanceof Error ? error.message : "Unknown error"
    Logger.error("Web search failed completely", {
      error: originalError,
      query: request.query,
    })

    // **CRITICAL FIX FOR AGENTIC MODE**: Return user-friendly error messages that won't trigger generic error handling
    let userFriendlyAnswer = ""
    if (
      originalError.includes("API key") ||
      originalError.includes("configuration")
    ) {
      userFriendlyAnswer =
        "Web search configuration issue. Please contact support."
    } else if (
      originalError.includes("rate limit") ||
      originalError.includes("quota")
    ) {
      userFriendlyAnswer =
        "Web search rate limit reached. Please try again in a few minutes."
    } else if (
      originalError.includes("timeout") ||
      originalError.includes("timed out")
    ) {
      userFriendlyAnswer =
        "Web search request timed out. Please try a simpler query or try again later."
    } else {
      userFriendlyAnswer =
        "Web search is temporarily unavailable. Please try again in a moment."
    }

    // Return a graceful fallback response instead of throwing
    return {
      answer: userFriendlyAnswer,
      urls: [],
      references: [],
    }
  }
}

// Configuration exports
export {
  loadWebSearchConfig,
  validateWebSearchConfig,
  getMaskedConfig,
  WEB_SEARCH_ENV_VARS,
} from "./config.js"

// Type exports
export type {
  GroundingMetadata,
  GeminiResponse,
  WebSearchRequest,
  WebSearchResult,
  WebSearchToolResponse,
  MinimalWebSearchFragment,
  WebSearchToolParams,
} from "./types.js"

export type {
  QueryIntent,
  SemanticContext,
} from "./queryEnhancer.js"

export type {
  WebSearchIntegrationConfig,
  WebSearchMetrics,
  WebSearchConfig,
} from "./config.js"

// Integration metadata
export const webSearchIntegration = {
  name: "Gemini Web Search",
  version: "1.0.0",
  provider: "Google Vertex AI",
  model: "gemini-2.5-flash-002",
  capabilities: [
    "Real-time web search",
    "Search result grounding",
    "URL extraction",
    "Content summarization",
    "Result filtering",
    "Followup query support",
    "Context-aware search enhancement",
  ],
  requiredEnvVars: [
    "GEMINI_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
  ],
  defaultLimits: {
    maxResults: 10,
    defaultResults: 5,
    timeout: 18000, // Balanced: Increased to 18s for better reliability
  },
} as const

// Status check function for the integration
export async function checkWebSearchStatus(): Promise<{
  available: boolean
  error?: string
  config: Partial<WebSearchIntegrationConfig>
}> {
  try {
    const config: Partial<WebSearchIntegrationConfig> = {
      apiKey: process.env.GEMINI_API_KEY ? "***configured***" : undefined,
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION,
    }

    const available = !!(
      process.env.GEMINI_API_KEY &&
      process.env.GOOGLE_CLOUD_PROJECT &&
      process.env.GOOGLE_CLOUD_LOCATION
    )

    return {
      available,
      error: available ? undefined : "Missing required environment variables",
      config,
    }
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : "Unknown error",
      config: {},
    }
  }
}

// Removed: URL metadata utilities exports - no longer needed for ultra-fast performance
