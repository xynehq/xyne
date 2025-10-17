import React, {
  createContext,
  useContext,
  useRef,
  useImperativeHandle,
  forwardRef,
} from "react"

// Define the interface for document operations
export interface DocumentOperations {
  highlightText?: (
    text: string,
    chunkIndex: number,
    pageIndex?: number,
    waitForTextLayer?: boolean,
  ) => Promise<boolean>
  clearHighlights?: () => void
  scrollToMatch?: (index: number) => boolean
  goToPage?: (pageIndex: number) => Promise<void>
}

// Create the context
const DocumentOperationsContext = createContext<{
  documentOperationsRef: React.RefObject<DocumentOperations>
  setGoToPage: (fn: ((pageIndex: number) => Promise<void>) | null) => void
} | null>(null)

// Provider component
export const DocumentOperationsProvider: React.FC<{
  children: React.ReactNode
}> = ({ children }) => {
  const documentOperationsRef = useRef<DocumentOperations>(
    {} as DocumentOperations,
  )

  const setGoToPageFn = React.useCallback(
    (fn: ((pageIndex: number) => Promise<void>) | null) => {
      if (documentOperationsRef.current) {
        documentOperationsRef.current.goToPage = fn || undefined
      }
    },
    [],
  )

  return (
    <DocumentOperationsContext.Provider
      value={{
        documentOperationsRef,
        setGoToPage: setGoToPageFn,
      }}
    >
      {children}
    </DocumentOperationsContext.Provider>
  )
}

// Hook to use the document operations
export const useDocumentOperations = () => {
  const context = useContext(DocumentOperationsContext)
  if (!context) {
    throw new Error(
      "useDocumentOperations must be used within a DocumentOperationsProvider",
    )
  }
  return context
}

// Higher-order component to expose document operations via ref
export const withDocumentOperations = <P extends object>(
  Component: React.ComponentType<
    P & { documentOperationsRef: React.RefObject<DocumentOperations> }
  >,
) => {
  return forwardRef<DocumentOperations, P>((props, ref) => {
    const { documentOperationsRef } = useDocumentOperations()

    useImperativeHandle(
      ref,
      () => ({
        highlightText: async (
          text: string,
          chunkIndex: number,
          pageIndex?: number,
          waitForTextLayer: boolean = false,
        ) => {
          if (documentOperationsRef.current?.highlightText) {
            return await documentOperationsRef.current.highlightText(
              text,
              chunkIndex,
              pageIndex,
              waitForTextLayer,
            )
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
        goToPage: async (pageIndex: number) => {
          if (documentOperationsRef.current?.goToPage) {
            await documentOperationsRef.current.goToPage(pageIndex)
          }
        },
      }),
      [documentOperationsRef],
    )

    return (
      <Component
        {...(props as P)}
        documentOperationsRef={documentOperationsRef}
      />
    )
  })
}
