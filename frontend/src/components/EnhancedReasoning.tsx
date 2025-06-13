import React, { useState, useEffect, useRef } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { AgentReasoningStepType } from "shared/types"

interface ReasoningStep {
  type: AgentReasoningStepType | string
  content: string
  timestamp: number
  status?: "pending" | "success" | "error" | "info"
  iterationNumber?: number
  substeps?: ReasoningStep[]
}

interface EnhancedReasoningProps {
  content: string
  isStreaming?: boolean
  className?: string
}

// Parse reasoning content into structured steps with iteration grouping
const parseReasoningContent = (content: string): ReasoningStep[] => {
  if (!content.trim()) return []
  
  const lines = content.split('\n').filter(line => line.trim())
  const steps: ReasoningStep[] = []
  let currentIteration: ReasoningStep | null = null
  
  lines.forEach((line, index) => {
    let type: AgentReasoningStepType | string = "log_message"
    let status: "pending" | "success" | "error" | "info" = "info"
    let stepContent = line.trim()
    let iterationNumber: number | undefined = undefined
    
    // Detect step types based on content patterns
    if (line.includes("Iteration ")) {
      type = AgentReasoningStepType.Iteration
      status = "info"
      // Extract iteration number
      const match = line.match(/Iteration (\d+)/)
      if (match) {
        iterationNumber = parseInt(match[1])
      }
      
      // Create new iteration step
      const iterationStep: ReasoningStep = {
        type,
        content: stepContent,
        timestamp: Date.now() + index,
        status,
        iterationNumber,
        substeps: []
      }
      
      steps.push(iterationStep)
      currentIteration = iterationStep
      return
    } else if (line.includes("Planning") || line.includes("Planning next step")) {
      type = AgentReasoningStepType.Planning
      status = "pending"
    } else if (line.includes("Tool selected:")) {
      type = AgentReasoningStepType.ToolSelected
      status = "info"
    } else if (line.includes("Parameters:")) {
      type = AgentReasoningStepType.ToolParameters
      status = "info"
    } else if (line.includes("Executing tool:")) {
      type = AgentReasoningStepType.ToolExecuting
      status = "pending"
    } else if (line.includes("Tool result")) {
      type = AgentReasoningStepType.ToolResult
      status = line.includes("Error:") ? "error" : "success"
    } else if (line.includes("Synthesizing") || line.includes("synthesis")) {
      type = AgentReasoningStepType.Synthesis
      status = "pending"
    } else if (line.includes("Validation Error")) {
      type = AgentReasoningStepType.ValidationError
      status = "error"
    } else if (line.includes("Broadening Search")) {
      type = AgentReasoningStepType.BroadeningSearch
      status = "info"
    } else if (line.includes("Analyzing")) {
      type = AgentReasoningStepType.AnalyzingQuery
      status = "pending"
    }
    
    const step: ReasoningStep = {
      type,
      content: stepContent,
      timestamp: Date.now() + index,
      status
    }
    
    // If we have a current iteration and this isn't a new iteration, add as substep
    if (currentIteration && type !== AgentReasoningStepType.Iteration) {
      currentIteration.substeps!.push(step)
    } else {
      // Otherwise add as top-level step
      steps.push(step)
    }
  })
  
  return steps
}

// Get display properties for different step types
const getStepTypeDisplay = (type: AgentReasoningStepType | string) => {
  const displays: Record<string, { icon: string; label: string; color: string; isError?: boolean }> = {
    [AgentReasoningStepType.Iteration]: { 
      icon: "→", 
      label: "Iteration",
      color: "text-blue-600 dark:text-blue-400"
    },
    [AgentReasoningStepType.Planning]: { 
      icon: "●", 
      label: "Planning",
      color: "text-purple-600 dark:text-purple-400"
    },
    [AgentReasoningStepType.ToolSelected]: { 
      icon: "○", 
      label: "Tool Selected",
      color: "text-green-600 dark:text-green-400"
    },
    [AgentReasoningStepType.ToolParameters]: { 
      icon: "·", 
      label: "Parameters",
      color: "text-gray-500 dark:text-gray-400"
    },
    [AgentReasoningStepType.ToolExecuting]: { 
      icon: "↻", 
      label: "Executing",
      color: "text-amber-600 dark:text-amber-400"
    },
    [AgentReasoningStepType.ToolResult]: { 
      icon: "✓", 
      label: "Result",
      color: "text-emerald-600 dark:text-emerald-400"
    },
    [AgentReasoningStepType.Synthesis]: { 
      icon: "◇", 
      label: "Synthesis",
      color: "text-indigo-600 dark:text-indigo-400"
    },
    [AgentReasoningStepType.ValidationError]: { 
      icon: "✗", 
      label: "Error", 
      color: "text-red-600 dark:text-red-400",
      isError: true
    },
    [AgentReasoningStepType.BroadeningSearch]: { 
      icon: "◯", 
      label: "Broadening Search",
      color: "text-orange-600 dark:text-orange-400"
    },
    [AgentReasoningStepType.AnalyzingQuery]: { 
      icon: "○", 
      label: "Analyzing",
      color: "text-cyan-600 dark:text-cyan-400"
    },
    log_message: { 
      icon: "·", 
      label: "Thinking",
      color: "text-gray-500 dark:text-gray-400"
    }
  }
  
  return displays[type] || displays.log_message
}

