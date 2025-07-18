export const isValidFile = (file: File) => {
  // Set size limits
  const maxGeneralSize = 40 * 1024 * 1024 // 40MB
  const maxImageSize = 5 * 1024 * 1024 // 5MB

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
    "text/markdown",
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
    ".md",
  ]

  const allowedImageTypes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
  ]

  // Check by MIME type or extension
  const isImage = allowedImageTypes.includes(file.type)
  const isAllowedType =
    allowedTypes.includes(file.type) ||
    allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext)) ||
    isImage

  const sizeLimit = isImage ? maxImageSize : maxGeneralSize

  return file.size <= sizeLimit && isAllowedType
}
