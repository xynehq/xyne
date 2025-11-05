import React, { useCallback, useState, useEffect } from "react"
import { Bot, Mail, Settings, X, FileTextIcon , FileText} from "lucide-react"
import {
  ReactFlow,
  ReactFlowProvider,
  Node,
  Edge,
  addEdge,
  ConnectionLineType,
  useNodesState,
  useEdgesState,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  NodeProps,
  Connection,
  useReactFlow,
  OnNodesDelete,
  OnEdgesDelete,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import {
  Flow,
  TemplateFlow,
  Step,
  UserDetail,
  Tool,
} from "./Types"

// Type for execution workflow data
interface ExecutionWorkflowData {
  id: string
  name: string
  userId: number
  workspaceId: number
  description?: string
  version?: string
  status: string
  config?: {
    ai_model?: string
    max_file_size?: string
    auto_execution?: boolean
    schema_version?: string
    allowed_file_types?: string[]
    supports_file_upload?: boolean
  }
  rootWorkflowStepTemplateId?: string
  rootWorkflowStepExeId?: string // For execution workflows
  createdAt: string
  updatedAt: string
  // For execution workflows
  stepExecutions?: Array<{
    id: string
    workflowStepTemplateId: string
    name: string
    description?: string
    type: string
    status: string
    prevStepIds: string[]
    nextStepIds: string[]
    toolExecIds: string[]
    metadata?: {
      icon?: string
      step_order?: number
      schema_version?: string
      user_instructions?: string
      ai_model?: string
      automated_description?: string
      formSubmission?: any
      webhookData?: any
      triggeredByWebhook?: boolean
    }
    createdAt: string
    updatedAt: string
    completedAt?: string
  }>
  toolExecutions?: Array<{
    id: string
    type: string
    toolType: string
    status: string
    result?: any
    createdAt: string
    updatedAt: string
  }>
  // For template workflows (fallback)
  steps?: Array<{
    id: string
    workflowTemplateId: string
    name: string
    description: string
    type: string
    parentStepId: string | null
    prevStepIds: string[]
    nextStepIds: string[]
    toolIds: string[]
    timeEstimate: number
    metadata: {
      icon?: string
      step_order?: number
      schema_version?: string
      user_instructions?: string
      ai_model?: string
      automated_description?: string
    }
    createdAt: string
    updatedAt: string
  }>
  workflow_tools?: Array<{
    id: string
    type: string
    value: any
    config: any
    workspaceId: number
    userId: number
    createdAt: string
    updatedAt: string
  }>
}


// Custom Node Component
const StepNode: React.FC<NodeProps> = ({
  data,
  isConnectable,
  selected,
}) => {
  const { step, isActive, isCompleted, tools } = data as {
    step: Step
    isActive?: boolean
    isCompleted?: boolean
    tools?: Tool[]
  }

  // Special rendering for AI Agent nodes and steps with ai_agent tools
  const hasAIAgentTool =
    tools && tools.length > 0 && tools[0].type === "ai_agent"
  if (step.type === "ai_agent" || hasAIAgentTool) {
    // Get config from step or tool
    const aiConfig =
      (step as any).config || (hasAIAgentTool && tools?.[0]?.config) || {}
    const isConfigured = aiConfig?.name && aiConfig?.name.trim() !== ""

    // For executions, always show configured layout even if config is missing
    const isExecution = (step as any).isExecution
    const forceConfiguredLayout = isExecution || isConfigured

    // Check if any associated tool execution has failed
    const hasFailedToolExecution =
      tools && tools.some((tool) => (tool as any).status === "failed")
    const isFailed = step.status === "failed" || hasFailedToolExecution

    if (!forceConfiguredLayout) {
      // Show only icon when not configured (template mode only)
      return (
        <>
          <div
            className="relative cursor-pointer hover:shadow-lg transition-shadow"
            style={{
              width: "80px",
              height: "80px",
              borderRadius: "12px",
              border: "2px solid #181B1D",
              background: "#FFF",
              boxShadow: "0 0 0 2px #E2E2E2",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {/* Blue bot icon with background */}
            <div
              className="flex justify-center items-center flex-shrink-0"
              style={{
                display: "flex",
                width: "32px",
                height: "32px",
                padding: "6px",
                justifyContent: "center",
                alignItems: "center",
                borderRadius: "6px",
                background: "#EBF4FF",
              }}
            >
              <Bot width={20} height={20} color="#2563EB" />
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

          </div>
        </>
      )
    }

    // Show full content when configured
    return (
      <>
        <div
          className="relative cursor-pointer hover:shadow-lg transition-shadow"
          style={{
            width: "320px",
            minHeight: "122px",
            borderRadius: "12px",
            border: isFailed
              ? "2px solid #EF4444"
              : isCompleted
                ? "2px solid #10B981"
                : "2px solid #181B1D",
            background: isFailed ? "#FEF2F2" : isCompleted ? "#F0FDF4" : "#FFF",
            boxShadow: isFailed
              ? "0 0 0 2px #FECACA"
              : isCompleted
                ? "0 0 0 2px #BBF7D0"
                : "0 0 0 2px #E2E2E2",
          }}
        >
          {/* Header with icon and title */}
          <div className="flex items-center gap-3 text-left w-full px-4 pt-4 mb-3">
            {/* Blue bot icon with background */}
            <div
              className="flex justify-center items-center flex-shrink-0"
              style={{
                display: "flex",
                width: "24px",
                height: "24px",
                padding: "4px",
                justifyContent: "center",
                alignItems: "center",
                borderRadius: "4.8px",
                background: "#EBF4FF",
              }}
            >
              <Bot width={16} height={16} color="#2563EB" />
            </div>

            <h3
              className="text-gray-800 truncate flex-1"
              style={{
                fontFamily: "Inter",
                fontSize: "14px",
                fontStyle: "normal",
                fontWeight: "600",
                lineHeight: "normal",
                letterSpacing: "-0.14px",
                color: "#3B4145",
              }}
            >
              {step.name || aiConfig?.name || "AI Agent"}
              {/* Show execution status indicator */}
              {isExecution && isActive && (
                <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">
                  Running
                </span>
              )}
              {isExecution && isFailed && step.status !== "failed" && (
                <span className="ml-2 text-xs bg-red-100 text-red-800 px-2 py-1 rounded-full">
                  Tool Failed
                </span>
              )}
            </h3>
          </div>

          {/* Full-width horizontal divider */}
          <div className="w-full h-px bg-gray-200 mb-3"></div>

          {/* Description text */}
          <div className="px-4 pb-4">
            <p className="text-gray-600 text-sm leading-relaxed text-left break-words overflow-hidden">
              {step.description ||
                aiConfig?.description ||
                `AI agent to analyze and summarize documents using model ${aiConfig?.model || "gpt-oss-120b"}.`}
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
            <div className="w-3 h-3 bg-gray-400 rounded-full border-2 border-white shadow-sm"></div>
          </div>

        </div>
      </>
    )
  }

  // Special rendering for Email nodes and steps with email tools
  const hasEmailTool = tools && tools.length > 0 && tools[0].type === "email"
  if (step.type === "email" || hasEmailTool) {
    // Get config from step or tool
    const emailConfig =
      (step as any).config || {}
    const emailAddresses =
      emailConfig?.emailAddresses ||
      emailConfig?.to_email ||
      []
    // Consider configured if has email addresses OR if step has name/description
    const isConfigured =
      (Array.isArray(emailAddresses) && emailAddresses.length > 0) ||
      step.name ||
      step.description

    // For executions, always show configured layout even if config is missing
    const isExecution = (step as any).isExecution
    const forceConfiguredLayout = isExecution || isConfigured

    // Check if any associated tool execution has failed
    const hasFailedToolExecution =
      tools && tools.some((tool) => (tool as any).status === "failed")
    const isFailed = step.status === "failed" || hasFailedToolExecution

    if (!forceConfiguredLayout) {
      // Show only icon when not configured
      return (
        <>
          <div
            className="relative cursor-pointer hover:shadow-lg transition-shadow"
            style={{
              width: "80px",
              height: "80px",
              borderRadius: "12px",
              border: "2px solid #181B1D",
              background: "#FFF",
              boxShadow: "0 0 0 2px #E2E2E2",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {/* Purple mail icon with background */}
            <div
              className="flex justify-center items-center flex-shrink-0"
              style={{
                display: "flex",
                width: "32px",
                height: "32px",
                padding: "6px",
                justifyContent: "center",
                alignItems: "center",
                borderRadius: "6px",
                background: "#F3E8FF",
              }}
            >
              <Mail width={20} height={20} color="#7C3AED" />
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

          </div>
        </>
      )
    }

    // Show full content when configured
    return (
      <>
        <div
          className="relative cursor-pointer hover:shadow-lg transition-shadow"
          style={{
            width: "320px",
            minHeight: "122px",
            borderRadius: "12px",
            border: isFailed
              ? "2px solid #EF4444"
              : isCompleted
                ? "2px solid #10B981"
                : "2px solid #181B1D",
            background: isFailed ? "#FEF2F2" : isCompleted ? "#F0FDF4" : "#FFF",
            boxShadow: isFailed
              ? "0 0 0 2px #FECACA"
              : isCompleted
                ? "0 0 0 2px #BBF7D0"
                : "0 0 0 2px #E2E2E2",
          }}
        >
          {/* Header with icon and title */}
          <div className="flex items-center gap-3 text-left w-full px-4 pt-4 mb-3">
            {/* Purple mail icon with background */}
            <div
              className="flex justify-center items-center flex-shrink-0"
              style={{
                display: "flex",
                width: "24px",
                height: "24px",
                padding: "4px",
                justifyContent: "center",
                alignItems: "center",
                borderRadius: "4.8px",
                background: "#F3E8FF",
              }}
            >
              <Mail width={16} height={16} color="#7C3AED" />
            </div>

            <h3
              className="text-gray-800 truncate flex-1"
              style={{
                fontFamily: "Inter",
                fontSize: "14px",
                fontStyle: "normal",
                fontWeight: "600",
                lineHeight: "normal",
                letterSpacing: "-0.14px",
                color: "#3B4145",
              }}
            >
              {step.name || "Email"}
              {/* Show execution status indicator */}
              {isExecution && isActive && (
                <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">
                  Running
                </span>
              )}
              {isExecution && isFailed && step.status !== "failed" && (
                <span className="ml-2 text-xs bg-red-100 text-red-800 px-2 py-1 rounded-full">
                  Tool Failed
                </span>
              )}
            </h3>
          </div>

          {/* Full-width horizontal divider */}
          <div className="w-full h-px bg-gray-200 mb-3"></div>

          {/* Description text */}
          <div className="px-4 pb-4">
            <p className="text-gray-600 text-sm leading-relaxed text-left break-words overflow-hidden">
              {step.description ||
                (emailAddresses && emailAddresses.length > 0
                  ? `Send emails to ${emailAddresses.join(", ")} via automated workflow.`
                  : "Send automated email notifications to specified recipients.")}
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
            <div className="w-3 h-3 bg-gray-400 rounded-full border-2 border-white shadow-sm"></div>
          </div>

        </div>
      </>
    )
  }

  // Special rendering for form submission nodes and steps with form tools
  const hasFormTool = tools && tools.length > 0 && tools[0].type === "form"
  if (step.type === "form_submission" || hasFormTool) {
    // Check if any associated tool execution has failed
    const hasFailedToolExecution =
      tools && tools.some((tool) => (tool as any).status === "failed")
    const isFailed = step.status === "failed" || hasFailedToolExecution
    return (
      <>
        <div
          className="relative cursor-pointer hover:shadow-lg transition-shadow"
          style={{
            width: "320px",
            minHeight: "122px",
            borderRadius: "12px",
            border: isFailed
              ? "2px solid #EF4444"
              : isCompleted
                ? "2px solid #10B981"
                : "2px solid #181B1D",
            background: isFailed ? "#FEF2F2" : isCompleted ? "#F0FDF4" : "#FFF",
            boxShadow: isFailed
              ? "0 0 0 2px #FECACA"
              : isCompleted
                ? "0 0 0 2px #BBF7D0"
                : "0 0 0 2px #E2E2E2",
          }}
        >
          {/* Header with icon and title */}
          <div className="flex items-center gap-3 text-left w-full px-4 pt-4 mb-3">
            {/* Green document icon with background */}
            <div
              className="flex justify-center items-center flex-shrink-0"
              style={{
                display: "flex",
                width: "24px",
                height: "24px",
                padding: "4px",
                justifyContent: "center",
                alignItems: "center",
                borderRadius: "4.8px",
                background: "#E8F9D1",
              }}
            >
              <FileTextIcon width={16} height={16} />
            </div>

            <h3
              className="text-gray-800 truncate flex-1"
              style={{
                fontFamily: "Inter",
                fontSize: "14px",
                fontStyle: "normal",
                fontWeight: "600",
                lineHeight: "normal",
                letterSpacing: "-0.14px",
                color: "#3B4145",
              }}
            >
              {step.name ||
                (step as any).config?.title ||
                "Form Submission"}
              {/* Show execution status indicator */}
              {(step as any).isExecution && isActive && (
                <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">
                  Running
                </span>
              )}
              {(step as any).isExecution &&
                isFailed &&
                step.status !== "failed" && (
                  <span className="ml-2 text-xs bg-red-100 text-red-800 px-2 py-1 rounded-full">
                    Tool Failed
                  </span>
                )}
            </h3>
          </div>

          {/* Full-width horizontal divider */}
          <div className="w-full h-px bg-gray-200 mb-3"></div>

          {/* Description text */}
          <div className="px-4 pb-4">
            <p className="text-gray-600 text-sm leading-relaxed text-left break-words overflow-hidden">
              {(() => {
                // Use step description if available
                if (step.description) {
                  return step.description
                }

                // Get config from step
                const config = (step as any).config || {}

                // If user has configured the form, show form details
                if (
                  config?.title ||
                  config?.description ||
                  (config?.fields && config.fields.length > 0)
                ) {
                  const fieldCount = config?.fields?.length || 0
                  const fields = config?.fields || []

                  // Build description based on what's configured
                  let description = ""

                  if (config.description) {
                    description = config.description

                    // Add field information even with custom description
                    if (fields.length > 0) {
                      const fieldDescriptions = fields.map((field: any) => {
                        if (field.type === "file") {
                          return `Upload a ${field.name || "file"} in formats such as PDF or DOCX`
                        } else if (field.type === "email") {
                          return `Enter ${field.name || "email address"}`
                        } else if (field.type === "text") {
                          return `Enter ${field.name || "text"}`
                        } else if (field.type === "textarea") {
                          return `Enter ${field.name || "detailed text"}`
                        } else if (field.type === "number") {
                          return `Enter ${field.name || "number"}`
                        }
                        return `${field.name || field.type}`
                      })

                      description += `. ${fieldDescriptions.join(", ")}`
                    }
                  } else if (config.title) {
                    description = `Form "${config.title}" with ${fieldCount} field${fieldCount !== 1 ? "s" : ""}`

                    // Add field details
                    if (fields.length > 0) {
                      const fieldDescriptions = fields.map((field: any) => {
                        if (field.type === "file") {
                          return `Upload a ${field.name || "file"} in formats such as PDF or DOCX`
                        } else if (field.type === "email") {
                          return `Enter ${field.name || "email address"}`
                        } else if (field.type === "text") {
                          return `Enter ${field.name || "text"}`
                        } else if (field.type === "textarea") {
                          return `Enter ${field.name || "detailed text"}`
                        } else if (field.type === "number") {
                          return `Enter ${field.name || "number"}`
                        }
                        return `${field.name || field.type}`
                      })

                      if (fieldDescriptions.length === 1) {
                        description = fieldDescriptions[0]
                      } else {
                        description += `. Fields: ${fieldDescriptions.join(", ")}`
                      }
                    }
                  } else if (fieldCount > 0) {
                    // Show field details when only fields are configured
                    const fieldDescriptions = fields.map((field: any) => {
                      if (field.type === "file") {
                        return `Upload a ${field.name || "file"} in formats such as PDF or DOCX`
                      } else if (field.type === "email") {
                        return `Enter ${field.name || "email address"}`
                      } else if (field.type === "text") {
                        return `Enter ${field.name || "text"}`
                      } else if (field.type === "textarea") {
                        return `Enter ${field.name || "detailed text"}`
                      } else if (field.type === "number") {
                        return `Enter ${field.name || "number"}`
                      }
                      return `${field.name || field.type}`
                    })

                    if (fieldDescriptions.length === 1) {
                      description = fieldDescriptions[0]
                    } else {
                      description = `Form with ${fieldCount} fields: ${fieldDescriptions.join(", ")}`
                    }
                  }

                  return description || "Custom form configuration"
                }

                // Fallback content when no configuration
                return "Upload a file in formats such as PDF or DOCX."
              })()}
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
            <div className="w-3 h-3 bg-gray-400 rounded-full border-2 border-white shadow-sm"></div>
          </div>

        </div>
      </>
    )
  }


  // For executions, create a generic template-style node if no specific type matched
  const isExecution = (step as any).isExecution
  if (isExecution) {
    // Check if any associated tool execution has failed
    const hasFailedToolExecution =
      tools && tools.some((tool) => (tool as any).status === "failed")
    const isFailed = step.status === "failed" || hasFailedToolExecution
    // Use template-style design for any execution node that didn't match above types
    return (
      <>
        <div
          className="relative cursor-pointer hover:shadow-lg transition-shadow"
          style={{
            width: "320px",
            minHeight: "122px",
            borderRadius: "12px",
            border: isFailed
              ? "2px solid #EF4444"
              : isCompleted
                ? "2px solid #10B981"
                : "2px solid #181B1D",
            background: isFailed ? "#FEF2F2" : isCompleted ? "#F0FDF4" : "#FFF",
            boxShadow: isFailed
              ? "0 0 0 2px #FECACA"
              : isCompleted
                ? "0 0 0 2px #BBF7D0"
                : "0 0 0 2px #E2E2E2",
          }}
        >
          {/* Header with icon and title */}
          <div className="flex items-center gap-3 text-left w-full px-4 pt-4 mb-3">
            {/* Generic step icon */}
            <div
              className="flex justify-center items-center flex-shrink-0"
              style={{
                display: "flex",
                width: "24px",
                height: "24px",
                padding: "4px",
                justifyContent: "center",
                alignItems: "center",
                borderRadius: "4.8px",
                background: "#E5E7EB",
              }}
            >
              <Settings width={16} height={16} color="#6B7280" /> 
            </div>

            <h3
              className="text-gray-800 truncate flex-1"
              style={{
                fontFamily: "Inter",
                fontSize: "14px",
                fontStyle: "normal",
                fontWeight: "600",
                lineHeight: "normal",
                letterSpacing: "-0.14px",
                color: "#3B4145",
              }}
            >
              {step.name || "Step"}
              {/* Show execution status indicator */}
              {isActive && (
                <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">
                  Running
                </span>
              )}
              {isFailed && step.status !== "failed" && (
                <span className="ml-2 text-xs bg-red-100 text-red-800 px-2 py-1 rounded-full">
                  Tool Failed
                </span>
              )}
            </h3>
          </div>

          {/* Full-width horizontal divider */}
          <div className="w-full h-px bg-gray-200 mb-3"></div>

          {/* Description text */}
          <div className="px-4 pb-4">
            <p className="text-gray-600 text-sm leading-relaxed text-left break-words overflow-hidden">
              {step.description || `Execution step: ${step.type || "unknown"}`}
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
            <div className="w-3 h-3 bg-gray-400 rounded-full border-2 border-white shadow-sm"></div>
          </div>
        </div>
      </>
    )
  }

  // Template mode: use original generic step node design
  const getNodeClasses = () => {
    const baseClasses =
      "rounded-2xl border-2 transition-all duration-300 ease-in-out p-6 min-w-[180px] min-h-[90px] text-center flex flex-col items-center justify-center cursor-pointer relative backdrop-blur-sm"

    if (isCompleted) {
      return `${baseClasses} border-emerald-600 bg-gradient-to-br from-emerald-50 to-emerald-100 dark:from-emerald-900/30 dark:to-emerald-800/20 text-emerald-900 dark:text-emerald-300 shadow-lg shadow-emerald-500/15`
    }

    if (isActive) {
      return `${baseClasses} border-blue-600 bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/30 dark:to-blue-800/20 text-blue-900 dark:text-blue-300 shadow-lg shadow-blue-500/15`
    }

    if (selected) {
      return `${baseClasses} border-purple-600 bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/30 dark:to-purple-800/20 text-purple-900 dark:text-purple-300 shadow-xl shadow-purple-500/15`
    }

    return `${baseClasses} border-gray-200 dark:border-gray-700 bg-gradient-to-br from-white to-gray-50 dark:from-gray-800 dark:to-gray-700 text-gray-700 dark:text-gray-300 shadow-md shadow-black/8 dark:shadow-black/20`
  }

  return (
    <>
      <div className={getNodeClasses()}>
        <Handle
          type="target"
          position={Position.Top}
          id="top"
          isConnectable={isConnectable}
          className={`w-3 h-3 border-2 border-white dark:border-gray-900 shadow-sm ${
            isCompleted
              ? "bg-emerald-600"
              : isActive
                ? "bg-blue-600"
                : "bg-gray-400 dark:bg-gray-500"
          }`}
        />

        <div className="flex items-center gap-2 mb-1">
          {isCompleted && (
            <div className="w-5 h-5 rounded-full bg-emerald-600 flex items-center justify-center text-white text-xs font-bold">
              ✓
            </div>
          )}
          {isActive && !isCompleted && (
            <div className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
          )}
          <div className="font-semibold text-base leading-tight">
            {step.name || "Unnamed Step"}
          </div>
          {isActive && !isCompleted && (
            <div className="text-xs bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300 px-2 py-1 rounded-full">
              Running
            </div>
          )}
        </div>

        {/* Status indicator */}
        {step.status && (
          <div className="text-xs opacity-70 uppercase tracking-wider font-medium mb-1">
            {step.status === "running" || step.status === "in_progress"
              ? "In Progress"
              : step.status === "completed" || step.status === "done"
                ? "Completed"
                : step.status === "pending"
                  ? "Pending"
                  : step.status}
          </div>
        )}

        <Handle
          type="source"
          position={Position.Bottom}
          id="bottom"
          isConnectable={isConnectable}
          className={`w-3 h-3 border-2 border-white dark:border-gray-900 shadow-sm ${
            isCompleted
              ? "bg-emerald-600"
              : isActive
                ? "bg-blue-600"
                : "bg-gray-400 dark:bg-gray-500"
          }`}
        />

      </div>
    </>
  )
}

// Header component
const Header = ({
  onBackToWorkflows,
  workflowName,
}: { onBackToWorkflows?: () => void; workflowName?: string }) => {
  return (
    <div className="flex flex-col items-start justify-center px-6 py-4 border-b border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-900 min-h-[80px] gap-3">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 w-full">
        <div className="text-slate-500 dark:text-gray-400 text-sm font-normal leading-5">
          <span
            className="cursor-pointer hover:text-slate-700 dark:hover:text-gray-300"
            onClick={onBackToWorkflows}
          >
            Workflow
          </span>
          <span className="text-[#3B4145] dark:text-gray-300 text-sm font-medium leading-5">
            {" "}
            / {workflowName || "Untitled Workflow"}
          </span>
        </div>
      </div>
    </div>
  )
}

// Right Sidebar - SELECT TRIGGERS Panel
// Execution Result Modal Component
const ExecutionResultModal = ({
  isVisible,
  result,
  onClose,
}: {
  isVisible: boolean
  result: any
  onClose?: () => void
}) => {
  if (!isVisible) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl max-w-6xl w-full max-h-[90vh] mx-4 relative overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">
            Execution Result
          </h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(90vh-120px)]">
          <div className="bg-gray-50 p-4 rounded-lg border">
            {(() => {
              const resultString =
                typeof result === "object"
                  ? JSON.stringify(result, null, 2)
                  : String(result)              
                return (
                  <pre className="whitespace-pre-wrap text-sm text-gray-800 font-mono leading-relaxed">
                    {resultString}
                  </pre>
                )
            })()}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end p-6 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded-md transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}



// Execution Sidebar Component
const ExecutionSidebar = ({
  isVisible,
  executionNode,
  workflowData,
  onClose,
  onResultClick,
}: {
  isVisible: boolean
  executionNode: any
  workflowData?: any
  onClose?: () => void
  onResultClick?: (result: any) => void
}) => {
  if (!executionNode) return null

  const { step, tools } = executionNode

  // Find previous step's output for input
  const getPreviousStepOutput = () => {
    if (!step.prevStepIds || step.prevStepIds.length === 0 || !workflowData)
      return null

    // Get the first previous step (assuming single previous step for simplicity)
    const prevStepTemplateId = step.prevStepIds[0]

    // Find previous step execution by matching workflowStepTemplateId
    const prevStep = workflowData.stepExecutions?.find(
      (s: any) => s.workflowStepTemplateId === prevStepTemplateId,
    )

    if (!prevStep) return null

    // Get previous step's tool outputs
    const prevStepTools =
      workflowData.toolExecutions?.filter((toolExec: any) =>
        prevStep.toolExecIds?.includes(toolExec.id),
      ) || []

    if (prevStepTools.length === 0) return null

    // Return the results from all previous step tools
    const results = prevStepTools
      .map((tool: any) => tool.result)
      .filter(Boolean)
    return results
  }

  return (
    <div
      className={`h-full bg-white border-l border-slate-200 flex flex-col overflow-hidden transition-transform duration-300 ease-in-out ${
        isVisible ? "translate-x-0 w-[400px]" : "translate-x-full w-0"
      }`}
    >
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-200">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-sm font-semibold text-gray-700 tracking-wider uppercase">
            EXECUTION DETAILS
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-100 rounded-md transition-colors"
            >
              <X className="w-4 h-4 text-gray-500" />
            </button>
          )}
        </div>
        <div className="text-sm text-slate-500 leading-5 font-normal">
          {step?.name || "Step execution information"}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-6">
        {/* Status Section */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Status</h3>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-xs font-medium text-gray-500">
                Current Status:
              </span>
              <span
                className={`text-xs px-2 py-1 rounded-full ${
                  step.status === "completed"
                    ? "bg-green-100 text-green-700"
                    : step.status === "failed"
                      ? "bg-red-100 text-red-700"
                      : step.status === "running"
                        ? "bg-blue-100 text-blue-700"
                        : "bg-gray-100 text-gray-600"
                }`}
              >
                {step.status || "pending"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs font-medium text-gray-500">
                Step Type:
              </span>
              <span className="text-xs text-gray-900">
                {step.type || "unknown"}
              </span>
            </div>
            {step.completedAt && (
              <div className="flex justify-between">
                <span className="text-xs font-medium text-gray-500">
                  Completed:
                </span>
                <span className="text-xs text-gray-900">
                  {new Date(step.completedAt).toLocaleString()}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Input Section */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Input</h3>
          <div className="bg-gray-100 p-3 rounded-lg border max-h-40 overflow-y-auto">
            {(() => {
              // If this step has no previous steps (first step), show form data as input
              if (!step.prevStepIds || step.prevStepIds.length === 0) {
                // For first step, check if we have output data from tools to use as input display
                if (tools && tools.length > 0) {
                  return (
                    <div className="space-y-2">
                      {tools
                        .map((tool: any, index: number) => {
                          if (
                            tool.result?.formData?.document_file
                              ?.originalFileName
                          ) {
                            return (
                              <div key={index} className="text-xs">
                                <div className="text-gray-900">
                                  <span>
                                    📁{" "}
                                    {
                                      tool.result.formData.document_file
                                        .originalFileName
                                    }
                                  </span>
                                </div>
                              </div>
                            )
                          }
                          return null
                        })
                        .filter(Boolean)}
                    </div>
                  )
                }

                if (step.metadata?.formSubmission?.formData) {
                  return (
                    <div className="space-y-2">
                      {Object.entries(
                        step.metadata.formSubmission.formData,
                      ).map(([key, value]) => (
                        <div key={key} className="text-xs">
                          <span className="font-medium text-gray-600">
                            {key}:
                          </span>
                          <div className="text-gray-900 mt-1 pl-2">
                            {typeof value === "object"
                              ? (() => {
                                  // Check if it's a file upload object with originalName
                                  if (
                                    value &&
                                    typeof value === "object" &&
                                    "originalName" in value
                                  ) {
                                    return (
                                      <span>
                                        📁 {(value as any).originalName}
                                      </span>
                                    )
                                  }
                                  // Check if it's a file upload object with filename
                                  if (
                                    value &&
                                    typeof value === "object" &&
                                    "filename" in value
                                  ) {
                                    return (
                                      <span>📁 {(value as any).filename}</span>
                                    )
                                  }
                                  // Default to JSON
                                  return (
                                    <pre className="whitespace-pre-wrap">
                                      {JSON.stringify(value, null, 2)}
                                    </pre>
                                  )
                                })()
                              : String(value)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                } else {
                  return (
                    <div className="text-xs text-gray-500 italic">
                      No input data available (first step)
                    </div>
                  )
                }
              }

              // If step has previous steps, show previous step's output as input
              const previousOutput = getPreviousStepOutput()
              if (previousOutput && previousOutput.length > 0) {
                return (
                  <div className="space-y-2">
                    {previousOutput.map((output: any, index: number) => (
                      <div key={index} className="text-xs">
                        <div className="text-gray-900">
                          {(() => {
                            if (typeof output === "object" && output) {
                              // Check for email step response with model and aiOutput
                              if (output.model && output.aiOutput) {
                                return (
                                  <div className="space-y-2">
                                    <div>
                                      <span className="font-medium text-gray-600">Model:</span>
                                      <span className="ml-2 text-gray-900">{output.model}</span>
                                    </div>
                                    <div>
                                      <span className="font-medium text-gray-600">AI Output:</span>
                                      <div className="mt-1 text-gray-900 whitespace-pre-wrap">
                                        {output.aiOutput}
                                      </div>
                                    </div>
                                  </div>
                                )
                              }
                              
                              // Check for the exact same path that works in output card
                              if (
                                output.formData &&
                                output.formData.document_file &&
                                output.formData.document_file.originalFileName
                              ) {
                                return (
                                  <span>
                                    📁{" "}
                                    {
                                      output.formData.document_file
                                        .originalFileName
                                    }
                                  </span>
                                )
                              }
                              // Check for nested path: result.formData.document_file.originalFileName
                              if (
                                output.result &&
                                output.result.formData &&
                                output.result.formData.document_file &&
                                output.result.formData.document_file
                                  .originalFileName
                              ) {
                                return (
                                  <span>
                                    📁{" "}
                                    {
                                      output.result.formData.document_file
                                        .originalFileName
                                    }
                                  </span>
                                )
                              }
                              // Fallback: Check for direct file_name property (like "uber bill.pdf" case)
                              if (output.file_name) {
                                return <span>📁 {output.file_name}</span>
                              }
                              // Fallback: Check for nested file_name in result property
                              if (
                                output.result &&
                                typeof output.result === "object" &&
                                output.result.file_name
                              ) {
                                return <span>📁 {output.result.file_name}</span>
                              }
                              // Fallback: Check if this is the full output structure with file_name at root level
                              if (output.status && output.file_name) {
                                return <span>📁 {output.file_name}</span>
                              }
                            }
                            // Default to showing full JSON
                            return (
                              <pre className="whitespace-pre-wrap">
                                {typeof output === "object"
                                  ? JSON.stringify(output, null, 2)
                                  : String(output)}
                              </pre>
                            )
                          })()}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              }

              // Step has previous step but no output available
              return (
                <div className="text-xs text-gray-500 italic">
                  No input available from previous step
                </div>
              )
            })()}
          </div>
        </div>

        {/* Output Section */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Output</h3>
          {(() => {




            // Check if this is a webhook-triggered step with webhook data
            const webhookData = step.metadata?.webhookData
            const isWebhookTriggered = step.metadata?.triggeredByWebhook

            // Show tool outputs if available
            if (tools && tools.length > 0) {
              return tools.map((tool: any, index: number) => {

                return (
                  <div
                    key={tool.id || index}
                    className="border border-gray-200 rounded-lg p-4 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-900">
                        {tool.type} Tool
                      </span>
                      <div className="flex gap-2">
                        {tool.status && (
                          <span
                            className={`text-xs px-2 py-1 rounded-full ${
                              tool.status === "completed"
                                ? "bg-green-100 text-green-700"
                                : tool.status === "failed"
                                  ? "bg-red-100 text-red-700"
                                  : "bg-gray-100 text-gray-600"
                            }`}
                          >
                            {tool.status}
                          </span>
                        )}
                      </div>
                    </div>

                    {tool.result && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <h4 className="text-xs font-semibold text-gray-600">
                            Result
                          </h4>
                          {(() => {
                            // Check if this is a successful email tool execution
                            const isEmailTool = tool.type === "email"
                            const isSuccess =
                              step.status === "completed" &&
                              tool.status === "completed"
                            const hasEmailBody =
                              tool.result?.email_details

                            if (isEmailTool && isSuccess && hasEmailBody) {
                              return (
                                <button
                                  onClick={() =>
                                    onResultClick?.(
                                      tool.result,
                                    )
                                  }
                                  className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded transition-colors"
                                >
                                  View Body
                                </button>
                              )
                            } else {
                              return (
                                <button
                                  onClick={() => onResultClick?.(tool.result)}
                                  className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded transition-colors"
                                >
                                  View Full
                                </button>
                              )
                            }
                          })()}
                        </div>
                        <div
                          className="text-xs text-gray-900 bg-gray-100 p-3 rounded max-h-32 overflow-y-auto border border-gray-200 cursor-pointer hover:bg-gray-200 transition-colors"
                          onClick={() => {
                            // Check if this is a successful email tool execution
                            const isEmailTool = tool.type === "email"
                            const isSuccess =
                              step.status === "completed" &&
                              tool.status === "completed"

                            if (isEmailTool && isSuccess) {
                              const hasEmailBody =
                                tool.result?.email_details
                              if (hasEmailBody) {
                                onResultClick?.(
                                  tool.result,
                                )
                              } else {
                                onResultClick?.(tool.result)
                              }
                            } else {
                              onResultClick?.(tool.result)
                            }
                          }}
                        >
                          {(() => {
                            const isEmailTool = tool.type === "email"
                            const isSuccess =
                              step.status === "completed" &&
                              tool.status === "completed"
                            const isFailed =
                              step.status === "failed" ||
                              tool.status === "failed"

                            // Handle failed executions for any tool type
                            if (isFailed) {
                              // Extract error message from multiple possible paths
                              const error =
                                tool.result?.error ||
                                tool.result?.message ||
                                tool.result?.stderr ||
                                tool.result?.exception ||
                                `${tool.type} execution failed`
                              return <div className="text-red-700">{error}</div>
                            }

                            // Handle successful executions for any tool type
                            if (isSuccess) {
                              // For email tools, show custom message if available
                              if (isEmailTool) {
                                const message = tool.result?.message
                                if (message) {
                                  return (
                                    <div className="text-green-700">
                                      {message}
                                    </div>
                                  )
                                }
                              }

                              // For all successful tools, show generic success message
                              return (
                                <div className="text-green-700">Success</div>
                              )
                            }

                            // Default behavior - show full result
                            return (
                              <pre className="whitespace-pre-wrap">
                                {typeof tool.result === "object"
                                  ? JSON.stringify(tool.result, null, 2)
                                  : String(tool.result)}
                              </pre>
                            )
                          })()}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })
            }

            // Show webhook data if this is a webhook-triggered step
            if (isWebhookTriggered && webhookData) {
              return (
                <div className="border border-gray-200 rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-900">
                      Webhook Event Data
                    </span>
                    <span className="text-xs px-2 py-1 rounded-full bg-green-100 text-green-700">
                      received
                    </span>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-gray-600">
                        Event Payload
                      </h4>
                      <button
                        onClick={() => onResultClick?.(webhookData)}
                        className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded transition-colors"
                      >
                        View Full
                      </button>
                    </div>
                    <div
                      className="text-xs text-gray-900 bg-gray-100 p-3 rounded max-h-32 overflow-y-auto border border-gray-200 cursor-pointer hover:bg-gray-200 transition-colors"
                      onClick={() => onResultClick?.(webhookData)}
                    >
                      <pre className="whitespace-pre-wrap">
                        {JSON.stringify(webhookData, null, 2)}
                      </pre>
                    </div>
                  </div>
                </div>
              )
            }

            // No output available
            return (
              <div className="text-center py-6">
                <div className="text-gray-400 mb-2">
                  <FileText className="w-8 h-8 mx-auto" />
                </div>
                <p className="text-sm text-gray-500">
                  No output data available
                </p>
              </div>
            )
          })()}
        </div>
      </div>
    </div>
  )
}


const nodeTypes = {
  stepNode: StepNode,
}

interface WorkflowBuilderProps {
  flow?: Flow | TemplateFlow
  activeStepId?: string
  onStepClick?: (step: Step) => void
  user?: UserDetail
  onBackToWorkflows?: () => void
  selectedTemplate?: ExecutionWorkflowData | null
  isLoadingTemplate?: boolean
}

// Internal component that uses ReactFlow hooks
const WorkflowBuilderInternal: React.FC<WorkflowBuilderProps> = ({
  onStepClick,
  onBackToWorkflows,
  selectedTemplate,
  isLoadingTemplate,
}) => {
  const [, setZoomLevel] = useState(100)
  const [showResultModal, setShowResultModal] = useState(false)
  const [selectedResult, setSelectedResult] = useState<any>(null)
  const [showExecutionSidebar, setShowExecutionSidebar] = useState(false)
  const [selectedExecutionNode, setSelectedExecutionNode] = useState<any>(null)
  // Cleanup polling on component unmount
  const [pollingInterval] = useState<NodeJS.Timeout | null>(null)

  // Empty initial state
  const initialNodes: Node[] = []
  const initialEdges: Edge[] = []

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)
  const { fitView, getViewport } = useReactFlow()

  // Create nodes and edges from selectedTemplate
  useEffect(() => {
    if (
      selectedTemplate &&
      (selectedTemplate.steps || selectedTemplate.stepExecutions)
    ) {

          // Check if this is an execution (has stepExecutions) or template (has steps)
      const isExecution = !!selectedTemplate.stepExecutions
      const stepsData = isExecution
        ? selectedTemplate.stepExecutions
        : selectedTemplate.steps


      // Sort steps for top-to-bottom execution flow starting with root step
      const sortedSteps = (() => {
        if (!stepsData || stepsData.length === 0) return []
        
        // For executions, find the root step using rootWorkflowStepExeId
        if (isExecution && (selectedTemplate as any).rootWorkflowStepExeId) {
          const rootStepExeId = (selectedTemplate as any).rootWorkflowStepExeId
          const rootStep = stepsData.find((step: any) => step.id === rootStepExeId)
          
          if (rootStep) {
            
            // Build execution order starting from root step
            const orderedSteps: any[] = []
            const visited = new Set<string>()
            
            const addStepAndFollowing = (currentStep: any) => {
              if (visited.has(currentStep.id)) return
              
              visited.add(currentStep.id)
              orderedSteps.push(currentStep)
              
              // Add next steps in order
              if (currentStep.nextStepIds && currentStep.nextStepIds.length > 0) {
                currentStep.nextStepIds.forEach((nextStepId: string) => {
                  const nextStep = stepsData.find((s: any) => s.workflowStepTemplateId === nextStepId || s.id === nextStepId)
                  if (nextStep && !visited.has(nextStep.id)) {
                    addStepAndFollowing(nextStep)
                  }
                })
              }
            }
            
            addStepAndFollowing(rootStep)
            
            // Add any remaining steps that weren't connected
            stepsData.forEach((step: any) => {
              if (!visited.has(step.id)) {
                orderedSteps.push(step)
              }
            })
            
            return orderedSteps
          }
        }
        
        // Fallback sorting for templates or when root step not found
        return [...stepsData].sort((a, b) => {
          // First try to sort by step_order in metadata
          const orderA = a.metadata?.step_order ?? 999
          const orderB = b.metadata?.step_order ?? 999
          if (orderA !== orderB) {
            return orderA - orderB
          }
          // Fallback to sorting by nextStepIds relationships
          // If step A's nextStepIds contains step B's id, A should come first
          if (a.nextStepIds?.includes(b.id)) return -1
          if (b.nextStepIds?.includes(a.id)) return 1
          // Final fallback to creation time
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        })
      })()


      // Create nodes from steps in top-down layout
      const templateNodes: Node[] = sortedSteps.map((step, index) => {
        // Find associated tools for this step
        let stepTools: any[] = []
        let toolExecutions: any[] = []

        if (isExecution) {
          // For executions, get tool executions from toolExecIds
          const executionStep = step as any
          toolExecutions =
            selectedTemplate.toolExecutions?.filter((toolExec: any) =>
              executionStep.toolExecIds?.includes(toolExec.id),
            ) || []



          // Create tool info from executions
          stepTools = toolExecutions.map((toolExec: any) => ({
            id: toolExec.id,
            type: toolExec.toolType || toolExec.type || "execution_tool", // Use new toolType field first
            config: toolExec.result || {},
            toolExecutionId: toolExec.id,
            status: toolExec.status,
            result: toolExec.result,
          }))

        } else {
          // For templates, use workflow_tools
          const templateStep = step as any
          stepTools =
            selectedTemplate.workflow_tools?.filter((tool) =>
              templateStep.toolIds?.includes(tool.id),
            ) || []
        }

        // Execution workflows don't show plus buttons
        const hasNextFlag = false

        return {
          id: step.id,
          type: "stepNode",
          position: {
            x: 400, // Keep all nodes at the same horizontal position
            y: 100 + index * 200, // Stack vertically with 200px spacing (reduced for new node height)
          },
          data: {
            step: {
              id: step.id,
              name: step.name,
              status: isExecution ? (step as any).status : "pending",
              description:
                step.description || step.metadata?.automated_description,
              type: step.type,
              contents: [],
              metadata: step.metadata,
              isExecution,
              toolExecutions: isExecution ? toolExecutions : undefined,
              // Properly extract prevStepIds and nextStepIds for executions
              prevStepIds: step.prevStepIds || [],
              nextStepIds: step.nextStepIds || [],
              workflowStepTemplateId: isExecution
                ? (step as any).workflowStepTemplateId
                : step.id,
            },
            tools: stepTools,
            isActive: isExecution && (step as any).status === "running",
            isCompleted: isExecution && (step as any).status === "completed",
            hasNext: hasNextFlag, // Show plus button on last step
          },
          draggable: true,
        }
      })

      // Create edges from nextStepIds
      const templateEdges: Edge[] = []
      if (stepsData && Array.isArray(stepsData)) {
        stepsData.forEach((step: any) => {
          step.nextStepIds?.forEach((nextStepId: any) => {
            // For executions, we need to map template step IDs to execution step IDs
            let targetStepId = nextStepId

            if (isExecution) {
              // Find the step execution that corresponds to this template step ID
              const targetStepExecution = stepsData.find(
                (s: any) => s.workflowStepTemplateId === nextStepId,
              )
              if (targetStepExecution) {
                targetStepId = targetStepExecution.id
              }
            }

            templateEdges.push({
              id: `${step.id}-${targetStepId}`,
              source: step.id,
              target: targetStepId,
              type: "smoothstep",
              animated: false,
              style: {
                stroke: "#D1D5DB",
                strokeWidth: 2,
                strokeLinecap: "round",
                strokeLinejoin: "round",
              },
              pathOptions: {
                borderRadius: 20,
                offset: 20,
              },
              markerEnd: {
                type: "arrowclosed",
                color: "#D1D5DB",
              },
            } as any)
          })
        })
      }


      setNodes(templateNodes)
      setEdges(templateEdges)

      setTimeout(() => {
        fitView({ padding: 0.2 })
      }, 50)
    }
  }, [selectedTemplate, setNodes, setEdges, fitView])


  const onConnect = useCallback(
    (params: Connection) => {
      const newEdge = {
        ...params,
        id: `${params.source}-${params.target}`,
        type: "smoothstep",
        animated: false,
        style: {
          stroke: "#6B7280",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        },
        pathOptions: {
          borderRadius: 20,
          offset: 20,
        },
        markerEnd: {
          type: "arrowclosed",
          color: "#6B7280",
        },
      }
      setEdges((eds) => addEdge(newEdge, eds))
    },
    [setEdges],
  )

  // const onSelectionChange = useCallback((params: OnSelectionChangeParams) => {
  //   setSelectedNodes(params.nodes)
  // }, [])

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      // Node click handler for execution workflows
      const step = node.data?.step as Step
      const tools = (node.data?.tools as Tool[]) || []

      if (!step) return

      // Check if this is an execution workflow node
      const isExecution = (step as any).isExecution


      // Close execution sidebar first
      setShowExecutionSidebar(false)

      // Show execution sidebar for execution workflows
      if (isExecution) {
        setSelectedExecutionNode({ step, tools, node })
        setShowExecutionSidebar(true)
        return
      }

      // For non-execution nodes, call the step click handler if provided
      if (onStepClick) {
        onStepClick(step)
      }
    },
    [onStepClick],
  )

  const onNodesDelete = useCallback<OnNodesDelete>(
    (_deleted) => {
      // Handle node deletion if needed
    },
    [],
  )

  const onEdgesDelete = useCallback<OnEdgesDelete>((_deleted) => {
    // Handle edge deletion if needed in the future
  }, [])






  // Sync zoom level with touchpad zoom gestures
  useEffect(() => {
    const handleViewportChange = () => {
      const viewport = getViewport()
      const newZoomLevel = Math.round(viewport.zoom * 100)
      setZoomLevel(newZoomLevel)
    }

    // Listen for viewport changes (including touchpad zoom)
    const reactFlowWrapper = document.querySelector(".react-flow__viewport")
    if (reactFlowWrapper) {
      const observer = new MutationObserver(handleViewportChange)
      observer.observe(reactFlowWrapper, {
        attributes: true,
        attributeFilter: ["style"],
      })

      // Also listen for wheel events to capture immediate zoom changes
      const handleWheel = (e: Event) => {
        const wheelEvent = e as WheelEvent
        if (wheelEvent.ctrlKey || wheelEvent.metaKey) {
          // Delay the viewport check to ensure it's updated
          setTimeout(handleViewportChange, 10)
        }
      }

      reactFlowWrapper.addEventListener("wheel", handleWheel, { passive: true })

      return () => {
        observer.disconnect()
        reactFlowWrapper.removeEventListener("wheel", handleWheel)
      }
    }
  }, [getViewport])


  // Function to fetch workflow status



  // Cleanup polling on component unmount
  useEffect(() => {
    return () => {
      if (pollingInterval) {
        clearInterval(pollingInterval)
      }
    }
  }, [pollingInterval])










  const handleResultClick = useCallback((result: any) => {
    setSelectedResult(result)
    setShowResultModal(true)
  }, [])

  const handleResultModalClose = useCallback(() => {
    setShowResultModal(false)
    setSelectedResult(null)
  }, [])

  return (
    <div className="w-full h-full flex flex-col bg-white dark:bg-gray-900 relative">
      {/* Header */}
      <Header
        onBackToWorkflows={onBackToWorkflows}
        workflowName={selectedTemplate?.name}
      />

      {/* Main content area */}
      <div className="flex flex-1 relative overflow-hidden">
        {/* Flow diagram area */}
        <div className="flex-1 bg-slate-50 dark:bg-gray-800 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDelete}
            nodeTypes={nodeTypes}
            connectionLineType={ConnectionLineType.SmoothStep}
            fitView
            className="bg-gray-100 dark:bg-slate-900"
            multiSelectionKeyCode="Shift"
            deleteKeyCode="Delete"
            snapToGrid={true}
            snapGrid={[15, 15]}
            defaultEdgeOptions={{
              type: 'smoothstep',
              style: { 
                strokeWidth: 2,
                stroke: '#D1D5DB',
                strokeLinecap: 'round',
                strokeLinejoin: 'round'
              },
              markerEnd: { 
                type: 'arrowclosed',
                color: '#D1D5DB'
              },
            }}
            connectionLineStyle={{
              strokeWidth: 2,
              stroke: '#D1D5DB',
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }}
            proOptions={{ hideAttribution: true }}
          >

            {/* Loading Template Content */}
            {isLoadingTemplate && (
              <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-[5] text-center">
                <div className="bg-white p-6 rounded-lg shadow-md border border-slate-200">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
                  <p className="text-slate-600">Loading workflow template...</p>
                </div>
              </div>
            )}
            <Background
              variant={BackgroundVariant.Dots}
              gap={12}
              size={1}
              className="bg-gray-50 dark:bg-slate-900"
            />

          </ReactFlow>
        </div>


        {/* Execution Sidebar */}
        <ExecutionSidebar
          isVisible={showExecutionSidebar}
          executionNode={selectedExecutionNode}
          workflowData={selectedTemplate}
          onClose={() => setShowExecutionSidebar(false)}
          onResultClick={handleResultClick}
        />





      </div>

      {/* Execution Result Modal */}
      <ExecutionResultModal
        isVisible={showResultModal}
        result={selectedResult}
        onClose={handleResultModalClose}
      />
    </div>
  )
}

// Main component wrapped with ReactFlowProvider
const WorkflowBuilder: React.FC<WorkflowBuilderProps> = (props) => {
  return (
    <ReactFlowProvider>
      <WorkflowBuilderInternal {...props} />
    </ReactFlowProvider>
  )
}

export default WorkflowBuilder