// Component to render a single reasoning step
const ReasoningStepComponent: React.FC<{
  step: ReasoningStep
  index: number
  isStreaming: boolean
  isLastStep: boolean
  depth?: number
}> = ({ step, index, isStreaming, isLastStep, depth = 0 }) => {
  const [isExpanded, setIsExpanded] = useState(true)
  const display = getStepTypeDisplay(step.type)
  const isIteration = step.type === AgentReasoningStepType.Iteration
  const hasSubsteps = step.substeps && step.substeps.length > 0
  
  return (
    <div className={cn("space-y-1 w-full min-w-full", depth > 0 && "ml-3")}>
      <div className="flex items-start space-x-2 py-1 w-full min-w-full">
        <div className="flex-shrink-0 mt-1 flex items-center">
          {isIteration && hasSubsteps && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="mr-1 p-0.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              {isExpanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
            </button>
          )}
          <span className={cn(
            "text-sm font-mono w-4 text-center",
            display.color
          )}>
            {display.icon}
          </span>
        </div>
        <div className="flex-1 min-w-0 w-full">
          <div className="flex items-center space-x-2 w-full">
            <span className={cn(
              "text-sm font-medium",
              display.color
            )}>
              {display.label}
              {step.iterationNumber && ` ${step.iterationNumber}`}
            </span>
            {step.status === "pending" && isStreaming && isLastStep && (
              <span className="text-gray-400 text-sm">...</span>
            )}
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-300 mt-1 leading-relaxed w-full break-words">
            {step.content}
          </p>
        </div>
      </div>
      
      {/* Render substeps if iteration is expanded */}
      {isIteration && hasSubsteps && isExpanded && (
        <div className="space-y-1 ml-4 pl-2 w-full">
          {step.substeps!.map((substep, substepIndex) => (
            <ReasoningStepComponent
              key={substepIndex}
              step={substep}
              index={substepIndex}
              isStreaming={isStreaming}
              isLastStep={substepIndex === step.substeps!.length - 1}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export const EnhancedReasoning: React.FC<EnhancedReasoningProps> = ({
  content,
  isStreaming = false,
  className
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [steps, setSteps] = useState<ReasoningStep[]>([])
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const parsedSteps = parseReasoningContent(content)
    setSteps(parsedSteps)
  }, [content])

  // Auto-scroll to bottom when new content arrives during streaming
  useEffect(() => {
    if (isStreaming && !isCollapsed && scrollContainerRef.current && steps.length > 0) {
      const container = scrollContainerRef.current
      // Use setTimeout to ensure DOM has updated before scrolling
      setTimeout(() => {
        // Scroll to the bottom smoothly
        container.scrollTo({
          top: container.scrollHeight,
          behavior: 'smooth'
        })
      }, 10)
    }
  }, [steps, isStreaming, isCollapsed])

  if (!content.trim() && !isStreaming) {
    return null
  }

  const toggleCollapsed = () => setIsCollapsed(!isCollapsed)

  return (
    <div className={cn("mb-4 w-full max-w-none", className)}>
      {/* Header */}
      <button
        onClick={toggleCollapsed}
        className="flex items-center w-full min-w-full px-3 py-2 text-base text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 transition-colors flex-1"
      >
        {isCollapsed ? (
          <ChevronRight className="w-4 h-4 mr-2 text-slate-500" />
        ) : (
          <ChevronDown className="w-4 h-4 mr-2 text-slate-500" />
        )}
        <span className="flex items-center font-medium flex-1">
          Agent Reasoning
          {/* {isStreaming && (
            <span className="ml-2 flex items-center text-sm font-normal text-slate-500">
              <span className="mr-1 text-blue-500">...</span>
              thinking
            </span>
          )} */}
        </span>
        <span className="flex-shrink-0 text-sm text-slate-400">
          {steps.length} {steps.length === 1 ? 'step' : 'steps'}
        </span>
      </button>

      {/* Content */}
      {!isCollapsed && (
        <div className="w-full min-w-full max-w-none pl-3 mt-2">
          <div 
            ref={scrollContainerRef}
            className="space-y-1 max-h-80 overflow-y-auto w-full min-w-full"
          >
            {steps.length > 0 ? (
              steps.map((step, index) => (
                <ReasoningStepComponent
                  key={index}
                  step={step}
                  index={index}
                  isStreaming={isStreaming}
                  isLastStep={index === steps.length - 1}
                  depth={0}
                />
              ))
            ) : isStreaming ? (
              <div className="flex items-center py-4 text-gray-500 dark:text-gray-400">
                <span className="mr-2">...</span>
                <span className="text-sm">initializing...</span>
              </div>
            ) : (
              <div className="py-4 text-gray-500 dark:text-gray-400 text-sm">
                No reasoning steps available
              </div>
            )}
            
            {/* Show streaming indicator if content is being generated */}
            {/* {isStreaming && content.trim() && (
              <div className="flex items-center space-x-2 py-2 text-gray-500 dark:text-gray-400">
                <span>...</span>
                <span className="text-sm">thinking...</span>
              </div>
            )} */}
          </div>
        </div>
      )}
    </div>
  )
}

export default EnhancedReasoning
