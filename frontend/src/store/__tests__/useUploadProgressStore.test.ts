import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useUploadProgress } from '../useUploadProgressStore'

// Mock File API for testing
global.File = class MockFile {
  name: string
  size: number
  type: string
  lastModified: number

  constructor(bits: any[], name: string, options?: { type?: string }) {
    this.name = name
    this.type = options?.type || 'text/plain'
    this.size = bits.reduce((acc, bit) => acc + (typeof bit === 'string' ? bit.length : 0), 0)
    this.lastModified = Date.now()
  }
} as any

describe('useUploadProgressStore', () => {
  beforeEach(() => {
    // Reset the store before each test by getting the state and clearing it
    const store = useUploadProgress.getState()
    if (store.currentUpload) {
      store.finishUpload(store.currentUpload.id)
    }
  })

  it('should start upload with abort controller', () => {
    const store = useUploadProgress.getState()
    
    const files = [
      { file: new File(['test'], 'test.txt'), id: 'file1' }
    ]
    
    const result = store.startUpload('test-collection', files, 1, true)
    
    expect(result.uploadId).toBeDefined()
    expect(result.abortController).toBeInstanceOf(AbortController)
    expect(useUploadProgress.getState().currentUpload?.id).toBe(result.uploadId)
  })

  it('should cancel upload and abort controller', () => {
    const store = useUploadProgress.getState()
    
    const files = [
      { file: new File(['test'], 'test.txt'), id: 'file1' }
    ]
    
    const { uploadId, abortController } = store.startUpload('test-collection', files, 1, true)
    
    // Verify controller is not aborted initially
    expect(abortController.signal.aborted).toBe(false)
    
    // Cancel the upload
    store.cancelUpload(uploadId)
    
    // Verify controller is aborted and upload is removed
    expect(abortController.signal.aborted).toBe(true)
    expect(useUploadProgress.getState().currentUpload).toBeNull()
  })

  it('should remove progress', () => {
    const store = useUploadProgress.getState()
    
    const files = [
      { file: new File(['test'], 'test.txt'), id: 'file1' }
    ]
    
    const { uploadId } = store.startUpload('test-collection', files, 1, true)
    
    // Verify upload exists
    expect(useUploadProgress.getState().currentUpload?.id).toBe(uploadId)
    
    // Remove progress
    store.removeProgress(uploadId)
    
    // Verify upload is removed
    expect(useUploadProgress.getState().currentUpload).toBeNull()
  })

  it('should handle file status updates', () => {
    const store = useUploadProgress.getState()
    
    const files = [
      { file: new File(['test'], 'test.txt'), id: 'file1' }
    ]
    
    const { uploadId } = store.startUpload('test-collection', files, 1, true)
    
    // Update file status to uploading
    store.updateFileStatus(uploadId, 'test.txt', 'file1', 'uploading')
    
    let upload = useUploadProgress.getState().currentUpload
    expect(upload?.files[0].status).toBe('uploading')
    
    // Update file status to uploaded
    store.updateFileStatus(uploadId, 'test.txt', 'file1', 'uploaded')
    
    upload = useUploadProgress.getState().currentUpload
    expect(upload?.files[0].status).toBe('uploaded')
  })

  it('should handle abort controller cleanup', () => {
    const store = useUploadProgress.getState()
    
    const files = [
      { file: new File(['test'], 'test.txt'), id: 'file1' }
    ]
    
    const { abortController } = store.startUpload('test-collection', files, 1, true)
    
    // Manually abort the controller
    abortController.abort()
    
    // Verify the signal is aborted
    expect(abortController.signal.aborted).toBe(true)
  })
})