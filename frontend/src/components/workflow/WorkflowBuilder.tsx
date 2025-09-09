import React, { useCallback, useState, useEffect } from "react"
import { Bot, Mail } from "lucide-react"
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
  Panel,
  OnSelectionChangeParams,
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
  StepExecution,
} from "./Types"

// Import WorkflowTemplate type
interface WorkflowTemplate {
  id: string
  name: string
  description: string
  version: string
  status: string
  config: {
    ai_model?: string
    max_file_size?: string
    auto_execution?: boolean
    schema_version?: string
    allowed_file_types?: string[]
    supports_file_upload?: boolean
  }
  createdBy: string
  rootWorkflowStepTemplateId: string
  createdAt: string
  updatedAt: string
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
    createdBy: string
    createdAt: string
    updatedAt: string
  }>
  rootStep?: {
    id: string
    workflowTemplateId: string
    name: string
    description: string
    type: string
    timeEstimate: number
    metadata: {
      icon?: string
      step_order?: number
      schema_version?: string
      user_instructions?: string
    }
    tool?: {
      id: string
      type: string
      value: any
      config: any
      createdBy: string
      createdAt: string
      updatedAt: string
    }
  }
}
import ActionBar from "./ActionBar"
import {
  EditorIcon,
  SettingsIcon,
  ManualTriggerIcon,
  AppEventIcon,
  ScheduleIcon,
  FormSubmissionIcon,
  WorkflowExecutionIcon,
  ChatMessageIcon,
  HelpIcon,
  TemplatesIcon,
  AddIcon,
  FormDocumentIcon,
} from "./WorkflowIcons"
import botLogo from "@/assets/bot-logo.svg"
import androidIcon from "@/assets/android.svg"
import documentIcon from "@/assets/document.svg"
import {
  workflowTemplatesAPI,
  workflowsAPI,
  workflowStepsAPI,
  workflowToolsAPI,
  workflowExecutionsAPI,
} from "./api/ApiHandlers"
import WhatHappensNextUI from "./WhatHappensNextUI"
import AIAgentConfigUI, { AIAgentConfig } from "./AIAgentConfigUI"
import EmailConfigUI, { EmailConfig } from "./EmailConfigUI"
import OnFormSubmissionUI, { FormConfig } from "./OnFormSubmissionUI"
import { WorkflowExecutionModal } from "./WorkflowExecutionModal"

