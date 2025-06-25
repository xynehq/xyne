import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useState } from "react"
import { ConfirmModal } from "@/components/ui/confirmModal"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"
import { datasourceSchema } from "../../../server/search/types"

interface DataSourceSidebarProps {
  dataSources: { name: string; docId: string }[]
  activeDataSource: string | null
  onSelectDataSource: (name:string) => void
  onAddNewDataSource: () => void
  onDataSourceDeleted: () => void
}

export function DataSourceSidebar({
  dataSources,
  activeDataSource,
  onSelectDataSource,
  onAddNewDataSource,
  onDataSourceDeleted,
}: DataSourceSidebarProps) {
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [confirmModalTitle, setConfirmModalTitle] = useState("")
  const [confirmModalMessage, setConfirmModalMessage] = useState("")
  const [confirmAction, setConfirmAction] = useState<
    (() => Promise<void>) | null
  >(null)

  const handleDeleteDataSource = async (docId: string, name: string) => {
    if (!docId) return

    const action = async () => {
      if (!docId) return
      try {
        const response = await api.search.document.delete.$post({
          json: {
            docId: docId,
            schema: datasourceSchema,
          },
        })

        if (response.ok) {
          toast({
            title: "Success",
            description: "Data source deleted successfully.",
          })
          onDataSourceDeleted()
        } else {
          const errorText = await response.text()
          throw new Error(
            errorText || `Request failed with status ${response.status}`,
          )
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "An unexpected error occurred."
        toast({
          title: "Error",
          description: `Failed to delete data source: ${errorMessage}`,
          variant: "destructive",
        })
        console.error("Error deleting data source:", err)
      }
    }

    setConfirmModalTitle("Delete Data Source")
    setConfirmModalMessage(
      `Are you sure you want to delete the "${name}" data source and all its files?`,
    )
    setConfirmAction(() => action)
    setShowConfirmModal(true)
  }

  return (
    <div className="w-[263px] border-r border-[#D7E0E9] dark:border-gray-700 h-full bg-white dark:bg-[#1E1E1E] shadow-sm overflow-auto">
      <ConfirmModal
        showModal={showConfirmModal}
        setShowModal={(val) =>
          setShowConfirmModal(val.open ?? showConfirmModal)
        }
        modalTitle={confirmModalTitle}
        modalMessage={confirmModalMessage}
        onConfirm={() => {
          if (confirmAction) {
            confirmAction()
          }
        }}
      />
      <div className="flex justify-between items-center p-4">
        <h3 className="font-medium text-gray-900 dark:text-gray-100">
          Data Sources
        </h3>
        <Button
          onClick={onAddNewDataSource}
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 rounded-full"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-1 p-2">
        {dataSources.map((ds) => (
          <div
            key={ds.docId}
            className={`px-3 py-2 text-sm rounded-md cursor-pointer flex items-center justify-between ${
              activeDataSource === ds.name
                ? "bg-[#EBEFF2] dark:bg-slate-700 text-gray-900 dark:text-gray-100"
                : "hover:bg-[#F5F7F9] dark:hover:bg-slate-700 text-gray-700 dark:text-gray-300"
            }`}
          >
            <span
              className="truncate flex-grow"
              onClick={() => onSelectDataSource(ds.name)}
            >
              {ds.name}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 p-0 opacity-60 hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                handleDeleteDataSource(ds.docId, ds.name)
              }}
            >
              <Trash2 className="h-4 w-4 text-red-500" />
            </Button>
          </div>
        ))}

        {dataSources.length === 0 && (
          <div className="text-sm text-gray-500 dark:text-gray-400 p-4 text-center">
            No data sources yet
          </div>
        )}
      </div>
    </div>
  )
}
