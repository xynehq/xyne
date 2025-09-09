import { mkdir } from "node:fs/promises"
import path from "node:path"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { isValidFile } from "shared/fileUtils"
import { HTTPException } from "hono/http-exception"

const Logger = getLogger(Subsystem.WorkflowApi)

export interface WorkflowFileUpload {
  fileId: string
  originalName: string
  fileName: string
  filePath: string
  relativePath: string
  fileSize: number
  fileType: string
  workflowExecutionId: string
  stepExecutionId: string
  uploadedAt: Date
}

export interface FileValidation {
  maxSize?: number
  allowedTypes?: string[]
  required?: boolean
}

export interface ValidationSchema {
  [fieldId: string]: {
    required?: boolean
    type?: string
    fileValidation?: FileValidation
  }
}

export interface FormValidationResult {
  isValid: boolean
  errors: string[]
}

// Base directory for workflow file uploads
const WORKFLOW_FILES_DIR = path.join(process.cwd(), "uploads", "workflows")

// Ensure uploads directory exists
await mkdir(WORKFLOW_FILES_DIR, { recursive: true })

/**
 * Handle file upload for workflow forms
 */
export const handleWorkflowFileUpload = async (
  file: File,
  workflowExecutionId: string,
  stepExecutionId: string,
  validation?: FileValidation
): Promise<WorkflowFileUpload> => {
  try {
    // Validate file against general rules
    if (!isValidFile(file)) {
      throw new Error("File does not meet general validation requirements")
    }

    // Apply custom validation if provided
    if (validation) {
      if (validation.maxSize && file.size > validation.maxSize) {
        throw new Error(`File size ${file.size} exceeds maximum allowed size ${validation.maxSize}`)
      }

      if (validation.allowedTypes && validation.allowedTypes.length > 0) {
        const fileExtension = file.name.split('.').pop()?.toLowerCase()
        const mimeTypeMatch = validation.allowedTypes.some(type => 
          file.type.includes(type) || (fileExtension && type.includes(fileExtension))
        )
        if (!mimeTypeMatch) {
          throw new Error(`File type ${file.type} is not allowed. Allowed types: ${validation.allowedTypes.join(', ')}`)
        }
      }
    }

    // Generate unique file ID and create directory structure
    const fileId = `wf_${Date.now()}_${crypto.randomUUID()}`
    const fileExtension = file.name.split('.').pop() || 'bin'
    const fileName = `${fileId}.${fileExtension}`
    
    // Create directory structure: workflows/{executionId}/{stepId}/
    const executionDir = path.join(WORKFLOW_FILES_DIR, workflowExecutionId)
    const stepDir = path.join(executionDir, stepExecutionId)
    await mkdir(stepDir, { recursive: true })
    
    const filePath = path.join(stepDir, fileName)
    const relativePath = path.relative(WORKFLOW_FILES_DIR, filePath)

    // Write file to disk
    const fileBuffer = await file.arrayBuffer()
    await Bun.write(filePath, new Uint8Array(fileBuffer))

    Logger.info(`Workflow file uploaded: ${fileName} to ${relativePath}`)

    const uploadResult: WorkflowFileUpload = {
      fileId,
      originalName: file.name,
      fileName,
      filePath,
      relativePath,
      fileSize: file.size,
      fileType: file.type,
      workflowExecutionId,
      stepExecutionId,
      uploadedAt: new Date()
    }

    return uploadResult
  } catch (error) {
    Logger.error(error, `Failed to upload workflow file: ${file.name}`)
    throw error
  }
}

/**
 * Build validation schema from form fields
 */
export const buildValidationSchema = (formFields: any[]): ValidationSchema => {
  const schema: ValidationSchema = {}

  for (const field of formFields) {
    schema[field.id] = {
      required: field.required || false,
      type: field.type
    }

    // Add file-specific validation
    if (field.type === 'file') {
      schema[field.id].fileValidation = {
        maxSize: field.maxSize,
        allowedTypes: field.allowedTypes,
        required: field.required || false
      }
    }
  }

  return schema
}

/**
 * Validate form data against schema
 */
export const validateFormData = (
  formData: any,
  validationSchema: ValidationSchema
): FormValidationResult => {
  const errors: string[] = []

  for (const [fieldId, rules] of Object.entries(validationSchema)) {
    const value = formData[fieldId]

    // Check required fields
    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push(`Field '${fieldId}' is required`)
      continue
    }

    // Skip further validation if field is not required and empty
    if (!rules.required && (value === undefined || value === null || value === '')) {
      continue
    }

    // Type-specific validation
    if (rules.type === 'email' && value) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(value)) {
        errors.push(`Field '${fieldId}' must be a valid email address`)
      }
    }

    if (rules.type === 'number' && value) {
      if (isNaN(Number(value))) {
        errors.push(`Field '${fieldId}' must be a valid number`)
      }
    }

    if (rules.type === 'url' && value) {
      try {
        new URL(value)
      } catch {
        errors.push(`Field '${fieldId}' must be a valid URL`)
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  }
}