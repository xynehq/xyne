/**
 * Interface for the data cached for each search interaction.
 */
export interface SearchCacheEntry {
  query: string;
  results: any[];
  timestamp: number;
  isFromThread: boolean;
}

/**
 * Interface for the data cached for each agent interaction.
 */
export interface AgentCacheEntry {
  query: string;
  agentName: string;
  response: string;
  citations: any[];
  timestamp: number;
  isFromThread: boolean;
}

export interface DbUser {
  id: number;
  name: string;
  email: string;
  externalId: string;
  workspaceId: number;
  workspaceExternalId: string;
  role: string;
}
