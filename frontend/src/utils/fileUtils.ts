import { isValidFile } from "../../../shared/filesutils"

// Generate unique ID for files
export const generateFileId = () => Math.random().toString(36).substring(2, 9)

// Check if file is an image
const isImageFile = (file: File): boolean => {
  return (
    file.type.startsWith("image/") &&
    [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/webp",
    ].includes(file.type)
  )
}

// Create preview URL for image files
export const createImagePreview = (file: File): string | undefined => {
  if (isImageFile(file)) {
    return URL.createObjectURL(file)
  }
  return undefined
}

// Clean up preview URLs to prevent memory leaks
export const cleanupPreviewUrls = (previews: string[]) => {
  previews.forEach((url) => {
    if (url) {
      URL.revokeObjectURL(url)
    }
  })
}

// Common drag and drop handlers
export const createDragHandlers = () => {
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
  }

  return { handleDragOver, handleDragLeave }
}

// Common file selection handlers
export const createFileSelectionHandlers = (
  fileInputRef: React.RefObject<HTMLInputElement>,
  processFiles: (files: FileList | File[]) => void,
) => {
  const handleFileSelect = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      processFiles(files)
    }
    // Reset the input value so the same file can be selected again
    e.target.value = ""
  }

  return { handleFileSelect, handleFileChange }
}

// Common file validation and deduplication logic
export const validateAndDeduplicateFiles = (
  files: FileList | File[],
  showToast: (title: string, description: string, isError?: boolean) => void,
) => {
  const fileArray = Array.from(files).filter(
    (file) => !file.name.startsWith("."),
  )

  const validFiles = fileArray.filter(isValidFile)
  const invalidFiles = fileArray.length - validFiles.length

  if (invalidFiles > 0) {
    showToast(
      "Invalid file(s)",
      `${invalidFiles} file(s) ignored. Files must be under 40MB, images under 5MB and of supported types.`,
      true,
    )
  }

  if (validFiles.length === 0) return []

  // Create a map to track files by name for deduplication
  const fileMap = new Map<string, File>()
  let duplicateCount = 0

  // Keep only the first occurrence of each filename
  validFiles.forEach((file) => {
    if (!fileMap.has(file.name)) {
      fileMap.set(file.name, file)
    } else {
      duplicateCount++
    }
  })

  // Notify about duplicates if any were found
  if (duplicateCount > 0) {
    showToast(
      "Duplicate files",
      `${duplicateCount} duplicate file(s) were ignored.`,
      false,
    )
  }

  return Array.from(fileMap.values())
}

// Common toast notification creator
export const createToastNotifier = (
  toast: (options: {
    title: string
    description: string
    variant?: "default" | "destructive"
    duration?: number
  }) => void,
) => {
  return (title: string, description: string, isError = false) => {
    toast({
      title,
      description,
      variant: isError ? "destructive" : "default",
      duration: 2000,
    })
  }
}
