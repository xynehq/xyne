import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react'

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
  status: 'pending' | 'uploading' | 'uploaded' | 'failed'
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
}

interface UploadProgressContextType {
  currentUpload: UploadTask | null
  startUpload: (collectionName: string, files: File[], totalBatches: number, isNewCollection: boolean, targetCollectionId?: string) => string
  updateProgress: (uploadId: string, current: number, batch: number) => void
  updateFileStatus: (uploadId: string, fileName: string, status: 'pending' | 'uploading' | 'uploaded' | 'failed', error?: string) => void
  finishUpload: (uploadId: string) => void
  cancelUpload: (uploadId: string) => void
  getUploadProgress: (uploadId: string) => UploadTask | null
}

const UploadProgressContext = createContext<UploadProgressContextType | undefined>(undefined)

export const useUploadProgress = () => {
  const context = useContext(UploadProgressContext)
  if (context === undefined) {
    throw new Error('useUploadProgress must be used within an UploadProgressProvider')
  }
  return context
}

interface UploadProgressProviderProps {
  children: ReactNode
}

export const UploadProgressProvider: React.FC<UploadProgressProviderProps> = ({ children }) => {
  const [currentUpload, setCurrentUpload] = useState<UploadTask | null>(null)

  const startUpload = useCallback((collectionName: string, files: File[], totalBatches: number, isNewCollection: boolean, targetCollectionId?: string): string => {
    const uploadId = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    
    const uploadFiles: UploadFileStatus[] = files.map((file, index) => ({
      id: `${uploadId}_file_${index}`,
      name: file.name,
      size: file.size,
      status: 'pending'
    }))
    
    const newUpload: UploadTask = {
      id: uploadId,
      collectionName,
      isUploading: true,
      batchProgress: {
        total: files.length,
        current: 0,
        batch: 0,
        totalBatches
      },
      isNewCollection,
      targetCollectionId,
      files: uploadFiles
    }
    
    setCurrentUpload(newUpload)
    return uploadId
  }, [])

  const updateProgress = useCallback((uploadId: string, current: number, batch: number) => {
    setCurrentUpload(prev => {
      if (!prev || prev.id !== uploadId) return prev
      
      return {
        ...prev,
        batchProgress: {
          ...prev.batchProgress,
          current,
          batch
        }
      }
    })
  }, [])

  const updateFileStatus = useCallback((uploadId: string, fileName: string, status: 'pending' | 'uploading' | 'uploaded' | 'failed', error?: string) => {
    setCurrentUpload(prev => {
      if (!prev || prev.id !== uploadId) return prev
      
      return {
        ...prev,
        files: prev.files.map(file => 
          file.name === fileName 
            ? { ...file, status, error }
            : file
        )
      }
    })
  }, [])

  const finishUpload = useCallback((uploadId: string) => {
    setCurrentUpload(prev => {
      if (!prev || prev.id !== uploadId) return prev
      return null
    })
  }, [])

  const cancelUpload = useCallback((uploadId: string) => {
    setCurrentUpload(prev => {
      if (!prev || prev.id !== uploadId) return prev
      return null
    })
  }, [])

  const getUploadProgress = useCallback((uploadId: string): UploadTask | null => {
    return currentUpload?.id === uploadId ? currentUpload : null
  }, [currentUpload])

  const value: UploadProgressContextType = {
    currentUpload,
    startUpload,
    updateProgress,
    updateFileStatus,
    finishUpload,
    cancelUpload,
    getUploadProgress
  }

  return (
    <UploadProgressContext.Provider value={value}>
      {children}
    </UploadProgressContext.Provider>
  )
}
