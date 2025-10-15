import React, { useState, useEffect } from 'react'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Trash2, Loader2, ChevronDown, ChevronRight, ChevronLeft } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import ReactJsonView from 'react-json-view'
import { useTheme } from '@/components/ThemeContext'
import type { AllDocsApiResponse, VespaDocument, DeleteDocRequest } from '@/types/allDocs'

export const AllDocsPage: React.FC = () => {
  const [documents, setDocuments] = useState<VespaDocument[]>([])
  const [totalDocuments, setTotalDocuments] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set())
  const [currentPage, setCurrentPage] = useState(1)
  const itemsPerPage = 50
  const { toast } = useToast()
  const { theme } = useTheme()

  // Pagination calculations
  const totalPages = Math.ceil(totalDocuments / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = Math.min(startIndex + itemsPerPage, totalDocuments)

  const fetchDocuments = async (page: number = currentPage) => {
    try {
      setLoading(true)
      setError(null)
      
      const queryParams = new URLSearchParams({
        page: page.toString(),
        limit: itemsPerPage.toString()
      })
      
      const response = await api['all-docs'].$get({
        query: queryParams
      })
      
      if (!response.ok) {
        throw new Error('Failed to fetch documents')
      }
      
      const data: AllDocsApiResponse = await response.json()
      console.log('Fetched documents:', data)
      
      if (data.success) {
        setDocuments(data.data.root.children || [])
        setTotalDocuments(data.totalCount || data.data.root.fields?.totalCount || 0)
      } else {
        throw new Error('API returned unsuccessful response')
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred'
      setError(errorMessage)
      toast({
        title: 'Error',
        description: `Failed to fetch documents: ${errorMessage}`,
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const deleteDocument = async (document: VespaDocument) => {
    const docId = document.fields.docId 
    const schema = document.fields.sddocname
    
    if (!docId || !schema) {
      toast({
        title: 'Error',
        description: 'Cannot delete document: missing document ID or schema',
        variant: 'destructive',
      })
      return
    }

    setDeletingIds(prev => new Set(prev.add(docId)))

    try {
      const deleteRequest: DeleteDocRequest = {
        schema,
        id: docId,
      }

      const response = await api['delete-doc'].$post({
        json: deleteRequest,
      })

      if (!response.ok) {
        throw new Error('Failed to delete document')
      }

      const result = await response.json()
      
      if (result.success) {
        // Remove the document from the local state
        setDocuments(prev => prev.filter(doc => {
          const currentDocId = doc.fields.docId || doc.id
          return currentDocId !== docId
        }))
        
        toast({
          title: 'Success',
          description: 'Document deleted successfully',
        })
      } else {
        throw new Error(result.message || 'Delete operation failed')
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred'
      toast({
        title: 'Error',
        description: `Failed to delete document: ${errorMessage}`,
        variant: 'destructive',
      })
    } finally {
      setDeletingIds(prev => {
        const newSet = new Set(prev)
        newSet.delete(docId)
        return newSet
      })
    }
  }

  const getDisplayTitle = (doc: VespaDocument): string => {
    return doc.fields.filename || doc.fields.name || doc.fields.subject || doc.fields.docId || 'Untitled'
  }

  const formatDate = (timestamp?: number): string => {
    if (!timestamp) return 'N/A'
    return new Date(timestamp).toLocaleDateString()
  }

  const toggleDocumentExpansion = (docId: string) => {
    setExpandedDocs(prev => {
      const newSet = new Set(prev)
      if (newSet.has(docId)) {
        newSet.delete(docId)
      } else {
        newSet.add(docId)
      }
      return newSet
    })
  }

  const generatePageNumbers = () => {
    const pages = []
    const maxVisiblePages = 7
    
    if (totalPages <= maxVisiblePages) {
      // Show all pages if total is small
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i)
      }
    } else {
      // Always show first page
      pages.push(1)
      
      if (currentPage <= 4) {
        // Near beginning
        for (let i = 2; i <= 5; i++) {
          pages.push(i)
        }
        pages.push('...')
        pages.push(totalPages)
      } else if (currentPage >= totalPages - 3) {
        // Near end
        pages.push('...')
        for (let i = totalPages - 4; i <= totalPages; i++) {
          pages.push(i)
        }
      } else {
        // Middle
        pages.push('...')
        for (let i = currentPage - 1; i <= currentPage + 1; i++) {
          pages.push(i)
        }
        pages.push('...')
        pages.push(totalPages)
      }
    }
    
    return pages
  }

  const goToPage = async (page: number) => {
    setCurrentPage(page)
    setExpandedDocs(new Set()) // Collapse all when changing pages
    await fetchDocuments(page)
  }

  useEffect(() => {
    fetchDocuments()
  }, [])

  // Reset to page 1 when documents change
  useEffect(() => {
    setCurrentPage(1)
  }, [documents.length])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin" />
        <span className="ml-2">Loading documents...</span>
      </div>
    )
  }

  if (error) {
    return (
      <Card className="max-w-4xl mx-auto mt-8">
        <CardHeader>
          <CardTitle className="text-red-600">Error</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-red-600 mb-4">{error}</p>
          <Button onClick={() => fetchDocuments()}>Retry</Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="max-w-6xl mx-auto mt-8">
      <CardHeader>
        <CardTitle>All Documents ({totalDocuments})</CardTitle>
      </CardHeader>
      <CardContent>
        {documents.length === 0 ? (
          <p className="text-gray-500 text-center py-8">No documents found</p>
        ) : (
          <>
            <div className="space-y-4">
              {documents.map((doc: VespaDocument) => {
                const docId = doc.fields.docId || doc.id
                const isDeleting = deletingIds.has(docId)
                const isExpanded = expandedDocs.has(docId)
                
                return (
                  <Card key={docId} className="border border-gray-200 dark:border-gray-700 overflow-hidden">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start space-x-3 min-w-0 flex-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleDocumentExpansion(docId)}
                            className="h-8 w-8 p-0 flex-shrink-0 mt-1"
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </Button>
                          <div className="flex-1 min-w-0 overflow-hidden">
                            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 break-words line-clamp-2">
                              {getDisplayTitle(doc)}
                            </h3>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500 dark:text-gray-400 mt-1">
                              <span className="inline-block truncate max-w-[200px]">
                                <span className="font-medium">Schema:</span> {doc.source}
                              </span>
                              <span className="inline-block truncate max-w-[150px]">
                                <span className="font-medium">App:</span> {doc.fields.app || 'N/A'}
                              </span>
                              <span className="inline-block truncate max-w-[150px]">
                                <span className="font-medium">Entity:</span> {doc.fields.entity || 'N/A'}
                              </span>
                              {doc.fields.updatedAt && (
                                <span className="inline-block truncate max-w-[150px]">
                                  <span className="font-medium">Updated:</span> {formatDate(doc.fields.updatedAt)}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => deleteDocument(doc)}
                          disabled={isDeleting}
                          className="flex items-center space-x-2 flex-shrink-0"
                        >
                          {isDeleting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                          <span>Delete</span>
                        </Button>
                      </div>
                    </CardHeader>
                    
                    {isExpanded && (
                      <CardContent className="pt-0">
                        <div className="border rounded-lg p-4 bg-gray-50 dark:bg-gray-800 overflow-hidden">
                          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                            Document JSON Data:
                          </h4>
                          <div className="overflow-auto max-h-[600px]">
                            <ReactJsonView
                              src={doc}
                              theme={theme === 'dark' ? 'monokai' : 'rjv-default'}
                              collapsed={false}
                              displayDataTypes={false}
                              displayObjectSize={false}
                              enableClipboard={true}
                              name={false}
                              style={{
                                backgroundColor: 'transparent',
                                fontSize: '12px',
                                wordBreak: 'break-word',
                                overflowWrap: 'break-word',
                              }}
                            />
                          </div>
                        </div>
                      </CardContent>
                    )}
                  </Card>
                )
              })}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  Showing {startIndex + 1} to {startIndex + documents.length} of {totalDocuments} documents
                </div>
                
                <div className="flex items-center space-x-2">
                  {/* Previous button */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => goToPage(currentPage - 1)}
                    disabled={currentPage === 1}
                    className="flex items-center space-x-1"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    <span>Previous</span>
                  </Button>

                  {/* Page numbers */}
                  <div className="flex items-center space-x-1">
                    {generatePageNumbers().map((page, index) => (
                      <React.Fragment key={index}>
                        {page === '...' ? (
                          <span className="px-3 py-2 text-gray-500 dark:text-gray-400">...</span>
                        ) : (
                          <Button
                            variant={currentPage === page ? "default" : "outline"}
                            size="sm"
                            onClick={() => goToPage(page as number)}
                            className={`w-10 h-10 ${
                              currentPage === page 
                                ? "bg-blue-600 text-white hover:bg-blue-700" 
                                : "hover:bg-gray-100 dark:hover:bg-gray-700"
                            }`}
                          >
                            {page}
                          </Button>
                        )}
                      </React.Fragment>
                    ))}
                  </div>

                  {/* Next button */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => goToPage(currentPage + 1)}
                    disabled={currentPage === totalPages}
                    className="flex items-center space-x-1"
                  >
                    <span>Next</span>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
