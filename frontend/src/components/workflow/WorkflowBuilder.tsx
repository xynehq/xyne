import React, { useCallback, useState, useEffect, useRef } from "react"
import { Bot, Mail, Plus, Play, Clock } from "lucide-react"
import { PlusButton } from "./PlusButton"
import {  FileText } from "lucide-react"
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
} from "./Types"
import { api } from "../../api"

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
  stepExecutions?: Array<{
    id: string
    workflowExecutionId: string
    workflowStepTemplateId: string
    name: string
    type: string
    status: string
    parentStepId: string | null
    prevStepIds: string[]
    nextStepIds: string[]
    toolExecId: string[]
    timeEstimate: number
    metadata: any
    completedBy: string | null
    createdAt: string
    updatedAt: string
    completedAt: string | null
  }>
  toolExecutions?: Array<{
    id: string
    workflowToolId: string
    workflowExecutionId: string
    status: string
    result: any
    startedAt: string | null
    completedAt: string | null
    createdAt: string
    updatedAt: string
  }>
}
import ActionBar from "./ActionBar"
import {
  ManualTriggerIcon,
  AppEventIcon,
  ScheduleIcon,
  WorkflowExecutionIcon,
  ChatMessageIcon,
  HelpIcon,
  TemplatesIcon,
  AddIcon,
} from "./WorkflowIcons"
import {
  workflowExecutionsAPI,
} from "./api/ApiHandlers"
import WhatHappensNextUI from "./WhatHappensNextUI"
import AIAgentConfigUI, { AIAgentConfig } from "./AIAgentConfigUI"
import EmailConfigUI, { EmailConfig } from "./EmailConfigUI"
import { ScriptSidebar } from "../ScriptSidebar"
import OnFormSubmissionUI, { FormConfig } from "./OnFormSubmissionUI"
import ReviewExecutionUI from "./ReviewExecutionUI"
import TriggerExecutionUI from "./TriggerExecutionUI"
import { WorkflowExecutionModal } from "./WorkflowExecutionModal"
import { TemplateSelectionModal } from "./TemplateSelectionModal"
import Snackbar from "../ui/Snackbar"
import ConfirmationPopup from "../ui/ConfirmationPopup"

// Import the ReviewEmailConfig type
type ReviewEmailConfig = {
  email_addresses: string[]
  email_message: string
}

