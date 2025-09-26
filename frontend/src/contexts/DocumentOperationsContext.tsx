import React, { createContext, useContext, useRef, useImperativeHandle, forwardRef } from 'react'

// Define the interface for document operations
export interface DocumentOperations {
  highlightText?: (text: string, chunkIndex: number) => Promise<boolean>
  clearHighlights?: () => void
  scrollToMatch?: (index: number) => boolean
  renderAllPagesForHighlighting?: () => Promise<void>
}

// Create the context
const DocumentOperationsContext = createContext<{
  documentOperationsRef: React.RefObject<DocumentOperations>
  setRenderAllPagesForHighlighting: (fn: (() => Promise<void>) | null) => void
} | null>(null)

// Provider component
export const DocumentOperationsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const documentOperationsRef = useRef<DocumentOperations>({} as DocumentOperations)

  const setRenderAllPagesForHighlightingFn = React.useCallback((fn: (() => Promise<void>) | null) => {
    if (documentOperationsRef.current) {
      documentOperationsRef.current.renderAllPagesForHighlighting = fn || undefined
    }
  }, [])

  return (
    <DocumentOperationsContext.Provider value={{ 
      documentOperationsRef, 
      setRenderAllPagesForHighlighting: setRenderAllPagesForHighlightingFn 
    }}>
      {children}
    </DocumentOperationsContext.Provider>
  )
}

// Hook to use the document operations
export const useDocumentOperations = () => {
  const context = useContext(DocumentOperationsContext)
  if (!context) {
    throw new Error('useDocumentOperations must be used within a DocumentOperationsProvider')
  }
  return context
}

// Higher-order component to expose document operations via ref
export const withDocumentOperations = <P extends object>(
  Component: React.ComponentType<P & { documentOperationsRef: React.RefObject<DocumentOperations> }>
) => {
  return forwardRef<DocumentOperations, P>((props, ref) => {
    const { documentOperationsRef } = useDocumentOperations()
    
    useImperativeHandle(ref, () => ({
      highlightText: async (text: string, chunkIndex: number) => {
        if (documentOperationsRef.current?.highlightText) {
          return await documentOperationsRef.current.highlightText(text, chunkIndex)
        }
        return false
      },
      clearHighlights: () => {
        if (documentOperationsRef.current?.clearHighlights) {
          documentOperationsRef.current.clearHighlights()
        }
      },
      scrollToMatch: (index: number) => {
        if (documentOperationsRef.current?.scrollToMatch) {
          return documentOperationsRef.current.scrollToMatch(index)
        }
        return false
      },
      renderAllPagesForHighlighting: async () => {
        if (documentOperationsRef.current?.renderAllPagesForHighlighting) {
          await documentOperationsRef.current.renderAllPagesForHighlighting()
        }
      }
    }), [documentOperationsRef])

    return <Component {...(props as P)} documentOperationsRef={documentOperationsRef} />
  })
}
