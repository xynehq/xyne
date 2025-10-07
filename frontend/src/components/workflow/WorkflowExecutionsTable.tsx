import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableFooter,
} from "@/components/ui/table"
import emptyStateIcon from "@/assets/empty-state.svg"

interface WorkflowExecution {
  id: string
  workflowName: string
  workflowId: string
  status: "Success" | "Running" | "Failed"
  started: string
  runTime: string
}

interface WorkflowExecutionsTableProps {
  executions: WorkflowExecution[]
  loading?: boolean
  currentPage?: number
  totalCount?: number
  pageSize?: number
  onPageChange?: (page: number) => void
  onPageSizeChange?: (size: number) => void
  onRowClick?: (execution: WorkflowExecution) => void
}

export function WorkflowExecutionsTable({
  executions,
  loading = false,
  currentPage = 1,
  totalCount = 0,
  pageSize = 10,
  onPageChange,
  onPageSizeChange,
  onRowClick,
}: WorkflowExecutionsTableProps) {
  const getStatusBadge = (status: WorkflowExecution["status"]) => {
    const baseClasses = "px-2 py-1 rounded-full text-xs font-medium"
    switch (status) {
      case "Success":
        return `${baseClasses} bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300`
      case "Running":
        return `${baseClasses} bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-300`
      case "Failed":
        return `${baseClasses} bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300`
      default:
        return `${baseClasses} bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-300`
    }
  }

  const totalPages = Math.ceil(totalCount / pageSize)
  const paginatedExecutions = executions

  if (loading) {
    return (
      <div className="space-y-4">
        {/* Search bar skeleton */}
        <div className="flex justify-between items-center">
          <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded-md w-80 animate-pulse"></div>
          <div className="flex gap-2">
            <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded-md w-32 animate-pulse"></div>
            <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded-md w-24 animate-pulse"></div>
          </div>
        </div>

        {/* Table skeleton */}
        <div className="border border-gray-200 dark:border-gray-800 rounded-lg">
          <div className="h-12 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 animate-pulse"></div>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 border-b border-gray-200 dark:border-gray-700 animate-pulse bg-white dark:bg-gray-900"></div>
          ))}
        </div>
      </div>
    )
  }

  // Show empty state if no executions
  if (executions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 h-[90%] min-h-[400px]">
        <img
          src={emptyStateIcon}
          alt="No executions"
          className="w-36 h-36 mb-2 dark:invert"
          style={{ filter: 'brightness(0) saturate(100%) invert(47%) sepia(0%) saturate(0%) hue-rotate(180deg) brightness(92%) contrast(85%)' }}
        />
        <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-2 text-lg">
          No executions yet
        </h3>
        <p className="text-gray-400 dark:text-gray-400 text-center text-base">
          Workflow executions will appear here
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Table */}
      <div className="border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900">
        <Table>
          <TableHeader>
            <TableRow className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <TableHead className="text-gray-900 dark:text-gray-100">Workflow Name</TableHead>
              <TableHead className="text-gray-900 dark:text-gray-100">Workflow ID</TableHead>
              <TableHead className="text-gray-900 dark:text-gray-100">Status</TableHead>
              <TableHead className="text-gray-900 dark:text-gray-100">Started</TableHead>
              <TableHead className="text-gray-900 dark:text-gray-100">Run Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedExecutions.map((execution) => (
              <TableRow
                key={execution.id}
                onClick={() => onRowClick?.(execution)}
                className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 border-b border-gray-200 dark:border-gray-700"
              >
                <TableCell className="font-medium py-4 text-gray-900 dark:text-gray-100">
                  {execution.workflowName}
                </TableCell>
                <TableCell className="text-gray-600 dark:text-gray-400 py-4">
                  {execution.workflowId}
                </TableCell>
                <TableCell className="py-4">
                  <span className={getStatusBadge(execution.status)}>
                    {execution.status}
                  </span>
                </TableCell>
                <TableCell className="text-gray-600 dark:text-gray-400 py-4">
                  {execution.started}
                </TableCell>
                <TableCell className="text-gray-600 dark:text-gray-400 py-4">
                  {execution.runTime}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow className="bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
              <TableCell colSpan={5} className="px-4 py-3">
                <div className="flex items-center justify-between w-full">
                  <div
                    className="flex items-center gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="text-sm text-gray-600 dark:text-gray-400">Rows per page</span>
                    <select
                      value={pageSize}
                      onChange={(e) =>
                        onPageSizeChange?.(Number(e.target.value))
                      }
                      onClick={(e) => e.stopPropagation()}
                      className="px-2 py-1 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded text-sm text-black dark:text-white focus:outline-none focus:border-gray-300 dark:focus:border-gray-500"
                    >
                      <option value={10}>10</option>
                      <option value={25}>25</option>
                      <option value={50}>50</option>
                    </select>
                  </div>

                  <div
                    className="flex items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onPageChange?.(Math.max(currentPage - 1, 1))
                      }}
                      disabled={currentPage === 1}
                      className="w-7 h-7 flex items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-200 dark:hover:bg-gray-600"
                    >
                      ←
                    </button>

                    <div className="flex gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onPageChange?.(currentPage)
                        }}
                        className="w-7 h-7 flex items-center justify-center text-sm rounded-lg bg-gray-700 dark:bg-gray-300 text-white dark:text-gray-900"
                      >
                        {currentPage}
                      </button>

                      {currentPage < totalPages && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            onPageChange?.(currentPage + 1)
                          }}
                          className="w-7 h-7 flex items-center justify-center text-sm rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                        >
                          {currentPage + 1}
                        </button>
                      )}
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onPageChange?.(Math.min(currentPage + 1, totalPages))
                      }}
                      disabled={currentPage === totalPages}
                      className="w-7 h-7 flex items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-200 dark:hover:bg-gray-600"
                    >
                      →
                    </button>
                  </div>
                </div>
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </div>
  )
}
