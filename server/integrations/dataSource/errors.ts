// Custom error classes for data source operations

export class DataSourceError extends Error {
  public readonly code: string
  public readonly userMessage: string

  constructor(message: string, code: string, userMessage?: string) {
    super(message)
    this.name = this.constructor.name
    this.code = code
    this.userMessage = userMessage || message
    Error.captureStackTrace(this, this.constructor)
  }
}

export class FileValidationError extends DataSourceError {
  constructor(message: string, userMessage?: string) {
    super(message, "FILE_VALIDATION_ERROR", userMessage)
  }
}

export class FileSizeExceededError extends FileValidationError {
  constructor(maxSizeMB: number, actualSizeMB: number) {
    const message = `File size ${actualSizeMB.toFixed(2)}MB exceeds maximum allowed limit of ${maxSizeMB}MB`
    super(message, `File is too large. Maximum allowed size is ${maxSizeMB}MB.`)
  }
}

// Specific PDF validation error when a single page exceeds client-side processing limits
export class PdfPageTooLargeError extends FileValidationError {
  constructor(pageNumber: number, maxSizeMB: number, actualBytes: number) {
    const actualMB = actualBytes / (1024 * 1024)
    const message = `PDF page ${pageNumber} size ${actualMB.toFixed(2)}MB exceeds maximum allowed per-page limit of ${maxSizeMB}MB`
    const userMessage = `One page in the PDF is too large (${actualMB.toFixed(2)}MB). Please compress or split the PDF so each page is under ${maxSizeMB}MB.`
    super(message, userMessage)
  }
}

export class UnsupportedFileTypeError extends FileValidationError {
  constructor(mimeType: string, supportedTypes: string[]) {
    const message = `Unsupported file type: ${mimeType}`
    const userMessage = `File type not supported. Supported types: ${supportedTypes.join(", ")}`
    super(message, userMessage)
  }
}

export class FileProcessingError extends DataSourceError {
  constructor(message: string, fileName?: string) {
    const fullMessage = fileName
      ? `Error processing file "${fileName}": ${message}`
      : message
    super(
      fullMessage,
      "FILE_PROCESSING_ERROR",
      "Failed to process the uploaded file.",
    )
  }
}

export class ContentExtractionError extends DataSourceError {
  constructor(message: string, fileType: string) {
    super(
      `Failed to extract content from ${fileType}: ${message}`,
      "CONTENT_EXTRACTION_ERROR",
      "Unable to extract readable content from the file.",
    )
  }
}

export class StorageError extends DataSourceError {
  constructor(message: string) {
    super(message, "STORAGE_ERROR", "Failed to save the processed file.")
  }
}

// Error factory functions
export const createFileValidationError = (file: File): FileValidationError => {
  if (!file?.name) {
    return new FileValidationError("Invalid file: missing name")
  }
  if (typeof file.size !== "number") {
    return new FileValidationError("Invalid file: missing size information")
  }
  if (typeof file.arrayBuffer !== "function") {
    return new FileValidationError("Invalid file: cannot read file contents")
  }
  if (file.size === 0) {
    return new FileValidationError("Empty files are not allowed")
  }

  return new FileValidationError("Unknown file validation error")
}

export const createFileSizeError = (
  size: number,
  maxSizeMB: number,
): FileSizeExceededError => {
  const actualSizeMB = size / (1024 * 1024)
  return new FileSizeExceededError(maxSizeMB, actualSizeMB)
}

export const createUnsupportedTypeError = (
  mimeType: string,
  supportedTypes: string[],
): UnsupportedFileTypeError => {
  return new UnsupportedFileTypeError(mimeType, supportedTypes)
}

// Error handler utility
export const handleDataSourceError = (
  error: unknown,
  fileName?: string,
): DataSourceError => {
  if (error instanceof DataSourceError) {
    return error
  }

  if (error instanceof Error) {
    // Convert common Node.js errors to our custom errors
    if (error.message.includes("ENOENT")) {
      return new FileProcessingError("File not found", fileName)
    }
    if (error.message.includes("EACCES")) {
      return new FileProcessingError("Permission denied", fileName)
    }
    if (error.message.includes("EMFILE") || error.message.includes("ENFILE")) {
      return new FileProcessingError("Too many open files", fileName)
    }

    return new FileProcessingError(error.message, fileName)
  }

  return new FileProcessingError("Unknown error occurred", fileName)
}

// Type guard
export const isDataSourceError = (error: unknown): error is DataSourceError => {
  return error instanceof DataSourceError
}