// Custom Node Component
const StepNode: React.FC<NodeProps> = ({
  data,
  isConnectable,
  selected,
  id,
}) => {
  const { step, isActive, isCompleted, tools, hasNext } = data as {
    step: Step
    isActive?: boolean
    isCompleted?: boolean
    tools?: Tool[]
    hasNext?: boolean
  }

  // Special rendering for AI Agent nodes and steps with ai_agent tools
  const hasAIAgentTool =
    tools && tools.length > 0 && tools[0].type === "ai_agent"
  if (step.type === "ai_agent" || hasAIAgentTool) {
    // Get config from step or tool
    const aiConfig =
      (step as any).config || (hasAIAgentTool && tools?.[0]?.value) || {}
    const isConfigured = aiConfig?.name && aiConfig?.name.trim() !== ""

    if (!isConfigured) {
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

            {/* Add Next Step Button for unconfigured AI Agent */}
            {hasNext && (
              <div
                className="absolute left-1/2 transform -translate-x-1/2 flex flex-col items-center cursor-pointer z-50 pointer-events-auto"
                style={{ top: "calc(100% + 8px)" }}
                onClick={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                  console.log(
                    "Plus button clicked for unconfigured AI agent:",
                    id,
                  )
                  const event = new CustomEvent("openWhatHappensNext", {
                    detail: { nodeId: id },
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
            border: "2px solid #181B1D",
            background: "#FFF",
            boxShadow: "0 0 0 2px #E2E2E2",
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

          {/* Add Next Step Button */}
          {hasNext && (
            <div
              className="absolute left-1/2 transform -translate-x-1/2 flex flex-col items-center cursor-pointer z-50 pointer-events-auto"
              style={{ top: "calc(100% + 8px)" }}
              onClick={(e) => {
                e.stopPropagation()
                e.preventDefault()
                console.log("Plus button clicked for node:", id)
                const event = new CustomEvent("openWhatHappensNext", {
                  detail: { nodeId: id },
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
        </div>
      </>
    )
  }

  // Special rendering for Email nodes and steps with email tools
  const hasEmailTool = tools && tools.length > 0 && tools[0].type === "email"
  if (step.type === "email" || hasEmailTool) {
    // Get config from step or tool
    const emailConfig =
      (step as any).config || (hasEmailTool && tools?.[0]?.value) || {}
    const emailAddresses =
      emailConfig?.emailAddresses ||
      emailConfig?.to_email ||
      (hasEmailTool && tools?.[0]?.config?.to_email) ||
      []
    // Consider configured if has email addresses OR if step has name/description
    const isConfigured =
      (Array.isArray(emailAddresses) && emailAddresses.length > 0) ||
      step.name ||
      step.description

    if (!isConfigured) {
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

            {/* Add Next Step Button for unconfigured Email */}
            {hasNext && (
              <div
                className="absolute left-1/2 transform -translate-x-1/2 flex flex-col items-center cursor-pointer z-50 pointer-events-auto"
                style={{ top: "calc(100% + 8px)" }}
                onClick={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                  console.log("Plus button clicked for unconfigured email:", id)
                  const event = new CustomEvent("openWhatHappensNext", {
                    detail: { nodeId: id },
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
            border: "2px solid #181B1D",
            background: "#FFF",
            boxShadow: "0 0 0 2px #E2E2E2",
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

          {/* Add Next Step Button */}
          {hasNext && (
            <div
              className="absolute left-1/2 transform -translate-x-1/2 flex flex-col items-center cursor-pointer z-50 pointer-events-auto"
              style={{ top: "calc(100% + 8px)" }}
              onClick={(e) => {
                e.stopPropagation()
                e.preventDefault()
                console.log("Plus button clicked for node:", id)
                const event = new CustomEvent("openWhatHappensNext", {
                  detail: { nodeId: id },
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
        </div>
      </>
    )
  }

  // Special rendering for form submission nodes and steps with form tools
  const hasFormTool = tools && tools.length > 0 && tools[0].type === "form"
  if (step.type === "form_submission" || hasFormTool) {
    return (
      <>
        <div
          className="relative cursor-pointer hover:shadow-lg transition-shadow"
          style={{
            width: "320px",
            minHeight: "122px",
            borderRadius: "12px",
            border: "2px solid #181B1D",
            background: "#FFF",
            boxShadow: "0 0 0 2px #E2E2E2",
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
              <FormDocumentIcon width={16} height={16} />
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
                (hasFormTool && tools?.[0]?.value?.title) ||
                "Form Submission"}
            </h3>
          </div>

          {/* Full-width horizontal divider */}
          <div className="w-full h-px bg-gray-200 mb-3"></div>

          {/* Description text */}
          <div className="px-4 pb-4">
            <p className="text-gray-600 text-sm leading-relaxed text-left break-words overflow-hidden">
              {(() => {
                // If step has description, use it first
                if (step.description) {
                  return step.description
                }

                // Get config from step or tool
                const config =
                  (step as any).config ||
                  (hasFormTool && tools?.[0]?.value) ||
                  {}

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
                          return `Upload a ${field.name || "file"} in formats such as PDF, DOCX or JPG`
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
                          return `Upload a ${field.name || "file"} in formats such as PDF, DOCX or JPG`
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
                        return `Upload a ${field.name || "file"} in formats such as PDF, DOCX or JPG`
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
                return "Upload a file in formats such as PDF, DOCX, or JPG."
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

          {/* Add Next Step Button */}
          {hasNext && (
            <div
              className="absolute left-1/2 transform -translate-x-1/2 flex flex-col items-center cursor-pointer z-50 pointer-events-auto"
              style={{ top: "calc(100% + 8px)" }}
              onClick={(e) => {
                e.stopPropagation()
                e.preventDefault()
                console.log("Plus button clicked for node:", id)
                const event = new CustomEvent("openWhatHappensNext", {
                  detail: { nodeId: id },
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
        </div>
      </>
    )
  }

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

        {/* Add Next Step Button */}
        {hasNext && (
          <div
            className="absolute left-1/2 transform -translate-x-1/2 flex flex-col items-center cursor-pointer z-10"
            style={{ top: "calc(100% + 8px)" }}
            onClick={(e) => {
              e.stopPropagation()
              // This will be handled by the parent component
              const event = new CustomEvent("openWhatHappensNext", {
                detail: { nodeId: id },
              })
              window.dispatchEvent(event)
            }}
          >
            <div className="w-0.5 h-6 bg-gray-300 mb-2"></div>
            <div
              className="bg-black hover:bg-gray-800 rounded-full flex items-center justify-center transition-colors"
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

// Header component
const Header = ({
  onBackToWorkflows,
  workflowName,
}: { onBackToWorkflows?: () => void; workflowName?: string }) => {
  return (
    <div className="flex flex-col items-start px-6 py-4 border-b border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-900 min-h-[80px] gap-3">
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
            / Untitled Workflow
          </span>
        </div>
      </div>

      {/* Full-width divider */}
      <div className="w-full h-px bg-slate-200 dark:bg-gray-700 -mx-6 self-stretch" />

      {/* Editor/Settings Toggle - positioned below divider */}
      <div className="flex items-center rounded-xl overflow-hidden border border-slate-200 dark:border-gray-700 bg-slate-50 dark:bg-gray-800">
        <button className="my-1 mx-1 px-4 py-1.5 bg-white dark:bg-gray-700 text-slate-800 dark:text-gray-200 text-sm font-medium border-none cursor-pointer flex items-center gap-1.5 h-8 min-w-[80px] justify-center rounded-lg shadow-sm">
          <EditorIcon />
          Editor
        </button>
        <button className="px-4 py-1.5 bg-transparent text-slate-500 dark:text-gray-400 text-sm font-medium border-none cursor-pointer flex items-center gap-1.5 h-8 min-w-[80px] justify-center">
          <SettingsIcon />
          Settings
        </button>
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
      <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[80vh] mx-4 relative overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">
            Execution Result
          </h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
          >
            <svg
              className="w-5 h-5 text-gray-500"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(80vh-120px)]">
          <div className="bg-gray-50 p-4 rounded-lg border">
            <pre className="whitespace-pre-wrap text-sm text-gray-800 font-mono leading-relaxed">
              {typeof result === "object"
                ? JSON.stringify(result, null, 2)
                : String(result)}
            </pre>
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

// Tools Sidebar Component
const ToolsSidebar = ({
  isVisible,
  nodeInfo,
  tools,
  onClose,
  onResultClick,
}: {
  isVisible: boolean
  nodeInfo: any
  tools: Tool[] | null
  onClose?: () => void
  onResultClick?: (result: any) => void
}) => {
  return (
    <div
      className={`h-full bg-white border-l border-slate-200 flex flex-col overflow-hidden transition-transform duration-300 ease-in-out ${
        isVisible ? "translate-x-0 w-[380px]" : "translate-x-full w-0"
      }`}
    >
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-200">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-sm font-semibold text-gray-700 tracking-wider uppercase">
            NODE DETAILS
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-100 rounded-md transition-colors"
            >
              <svg
                className="w-4 h-4 text-gray-500"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          )}
        </div>
        <div className="text-sm text-slate-500 leading-5 font-normal">
          {nodeInfo?.step?.name || "Selected node information"}
        </div>
      </div>

      {/* Node Information */}
      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-6">
        {/* Step Information */}
        {nodeInfo?.step && (
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">
                Step Information
              </h3>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-xs font-medium text-gray-500">
                    Name:
                  </span>
                  <span className="text-xs text-gray-900">
                    {nodeInfo.step.name}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs font-medium text-gray-500">
                    Type:
                  </span>
                  <span className="text-xs text-gray-900">
                    {nodeInfo.step.type || "Unknown"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs font-medium text-gray-500">
                    Status:
                  </span>
                  <span className="text-xs text-gray-900">
                    {nodeInfo.step.status || "Pending"}
                  </span>
                </div>
                {nodeInfo.step.description && (
                  <div>
                    <span className="text-xs font-medium text-gray-500">
                      Description:
                    </span>
                    <p className="text-xs text-gray-900 mt-1">
                      {nodeInfo.step.description}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tools Information */}
        {tools && tools.length > 0 && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-700">
              Associated Tools
            </h3>
            {tools.map((tool, index) => (
              <div
                key={tool.id || index}
                className="border border-gray-200 rounded-lg p-4 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-900">
                    {tool.type}
                  </span>
                  <div className="flex gap-2">
                    {(tool as any).status && (
                      <span
                        className={`text-xs px-2 py-1 rounded ${
                          (tool as any).status === "completed"
                            ? "bg-green-100 text-green-700"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {(tool as any).status}
                      </span>
                    )}
                    <span className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded">
                      Tool
                    </span>
                  </div>
                </div>

                {/* Tool Execution Result (for executions) */}
                {(tool as any).result && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-gray-600">
                        Execution Result
                      </h4>
                      <button
                        onClick={() => onResultClick?.((tool as any).result)}
                        className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded transition-colors"
                      >
                        View Full
                      </button>
                    </div>
                    <div
                      className="text-xs text-gray-900 bg-green-50 p-3 rounded max-h-40 overflow-y-auto border border-green-200 cursor-pointer hover:bg-green-100 transition-colors"
                      onClick={() => onResultClick?.((tool as any).result)}
                    >
                      <pre className="whitespace-pre-wrap">
                        {typeof (tool as any).result === "object"
                          ? JSON.stringify((tool as any).result, null, 2)
                          : String((tool as any).result)}
                      </pre>
                    </div>
                  </div>
                )}

                {/* Regular tool config (for templates) */}
                {tool.config && !(tool as any).result && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-gray-600">
                      Configuration
                    </h4>
                    <div className="space-y-1">
                      {Object.entries(tool.config).map(([key, value]) => (
                        <div key={key} className="flex justify-between text-xs">
                          <span className="text-gray-500 capitalize">
                            {key.replace(/_/g, " ")}:
                          </span>
                          <span
                            className="text-gray-900 max-w-[200px] truncate"
                            title={String(value)}
                          >
                            {typeof value === "object"
                              ? JSON.stringify(value)
                              : String(value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {(tool as any).value && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-gray-600">
                      Tool Value
                    </h4>
                    <div className="text-xs text-gray-900 bg-gray-50 p-2 rounded max-h-20 overflow-y-auto">
                      <pre>
                        {typeof (tool as any).value === "object"
                          ? JSON.stringify((tool as any).value, null, 2)
                          : String((tool as any).value)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* No Tools Message */}
        {(!tools || tools.length === 0) && (
          <div className="text-center py-8">
            <div className="text-gray-400 mb-2">
              <svg
                className="w-12 h-12 mx-auto"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1"
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                />
              </svg>
            </div>
            <p className="text-sm text-gray-500">
              No tools associated with this node
            </p>
          </div>
        )}

        {/* Position Information */}
        {nodeInfo?.position && (
          <div className="space-y-2 pt-4 border-t border-gray-200">
            <h3 className="text-sm font-semibold text-gray-700">Position</h3>
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">X:</span>
                <span className="text-gray-900">
                  {Math.round(nodeInfo.position.x)}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Y:</span>
                <span className="text-gray-900">
                  {Math.round(nodeInfo.position.y)}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const TriggersSidebar = ({
  isVisible,
  onTriggerClick,
  onClose,
}: {
  isVisible: boolean
  onClose?: () => void
  onTriggerClick?: (triggerId: string) => void
}) => {
  const triggers = [
    {
      id: "form",
      name: "On Form Submission",
      description:
        "Generate webforms in Xyne and pass their responses to the workflow",
      icon: <FormSubmissionIcon width={20} height={20} />,
      enabled: true,
    },
    {
      id: "manual",
      name: "Trigger Manually",
      description:
        "Runs the flow when triggered manually. Good for getting started quickly",
      icon: <ManualTriggerIcon width={20} height={20} />,
      enabled: false,
    },
    {
      id: "app_event",
      name: "On App Event",
      description: "Connect different apps to the workflow",
      icon: <AppEventIcon width={20} height={20} />,
      enabled: false,
    },
    {
      id: "schedule",
      name: "On Schedule",
      description: "Runs the flow every day, hour or custom interval",
      icon: <ScheduleIcon width={20} height={20} />,
      enabled: false,
    },
    {
      id: "workflow",
      name: "When executed by another workflow",
      description:
        "Runs the flow when called by the Execute Workflow node from a different workflow",
      icon: <WorkflowExecutionIcon width={20} height={20} />,
      enabled: false,
    },
    {
      id: "chat",
      name: "On Chat Message",
      description:
        "Runs the flow when a user sends a chat message. For use with AI nodes",
      icon: <ChatMessageIcon width={20} height={20} />,
      enabled: false,
    },
  ]

  const resources = [
    {
      id: "create_workflow",
      name: "How to create a workflow",
      icon: <HelpIcon width={20} height={20} />,
    },
    {
      id: "templates",
      name: "Templates",
      icon: <TemplatesIcon width={20} height={20} />,
    },
  ]

  return (
    <div
      className={`h-full bg-white dark:bg-gray-900 border-l border-slate-200 dark:border-gray-700 flex flex-col overflow-hidden transition-transform duration-300 ease-in-out ${
        isVisible ? "translate-x-0 w-[380px]" : "translate-x-full w-0"
      }`}
    >
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 tracking-wider uppercase">
            SELECT TRIGGERS
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
            >
              <svg
                className="w-4 h-4 text-gray-500 dark:text-gray-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          )}
        </div>
        <div className="text-sm text-slate-500 dark:text-gray-400 leading-5 font-normal">
          Trigger is an action that will initiate the workflow.
        </div>
      </div>

      {/* Triggers List */}
      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-1">
        {/* Enabled triggers */}
        {triggers
          .filter((trigger) => trigger.enabled)
          .map((trigger) => (
            <div
              key={trigger.id}
              onClick={() => onTriggerClick?.(trigger.id)}
              className="flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer transition-all duration-150 bg-transparent hover:bg-slate-50 dark:hover:bg-gray-800 text-slate-700 dark:text-gray-300 min-h-[60px]"
            >
              <div className="w-5 h-5 flex items-center justify-center text-slate-500 dark:text-gray-400 flex-shrink-0">
                {trigger.icon}
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-700 dark:text-gray-300 leading-5">
                  {trigger.name}
                </div>
                <div className="text-xs text-slate-500 dark:text-gray-400 leading-4 mt-1">
                  {trigger.description}
                </div>
              </div>
              <svg
                className="w-4 h-4 text-slate-400 dark:text-gray-500"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </div>
          ))}

        {/* Coming Soon Section */}
        <div className="mt-6 mb-4">
          <div className="text-xs font-semibold text-slate-500 dark:text-gray-500 tracking-wider uppercase">
            COMING SOON
          </div>
        </div>

        {/* Disabled triggers */}
        {triggers
          .filter((trigger) => !trigger.enabled)
          .map((trigger) => (
            <div
              key={trigger.id}
              className="flex items-center gap-3 px-4 py-3 rounded-lg cursor-not-allowed transition-all duration-150 bg-transparent text-slate-400 dark:text-gray-600 min-h-[60px] opacity-60"
            >
              <div className="w-5 h-5 flex items-center justify-center text-slate-400 dark:text-gray-600 flex-shrink-0">
                {trigger.icon}
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-400 dark:text-gray-600 leading-5">
                  {trigger.name}
                </div>
                <div className="text-xs text-slate-400 dark:text-gray-600 leading-4 mt-1">
                  {trigger.description}
                </div>
              </div>
              <svg
                className="w-4 h-4 text-slate-300 dark:text-gray-700"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </div>
          ))}
      </div>

      {/* Helpful Resources Section */}
      <div className="px-6 pt-5 pb-6">
        <div className="text-xs font-semibold text-slate-500 dark:text-gray-500 tracking-wider uppercase mb-4">
          HELPFUL RESOURCES
        </div>

        {resources.map((resource) => (
          <div
            key={resource.id}
            className="flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer transition-all duration-150 bg-white dark:bg-gray-800 hover:bg-slate-50 dark:hover:bg-gray-700 border border-slate-200 dark:border-gray-700 hover:border-slate-300 dark:hover:border-gray-600 mb-2 min-h-[44px]"
          >
            <div className="w-5 h-5 flex items-center justify-center text-slate-500 dark:text-gray-400 flex-shrink-0">
              {resource.icon}
            </div>
            <div className="text-sm font-medium text-slate-700 dark:text-gray-300 leading-5">
              {resource.name}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const EmptyCanvas: React.FC<{
  onAddFirstStep: () => void
  onStartWithTemplate: () => void
}> = ({ onAddFirstStep, onStartWithTemplate }) => {
  return (
    <div className="flex flex-col items-center justify-center gap-8 p-12 text-center">
      {/* Main CTA Button */}
      <button
        onClick={onAddFirstStep}
        className="px-8 py-5 bg-white dark:bg-gray-800 border-2 border-dashed border-slate-300 dark:border-gray-600 hover:border-slate-400 dark:hover:border-gray-500 rounded-xl text-slate-700 dark:text-gray-300 text-base font-medium cursor-pointer flex items-center gap-3 transition-all duration-200 min-w-[200px] justify-center hover:bg-slate-50 dark:hover:bg-gray-700 hover:-translate-y-px hover:shadow-md"
      >
        <AddIcon />
        Add first step
      </button>

      {/* Divider */}
      <div className="flex items-center gap-4 w-full max-w-[300px]">
        <div className="flex-1 h-px bg-slate-200 dark:bg-gray-600" />
        <div className="text-slate-500 dark:text-gray-400 text-sm font-medium uppercase tracking-wider">
          OR
        </div>
        <div className="flex-1 h-px bg-slate-200 dark:bg-gray-600" />
      </div>

      {/* Secondary Button */}
      <button
        onClick={onStartWithTemplate}
        className="px-6 py-3 bg-white dark:bg-gray-800 border border-slate-200 dark:border-gray-700 hover:border-slate-300 dark:hover:border-gray-600 rounded-lg text-slate-700 dark:text-gray-300 text-sm font-medium cursor-pointer transition-all duration-200 hover:bg-slate-50 dark:hover:bg-gray-700 hover:shadow-sm"
      >
        Start with a Template
      </button>
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
  selectedTemplate?: WorkflowTemplate | null
  isLoadingTemplate?: boolean
  isEditableMode?: boolean
}

// Internal component that uses ReactFlow hooks
const WorkflowBuilderInternal: React.FC<WorkflowBuilderProps> = ({
  onStepClick,
  onBackToWorkflows,
  selectedTemplate,
  isLoadingTemplate,
  isEditableMode,
}) => {
  const [selectedNodes, setSelectedNodes] = useState<Node[]>([])
  const [selectedEdges, setSelectedEdges] = useState<Edge[]>([])
  const [nodeCounter, setNodeCounter] = useState(1)
  const [showEmptyCanvas, setShowEmptyCanvas] = useState(true)
  const [showTriggersSidebar, setShowTriggersSidebar] = useState(false)
  const [showWhatHappensNextUI, setShowWhatHappensNextUI] = useState(false)
  const [showAIAgentConfigUI, setShowAIAgentConfigUI] = useState(false)
  const [showEmailConfigUI, setShowEmailConfigUI] = useState(false)
  const [showOnFormSubmissionUI, setShowOnFormSubmissionUI] = useState(false)
  const [selectedNodeForNext, setSelectedNodeForNext] = useState<string | null>(
    null,
  )
  const [selectedAgentNodeId, setSelectedAgentNodeId] = useState<string | null>(
    null,
  )
  const [selectedEmailNodeId, setSelectedEmailNodeId] = useState<string | null>(
    null,
  )
  const [selectedFormNodeId, setSelectedFormNodeId] = useState<string | null>(
    null,
  )
  const [zoomLevel, setZoomLevel] = useState(100)
  const [showToolsSidebar, setShowToolsSidebar] = useState(false)
  const [selectedNodeTools, setSelectedNodeTools] = useState<Tool[] | null>(
    null,
  )
  const [selectedNodeInfo, setSelectedNodeInfo] = useState<any>(null)
  const [showResultModal, setShowResultModal] = useState(false)
  const [selectedResult, setSelectedResult] = useState<any>(null)
  const [showExecutionModal, setShowExecutionModal] = useState(false)
  const [createdTemplate, setCreatedTemplate] = useState<WorkflowTemplate | null>(null)
  // Template workflow state (for creating the initial workflow)
  const [templateWorkflow, setTemplateWorkflow] = useState<TemplateFlow | null>(
    null,
  )
  const [, setIsLoadingTemplate] = useState(false)
  const [, setTemplateError] = useState<string | null>(null)

  // Running workflow state (for real-time updates)
  const [, setWorkflow] = useState<Flow | null>(null)
  const [, setIsPolling] = useState(false)
  const [pollingInterval, setPollingInterval] = useState<NodeJS.Timeout | null>(
    null,
  )

  // Empty initial state
  const initialNodes: Node[] = []
  const initialEdges: Edge[] = []

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)
  const { fitView, zoomTo, getViewport } = useReactFlow()

  // Create nodes and edges from selectedTemplate
  useEffect(() => {
    if (
      selectedTemplate &&
      (selectedTemplate.steps || selectedTemplate.stepExecutions)
    ) {
      console.log("Creating workflow from template:", selectedTemplate)

      // Check if this is an execution (has stepExecutions) or template (has steps)
      const isExecution =
        selectedTemplate.stepExecutions &&
        Array.isArray(selectedTemplate.stepExecutions)
      const stepsData = isExecution
        ? selectedTemplate.stepExecutions
        : selectedTemplate.steps

      // Sort steps by step_order or creation order before creating nodes
      const sortedSteps = [...stepsData].sort((a, b) => {
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

      console.log("Original steps:", stepsData)
      console.log("Sorted steps:", sortedSteps)

      // Create nodes from steps in top-down layout
      const templateNodes: Node[] = sortedSteps.map((step, index) => {
        // Find associated tools for this step
        let stepTools = []
        let toolExecutions = []

        if (isExecution) {
          // For executions, get tool executions from toolExecIds
          toolExecutions =
            selectedTemplate.toolExecutions?.filter((toolExec) =>
              step.toolExecIds?.includes(toolExec.id),
            ) || []

          // Create tool info from executions
          stepTools = toolExecutions.map((toolExec) => ({
            id: toolExec.id,
            type: "execution_tool",
            config: toolExec.result || {},
            toolExecutionId: toolExec.id,
            status: toolExec.status,
            result: toolExec.result,
          }))
        } else {
          // For templates, use workflow_tools
          stepTools =
            selectedTemplate.workflow_tools?.filter((tool) =>
              step.toolIds?.includes(tool.id),
            ) || []
        }

        // Check if this is the last step (no nextStepIds or empty nextStepIds)
        const isLastStep = !step.nextStepIds || step.nextStepIds.length === 0
        const hasNextFlag = isLastStep

        return {
          id: step.id,
          type: "stepNode",
          position: {
            x: 400, // Consistent X position for perfect vertical straight line alignment
            y: 100 + index * 250, // Increased spacing for better visual separation while maintaining straight lines
          },
          data: {
            step: {
              id: step.id,
              name: step.name,
              status: isExecution ? step.status : "pending",
              description:
                step.description || step.metadata?.automated_description,
              type: step.type,
              contents: [],
              metadata: step.metadata,
              isExecution,
              toolExecutions: isExecution ? toolExecutions : undefined,
            },
            tools: stepTools,
            isActive: isExecution && step.status === "running",
            isCompleted: isExecution && step.status === "completed",
            hasNext: hasNextFlag, // Show plus button on last step
          },
          draggable: true,
        }
      })

      // Create edges from nextStepIds
      const templateEdges: Edge[] = []
      stepsData.forEach((step) => {
        step.nextStepIds?.forEach((nextStepId) => {
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
            type: "straight",
            animated: false,
            style: {
              stroke: "#D1D5DB",
              strokeWidth: 2,
            },
            markerEnd: {
              type: "arrowclosed",
              color: "#D1D5DB",
            },
            sourceHandle: "bottom",
            targetHandle: "top",
          })
        })
      })

      console.log("Created nodes:", templateNodes.length)
      console.log("Created edges:", templateEdges.length)

      setNodes(templateNodes)
      setEdges(templateEdges)
      setNodeCounter(stepsData.length + 1)
      setShowEmptyCanvas(false)

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
        type: "straight",
        animated: false,
        style: {
          stroke: "#D1D5DB",
          strokeWidth: 2,
        },
        markerEnd: {
          type: "arrowclosed",
          color: "#D1D5DB",
        },
        sourceHandle: "bottom",
        targetHandle: "top",
      }
      setEdges((eds) => addEdge(newEdge, eds))
    },
    [setEdges],
  )

  const onSelectionChange = useCallback((params: OnSelectionChangeParams) => {
    setSelectedNodes(params.nodes)
    setSelectedEdges(params.edges)
  }, [])

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      // Generic node click handler that opens appropriate sidebar based on tool type
      const step = node.data?.step as Step
      const tools = (node.data?.tools as Tool[]) || []

      if (!step) return

      // Get the first tool to determine type
      const primaryTool = tools[0]
      const toolType = primaryTool?.type || step.type

      console.log(
        "🎯 Node clicked:",
        node.id,
        "Tool type:",
        toolType,
        "Step type:",
        step.type,
      )

      // Don't override sidebar state if What Happens Next is currently showing and this node is the selected one
      if (showWhatHappensNextUI && selectedNodeForNext === node.id) {
        console.log(
          "🔄 What Happens Next is open for this node, preserving state",
        )
        return
      }

      // Close all sidebars first
      setShowTriggersSidebar(false)
      setShowWhatHappensNextUI(false)
      setShowAIAgentConfigUI(false)
      setShowEmailConfigUI(false)
      setShowOnFormSubmissionUI(false)

      // Handle different tool types
      switch (toolType) {
        case "form":
          // Open Form config sidebar
          setSelectedFormNodeId(node.id)
          setShowOnFormSubmissionUI(true)
          console.log("📝 Opening form config sidebar")
          break

        case "python_code":
        case "python_script":
          // Open What Happens Next sidebar for Python code configuration
          setSelectedNodeForNext(node.id)
          setShowWhatHappensNextUI(true)
          console.log(
            "🐍 Opening Python code config sidebar for type:",
            toolType,
          )
          break

        case "email":
          // Open Email config sidebar
          setSelectedEmailNodeId(node.id)
          setShowEmailConfigUI(true)
          console.log("📧 Opening email config sidebar")
          break

        case "ai_agent":
          // Open AI Agent config sidebar
          setSelectedAgentNodeId(node.id)
          setShowAIAgentConfigUI(true)
          console.log("🤖 Opening AI agent config sidebar")
          break

        default:
          // For unknown types, open What Happens Next sidebar
          setSelectedNodeForNext(node.id)
          setShowWhatHappensNextUI(true)
          console.log("❓ Opening default sidebar for type:", toolType)

          if (onStepClick) {
            onStepClick(step)
          }
          break
      }
    },
    [onStepClick, showWhatHappensNextUI, selectedNodeForNext],
  )

  const onNodesDelete = useCallback<OnNodesDelete>(
    (_deleted) => {
      if (nodes.length === _deleted.length) {
        setShowEmptyCanvas(true)
      }
    },
    [nodes.length],
  )

  const onEdgesDelete = useCallback<OnEdgesDelete>((_deleted) => {
    // Handle edge deletion if needed in the future
  }, [])

  const addFirstStep = useCallback(() => {
    setShowTriggersSidebar(true)
    const newNode: Node = {
      id: "1",
      type: "stepNode",
      position: { x: 400, y: 100 }, // Consistent X position for straight line connections, starting higher
      data: {
        step: {
          id: "1",
          name: "Select trigger from the sidebar",
          status: "PENDING",
          contents: [],
        },
        isActive: false,
        isCompleted: false,
      },
      draggable: true,
    }

    setNodes([newNode])
    setNodeCounter(2)
    setShowEmptyCanvas(false)
    setZoomLevel(100)

    setTimeout(() => {
      zoomTo(1)
    }, 50)
  }, [setNodes, zoomTo])

  const startWithTemplate = useCallback(() => {
    if (!templateWorkflow) {
      console.error("No template workflow available")
      return
    }

    // Convert template workflow template_steps to nodes
    const templateNodes: Node[] = templateWorkflow.template_steps.map(
      (templateStep, index) => {
        // Find the associated tool for this step
        const associatedTool = templateWorkflow.tools?.find(
          (tool) => tool.id === templateStep.tool_id,
        )

        // Get all tools for this step (in case there are multiple)
        const stepTools = templateStep.tool_id
          ? templateWorkflow.tools?.filter(
              (tool) => tool.id === templateStep.tool_id,
            ) || []
          : []

        return {
          id: templateStep.id,
          type: "stepNode",
          position: {
            x: 200 + index * 300,
            y: 200 + (index % 2 === 0 ? 0 : 100),
          },
          data: {
            step: {
              id: templateStep.id,
              name: associatedTool
                ? `${associatedTool.type === "delay" ? "Processing Delay" : associatedTool.type === "python_script" ? (index === 1 ? "Process Data" : "Send Notification") : `Step ${index + 1}: ${associatedTool.type}`}`
                : index === 0
                  ? "Start Workflow"
                  : `Step ${index + 1}`,
              status: "pending",
              description:
                associatedTool?.config.description || "Template step",
              type: associatedTool?.type || "unknown",
              tool_id: templateStep.tool_id,
              prevStepIds: templateStep.prevStepIds,
              nextStepIds: templateStep.nextStepIds,
              contents: [],
            },
            tools: stepTools, // Pass tools data to the node
            isActive: false,
            isCompleted: false,
          },
          draggable: true,
        }
      },
    )

    // Create edges based on nextStepIds
    const templateEdges: Edge[] = []
    templateWorkflow.template_steps.forEach((templateStep) => {
      templateStep.nextStepIds.forEach((nextStepId) => {
        templateEdges.push({
          id: `${templateStep.id}-${nextStepId}`,
          source: templateStep.id,
          target: nextStepId,
          type: "straight",
          animated: false,
          style: {
            stroke: "#3B82F6",
            strokeWidth: 2,
          },
          markerEnd: {
            type: "arrowclosed",
            color: "#3B82F6",
          },
          sourceHandle: "bottom",
          targetHandle: "top",
          })
      })
    })

    setNodes(templateNodes)
    setEdges(templateEdges)
    setNodeCounter(templateWorkflow.template_steps.length + 1)
    setShowEmptyCanvas(false)

    setTimeout(() => {
      fitView({ padding: 0.2 })
    }, 50)
  }, [templateWorkflow, setNodes, setEdges, fitView])

  const addNewNode = useCallback(() => {
    const newNode: Node = {
      id: nodeCounter.toString(),
      type: "stepNode",
      position: {
        x: Math.random() * 400 + 200,
        y: Math.random() * 300 + 150,
      },
      data: {
        step: {
          id: nodeCounter.toString(),
          name: `New Step ${nodeCounter}`,
          status: "PENDING",
          contents: [],
        },
        isActive: false,
        isCompleted: false,
      },
      draggable: true,
    }

    setNodes((nds) => [...nds, newNode])
    setNodeCounter((prev) => prev + 1)
    setShowEmptyCanvas(false)
  }, [nodeCounter, setNodes, setShowEmptyCanvas])

  // Prevent unused variable warning
  void addNewNode

  const deleteSelectedNodes = useCallback(() => {
    if (selectedNodes.length > 0) {
      const nodeIdsToDelete = selectedNodes.map((node) => node.id)
      setNodes((nds) =>
        nds.filter((node) => !nodeIdsToDelete.includes(node.id)),
      )
      setEdges((eds) =>
        eds.filter(
          (edge) =>
            !nodeIdsToDelete.includes(edge.source) &&
            !nodeIdsToDelete.includes(edge.target),
        ),
      )
    }
  }, [selectedNodes, setNodes, setEdges])

  // Prevent unused variable warning
  void deleteSelectedNodes

  const handleZoomChange = useCallback(
    (zoom: number) => {
      setZoomLevel(zoom)
      zoomTo(zoom / 100)
    },
    [zoomTo],
  )

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

  // Listen for custom events from StepNode + icons
  useEffect(() => {
    const handleOpenWhatHappensNext = (event: CustomEvent) => {
      const { nodeId } = event.detail
      console.log("Plus button clicked, opening What Happens Next for node:", nodeId)
      
      // Close all other sidebars to ensure What Happens Next is shown
      setShowTriggersSidebar(false)
      setShowAIAgentConfigUI(false)
      setShowEmailConfigUI(false)
      setShowOnFormSubmissionUI(false)
      
      // Open What Happens Next sidebar
      setSelectedNodeForNext(nodeId)
      setShowWhatHappensNextUI(true)
    }

    window.addEventListener(
      "openWhatHappensNext" as any,
      handleOpenWhatHappensNext,
    )

    return () => {
      window.removeEventListener(
        "openWhatHappensNext" as any,
        handleOpenWhatHappensNext,
      )
    }
  }, [])

  // Function to stop polling
  const stopPolling = useCallback(() => {
    setIsPolling(false)

    if (pollingInterval) {
      clearInterval(pollingInterval)
      setPollingInterval(null)
    }
  }, [pollingInterval, setIsPolling, setPollingInterval])

  // Function to fetch workflow execution status
  const fetchWorkflowStatus = useCallback(
    async (executionId: string) => {
      try {
        // Use the status endpoint for lightweight polling
        const statusData = await workflowExecutionsAPI.fetchStatus(executionId)
        
        console.log("📊 Polling status for execution:", executionId, "Status:", statusData.status)

        // Check if workflow is completed or failed to stop polling
        if (statusData.success) {
          if (statusData.status === "completed") {
            console.log("✅ Workflow execution completed!")
            // Fetch full details to update nodes with final status
            const fullData = await workflowExecutionsAPI.fetchById(executionId)
            
            // Update nodes to show completed status
            if (fullData?.stepExecutions) {
              setNodes((currentNodes) =>
                currentNodes.map((node) => ({
                  ...node,
                  data: {
                    ...node.data,
                    isActive: false,
                    isCompleted: true,
                    step: node.data.step
                      ? {
                          ...node.data.step,
                          status: "completed",
                        }
                      : node.data.step,
                  },
                })),
              )
            }
            
            stopPolling()
          } else if (statusData.status === "failed") {
            console.log("❌ Workflow execution failed!")
            // Update nodes to show failed status
            setNodes((currentNodes) =>
              currentNodes.map((node) => ({
                ...node,
                data: {
                  ...node.data,
                  isActive: false,
                  isCompleted: false,
                  step: node.data.step
                    ? {
                        ...node.data.step,
                        status: "failed",
                      }
                    : node.data.step,
                },
              })),
            )
            
            stopPolling()
          } else if (statusData.status === "active") {
            // Update nodes to show active status
            setNodes((currentNodes) =>
              currentNodes.map((node, index) => ({
                ...node,
                data: {
                  ...node.data,
                  isActive: index === 0, // Show first step as active for simplicity
                  isCompleted: false,
                  step: node.data.step
                    ? {
                        ...node.data.step,
                        status: "running",
                      }
                    : node.data.step,
                },
              })),
            )
          }
        }
      } catch (error) {
        console.error("Error fetching workflow status:", error)
        // Stop polling on persistent errors
        stopPolling()
      }
    },
    [setNodes, stopPolling],
  )

  // Function to start polling
  const startPolling = useCallback(
    (workflowId: string) => {
      setIsPolling(true)

      // Clear any existing interval
      if (pollingInterval) {
        clearInterval(pollingInterval)
      }

      // Start polling every second
      const interval = setInterval(() => {
        fetchWorkflowStatus(workflowId)
      }, 1000)

      setPollingInterval(interval)
    },
    [pollingInterval, fetchWorkflowStatus, setIsPolling, setPollingInterval],
  )

  // Cleanup polling on component unmount
  useEffect(() => {
    return () => {
      if (pollingInterval) {
        clearInterval(pollingInterval)
      }
    }
  }, [pollingInterval])

  const executeWorkflow = useCallback(async (file?: File) => {
    if (file) {
      // File execution mode - requires existing template
      console.log("Executing workflow with file:", file.name)
      console.log("Selected template:", selectedTemplate)

      try {
        // Check if we have a valid template (prioritize createdTemplate over selectedTemplate)
        const currentTemplate = createdTemplate || selectedTemplate
        const templateId = currentTemplate?.id
        if (!templateId || templateId === "custom") {
          throw new Error("Cannot execute workflow with file: No valid template ID available. Please save the workflow as a template first.")
        }

        // Create form data matching the curl command format
        const formData: Record<string, any> = {
          name: `${currentTemplate?.name || "Workflow"} - ${new Date().toLocaleString()}`,
          description: `Execution of ${currentTemplate?.name || "workflow"} with file: ${file.name}`,
          file_description: `Test document: ${file.name}`,
        }

        console.log("Generated form data:", formData)

        const executionData = {
          name: formData.name,
          description: formData.description,
          file: file,
          formData: formData,
        }
        
        const response = await workflowExecutionsAPI.executeTemplate(
          templateId,
          executionData,
        )

        console.log("🚀 WORKFLOW EXECUTION RESPONSE:", response)

        // Handle response similar to execution modal
        if (response.error || response.status === "error") {
          console.error("Execution failed:", response.error || response.message)
          throw new Error(response.error || response.message || "Execution failed")
        } else {
          // Extract execution ID from response.data.execution.id
          const executionId = response.data?.execution?.id
          console.log("📋 Extracted execution ID:", executionId)

          if (executionId) {
            // Start polling for completion with the execution ID
            startPolling(executionId)
          } else {
            console.warn("No execution ID found in response")
          }
        }

        return response
      } catch (error) {
        console.error("Execution error:", error)
        throw error
      }
    } else {
      // Template creation mode - first create template, then open execution modal
      console.log("Creating workflow template for execution...")
      
      // Check if we have nodes to create a workflow
      if (nodes.length === 0) {
        throw new Error("Cannot execute workflow: No workflow steps defined. Please add at least one step to your workflow.")
      }

      // Create the workflow state payload for the complex template API
      const workflowState = {
        name: selectedTemplate?.name || `Custom Workflow ${new Date().toLocaleDateString()}`,
        description: selectedTemplate?.description || "Workflow created from builder",
        version: "1.0.0",
        config: {
          ai_model: "gemini-1.5-pro",
          max_file_size: "10MB",
          auto_execution: false,
          schema_version: "1.0",
          allowed_file_types: ["pdf", "docx", "txt", "jpg", "png"],
          supports_file_upload: true,
        },
        nodes: nodes.map(node => ({
          id: node.id,
          type: node.type,
          position: node.position,
          data: {
            step: node.data?.step,
            tools: node.data?.tools,
            isActive: node.data?.isActive,
            isCompleted: node.data?.isCompleted,
            hasNext: node.data?.hasNext,
          }
        })),
        edges: edges.map(edge => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: edge.type,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          style: edge.style,
          markerEnd: edge.markerEnd,
        })),
        metadata: {
          nodeCount: nodes.length,
          edgeCount: edges.length,
          createdAt: new Date().toISOString(),
          workflowType: templateWorkflow ? 'template-based' : 'user-created'
        }
      }
      
      console.log("=== WORKFLOW STATE FOR BACKEND API ===")
      console.log(JSON.stringify(workflowState, null, 2))
      console.log("=== END WORKFLOW STATE ===")

      try {
        // Create the workflow template in the backend
        const response = await fetch('http://localhost:3000/api/v1/workflow/templates/complex', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(workflowState),
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`Failed to create workflow template: ${response.status} ${response.statusText}. ${errorText.substring(0, 200)}`)
        }

        const result = await response.json()
        console.log("✅ Workflow template created successfully:", result)

        // Update the selectedTemplate state with the newly created template
        if (result.success && result.data) {
          // The API returns the created template - we can use this for execution
          const newTemplate = result.data
          
          // Store the created template for use in the execution modal
          setCreatedTemplate(newTemplate)
          
          // Open the WorkflowExecutionModal with the created template
          setShowExecutionModal(true)
          
          console.log("📋 Template ID for execution:", newTemplate.id)
        } else {
          throw new Error("Failed to create workflow template: Invalid response format")
        }
      } catch (error) {
        console.error("❌ Failed to create workflow template:", error)
        throw error
      }
    }
  }, [nodes, edges, templateWorkflow, selectedTemplate, createdTemplate, startPolling])

  const handleTriggerClick = useCallback(
    (triggerId: string) => {
      if (triggerId === "form") {
        // Create form submission node immediately so user can see and drag it
        const formNode: Node = {
          id: "form-submission",
          type: "stepNode",
          position: { x: 400, y: 100 }, // Consistent X position for straight line connections
          data: {
            step: {
              id: "form-submission",
              name: "Form Submission",
              status: "PENDING",
              contents: [],
              type: "form_submission",
              config: {
                title: "",
                description: "",
                fields: [
                  {
                    id: crypto.randomUUID(),
                    name: "Field 1",
                    placeholder: "",
                    type: "file",
                  },
                ],
              },
            },
            isActive: false,
            isCompleted: false,
            hasNext: false, // Will be set to true after configuration
          },
          draggable: true,
          selectable: true,
        }

        setNodes([formNode])
        setNodeCounter(2)
        setShowEmptyCanvas(false)
        setSelectedFormNodeId("form-submission")
        setShowOnFormSubmissionUI(true)
        setShowTriggersSidebar(false)

        // Reset zoom to 100% to match AI Agent/Email zoom level
        setZoomLevel(100)
        setTimeout(() => {
          zoomTo(1)
        }, 50)
      }
      // Handle other triggers here as needed
    },
    [setNodes, zoomTo],
  )

  const handleWhatHappensNextClose = useCallback(() => {
    setShowWhatHappensNextUI(false)
    setSelectedNodeForNext(null)
  }, [])

  const handleWhatHappensNextAction = useCallback(async (actionId: string) => {
    console.log("Selected action:", actionId)
    
    if (actionId === "ai_agent") {
      // When AI Agent is selected from WhatHappensNextUI, create a blank AI Agent node and open AIAgentConfigUI
      if (selectedNodeForNext) {
        const sourceNode = nodes.find((n) => n.id === selectedNodeForNext)
        if (sourceNode) {
          const newNodeId = `step-${nodeCounter}`
          
          // Create new AI Agent node positioned below the source node
          const newNode = {
            id: newNodeId,
            type: "stepNode",
            position: {
              x: 400, // Consistent X position for perfect straight line alignment
              y: sourceNode.position.y + 250, // Increased consistent vertical spacing for straight lines
            },
            data: {
              step: {
                id: newNodeId,
                name: "AI Agent",
                description: "",
                type: "ai_agent",
                status: "pending",
                contents: [],
                config: {},
              },
              tools: [],
              isActive: false,
              isCompleted: false,
              hasNext: false, // Will be set to true after configuration
            },
            draggable: true,
          }

          // Create edge connecting source to new node
          const newEdge: Edge = {
            id: `${selectedNodeForNext}-${newNodeId}`,
            source: selectedNodeForNext,
            target: newNodeId,
            type: "straight",
            animated: false,
            style: {
              stroke: "#D1D5DB",
              strokeWidth: 2,
            },
            markerEnd: {
              type: "arrowclosed" as const,
              color: "#D1D5DB",
            },
            sourceHandle: "bottom",
            targetHandle: "top",
          }

          // Update nodes and edges
          setNodes((prevNodes) => [...prevNodes, newNode])
          setEdges((prevEdges) => [...prevEdges, newEdge])
          setNodeCounter((prev) => prev + 1)

          // Remove hasNext from source node since it now has a next step
          setNodes((prevNodes) =>
            prevNodes.map((node) =>
              node.id === selectedNodeForNext
                ? {
                    ...node,
                    data: {
                      ...node.data,
                      hasNext: false,
                    },
                  }
                : node,
            ),
          )

          // Close WhatHappensNextUI and open AIAgentConfigUI for the new node
          setShowWhatHappensNextUI(false)
          setSelectedNodeForNext(null)
          setSelectedAgentNodeId(newNodeId)
          setShowAIAgentConfigUI(true)
        }
      }
    } else if (actionId === "email") {
      // When Email is selected from WhatHappensNextUI, create a blank Email node and open EmailConfigUI
      if (selectedNodeForNext) {
        const sourceNode = nodes.find((n) => n.id === selectedNodeForNext)
        if (sourceNode) {
          const newNodeId = `step-${nodeCounter}`
          
          // Create new Email node positioned below the source node
          const newNode = {
            id: newNodeId,
            type: "stepNode",
            position: {
              x: 400, // Consistent X position for perfect straight line alignment
              y: sourceNode.position.y + 250, // Increased consistent vertical spacing for straight lines
            },
            data: {
              step: {
                id: newNodeId,
                name: "Email",
                description: "",
                type: "email",
                status: "pending",
                contents: [],
                config: {},
              },
              tools: [],
              isActive: false,
              isCompleted: false,
              hasNext: false, // Will be set to true after configuration
            },
            draggable: true,
          }

          // Create edge connecting source to new node
          const newEdge: Edge = {
            id: `${selectedNodeForNext}-${newNodeId}`,
            source: selectedNodeForNext,
            target: newNodeId,
            type: "straight",
            animated: false,
            style: {
              stroke: "#D1D5DB",
              strokeWidth: 2,
            },
            markerEnd: {
              type: "arrowclosed" as const,
              color: "#D1D5DB",
            },
            sourceHandle: "bottom",
            targetHandle: "top",
          }

          // Update nodes and edges
          setNodes((prevNodes) => [...prevNodes, newNode])
          setEdges((prevEdges) => [...prevEdges, newEdge])
          setNodeCounter((prev) => prev + 1)

          // Remove hasNext from source node since it now has a next step
          setNodes((prevNodes) =>
            prevNodes.map((node) =>
              node.id === selectedNodeForNext
                ? {
                    ...node,
                    data: {
                      ...node.data,
                      hasNext: false,
                    },
                  }
                : node,
            ),
          )

          // Close WhatHappensNextUI and open EmailConfigUI for the new node
          setShowWhatHappensNextUI(false)
          setSelectedNodeForNext(null)
          setSelectedEmailNodeId(newNodeId)
          setShowEmailConfigUI(true)
        }
      }
    }
  }, [selectedNodeForNext, nodes, nodeCounter, setNodes, setEdges, setNodeCounter])

  const handleAIAgentConfigBack = useCallback(() => {
    setShowAIAgentConfigUI(false)
    setSelectedAgentNodeId(null)
  }, [])

  const handleAIAgentConfigSave = useCallback(
    (agentConfig: AIAgentConfig) => {
      if (selectedAgentNodeId) {
        // Format description with model information
        const formattedDescription = agentConfig.description
          ? `${agentConfig.description} using ${agentConfig.model}`
          : `AI agent to analyze and summarize documents using ${agentConfig.model}`

        // Find the source node that this AI Agent connects from
        const sourceEdge = edges.find(
          (edge) => edge.target === selectedAgentNodeId,
        )
        const sourceNode = sourceEdge
          ? nodes.find((n) => n.id === sourceEdge.source)
          : null

        // Update the AI Agent node with the configuration and add hasNext flag
        setNodes((nds) =>
          nds.map((node) =>
            node.id === selectedAgentNodeId
              ? {
                  ...node,
                  // Reposition node to ensure consistent X alignment for straight lines
                  position: sourceNode
                    ? {
                        x: 400, // Consistent X position for perfect straight line alignment
                        y: node.position.y, // Keep same Y position for straight line connection
                      }
                    : node.position,
                  data: {
                    ...node.data,
                    step: {
                      ...(node.data.step || {}),
                      name: agentConfig.name,
                      config: {
                        ...agentConfig,
                        description: formattedDescription,
                      },
                    },
                    hasNext: true, // Add the + icon after saving
                  },
                }
              : node,
          ),
        )
      }

      // Reset zoom to 100% after saving configuration
      setZoomLevel(100)
      setTimeout(() => {
        zoomTo(1)
      }, 50)

      setShowAIAgentConfigUI(false)
      setSelectedAgentNodeId(null)
    },
    [selectedAgentNodeId, edges, nodes, setNodes, zoomTo],
  )

  const handleEmailConfigBack = useCallback(() => {
    setShowEmailConfigUI(false)
    setSelectedEmailNodeId(null)
  }, [])

  const handleEmailConfigSave = useCallback(
    (emailConfig: EmailConfig) => {
      if (selectedEmailNodeId) {
        // Find the source node that this Email connects from
        const sourceEdge = edges.find(
          (edge) => edge.target === selectedEmailNodeId,
        )
        const sourceNode = sourceEdge
          ? nodes.find((n) => n.id === sourceEdge.source)
          : null

        // Update the Email node with the configuration and add hasNext flag
        setNodes((nds) =>
          nds.map((node) =>
            node.id === selectedEmailNodeId
              ? {
                  ...node,
                  // Reposition node to ensure consistent X alignment for straight lines
                  position: sourceNode
                    ? {
                        x: 400, // Consistent X position for perfect straight line alignment
                        y: node.position.y, // Keep same Y position for straight line connection
                      }
                    : node.position,
                  data: {
                    ...node.data,
                    step: {
                      ...(node.data.step || {}),
                      name: "Email",
                      config: {
                        sendingFrom: emailConfig.sendingFrom,
                        emailAddresses: emailConfig.emailAddresses,
                      },
                    },
                    hasNext: true, // Add the + icon after saving
                  },
                }
              : node,
          ),
        )
      }

      // Reset zoom to 100% after saving configuration
      setZoomLevel(100)
      setTimeout(() => {
        zoomTo(1)
      }, 50)

      setShowEmailConfigUI(false)
      setSelectedEmailNodeId(null)
    },
    [selectedEmailNodeId, edges, nodes, setNodes, zoomTo],
  )

  const handleOnFormSubmissionBack = useCallback(() => {
    setShowOnFormSubmissionUI(false)
    setSelectedFormNodeId(null)
    // Go back to main workflow view
  }, [])

  const handleOnFormSubmissionSave = useCallback(
    (formConfig: FormConfig) => {
      // Always update the existing form submission node (since we create it immediately on trigger click)
      if (selectedFormNodeId) {
        setNodes((nds) =>
          nds.map((node) =>
            node.id === selectedFormNodeId
              ? {
                  ...node,
                  data: {
                    ...node.data,
                    step: {
                      ...(node.data.step || {}),
                      name: formConfig.title || "Form Submission",
                      config: formConfig,
                    },
                    hasNext: true, // Enable + icon after configuration
                  },
                }
              : node,
          ),
        )
      }

      setShowOnFormSubmissionUI(false)
      setSelectedFormNodeId(null)
      setZoomLevel(100)

      setTimeout(() => {
        zoomTo(1)
      }, 50)
    },
    [selectedFormNodeId, setNodes, zoomTo],
  )

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
            onSelectionChange={onSelectionChange}
            nodeTypes={nodeTypes}
            connectionLineType={ConnectionLineType.Straight}
            fitView
            className="bg-gray-100 dark:bg-slate-900"
            multiSelectionKeyCode="Shift"
            deleteKeyCode="Delete"
            snapToGrid={true}
            snapGrid={[20, 20]}
            defaultEdgeOptions={{
              type: 'straight',
              style: { 
                strokeWidth: 2,
                stroke: '#D1D5DB'
              },
              markerEnd: { 
                type: 'arrowclosed',
                color: '#D1D5DB'
              },
            }}
            connectionLineStyle={{
              strokeWidth: 2,
              stroke: '#D1D5DB',
            }}
            proOptions={{ hideAttribution: true }}
          >
            {/* Selection Info Panel */}
            {(selectedNodes.length > 0 || selectedEdges.length > 0) && (
              <Panel position="top-right">
                <div className="bg-white dark:bg-gray-800 p-3 rounded-lg shadow-md border border-slate-200 dark:border-gray-700 min-w-[200px]">
                  <div className="text-sm font-semibold mb-2 text-gray-900 dark:text-gray-100">
                    Selection Info
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Nodes: {selectedNodes.length} | Edges:{" "}
                    {selectedEdges.length}
                  </div>
                  {selectedNodes.length === 1 && selectedNodes[0].data?.step ? (
                    <div className="text-xs mt-1 text-gray-700 dark:text-gray-300">
                      <strong>Step:</strong>{" "}
                      {(selectedNodes[0].data.step as Step).name || "Unnamed"}
                    </div>
                  ) : null}
                </div>
              </Panel>
            )}

            {/* Empty Canvas Content */}
            {showEmptyCanvas && !isLoadingTemplate && (
              <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-[5] text-center">
                <EmptyCanvas
                  onAddFirstStep={addFirstStep}
                  onStartWithTemplate={startWithTemplate}
                />
              </div>
            )}

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

            {/* Action Bar at bottom center */}
            {!showEmptyCanvas && isEditableMode && (
              <Panel position="bottom-center">
                <ActionBar
                  onExecute={async () => {
                    try {
                      await executeWorkflow()
                    } catch (error) {
                      console.error("Failed to execute workflow:", error)
                      // You could add user notification here if needed
                      alert(`Failed to execute workflow: ${error instanceof Error ? error.message : "Unknown error"}`)
                    }
                  }}
                  zoomLevel={zoomLevel}
                  onZoomChange={handleZoomChange}
                />
              </Panel>
            )}
          </ReactFlow>
        </div>

        {/* Tools Sidebar */}
        <ToolsSidebar
          isVisible={showToolsSidebar}
          nodeInfo={selectedNodeInfo}
          tools={selectedNodeTools}
          onClose={() => setShowToolsSidebar(false)}
          onResultClick={handleResultClick}
        />

        {/* Right Triggers Sidebar */}
        {!showWhatHappensNextUI &&
          !showAIAgentConfigUI &&
          !showEmailConfigUI &&
          !showOnFormSubmissionUI && (
            <TriggersSidebar
              isVisible={showTriggersSidebar}
              onTriggerClick={handleTriggerClick}
              onClose={() => setShowTriggersSidebar(false)}
            />
          )}

        {/* What Happens Next Sidebar */}
        {!showAIAgentConfigUI &&
          !showEmailConfigUI &&
          !showOnFormSubmissionUI && (
            <WhatHappensNextUI
              isVisible={showWhatHappensNextUI}
              onClose={handleWhatHappensNextClose}
              onSelectAction={handleWhatHappensNextAction}
              selectedNodeId={selectedNodeForNext}
              toolType={
                selectedNodeForNext
                  ? (() => {
                      const node = nodes.find((n) => n.id === selectedNodeForNext)
                      const tools = node?.data?.tools as Tool[] | undefined
                      return tools && tools.length > 0 ? tools[0]?.type : undefined
                    })()
                  : undefined
              }
              toolData={
                selectedNodeForNext
                  ? (() => {
                      const node = nodes.find((n) => n.id === selectedNodeForNext)
                      const tools = node?.data?.tools as Tool[] | undefined
                      return tools && tools.length > 0 ? tools[0] : undefined
                    })()
                  : undefined
              }
              selectedTemplate={selectedTemplate}
              onStepCreated={(stepData) => {
                console.log("Step created:", stepData)
                
                // Create visual step below the selected node
                if (selectedNodeForNext && stepData) {
                  const sourceNode = nodes.find((n) => n.id === selectedNodeForNext)
                  if (sourceNode) {
                    const newNodeId = `step-${nodeCounter}`
                    
                    // Create new node positioned below the source node
                    const newNode = {
                      id: newNodeId,
                      type: "stepNode",
                      position: {
                        x: 400, // Consistent X position for perfect straight line alignment
                        y: sourceNode.position.y + 250, // Increased consistent vertical spacing for straight lines
                      },
                      data: {
                        step: {
                          id: newNodeId,
                          name: stepData.name,
                          description: stepData.description,
                          type: stepData.type,
                          status: "pending",
                          contents: [],
                          config: stepData.tool?.value || {},
                        },
                        tools: stepData.tool ? [stepData.tool] : [],
                        isActive: false,
                        isCompleted: false,
                        hasNext: true, // Show + button on new step
                      },
                      draggable: true,
                    }

                    // Create edge connecting source to new node
                    const newEdge: Edge = {
                      id: `${selectedNodeForNext}-${newNodeId}`,
                      source: selectedNodeForNext,
                      target: newNodeId,
                      type: "straight",
                      animated: false,
                      style: {
                        stroke: "#D1D5DB",
                        strokeWidth: 2,
                      },
                      markerEnd: {
                        type: "arrowclosed" as const,
                        color: "#D1D5DB",
                      },
                      sourceHandle: "bottom",
                      targetHandle: "top",
                    }

                    // Update nodes and edges
                    setNodes((prevNodes) => [...prevNodes, newNode])
                    setEdges((prevEdges) => [...prevEdges, newEdge])
                    setNodeCounter((prev) => prev + 1)

                    // Remove hasNext from source node since it now has a next step
                    setNodes((prevNodes) =>
                      prevNodes.map((node) =>
                        node.id === selectedNodeForNext
                          ? {
                              ...node,
                              data: {
                                ...node.data,
                                hasNext: false,
                              },
                            }
                          : node,
                      ),
                    )
                  }
                }
              }}
            />
          )}

        {/* AI Agent Config Sidebar */}
        {!showEmailConfigUI && !showOnFormSubmissionUI && (
          <AIAgentConfigUI
            isVisible={showAIAgentConfigUI}
            onBack={handleAIAgentConfigBack}
            onSave={handleAIAgentConfigSave}
            toolData={
              selectedAgentNodeId
                ? (() => {
                    const node = nodes.find((n) => n.id === selectedAgentNodeId)
                    const tools = node?.data?.tools as Tool[] | undefined
                    return tools && tools.length > 0 ? tools[0] : undefined
                  })()
                : undefined
            }
            toolId={
              selectedAgentNodeId
                ? (() => {
                    const node = nodes.find((n) => n.id === selectedAgentNodeId)
                    const tools = node?.data?.tools as Tool[] | undefined
                    return tools && tools.length > 0 ? tools[0]?.id : undefined
                  })()
                : undefined
            }
            stepData={
              selectedAgentNodeId
                ? (() => {
                    const node = nodes.find((n) => n.id === selectedAgentNodeId)
                    return node?.data?.step
                  })()
                : undefined
            }
          />
        )}

        {/* Email Config Sidebar */}
        {!showAIAgentConfigUI && !showOnFormSubmissionUI && (
          <EmailConfigUI
            isVisible={showEmailConfigUI}
            onBack={handleEmailConfigBack}
            onSave={handleEmailConfigSave}
            toolData={
              selectedEmailNodeId
                ? (() => {
                    const node = nodes.find((n) => n.id === selectedEmailNodeId)
                    const tools = node?.data?.tools as Tool[] | undefined
                    return tools && tools.length > 0 ? tools[0] : undefined
                  })()
                : undefined
            }
            toolId={
              selectedEmailNodeId
                ? (() => {
                    const node = nodes.find((n) => n.id === selectedEmailNodeId)
                    const tools = node?.data?.tools as Tool[] | undefined
                    return tools && tools.length > 0 ? tools[0]?.id : undefined
                  })()
                : undefined
            }
            stepData={
              selectedEmailNodeId
                ? (() => {
                    const node = nodes.find((n) => n.id === selectedEmailNodeId)
                    return node?.data?.step
                  })()
                : undefined
            }
          />
        )}

        {/* On Form Submission Config Sidebar */}
        {showOnFormSubmissionUI && (
          <OnFormSubmissionUI
            onBack={handleOnFormSubmissionBack}
            onSave={handleOnFormSubmissionSave}
            initialConfig={
              selectedFormNodeId
                ? (
                    nodes.find((n) => n.id === selectedFormNodeId)?.data
                      ?.step as any
                  )?.config
                : undefined
            }
            toolData={
              selectedFormNodeId
                ? (() => {
                    const node = nodes.find((n) => n.id === selectedFormNodeId)
                    const tools = node?.data?.tools as Tool[] | undefined
                    return tools && tools.length > 0 ? tools[0] : undefined
                  })()
                : undefined
            }
            toolId={
              selectedFormNodeId
                ? (() => {
                    const node = nodes.find((n) => n.id === selectedFormNodeId)
                    const tools = node?.data?.tools as Tool[] | undefined
                    return tools && tools.length > 0 ? tools[0]?.id : undefined
                  })()
                : undefined
            }
          />
        )}
      </div>

      {/* Execution Result Modal */}
      <ExecutionResultModal
        isVisible={showResultModal}
        result={selectedResult}
        onClose={handleResultModalClose}
      />

      {/* Workflow Execution Modal */}
      {showExecutionModal && (createdTemplate || selectedTemplate) && (
        <WorkflowExecutionModal
          isOpen={showExecutionModal}
          onClose={() => {
            setShowExecutionModal(false)
            setCreatedTemplate(null) // Clear created template when modal closes
          }}
          workflowName={(createdTemplate || selectedTemplate)?.name || "Custom Workflow"}
          workflowDescription={(createdTemplate || selectedTemplate)?.description || "User-created workflow"}
          templateId={(createdTemplate || selectedTemplate)!.id}
          workflowTemplate={(createdTemplate || selectedTemplate)!}
        />
      )}
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
