import React, { createContext, useState } from "react"
import { useToast } from "./hooks/use-toast"
import { isSupportedFileType } from "./lib/common"

// Define the context and its type
export const StateContext = createContext<{
  stagedFiles: File[]
  setStagedFiles: React.Dispatch<React.SetStateAction<File[]>>
  handleFileRemove: (index: number) => void
  handleFileSelection: (file: File) => void
} | null>(null)

// Provider component
export const StateContextProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [stagedFiles, setStagedFiles] = useState<File[]>([])
  const { toast } = useToast()

  const handleFileSelection = (event) => {
    const files = Array.from(event.target!.files) as File[]
    const validFiles: File[] = [] // Array to hold files that pass validation

    files.forEach((file: File) => {
      // File size check: 20 MB limit
      const fileSizeInMB = file.size / (1024 * 1024)
      if (fileSizeInMB > 20) {
        toast({
          title: `File Too Large`,
          description: `The file "${file.name}" exceeds the 20MB size limit. Please choose a smaller file.`,
          variant: "destructive",
        })
      } else if (!isSupportedFileType(file.type)) {
        // Check for unsupported file types
        toast({
          title: "File Type not supported",
          description: `The file "${file.name}" is of type "${file.type}", which is not supported. Please upload a valid file type.`,
          variant: "destructive",
        })
      } else {
        // If valid, add the file to the validFiles array
        validFiles.push(file)
      }
    })

    setStagedFiles((prev) => {
      if (prev.length + validFiles.length > 5) {
        toast({
          title: "File Limit Exceeded",
          description: "You can only select up to 5 files.",
          variant: "destructive",
        })
        return prev // Keep the current files unchanged
      }
      return [...prev, ...validFiles]
    })

    event.target.value = ""
  }

  function handleFileRemove(index: number) {
    setStagedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  return (
    <StateContext.Provider
      value={{
        stagedFiles,
        setStagedFiles,
        handleFileRemove,
        handleFileSelection,
      }}
    >
      {children}
    </StateContext.Provider>
  )
}
