
export const DATASOURCE_CONFIG = {
  // File size limits
  MAX_PDF_FILE_SIZE_MB: parseInt(
    process.env.DATASOURCE_MAX_PDF_FILE_SIZE_MB || "40",
    10,
  ),
  MAX_DOCX_FILE_SIZE_MB: parseInt(
    process.env.DATASOURCE_MAX_DOCX_FILE_SIZE_MB || "40",
    10,
  ),
  MAX_PPTX_FILE_SIZE_MB: parseInt(
    process.env.DATASOURCE_MAX_PPTX_FILE_SIZE_MB || "40",
    10,
  ),
  MAX_PPTX_TEXT_LEN: parseInt(
    process.env.DATASOURCE_MAX_PPTX_TEXT_LEN || "300000",
    10,
  ),
  MAX_SPREADSHEET_FILE_SIZE_MB: parseInt(
    process.env.DATASOURCE_MAX_SPREADSHEET_FILE_SIZE_MB || "10",
    10,
  ),
  MAX_TEXT_FILE_SIZE_MB: parseInt(
    process.env.DATASOURCE_MAX_TEXT_FILE_SIZE_MB || "40",
    10,
  ),
  MAX_CHUNK_SIZE: parseInt(process.env.DATASOURCE_MAX_CHUNK_SIZE || "512", 10),
  MAX_IMAGE_FILE_SIZE_MB: parseInt(
    process.env.DATASOURCE_MAX_IMAGE_FILE_SIZE_MB || "40",
    10,
  ),

  // Supported file types
  SUPPORTED_TEXT_TYPES: new Set([
    "text/plain",
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

  SUPPORTED_DOCX_TYPES: new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
    "application/msword", // .doc
  ]),

  SUPPORTED_PPTX_TYPES: new Set([
    "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
    "application/vnd.ms-powerpoint", // .ppt
  ]),

  SUPPORTED_IMAGE_TYPES: new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
  ]),
} as const

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

export const isImageFile = (mimeType: string): boolean => {
  const baseMimeType = getBaseMimeType(mimeType)
  return DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES.has(baseMimeType)
}

export const isDocxFile = (mimeType: string): boolean => {
  const baseMimeType = getBaseMimeType(mimeType)
  return DATASOURCE_CONFIG.SUPPORTED_DOCX_TYPES.has(baseMimeType)
}

export const isPptxFile = (mimeType: string): boolean => {
  const baseMimeType = getBaseMimeType(mimeType)
  return DATASOURCE_CONFIG.SUPPORTED_PPTX_TYPES.has(baseMimeType)
}

export const getSupportedFileTypes = (): string[] => [
  ...DATASOURCE_CONFIG.SUPPORTED_TEXT_TYPES,
  ...DATASOURCE_CONFIG.SUPPORTED_SHEET_TYPES,
  ...DATASOURCE_CONFIG.SUPPORTED_DOCX_TYPES,
  ...DATASOURCE_CONFIG.SUPPORTED_PPTX_TYPES,
  ...DATASOURCE_CONFIG.SUPPORTED_IMAGE_TYPES,
  "application/pdf",
]
