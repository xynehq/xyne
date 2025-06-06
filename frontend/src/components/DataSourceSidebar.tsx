import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip"
import { Tip } from "@/components/Tooltip"

interface DataSourceSidebarProps {
  dataSources: string[]
  activeDataSource: string | null
  onSelectDataSource: (name: string) => void
  onAddNewDataSource: () => void
  onDeleteDataSource?: (name: string) => void
}

export function DataSourceSidebar({
  dataSources,
  activeDataSource,
  onSelectDataSource,
  onAddNewDataSource,
  onDeleteDataSource,
}: DataSourceSidebarProps) {
  return (
    <div className="w-[263px] border-r border-[#D7E0E9] h-full bg-white shadow-sm overflow-auto">
      <div className="flex justify-between items-center p-4">
        <h3 className="font-medium text-gray-900">Data Sources</h3>
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
        {dataSources.map((name) => (
          <div
            key={name}
            className={`px-3 py-2 text-sm rounded-md cursor-pointer flex items-center justify-between ${
              activeDataSource === name
                ? "bg-[#EBEFF2] text-gray-900"
                : "hover:bg-[#F5F7F9] text-gray-700"
            }`}
          >
            <span
              className="truncate flex-grow"
              onClick={() => onSelectDataSource(name)}
            >
              {name}
            </span>

            {onDeleteDataSource && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 opacity-70 hover:opacity-100 hover:bg-transparent"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (
                        confirm(
                          `Are you sure you want to delete "${name}" data source?`,
                        )
                      ) {
                        onDeleteDataSource(name)
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-gray-500 hover:text-red-500" />
                  </Button>
                </TooltipTrigger>
                <Tip side="left" info="Delete data source" />
              </Tooltip>
            )}
          </div>
        ))}

        {dataSources.length === 0 && (
          <div className="text-sm text-gray-500 p-4 text-center">
            No data sources yet
          </div>
        )}
      </div>
    </div>
  )
}
