import type { Citation } from "./citation"

/**
 * A fragment of context retrieved for the chat
 */
export interface Fragment {
  /** Unique identifier for this fragment */
  id: string
  
  /** Text content of the fragment */
  content: string
  
  /** Source citation for attribution */
  source: Citation
  
  /** Relevance confidence score (0-1) */
  confidence: number
  
  /** Optional associated images */
  images?: FragmentImage[]
  
  /** Metadata for ranking/filtering */
  metadata?: FragmentMetadata
}

export interface FragmentImage {
  fileName: string
  filePath?: string
  addedAtTurn: number
  sourceFragmentId: string
  sourceToolName: string
  isUserAttachment: boolean
}

export interface FragmentMetadata {
  chunkIndex?: number
  totalChunks?: number
  timestamp?: string
  author?: string
  app?: string
  entity?: string
  [key: string]: unknown
}

/**
 * Collection of fragments from a single retrieval source
 */
export interface FragmentCollection {
  source: RetrievalSource
  fragments: Fragment[]
  query: string
  timestamp: Date
}

export enum RetrievalSource {
  Vespa = "vespa",
  KnowledgeBase = "knowledge-base",
  Attachment = "attachment",
  Memory = "memory",
  Web = "web",
  Notion = "notion",
  Confluence = "confluence",
  Custom = "custom",
}
