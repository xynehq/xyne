import { useState } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableFooter,
} from "@/components/ui/table"

interface WorkflowExecution {
  id: string;
  workflowName: string;
  workflowId: string;
  status: 'Success' | 'Running' | 'Failed';
  started: string;
  runTime: string;
}

interface WorkflowExecutionsTableProps {
  executions: WorkflowExecution[];
  loading?: boolean;
  currentPage?: number;
  totalCount?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  onRowClick?: (execution: WorkflowExecution) => void;
}

export function WorkflowExecutionsTable({ 
  executions, 
  loading = false,
  currentPage = 1,
  totalCount = 0,
  pageSize = 10,
  onPageChange,
  onPageSizeChange,
  onRowClick
}: WorkflowExecutionsTableProps) {

  const getStatusBadge = (status: WorkflowExecution['status']) => {
    const baseClasses = "px-2 py-1 rounded-full text-xs font-medium";
    switch (status) {
      case 'Success':
        return `${baseClasses} bg-green-100 text-green-800`;
      case 'Running':
        return `${baseClasses} bg-orange-100 text-orange-800`;
      case 'Failed':
        return `${baseClasses} bg-red-100 text-red-800`;
      default:
        return `${baseClasses} bg-gray-100 text-gray-800`;
    }
  };

  const totalPages = Math.ceil(totalCount / pageSize);
  const paginatedExecutions = executions;


  if (loading) {
    return (
      <div className="space-y-4">
        {/* Search bar skeleton */}
        <div className="flex justify-between items-center">
          <div className="h-10 bg-gray-200 rounded-md w-80 animate-pulse"></div>
          <div className="flex gap-2">
            <div className="h-10 bg-gray-200 rounded-md w-32 animate-pulse"></div>
            <div className="h-10 bg-gray-200 rounded-md w-24 animate-pulse"></div>
          </div>
        </div>
        
        {/* Table skeleton */}
        <div className="border rounded-lg">
          <div className="h-12 bg-gray-50 border-b animate-pulse"></div>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 border-b animate-pulse bg-white"></div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Table */}
      <div className="border rounded-lg bg-white">
        <Table>
          <TableHeader>
            <TableRow className="bg-gray-50">
              <TableHead>Workflow Name</TableHead>
              <TableHead>Workflow ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Run Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedExecutions.map((execution) => (
              <TableRow 
                key={execution.id}
                onClick={() => onRowClick?.(execution)}
                className="cursor-pointer hover:bg-gray-50"
              >
                <TableCell className="font-medium py-4">{execution.workflowName}</TableCell>
                <TableCell className="text-gray-600 py-4">{execution.workflowId}</TableCell>
                <TableCell className="py-4">
                  <span className={getStatusBadge(execution.status)}>
                    {execution.status}
                  </span>
                </TableCell>
                <TableCell className="text-gray-600 py-4">{execution.started}</TableCell>
                <TableCell className="text-gray-600 py-4">{execution.runTime}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={5} className="px-4 py-3">
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <span className="text-sm text-gray-600">Rows per page</span>
                    <select 
                      value={pageSize}
                      onChange={(e) => onPageSizeChange?.(Number(e.target.value))}
                      onClick={(e) => e.stopPropagation()}
                      className="px-2 py-1 bg-white border border-gray-300 rounded text-sm text-black focus:outline-none focus:border-gray-300"
                    >
                      <option value={10}>10</option>
                      <option value={25}>25</option>
                      <option value={50}>50</option>
                    </select>
                  </div>
                  
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onPageChange?.(Math.max(currentPage - 1, 1));
                      }}
                      disabled={currentPage === 1}
                      className="w-7 h-7 flex items-center justify-center rounded-lg bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-200"
                    >
                      ←
                    </button>
                    
                    <div className="flex gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onPageChange?.(currentPage);
                        }}
                        className="w-7 h-7 flex items-center justify-center text-sm rounded-lg bg-gray-700 text-white"
                      >
                        {currentPage}
                      </button>
                      
                      {currentPage < totalPages && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onPageChange?.(currentPage + 1);
                          }}
                          className="w-7 h-7 flex items-center justify-center text-sm rounded-lg bg-gray-100 hover:bg-gray-200"
                        >
                          {currentPage + 1}
                        </button>
                      )}
                    </div>
                    
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onPageChange?.(Math.min(currentPage + 1, totalPages));
                      }}
                      disabled={currentPage === totalPages}
                      className="w-7 h-7 flex items-center justify-center rounded-lg bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-200"
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
  );
}