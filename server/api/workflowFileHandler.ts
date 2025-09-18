import { mkdir } from "node:fs/promises"
import path from "node:path"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { handleAttachmentUpload } from "./files"
import { type AttachmentMetadata } from "shared/types"

const Logger = getLogger(Subsystem.WorkflowApi)

export interface WorkflowFileUpload {
  originalFileName: string
  fileName: string
  fileSize: number
  mimetype: string
  absolutePath: string
  relativePath: string
  uploadedAt: string
  uploadedBy: string
  fileExtension: string
  workflowExecutionId: string
  workflowStepId: string
  attachmentId?: string
  attachmentMetadata?: AttachmentMetadata
}
  export interface WorkflowFileData {
    originalFileName: string
    fileName: string
    fileSize: number
    mimetype: string
    uploadedAt: string
    uploadedBy: string
    fileExtension: string
    workflowExecutionId: string
    workflowStepId: string
    attachmentId?: string
    attachmentMetadata?: AttachmentMetadata
  }

export interface AttachmentUploadResponse {
  success: boolean
  attachments: AttachmentMetadata[]
  message: string
}

export interface FileValidationRule {
  allowedTypes: string[]
  maxSize: number // in bytes
  required: boolean
}

export interface FormFieldValidation {
  type:
    | "text"
    | "number"
    | "email"
    | "dropdown"
    | "file"
    | "textarea"
    | "checkbox"
  required?: boolean
  minLength?: number
  maxLength?: number
  pattern?: string
  options?: Array<{ label: string; value: string }>
  fileValidation?: FileValidationRule
}

export interface FormValidationSchema {
  [fieldId: string]: FormFieldValidation
}

/**
 * Validate form field based on its configuration
 */
export function validateFormField(
  fieldId: string,
  value: any,
  validation: FormFieldValidation,
): { isValid: boolean; error?: string } {
  // Check required fields
  if (
    validation.required &&
    (!value || (typeof value === "string" && value.trim() === ""))
  ) {
    return { isValid: false, error: `Field '${fieldId}' is required` }
  }

  // If field is not required and empty, it's valid
  if (
    !validation.required &&
    (!value || (typeof value === "string" && value.trim() === ""))
  ) {
    return { isValid: true }
  }

  switch (validation.type) {
    case "text":
    case "textarea":
      if (typeof value !== "string") {
        return { isValid: false, error: `Field '${fieldId}' must be a string` }
      }
      if (validation.minLength && value.length < validation.minLength) {
        return {
          isValid: false,
          error: `Field '${fieldId}' must be at least ${validation.minLength} characters`,
        }
      }
      if (validation.maxLength && value.length > validation.maxLength) {
        return {
          isValid: false,
          error: `Field '${fieldId}' must be no more than ${validation.maxLength} characters`,
        }
      }
      if (validation.pattern) {
        const regex = new RegExp(validation.pattern)
        if (!regex.test(value)) {
          return {
            isValid: false,
            error: `Field '${fieldId}' format is invalid`,
          }
        }
      }
      break

    case "email":
      if (typeof value !== "string") {
        return { isValid: false, error: `Field '${fieldId}' must be a string` }
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(value)) {
        return {
          isValid: false,
          error: `Field '${fieldId}' must be a valid email address`,
        }
      }
      break

    case "number":
      if (typeof value !== "number" && !!isNaN(Number(value))) {
        return { isValid: false, error: `Field '${fieldId}' must be a number` }
      }
      break

    case "dropdown":
      if (!validation.options) {
        return {
          isValid: false,
          error: `Field '${fieldId}' has no options configured`,
        }
      }
      const validValues = validation.options.map((opt) => opt.value)
      if (!validValues.includes(value)) {
        return {
          isValid: false,
          error: `Field '${fieldId}' must be one of: ${validValues.join(", ")}`,
        }
      }
      break

    case "checkbox":
      // Handle checkbox values from form data - can be boolean, "on", "true", or undefined
      if (value === "on" || value === "true" || value === true) {
        return { isValid: true }
      } else if (
        value === "off" ||
        value === "false" ||
        value === false ||
        value === undefined ||
        value === null
      ) {
        return { isValid: true }
      } else {
        return {
          isValid: false,
          error: `Field '${fieldId}' must be a boolean value`,
        }
      }

    case "file":
      // File validation is handled separately in handleWorkflowFileUpload
      break

    default:
      return {
        isValid: false,
        error: `Field '${fieldId}' has unknown type: ${validation.type}`,
      }
  }

  return { isValid: true }
}

/**
 * Validate all form fields according to their schema
 */
