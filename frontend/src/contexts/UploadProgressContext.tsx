import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
} from "react"

export interface UploadBatchProgress {
  total: number
  current: number
  batch: number
  totalBatches: number
}

export interface UploadFileStatus {
  id: string
  name: string
  size: number
  status: "pending" | "uploading" | "uploaded" | "failed"
  error?: string
}

export interface UploadTask {
  id: string
  collectionName: string
  isUploading: boolean
  batchProgress: UploadBatchProgress
  isNewCollection: boolean
  targetCollectionId?: string
  files: UploadFileStatus[]
  abortController: AbortController
}

interface UploadProgressContextType {
  currentUpload: UploadTask | null
  startUpload: (
    collectionName: string,
    files: { file: File; id: string }[],
    totalBatches: number,
    isNewCollection: boolean,
    targetCollectionId?: string,
  ) => { uploadId: string; abortController: AbortController }
  updateProgress: (uploadId: string, current: number, batch: number) => void
  updateFileStatus: (
    uploadId: string,
    fileName: string,
    fileId: string,
    status: "pending" | "uploading" | "uploaded" | "failed",
    error?: string,
  ) => void
  finishUpload: (uploadId: string) => void
  cancelUpload: (uploadId: string) => void
  getUploadProgress: (uploadId: string) => UploadTask | null
}

const UploadProgressContext = createContext<
  UploadProgressContextType | undefined
>(undefined)

export const useUploadProgress = () => {
  const context = useContext(UploadProgressContext)
  if (context === undefined) {
    throw new Error(
      "useUploadProgress must be used within an UploadProgressProvider",
    )
  }
  return context
}

interface UploadProgressProviderProps {
  children: ReactNode
}

export const UploadProgressProvider: React.FC<UploadProgressProviderProps> = ({
  children,
}) => {
  const [currentUpload, setCurrentUpload] = useState<UploadTask | null>(null)

  const startUpload = useCallback(
    (
      collectionName: string,
      files: { file: File; id: string }[],
      totalBatches: number,
      isNewCollection: boolean,
      targetCollectionId?: string,
    ): { uploadId: string; abortController: AbortController } => {
      const uploadId = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      const abortController = new AbortController()

      const uploadFiles: UploadFileStatus[] = files.map((file, index) => ({
        id: file.id,
        name: file.file.name,
        size: file.file.size,
        status: "pending",
      }))

      const newUpload: UploadTask = {
        id: uploadId,
        collectionName,
        isUploading: true,
        batchProgress: {
          total: files.length,
          current: 0,
          batch: 0,
          totalBatches,
        },
        isNewCollection,
        targetCollectionId,
        files: uploadFiles,
        abortController,
      }

      setCurrentUpload(newUpload)
      return { uploadId, abortController }
    },
    [],
  )

  const updateProgress = useCallback(
    (uploadId: string, current: number, batch: number) => {
      setCurrentUpload((prev) => {
        if (!prev || prev.id !== uploadId) return prev

        return {
          ...prev,
          batchProgress: {
            ...prev.batchProgress,
            current,
            batch,
          },
        }
      })
    },
    [],
  )

  const updateFileStatus = useCallback(
    (
      uploadId: string,
      fileName: string,
      fileId: string,
      status: "pending" | "uploading" | "uploaded" | "failed",
      error?: string,
    ) => {
      setCurrentUpload((prev) => {
        if (!prev || prev.id !== uploadId) return prev

        return {
          ...prev,
          files: prev.files.map((file) =>
            file.name === fileName && file.id === fileId
              ? { ...file, status, error }
              : file,
          ),
        }
      })
    },
    [],
  )

  const finishUpload = useCallback((uploadId: string) => {
    setCurrentUpload((prev) => {
      if (!prev || prev.id !== uploadId) return prev
      return null
    })
  }, [])

  const cancelUpload = useCallback((uploadId: string) => {
    setCurrentUpload((prev) => {
      if (!prev || prev.id !== uploadId) return prev

      // Abort all ongoing requests
      if (prev.abortController) {
        prev.abortController.abort()
      }

      return null
    })
  }, [])

  const getUploadProgress = useCallback(
    (uploadId: string): UploadTask | null => {
      return currentUpload?.id === uploadId ? currentUpload : null
    },
    [currentUpload],
  )

  const value: UploadProgressContextType = {
    currentUpload,
    startUpload,
    updateProgress,
    updateFileStatus,
    finishUpload,
    cancelUpload,
    getUploadProgress,
  }

  return (
    <UploadProgressContext.Provider value={value}>
      {children}
    </UploadProgressContext.Provider>
  )
}
