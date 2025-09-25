import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import { authFetch } from "@/utils/authFetch"
import ReactJsonView from "react-json-view"

interface DebugDocModalProps {
  documentId: string | null
  documentName: string | null
  isOpen: boolean
  onClose: () => void
}

export function DebugDocModal({
  documentId,
  documentName,
  isOpen,
  onClose,
}: DebugDocModalProps) {
  const { toast } = useToast()
  const [vespaData, setVespaData] = useState<any>(null)
  const [loadingVespaData, setLoadingVespaData] = useState(false)

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
          <DialogTitle className="text-lg font-semibold">
            Vespa Document Data - {documentName}
          </DialogTitle>
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
