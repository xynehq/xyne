/**
 * Interface for the data cached for each search interaction.
 */
export interface SearchCacheEntry {
  query: string
  results: any[]
  timestamp: number
  isFromThread: boolean
}

/**
 * Interface for the data cached for each agent interaction.
 */
export interface AgentCacheEntry {
  query: string
  agentName: string
  response: string
  citations: any[]
  timestamp: number
  isFromThread: boolean
}

export interface DbUser {
  id: number
  name: string
  email: string
  externalId: string
  workspaceId: number
  workspaceExternalId: string
  role: string
}

// Define interfaces for external data structures
export interface SearchResult {
  id?: string
  subject?: string
  title?: string
  name?: string
  content?: string
  snippet?: string
  chunks_summary?: Array<{ chunk?: string }>
  url?: string
  type?: string
  from?: string
  timestamp?: string | number
}

export interface Citation {
  id?: string
  title?: string
  name?: string
  url?: string
  snippet?: string
  content?: string
}

export interface Agent {
  id: string
  externalId: string
  name: string
  description?: string
  model?: string
}

export interface ConversationMessage {
  role: string
  content: string
}

// Runtime validation functions
export function isValidSearchResult(obj: unknown): obj is SearchResult {
  if (!obj || typeof obj !== "object") return false
  const result = obj as Record<string, unknown>

  // At least one of these fields should exist
  const hasIdentifier =
    typeof result.id === "string" ||
    typeof result.subject === "string" ||
    typeof result.title === "string" ||
    typeof result.name === "string"

  return hasIdentifier
}

export function isValidCitation(obj: unknown): obj is Citation {
  if (!obj || typeof obj !== "object") return false
  const citation = obj as Record<string, unknown>

  // At least title or name should exist
  return typeof citation.title === "string" || typeof citation.name === "string"
}

export function isValidAgent(obj: unknown): obj is Agent {
  if (!obj || typeof obj !== "object") return false
  const agent = obj as Record<string, unknown>

  return (
    typeof agent.id === "string" &&
    typeof agent.externalId === "string" &&
    typeof agent.name === "string"
  )
}

export function isValidConversationMessage(
  obj: unknown,
): obj is ConversationMessage {
  if (!obj || typeof obj !== "object") return false
  const msg = obj as Record<string, unknown>

  return typeof msg.role === "string" && typeof msg.content === "string"
}

// Validation helper functions
export function validateSearchResults(results: unknown[]): SearchResult[] {
  return results.filter(isValidSearchResult)
}

export function validateCitations(citations: unknown[]): Citation[] {
  return citations.filter(isValidCitation)
}

export function validateAgents(agents: unknown[]): Agent[] {
  return agents.filter(isValidAgent)
}

export function validateConversationHistory(
  messages: unknown[],
): ConversationMessage[] {
  return messages.filter(isValidConversationMessage)
}
