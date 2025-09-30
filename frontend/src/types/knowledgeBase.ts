import { UploadStatus } from "shared/types"

export interface Collection {
  id: string
  workspaceId: number
  ownerId: number
  name: string
  description: string | null
  vespaDocId: string
  isPrivate: boolean
  totalItems: number
  lastUpdatedByEmail: string | null
  lastUpdatedById: number | null
  metadata: any
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  // Legacy compatibility fields
  totalCount?: number // alias for totalItems
}

export interface CollectionItem {
  id: string
  collectionId: string // Reference to the collection
  parentId: string | null
  workspaceId: number
  ownerId: number
  name: string
  type: "folder" | "file" // Only folder and file types
  path: string
  position: number
  vespaDocId: string | null

  // File-specific fields (when type === "file")
  originalName?: string | null
  storagePath?: string | null
  storageKey?: string | null
  mimeType?: string | null
  fileSize?: number | null
  checksum?: string | null
  uploadedByEmail?: string | null
  uploadedById?: number | null

  lastUpdatedByEmail: string | null
  lastUpdatedById: number | null
  processingInfo: any
  processedAt: string | null
  metadata: any
  createdAt: string
  updatedAt: string
  deletedAt: string | null

  // Additional fields for frontend display
  totalFileCount?: number
  files?: number
  lastUpdated?: string
  updatedBy?: string
  isOpen?: boolean
  children?: CollectionItem[]
  uploadStatus?: UploadStatus
  statusMessage?: string
  retryCount?: number
}

// Type alias for files
export interface File extends CollectionItem {
  type: "file"
  originalName: string | null
  storagePath: string | null
  storageKey: string | null
  mimeType: string | null
  fileSize: number | null
  checksum: string | null
  uploadedByEmail: string | null
  uploadedById: number | null
}

// Type alias for folders
export interface Folder extends CollectionItem {
  type: "folder"
}

// Legacy types for backward compatibility during transition
export type KnowledgeBase = Collection
export type ClItem = CollectionItem
export type ClFile = File
export type ClFolder = Folder

export interface LegacyKbItem {
  id: string
  parentId: string | null
  workspaceId: number
  ownerId: number
  name: string
  type: "knowledge_base" | "folder" | "file" // Old unified type
  path: string
  position: number
  totalCount?: number
  isPrivate: boolean
  lastUpdatedByEmail: string | null
  lastUpdatedById: number | null
  metadata: any
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  // Additional fields for frontend display
  files?: number
  lastUpdated?: string
  updatedBy?: string
  isOpen?: boolean
  children?: LegacyKbItem[]
}
