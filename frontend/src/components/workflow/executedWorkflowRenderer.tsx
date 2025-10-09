import React, { useCallback, useState, useEffect, useRef } from "react"
import { Bot, Mail, Settings, X, FileTextIcon , FileText, Code} from "lucide-react"
import ReviewExecutionUI from "./ReviewExecutionUI"
import TriggerExecutionUI from "./TriggerExecutionUI"
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
import { api } from "../../api"

// Import WorkflowTemplate from workflow.tsx
import type { WorkflowTemplate } from "../../routes/_authenticated/workflow"

// Extended WorkflowTemplate for execution workflows
interface ExecutionWorkflowTemplate extends WorkflowTemplate {
  rootWorkflowStepExeId?: string // For execution workflows
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
    toolConfig?: any
  }>
}

import botLogo from "@/assets/bot-logo.svg"

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

  // Special rendering for steps with review tools (same as builder mode)
  const hasReviewTool = tools && tools.length > 0 && tools.some(tool => tool.type === "review")
  
  if (hasReviewTool) {
    // Get config from review tool
    const reviewTool = tools.find(tool => tool.type === "review")
    const reviewConfig = reviewTool?.config || {}
    
    const isConfigured = reviewConfig.approved && reviewConfig.rejected
    const isAwaitingReview = step.status === "active"
    const isReviewCompleted = step.status === "completed"

    return (
      <>
        <div
          className={`relative cursor-pointer hover:shadow-lg transition-all ${
            isAwaitingReview
              ? "bg-amber-50 dark:bg-amber-900/20 border-2 border-amber-300 dark:border-amber-600"
              : isReviewCompleted
              ? "bg-green-50 dark:bg-green-900/20 border-2 border-green-300 dark:border-green-600"
              : "bg-white dark:bg-gray-800 border-2"
          } ${
            selected 
              ? "border-purple-600 shadow-xl shadow-purple-500/15" 
              : isAwaitingReview
              ? "border-amber-300 dark:border-amber-600"
              : isReviewCompleted
              ? "border-green-300 dark:border-green-600"
              : "border-gray-200 dark:border-gray-700 hover:border-gray-300"
          } rounded-xl p-4 min-w-[280px] flex flex-col`}
        >
          {/* Header */}
          <div className="flex items-center space-x-3 mb-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
              isAwaitingReview 
                ? "bg-amber-100 dark:bg-amber-800" 
                : isReviewCompleted
                ? "bg-green-100 dark:bg-green-800"
                : "bg-orange-100 dark:bg-orange-800"
            }`}>
              <svg
                className={`w-4 h-4 ${
                  isAwaitingReview 
                    ? "text-amber-600 dark:text-amber-300" 
                    : isReviewCompleted
                    ? "text-green-600 dark:text-green-300"
                    : "text-orange-600 dark:text-orange-300"
                }`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                />
              </svg>
            </div>
            <div className="flex-1 text-left">
              <h3 className={`font-semibold text-sm ${
                isAwaitingReview 
                  ? "text-amber-900 dark:text-amber-100" 
                  : "text-gray-900 dark:text-gray-100"
              }`}>
                {step.name || "Review Step"}
              </h3>
              {isAwaitingReview && (
                <div className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                  Action Required
                </div>
              )}
            </div>
          </div>

          {/* Content */}
          <div className="text-left flex-1">
            <p className={`text-sm ${
              isAwaitingReview 
                ? "text-amber-700 dark:text-amber-300" 
                : "text-gray-600 dark:text-gray-400"
            } leading-relaxed`}>
              {(() => {
                if (isAwaitingReview) {
                  return "Review is required to continue the workflow. Click to approve or reject."
                }
              
                
                if (isConfigured) {
                  return `Review step configured with approval and rejection paths.`
                }
                
                return "Review step - configured with approval and rejection paths"
              })()}
            </p>
          </div>

          {/* ReactFlow Handles for Review Node */}
          <Handle
            type="target"
            position={Position.Top}
            id="top"
            isConnectable={isConnectable}
            className="opacity-0"
          />
          {/* ReactFlow handles for approved and rejected paths */}
          <Handle
            type="source"
            position={Position.Bottom}
            id="approved"
            isConnectable={isConnectable}
            className="opacity-0"
            style={{ left: '25%', transform: 'translateX(-50%)', bottom: '-6px' }}
          />
          <Handle
            type="source"
            position={Position.Bottom}
            id="rejected"
            isConnectable={isConnectable}
            className="opacity-0"
            style={{ left: '75%', transform: 'translateX(-50%)', bottom: '-6px' }}
          />
          {/* Bottom connection points for review step */}
          {/* Approved path dot - at 25% from left */}
          <div className="absolute -bottom-1.5 left-1/4 transform -translate-x-1/2">
            <div className="w-3 h-3 bg-gray-400 dark:bg-gray-500 rounded-full border-2 border-white dark:border-gray-900 shadow-sm"></div>
          </div>
          
          {/* Rejected path dot - at 75% from left */}
          <div className="absolute -bottom-1.5 left-3/4 transform -translate-x-1/2">
            <div className="w-3 h-3 bg-gray-400 dark:bg-gray-500 rounded-full border-2 border-white dark:border-gray-900 shadow-sm"></div>
          </div>
        </div>
      </>
    )
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
    const isActive = step.status === "active"

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
            border: selected
              ? isFailed
                ? "2px solid #DC2626"
                : isCompleted
                  ? "2px solid #059669"
                  : "2px solid #111827"
              : isFailed
                ? "2px solid #F87171"
                : isCompleted
                  ? "2px solid #34D399"
                  : "2px solid #6B7280",
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
                `AI agent to analyze and summarize documents using ${aiConfig?.model || "gpt-oss-120b"}.`}
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
    const isActive = step.status === "active"
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
            border: selected
              ? isFailed
                ? "2px solid #DC2626"
                : isCompleted
                  ? "2px solid #059669"
                  : "2px solid #111827"
              : isFailed
                ? "2px solid #F87171"
                : isCompleted
                  ? "2px solid #34D399"
                  : "2px solid #6B7280",
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
    const isActive = step.status === "active"
    return (
      <>
        <div
          className="relative cursor-pointer hover:shadow-lg transition-shadow"
          style={{
            width: "320px",
            minHeight: "122px",
            borderRadius: "12px",
            border: selected
              ? isFailed
                ? "2px solid #DC2626"
                : isCompleted
                  ? "2px solid #059669"
                  : isActive
                    ? "2px solid #D97706"
                    : "2px solid #111827"
              : isFailed
                ? "2px solid #F87171"
                : isCompleted
                  ? "2px solid #34D399"
                  : isActive
                    ? "2px solid #F59E0B"
                    : "2px solid #6B7280",
            background: isFailed ? "#FEF2F2" : isCompleted ? "#F0FDF4" : isActive ? "#FFFBEB" : "#FFF",
            boxShadow: isFailed
              ? "0 0 0 2px #FECACA"
              : isCompleted
                ? "0 0 0 2px #BBF7D0"
                : isActive
                  ? "0 0 0 2px #FED7AA"
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

  // Special rendering for python_script tools
  const hasPythonScriptTool =
    tools && tools.length > 0 && tools[0].type === "python_script"
  if (step.type === "python_script" || hasPythonScriptTool) {
    // Check if any associated tool execution has failed
    const hasFailedToolExecution =
      tools && tools.some((tool) => (tool as any).status === "failed")
    const isFailed = step.status === "failed" || hasFailedToolExecution
    const isActive = step.status === "active"

    return (
      <>
        <div
          className="relative cursor-pointer hover:shadow-lg transition-shadow"
          style={{
            width: "320px",
            minHeight: "122px",
            borderRadius: "12px",
            border: selected
              ? isFailed
                ? "2px solid #DC2626"
                : isCompleted
                  ? "2px solid #059669"
                  : isActive
                    ? "2px solid #D97706"
                    : "2px solid #111827"
              : isFailed
                ? "2px solid #F87171"
                : isCompleted
                  ? "2px solid #34D399"
                  : isActive
                    ? "2px solid #F59E0B"
                    : "2px solid #6B7280",
            background: isFailed ? "#FEF2F2" : isCompleted ? "#F0FDF4" : isActive ? "#FFFBEB" : "#FFF",
            boxShadow: isFailed
              ? "0 0 0 2px #FECACA"
              : isCompleted
                ? "0 0 0 2px #BBF7D0"
                : isActive
                  ? "0 0 0 2px #FED7AA"
                  : "0 0 0 2px #E2E2E2",
          }}
        >
          {/* Header with icon and title */}
          <div className="flex items-center gap-3 text-left w-full px-4 pt-4 mb-3">
            {/* Bot icon with background */}
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
              <img src={botLogo} alt="Bot" width={16} height={16} />
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
              {step.name || "Python Script"}
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
              {step.description ||
                "Execute Python script to process data and generate results."}
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

  // Special rendering for script nodes and steps with script tools
  const hasScriptTool = tools && tools.length > 0 && tools[0].type === "script"
  if (step.type === "script" || hasScriptTool) {
    // Check if any associated tool execution has failed
    const hasFailedToolExecution =
      tools && tools.some((tool) => (tool as any).status === "failed")
    const isFailed = step.status === "failed" || hasFailedToolExecution
    const isActive = step.status === "active"

    // Extract title and description from script tool data
    const scriptTool = hasScriptTool ? tools[0] : null
    const scriptData = (scriptTool as any)?.result || (scriptTool as any)?.config || {}
    const language = scriptData?.language || (scriptTool as any)?.toolType || "script"
    const scriptTitle = `${language.charAt(0).toUpperCase() + language.slice(1)} Script`
    const scriptDescription = step.description || `Execute ${language} script with custom code`

    return (
      <>
        <div
          className="relative cursor-pointer hover:shadow-lg transition-shadow"
          style={{
            width: "320px",
            minHeight: "122px",
            borderRadius: "12px",
            border: selected
              ? isFailed
                ? "2px solid #DC2626"
                : isCompleted
                  ? "2px solid #059669"
                  : isActive
                    ? "2px solid #D97706"
                    : "2px solid #111827"
              : isFailed
                ? "2px solid #F87171"
                : isCompleted
                  ? "2px solid #34D399"
                  : isActive
                    ? "2px solid #F59E0B"
                    : "2px solid #6B7280",
            background: isFailed ? "#FEF2F2" : isCompleted ? "#F0FDF4" : isActive ? "#FFFBEB" : "#FFF",
            boxShadow: isFailed
              ? "0 0 0 2px #FECACA"
              : isCompleted
                ? "0 0 0 2px #BBF7D0"
                : isActive
                  ? "0 0 0 2px #FED7AA"
                  : "0 0 0 2px #E2E2E2",
          }}
        >
          {/* Header with icon and title */}
          <div className="flex items-center gap-3 text-left w-full px-4 pt-4 mb-3">
            {/* Green code icon with background */}
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
                background: "#F0FDF4",
              }}
            >
              <Code width={16} height={16} color="#10B981" />
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
              {step.name || scriptTitle}
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
              {scriptDescription}
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
    const isActive = step.status === "active"
    // Use template-style design for any execution node that didn't match above types
    return (
      <>
        <div
          className="relative cursor-pointer hover:shadow-lg transition-shadow"
          style={{
            width: "320px",
            minHeight: "122px",
            borderRadius: "12px",
            border: selected
              ? isFailed
                ? "2px solid #DC2626"
                : isCompleted
                  ? "2px solid #059669"
                  : isActive
                    ? "2px solid #D97706"
                    : "2px solid #111827"
              : isFailed
                ? "2px solid #F87171"
                : isCompleted
                  ? "2px solid #34D399"
                  : isActive
                    ? "2px solid #F59E0B"
                    : "2px solid #6B7280",
            background: isFailed ? "#FEF2F2" : isCompleted ? "#F0FDF4" : isActive ? "#FFFBEB" : "#FFF",
            boxShadow: isFailed
              ? "0 0 0 2px #FECACA"
              : isCompleted
                ? "0 0 0 2px #BBF7D0"
                : isActive
                  ? "0 0 0 2px #FED7AA"
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
      return `${baseClasses} border-amber-600 bg-gradient-to-br from-amber-50 to-amber-100 dark:from-amber-900/30 dark:to-amber-800/20 text-amber-900 dark:text-amber-300 shadow-lg shadow-amber-500/15`
    }

    if (selected) {
      return `${baseClasses} border-purple-800 bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/30 dark:to-purple-800/20 text-purple-900 dark:text-purple-300 shadow-xl shadow-purple-500/15`
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
                ? "bg-amber-600"
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
            <div className="w-2 h-2 rounded-full bg-amber-600 animate-pulse" />
          )}
          <div className="font-semibold text-base leading-tight">
            {step.name || "Unnamed Step"}
          </div>
          {isActive && !isCompleted && (
            <div className="text-xs bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300 px-2 py-1 rounded-full">
              Action Required
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
                ? "bg-amber-600"
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
}: { onBackToWorkflows?: () => void; workflowName?: string; }) => {
  return (
    <div className="flex flex-col items-start justify-center px-6 py-4 border-b border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-900 min-h-[80px] gap-3">
      {/* Breadcrumb */}
      <div className="flex items-center justify-between w-full">
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
        prevStep.workflow_tool_ids?.includes(toolExec.workflowToolId),
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
                            // Check if current step is a script node - if so, show whole input
                            if (step.type === "script" || (tools && tools.some((tool: any) => tool.type === "script"))) {
                              // For script nodes, always show the complete input data
                              return (
                                <pre className="whitespace-pre-wrap">
                                  {typeof output === "object"
                                    ? JSON.stringify(output, null, 2)
                                    : String(output)}
                                </pre>
                              )
                            }

                            if (typeof output === "object" && output) {
                              // Check for script tool output - show raw data
                              if (output.toolType === "script" || output.type === "script") {
                                return (
                                  <div className="space-y-2">
                                    <div>
                                      <span className="font-medium text-gray-600">Script Output:</span>
                                      <div className="mt-1 text-gray-900 whitespace-pre-wrap font-mono text-xs bg-gray-50 p-2 rounded border">
                                        {typeof output === "object"
                                          ? JSON.stringify(output, null, 2)
                                          : String(output)}
                                      </div>
                                    </div>
                                  </div>
                                )
                              }

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




            return tools && tools.length > 0 ? (
              tools.map((tool: any, index: number) => {

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
                            // Check if this is a script tool - always show "View Full"
                            if (tool.type === "script") {
                              return (
                                <button
                                  onClick={() => onResultClick?.(tool.result)}
                                  className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded transition-colors"
                                >
                                  View Full
                                </button>
                              )
                            }

                            // Check if this is a successful email tool execution
                            const isEmailTool = tool.type === "email"
                            const isSuccess =
                              step.status === "completed" &&
                              tool.status === "completed"
                            const hasEmailBody =
                              tool.result?.python_script_output?.body

                            if (isEmailTool && isSuccess && hasEmailBody) {
                              return (
                                <button
                                  onClick={() =>
                                    onResultClick?.(
                                      tool.result.python_script_output.body,
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
                            // For script tools, always show full data
                            if (tool.type === "script") {
                              onResultClick?.(tool.result)
                              return
                            }

                            // Check if this is a successful email tool execution
                            const isEmailTool = tool.type === "email"
                            const isSuccess =
                              step.status === "completed" &&
                              tool.status === "completed"

                            if (isEmailTool && isSuccess) {
                              const hasEmailBody =
                                tool.result?.python_script_output?.body
                              if (hasEmailBody) {
                                onResultClick?.(
                                  tool.result.python_script_output.body,
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
                                tool.result?.python_script_output?.error ||
                                tool.result?.stderr ||
                                tool.result?.exception ||
                                `${tool.type} execution failed`
                              return <div className="text-red-700">{error}</div>
                            }

                            // Handle successful executions for any tool type
                            if (isSuccess) {
                              // For script tools, show full data output
                              if (tool.type === "script") {
                                return (
                                  <pre className="whitespace-pre-wrap text-green-700 font-mono text-xs">
                                    {typeof tool.result === "object"
                                      ? JSON.stringify(tool.result, null, 2)
                                      : String(tool.result)}
                                  </pre>
                                )
                              }

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

                              // For all other successful tools, show generic success message
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
            ) : (
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
  selectedTemplate?: ExecutionWorkflowTemplate | null
  isLoadingTemplate?: boolean
  onTemplateUpdate?: (template: ExecutionWorkflowTemplate) => void
  shouldStartPolling?: boolean
}

// Internal component that uses ReactFlow hooks
const WorkflowBuilderInternal: React.FC<WorkflowBuilderProps> = ({
  onStepClick,
  onBackToWorkflows,
  selectedTemplate,
  isLoadingTemplate,
  onTemplateUpdate,
}) => {
  const [, setZoomLevel] = useState(100)
  const [showResultModal, setShowResultModal] = useState(false)
  const [selectedResult, setSelectedResult] = useState<any>(null)
  const [showExecutionSidebar, setShowExecutionSidebar] = useState(false)
  const [selectedExecutionNode, setSelectedExecutionNode] = useState<any>(null)
  const [showReviewExecutionUI, setShowReviewExecutionUI] = useState(false)
  const [showTriggerExecutionUI, setShowTriggerExecutionUI] = useState(false)
  const [selectedReviewStepId, setSelectedReviewStepId] = useState<string | null>(null)
  const [selectedTriggerStepId, setSelectedTriggerStepId] = useState<string | null>(null)
  const [reviewPreviousStepResult, setReviewPreviousStepResult] = useState<any>(null)
  // Simple polling timeout reference for cleanup
  const pollingTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Local workflow data state for forcing re-renders during polling
  const [workflowData, setWorkflowData] = useState<ExecutionWorkflowTemplate | null>(selectedTemplate || null)

  // Update local data when selectedTemplate changes
  useEffect(() => {
    console.log("📝 selectedTemplate changed, updating workflowData:", {
      selectedTemplateId: selectedTemplate?.id,
      selectedTemplateStatus: selectedTemplate?.status,
      stepExecutionsCount: selectedTemplate?.stepExecutions?.length
    })
    setWorkflowData(selectedTemplate || null)
  }, [selectedTemplate])

  // Empty initial state
  const initialNodes: Node[] = []
  const initialEdges: Edge[] = []

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)
  const { fitView, getViewport } = useReactFlow()

  // Create nodes and edges from selectedTemplate
  useEffect(() => {
    // Use workflowData for rendering, fallback to selectedTemplate for initial load
    const dataToRender = workflowData || selectedTemplate
    
    // Debug: Log the workflow data structure
    console.log("🔍 Workflow data structure:", {
      workflowData,
      stepExecutions: dataToRender?.stepExecutions?.slice(0, 2), // First 2 steps only
      workflow_tools: dataToRender?.workflow_tools?.slice(0, 3) // First 3 tools only
    })
    
    // Debug: Log when nodes are being recreated
    console.log("🔄 Recreating nodes with data:", {
      workflowDataExists: !!workflowData,
      selectedTemplateExists: !!selectedTemplate,
      stepExecutionsCount: dataToRender?.stepExecutions?.length,
      stepStatuses: dataToRender?.stepExecutions?.map((s: any) => ({ id: s.id, status: s.status }))
    })
    if (
      dataToRender &&
      (dataToRender.steps || dataToRender.stepExecutions)
    ) {

          // Check if this is an execution (has stepExecutions) or template (has steps)
      const isExecution = !!dataToRender.stepExecutions
      const stepsData = isExecution
        ? dataToRender.stepExecutions
        : dataToRender.steps


      // Sort steps by nextStepIds relationships and creation order (same as builder mode without step_order)
      const sortedSteps = stepsData ? [...stepsData].sort((a, b) => {
        // Sort by nextStepIds relationships
        // If step A's nextStepIds contains step B's id, A should come first
        if (a.nextStepIds?.includes(b.id)) return -1
        if (b.nextStepIds?.includes(a.id)) return 1
        // Fallback to creation time
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      }) : []

      // Simple Parent-Based DFS Algorithm (same as builder mode)
      const performSimpleDFS = (steps: any[]) => {
        // Get the root step ID from template
        const rootStepId = isExecution 
          ? (dataToRender as any).rootWorkflowStepExeId 
          : dataToRender.rootWorkflowStepTemplateId
        
        if (!rootStepId) {
          console.error('No root step ID found in template')
          return new Map()
        }
        
        const nodePositions = new Map()
        const visited = new Set()
        
        // Simple DFS with parent-based positioning
        const dfs = (nodeId: string, parentX: number, parentY: number, siblingIds: string[] = [], myIndex: number = 0) => {
          // Skip if already visited
          if (visited.has(nodeId)) return
          visited.add(nodeId)
          
          // Calculate position: center children around parent
          let x = parentX
          if (siblingIds.length > 1) {
            // Center multiple children around parent
            const totalWidth = (siblingIds.length - 1) * 500
            const startX = parentX - (totalWidth / 2)
            x = startX + (myIndex * 500)
          }
          const y = parentY + 250
          
          // Store position
          nodePositions.set(nodeId, { x, y })
          
          // Find the current node
          const currentNode = steps.find(s => s.id === nodeId || (isExecution && s.workflowStepTemplateId === nodeId))
          if (!currentNode) {
            return
          }
          
          // Get nextStepIds for this node
          const nextStepIds = currentNode.nextStepIds || []
          
          // Recurse for each child
          if (nextStepIds.length > 0) {
            nextStepIds.forEach((childId: string, index: number) => {
              dfs(childId, x, y, nextStepIds, index)
            })
          }
        }
        
        // Start with root at (400, 100)
        nodePositions.set(rootStepId, { x: 400, y: 100 })
        
        // Start DFS for root's children
        const rootNode = steps.find(s => s.id === rootStepId || (isExecution && s.workflowStepTemplateId === rootStepId))
        if (rootNode?.nextStepIds) {
          rootNode.nextStepIds.forEach((childId: string, index: number) => {
            dfs(childId, 400, 100, rootNode.nextStepIds, index)
          })
        }
        
        return nodePositions
      }
      
      const nodePositions = performSimpleDFS(sortedSteps)

      // Calculate positions using simple parent-based algorithm
      const calculatePosition = (step: any) => {
        const position = nodePositions.get(step.id) || nodePositions.get(step.workflowStepTemplateId)
        if (position) {
          return position
        }
        
        // Fallback for nodes not found in DFS
        return { x: 400, y: 100 }
      }

      // Create nodes from steps with DFS-based layout
      const templateNodes: Node[] = sortedSteps.map((step, index) => {
        // Find associated tools for this step
        let stepTools: any[] = []
        let toolExecutions: any[] = []

        if (isExecution) {
          // For executions, use workflow_tool_ids to get tools from workflow_tools
          const executionStep = step as any
          
          // Get tools using workflow_tool_ids from workflow_tools
          stepTools = dataToRender.workflow_tools?.filter((tool: any) =>
            executionStep.workflow_tool_ids?.includes(tool.id)
          ) || []

          // Also get tool executions for status/results (if available)
          toolExecutions =
            dataToRender.toolExecutions?.filter((toolExec: any) =>
              executionStep.toolExecIds?.includes(toolExec.id),
            ) || []

        } else {
          // For templates, use workflow_tools
          const templateStep = step as any
          stepTools =
            dataToRender.workflow_tools?.filter((tool) =>
              templateStep.toolIds?.includes(tool.id),
            ) || []
        }

        // Execution workflows don't show plus buttons
        const hasNextFlag = false

        const nodeData = {
          id: step.id,
          type: "stepNode",
          position: calculatePosition(step),
          key: `${step.id}-${isExecution ? (step as any).status : "pending"}`, // Force re-render when status changes
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
        
        // Debug: Log node data creation for first few steps
        if (index < 3) {
          console.log(`🔧 Creating node ${index + 1}:`, {
            stepId: step.id,
            stepName: step.name,
            stepStatus: isExecution ? (step as any).status : "pending",
            isActive: isExecution && (step as any).status === "running",
            isCompleted: isExecution && (step as any).status === "completed"
          })
        }
        
        return nodeData
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

            // Check if source is a review step with approved/rejected paths (same as builder mode)
            let sourceHandle = "bottom"
            let edgeLabel = ""
            let labelStyle = {}
            let labelBgStyle = {}
            
            // Get tools for this step - check if this step has review tools
            const hasReviewTools = isExecution 
              ? dataToRender.workflow_tools?.some(tool =>
                  step.workflow_tool_ids?.includes(tool.id) && tool.type === "review"
                )
              : dataToRender.workflow_tools?.some(tool =>
                  step.toolIds?.includes(tool.id) && tool.type === "review"
                )
                
            if (hasReviewTools) {
              // Get the review tool config
              let config = {}
              
              if (isExecution) {
                const workflowTool = dataToRender.workflow_tools?.find(tool =>
                  step.workflow_tool_ids?.includes(tool.id) && tool.type === "review"
                )
                config = workflowTool?.config || {}
              } else {
                const workflowTool = dataToRender.workflow_tools?.find(tool =>
                  step.toolIds?.includes(tool.id) && tool.type === "review"
                )
                config = workflowTool?.config || {}
              }
              
              if (Object.keys(config).length > 0) {
                console.log("Review tool config:", config, "targetStepId:", targetStepId)
                
                // Check if this target matches approved or rejected path
                const typedConfig = config as { approved?: string; rejected?: string }
                
                // For execution mode, we need to map template step IDs to execution step IDs
                let approvedStepId = typedConfig.approved
                let rejectedStepId = typedConfig.rejected
                
                if (isExecution) {
                  // Find execution step ID for approved template step ID
                  if (approvedStepId) {
                    const approvedExecution = stepsData.find(
                      (s: any) => s.workflowStepTemplateId === approvedStepId
                    )
                    if (approvedExecution) {
                      approvedStepId = approvedExecution.id
                    }
                  }
                  
                  // Find execution step ID for rejected template step ID  
                  if (rejectedStepId) {
                    const rejectedExecution = stepsData.find(
                      (s: any) => s.workflowStepTemplateId === rejectedStepId
                    )
                    if (rejectedExecution) {
                      rejectedStepId = rejectedExecution.id
                    }
                  }
                }
                
                if (approvedStepId === targetStepId) {
                  sourceHandle = "approved"
                  edgeLabel = "Approved"
                } else if (rejectedStepId === targetStepId) {
                  sourceHandle = "rejected"
                  edgeLabel = "Rejected"
                }
              }
            }
            
            if (edgeLabel !== "") {
              labelStyle = { 
                fill: '#6B7280', 
                fontWeight: 600, 
                fontSize: '12px',
                fontFamily: 'Inter'
              }
              labelBgStyle = { 
                fill: '#F9FAFB', 
                stroke: '#E5E7EB',
                strokeWidth: 1,
                rx: 4
              }
            }

            templateEdges.push({
              id: `${step.id}-${targetStepId}`,
              source: step.id,
              target: targetStepId,
              sourceHandle: sourceHandle,
              targetHandle: "top",
              type: "smoothstep",
              animated: false,
              label: edgeLabel !== "" ? edgeLabel : null,
              labelStyle: edgeLabel !== "" ? labelStyle : null,
              labelBgStyle: edgeLabel !== "" ? labelBgStyle : null,
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


      console.log("🚀 Setting nodes and edges at:", new Date().toISOString(), {
        nodeCount: templateNodes.length,
        edgeCount: templateEdges.length
      })
      setNodes(templateNodes)
      setEdges(templateEdges)

      setTimeout(() => {
        fitView({ padding: 0.2 })
      }, 50)
    }
  }, [selectedTemplate, workflowData, setNodes, setEdges, fitView])


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

      if (!step) return

      // Check if this is an execution workflow node
      const isExecution = (step as any).isExecution

      // Close all sidebars first
      setShowExecutionSidebar(false)
      setShowReviewExecutionUI(false)
      setShowTriggerExecutionUI(false)
      setSelectedReviewStepId(null)
      setSelectedTriggerStepId(null)

      // Handle execution workflows
      if (isExecution) {
        // Get tools for this step to determine sidebar based on toolType
        const stepData = step as any
        const workflowDataForTools = workflowData || selectedTemplate
        
        // Find the actual step execution data to get workflow_tool_ids
        const stepExecution = workflowDataForTools?.stepExecutions?.find((se: any) => se.id === step.id) as any
        const workflowToolIds = stepExecution?.workflow_tool_ids || []
        
        const stepTools = workflowDataForTools?.workflow_tools?.filter((tool: any) =>
          workflowToolIds.includes(tool.id)
        ) || []

        // Check for trigger tool first
        console.log("🔍 Checking for trigger tools:", { 
          stepId: step.id, 
          stepTools: stepTools, 
          stepExecution: stepExecution,
          workflowToolIds: workflowToolIds,
          foundTools: stepTools.map((t: any) => ({ id: t.id, type: t.type }))
        })
        
        const hasTriggerTool = stepTools.some((tool: any) => tool.type === "trigger")
        console.log("🔍 Has trigger tool?", hasTriggerTool)
        
        if (hasTriggerTool) {
          console.log("🔍 Trigger tool node clicked:", { stepId: step.id, tools: stepTools })
          setSelectedTriggerStepId(step.id)
          setShowTriggerExecutionUI(true)
          return
        }

        // Check for review tool
        const hasReviewTool = stepTools.some((tool: any) => tool.type === "review")
        console.log("🔍 Has review tool?", hasReviewTool, { stepTools: stepTools.map(t => ({ id: t.id, type: t.type })) })
        
        if (hasReviewTool) {
          console.log("🔍 Review tool node clicked:", { stepId: step.id, tools: stepTools })
          
          // Extract previous step result for review content
          let previousStepResult = null
          const stepExecution = step as any // Cast to access execution properties
          if (selectedTemplate?.stepExecutions && stepExecution.prevStepIds && stepExecution.prevStepIds.length > 0) {
            const prevStepId = stepExecution.prevStepIds[0] // Get the first previous step
            const prevStep = (workflowData || selectedTemplate)?.stepExecutions?.find((s: any) => s.workflowStepTemplateId === prevStepId)
            
            if (prevStep && (workflowData || selectedTemplate)?.toolExecutions) {
              // Find tool executions for the previous step
              const prevStepToolExecs = (workflowData || selectedTemplate)?.toolExecutions?.filter(
                (tool: any) => prevStep.toolExecIds.includes(tool.id)
              )
              
              if (prevStepToolExecs && prevStepToolExecs.length > 0) {
                // Get the result from the most recent completed tool execution
                const completedTools = prevStepToolExecs.filter((tool: any) => tool.result)
                if (completedTools.length > 0) {
                  previousStepResult = completedTools[completedTools.length - 1].result
                }
              }
              
              // Fallback: check if the previous step has form submission data
              if (!previousStepResult && prevStep.metadata?.formSubmission) {
                previousStepResult = {
                  formData: prevStep.metadata.formSubmission
                }
              }
            }
          }
          
          console.log("🔍 Previous step result for review:", previousStepResult)
          setReviewPreviousStepResult(previousStepResult)
          setSelectedReviewStepId(step.id)
          setShowReviewExecutionUI(true)
          return
        }

        // Default execution sidebar for other steps
        // Get the actual tool executions for this step
        const workflowDataForExecution = workflowData || selectedTemplate
        const toolExecutions = workflowDataForExecution?.toolExecutions?.filter((toolExec: any) =>
          stepData.workflow_tool_ids?.includes(toolExec.workflowToolId)
        ) || []
        
        setSelectedExecutionNode({ step, tools: toolExecutions, node })
        setShowExecutionSidebar(true)
        return
      }

      // For non-execution nodes, call the step click handler if provided
      if (onStepClick) {
        onStepClick(step)
      }
    },
    [onStepClick, workflowData, selectedTemplate, setShowExecutionSidebar, setShowReviewExecutionUI, setShowTriggerExecutionUI, setSelectedReviewStepId, setSelectedTriggerStepId, setReviewPreviousStepResult, setSelectedExecutionNode],
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


  // Function to fetch enhanced workflow status
  const fetchWorkflowStatus = (async (executionId: string) => {
    try {
      console.log("📊 Fetching execution data for:", executionId)
      
      // Fetch fresh execution data
      const response = await api.workflow.executions[executionId].$get()
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      
      const executionData = await response.json()
      console.log("📊 Raw execution data:", executionData)
      
      // Extract the actual data - could be nested
      let extractedData = executionData
      if (executionData.success && executionData.data) {
        extractedData = executionData.data
      } else if (executionData.data) {
        extractedData = executionData.data
      }
      
      console.log("📊 Extracted execution data:", extractedData)
      
      // Update UI with fresh execution data
      if (extractedData && onTemplateUpdate) {
        onTemplateUpdate(extractedData)
      }
      
      // Update local workflow data to trigger re-renders
      console.log("🔄 Updating workflowData with new polling data:", {
        stepExecutionsCount: extractedData?.stepExecutions?.length,
        newStepStatuses: extractedData?.stepExecutions?.map((s: any) => ({ id: s.id, status: s.status }))
      })
      setWorkflowData(extractedData)
      
      // Check if workflow is completed or failed at workflow level
      if (extractedData.status === 'completed' || extractedData.status === 'failed') {
        console.log("✅ Workflow finished, stopping polling")
        return extractedData
      }
      
      // Check if all steps are completed or any step has failed
      if (extractedData.stepExecutions) {
        const allStepsCompleted = extractedData.stepExecutions.every((step: any) => step.status === 'completed')
        const anyStepFailed = extractedData.stepExecutions.some((step: any) => step.status === 'failed')
        
        if (allStepsCompleted) {
          console.log("✅ All steps completed, stopping polling")
          return extractedData
        }
        
        if (anyStepFailed) {
          console.log("❌ One or more steps failed, stopping polling")
          return extractedData
        }
        
        // Find steps requiring user action (manual steps or active steps waiting for user interaction)
        const manualStep = extractedData.stepExecutions.find((step: any) => 
          step.type?.toLowerCase() === 'manual' && step.status !== 'completed'
        )
        
        // Find steps that are active and waiting for user action (review, trigger, etc.)
        const activeUserStep = extractedData.stepExecutions.find((step: any) => 
          step.status === 'active'
        )
        
        if (manualStep) {
          console.log("🔍 Manual step found:", {
            stepId: manualStep.id,
            stepName: manualStep.name,
            stepType: manualStep.type,
            stepStatus: manualStep.status
          })
          
          // Show appropriate UI for manual steps
          console.log("🔧 Opening manual step UI")
          setSelectedTriggerStepId(manualStep.id)
          setShowTriggerExecutionUI(true)
          
          // Continue polling at longer intervals for manual steps
          console.log("⏰ Continuing polling at 10 second intervals for manual step")
          pollingTimeoutRef.current = setTimeout(() => {
            fetchWorkflowStatus(executionId)
          }, 10000)
          
          return extractedData
        }
        
        if (activeUserStep) {
          console.log("🔍 Active user step found:", {
            stepId: activeUserStep.id,
            stepName: activeUserStep.name,
            stepType: activeUserStep.type,
            stepStatus: activeUserStep.status
          })
          
          // Continue polling at longer intervals for active steps requiring user action
          console.log("⏰ Continuing polling at 10 second intervals for active user step")
          pollingTimeoutRef.current = setTimeout(() => {
            fetchWorkflowStatus(executionId)
          }, 10000)
          
          return extractedData
        }
        
        // If no manual steps, find other active steps (running/pending)
        const activeStep = extractedData.stepExecutions.find((step: any) => 
          step.status === 'running' || step.status === 'pending'
        )
        
        if (activeStep) {
          console.log("🔍 Active automated step found:", {
            stepId: activeStep.id,
            stepName: activeStep.name,
            stepType: activeStep.type,
            stepStatus: activeStep.status
          })
        }
      }
      
      // Continue polling after 5 seconds for automated steps
      console.log("⏰ Scheduling next poll in 5 seconds")
      pollingTimeoutRef.current = setTimeout(() => {
        fetchWorkflowStatus(executionId)
      }, 5000)
      
      return extractedData
    } catch (error) {
      console.error('❌ Failed to fetch execution data:', error)
      // Continue polling on error after 5 seconds
      console.log("⏰ Scheduling retry in 5 seconds after error")
      pollingTimeoutRef.current = setTimeout(() => {
        fetchWorkflowStatus(executionId)
      }, 5000)
      return null
    }
  })







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
        onBackToWorkflows={() => {
          onBackToWorkflows?.()
        }}
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
          workflowData={workflowData || selectedTemplate}
          onClose={() => setShowExecutionSidebar(false)}
          onResultClick={handleResultClick}
        />

        {/* Review Execution Sidebar */}
        <ReviewExecutionUI
          isVisible={showReviewExecutionUI}
          onBack={() => setShowReviewExecutionUI(false)}
          onClose={() => {
            setShowReviewExecutionUI(false)
            setSelectedReviewStepId(null)
            setReviewPreviousStepResult(null)
          }}
          stepExecutionId={selectedReviewStepId || ""}
          stepName="Review Step"
          builder={false} // Always execution mode in this component
          previousStepResult={reviewPreviousStepResult}
          workflowExecutionId={selectedTemplate?.id}
          isStepActive={(() => {
            if (!selectedReviewStepId || !workflowData?.stepExecutions) return false
            const step = workflowData.stepExecutions.find((s: any) => s.id === selectedReviewStepId)
            return step?.status === "active"
          })()}
          onReviewSubmitted={() => {
            console.log("Review submitted, workflow will continue")
            // Resume polling - it will handle execution data refresh
            if (selectedTemplate?.id) {
              fetchWorkflowStatus(selectedTemplate.id)
            }
          }}
        />

        {/* Trigger Execution Sidebar */}
        <TriggerExecutionUI
          isVisible={showTriggerExecutionUI}
          onBack={() => setShowTriggerExecutionUI(false)}
          onClose={() => {
            setShowTriggerExecutionUI(false)
            setSelectedTriggerStepId(null)
          }}
          stepExecutionId={selectedTriggerStepId || ""}
          stepName={selectedExecutionNode?.step?.name || "Manual Trigger Step"}
          builder={false} // Always execution mode in this component
          isStepActive={(() => {
            if (!selectedTriggerStepId || !workflowData?.stepExecutions) return false
            const step = workflowData.stepExecutions.find((s: any) => s.id === selectedTriggerStepId)
            return step?.status === "active"
          })()}
          onTriggerSubmitted={() => {
            console.log("Trigger submitted, workflow will continue")
            // Resume polling - it will handle execution data refresh
            if (selectedTemplate?.id) {
              fetchWorkflowStatus(selectedTemplate.id)
            }
          }}
          path={"execution"}
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
