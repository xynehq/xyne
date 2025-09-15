import { mkdir } from "node:fs/promises"
import path from "node:path"
import crypto from "crypto"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { FileProcessorService } from "@/services/fileProcessor"
import { insert } from "@/search/vespa"
import { Apps, KbItemsSchema, KnowledgeBaseEntity } from "@/search/types"
import { getBaseMimeType } from "@/integrations/dataSource/config"
import type { WorkflowFileUpload, FileValidationRule } from "./workflowFileHandler"

const Logger = getLogger(Subsystem.WorkflowApi)

// Enhanced workflow file upload with KB-style processing
const WORKFLOW_STORAGE_ROOT = path.join(process.cwd(), "storage", "workflow_files")

export interface EnhancedWorkflowFileUpload extends WorkflowFileUpload {
  vespaDocId: string
  checksum: string
  processedChunks: number
  imageChunks: number
  isSearchable: boolean
  contentExtracted: boolean
}

export interface WorkflowFileAccessInfo {
  fileId: string
  vespaDocId: string
  fileName: string
  content: string // Extracted text content
  chunks: string[]
  imageChunks: string[]
  metadata: Record<string, any>
  mimeType: string
  fileSize: number
  uploadedAt: string
}

/**
 * Calculate file checksum for duplicate detection
 */
function calculateChecksum(buffer: ArrayBuffer): string {
  const hash = crypto.createHash("sha256")
  hash.update(new Uint8Array(buffer))
  return hash.digest("hex")
}

/**
 * Generate unique Vespa document ID for workflow files
 */
function generateWorkflowVespaDocId(): string {
  return `workflow_file_${crypto.randomUUID()}`
}

/**
 * Get storage path for workflow files with organized structure
 */
function getWorkflowStoragePath(
  executionId: string,
  stepId: string,
  fileName: string,
): string {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  
  return path.join(
    WORKFLOW_STORAGE_ROOT,
    executionId,
    stepId,
    year.toString(),
    month,
    fileName,
  )
}

/**
 * Enhanced workflow file upload with KB-style processing and Vespa integration
 */
