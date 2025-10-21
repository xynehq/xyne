import { MIME_TYPE_MAPPINGS, EXTENSION_MAPPINGS, FileType } from "./types"

// Check if file is an image
export const isImageFile = (fileType: string): boolean => {
  return (MIME_TYPE_MAPPINGS[FileType.IMAGE] as readonly string[]).includes(
    fileType,
  )
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
  const isImage = (
    MIME_TYPE_MAPPINGS[FileType.IMAGE] as readonly string[]
  ).includes(file.type)

  // Check if file type is allowed by MIME type or extension
  const isAllowedType =
    allowedMimeTypes.includes(file.type) ||
    allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext))

  const sizeLimit = isImage ? maxImageSize : maxGeneralSize

  return file.size <= sizeLimit && isAllowedType
}
