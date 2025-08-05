export interface GroundingMetadata {
  searchQueries?: string[] | string
  groundingChunks?: Array<{
    web?: {
      uri?: string
      url?: string
      title?: string
      content?: string
    }
    uri?: string
    url?: string
    title?: string
    content?: string
    text?: string
    webSearchResult?: {
      uri?: string
      url?: string
      title?: string
      content?: string
      snippet?: string
    }
    source?: {
      uri?: string
      url?: string
      title?: string
      content?: string
    }
  }>
}

export interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string
      }>
    }
    groundingMetadata?: GroundingMetadata
  }>
}

// Web search types for integration with the existing system
export interface WebSearchRequest {
  query: string
  maxResults?: number
  excludedUrls?: string[]
  previousQuery?: string
  previousAnswer?: string
  context?: string
}

export interface UrlWithMetadata {
  url: string
  title?: string
  siteName?: string
  content?: string // Add content/snippet for reference descriptions
}

export interface WebSearchResult {
  answer: string
  urls: string[]
  urlsWithMetadata?: UrlWithMetadata[]
  references: string[]
}

// Integration types for existing agent system
export interface WebSearchToolResponse {
  result: string
  contexts?: MinimalWebSearchFragment[]
  error?: string
  searchMetadata?: {
    query: string
    totalResults: number
    provider: string
    // Followup query support
    conversationId?: string
    isFollowup?: boolean
    previousResults?: string // Store previous search results for context
    contextCorrelationScore?: number // How well this relates to previous results
  }
  // Followup query support - no suggestions, just context tracking
  conversationId?: string
  relatedQueries?: string[]
}

export interface MinimalWebSearchFragment {
  id: string
  content: string
  source: {
    docId: string
    title: string
    url: string
    app: any // Apps enum
    entity: any // SystemEntity enum
  }
  confidence: number
}

// Agent tool parameter types specific to web search
export interface WebSearchToolParams {
  filter_query: string
  limit?: number
  offset?: number
  timeRange?: string
  searchType?: string
  previousQuery?: string
  conversationContext?: string
}
