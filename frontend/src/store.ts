import {create} from 'zustand'; 

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
  abortController: AbortController
}

interface UploadProgressStore {
  currentUpload: UploadTask | null
  startUpload: (
    collectionName: string, 
    files: { file: File; id: string }[], 
    totalBatches: number, 
    isNewCollection: boolean, 
    targetCollectionId?: string
  ) => { uploadId: string; abortController: AbortController }
  updateProgress: (uploadId: string, current: number, batch: number) => void
  updateFileStatus: (
    uploadId: string, 
    fileName: string, 
    fileId: string, 
    status: 'pending' | 'uploading' | 'uploaded' | 'failed', 
    error?: string
  ) => void
  finishUpload: (uploadId: string) => void
  cancelUpload: (uploadId: string) => void
  getUploadProgress: (uploadId: string) => UploadTask | null
}

export const useUploadProgressStore = create<UploadProgressStore>((set, get) => ({
  currentUpload: null,

  startUpload: (collectionName, files, totalBatches, isNewCollection, targetCollectionId) => {
    const uploadId = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const abortController = new AbortController()
    
    const uploadFiles: UploadFileStatus[] = files.map((file) => ({
      id: file.id,
      name: file.file.name,
      size: file.file.size,
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
      files: uploadFiles,
      abortController
    }
    
    set({ currentUpload: newUpload })
    return { uploadId, abortController }
  },

  updateProgress: (uploadId, current, batch) => {
    set((state) => {
      if (!state.currentUpload || state.currentUpload.id !== uploadId) {
        return state
      }
      
      return {
        currentUpload: {
          ...state.currentUpload,
          batchProgress: {
            ...state.currentUpload.batchProgress,
            current,
            batch
          }
        }
      }
    })
  },

  updateFileStatus: (uploadId, fileName, fileId, status, error) => {
    set((state) => {
      if (!state.currentUpload || state.currentUpload.id !== uploadId) {
        return state
      }
      
      return {
        currentUpload: {
          ...state.currentUpload,
          files: state.currentUpload.files.map(file => 
            file.name === fileName && file.id === fileId
              ? { ...file, status, error }
              : file
          )
        }
      }
    })
  },

  finishUpload: (uploadId) => {
    set((state) => {
      if (!state.currentUpload || state.currentUpload.id !== uploadId) {
        return state
      }
      return { currentUpload: null }
    })
  },

  cancelUpload: (uploadId) => {
    set((state) => {
      if (!state.currentUpload || state.currentUpload.id !== uploadId) {
        return state
      }
      
      // Abort all ongoing requests
      if (state.currentUpload.abortController) {
        state.currentUpload.abortController.abort()
      }
      
      return { currentUpload: null }
    })
  },

  getUploadProgress: (uploadId) => {
    const state = get()
    return state.currentUpload?.id === uploadId ? state.currentUpload : null
  }
}));

export const useUploadProgress = () => {
  const store = useUploadProgressStore()
  
  return {
    currentUpload: store.currentUpload,
    startUpload: store.startUpload,
    updateProgress: store.updateProgress,
    updateFileStatus: store.updateFileStatus,
    finishUpload: store.finishUpload,
    cancelUpload: store.cancelUpload,
    getUploadProgress: store.getUploadProgress
  }
}
