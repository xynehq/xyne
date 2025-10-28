import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { authFetch } from "@/utils/authFetch"
import { Copy } from "lucide-react"
import ReactJsonView from "react-json-view"

interface DebugDocModalProps {
  documentId: string | null
  documentName: string | null
  isOpen: boolean
  onClose: () => void
  currentSheetIndex?: number
}
interface KnowledgeBaseFileMetadata {
  originalFileName: string
  uploadedBy: string
  chunksCount: number
  imageChunksCount: number
  processingMethod: string
  lastModified: number
}

interface KnowledgeBaseFile {
  storagePath: string
  chunks: any[] // You may want to define a more specific type for chunks
  fileName: string
  fileSize: number
  itemId: string
  duration: number
  clId: string
  metadata: string | KnowledgeBaseFileMetadata // Can be JSON string or parsed object
  createdBy: string
  entity: string
  app: string
  chunks_pos: any[] // You may want to define a more specific type for chunk positions
  docId: string
  createdAt: number
  updatedAt: number
  mimeType: string
}
export function DebugDocModal({
  documentId,
  documentName,
  isOpen,
  onClose,
  currentSheetIndex,
}: DebugDocModalProps) {
  const { toast } = useToast()
  const [vespaData, setVespaData] = useState<KnowledgeBaseFile | null>(null)
  const [loadingVespaData, setLoadingVespaData] = useState(false)

  const handleCopyToClipboard = async () => {
    if (!vespaData) {
      toast.error({
        title: "Error",
        description: "No data available to copy",
      })
      return
    }

    try {
      const formattedData = JSON.stringify(vespaData, null, 2)
      await navigator.clipboard.writeText(formattedData)
      toast.success({
        title: "Success",
        description: "Vespa data copied to clipboard",
      })
    } catch (error) {
      console.error("Error copying to clipboard:", error)
      toast.error({
        title: "Error",
        description: "Failed to copy data to clipboard",
      })
    }
  }

  const handleFetchVespaData = async () => {
    if (!documentId) {
      toast.error({
        title: "Error",
        description: "No document selected",
      })
      return
    }

    setLoadingVespaData(true)
    try {
      const response = await authFetch("/api/v1/admin/kb/vespa-data", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          docId: documentId,
          schema: "kb_items",
          sheetIndex: currentSheetIndex,
        }),
      })

      if (!response.ok) {
        let errorMessage = "Failed to fetch Vespa data"
        try {
          const errorData = await response.json()
          errorMessage = errorData.message || errorMessage
        } catch {
          errorMessage = `${errorMessage}: ${response.statusText}`
        }
        toast.error({
          title: "Error",
          description: errorMessage,
        })
        return
      }

      const data = await response.json()
      data.data.metadata = JSON.parse(data.data.metadata)
      setVespaData(data.data)
    } catch (error) {
      console.error("Error fetching Vespa data:", error)
      toast.error({
        title: "Error",
        description: "Failed to fetch Vespa data",
      })
    } finally {
      setLoadingVespaData(false)
    }
  }

  // Automatically fetch data when modal opens
  useEffect(() => {
    if (isOpen && documentId && !vespaData && !loadingVespaData) {
      handleFetchVespaData()
    }
  }, [isOpen, documentId])

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setVespaData(null) // Clear data when modal closes
      onClose()
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[60vw] w-full max-h-[95vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="text-lg font-semibold">
              Vespa Document Data - {documentName}
            </DialogTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyToClipboard}
              disabled={!vespaData || loadingVespaData}
              className="flex items-center gap-2 mr-8"
            >
              <Copy className="h-4 w-4" />
              Copy Data
            </Button>
          </div>
        </DialogHeader>
        <div className="flex-1 overflow-auto p-4">
          {loadingVespaData ? (
            <div className="flex items-center justify-center h-32">
              <div className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gray-600"></div>
                <p className="text-gray-500 dark:text-gray-400">
                  Loading Vespa data...
                </p>
              </div>
            </div>
          ) : vespaData ? (
            <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
              <ReactJsonView
                src={vespaData}
                theme="rjv-default"
                displayDataTypes={false}
                displayObjectSize={false}
                enableClipboard={false}
                name={false}
                collapsed={1}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center h-32">
              <p className="text-gray-500 dark:text-gray-400">
                No Vespa data available
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
