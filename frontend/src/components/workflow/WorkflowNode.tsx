import React from "react"
import { Handle, Position } from "@xyflow/react"

export interface WorkflowNodeProps{
  // Required props
  icon: React.ReactNode
  title: string
  description: string
  
  // Configuration state
  isConfigured: boolean
  
  // Styling
  iconColor: string
  iconBgColorClass: string // e.g., "bg-blue-50 dark:bg-blue-900/50"
  
  // Event handlers  
  id: string
  selected: boolean
  isConnectable: boolean
  hasNext?: boolean
  onNextStepClick?: (nodeId: string) => void
  
  // Optional props for configured state
  configuredWidth?: string // default: "320px"
  configuredHeight?: string // default: "122px"
  iconSizeConfigured?: number // default: 16
  iconSizeUnconfigured?: number // default: 20
}

const WorkflowNode: React.FC<WorkflowNodeProps> = ({
    icon,
    title,
    description,
    isConfigured,
    iconColor,
    iconBgColorClass,
    id,
    selected,
    isConnectable,
    hasNext = false,
    onNextStepClick,
    configuredWidth = "320px",
    configuredHeight = "122px",
    iconSizeConfigured = 16,
    iconSizeUnconfigured = 20,
}) => {
  
    if (!isConfigured) {
        // Show only icon when not configured
        return (
            <>
                <div
                    className={`relative cursor-pointer hover:shadow-lg transition-all bg-white dark:bg-gray-800 border-2 ${selected
                            ? "border-gray-800 dark:border-gray-300 shadow-lg"
                            : "border-gray-300 dark:border-gray-600"
                        }`}
                    style={{
                        width: "80px",
                        height: "80px",
                        borderRadius: "12px",
                        boxShadow: "0 0 0 2px #E2E2E2",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                    }}
                >
                    {/* Icon with background */}
                    <div
                        className={`flex justify-center items-center flex-shrink-0 ${iconBgColorClass}`}
                        style={{
                            display: "flex",
                            width: "32px",
                            height: "32px",
                            padding: "6px",
                            justifyContent: "center",
                            alignItems: "center",
                            borderRadius: "6px",
                        }}
                    >
                        {React.cloneElement(icon as React.ReactElement, {
                            width: iconSizeUnconfigured,
                            height: iconSizeUnconfigured,
                            color: iconColor
                        })}
                    </div>

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

                    {/* Add Next Step Button for unconfigured node */}
                    {hasNext && onNextStepClick && (
                        <div
                            className="absolute left-1/2 transform -translate-x-1/2 flex flex-col items-center cursor-pointer z-50 pointer-events-auto"
                            style={{ top: "calc(100% + 8px)" }}
                            onClick={(e) => {
                                e.stopPropagation()
                                e.preventDefault()
                                onNextStepClick(id)
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
                </div>
            </>
        )
    }

    // Show full content when configured
    return (
        <>
            <div
                className={`relative cursor-pointer hover:shadow-lg transition-all bg-white dark:bg-gray-800 border-2 ${selected
                        ? "border-gray-800 dark:border-gray-300 shadow-lg"
                        : "border-gray-300 dark:border-gray-600"
                    }`}
                style={{
                    width: configuredWidth,
                    minHeight: configuredHeight,
                    borderRadius: "12px",
                    boxShadow: "0 0 0 2px #E2E2E2",
                }}
            >
                {/* Header with icon and title */}
                <div className="flex items-center gap-3 text-left w-full px-4 pt-4 mb-3">
                    {/* Icon with background */}
                    <div
                        className={`flex justify-center items-center flex-shrink-0 ${iconBgColorClass}`}
                        style={{
                            display: "flex",
                            width: "24px",
                            height: "24px",
                            padding: "4px",
                            justifyContent: "center",
                            alignItems: "center",
                            borderRadius: "4.8px",
                        }}
                    >
                        {React.cloneElement(icon as React.ReactElement, {
                            width: iconSizeConfigured,
                            height: iconSizeConfigured,
                            color: iconColor
                        })}
                    </div>

                    <h3
                        className="text-gray-800 dark:text-gray-200 truncate flex-1"
                        style={{
                            fontFamily: "Inter",
                            fontSize: "14px",
                            fontStyle: "normal",
                            fontWeight: "600",
                            lineHeight: "normal",
                            letterSpacing: "-0.14px",
                        }}
                    >
                        {title}
                    </h3>
                </div>

                {/* Full-width horizontal divider */}
                <div className="w-full h-px bg-gray-200 dark:bg-gray-600 mb-3"></div>

                {/* Description text */}
                <div className="px-4 pb-4">
                    <p className="text-gray-600 dark:text-gray-300 text-sm leading-relaxed text-left break-words overflow-hidden">
                        {description}
                    </p>
                </div>

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

                {/* Add Next Step Button */}
                {hasNext && onNextStepClick && (
                    <div
                        className="absolute left-1/2 transform -translate-x-1/2 flex flex-col items-center cursor-pointer z-50 pointer-events-auto"
                        style={{ top: "calc(100% + 8px)" }}
                        onClick={(e) => {
                            e.stopPropagation()
                            e.preventDefault()
                            onNextStepClick(id)
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
            </div>
        </>
    )
}
export default WorkflowNode
