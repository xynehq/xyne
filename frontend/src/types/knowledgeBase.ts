// Updated types for the new schema structure
export interface KnowledgeBase {
  id: string;
  workspaceId: number;
  ownerId: number;
  name: string;
  description: string | null;
  vespaDocId: string;
  isPrivate: boolean;
  totalItems: number;
  lastUpdatedByEmail: string | null;
  lastUpdatedById: number | null;
  metadata: any;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  // Legacy compatibility fields
  totalCount?: number; // alias for totalItems
}

export interface KbItem {
  id: string;
  kbId: string; // Reference to the knowledge base
  parentId: string | null;
  workspaceId: number;
  ownerId: number;
  name: string;
  type: "folder" | "file"; // Only folder and file, no knowledge_base
  path: string;
  position: number;
  vespaDocId: string | null;
  
  // File-specific fields (when type === "file")
  originalName?: string | null;
  storagePath?: string | null;
  storageKey?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  checksum?: string | null;
  uploadedByEmail?: string | null;
  uploadedById?: number | null;
  
  lastUpdatedByEmail: string | null;
  lastUpdatedById: number | null;
  processingInfo: any;
  processedAt: string | null;
  metadata: any;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  
  // Additional fields for frontend display
  totalCount?: number;
  files?: number;
  lastUpdated?: string;
  updatedBy?: string;
  isOpen?: boolean;
  children?: KbItem[];
}

// Type alias for files
export interface KbFile extends KbItem {
  type: "file";
  originalName: string | null;
  storagePath: string | null;
  storageKey: string | null;
  mimeType: string | null;
  fileSize: number | null;
  checksum: string | null;
  uploadedByEmail: string | null;
  uploadedById: number | null;
}

// Type alias for folders
export interface KbFolder extends KbItem {
  type: "folder";
}

// Legacy type for backward compatibility during transition
export interface LegacyKbItem {
  id: string;
  parentId: string | null;
  workspaceId: number;
  ownerId: number;
  name: string;
  type: "knowledge_base" | "folder" | "file"; // Old unified type
  path: string;
  position: number;
  totalCount?: number;
  isPrivate: boolean;
  lastUpdatedByEmail: string | null;
  lastUpdatedById: number | null;
  metadata: any;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  // Additional fields for frontend display
  files?: number;
  lastUpdated?: string;
  updatedBy?: string;
  isOpen?: boolean;
  children?: LegacyKbItem[];
}
