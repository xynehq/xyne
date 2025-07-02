import path from "path"

export const DATASOURCE_CONFIG = {
  // File size limits
  MAX_FILE_SIZE_MB: parseInt(
    process.env.DATASOURCE_MAX_FILE_SIZE_MB || "15",
    10,
  ),
  MAX_CHUNK_SIZE: parseInt(process.env.DATASOURCE_MAX_CHUNK_SIZE || "512", 10),

  // Supported file types
  SUPPORTED_TEXT_TYPES: new Set([
    "text/plain",
    "text/csv",
    "text/markdown",
    "text/html",
    "text/xml",
    "application/json",
  ]),

  SUPPORTED_SHEET_TYPES: new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
    "application/vnd.ms-excel", // .xls
    "text/csv",
  ]),

  SUPPORTED_OFFICE_TYPES: new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
    "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
    "application/msword", // .doc
    "application/vnd.ms-powerpoint", // .ppt
  ]),

  SUPPORTED_IMAGE_TYPES: new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/bmp",
    "image/tiff",
    "image/webp",
  ]),

  // Directories
  TEMP_DIR:
    process.env.DATASOURCE_TEMP_DIR || path.resolve(__dirname, "../../tmp"),

  // External tool paths
  LIBREOFFICE_PATHS: {
    darwin: "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    linux: "/usr/bin/soffice",
    win32: "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  } as const,

  // Processing options
  CONVERSION_TIMEOUT_MS: parseInt(
    process.env.DATASOURCE_CONVERSION_TIMEOUT_MS || "30000",
    10,
  ),
  CLEANUP_RETRY_ATTEMPTS: parseInt(
    process.env.DATASOURCE_CLEANUP_RETRY_ATTEMPTS || "3",
    10,
  ),

  // Validation
  MIN_CONTENT_LENGTH: parseInt(
    process.env.DATASOURCE_MIN_CONTENT_LENGTH || "10",
    10,
  ),
  MAX_FILENAME_LENGTH: parseInt(
    process.env.DATASOURCE_MAX_FILENAME_LENGTH || "255",
    10,
  ),
} as const

// Computed values
export const MAX_DATASOURCE_FILE_SIZE =
  DATASOURCE_CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024

// Utility function to extract base MIME type (remove parameters like charset)
export const getBaseMimeType = (rawMimeType: string): string => {
  return rawMimeType.split(";")[0].trim().toLowerCase()
}

// Helper functions for type checking
export const isTextFile = (mimeType: string): boolean => {
  const baseMimeType = getBaseMimeType(mimeType)
  return DATASOURCE_CONFIG.SUPPORTED_TEXT_TYPES.has(baseMimeType)
}

export const isSheetFile = (mimeType: string): boolean => {
  const baseMimeType = getBaseMimeType(mimeType)
  return DATASOURCE_CONFIG.SUPPORTED_SHEET_TYPES.has(baseMimeType)
}

export const isOfficeFile = (mimeType: string): boolean => {
  const baseMimeType = getBaseMimeType(mimeType)
  return DATASOURCE_CONFIG.SUPPORTED_OFFICE_TYPES.has(baseMimeType)
}

export const isImageFile = (mimeType: string): boolean => {
  const baseMimeType = getBaseMimeType(mimeType)
  return DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES.has(baseMimeType)
}

export const requiresConversion = (mimeType: string): boolean =>
  isOfficeFile(mimeType)

export const getSupportedFileTypes = (): string[] => [
  ...DATASOURCE_CONFIG.SUPPORTED_TEXT_TYPES,
  ...DATASOURCE_CONFIG.SUPPORTED_SHEET_TYPES,
  ...DATASOURCE_CONFIG.SUPPORTED_OFFICE_TYPES,
  ...DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES,
  "application/pdf",
]
