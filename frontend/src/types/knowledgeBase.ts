// Shared types between frontend and backend
export interface KnowledgeBase {
  id: string;
  parentId: string | null;
  workspaceId: number;
  ownerId: number;
  name: string;
  description: string | null;
  type: "knowledge_base" | "folder" | "file";
  path: string;
  position: number;
  totalCount: number;
  isPrivate: boolean;
  lastUpdatedByEmail: string | null;
  lastUpdatedById: number | null;
  metadata: any;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface KbFile {
  id: string;
  itemId: string;
  vespaDocId: string;
  originalName: string;
  storagePath: string;
  storageKey: string;
  mimeType: string | null;
  fileSize: number | null;
  checksum: string | null;
  uploadedByEmail: string | null;
  uploadedById: number | null;
  lastUpdatedByEmail: string | null;
  lastUpdatedById: number | null;
  processingInfo: any;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface KbItem {
  id: string;
  parentId: string | null;
  workspaceId: number;
  ownerId: number;
  name: string;
  type: "knowledge_base" | "folder" | "file";
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
  children?: KbItem[];
}
