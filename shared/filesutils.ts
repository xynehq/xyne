export const isValidFile = (file: File) => {
  // Accept only text, image, pdf, docs, sheets, ppts, and check size limits
  const maxSize = 15 * 1024 * 1024 // 15MB limit

  // Allowed MIME types
  const allowedTypes = [
    "text/plain",
    "text/csv",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ]

  // Allowed extensions (for fallback)
  const allowedExtensions = [
    ".txt",
    ".csv",
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
  ]

  const allowedImageTypes = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/svg+xml",
    "image/tiff",
    "image/heic",
    "image/heif",
  ]

  // Check by MIME type or extension
  const isAllowedType =
    allowedTypes.includes(file.type) ||
    allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext)) ||
    allowedImageTypes.includes(file.type)

  return file.size <= maxSize && isAllowedType
}
