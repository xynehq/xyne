import { MIME_TYPE_MAPPINGS, EXTENSION_MAPPINGS, FileType } from "./types"

// Check if file is an image
export const isImageFile = (fileType: string): boolean => {
  return (
    (MIME_TYPE_MAPPINGS[FileType.IMAGE] as readonly string[]).includes(fileType)
  )
}

export const getFileType = ({ type, name }: { type: string, name: string }): FileType => {
  const fileName = name.toLowerCase()
  const mimeType = type.toLowerCase()
  const baseMime = mimeType.split(";")[0]

  // Check each file type category using the mappings
  for (const [fileType, mimeTypes] of Object.entries(MIME_TYPE_MAPPINGS)) {
    // Check MIME type first (more reliable)
    if (mimeTypes.some(mime => baseMime === mime)) {
      return fileType as FileType
    }
  }

  // Fallback to extension-based detection
  for (const [fileType, extensions] of Object.entries(EXTENSION_MAPPINGS)) {
    if (extensions.some(ext => fileName.endsWith(ext))) {
      return fileType as FileType
    }
  }

  // Default fallback
  return FileType.FILE
}

export const isValidFile = (file: File) => {
  // Set size limits
  const maxGeneralSize = 40 * 1024 * 1024 // 40MB
  const maxImageSize = 5 * 1024 * 1024 // 5MB

  // Get all allowed MIME types from the centralized mappings
  const allowedMimeTypes = [
    ...MIME_TYPE_MAPPINGS[FileType.TEXT],
    ...MIME_TYPE_MAPPINGS[FileType.PDF],
    ...MIME_TYPE_MAPPINGS[FileType.DOCUMENT],
    ...MIME_TYPE_MAPPINGS[FileType.SPREADSHEET],
    ...MIME_TYPE_MAPPINGS[FileType.PRESENTATION],
    ...MIME_TYPE_MAPPINGS[FileType.IMAGE],
  ] as readonly string[]

  // Get all allowed extensions from the centralized mappings
  const allowedExtensions = [
    ...EXTENSION_MAPPINGS[FileType.TEXT],
    ...EXTENSION_MAPPINGS[FileType.PDF],
    ...EXTENSION_MAPPINGS[FileType.DOCUMENT],
    ...EXTENSION_MAPPINGS[FileType.SPREADSHEET],
    ...EXTENSION_MAPPINGS[FileType.PRESENTATION],
    ...EXTENSION_MAPPINGS[FileType.IMAGE],
  ] as readonly string[]

  // Check if file is an image using the centralized mapping
  const isImage = (MIME_TYPE_MAPPINGS[FileType.IMAGE] as readonly string[]).includes(file.type)
  
  // Check if file type is allowed by MIME type or extension
  const isAllowedType =
    allowedMimeTypes.includes(file.type) ||
    allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext))

  const sizeLimit = isImage ? maxImageSize : maxGeneralSize

  return file.size <= sizeLimit && isAllowedType
}