export async function handleEnhancedWorkflowFileUpload(
  file: File,
  workflowExecutionId: string,
  workflowStepId: string,
  userEmail: string = "workflow-system",
  validation?: FileValidationRule,
): Promise<EnhancedWorkflowFileUpload> {
  // Validate file if validation rules provided
  if (validation) {
    const { validateFileUpload } = await import("./workflowFileHandler")
    const validationResult = validateFileUpload(file, validation)
    if (!validationResult.isValid) {
      throw new Error(validationResult.error)
    }
  }

  try {
    // Read file content and calculate checksum
    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const checksum = calculateChecksum(arrayBuffer)

    // Generate unique identifiers
    const vespaDocId = generateWorkflowVespaDocId()
    const timestamp = Date.now()
    const randomSuffix = Math.random().toString(36).substr(2, 9)
    const fileExtension = file.name.split(".").pop()?.toLowerCase() || ""
    const uniqueFileName = `${timestamp}_${randomSuffix}_${file.name}`

    // Calculate storage path
    const storagePath = getWorkflowStoragePath(
      workflowExecutionId,
      workflowStepId,
      uniqueFileName,
    )

    // Ensure directory exists
    await mkdir(path.dirname(storagePath), { recursive: true })

    // Write file to disk
    await Bun.write(storagePath, new Uint8Array(buffer))

    // Process file content using the same service as Knowledge Base
    const processingResult = await FileProcessorService.processFile(
      buffer,
      file.type || "text/plain",
      file.name,
      vespaDocId,
      storagePath,
    )

    const { chunks, chunks_pos, image_chunks, image_chunks_pos } = processingResult

    // Create Vespa document for workflow file
    const vespaDoc = {
      docId: vespaDocId,
      clId: workflowExecutionId, // Use execution ID as collection ID
      itemId: `${workflowExecutionId}_${workflowStepId}_${timestamp}`,
      fileName: `Workflow/${workflowExecutionId}/${workflowStepId}/${file.name}`,
      app: Apps.KnowledgeBase as const,
      entity: KnowledgeBaseEntity.File,
      description: `Workflow file uploaded in step ${workflowStepId}`,
      storagePath: storagePath,
      chunks: chunks,
      chunks_pos: chunks_pos,
      image_chunks: image_chunks,
      image_chunks_pos: image_chunks_pos,
      metadata: JSON.stringify({
        workflowExecutionId,
        workflowStepId,
        originalFileName: file.name,
        uploadedBy: userEmail,
        chunksCount: chunks.length,
        imageChunksCount: image_chunks.length,
        processingMethod: getBaseMimeType(file.type || "text/plain"),
        isWorkflowFile: true,
        workflowContext: "form_upload",
        lastModified: Date.now(),
      }),
      createdBy: userEmail,
      duration: 0,
      mimeType: getBaseMimeType(file.type || "text/plain"),
      fileSize: file.size,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    // Insert into Vespa for searchability
    await insert(vespaDoc, KbItemsSchema)

    Logger.info(
      `Enhanced workflow file uploaded and processed: ${storagePath} (${file.size} bytes, ${chunks.length} text chunks, ${image_chunks.length} image chunks)`,
    )

    const relativePath = path.relative(process.cwd(), storagePath)

    return {
      originalFileName: file.name,
      fileName: uniqueFileName,
      fileSize: file.size,
      mimetype: file.type || getMimeTypeFromExtension(fileExtension),
      absolutePath: storagePath,
      relativePath: relativePath,
      uploadedAt: new Date().toISOString(),
      uploadedBy: userEmail,
      fileExtension: fileExtension,
      workflowExecutionId: workflowExecutionId,
      workflowStepId: workflowStepId,
      vespaDocId: vespaDocId,
      checksum: checksum,
      processedChunks: chunks.length,
      imageChunks: image_chunks.length,
      isSearchable: true,
      contentExtracted: chunks.length > 0 || image_chunks.length > 0,
    }
  } catch (error) {
    Logger.error(error, "Enhanced workflow file upload failed")
    throw new Error(
      `Enhanced file upload failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Retrieve workflow file content for AI/email nodes
 */
export async function getWorkflowFileContent(
  vespaDocId: string,
): Promise<WorkflowFileAccessInfo | null> {
  try {
    // Get document from Vespa
    const { GetDocument } = await import("@/search/vespa")
    const vespaDoc = await GetDocument(KbItemsSchema, vespaDocId)
    
    if (!vespaDoc || !vespaDoc.fields) {
      return null
    }

    const fields = vespaDoc.fields as any
    const metadata = JSON.parse(fields.metadata || "{}")

    // Combine all text chunks into full content
    const textContent = (fields.chunks || []).join("\n")
    
    return {
      fileId: fields.itemId,
      vespaDocId: vespaDocId,
      fileName: metadata.originalFileName || fields.fileName,
      content: textContent,
      chunks: fields.chunks || [],
      imageChunks: fields.image_chunks || [],
      metadata: metadata,
      mimeType: fields.mimeType,
      fileSize: fields.fileSize,
      uploadedAt: new Date(fields.createdAt).toISOString(),
    }
  } catch (error) {
    Logger.error(error, `Failed to retrieve workflow file content: ${vespaDocId}`)
    return null
  }
}

/**
 * Get all files uploaded in a specific workflow execution
 */
export async function getWorkflowExecutionFiles(
  executionId: string,
): Promise<WorkflowFileAccessInfo[]> {
  try {
    // Search Vespa for files in this execution
    const { searchVespaAgent, Apps } = await import("@/search/vespa")
    
    const searchResult = await searchVespaAgent(
      `clId:${executionId}`, // Search by collection ID (execution ID)
      "workflow-system",
      Apps.KnowledgeBase,
      KnowledgeBaseEntity.File,
      [Apps.KnowledgeBase],
      { limit: 100 }
    )

    const files: WorkflowFileAccessInfo[] = []
    
    if (searchResult.root?.children) {
      for (const child of searchResult.root.children) {
        const fields = child.fields as any
        if (fields) {
          const metadata = JSON.parse(fields.metadata || "{}")
          const textContent = (fields.chunks || []).join("\n")
          
          files.push({
            fileId: fields.itemId,
            vespaDocId: fields.docId,
            fileName: metadata.originalFileName || fields.fileName,
            content: textContent,
            chunks: fields.chunks || [],
            imageChunks: fields.image_chunks || [],
            metadata: metadata,
            mimeType: fields.mimeType,
            fileSize: fields.fileSize,
            uploadedAt: new Date(fields.createdAt).toISOString(),
          })
        }
      }
    }

    return files
  } catch (error) {
    Logger.error(error, `Failed to retrieve workflow execution files: ${executionId}`)
    return []
  }
}

/**
 * Get all files uploaded in a specific workflow step
 */
export async function getWorkflowStepFiles(
  executionId: string,
  stepId: string,
): Promise<WorkflowFileAccessInfo[]> {
  const allFiles = await getWorkflowExecutionFiles(executionId)
  return allFiles.filter(file => file.metadata.workflowStepId === stepId)
}

/**
 * Search workflow files by content
 */
export async function searchWorkflowFiles(
  query: string,
  executionId?: string,
  limit: number = 10,
): Promise<WorkflowFileAccessInfo[]> {
  try {
    const { searchVespaAgent, Apps } = await import("@/search/vespa")
    
    // Build search query
    let searchQuery = query
    if (executionId) {
      searchQuery = `${query} AND clId:${executionId}`
    }
    
    const searchResult = await searchVespaAgent(
      searchQuery,
      "workflow-system",
      Apps.KnowledgeBase,
      KnowledgeBaseEntity.File,
      [Apps.KnowledgeBase],
      { limit }
    )

    const files: WorkflowFileAccessInfo[] = []
    
    if (searchResult.root?.children) {
      for (const child of searchResult.root.children) {
        const fields = child.fields as any
        if (fields && fields.metadata) {
          const metadata = JSON.parse(fields.metadata)
          // Only include workflow files
          if (metadata.isWorkflowFile) {
            const textContent = (fields.chunks || []).join("\n")
            
            files.push({
              fileId: fields.itemId,
              vespaDocId: fields.docId,
              fileName: metadata.originalFileName || fields.fileName,
              content: textContent,
              chunks: fields.chunks || [],
              imageChunks: fields.image_chunks || [],
              metadata: metadata,
              mimeType: fields.mimeType,
              fileSize: fields.fileSize,
              uploadedAt: new Date(fields.createdAt).toISOString(),
            })
          }
        }
      }
    }

    return files
  } catch (error) {
    Logger.error(error, `Failed to search workflow files: ${query}`)
    return []
  }
}

/**
 * Helper function for AI nodes to get file content as context
 */
export async function getWorkflowFilesAsContext(
  executionId: string,
  stepId?: string,
): Promise<string> {
  const files = stepId 
    ? await getWorkflowStepFiles(executionId, stepId)
    : await getWorkflowExecutionFiles(executionId)
  
  if (files.length === 0) {
    return "No files available in this workflow."
  }

  let context = "Available files in this workflow:\n\n"
  
  for (const file of files) {
    context += `File: ${file.fileName}\n`
    context += `Type: ${file.mimeType}\n`
    context += `Size: ${(file.fileSize / 1024).toFixed(1)} KB\n`
    context += `Uploaded: ${file.uploadedAt}\n`
    
    if (file.content && file.content.length > 0) {
      // Truncate content for context (similar to current AI processing)
      const truncatedContent = file.content.slice(0, 4000)
      context += `Content preview:\n${truncatedContent}\n`
      if (file.content.length > 4000) {
        context += `... (content truncated, full content available via file search)\n`
      }
    }
    
    context += "\n---\n\n"
  }
  
  return context
}

// Utility function for MIME type detection (reused from original)
function getMimeTypeFromExtension(extension: string): string {
  const mimeTypes: Record<string, string> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    xml: "application/xml",
  }

  return mimeTypes[extension.toLowerCase()] || "application/octet-stream"
}