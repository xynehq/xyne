import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUploadProgress } from '../useUploadProgressStore'

describe('useUploadProgressStore', () => {
  beforeEach(() => {
    // Reset the store before each test
    const { result } = renderHook(() => useUploadProgress())
    act(() => {
      const currentUpload = result.current.currentUpload
      if (currentUpload) {
        result.current.finishUpload(currentUpload.id)
      }
    })
  })

  it('should start upload with abort controller', () => {
    const { result } = renderHook(() => useUploadProgress())
    
    const files = [
      { file: new File(['test'], 'test.txt'), id: 'file1' }
    ]
    
    act(() => {
      const uploadResult = result.current.startUpload('test-collection', files, 1, true)
      
      expect(uploadResult.uploadId).toBeDefined()
      expect(uploadResult.abortController).toBeInstanceOf(AbortController)
      expect(result.current.currentUpload?.id).toBe(uploadResult.uploadId)
    })
  })

  it('should cancel upload and abort controller', () => {
    const { result } = renderHook(() => useUploadProgress())
    
    const files = [
      { file: new File(['test'], 'test.txt'), id: 'file1' }
    ]
    
    act(() => {
      const { uploadId, abortController } = result.current.startUpload('test-collection', files, 1, true)
      
      // Verify controller is not aborted initially
      expect(abortController.signal.aborted).toBe(false)
      
      // Cancel the upload
      result.current.cancelUpload(uploadId)
      
      // Verify controller is aborted and upload is removed
      expect(abortController.signal.aborted).toBe(true)
      expect(result.current.currentUpload).toBeNull()
    })
  })

  it('should remove progress', () => {
    const { result } = renderHook(() => useUploadProgress())
    
    const files = [
      { file: new File(['test'], 'test.txt'), id: 'file1' }
    ]
    
    act(() => {
      const { uploadId } = result.current.startUpload('test-collection', files, 1, true)
      
      // Verify upload exists
      expect(result.current.currentUpload?.id).toBe(uploadId)
      
      // Remove progress
      result.current.removeProgress(uploadId)
      
      // Verify upload is removed
      expect(result.current.currentUpload).toBeNull()
    })
  })

  it('should handle file status updates', () => {
    const { result } = renderHook(() => useUploadProgress())
    
    const files = [
      { file: new File(['test'], 'test.txt'), id: 'file1' }
    ]
    
    act(() => {
      const { uploadId } = result.current.startUpload('test-collection', files, 1, true)
      
      // Update file status to uploading
      result.current.updateFileStatus(uploadId, 'test.txt', 'file1', 'uploading')
      
      let upload = result.current.currentUpload
      expect(upload?.files[0].status).toBe('uploading')
      
      // Update file status to uploaded
      result.current.updateFileStatus(uploadId, 'test.txt', 'file1', 'uploaded')
      
      upload = result.current.currentUpload
      expect(upload?.files[0].status).toBe('uploaded')
    })
  })
})