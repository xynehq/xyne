/**
 * Web Search Integration Configuration
 *
 * Configuration and environment management for the Gemini web search integration
 */

// Configuration interfaces
export interface WebSearchIntegrationConfig {
  enabled: boolean
  apiKey: string
  projectId: string
  location: string
  model: string
  defaultMaxResults: number
  timeout: number
}

export interface WebSearchMetrics {
  totalQueries: number
  successfulQueries: number
  failedQueries: number
  averageResponseTime: number
  lastQueryTimestamp?: Date
}

// Default configuration values
const DEFAULT_CONFIG: Omit<
  WebSearchIntegrationConfig,
  "apiKey" | "projectId" | "location"
> = {
  enabled: true,
  model: "gemini-2.5-flash-002",
  defaultMaxResults: 5,
  timeout: 30000, // 30 seconds
}

// Load configuration from environment variables
export function loadWebSearchConfig(): WebSearchIntegrationConfig {
  const apiKey = process.env.GEMINI_API_KEY
  const projectId = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY environment variable is required for web search integration",
    )
  }

  if (!projectId) {
    throw new Error(
      "GOOGLE_CLOUD_PROJECT environment variable is required for web search integration",
    )
  }

  if (!location) {
    throw new Error(
      "GOOGLE_CLOUD_LOCATION environment variable is required for web search integration",
    )
  }

  return {
    ...DEFAULT_CONFIG,
    apiKey,
    projectId,
    location,
    model: process.env.GEMINI_MODEL || DEFAULT_CONFIG.model,
    defaultMaxResults: parseInt(
      process.env.GEMINI_DEFAULT_MAX_RESULTS ||
        String(DEFAULT_CONFIG.defaultMaxResults),
    ),
    timeout: parseInt(
      process.env.GEMINI_TIMEOUT || String(DEFAULT_CONFIG.timeout),
    ),
  }
}

// Validate configuration
export function validateWebSearchConfig(config: WebSearchIntegrationConfig): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (!config.apiKey || config.apiKey.trim() === "") {
    errors.push("API key is required and cannot be empty")
  }

  if (!config.projectId || config.projectId.trim() === "") {
    errors.push("Google Cloud project ID is required and cannot be empty")
  }

  if (!config.location || config.location.trim() === "") {
    errors.push("Google Cloud location is required and cannot be empty")
  }

  if (config.defaultMaxResults < 1 || config.defaultMaxResults > 20) {
    errors.push("Default max results must be between 1 and 20")
  }

  if (config.timeout < 1000 || config.timeout > 60000) {
    errors.push("Timeout must be between 1000ms and 60000ms")
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

// Get masked configuration for logging (hides sensitive data)
export function getMaskedConfig(
  config: WebSearchIntegrationConfig,
): Partial<WebSearchIntegrationConfig> {
  return {
    enabled: config.enabled,
    projectId: config.projectId,
    location: config.location,
    model: config.model,
    defaultMaxResults: config.defaultMaxResults,
    timeout: config.timeout,
    apiKey: config.apiKey ? "***configured***" : undefined,
  }
}

// Environment variable names used by the integration
export const WEB_SEARCH_ENV_VARS = {
  API_KEY: "GEMINI_API_KEY",
  PROJECT_ID: "GOOGLE_CLOUD_PROJECT",
  LOCATION: "GOOGLE_CLOUD_LOCATION",
  MODEL: "GEMINI_MODEL",
  MAX_RESULTS: "GEMINI_DEFAULT_MAX_RESULTS",
  TIMEOUT: "GEMINI_TIMEOUT",
} as const

// Configuration for the integration
export interface WebSearchConfig {
  apiKey: string
  projectId: string
  location: string
  model?: string
  maxResults?: number
  timeout?: number
}
