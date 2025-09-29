import { Handle, Position } from "@xyflow/react"

interface PlusButtonProps {
  hasNext: boolean | undefined
  nodeId: string
  isConnectable?: boolean
  showHandles?: boolean
}

export function PlusButton({ hasNext, nodeId, isConnectable, showHandles = false }: PlusButtonProps) {
  return (
    <>
      {showHandles && (
        <>
          {/* ReactFlow Handles - invisible but functional */}
          <Handle
            type="target"
            position={Position.Top}
            id="top"
            isConnectable={isConnectable}
            className="opacity-0"
          />
          <Handle
            type="source"
            position={Position.Bottom}
            id="bottom"
            isConnectable={isConnectable}
            className="opacity-0"
          />
          {/* Bottom center connection point - visual only */}
          <div className="absolute -bottom-1.5 left-1/2 transform -translate-x-1/2">
            <div className="w-3 h-3 bg-gray-400 dark:bg-gray-500 rounded-full border-2 border-white dark:border-gray-900 shadow-sm"></div>
          </div>
        </>
      )}
      
      {hasNext && (
        <div
          className="absolute left-1/2 transform -translate-x-1/2 flex flex-col items-center cursor-pointer z-50 pointer-events-auto"
          style={{ top: "calc(100% + 8px)" }}
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            const event = new CustomEvent("openWhatHappensNext", {
              detail: { nodeId },
            })
            window.dispatchEvent(event)
          }}
        >
          <div className="w-0.5 h-6 bg-gray-300 dark:bg-gray-600 mb-2"></div>
          <div
            className="bg-black hover:bg-gray-800 rounded-full flex items-center justify-center transition-colors shadow-lg"
            style={{
              width: "28px",
              height: "28px",
            }}
          >
            <svg
              className="w-4 h-4 text-white"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </div>
        </div>
      )}
    </>
  )
}