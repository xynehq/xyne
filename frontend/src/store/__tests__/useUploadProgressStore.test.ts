import { describe, it, expect, beforeEach } from 'vitest'
import { useUploadProgress } from '../useUploadProgressStore'

describe('useUploadProgressStore', () => {
  beforeEach(() => {
    // Reset the store before each test
    const { getState } = useUploadProgress.getState()
    if (getState().currentUpload) {
      useUploadProgress.getState().finishUpload(getState().currentUpload!.id)
    }
  })

  it('should start upload with abort controller', () => {
    const { startUpload } = useUploadProgress.getState()
    
    const files = [
      { file: new File(['test'], 'test.txt'), id: 'file1' }
    ]
    
    const result = startUpload('test-collection', files, 1, true)
    
    expect(result.uploadId).toBeDefined()
    expect(result.abortController).toBeInstanceOf(AbortController)
    expect(useUploadProgress.getState().currentUpload?.id).toBe(result.uploadId)
  })

  it('should cancel upload and abort controller', () => {
    const { startUpload, cancelUpload } = useUploadProgress.getState()
    
    const files = [
      { file: new File(['test'], 'test.txt'), id: 'file1' }
    ]
    
    const { uploadId, abortController } = startUpload('test-collection', files, 1, true)
    
    // Verify controller is not aborted initially
    expect(abortController.signal.aborted).toBe(false)
    
    // Cancel the upload
    cancelUpload(uploadId)
    
    // Verify controller is aborted and upload is removed
    expect(abortController.signal.aborted).toBe(true)
    expect(useUploadProgress.getState().currentUpload).toBeNull()
  })

  it('should remove progress', () => {
    const { startUpload, removeProgress } = useUploadProgress.getState()
    
    const files = [
      { file: new File(['test'], 'test.txt'), id: 'file1' }
    ]
    
    const { uploadId } = startUpload('test-collection', files, 1, true)
    
    // Verify upload exists
    expect(useUploadProgress.getState().currentUpload?.id).toBe(uploadId)
    
    // Remove progress
    removeProgress(uploadId)
    
    // Verify upload is removed
    expect(useUploadProgress.getState().currentUpload).toBeNull()
  })

  it('should handle file status updates', () => {
    const { startUpload, updateFileStatus } = useUploadProgress.getState()
    
    const files = [
      { file: new File(['test'], 'test.txt'), id: 'file1' }
    ]
    
    const { uploadId } = startUpload('test-collection', files, 1, true)
    
    // Update file status to uploading
    updateFileStatus(uploadId, 'test.txt', 'file1', 'uploading')
    
    let upload = useUploadProgress.getState().currentUpload
    expect(upload?.files[0].status).toBe('uploading')
    
    // Update file status to uploaded
    updateFileStatus(uploadId, 'test.txt', 'file1', 'uploaded')
    
    upload = useUploadProgress.getState().currentUpload
    expect(upload?.files[0].status).toBe('uploaded')
  })
})