// Custom Node Component
const StepNode: React.FC<NodeProps> = ({
  data,
  isConnectable,
  selected,
  id,
}) => {
  const { step, isActive, isCompleted, tools, hasNext, isTriggerSelector } = data as {
    step: Step
    isActive?: boolean
    isCompleted?: boolean
    tools?: Tool[]
    hasNext?: boolean
    isTriggerSelector?: boolean
  }

  // Special rendering for "Select trigger from the sidebar" node
  if (isTriggerSelector || step.name === "Select trigger from the sidebar" || step.type === "trigger_selector") {
    return (
      <>
        <div
          className="px-8 py-5 bg-white dark:bg-gray-800 border-2 border-dashed border-slate-300 dark:border-gray-600 hover:border-slate-400 dark:hover:border-gray-500 rounded-xl text-slate-700 dark:text-gray-300 text-base font-medium cursor-pointer flex items-center gap-3 transition-all duration-200 min-w-[200px] justify-center hover:bg-slate-50 dark:hover:bg-gray-700 hover:-translate-y-px hover:shadow-md"
          onClick={(e) => {
            e.stopPropagation()
            // This will open the triggers sidebar
            const event = new CustomEvent("openTriggersSidebar", {
              detail: { nodeId: id },
            })
            window.dispatchEvent(event)
          }}
        >
          <svg
            className="w-5 h-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Select trigger from sidebar
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
      </>
    )
  }

  // Special rendering for AI Agent nodes and steps with ai_agent tools
  const hasAIAgentTool =
    tools && tools.length > 0 && tools[0].type === "ai_agent"
  if (step.type === "ai_agent" || hasAIAgentTool) {
    // Get config from step or tool
    const aiConfig =
      (step as any).config || (hasAIAgentTool && tools?.[0]?.val) || {}
    const isConfigured = 
      (aiConfig?.name && aiConfig?.name.trim() !== "") || 
      step.name || 
      step.description ||
      (hasAIAgentTool && tools?.[0])

    if (!isConfigured) {
      // Show only icon when not configured
      return (
        <>
          <div
            className={`relative cursor-pointer hover:shadow-lg transition-all bg-white dark:bg-gray-800 border-2 ${
              selected 
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
            {/* Blue bot icon with background */}
            <div
              className="flex justify-center items-center flex-shrink-0 bg-blue-50 dark:bg-blue-900/50"
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
              <Bot width={20} height={20} color="#2563EB" />
            </div>

            <PlusButton hasNext={hasNext} nodeId={id} isConnectable={isConnectable} showHandles={true} />
          </div>
        </>
      )
    }

    // Show full content when configured
    return (
      <>
        <div
          className={`relative cursor-pointer hover:shadow-lg transition-all bg-white dark:bg-gray-800 border-2 ${
            selected 
              ? "border-gray-800 dark:border-gray-300 shadow-lg" 
              : "border-gray-300 dark:border-gray-600"
          }`}
          style={{
            width: "320px",
            minHeight: "122px",
            borderRadius: "12px",
            boxShadow: "0 0 0 2px #E2E2E2",
          }}
        >
          {/* Header with icon and title */}
          <div className="flex items-center gap-3 text-left w-full px-4 pt-4 mb-3">
            {/* Blue bot icon with background */}
            <div
              className="flex justify-center items-center flex-shrink-0 bg-blue-50 dark:bg-blue-900/50"
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
              <Bot width={16} height={16} color="#2563EB" />
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
              {(() => {
                // First try to get name from workflow_tools[index].val.name
                if (hasAIAgentTool && tools?.[0]?.val && typeof tools[0].val === 'object' && (tools[0].val as any)?.name) {
                  return (tools[0].val as any).name
                }
                
                // Try to get name from workflow_tools[index].value.name
                if (hasAIAgentTool && tools?.[0] && (tools[0] as any)?.value && typeof (tools[0] as any).value === 'object' && (tools[0] as any).value?.name) {
                  return (tools[0] as any).value.name
                }
                
                // Fallback to existing logic
                return step.name || aiConfig?.name || "AI Agent"
              })()}
            </h3>
          </div>

          {/* Full-width horizontal divider */}
          <div className="w-full h-px bg-gray-200 dark:bg-gray-600 mb-3"></div>

          {/* Description text */}
          <div className="px-4 pb-4">
            <p className="text-gray-600 dark:text-gray-300 text-sm leading-relaxed text-left break-words overflow-hidden">
              {(() => {
                // First try to get description from workflow_tools[index].val.description
                if (hasAIAgentTool && tools?.[0]?.val && typeof tools[0].val === 'object' && (tools[0].val as any)?.description) {
                  return (tools[0].val as any).description
                }
                
                // Try to get description from workflow_tools[index].value.description
                if (hasAIAgentTool && tools?.[0] && (tools[0] as any)?.value && typeof (tools[0] as any).value === 'object' && (tools[0] as any).value?.description) {
                  return (tools[0] as any).value.description
                }
                
                // Fallback to existing logic
                return step.description ||
                  aiConfig?.description ||
                  `AI agent to analyze and summarize documents using ${aiConfig?.model || "gpt-oss-120b"}.`
              })()}
            </p>
          </div>

          <PlusButton hasNext={hasNext} nodeId={id} isConnectable={isConnectable} showHandles={true} />
        </div>
      </>
    )
  }

  // Special rendering for Email nodes and steps with email tools
  const hasEmailTool = tools && tools.length > 0 && tools[0].type === "email"
  if (step.type === "email" || hasEmailTool) {
    // Get config from step or tool
    const emailConfig =
      (step as any).config || (hasEmailTool && tools?.[0]?.val) || {}
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
            className={`relative cursor-pointer hover:shadow-lg transition-all bg-white dark:bg-gray-800 border-2 ${
              selected 
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
            {/* Purple mail icon with background */}
            <div
              className="flex justify-center items-center flex-shrink-0 bg-purple-50 dark:bg-purple-900/50"
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
              <Mail width={20} height={20} color="#7C3AED" />
            </div>

            <PlusButton hasNext={hasNext} nodeId={id} isConnectable={isConnectable} showHandles={true} />
          </div>
        </>
      )
    }

    // Show full content when configured
    return (
      <>
        <div
          className={`relative cursor-pointer hover:shadow-lg transition-all bg-white dark:bg-gray-800 border-2 ${
            selected 
              ? "border-gray-800 dark:border-gray-300 shadow-lg" 
              : "border-gray-300 dark:border-gray-600"
          }`}
          style={{
            width: "320px",
            minHeight: "122px",
            borderRadius: "12px",
            boxShadow: "0 0 0 2px #E2E2E2",
          }}
        >
          {/* Header with icon and title */}
          <div className="flex items-center gap-3 text-left w-full px-4 pt-4 mb-3">
            {/* Purple mail icon with background */}
            <div
              className="flex justify-center items-center flex-shrink-0 bg-purple-50 dark:bg-purple-900/50"
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
              <Mail width={16} height={16} color="#7C3AED" />
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
              {(() => {
                // First try to get title from workflow_tools[index].val.title
                if (hasEmailTool && tools?.[0]?.val && typeof tools[0].val === 'object' && (tools[0].val as any)?.title) {
                  return (tools[0].val as any).title
                }
                
                // Try to get title from workflow_tools[index].value.title
                if (hasEmailTool && tools?.[0] && (tools[0] as any)?.value && typeof (tools[0] as any).value === 'object' && (tools[0] as any).value?.title) {
                  return (tools[0] as any).value.title
                }
                
                // Fallback to existing logic
                return step.name || "Email"
              })()}
            </h3>
          </div>

          {/* Full-width horizontal divider */}
          <div className="w-full h-px bg-gray-200 dark:bg-gray-600 mb-3"></div>

          {/* Description text */}
          <div className="px-4 pb-4">
            <p className="text-gray-600 dark:text-gray-300 text-sm leading-relaxed text-left break-words overflow-hidden">
              {(() => {
                // First try to get description from workflow_tools[index].val.description
                if (hasEmailTool && tools?.[0]?.val && typeof tools[0].val === 'object' && (tools[0].val as any)?.description) {
                  return (tools[0].val as any).description
                }
                
                // Try to get description from workflow_tools[index].value.description
                if (hasEmailTool && tools?.[0] && (tools[0] as any)?.value && typeof (tools[0] as any).value === 'object' && (tools[0] as any).value?.description) {
                  return (tools[0] as any).value.description
                }
                
                // Always generate description from email addresses
                return (emailAddresses && emailAddresses.length > 0
                  ? `Send emails to ${emailAddresses.join(", ")}`
                  : "Send automated email notifications to specified recipients.")
              })()}
            </p>
          </div>

          <PlusButton hasNext={hasNext} nodeId={id} isConnectable={isConnectable} showHandles={true} />
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
          className={`relative cursor-pointer hover:shadow-lg transition-all bg-white dark:bg-gray-800 border-2 ${
            selected 
              ? "border-gray-800 dark:border-gray-300 shadow-lg" 
              : "border-gray-300 dark:border-gray-600"
          }`}
          style={{
            width: "320px",
            minHeight: "122px",
            borderRadius: "12px",
            boxShadow: "0 0 0 2px #E2E2E2",
          }}
        >
          {/* Header with icon and title */}
          <div className="flex items-center gap-3 text-left w-full px-4 pt-4 mb-3">
            {/* Green document icon with background */}
            <div
              className="flex justify-center items-center flex-shrink-0 bg-green-50 dark:bg-green-900/50"
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
              <FileText size={16} />
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
              {(() => {
                // First try to get title from workflow_tools[index].val.title
                if (hasFormTool && tools?.[0]?.val && typeof tools[0].val === 'object' && (tools[0].val as any)?.title) {
                  return (tools[0].val as any).title
                }
                
                // Try to get title from workflow_tools[index].value.title
                if (hasFormTool && tools?.[0] && (tools[0] as any)?.value && typeof (tools[0] as any).value === 'object' && (tools[0] as any).value?.title) {
                  return (tools[0] as any).value.title
                }
                
                // Fallback to existing logic
                return step.name ||
                  (step as any).config?.title ||
                  (hasFormTool && tools?.[0] && typeof tools[0].val === 'object' && tools[0].val?.title) ||
                  "Form Submission"
              })()}
            </h3>
          </div>

          {/* Full-width horizontal divider */}
          <div className="w-full h-px bg-gray-200 dark:bg-gray-600 mb-3"></div>

          {/* Description text */}
          <div className="px-4 pb-4">
            <p className="text-gray-600 dark:text-gray-300 text-sm leading-relaxed text-left break-words overflow-hidden">
              {(() => {
                // First try to get description from workflow_tools[index].val.description
                if (hasFormTool && tools?.[0]?.val && typeof tools[0].val === 'object' && (tools[0].val as any)?.description) {
                  return (tools[0].val as any).description
                }
                
                // Try to get description from workflow_tools[index].value.description
                if (hasFormTool && tools?.[0] && (tools[0] as any)?.value && typeof (tools[0] as any).value === 'object' && (tools[0] as any).value?.description) {
                  return (tools[0] as any).value.description
                }
                
                // If step has description, use it next
                if (step.description) {
                  return step.description
                }

                // Get config from step or tool
                const config =
                  (step as any).config ||
                  (hasFormTool && tools?.[0]?.val) ||
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
                          return `Upload a ${field.name || "file"} in formats such as text, PDF, or Word`
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
                          return `Upload a ${field.name || "file"} in formats such as text, PDF, or Word`
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
                        return `Upload a ${field.name || "file"} in formats such as text, PDF, or Word`
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
                return "Upload a file in formats such as text, PDF, or Word."
              })()}
            </p>
          </div>

          <PlusButton hasNext={hasNext} nodeId={id} isConnectable={isConnectable} showHandles={true} />
        </div>
      </>
    )
  }

  // Special rendering for review nodes and steps with review tools
  const hasReviewTool = tools && tools.length > 0 && tools[0].type === "review"
  if (step.type === "review" || hasReviewTool) {
    // Get config from step or tool
    const reviewConfig =
      (step as any).config || (hasReviewTool && tools?.[0]?.config) || {}
    const reviewDefinition =
      (step as any).value || (hasReviewTool && tools?.[0]?.val) || {}
    
    const isConfigured = reviewConfig.approved && reviewConfig.rejected
    const isAwaitingReview = step.status === "active" && step.type === "review"

    return (
      <>
        <div
          className={`relative cursor-pointer hover:shadow-lg transition-all ${
            isAwaitingReview
              ? "bg-amber-50 dark:bg-amber-900/20 border-2 border-amber-300 dark:border-amber-600"
              : "bg-white dark:bg-gray-800 border-2"
          } ${
            selected 
              ? "border-purple-600 shadow-xl shadow-purple-500/15" 
              : isAwaitingReview
              ? "border-amber-300 dark:border-amber-600"
              : "border-gray-200 dark:border-gray-700 hover:border-gray-300"
          } rounded-xl p-4 min-w-[280px] flex flex-col`}
        >
          {/* Header */}
          <div className="flex items-center space-x-3 mb-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
              isAwaitingReview 
                ? "bg-amber-100 dark:bg-amber-800" 
                : "bg-orange-100 dark:bg-orange-800"
            }`}>
              <svg
                className={`w-4 h-4 ${
                  isAwaitingReview 
                    ? "text-amber-600 dark:text-amber-300" 
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
                {step.name || reviewDefinition.title || "Review Step"}
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
                
                if (reviewDefinition.description) {
                  return reviewDefinition.description
                }
                
                if (isConfigured) {
                  return `Review step configured with approval and rejection paths.`
                }
                
                return "Review step - configure approval and rejection paths"
              })()}
            </p>
          </div>

          {/* ReactFlow Handles for Review Node - positioned to align with grey dot */}
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

          {/* Conditional Plus Buttons for Review Steps */}
          {!isAwaitingReview && (
            <>
              {/* Approved path plus button - positioned at 25% */}
              {!(data.approvedPathUsed) && (
                <div className="absolute left-1/4 transform -translate-x-1/2 flex flex-col items-center cursor-pointer z-50 pointer-events-auto"
                  style={{ top: "calc(100% + 8px)" }}>
                  <div className="w-0.5 h-6 bg-gray-300 dark:bg-gray-600 mb-2"></div>
                  <div
                    className="bg-black hover:bg-gray-800 rounded-full flex items-center justify-center transition-colors shadow-lg"
                    style={{
                      width: "28px",
                      height: "28px",
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                      const event = new CustomEvent("openWhatHappensNext", {
                        detail: { nodeId: id, reviewPath: "approved" },
                      })
                      window.dispatchEvent(event)
                    }}
                  >
                    <Plus className="w-4 h-4 text-white" />
                  </div>
                  <div className="text-xs text-gray-600 dark:text-gray-400 font-medium px-2 py-1 bg-gray-50 dark:bg-gray-900/30 rounded mt-2">
                    Approved
                  </div>
                </div>
              )}

              {/* Rejected path plus button - positioned at 75% */}
              {!(data.rejectedPathUsed) && (
                <div className="absolute left-3/4 transform -translate-x-1/2 flex flex-col items-center cursor-pointer z-50 pointer-events-auto"
                  style={{ top: "calc(100% + 8px)" }}>
                  <div className="w-0.5 h-6 bg-gray-300 dark:bg-gray-600 mb-2"></div>
                  <div
                    className="bg-black hover:bg-gray-800 rounded-full flex items-center justify-center transition-colors shadow-lg"
                    style={{
                      width: "28px",
                      height: "28px",
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                      const event = new CustomEvent("openWhatHappensNext", {
                        detail: { nodeId: id, reviewPath: "rejected" },
                      })
                      window.dispatchEvent(event)
                    }}
                  >
                    <Plus className="w-4 h-4 text-white" />
                  </div>
                  <div className="text-xs text-gray-600 dark:text-gray-400 font-medium px-2 py-1 bg-gray-50 dark:bg-gray-900/30 rounded mt-2">
                    Rejected
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </>
    )
  }

  // Special rendering for trigger nodes and steps with trigger tools
  const hasTriggerTool = tools && tools.length > 0 && tools[0].type === "trigger"
  if (step.type === "trigger" || hasTriggerTool) {
    const isAwaitingTrigger = step.status === "active" && step.type === "trigger"
    
    return (
      <>
        <div
          className={`relative cursor-pointer hover:shadow-lg transition-all bg-white dark:bg-gray-800 border-2 ${
            selected 
              ? "border-gray-800 dark:border-gray-300 shadow-lg" 
              : isAwaitingTrigger
              ? "border-orange-400 dark:border-orange-300" 
              : "border-gray-300 dark:border-gray-600"
          }`}
          style={{
            width: "320px",
            minHeight: "122px",
            borderRadius: "12px",
            boxShadow: "0 0 0 2px #E2E2E2",
          }}
        >
          {/* Header with icon and title */}
          <div className="flex items-center gap-3 text-left w-full px-4 pt-4 mb-3">
            {/* Play/trigger icon with background */}
            <div 
              className={`w-10 h-10 flex items-center justify-center rounded-lg ${
                isAwaitingTrigger 
                  ? "bg-orange-500" 
                  : "bg-blue-500"
              }`}
            >
              <Play className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div 
                className={`text-base font-semibold truncate ${
                  isAwaitingTrigger 
                    ? "text-orange-900 dark:text-orange-100" 
                    : "text-gray-900 dark:text-gray-100"
                }`}
              >
                {step.name || "Manual Trigger"}
              </div>
              <div 
                className={`text-sm truncate ${
                  isAwaitingTrigger 
                    ? "text-orange-700 dark:text-orange-200" 
                    : "text-gray-600 dark:text-gray-400"
                }`}
              >
                {step.description || "Manual trigger step"}
              </div>
            </div>
          </div>

          {/* Status indicator for awaiting trigger */}
          {isAwaitingTrigger && (
            <div className="px-4 mb-3">
              <div className="flex items-center gap-2 px-3 py-2 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg">
                <Clock className="w-4 h-4 text-orange-500" />
                <span className="text-sm font-medium text-orange-700 dark:text-orange-300">
                  Waiting for trigger
                </span>
              </div>
            </div>
          )}

          {/* ReactFlow Handles */}
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
          {/* Bottom center connection point */}
          <div className="absolute -bottom-1.5 left-1/2 transform -translate-x-1/2">
            <div className="w-3 h-3 bg-gray-400 dark:bg-gray-500 rounded-full border-2 border-white dark:border-gray-900 shadow-sm"></div>
          </div>

          {/* PlusButton for adding next step (only if not awaiting trigger) */}
          {!isAwaitingTrigger && (
            <PlusButton
              hasNext={Boolean(data.hasNext)}
              nodeId={String(data.id)}
              isConnectable={isConnectable}
              showHandles={false}
            />
          )}
        </div>
      </>
    )
  }

  // Special rendering for script nodes and steps with script tools
  const hasScriptTool = tools && tools.length > 0 && tools[0].type === "script"
  if (step.type === "script" || hasScriptTool) {
    return (
      <>
        <div
          className={`relative cursor-pointer hover:shadow-lg transition-all bg-white dark:bg-gray-800 border-2 ${
            selected 
              ? "border-gray-800 dark:border-gray-300 shadow-lg" 
              : "border-gray-300 dark:border-gray-600"
          }`}
          style={{
            width: "320px",
            minHeight: "122px",
            borderRadius: "12px",
            boxShadow: "0 0 0 2px #E2E2E2",
          }}
        >
          {/* Header with icon and title */}
          <div className="flex items-center gap-3 text-left w-full px-4 pt-4 mb-3">
            {/* Green code icon with background */}
            <div
              className="flex justify-center items-center flex-shrink-0 bg-green-50 dark:bg-green-900/50"
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
              <svg
                width={16}
                height={16}
                viewBox="0 0 24 24"
                fill="none"
                stroke="#10B981"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="16 18 22 12 16 6"></polyline>
                <polyline points="8 6 2 12 8 18"></polyline>
              </svg>
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
              {(() => {
                // First try to get name from workflow_tools[index].val.language
                if (hasScriptTool && tools?.[0]?.val && typeof tools[0].val === 'object' && (tools[0].val as any)?.language) {
                  const language = (tools[0].val as any).language
                  return `${language.charAt(0).toUpperCase() + language.slice(1)} Script`
                }
                
                // Try to get name from workflow_tools[index].value.language
                if (hasScriptTool && tools?.[0] && (tools[0] as any)?.value && typeof (tools[0] as any).value === 'object' && (tools[0] as any).value?.language) {
                  const language = (tools[0] as any).value.language
                  return `${language.charAt(0).toUpperCase() + language.slice(1)} Script`
                }
                
                // Fallback to existing logic
                return step.name || "Script"
              })()}
            </h3>
          </div>

          {/* Full-width horizontal divider */}
          <div className="w-full h-px bg-gray-200 dark:bg-gray-600 mb-3"></div>

          {/* Description text */}
          <div className="px-4 pb-4">
            <p className="text-gray-600 dark:text-gray-300 text-sm leading-relaxed text-left break-words overflow-hidden">
              {(() => {
                // First try to get description from workflow_tools[index].val.description
                if (hasScriptTool && tools?.[0]?.val && typeof tools[0].val === 'object' && (tools[0].val as any)?.description) {
                  return (tools[0].val as any).description
                }
                
                // Try to get description from workflow_tools[index].value.description
                if (hasScriptTool && tools?.[0] && (tools[0] as any)?.value && typeof (tools[0] as any).value === 'object' && (tools[0] as any).value?.description) {
                  return (tools[0] as any).value.description
                }
                
                // Generate description based on language
                if (hasScriptTool && tools?.[0] && ((tools[0] as any)?.value?.language || (tools[0] as any)?.val?.language)) {
                  const language = (tools[0] as any)?.value?.language || (tools[0] as any)?.val?.language
                  return `Execute ${language} script with custom code`
                }
                
                // Fallback to step description or default
                return step.description || "Execute custom script code"
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
            <div className="w-3 h-3 bg-gray-400 dark:bg-gray-500 rounded-full border-2 border-white dark:border-gray-900 shadow-sm"></div>
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
            <div className="w-0.5 h-6 bg-gray-300 dark:bg-gray-600 mb-2"></div>
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
  onRefreshWorkflows,
  workflowName,
  selectedTemplate,
  onWorkflowNameChange,
  isEditable = true,
  onSaveChanges,
  isSaveDisabled = false,
  hasUnsavedChanges = false,
  onConfirmRefresh,
}: { 
  onBackToWorkflows?: () => void; 
  onRefreshWorkflows?: () => void;
  workflowName?: string;
  selectedTemplate?: WorkflowTemplate | null;
  onWorkflowNameChange?: (newName: string) => void;
  isEditable?: boolean;
  onSaveChanges?: () => void;
  isSaveDisabled?: boolean;
  hasUnsavedChanges?: boolean;
  onConfirmRefresh?: (callback: () => void) => void;
}) => {
  const [isEditing, setIsEditing] = useState(false)
  const [editingName, setEditingName] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const currentName = workflowName || selectedTemplate?.name || "Untitled Workflow"

  const handleClick = () => {
    if (!isEditable) return
    setEditingName(currentName)
    setIsEditing(true)
  }

  const handleSave = () => {
    if (editingName.trim() && editingName !== currentName) {
      onWorkflowNameChange?.(editingName.trim())
    }
    setIsEditing(false)
  }

  const handleCancel = () => {
    setEditingName("")
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSave()
    } else if (e.key === "Escape") {
      handleCancel()
    }
  }

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  return (
    <div className="flex items-center justify-between px-6 border-b border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-900 min-h-[80px]">
      {/* Breadcrumb */}
      <div className="text-slate-500 dark:text-gray-400 text-sm font-normal leading-5">
        <span
          className="cursor-pointer hover:text-slate-700 dark:hover:text-gray-300"
          onClick={() => {
            const handleRefresh = () => {
              onBackToWorkflows?.()
              onRefreshWorkflows?.()
            }
            
            // Check if we're in editable mode with unsaved changes
            if (isEditable && hasUnsavedChanges && onConfirmRefresh) {
              onConfirmRefresh(handleRefresh)
            } else {
              handleRefresh()
            }
          }}
        >
          Workflow
        </span>
        <span className="text-[#3B4145] dark:text-gray-300 text-sm font-medium leading-5">
          {" "}
          / {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              className="bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-2 py-0 outline-none focus:border-black dark:focus:border-white text-[#3B4145] dark:text-gray-300 text-sm font-medium w-60 h-6"
              placeholder="Enter workflow name"
              autoFocus
            />
          ) : (
            <span 
              className={isEditable 
                ? "cursor-pointer hover:text-[#1a1d20] dark:hover:text-gray-100 transition-colors px-2 py-1 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
                : "text-[#3B4145] dark:text-gray-300"
              }
              onClick={isEditable ? handleClick : undefined}
              title={isEditable ? "Click to edit workflow name" : undefined}
            >
              {currentName}
            </span>
          )}
        </span>
      </div>

      {/* Save Changes Button - only show in builder mode (create from blank) */}
      {onSaveChanges && isEditable && (
          <button
            onClick={onSaveChanges}
            disabled={isSaveDisabled}
            className={`px-6 py-2 text-sm font-medium rounded-full transition-all duration-200 ${
              isSaveDisabled
                ? "bg-gray-900 dark:bg-gray-700 text-white opacity-50 cursor-not-allowed"
                : "bg-gray-900 hover:bg-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 text-white opacity-100"
            }`}
          >
            Save Changes
          </button>
      )}
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
      className={`fixed top-[80px] right-0 h-[calc(100vh-80px)] bg-white border-l border-slate-200 flex flex-col overflow-hidden transition-all duration-300 ease-in-out z-40 ${
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

                {(tool as any).val && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-gray-600">
                      Tool Value
                    </h4>
                    <div className="text-xs text-gray-900 bg-gray-50 p-2 rounded max-h-20 overflow-y-auto">
                      <pre>
                        {typeof (tool as any).val === "object"
                          ? JSON.stringify((tool as any).val, null, 2)
                          : String((tool as any).val)}
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
      icon: <FileText size={20} />,
      enabled: true,
    },
    {
      id: "manual",
      name: "Trigger Manually",
      description:
        "Runs the flow when triggered manually. Good for getting started quickly",
      icon: <ManualTriggerIcon width={20} height={20} />,
      enabled: true,
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
      className={`fixed top-[80px] right-0 h-[calc(100vh-80px)] bg-white dark:bg-gray-900 border-l border-slate-200 dark:border-gray-700 flex flex-col overflow-hidden z-40 ${
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
  onRefreshWorkflows?: () => void
  selectedTemplate?: WorkflowTemplate | null
  isLoadingTemplate?: boolean
  isEditableMode?: boolean
  builder?: boolean // true for create mode, false for view mode
  onViewExecution?: (executionId: string, startPolling?: boolean) => void
}

// Internal component that uses ReactFlow hooks
const WorkflowBuilderInternal: React.FC<WorkflowBuilderProps> = ({
  onStepClick,
  onBackToWorkflows,
  onRefreshWorkflows,
  selectedTemplate,
  isLoadingTemplate,
  isEditableMode,
  builder = true, // Default to builder mode
  onViewExecution,
}) => {
  // Console log the builder prop value
  const [selectedNodes, setSelectedNodes] = useState<Node[]>([])
  const [nodeCounter, setNodeCounter] = useState(1)
  const [showEmptyCanvas, setShowEmptyCanvas] = useState(true)
  const [showTriggersSidebar, setShowTriggersSidebar] = useState(false)
  const [showWhatHappensNextUI, setShowWhatHappensNextUI] = useState(false)
  const [showAIAgentConfigUI, setShowAIAgentConfigUI] = useState(false)
  const [showEmailConfigUI, setShowEmailConfigUI] = useState(false)
  const [showOnFormSubmissionUI, setShowOnFormSubmissionUI] = useState(false)
  const [showReviewExecutionUI, setShowReviewExecutionUI] = useState(false)
  const [showTriggerExecutionUI, setShowTriggerExecutionUI] = useState(false)
  const [showScriptConfigUI, setShowScriptConfigUI] = useState(false)
  const [selectedNodeForNext, setSelectedNodeForNext] = useState<string | null>(
    null,
  )
  const [selectedReviewPath, setSelectedReviewPath] = useState<string | null>(
    null,
  )
  const [selectedAgentNodeId, setSelectedAgentNodeId] = useState<string | null>(
    null,
  )
  const [selectedEmailNodeId, setSelectedEmailNodeId] = useState<string | null>(
    null,
  )
  const [selectedScriptNodeId, setSelectedScriptNodeId] = useState<string | null>(
    null,
  )
  const [selectedFormNodeId, setSelectedFormNodeId] = useState<string | null>(
    null,
  )
  const [selectedReviewStepId, setSelectedReviewStepId] = useState<string | null>(
    null,
  )
  const [selectedTriggerStepId, setSelectedTriggerStepId] = useState<string | null>(
    null,
  )
  const [zoomLevel, setZoomLevel] = useState(100)
  const [showToolsSidebar, setShowToolsSidebar] = useState(false)
  const [selectedNodeTools] = useState<Tool[] | null>(
    null,
  )
  const [selectedNodeInfo] = useState<any>(null)
  const [showResultModal, setShowResultModal] = useState(false)
  const [selectedResult, setSelectedResult] = useState<any>(null)
  const [showExecutionModal, setShowExecutionModal] = useState(false)
  const [createdTemplate, setCreatedTemplate] = useState<WorkflowTemplate | null>(null)
  const [showTemplateSelectionModal, setShowTemplateSelectionModal] = useState(false)
  const [availableTemplates, setAvailableTemplates] = useState<WorkflowTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templatesError, setTemplatesError] = useState<string | null>(null)
  const [localSelectedTemplate, setLocalSelectedTemplate] = useState<WorkflowTemplate | null>(null)
  // Template workflow state (for creating the initial workflow)
  const [templateWorkflow] = useState<TemplateFlow | null>(
    null,
  )
  // Running workflow state (for real-time updates)
  const [, setIsPolling] = useState(false)
  const [pollingInterval, setPollingInterval] = useState<NodeJS.Timeout | null>(
    null,
  )
  // Workflow name state
  const [currentWorkflowName, setCurrentWorkflowName] = useState<string>("")
  // Snackbar state
  const [snackbarMessage, setSnackbarMessage] = useState<string>("")
  const [snackbarType, setSnackbarType] = useState<'success' | 'error' | 'warning' | 'info'>('info')
  const [showSnackbar, setShowSnackbar] = useState(false)
  // Save Changes button state
  const [isWorkflowSaved, setIsWorkflowSaved] = useState(false)
  const [hasWorkflowChanged, setHasWorkflowChanged] = useState(false)
  const [lastSavedHash, setLastSavedHash] = useState<string>("")
  // Confirmation popup state
  const [showConfirmationPopup, setShowConfirmationPopup] = useState(false)
  const [pendingRefreshCallback, setPendingRefreshCallback] = useState<(() => void) | null>(null)

  // Empty initial state
  const initialNodes: Node[] = []
  const initialEdges: Edge[] = []

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // Utility function to get tool ID from step ID
  const getToolIdFromStepId = useCallback((stepId: string): string | undefined => {
    const node = nodes.find((n) => n.id === stepId)
    const tools = node?.data?.tools as Tool[] | undefined
    return tools && tools.length > 0 ? tools[0]?.id : undefined
  }, [nodes])
  
  // Helper function to show snackbar messages
  const showSnackbarMessage = useCallback((message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info') => {
    setSnackbarMessage(message)
    setSnackbarType(type)
    setShowSnackbar(true)
  }, [])

  // Helper function to create a hash of the current workflow state
  // Excludes position coordinates and UI state to prevent save button activation on node drag or UI interactions
  const createWorkflowHash = () => {
    const workflowState = {
      nodes: nodes.map(node => ({
        id: node.id,
        type: node.type,
        // Exclude position from hash calculation
        data: {
          step: node.data?.step,
          tools: node.data?.tools,
          // Exclude UI state properties like hasNext, isActive, isCompleted, anyNodeSelected
        }
      })),
      edges: edges.map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.type
      }))
    }
    return JSON.stringify(workflowState)
  }

  // Helper function to get workflow name consistently across components
  const getWorkflowName = useCallback(() => {
    // If user has set a custom name, use it
    if (currentWorkflowName && currentWorkflowName.trim() !== "") {
      return currentWorkflowName
    }
    
    // If we have a selected template, use its name
    if (selectedTemplate?.name) {
      return selectedTemplate.name
    }
    
    // For blank workflows without a custom name, use "Untitled Workflow"
    if (!selectedTemplate && nodes.length > 0) {
      return "Untitled Workflow"
    }
    
    // Final fallback
    return "Untitled Workflow"
  }, [currentWorkflowName, selectedTemplate?.name, selectedTemplate, nodes.length])
  const { fitView, zoomTo, getViewport } = useReactFlow()

  // Smart fit view to show entire workflow with proper padding
  const smartFitWorkflow = useCallback(() => {
    setTimeout(() => {
      // Use fitView to show the entire workflow with extra bottom padding for + button
      fitView({
        padding: {
          top: 0.1,    // 10% padding at top
          right: 0.15, // 15% padding on sides
          bottom: 0.5, // 50% padding at bottom to ensure + button is fully visible
          left: 0.15   // 15% padding on sides
        },
        includeHiddenNodes: false,
        minZoom: 0.4, // Balanced minimum zoom for better workflow visibility
        maxZoom: 1.2, // Maximum zoom level to keep nodes readable
        duration: 600, // Smooth animation
      })
    }, 150) // Small delay to ensure the node is fully rendered
  }, [fitView])

  // Watch for nodes changes and smart fit the entire workflow
  const previousRealNodeCount = useRef(0)
  useEffect(() => {
    // Check if we have real workflow nodes (exclude trigger selector placeholder)
    const realNodes = nodes.filter(node => {
      const nodeData = node.data as any
      return nodeData?.step?.type !== "trigger_selector" && !nodeData?.isTriggerSelector
    })
    
    if (realNodes.length > previousRealNodeCount.current && realNodes.length > 0) {
      // Smart fit the entire workflow to keep everything visible for real nodes
      smartFitWorkflow()
    }
    previousRealNodeCount.current = realNodes.length
  }, [nodes, smartFitWorkflow])

  // Create nodes and edges from selectedTemplate or localSelectedTemplate
  useEffect(() => {
    const templateToUse = localSelectedTemplate || selectedTemplate
    if (
      templateToUse &&
      (templateToUse.steps || templateToUse.stepExecutions)
    ) {
      // Check if this is an execution (has stepExecutions) or template (has steps)
      const isExecution =
        templateToUse.stepExecutions &&
        Array.isArray(templateToUse.stepExecutions)
      const stepsData = isExecution
        ? templateToUse.stepExecutions
        : templateToUse.steps

      // Sort steps by step_order or creation order before creating nodes
      const sortedSteps = stepsData ? [...stepsData].sort((a, b) => {
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
      }) : []

      // Simple Parent-Based DFS Algorithm
      const performSimpleDFS = (steps: any[]) => {
        // Get the root step ID from template
        const rootStepId = templateToUse.rootWorkflowStepTemplateId
        console.log('Simple DFS - Root step ID:', rootStepId)
        
        if (!rootStepId) {
          console.error('No rootWorkflowStepTemplateId found in template')
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
          console.log(`Positioning ${nodeId}: (${x}, ${y}) - index: ${myIndex}/${siblingIds.length}`)
          
          // Find the current node
          const currentNode = steps.find(s => s.id === nodeId)
          if (!currentNode) {
            console.log(`Node ${nodeId} not found in steps`)
            return
          }
          
          // Get nextStepIds for this node
          const nextStepIds = currentNode.nextStepIds || []
          
          // Recurse for each child
          if (nextStepIds.length > 0) {
            console.log(`Node ${nodeId} has ${nextStepIds.length} children:`, nextStepIds)
            nextStepIds.forEach((childId: string, index: number) => {
              console.log(`Recursing into child ${index}: ${childId}`)
              dfs(childId, x, y, nextStepIds, index)
            })
          } else {
            console.log(`Node ${nodeId} is a leaf node`)
          }
        }
        
        // Start with root at (400, 100)
        console.log(`Starting simple DFS from root: ${rootStepId}`)
        nodePositions.set(rootStepId, { x: 400, y: 100 })
        
        // Start DFS for root's children
        const rootNode = steps.find(s => s.id === rootStepId)
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
        const position = nodePositions.get(step.id)
        if (position) {
          console.log(`Final position for ${step.id}: (${position.x}, ${position.y})`)
          return position
        }
        
        // Fallback for nodes not found in DFS (shouldn't happen)
        console.warn(`Node ${step.id} not found in DFS positions, using fallback`)
        return { x: 400, y: 100 }
      }

      // Create nodes from steps with DFS-based layout
      const templateNodes: Node[] = sortedSteps.map((step: any) => {
        // Find associated tools for this step
        let stepTools = []
        let toolExecutions: any[] = []


        if (isExecution) {
          // For executions, get tool executions from toolExecIds
          toolExecutions =
            templateToUse.toolExecutions?.filter((toolExec) =>
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
            templateToUse.workflow_tools?.filter((tool) =>
              step.toolIds?.includes(tool.id),
            ) || []
        }


        // Check if this is the last step (no nextStepIds or empty nextStepIds)
        const isLastStep = !step.nextStepIds || step.nextStepIds.length === 0
        const hasNextFlag = isLastStep

        // Check if this is a review step and set path usage flags
        let approvedPathUsed = false
        let rejectedPathUsed = false
        if (step.type === "manual" && stepTools.length > 0 && stepTools[0].type === "review") {
          const reviewTool = stepTools[0]
          const config = reviewTool.config || {}
          approvedPathUsed = !!config.approved
          rejectedPathUsed = !!config.rejected
        }

        const position = calculatePosition(step)
        
        return {
          id: step.id,
          type: "stepNode",
          position,
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
            approvedPathUsed,
            rejectedPathUsed,
          },
          draggable: true,
        }
      })

      // Create edges from nextStepIds
      const templateEdges: Edge[] = []
      stepsData?.forEach((step) => {
        step.nextStepIds?.forEach((nextStepId) => {
          // For executions, we need to map template step IDs to execution step IDs
          let targetStepId = nextStepId

          if (isExecution) {
            // Find the step execution that corresponds to this template step ID
            const targetStepExecution = stepsData?.find(
              (s: any) => s.workflowStepTemplateId === nextStepId,
            )
            if (targetStepExecution) {
              targetStepId = targetStepExecution.id
            }
          }

          // Determine sourceHandle based on step configuration
          let sourceHandle = "bottom"
          let edgeLabel = undefined
          let labelStyle = undefined
          let labelBgStyle = undefined
          
          // Check if source is a review step with approved/rejected paths
          if (step.type === "manual") {
            // Get tools for this step from workflow_tools (only for templates, not executions)
            const stepTools = !isExecution && (step as any).toolIds && templateToUse.workflow_tools
              ? templateToUse.workflow_tools.filter((tool) =>
                  (step as any).toolIds.includes(tool.id)
                ) 
              : []
            
            if (stepTools.length > 0 && stepTools[0].type === "review") {
              const reviewTool = stepTools[0]
              const config = reviewTool.config || {}
              
              if (config.approved === targetStepId) {
                sourceHandle = "approved"
                edgeLabel = "Approved"
              } else if (config.rejected === targetStepId) {
                sourceHandle = "rejected"
                edgeLabel = "Rejected"
              }
            }
            
            // Add label styling for review paths
            if (edgeLabel) {
              labelStyle = { 
                fill: '#6B7280', 
                fontWeight: 600, 
                fontSize: '12px',
                fontFamily: 'Inter, system-ui, sans-serif'
              }
              labelBgStyle = { 
                fill: '#FFFFFF', 
                fillOpacity: 0.9,
                stroke: '#E5E7EB',
                strokeWidth: 1,
                rx: 4
              }
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
            sourceHandle: sourceHandle,
            targetHandle: "top",
            label: edgeLabel,
            labelStyle: labelStyle,
            labelBgStyle: labelBgStyle,
          } as any)
        })
      })

      setNodes(templateNodes)
      setEdges(templateEdges)
      setNodeCounter((stepsData?.length || 0) + 1)
      setShowEmptyCanvas(false)

      // // Fix existing edges for review steps - update sourceHandle based on node configuration
      // setTimeout(() => {
      //   setEdges((prevEdges) => 
      //     prevEdges.map((edge) => {
      //       const sourceNode = templateNodes.find(n => n.id === edge.source)
      //       if (sourceNode && sourceNode.data && sourceNode.data.step && sourceNode.data.step.type === "review") {
      //         // Check if target is connected via approved or rejected path
      //         if (sourceNode.data.approved === edge.target) {
      //           return {
      //             ...edge,
      //             sourceHandle: "approved",
      //             label: "Approved",
      //             labelStyle: { 
      //               fill: '#6B7280', 
      //               fontWeight: 600, 
      //               fontSize: '12px',
      //               fontFamily: 'Inter, system-ui, sans-serif'
      //             },
      //             labelBgStyle: { 
      //               fill: '#FFFFFF', 
      //               fillOpacity: 0.9,
      //               stroke: '#E5E7EB',
      //               strokeWidth: 1,
      //               rx: 4
      //             }
      //           }
      //         } else if (sourceNode.data.rejected === edge.target) {
      //           return {
      //             ...edge,
      //             sourceHandle: "rejected",
      //             label: "Rejected",
      //             labelStyle: { 
      //               fill: '#6B7280', 
      //               fontWeight: 600, 
      //               fontSize: '12px',
      //               fontFamily: 'Inter, system-ui, sans-serif'
      //             },
      //             labelBgStyle: { 
      //               fill: '#FFFFFF', 
      //               fillOpacity: 0.9,
      //               stroke: '#E5E7EB',
      //               strokeWidth: 1,
      //               rx: 4
      //             }
      //           }
      //         }
      //       }
      //       return edge
      //     })
      //   )
      // }, 100)
      
      // Initialize current workflow name with template name
      if (!currentWorkflowName && templateToUse.name) {
        setCurrentWorkflowName(templateToUse.name)
      }

      // Reset save state when loading a template (existing workflow)
      setIsWorkflowSaved(true) // Template is already saved
      setHasWorkflowChanged(false) // No changes yet
      const initialHash = createWorkflowHash()
      setLastSavedHash(initialHash)

      setTimeout(() => {
        fitView({ padding: 0.2 })
      }, 50)
    }
  }, [selectedTemplate, localSelectedTemplate, setNodes, setEdges, fitView, currentWorkflowName, setCurrentWorkflowName])

  // Monitor workflow changes to enable/disable Save Changes button
  useEffect(() => {
    if (nodes.length > 0 || edges.length > 0) {
      const currentHash = createWorkflowHash()
      
      // Check if we have any actual workflow steps (not just trigger selector)
      const hasActualSteps = nodes.some(node => {
        const nodeData = node.data as any
        return nodeData?.step?.type && nodeData.step.type !== "trigger_selector"
      })
      
      if (lastSavedHash === "" && hasActualSteps) {
        // First time with nodes/edges and actual steps, mark as changed
        setHasWorkflowChanged(true)
        setIsWorkflowSaved(false)
      } else if (currentHash !== lastSavedHash && hasActualSteps) {
        // Workflow has changed since last save and has actual steps
        setHasWorkflowChanged(true)
        setIsWorkflowSaved(false)
      } else if (!hasActualSteps) {
        // No actual steps yet, keep disabled
        setHasWorkflowChanged(false)
        setIsWorkflowSaved(false)
      } else {
        // Workflow matches last saved state
        setHasWorkflowChanged(false)
      }
    } else {
      // No nodes/edges, reset state
      setHasWorkflowChanged(false)
      setIsWorkflowSaved(false)
    }
  }, [nodes, edges, lastSavedHash])

  const onConnect = useCallback(
    (params: Connection) => {
      const newEdge = {
        ...params,
        id: `${params.source}-${params.target}`,
        type: "smoothstep",
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
  }, [])

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      // Generic node click handler that opens appropriate sidebar based on tool type
      const step = node.data?.step as Step
      const tools = (node.data?.tools as Tool[]) || []

      if (!step) return

      // Don't allow clicking on the initial "Select trigger from the sidebar" node
      if (step.name === "Select trigger from the sidebar") {
        return
      }

      // Get the first tool to determine type
      const primaryTool = tools[0]
      const toolType = primaryTool?.type || step.type

      // Close menu sidebars when nodes are clicked
      setShowTriggersSidebar(false)
      setShowWhatHappensNextUI(false)
      
      // Close all node config sidebars and clear selected node IDs
      setShowAIAgentConfigUI(false)
      setShowEmailConfigUI(false)
      setShowOnFormSubmissionUI(false)
      setShowReviewExecutionUI(false)
      setShowTriggerExecutionUI(false)
      setShowScriptConfigUI(false)
      setSelectedNodeForNext(null)
      setSelectedAgentNodeId(null)
      setSelectedEmailNodeId(null)
      setSelectedFormNodeId(null)
      setSelectedReviewStepId(null)
      setSelectedTriggerStepId(null)
      setSelectedScriptNodeId(null)

      // Handle different tool types
      switch (toolType) {
        case "form":
          // Open Form config sidebar
          setSelectedFormNodeId(node.id)
          setShowOnFormSubmissionUI(true)
          break

        case "python_code":
        case "python_script":
          // Open What Happens Next sidebar for Python code configuration
          setSelectedNodeForNext(node.id)
          setShowWhatHappensNextUI(true)
          break

        case "email":
          // Open Email config sidebar
          setSelectedEmailNodeId(node.id)
          setShowEmailConfigUI(true)
          break

        case "ai_agent":
          // Open AI Agent config sidebar
          setSelectedAgentNodeId(node.id)
          setShowAIAgentConfigUI(true)
          break

        case "review":
          // Open Review execution sidebar
          setSelectedReviewStepId(step.id)
          setShowReviewExecutionUI(true)
          break
        case "trigger":
          // Open Trigger execution sidebar (only in execution mode)
          if (!builder) {
            setSelectedTriggerStepId(step.id)
            setShowTriggerExecutionUI(true)
          }
          // In builder mode, trigger nodes should not open any sidebar
          break
        case "script":
          // Open Script config sidebar
          setSelectedScriptNodeId(node.id)
          setShowScriptConfigUI(true)
          console.log("📜 Opening script config sidebar")
          break

        default:
          if (onStepClick) {
            onStepClick(step)
          }
          break
      }
    },
    [
      onStepClick, 
      showWhatHappensNextUI, 
      selectedNodeForNext,
      showAIAgentConfigUI,
      selectedAgentNodeId,
      showEmailConfigUI,
      selectedEmailNodeId,
      showOnFormSubmissionUI,
      selectedFormNodeId,
      showReviewExecutionUI,
      selectedReviewStepId
    ],
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
          type: "trigger_selector", // Special type to identify this node
        },
        isActive: false,
        isCompleted: false,
        isTriggerSelector: true, // Flag for immediate identification
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

  // Function to fetch available templates
  const fetchTemplates = useCallback(async () => {
    setTemplatesLoading(true)
    setTemplatesError(null)
    
    try {
      const response = await api.workflow.templates.$get()
      if (!response.ok) {
        throw new Error(`Failed to fetch templates: ${response.status} ${response.statusText}`)
      }
      
      const result = await response.json()
      if (result.success && result.data) {
        setAvailableTemplates(result.data)
      } else {
        throw new Error('Invalid response format')
      }
    } catch (error) {
      console.error('Error fetching templates:', error)
      setTemplatesError(error instanceof Error ? error.message : 'Failed to fetch templates')
      setAvailableTemplates([])
    } finally {
      setTemplatesLoading(false)
    }
  }, [])

  const startWithTemplate = useCallback(async () => {
    // Fetch templates and open the selection modal
    setShowTemplateSelectionModal(true)
    await fetchTemplates()
  }, [fetchTemplates])

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
      const { nodeId, reviewPath } = event.detail

      // Close all other sidebars when What Happens Next opens
      setShowTriggersSidebar(false)
      setShowAIAgentConfigUI(false)
      setShowEmailConfigUI(false)
      setShowOnFormSubmissionUI(false)
      setShowScriptConfigUI(false)
      
      // Open What Happens Next sidebar
      setSelectedNodeForNext(nodeId)
      setShowWhatHappensNextUI(true)
      
      // Store the review path for conditional step creation
      setSelectedReviewPath(reviewPath || null)
    }

    const handleOpenTriggersSidebar = (event: CustomEvent) => {
      // Close all other sidebars
      setShowWhatHappensNextUI(false)
      setShowAIAgentConfigUI(false)
      setShowEmailConfigUI(false)
      setShowOnFormSubmissionUI(false)
      setShowScriptConfigUI(false)
      
      // Open Triggers sidebar
      setShowTriggersSidebar(true)
    }

    window.addEventListener(
      "openWhatHappensNext" as any,
      handleOpenWhatHappensNext,
    )

    window.addEventListener(
      "openTriggersSidebar" as any,
      handleOpenTriggersSidebar,
    )

    return () => {
      window.removeEventListener(
        "openWhatHappensNext" as any,
        handleOpenWhatHappensNext,
      )
      window.removeEventListener(
        "openTriggersSidebar" as any,
        handleOpenTriggersSidebar,
      )
    }
  }, [])

  // Update all nodes with anyNodeSelected flag
  useEffect(() => {
    const anySelected = selectedNodes.length > 0
    setNodes((prevNodes) => 
      prevNodes.map(node => ({
        ...node,
        data: {
          ...node.data,
          anyNodeSelected: anySelected
        }
      }))
    )
  }, [selectedNodes, setNodes])

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

        // Check if workflow is completed or failed to stop polling
        if (statusData.success) {
          if (statusData.status === "completed") {
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

        // Handle response similar to execution modal
        console.log("🔍 Full execution response:", response)
        
        if (response.error || response.status === "error") {
          console.error("Execution failed:", response.error || response.message)
          throw new Error(response.error || response.message || "Execution failed")
        } else {
          // Extract execution ID from response (API handler strips success wrapper)
          const executionId = response.execution?.id
          
          console.log("🔍 Extracted execution ID:", executionId)
          console.log("🔍 Response structure:", {
            hasData: !!response.data,
            hasExecution: !!response.data?.execution,
            hasDirectId: !!response.id,
            responseKeys: Object.keys(response)
          })

          if (executionId) {
            // Navigate to execution UI and start polling for new execution
            if (onViewExecution) {
              onViewExecution(executionId, true) // true = start polling
            }
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
      // Check if we have nodes to create a workflow
      if (nodes.length === 0) {
        throw new Error("Cannot execute workflow: No workflow steps defined. Please add at least one step to your workflow.")
      }

      // Check if we already have a saved template
      const currentTemplate = createdTemplate || selectedTemplate
      if(selectedTemplate ) {
        console.log("Selected Template at execution time:", selectedTemplate)
      }
      else if (createdTemplate) {
        console.log("Created Template at execution time:", createdTemplate)
      }
      
      if (currentTemplate && currentTemplate.id && currentTemplate.id !== 'pending-creation') {
        // Check if the root node requires a form (file upload)
        const requiresForm = (() => {
          // Find the root step using rootWorkflowStepTemplateId
          const rootStep = currentTemplate.steps?.find(step => 
            step.id === currentTemplate.rootWorkflowStepTemplateId
          )
          
          if (!rootStep || rootStep.type !== "manual") {
            return false
          }
          
          // Check if the root step has a form tool
          if (rootStep.toolIds && rootStep.toolIds.length > 0) {
            const rootStepTools = currentTemplate.workflow_tools?.filter(tool => 
              rootStep.toolIds?.includes(tool.id)
            )
            
            return rootStepTools?.some(tool => tool.type === "form") || false
          }
        console.log("RootStep Type",rootStep,"Tool Type",currentTemplate.rootStep)
        console.log("Current Template at execution time:", currentTemplate)
          
          return false
        })()
        
        if (requiresForm) {
          // Show upload modal for workflows that require form data
          setShowExecutionModal(true)
        } else {
          // Execute directly without form data for other workflow types
          try {
            const formData: Record<string, any> = {
              name: `${currentTemplate?.name || "Workflow"} - ${new Date().toLocaleString()}`,
              description: `Execution of ${currentTemplate?.name || "workflow"}`,
            }

            const executionData = {
              name: formData.name,
              description: formData.description,
              formData: formData,
            }
            
            const response = await workflowExecutionsAPI.executeTemplate(
              currentTemplate.id,
              executionData,
            )

            console.log("🔍 Full execution response (direct):", response)
            
            if (response.error || response.status === "error") {
              console.error("Execution failed:", response.error || response.message)
              throw new Error(response.error || response.message || "Execution failed")
            } else {
              // Extract execution ID from response (API handler strips success wrapper)
              const executionId = response.execution?.id
              
              console.log("🔍 Extracted execution ID (direct):", executionId)
              console.log("🔍 Response structure (direct):", {
                hasData: !!response.data,
                hasExecution: !!response.data?.execution,
                hasDirectId: !!response.id,
                responseKeys: Object.keys(response)
              })
              
              if (executionId) {
                // Navigate to execution UI and start polling for new execution
                if (onViewExecution) {
                  onViewExecution(executionId, true) // true = start polling
                }
                showSnackbarMessage("Workflow execution started successfully!", 'success')
              } else {
                console.warn("No execution ID found in response")
              }
            }
          } catch (error) {
            console.error("Execution error:", error)
            showSnackbarMessage(`Failed to execute workflow: ${error instanceof Error ? error.message : "Unknown error"}`, 'error')
          }
        }
        return
      }

      // If no saved template exists, show snackbar message instead of throwing error
      showSnackbarMessage(
        "Cannot execute workflow: No saved template found. Please save the workflow first using the 'Save Changes' button.",
        'warning'
      )
    }
  }, [nodes, edges, templateWorkflow, selectedTemplate, createdTemplate, onViewExecution, getWorkflowName, showSnackbarMessage])

  const handleTriggerClick = useCallback(
    (triggerId: string) => {
      if (triggerId === "form") {
        // Close TriggersSidebar with slide-out animation when OnFormSubmissionUI opens
        setShowTriggersSidebar(false)
        setSelectedFormNodeId("pending") // Temporary ID to indicate we're in creation mode
        setShowOnFormSubmissionUI(true)
        setShowEmptyCanvas(false) // Hide empty canvas since we're configuring

        // Reset zoom to 100%
        setZoomLevel(100)
        setTimeout(() => {
          zoomTo(1)
        }, 50)
      } else if (triggerId === "manual") {
        // Create a manual trigger node directly
        setShowTriggersSidebar(false)
        
        // Create the trigger tool
        const triggerTool = {
          id: "tool-1",
          type: "trigger",
          value: {
            title: "Manual Trigger",
            description: "Click trigger button to continue workflow execution"
          },
          config: {}
        }
        
        // Create new trigger node
        const triggerNode: Node = {
          id: "1",
          type: "stepNode",
          position: { x: 400, y: 100 },
          data: {
            id: "1", // Add id for PlusButton compatibility
            step: {
              id: "1",
              name: "Manual Trigger",
              status: "pending",
              contents: [],
              type: "trigger",
              prevStepIds: [],
            },
            tools: [triggerTool],
            isActive: false,
            isCompleted: false,
            hasNext: true,
          },
          draggable: true,
        }

        // Update the existing trigger selector node to be the actual trigger node
        setNodes([triggerNode])
        setShowEmptyCanvas(false)
        setZoomLevel(100)
        setTimeout(() => {
          zoomTo(1)
        }, 50)
      }
      // Handle other triggers here as needed
    },
    [zoomTo, setNodes],
  )


  const handleWhatHappensNextAction = useCallback(async (actionId: string) => {
    if (actionId === "ai_agent") {
      // When AI Agent is selected from WhatHappensNextUI, keep it visible in background
      if (selectedNodeForNext) {
        // Keep selectedNodeForNext for later node creation on save
        setSelectedAgentNodeId("pending") // Temporary ID to indicate we're in creation mode
        setShowAIAgentConfigUI(true)
        // Note: Keep WhatHappensNextUI visible in background (z-40)
        // Don't close WhatHappensNextUI - let it stay visible behind the node sidebar
      }
    } else if (actionId === "email") {
      // When Email is selected from WhatHappensNextUI, keep it visible in background
      if (selectedNodeForNext) {
        // Keep selectedNodeForNext for later node creation on save
        setSelectedEmailNodeId("pending") // Temporary ID to indicate we're in creation mode
        setShowEmailConfigUI(true)
        // Note: Keep WhatHappensNextUI visible in background (z-40)
        // Don't close WhatHappensNextUI - let it stay visible behind the node sidebar
      }
    } else if (actionId === "review") {
      // When Review is selected from WhatHappensNextUI, create the review step directly
      if (selectedNodeForNext) {
        const sourceNode = nodes.find((n) => n.id === selectedNodeForNext)
        if (sourceNode) {
          const newNodeId = `review-${nodeCounter}`
          
          // Create the review tool
          const reviewTool = {
            id: `tool-${newNodeId}`,
            type: "review",
            value: {
              title: "Review Step",
              description: "Please review the previous step and either approve or reject it"
            },
            config: {
              review_options: ["approved", "rejected"],
              approved: null, // UUID of step connected to approved path
              rejected: null  // UUID of step connected to rejected path
            }
          }
          
          // Create new review node positioned below the source node
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
                name: "Review Step",
                description: "Manual review step for approval/rejection",
                type: "manual",
                status: "pending",
                contents: [],
                config: reviewTool.config,
              },
              tools: [reviewTool],
              isActive: false,
              isCompleted: false,
              hasNext: true, // Show + button on new step
              approvedPathUsed: false, // Initialize path tracking flags
              rejectedPathUsed: false,
            },
            draggable: true,
          }

          // Create edge connecting source to new node
          const newEdge = {
            id: `${selectedNodeForNext}-${newNodeId}`,
            source: selectedNodeForNext,
            target: newNodeId,
            type: "smoothstep",
            animated: false,
            style: {
              stroke: "#94a3b8",
              strokeWidth: 2,
            },
          }

          // Add the new node and edge, and update source node to remove plus button
          setNodes((prevNodes) => 
            prevNodes.map(node => 
              node.id === selectedNodeForNext 
                ? { ...node, data: { ...node.data, hasNext: false } }
                : node
            ).concat(newNode)
          )
          setEdges((prevEdges) => [...prevEdges, newEdge])
          setNodeCounter((prev) => prev + 1)

          // Close WhatHappensNextUI and clear selection
          setShowWhatHappensNextUI(false)
          setSelectedNodeForNext(null)

          // Auto-fit the workflow to show the new step
          setTimeout(() => {
            smartFitWorkflow()
          }, 50)
        }

      }


        

    } else if (actionId === "run_script") {
      // When Run Script is selected from WhatHappensNextUI, keep it visible in background
      if (selectedNodeForNext) {
        // Keep selectedNodeForNext for later node creation on save
        setSelectedScriptNodeId("pending") // Temporary ID to indicate we're in creation mode
        setShowScriptConfigUI(true)
        // Note: Keep WhatHappensNextUI visible in background (z-40)
        // Don't close WhatHappensNextUI - let it stay visible behind the node sidebar
      }
    }
  }, [selectedNodeForNext, nodes, nodeCounter, setNodes, setEdges, setNodeCounter, smartFitWorkflow, zoomTo])

  const handleAIAgentConfigBack = useCallback(() => {
    setShowAIAgentConfigUI(false)
    
    // If we're in creation mode (pending), go back to the "What Happens Next" menu
    if (selectedAgentNodeId === "pending" && selectedNodeForNext) {
      // Ensure WhatHappensNextUI is visible when we go back
      setShowWhatHappensNextUI(true)
      setSelectedAgentNodeId(null)
    } else {
      // If we're editing an existing node, just close the sidebar
      setSelectedAgentNodeId(null)
      setSelectedNodeForNext(null)
      // Clear all node selections when sidebar closes
      setNodes((prevNodes) => 
        prevNodes.map(node => ({ ...node, selected: false }))
      )
      setSelectedNodes([])
    }
  }, [selectedAgentNodeId, selectedNodeForNext, setNodes])

  const handleAIAgentConfigSave = useCallback(
    (agentConfig: AIAgentConfig) => {
      console.log(`handleAIAgentConfigSave called:`, {
        selectedAgentNodeId,
        selectedNodeForNext,
        agentConfig
      })
      
      if (selectedAgentNodeId === "pending" && selectedNodeForNext) {
        // Create new AI Agent node when saving configuration
        const sourceNode = nodes.find((n) => n.id === selectedNodeForNext)
        if (sourceNode) {
          const newNodeId = `ai-agent-${nodeCounter}`
          
          // Check if the source node is a review step and determine the connection path
          let sourceHandle = "bottom"
          let edgeLabel = undefined
          let reviewPath = null
          
          if (sourceNode?.data?.tools && Array.isArray(sourceNode.data.tools)) {
            const reviewTool = sourceNode.data.tools.find((tool: any) => tool.type === "review")
            if (reviewTool) {
              // This is a review step - determine which path to use based on current usage
              const config = reviewTool.config || {}
              console.log("Found review step with config:", config)
              
              // Use approved path if it's not used, otherwise use rejected path
              if (!config.approved) {
                sourceHandle = "approved"
                edgeLabel = "Approved"
                reviewPath = "approved"
              } else if (!config.rejected) {
                sourceHandle = "rejected" 
                edgeLabel = "Rejected"
                reviewPath = "rejected"
              } else {
                console.warn("Both approved and rejected paths are already used for review step:", selectedNodeForNext)
              }
            }
          }
          
          // Use description as-is without model information
          const formattedDescription = agentConfig.description
            ? agentConfig.description
            : "AI agent to analyze and summarize documents"

          // Create the tool object for AI Agent
          const aiAgentTool = {
            id: `tool-${newNodeId}`,
            type: "ai_agent",
            val: agentConfig, // Use 'val' to match template structure
            value: agentConfig, // Also include 'value' for compatibility
            config: {
              model: agentConfig.model,
              name: agentConfig.name,
              description: formattedDescription,
              to_email: [],
            },
          }

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
                name: agentConfig.name,
                description: formattedDescription,
                type: "ai_agent",
                status: "pending",
                contents: [],
                config: {
                  ...agentConfig,
                  description: formattedDescription,
                },
              },
              tools: [aiAgentTool],
              isActive: false,
              isCompleted: false,
              hasNext: true, // Show + button on new step
            },
            draggable: true,
            selected: true, // Select the newly created node
          }

          // Create edge connecting source to new node
          const newEdge = {
            id: `${selectedNodeForNext}-${newNodeId}`,
            source: selectedNodeForNext,
            target: newNodeId,
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
              type: "arrowclosed" as const,
              color: "#D1D5DB",
            },
            sourceHandle: sourceHandle,
            targetHandle: "top",
            label: edgeLabel,
            labelStyle: edgeLabel ? { 
              fill: '#6B7280', 
              fontWeight: 600, 
              fontSize: '12px',
              fontFamily: 'Inter, system-ui, sans-serif'
            } : undefined,
            labelBgStyle: edgeLabel ? { 
              fill: '#FFFFFF', 
              fillOpacity: 0.9,
              stroke: '#E5E7EB',
              strokeWidth: 1,
              rx: 4
            } : undefined,
          } as any

          // Update nodes and edges
          setNodes((prevNodes) => [...prevNodes, newNode])
          setEdges((prevEdges) => [...prevEdges, newEdge])
          setNodeCounter((prev) => prev + 1)

          // Update the review step's config if this was from a review step
          if (reviewPath) {
            setNodes((prevNodes) =>
              prevNodes.map((node) =>
                node.id === selectedNodeForNext
                  ? {
                      ...node,
                      data: {
                        ...node.data,
                        hasNext: false,
                        // Mark review path as used
                        ...(reviewPath === "approved" ? { approvedPathUsed: true } : {}),
                        ...(reviewPath === "rejected" ? { rejectedPathUsed: true } : {}),
                        // Update tool config if this is a review step
                        tools: (node.data.tools && Array.isArray(node.data.tools)) ? node.data.tools.map((tool: any) => 
                          tool.type === "review" ? {
                            ...tool,
                            config: {
                              ...tool.config,
                              ...(reviewPath === "approved" ? { approved: newNodeId } : {}),
                              ...(reviewPath === "rejected" ? { rejected: newNodeId } : {}),
                            }
                          } : tool
                        ) : node.data.tools,
                      },
                      selected: false, // Deselect source node
                    }
                  : node.id === newNodeId
                    ? node // Keep new node selected
                    : { ...node, selected: false }, // Deselect all other nodes
              ),
            )
          } else {
            // If not from a review step, still need to update hasNext for source node
            setNodes((prevNodes) =>
              prevNodes.map((node) =>
                node.id === selectedNodeForNext
                  ? {
                      ...node,
                      data: {
                        ...node.data,
                        hasNext: false, // Remove plus button from source node
                      },
                      selected: false, // Deselect source node
                    }
                  : node.id === newNodeId
                    ? node // Keep new node selected
                    : { ...node, selected: false }, // Deselect all other nodes
              ),
            )
          }
        }
      } else if (selectedAgentNodeId && selectedAgentNodeId !== "pending") {
        // Update existing AI Agent node with the configuration
        const formattedDescription = agentConfig.description
          ? agentConfig.description
          : "AI agent to analyze and summarize documents"

        const aiAgentTool = {
          id: getToolIdFromStepId(selectedAgentNodeId),
          type: "ai_agent",
          val: agentConfig,
          value: agentConfig,
          config: {
            model: agentConfig.model,
            name: agentConfig.name,
            description: formattedDescription,
            to_email: [],
          },
        }

        setNodes((nds) =>
          nds.map((node) =>
            node.id === selectedAgentNodeId
              ? {
                  ...node,
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
                    tools: [aiAgentTool],
                    hasNext: !edges.some(edge => edge.source === selectedAgentNodeId),
                  },
                }
              : node,
          ),
        )
      }

      // Reset zoom and auto-fit workflow after saving configuration
      setZoomLevel(100)
      setTimeout(() => {
        smartFitWorkflow()
      }, 50)

      setShowAIAgentConfigUI(false)
      setSelectedAgentNodeId(null)
      setSelectedNodeForNext(null)
      setSelectedReviewPath(null)
    },
    [selectedAgentNodeId, selectedNodeForNext, edges, nodes, setNodes, setEdges, nodeCounter, setNodeCounter, smartFitWorkflow, selectedReviewPath],
  )

  const handleEmailConfigBack = useCallback(() => {
    setShowEmailConfigUI(false)
    
    // If we're in creation mode (pending), go back to the "What Happens Next" menu
    if (selectedEmailNodeId === "pending" && selectedNodeForNext) {
      // Ensure WhatHappensNextUI is visible when we go back
      setShowWhatHappensNextUI(true)
      setSelectedEmailNodeId(null)
    } else {
      // If we're editing an existing node, just close the sidebar
      setSelectedEmailNodeId(null)
      setSelectedNodeForNext(null)
      // Clear all node selections when sidebar closes
      setNodes((prevNodes) => 
        prevNodes.map(node => ({ ...node, selected: false }))
      )
      setSelectedNodes([])
    }
  }, [selectedEmailNodeId, selectedNodeForNext, setNodes])

  const handleEmailConfigSave = useCallback(
    (emailConfig: EmailConfig) => {
      if (selectedEmailNodeId === "pending" && selectedNodeForNext) {
        // Create new Email node when saving configuration
        const sourceNode = nodes.find((n) => n.id === selectedNodeForNext)
        if (sourceNode) {
          const newNodeId = `email-${nodeCounter}`
          
          // Check if the source node is a review step and determine the connection path
          let sourceHandle = "bottom"
          let edgeLabel = undefined
          let reviewPath = null
          
          if (sourceNode?.data?.tools && Array.isArray(sourceNode.data.tools)) {
            const reviewTool = sourceNode.data.tools.find((tool: any) => tool.type === "review")
            if (reviewTool) {
              // This is a review step - determine which path to use based on current usage
              const config = reviewTool.config || {}
              console.log("Found review step with config:", config)
              
              // Use approved path if it's not used, otherwise use rejected path
              if (!config.approved) {
                sourceHandle = "approved"
                edgeLabel = "Approved"
                reviewPath = "approved"
              } else if (!config.rejected) {
                sourceHandle = "rejected" 
                edgeLabel = "Rejected"
                reviewPath = "rejected"
              } else {
                console.warn("Both approved and rejected paths are already used for review step:", selectedNodeForNext)
              }
            }
          }
          
          // Create the tool object for Email
          const emailTool = {
            id: `tool-${newNodeId}`,
            type: "email",
            val: emailConfig, // Use 'val' to match template structure
            value: emailConfig, // Also include 'value' for compatibility
            config: {
              to_email: emailConfig.emailAddresses,
              from_email: emailConfig.sendingFrom,
              sendingFrom: emailConfig.sendingFrom,
              emailAddresses: emailConfig.emailAddresses,
            },
          }

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
                name: "Email",
                type: "email",
                status: "pending",
                contents: [],
                config: {
                  sendingFrom: emailConfig.sendingFrom,
                  emailAddresses: emailConfig.emailAddresses,
                },
              },
              tools: [emailTool],
              isActive: false,
              isCompleted: false,
              hasNext: true, // Show + button on new step
            },
            draggable: true,
            selected: true, // Select the newly created node
          }

          // Create edge connecting source to new node
          const newEdge = {
            id: `${selectedNodeForNext}-${newNodeId}`,
            source: selectedNodeForNext,
            target: newNodeId,
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
              type: "arrowclosed" as const,
              color: "#D1D5DB",
            },
            sourceHandle: sourceHandle,
            targetHandle: "top",
            label: edgeLabel,
            labelStyle: edgeLabel ? { 
              fill: '#6B7280', 
              fontWeight: 600, 
              fontSize: '12px',
              fontFamily: 'Inter, system-ui, sans-serif'
            } : undefined,
            labelBgStyle: edgeLabel ? { 
              fill: '#FFFFFF', 
              fillOpacity: 0.9,
              stroke: '#E5E7EB',
              strokeWidth: 1,
              rx: 4
            } : undefined,
          } as any

          // Update nodes and edges
          setNodes((prevNodes) => [...prevNodes, newNode])
          setEdges((prevEdges) => [...prevEdges, newEdge])
          setNodeCounter((prev) => prev + 1)

          // Update the review step's config if this was from a review step
          if (reviewPath) {
            setNodes((prevNodes) =>
              prevNodes.map((node) =>
                node.id === selectedNodeForNext
                  ? {
                      ...node,
                      data: {
                        ...node.data,
                        hasNext: false,
                        // Mark review path as used
                        ...(reviewPath === "approved" ? { approvedPathUsed: true } : {}),
                        ...(reviewPath === "rejected" ? { rejectedPathUsed: true } : {}),
                        // Update tool config if this is a review step
                        tools: (node.data.tools && Array.isArray(node.data.tools)) ? node.data.tools.map((tool: any) => 
                          tool.type === "review" ? {
                            ...tool,
                            config: {
                              ...tool.config,
                              ...(reviewPath === "approved" ? { approved: newNodeId } : {}),
                              ...(reviewPath === "rejected" ? { rejected: newNodeId } : {}),
                            }
                          } : tool
                        ) : node.data.tools,
                      },
                      selected: false, // Deselect source node
                    }
                  : node.id === newNodeId
                    ? node // Keep new node selected
                    : { ...node, selected: false }, // Deselect all other nodes
              ),
            )
          } else {
            // If not from a review step, still need to update hasNext for source node
            setNodes((prevNodes) =>
              prevNodes.map((node) =>
                node.id === selectedNodeForNext
                  ? {
                      ...node,
                      data: {
                        ...node.data,
                        hasNext: false, // Remove plus button from source node
                      },
                      selected: false, // Deselect source node
                    }
                  : node.id === newNodeId
                    ? node // Keep new node selected
                    : { ...node, selected: false }, // Deselect all other nodes
              ),
            )
          }
        }
      } else if (selectedEmailNodeId && selectedEmailNodeId !== "pending") {
        // Update existing Email node with the configuration
        const emailTool = {
          id: getToolIdFromStepId(selectedEmailNodeId),
          type: "email",
          val: emailConfig,
          value: emailConfig,
          config: {
            to_email: emailConfig.emailAddresses,
            from_email: emailConfig.sendingFrom,
            sendingFrom: emailConfig.sendingFrom,
            emailAddresses: emailConfig.emailAddresses,
          },
        }

        setNodes((nds) =>
          nds.map((node) =>
            node.id === selectedEmailNodeId
              ? {
                  ...node,
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
                    tools: [emailTool],
                    hasNext: !edges.some(edge => edge.source === selectedEmailNodeId),
                  },
                }
              : node,
          ),
        )
      }

      // Reset zoom and auto-fit workflow after saving configuration
      setZoomLevel(100)
      setTimeout(() => {
        smartFitWorkflow()
      }, 50)

      setShowEmailConfigUI(false)
      setSelectedEmailNodeId(null)
      setSelectedNodeForNext(null)
      setSelectedReviewPath(null)
    },
    [selectedEmailNodeId, selectedNodeForNext, edges, nodes, setNodes, setEdges, nodeCounter, setNodeCounter, smartFitWorkflow, selectedReviewPath],
  )

  const handleReviewConfigSave = useCallback(
    (emailConfig: ReviewEmailConfig) => {
      console.log(`handleReviewConfigSave called:`, {
        selectedReviewStepId,
        emailConfig,
      })

      if (selectedReviewStepId) {
        // Update existing review step's tool configuration
        const updatedNodes = nodes.map((node) => {
          if (node.id === selectedReviewStepId || 
              (node.data?.step && (node.data.step as any).id === selectedReviewStepId)) {
            console.log("Updating review node:", node.id, "with email config:", emailConfig)
            
            return {
              ...node,
              data: {
                ...node.data,
                tools: Array.isArray(node.data?.tools) ? node.data.tools.map((tool: any) => {
                  if (tool.type === "review") {
                    return {
                      ...tool,
                      config: {
                        ...tool.config,
                        email_addresses: emailConfig.email_addresses,
                        email_message: emailConfig.email_message,
                      }
                    }
                  }
                  return tool
                }) : [{
                  type: "review",
                  config: {
                    email_addresses: emailConfig.email_addresses,
                    email_message: emailConfig.email_message,
                  }
                }]
              }
            }
          }
          return node
        })

        setNodes(updatedNodes)
        
        // Close the sidebar
        setShowReviewExecutionUI(false)
        setSelectedReviewStepId(null)
        
        console.log("Review configuration saved successfully")
      }
    },
    [selectedReviewStepId, nodes, setNodes],
  )

  const handleOnFormSubmissionBack = useCallback(() => {
    setShowOnFormSubmissionUI(false)
    
    // If we're in creation mode (pending), go back to triggers sidebar
    if (selectedFormNodeId === "pending") {
      setShowTriggersSidebar(true)
      setSelectedFormNodeId(null)
      // If we were in pending mode (creating new trigger), show empty canvas again
      if (nodes.length === 0) {
        setShowEmptyCanvas(true)
      }
    } else {
      // If we're editing an existing node, just close the sidebar
      setSelectedFormNodeId(null)
      // Clear all node selections when sidebar closes
      setNodes((prevNodes) => 
        prevNodes.map(node => ({ ...node, selected: false }))
      )
      setSelectedNodes([])
    }
  }, [selectedFormNodeId, nodes.length, setNodes])

  const handleOnFormSubmissionSave = useCallback(
    (formConfig: FormConfig) => {
      if (selectedFormNodeId === "pending") {
        // Create new form submission node when saving configuration
        const newNodeId = "form-submission"
        
        // Create the tool object for Form
        const formTool = {
          id: `tool-${newNodeId}`,
          type: "form",
          val: formConfig, // Use 'val' to match template structure
          value: formConfig, // Also include 'value' for compatibility
          config: {
            title: formConfig.title,
            description: formConfig.description,
            fields: formConfig.fields,
          },
        }

        // Create form submission node
        const formNode: Node = {
          id: newNodeId,
          type: "stepNode",
          position: { x: 400, y: 100 }, // Consistent X position for straight line connections
          data: {
            step: {
              id: newNodeId,
              name: formConfig.title || "Form Submission",
              status: "PENDING",
              contents: [],
              type: "form_submission",
              config: formConfig,
            },
            tools: [formTool],
            isActive: false,
            isCompleted: false,
            hasNext: true, // Show + icon since this is the starting node
            anyNodeSelected: false,
          },
          draggable: true,
          selectable: true,
          selected: true, // Select the newly created node
        }

        setNodes([formNode])
        setNodeCounter(2)
        setSelectedNodes([formNode]) // Update selectedNodes for the anyNodeSelected flag

      } else if (selectedFormNodeId && selectedFormNodeId !== "pending") {
        // Update existing form submission node
        const formTool = {
          id: getToolIdFromStepId(selectedFormNodeId),
          type: "form",
          val: formConfig,
          value: formConfig,
          config: {
            title: formConfig.title,
            description: formConfig.description,
            fields: formConfig.fields,
          },
        }

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
                    tools: [formTool],
                    hasNext: !edges.some(edge => edge.source === selectedFormNodeId),
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
        smartFitWorkflow()
      }, 50)
    },
    [selectedFormNodeId, setNodes, setNodeCounter, setSelectedNodes, smartFitWorkflow, edges],
  )

  const handleResultClick = useCallback((result: any) => {
    setSelectedResult(result)
    setShowResultModal(true)
  }, [])

  const handleResultModalClose = useCallback(() => {
    setShowResultModal(false)
    setSelectedResult(null)
  }, [])

  const handleTemplateSelect = useCallback(async (template: any) => {
    // Find the full template data from availableTemplates
    const fullTemplate = availableTemplates.find(t => t.id === template.id)
    if (fullTemplate) {
      try {
        // Fetch detailed template data including steps and tools
        const response = await api.workflow.templates[fullTemplate.id].$get()
        if (response.ok) {
          const result = await response.json()
          if (result.success && result.data) {
            // Set the detailed template which will trigger the useEffect to create nodes
            setLocalSelectedTemplate(result.data)
          } else {
            console.error('Failed to get detailed template data')
            setLocalSelectedTemplate(fullTemplate)
          }
        } else {
          console.error('Failed to fetch detailed template')
          setLocalSelectedTemplate(fullTemplate)
        }
      } catch (error) {
        console.error('Error fetching detailed template:', error)
        setLocalSelectedTemplate(fullTemplate)
      }
      
      // Also trigger a custom event that the parent component can listen to (optional)
      const event = new CustomEvent('templateSelected', { detail: fullTemplate })
      window.dispatchEvent(event)
    }
    
    setShowTemplateSelectionModal(false)
  }, [availableTemplates])

  const handleTemplateModalClose = useCallback(() => {
    setShowTemplateSelectionModal(false)
  }, [])


  // Handler for workflow name change
  const handleWorkflowNameChange = useCallback((newName: string) => {
    setCurrentWorkflowName(newName)
    // Here you could also update the selectedTemplate if needed
    // or make an API call to save the name change
  }, [currentWorkflowName])

  // Handler for refresh confirmation
  const handleConfirmRefresh = useCallback((callback: () => void) => {
    setPendingRefreshCallback(() => callback)
    setShowConfirmationPopup(true)
  }, [])

  // Handler for beforeunload event (browser refresh/close)
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      // Only show warning if in builder mode with unsaved changes
      if (builder && hasWorkflowChanged) {
        event.preventDefault()
        event.returnValue = 'You have unsaved changes. Are you sure you want to leave?'
        return 'You have unsaved changes. Are you sure you want to leave?'
      }
    }

    // Handler for keyboard refresh events (Cmd+R, Cmd+Shift+R)
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Cmd+R or Cmd+Shift+R (Mac) or Ctrl+R, Ctrl+Shift+R (Windows/Linux)
      const isRefreshKey = event.key === 'r' || event.key === 'R'
      const isModifierPressed = event.metaKey || event.ctrlKey // Cmd on Mac, Ctrl on Windows/Linux
      
      if (isRefreshKey && isModifierPressed && builder && hasWorkflowChanged) {
        // Prevent the default refresh behavior
        event.preventDefault()
        event.stopPropagation()
        
        // Show our custom confirmation popup
        handleConfirmRefresh(() => {
          // If user confirms, perform the refresh
          window.location.reload()
        })
      }
    }

    // Add event listeners
    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('keydown', handleKeyDown, true) // Use capture phase for better control

    // Cleanup event listeners
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [builder, hasWorkflowChanged, handleConfirmRefresh])

  // Handler for save changes button
  const handleSaveChanges = useCallback(async () => {
    try {
      // Check if we have nodes to create a workflow
      if (nodes.length === 0 || (nodes.length === 1 && (nodes[0].data as any)?.step?.type === "trigger_selector")) {
        throw new Error("Cannot save workflow: No workflow steps defined. Please add at least one step to your workflow.")
      }

      // Create the workflow state payload that will be sent to the complex template API
      // Use the centralized name resolution function to ensure consistency
      const derivedName = getWorkflowName()
      
      const workflowData = {
        name: derivedName,
        description: selectedTemplate?.description || "Workflow created from builder",
        version: "1.0.0",
        config: {
          ai_model: "gemini-1.5-pro",
          max_file_size: "10MB",
          auto_execution: false,
          schema_version: "1.0",
          allowed_file_types: ["pdf", "docx", "txt"],
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

      // Create the workflow template via complex.post API
      const createResponse = await api.workflow.templates.complex.$post({
        json: workflowData,
      })

      if (!createResponse.ok) {
        const errorText = await createResponse.text()
        throw new Error(`Failed to create workflow template: ${createResponse.status} ${createResponse.statusText}. ${errorText.substring(0, 200)}`)
      }

      const createResult = await createResponse.json()

      if (!createResult.success || !createResult.data) {
        throw new Error("Failed to create workflow template: Invalid response format")
      }

      // Extract the created template ID
      const createdTemplateId = createResult.data.id

      // Use the full response data from the API instead of manually creating the object
      const newCreatedTemplate = {
        ...createResult.data,
        id: createdTemplateId,
      } as WorkflowTemplate
      
      setCreatedTemplate(newCreatedTemplate)
      
      // Mark workflow as saved and update hash
      const currentHash = createWorkflowHash()
      setLastSavedHash(currentHash)
      setIsWorkflowSaved(true)
      setHasWorkflowChanged(false)
      
      // Show success snackbar
      showSnackbarMessage("Workflow saved successfully! You can now execute it.", 'success')

    } catch (error) {
      console.error("Failed to save workflow:", error)
      showSnackbarMessage(`Failed to save workflow: ${error instanceof Error ? error.message : "Unknown error"}`, 'error')
    }
  }, [nodes, edges, templateWorkflow, selectedTemplate, getWorkflowName, setCreatedTemplate, showSnackbarMessage])

  // Use the centralized workflow name function for display consistency

  return (
    <div className="w-full h-full flex flex-col bg-white dark:bg-gray-900 relative">
      {/* Header */}
      <Header
        onBackToWorkflows={onBackToWorkflows}
        onRefreshWorkflows={onRefreshWorkflows}
        workflowName={getWorkflowName()}
        selectedTemplate={selectedTemplate}
        onWorkflowNameChange={handleWorkflowNameChange}
        isEditable={builder}
        onSaveChanges={handleSaveChanges}
        isSaveDisabled={(() => {
          // Check if we have actual workflow steps (not just trigger selector)
          const hasActualSteps = nodes.some(node => {
            const nodeData = node.data as any
            return nodeData?.step?.type && nodeData.step.type !== "trigger_selector"
          })
          
          // Enable save button if we have actual steps and changes have been made
          return !hasActualSteps || (!hasWorkflowChanged && isWorkflowSaved)
        })()}
        hasUnsavedChanges={builder && hasWorkflowChanged}
        onConfirmRefresh={handleConfirmRefresh}
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
            {!showEmptyCanvas && (
              <Panel position="bottom-center">
                <ActionBar
                  onExecute={async () => {
                    try {
                      await executeWorkflow()
                    } catch (error) {
                      console.error("Failed to execute workflow:", error)
                      showSnackbarMessage(`Failed to execute workflow: ${error instanceof Error ? error.message : "Unknown error"}`, 'error')
                    }
                  }}
                  zoomLevel={zoomLevel}
                  onZoomChange={handleZoomChange}
                  disabled={nodes.length === 0 || (nodes.length === 1 && (nodes[0].data as any)?.isTriggerSelector) || (builder && !isWorkflowSaved)}
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
              onClose={() => {
                setShowTriggersSidebar(false)
                // Clear all node selections when sidebar closes
                setNodes((prevNodes) => 
                  prevNodes.map(node => ({ ...node, selected: false }))
                )
                setSelectedNodes([])
              }}
            />
          )}

        {/* What Happens Next Sidebar - stays visible in background when node sidebars open */}
        <WhatHappensNextUI
              isVisible={showWhatHappensNextUI}
              onClose={() => {
                setShowWhatHappensNextUI(false)
                setSelectedReviewPath(null)
                // Don't clear selectedNodeForNext here since it's needed for node creation
                // Only clear it when AI Agent/Email config is actually cancelled
                // Clear all node selections when sidebar closes
                setNodes((prevNodes) => 
                  prevNodes.map(node => ({ ...node, selected: false }))
                )
                setSelectedNodes([])
              }}
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
              reviewPath={selectedReviewPath}
              onStepCreated={(stepData) => {
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
                          config: stepData.tool?.val || {},
                        },
                        tools: stepData.tool ? [stepData.tool] : [],
                        isActive: false,
                        isCompleted: false,
                        hasNext: true, // Show + button on new step
                      },
                      draggable: true,
                    }

                    // Create edge connecting source to new node
                    const newEdge = {
                      id: `${selectedNodeForNext}-${newNodeId}`,
                      source: selectedNodeForNext,
                      target: newNodeId,
                      type: "smoothstep",
                      animated: false,
                      style: {
                        stroke: "#D1D5DB",
                        strokeWidth: 2,
                      },
                      markerEnd: {
                        type: "arrowclosed" as const,
                        color: "#D1D5DB",
                      },
                      sourceHandle: selectedReviewPath === "approved" ? "approved" : selectedReviewPath === "rejected" ? "rejected" : "bottom",
                      targetHandle: "top",
                      label: selectedReviewPath === "approved" ? "Approved" : selectedReviewPath === "rejected" ? "Rejected" : undefined,
                      labelStyle: selectedReviewPath ? { 
                        fill: '#6B7280', 
                        fontWeight: 600, 
                        fontSize: '12px',
                        fontFamily: 'Inter, system-ui, sans-serif'
                      } : undefined,
                      labelBgStyle: selectedReviewPath ? { 
                        fill: '#FFFFFF', 
                        fillOpacity: 0.9,
                        stroke: '#E5E7EB',
                        strokeWidth: 1,
                        rx: 4
                      } : undefined,
                    }

                    // Update nodes and edges
                    setNodes((prevNodes) => [...prevNodes, newNode])
                    setEdges((prevEdges) => [...prevEdges, newEdge])
                    setNodeCounter((prev) => prev + 1)

                    // Mark the appropriate review path as used if this was from a review step
                    setNodes((prevNodes) =>
                      prevNodes.map((node) =>
                        node.id === selectedNodeForNext
                          ? {
                              ...node,
                              data: {
                                ...node.data,
                                hasNext: false,
                                // Mark review path as used
                                ...(selectedReviewPath === "approved" ? { approvedPathUsed: true } : {}),
                                ...(selectedReviewPath === "rejected" ? { rejectedPathUsed: true } : {}),
                                // Update tool config if this is a review step
                                tools: (node.data.tools && Array.isArray(node.data.tools)) ? node.data.tools.map((tool: any) => 
                                  tool.type === "review" ? {
                                    ...tool,
                                    config: {
                                      ...tool.config,
                                      ...(selectedReviewPath === "approved" ? { approved: newNodeId } : {}),
                                      ...(selectedReviewPath === "rejected" ? { rejected: newNodeId } : {}),
                                    }
                                  } : tool
                                ) : node.data.tools,
                              },
                            }
                          : node,
                      ),
                    )
                  }
                }
              }}
            />

        {/* AI Agent Config Sidebar */}
        {!showEmailConfigUI && !showOnFormSubmissionUI && (
          <AIAgentConfigUI
            isVisible={showAIAgentConfigUI}
            onBack={handleAIAgentConfigBack}
            onClose={() => {
              setShowAIAgentConfigUI(false)
              setSelectedAgentNodeId(null)
              setSelectedNodeForNext(null)
              setNodes((prevNodes) => 
                prevNodes.map(node => ({ ...node, selected: false }))
              )
              setSelectedNodes([])
            }}
            onSave={handleAIAgentConfigSave}
            showBackButton={selectedAgentNodeId === "pending"}
            builder={builder}
            toolData={
              selectedAgentNodeId
                ? (() => {
                    const node = nodes.find((n) => n.id === selectedAgentNodeId)
                    const tools = node?.data?.tools as Tool[] | undefined
                    return tools && tools.length > 0 ? tools[0] : undefined
                  })()
                : undefined
            }
            toolId={selectedAgentNodeId ? getToolIdFromStepId(selectedAgentNodeId) : undefined}
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
            onClose={() => {
              setShowEmailConfigUI(false)
              setSelectedEmailNodeId(null)
              setSelectedNodeForNext(null)
              setNodes((prevNodes) => 
                prevNodes.map(node => ({ ...node, selected: false }))
              )
              setSelectedNodes([])
            }}
            onSave={handleEmailConfigSave}
            showBackButton={selectedEmailNodeId === "pending"}
            builder={builder}
            toolData={
              selectedEmailNodeId
                ? (() => {
                    const node = nodes.find((n) => n.id === selectedEmailNodeId)
                    const tools = node?.data?.tools as Tool[] | undefined
                    return tools && tools.length > 0 ? tools[0] : undefined
                  })()
                : undefined
            }
            toolId={selectedEmailNodeId ? getToolIdFromStepId(selectedEmailNodeId) : undefined}
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
        <OnFormSubmissionUI
            isVisible={showOnFormSubmissionUI}
            onBack={handleOnFormSubmissionBack}
            onClose={() => {
              setShowOnFormSubmissionUI(false)
              setSelectedFormNodeId(null)
              setNodes((prevNodes) => 
                prevNodes.map(node => ({ ...node, selected: false }))
              )
              setSelectedNodes([])
              // If we were in pending mode (creating new trigger), show empty canvas again
              if (nodes.length === 0) {
                setShowEmptyCanvas(true)
              }
            }}
            onSave={handleOnFormSubmissionSave}
            showBackButton={selectedFormNodeId === "pending"}
            builder={builder}
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
            toolId={selectedFormNodeId ? getToolIdFromStepId(selectedFormNodeId) : undefined}
          />

        {/* Review Execution Sidebar */}
        <ReviewExecutionUI
          isVisible={showReviewExecutionUI}
          onBack={() => setShowReviewExecutionUI(false)}
          onClose={() => {
            setShowReviewExecutionUI(false)
            setSelectedReviewStepId(null)
          }}
          stepExecutionId={selectedReviewStepId || ""}
          stepName={
            selectedReviewStepId
              ? (() => {
                  const node = nodes.find((n) => {
                    const step = n.data?.step as { id?: string; name?: string }
                    return step?.id === selectedReviewStepId
                  })
                  const step = node?.data?.step as { name?: string }
                  return step?.name || "Review Step"
                })()
              : "Review Step"
          }
          previousStepResult={
            selectedReviewStepId
              ? (() => {
                  // Get previous step results for review context
                  // This would typically come from the workflow execution data
                  return { content: "Previous step content for review" }
                })()
              : null
          }
          onReviewSubmitted={() => {
            // Restart workflow polling after review submission
            console.log("Review submitted, workflow will continue")
          }}
          builder={true}
          onSave={(emailConfig) => {
            // Handle saving review email configuration
            handleReviewConfigSave(emailConfig)
          }}
          stepData={
            selectedReviewStepId
              ? (() => {
                  const node = nodes.find((n) => {
                    const step = n.data?.step as { id?: string }
                    return step?.id === selectedReviewStepId
                  })
                  return node
                })()
              : null
          }
          toolData={
            selectedReviewStepId
              ? (() => {
                  const node = nodes.find((n) => {
                    const step = n.data?.step as { id?: string }
                    return step?.id === selectedReviewStepId
                  })
                  const tools = node?.data?.tools as Tool[] | undefined
                  return tools && tools.length > 0 ? tools[0] : undefined
                })()
              : undefined
          }
          toolId={selectedReviewStepId ? getToolIdFromStepId(selectedReviewStepId) : undefined}
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
          stepName={
            selectedTriggerStepId
              ? (() => {
                  const node = nodes.find((n) => {
                    const step = n.data?.step as { id?: string; name?: string }
                    return step?.id === selectedTriggerStepId
                  })
                  const step = node?.data?.step as { name?: string }
                  return step?.name || "Trigger Step"
                })()
              : "Trigger Step"
          }
          builder={true}
          onTriggerSubmitted={() => {
            // Restart workflow polling after trigger submission
            console.log("Trigger submitted, workflow will continue")
          }}
        />

        {/* Script Config Sidebar */}
        {!showAIAgentConfigUI && !showEmailConfigUI && !showOnFormSubmissionUI && (
          <ScriptSidebar
            isOpen={showScriptConfigUI}
            onClose={() => {
              setShowScriptConfigUI(false)
              setSelectedScriptNodeId(null)
              setSelectedNodeForNext(null)
              setNodes((prevNodes) => 
                prevNodes.map(node => ({ ...node, selected: false }))
              )
              setSelectedNodes([])
            }}
            onBack={() => {
              setShowScriptConfigUI(false)
              
              // If we're in creation mode (pending), go back to the "What Happens Next" menu
              if (selectedScriptNodeId === "pending" && selectedNodeForNext) {
                // Ensure WhatHappensNextUI is visible when we go back
                setShowWhatHappensNextUI(true)
                setSelectedScriptNodeId(null)
              } else {
                // If we're editing an existing node, just close the sidebar
                setSelectedScriptNodeId(null)
                setSelectedNodeForNext(null)
                // Clear all node selections when sidebar closes
                setNodes((prevNodes) => 
                  prevNodes.map(node => ({ ...node, selected: false }))
                )
                setSelectedNodes([])
              }
            }}
            showBackButton={selectedScriptNodeId === "pending"}
            onCodeSaved={(language: string, code: string) => {
              console.log("Script code saved:", { language, code })
            }}
            zIndex={50}
            selectedNodeId={selectedScriptNodeId}
            selectedTemplate={selectedTemplate}
            initialData={
              selectedScriptNodeId
                ? (() => {
                    const node = nodes.find((n) => n.id === selectedScriptNodeId)
                    const tools = node?.data?.tools as Tool[] | undefined
                    const tool = tools && tools.length > 0 ? tools[0] : undefined
                    console.log("WorkflowBuilder: Passing script tool data to sidebar:", {
                      nodeId: selectedScriptNodeId,
                      node: node,
                      tools: tools,
                      tool: tool
                    })
                    return tool
                  })()
                : undefined
            }
            onStepCreated={(stepData) => {
              console.log("Script step created:", stepData)
              
              // Create visual step below the selected node
              if (selectedNodeForNext && stepData) {
                const sourceNode = nodes.find((n) => n.id === selectedNodeForNext)
                if (sourceNode) {
                  const newNodeId = `step-${nodeCounter}`
                  
                  // Check if the source node is a review step and determine the connection path
                  let sourceHandle = "bottom"
                  let edgeLabel = undefined
                  let reviewPath = null
                  
                  if (sourceNode?.data?.tools && Array.isArray(sourceNode.data.tools)) {
                    const reviewTool = sourceNode.data.tools.find((tool: any) => tool.type === "review")
                    if (reviewTool) {
                      // This is a review step - determine which path to use based on current usage
                      const config = reviewTool.config || {}
                      console.log("Found review step with config:", config)
                      
                      // Use approved path if it's not used, otherwise use rejected path
                      if (!config.approved) {
                        sourceHandle = "approved"
                        edgeLabel = "Approved"
                        reviewPath = "approved"
                      } else if (!config.rejected) {
                        sourceHandle = "rejected" 
                        edgeLabel = "Rejected"
                        reviewPath = "rejected"
                      } else {
                        console.warn("Both approved and rejected paths are already used for review step:", selectedNodeForNext)
                      }
                    }
                  }
                  
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
                  const newEdge = {
                    id: `${selectedNodeForNext}-${newNodeId}`,
                    source: selectedNodeForNext,
                    target: newNodeId,
                    type: "smoothstep",
                    animated: false,
                    style: {
                      stroke: "#D1D5DB",
                      strokeWidth: 2,
                    },
                    markerEnd: {
                      type: "arrowclosed" as const,
                      color: "#D1D5DB",
                    },
                    sourceHandle: sourceHandle,
                    targetHandle: "top",
                    label: edgeLabel,
                    labelStyle: edgeLabel ? { 
                      fill: '#6B7280', 
                      fontWeight: 600, 
                      fontSize: '12px',
                      fontFamily: 'Inter, system-ui, sans-serif'
                    } : undefined,
                    labelBgStyle: edgeLabel ? { 
                      fill: '#FFFFFF', 
                      fillOpacity: 0.9,
                      stroke: '#E5E7EB',
                      strokeWidth: 1,
                      rx: 4
                    } : undefined,
                  }

                  // Update nodes and edges
                  setNodes((prevNodes) => [...prevNodes, newNode])
                  setEdges((prevEdges) => [...prevEdges, newEdge])
                  setNodeCounter((prev) => prev + 1)

                  // Update the review step's config if this was from a review step
                  if (reviewPath) {
                    setNodes((prevNodes) =>
                      prevNodes.map((node) =>
                        node.id === selectedNodeForNext
                          ? {
                              ...node,
                              data: {
                                ...node.data,
                                hasNext: false,
                                // Mark review path as used
                                ...(reviewPath === "approved" ? { approvedPathUsed: true } : {}),
                                ...(reviewPath === "rejected" ? { rejectedPathUsed: true } : {}),
                                // Update tool config if this is a review step
                                tools: (node.data.tools && Array.isArray(node.data.tools)) ? node.data.tools.map((tool: any) => 
                                  tool.type === "review" ? {
                                    ...tool,
                                    config: {
                                      ...tool.config,
                                      ...(reviewPath === "approved" ? { approved: newNodeId } : {}),
                                      ...(reviewPath === "rejected" ? { rejected: newNodeId } : {}),
                                    }
                                  } : tool
                                ) : node.data.tools,
                              },
                            }
                          : node,
                      ),
                    )
                  } else {
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
              }
            }}
            onToolUpdated={(nodeId, updatedTool) => {
              console.log("Script tool updated for node:", nodeId, updatedTool)
              
              // Update the React Flow node data with the updated tool
              setNodes((prevNodes) =>
                prevNodes.map((node) => {
                  if (node.id === nodeId) {
                    const currentTools = (node.data?.tools as any[]) || []
                    
                    // For script tools, always update the first tool since there should only be one
                    // This handles cases where tool IDs might not match or be missing
                    let updatedTools
                    if (updatedTool.type === "script" && currentTools.length > 0) {
                      updatedTools = [updatedTool] // Replace the first (and likely only) script tool
                    } else {
                      // Fallback to ID matching for other tool types
                      updatedTools = currentTools.map((tool) => 
                        tool.id === updatedTool.id ? updatedTool : tool
                      )
                      
                      // If no tool was updated by ID matching, replace the first tool
                      if (updatedTools.every(tool => tool !== updatedTool) && currentTools.length > 0) {
                        updatedTools[0] = updatedTool
                      }
                    }
                    
                    console.log("Updating node data:", {
                      nodeId,
                      currentTools,
                      updatedTools,
                      updatedTool
                    })
                    
                    return {
                      ...node,
                      data: {
                        ...node.data,
                        tools: updatedTools,
                      },
                    }
                  }
                  return node
                }),
              )
            }}
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
      {showExecutionModal && (createdTemplate || selectedTemplate) && (() => {
        const template = createdTemplate || selectedTemplate
        const templateId = template?.id !== 'pending-creation' ? template?.id : undefined
        
        return (
          <WorkflowExecutionModal
            isOpen={showExecutionModal}
            onClose={() => {
              setShowExecutionModal(false)
              // Keep createdTemplate state so it can be reused for future executions
            }}
            workflowName={template?.name || "Custom Workflow"}
            workflowDescription={template?.description || "User-created workflow"}
            templateId={templateId}
            workflowTemplate={templateId ? template || undefined : undefined}
            onViewExecution={onViewExecution}
          />
        )
      })()}

      {/* Template Selection Modal */}
      <TemplateSelectionModal
        isOpen={showTemplateSelectionModal}
        onClose={handleTemplateModalClose}
        templates={availableTemplates
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) // Sort by newest first
          .map(template => ({
            id: template.id,
            name: template.name,
            description: template.description,
            icon: "🔧", // Default icon, you can map based on template type
            iconBgColor: "bg-blue-50",
            isPlaceholder: false,
          }))}
        loading={templatesLoading}
        error={templatesError}
        onSelectTemplate={handleTemplateSelect}
      />

      {/* Snackbar for notifications */}
      <Snackbar
        message={snackbarMessage}
        type={snackbarType}
        isVisible={showSnackbar}
        onClose={() => setShowSnackbar(false)}
        duration={5000}
        position="top-center"
      />

      {/* Confirmation Popup for unsaved changes */}
      <ConfirmationPopup
        isVisible={showConfirmationPopup}
        title="Hold on — you have unsaved work"
        message="Refreshing now will discard your edits permanently"
        confirmText="Refresh"
        cancelText="Cancel"
        onConfirm={() => {
          setShowConfirmationPopup(false)
          if (pendingRefreshCallback) {
            pendingRefreshCallback()
            setPendingRefreshCallback(null)
          }
        }}
        onCancel={() => {
          setShowConfirmationPopup(false)
          setPendingRefreshCallback(null)
        }}
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