export function validateFormData(
  formData: Record<string, any>,
  validationSchema: FormValidationSchema,
): { isValid: boolean; errors: string[] } {
  const errors: string[] = []

  for (const [fieldId, validation] of Object.entries(validationSchema)) {
    const value = formData[fieldId]
    const result = validateFormField(fieldId, value, validation)

    if (!result.isValid) {
      errors.push(result.error!)
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  }
}

/**
 * Validate file upload against rules
 */
export function validateFileUpload(
  file: File,
  validation: FileValidationRule,
): { isValid: boolean; error?: string } {
  // Check file size
  if (file.size > validation.maxSize) {
    const maxSizeMB = (validation.maxSize / (1024 * 1024)).toFixed(1)
    return {
      isValid: false,
      error: `File size ${(file.size / (1024 * 1024)).toFixed(1)}MB exceeds maximum allowed size of ${maxSizeMB}MB`,
    }
  }

  // Check file type
  const fileExtension = file.name.split(".").pop()?.toLowerCase() || ""
  const mimeTypeValid = validation.allowedTypes.some((type) => {
    if (type.includes("/")) {
      // MIME type check
      return file.type === type
    } else {
      // Extension check
      return fileExtension === type.toLowerCase()
    }
  })

  if (!mimeTypeValid) {
    return {
      isValid: false,
      error: `File type '${fileExtension}' not allowed. Allowed types: ${validation.allowedTypes.join(", ")}`,
    }
  }

  return { isValid: true }
}

/**
 * Handle workflow file uploads with proper directory structure
 */
export async function handleWorkflowFileUpload(
  file: File,
  workflowExecutionId: string,
  workflowStepId: string,
  validation?: FileValidationRule,
): Promise<WorkflowFileUpload> {
  // Validate file if validation rules provided
  if (validation) {
    const validationResult = validateFileUpload(file, validation)
    if (!validationResult.isValid) {
      throw new Error(validationResult.error)
    }
  }

  try {
    // Create workflow-specific directory structure: workflow_uploads/execution_id/step_id/
    const baseDir = "/tmp/workflow_uploads"
    const executionDir = path.join(baseDir, workflowExecutionId)
    const stepDir = path.join(executionDir, workflowStepId)

    await mkdir(stepDir, { recursive: true })

    // Generate unique filename with timestamp and random suffix
    const timestamp = Date.now()
    const randomSuffix = Math.random().toString(36).substr(2, 9)
    const fileExtension = file.name.split(".").pop()?.toLowerCase() || ""
    const fileName = `${timestamp}_${randomSuffix}_${file.name}`
    const filePath = path.join(stepDir, fileName)

    // Save file to disk
    const arrayBuffer = await file.arrayBuffer()
    await Bun.write(filePath, new Uint8Array(arrayBuffer))

    Logger.info(`Workflow file uploaded: ${filePath} (${file.size} bytes)`)

    const relativePath = path.join(
      "workflow_uploads",
      workflowExecutionId,
      workflowStepId,
      fileName,
    )

    return {
      originalFileName: file.name,
      fileName: fileName,
      fileSize: file.size,
      mimetype: file.type || getMimeTypeFromExtension(fileExtension),
      absolutePath: filePath,
      relativePath: relativePath,
      uploadedAt: new Date().toISOString(),
      uploadedBy: "workflow-system",
      fileExtension: fileExtension,
      workflowExecutionId: workflowExecutionId,
      workflowStepId: workflowStepId,
    }
  } catch (error) {
    Logger.error(error, "Workflow file upload failed")
    throw new Error(
      `File upload failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}


/**
 * Get MIME type from file extension
 */
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

/**
 * Build validation schema from form field definitions
 */
export function buildValidationSchema(formFields: any[]): FormValidationSchema {
  const schema: FormValidationSchema = {}

  for (const field of formFields) {
    const validation: FormFieldValidation = {
      type: field.type,
      required: field.required || false,
    }

    // Add type-specific validations
    if (field.validation) {
      if (field.validation.minLength)
        validation.minLength = field.validation.minLength
      if (field.validation.maxLength)
        validation.maxLength = field.validation.maxLength
      if (field.validation.pattern)
        validation.pattern = field.validation.pattern
    }

    // Add dropdown options
    if (field.options) {
      validation.options = field.options
    }

    // Add file validation
    if (field.type === "file") {
      validation.fileValidation = {
        allowedTypes: field.fileTypes || [],
        maxSize: parseFileSize(field.maxSize || "10MB"),
        required: field.required || false,
      }
    }

    schema[field.id] = validation
  }

  return schema
}

/**
 * Parse file size string to bytes
 */
function parseFileSize(sizeStr: string): number {
  const units: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
  }

  const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i)
  if (!match) {
    return 10 * 1024 * 1024 // Default 10MB
  }

  const size = parseFloat(match[1])
  const unit = match[2].toUpperCase()

  return Math.floor(size * (units[unit] || 1))
}

