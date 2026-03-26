import type { Apps, Entity } from "@xyne/vespa-ts/types"

/**
 * A citation for attribution
 */
export interface Citation {
  /** Document identifier */
  docId: string
  
  /** Human-readable title */
  title?: string
  
  /** URL to source */
  url?: string
  
  /** Application source */
  app: Apps
  
  /** Entity type */
  entity: Entity
  
  /** Chunk/index within document */
  chunkIndex?: number
  
  /** Thread ID (for threaded content like email/Slack) */
  threadId?: string
  
  /** Additional metadata */
  metadata?: CitationMetadata
}

export interface CitationMetadata {
  pageTitle?: string
  itemId?: string
  collectionId?: string
  createdAt?: string
  resolvedAt?: string
  status?: string
  ticketNumber?: string
  [key: string]: unknown
}

/**
 * Image citation for inline image references
 */
export interface ImageCitation {
  citationKey: string
  imagePath: string
  imageData: string
  item: Citation
  mimeType?: string
}

/**
 * Chunk-level citation (e.g., K[1_0])
 */
export interface ChunkCitation {
  docIndex: number
  chunkIndex: number
  fragmentId: string
  source: Citation
}

/**
 * Formatted citation for client display
 */
export interface FormattedCitation {
  index: number
  docId: string
  title: string
  url?: string
  app: string
  entity: string
  snippet?: string
}
