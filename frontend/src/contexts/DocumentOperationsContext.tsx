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
  /** PDF viewer: highlight exact bbox coordinates with a yellow overlay box.
   *
   *  Pass a single bbox to draw one rectangle, or a non-empty array to draw
   *  one rectangle per fragment (e.g. one per paragraph in a multi-paragraph
   *  chunk). Each fragment may carry its own `page_no` (1-based, Docling
   *  convention); if absent, falls back to the `pageIndex` argument. */
  highlightBbox?: (
    bbox:
      | { l: number; t: number; r: number; b: number }
      | Array<{
          l: number
          t: number
          r: number
          b: number
          page_no?: number | null
        }>,
    pageIndex: number,
  ) => Promise<boolean>
  clearHighlights?: () => void
  scrollToMatch?: (index: number) => boolean
  goToPage?: (pageIndex: number) => Promise<void>
  /** PDF viewer: wait until canvas + text + annotation layers are ready for this 0-based page. */
  waitForPageReady?: (pageIndex: number) => Promise<void>
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
        highlightBbox: async (
          bbox:
            | { l: number; t: number; r: number; b: number }
            | Array<{
                l: number
                t: number
                r: number
                b: number
                page_no?: number | null
              }>,
          pageIndex: number,
        ) => {
          if (documentOperationsRef.current?.highlightBbox) {
            return await documentOperationsRef.current.highlightBbox(
              bbox,
              pageIndex,
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
        waitForPageReady: async (pageIndex: number) => {
          if (documentOperationsRef.current?.waitForPageReady) {
            await documentOperationsRef.current.waitForPageReady(pageIndex)
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
