import { isValidFile, isImageFile } from "shared/fileUtils"
import { SelectedFile } from "@/components/ClFileUpload"
import { authFetch } from "./authFetch"
import { UploadStatus } from "shared/types"

// Generate unique ID for files
export const generateFileId = () => Math.random().toString(36).substring(2, 9)

// Create preview URL for image files
export const createImagePreview = (file: File): string | undefined => {
  if (isImageFile(file.type)) {
    return URL.createObjectURL(file)
  }
  return undefined
}

// Clean up preview URLs to prevent memory leaks
export const cleanupPreviewUrls = (previews: string[]) => {
  previews.forEach((url) => {
    if (url) {
      URL.revokeObjectURL(url)
    }
  })
}

// Common drag and drop handlers
export const createDragHandlers = () => {
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
  }

  return { handleDragOver, handleDragLeave }
}

// Common file selection handlers
export const createFileSelectionHandlers = (
  fileInputRef: React.RefObject<HTMLInputElement>,
  processFiles: (files: FileList | File[]) => void,
) => {
  const handleFileSelect = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      processFiles(files)
    }
    // Reset the input value so the same file can be selected again
    e.target.value = ""
  }

  return { handleFileSelect, handleFileChange }
}

// Common file validation and deduplication logic
export const validateAndDeduplicateFiles = (
  files: FileList | File[],
  toast: {
    error: (options: { title: string; description: string }) => void;
    warning: (options: { title: string; description: string }) => void;
  },
) => {
  const fileArray = Array.from(files).filter(
    (file) => !file.name.startsWith("."),
  )

  const validFiles = fileArray.filter(isValidFile)
  const invalidFiles = fileArray.length - validFiles.length

  if (invalidFiles > 0) {
    toast.error({
      title: "Invalid file(s)",
      description: `${invalidFiles} file(s) ignored. Files must be under 40MB, images under 5MB and of supported types.`,
    })
  }

  if (validFiles.length === 0) return []

  // Create a map to track files by name for deduplication
  const fileMap = new Map<string, File>()
  let duplicateCount = 0

  // Keep only the first occurrence of each filename
  validFiles.forEach((file) => {
    if (!fileMap.has(file.name)) {
      fileMap.set(file.name, file)
    } else {
      duplicateCount++
    }
  })

  // Notify about duplicates if any were found
  if (duplicateCount > 0) {
    toast.warning({
      title: "Duplicate files",
      description: `${duplicateCount} duplicate file(s) were ignored.`,
    })
  }

  return Array.from(fileMap.values())
}


// build file tree
export interface FileNode {
  id?: string
  name: string
  type: "folder" | "file"
  children?: FileNode[]
  files?: number
  lastUpdated?: string
  updatedBy?: string
  isOpen?: boolean
  uploadStatus?: UploadStatus
  statusMessage?: string
  retryCount?: number
}

export const buildFileTree = (
  files: {
    id?: string
    name: string
    type: "file" | "folder"
    totalFileCount?: number
    updatedAt?: string
    updatedBy?: string
    uploadStatus?: UploadStatus
    statusMessage?: string
    retryCount?: number
  }[],
): FileNode[] => {
  const root: FileNode = {
    name: "root",
    type: "folder",
    children: [],
    files: 0,
    lastUpdated: "",
    updatedBy: "",
  }

  for (const file of files) {
    const parts = file.name.split("/")
    let currentNode = root

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isFile = i === parts.length - 1

      let childNode = currentNode.children?.find((child) => child.name === part)

      if (!childNode) {
        childNode = {
          id: isFile && file.id ? file.id : undefined,
          name: part,
          type: isFile ? file.type : "folder",
          children: isFile ? undefined : [],
          files: file.totalFileCount,
          lastUpdated: file.updatedAt,
          updatedBy: file.updatedBy,
          uploadStatus: file.uploadStatus,
          statusMessage: file.statusMessage,
          retryCount: file.retryCount,
        }
        if (!currentNode.children) {
          currentNode.children = []
        }
        currentNode.children.push(childNode)
        currentNode.children.sort((a, b) => {
          if (a.type === "folder" && b.type === "file") return -1
          if (a.type === "file" && b.type === "folder") return 1
          return a.name.localeCompare(b.name)
        })
      }

      if (childNode.type === "folder") {
        currentNode = childNode
      }
    }
  }

  return root.children || []
}

// API functions for Collection operations
export const uploadFileBatch = async (
  files: File[],
  collectionId: string,
  parentId?: string | null,
  abortSignal?: AbortSignal,
): Promise<any> => {
  const formData = new FormData()

  // If parentId is provided, add it to formData
  if (parentId !== undefined && parentId !== null) {
    formData.append("parentId", parentId)
  }

  // Add files with their paths
  files.forEach((file) => {
    formData.append("files", file)
    // Add file paths if available (for maintaining folder structure)
    const relativePath = (file as any).webkitRelativePath || file.name
    formData.append("paths", relativePath)
  })

  try {
    const response = await authFetch(
      `/api/v1/cl/${collectionId}/items/upload`,
      {
        method: "POST",
        body: formData,
        signal: abortSignal,
      },
    )

    const responseText = await response.text()

    if (!response.ok) {
      throw new Error(
        `Upload failed: ${response.status} ${response.statusText} - ${responseText}`,
      )
    }

    try {
      return JSON.parse(responseText)
    } catch (e) {
      console.error("Failed to parse response as JSON:", e)
      return { success: true, message: responseText }
    }
  } catch (error) {
    console.error("Upload error:", error)
    throw error
  }
}

export const createCollection = async (
  name: string,
  description?: string,
): Promise<any> => {
  const response = await authFetch("/api/v1/cl", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      description,
      isPrivate: true,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Failed to create collection: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }

  return response.json()
}

export const deleteCollection = async (collectionId: string): Promise<void> => {
  const response = await authFetch(`/api/v1/cl/${collectionId}`, {
    method: "DELETE",
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Failed to delete collection: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }
}

export const deleteItem = async (
  collectionId: string,
  itemId: string,
): Promise<void> => {
  const response = await authFetch(
    `/api/v1/cl/${collectionId}/items/${itemId}`,
    {
      method: "DELETE",
    },
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Failed to delete item: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }
}

export const addFilesToExistingCollection = async (
  files: SelectedFile[],
  collectionId: string,
  parentId?: string | null,
): Promise<any> => {
  return uploadFileBatch(
    files.map((f) => f.file),
    collectionId,
    parentId,
  )
}
