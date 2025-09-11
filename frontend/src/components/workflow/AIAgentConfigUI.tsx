import React, { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ArrowLeft, X, ChevronDown } from "lucide-react"
import { workflowToolsAPI } from "./api/ApiHandlers"

interface AIAgentConfigUIProps {
  isVisible: boolean
  onBack: () => void
  onClose?: () => void // New prop for closing all sidebars
  onSave?: (agentConfig: AIAgentConfig) => void
  toolData?: any
  toolId?: string // Tool ID for API updates
  stepData?: any // Step data for loading existing configuration
  showBackButton?: boolean // Whether to show the back button
}

export interface AIAgentConfig {
  name: string
  description: string
  model: string
  inputPrompt: string
  systemPrompt: string
  knowledgeBase: string
}

const AIAgentConfigUI: React.FC<AIAgentConfigUIProps> = ({
  isVisible,
  onBack,
  onClose,
  onSave,
  toolData,
  toolId,
  stepData,
  showBackButton = false,
}) => {
  const [agentConfig, setAgentConfig] = useState<AIAgentConfig>({
    name: "AI Agent",
    description: "",
    model: "gemini-1.5-flash",
    inputPrompt: "$json.input",
    systemPrompt: "",
    knowledgeBase: "",
  })

  // Load existing data or reset to defaults when component becomes visible
  React.useEffect(() => {
    if (isVisible) {
      // Try to load from stepData.config first, then toolData, otherwise use defaults
      let existingConfig = null
      
      if (stepData?.config) {
        existingConfig = stepData.config
      } else if (toolData?.value || toolData?.config) {
        existingConfig = toolData.value || toolData.config || {}
      }
      
      if (existingConfig) {
        setAgentConfig({
          name: existingConfig.name || "AI Agent",
          description: existingConfig.description || "",
          model: existingConfig.model || "gemini-1.5-flash",
          inputPrompt: existingConfig.inputPrompt || "$json.input",
          systemPrompt: existingConfig.systemPrompt || "",
          knowledgeBase: existingConfig.knowledgeBase || "",
        })
      } else {
        // Reset to defaults for new AI Agent
        setAgentConfig({
          name: "AI Agent",
          description: "",
          model: "gemini-1.5-flash",
          inputPrompt: "$json.input",
          systemPrompt: "",
          knowledgeBase: "",
        })
      }
      setIsModelDropdownOpen(false)
      setIsEnhancingPrompt(false)
    }
  }, [isVisible, toolData, stepData])

  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false)
  const [isEnhancingPrompt, setIsEnhancingPrompt] = useState(false)

  const models = ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-1.0-pro"]

  const enhanceSystemPrompt = async () => {
    if (!agentConfig.systemPrompt.trim()) {
      alert("Please enter a system prompt first")
      return
    }

    setIsEnhancingPrompt(true)

    try {
      // Use Xyne's existing prompt generation endpoint with Bedrock
      const requirements = `Enhance this AI agent system prompt to be more professional, clear, and effective. Make it more structured and comprehensive while preserving the original intent.

Original prompt: "${agentConfig.systemPrompt}"

Please provide an enhanced version that:
1. Is clear and specific about the AI agent's role
2. Includes proper behavioral guidelines  
3. Has clear instructions for output format
4. Maintains the original purpose but makes it more professional

Return only the enhanced system prompt without any additional explanation.`

      // Create EventSource for streaming response from Xyne's Bedrock implementation
      const url = `/agent/generate-prompt?requirements=${encodeURIComponent(requirements)}&modelId=${encodeURIComponent(agentConfig.model)}`
      const eventSource = new EventSource(url)

      let enhancedPrompt = ""
      let timeoutId: ReturnType<typeof setTimeout>

      // Set a timeout to prevent hanging
      timeoutId = setTimeout(() => {
        eventSource.close()
        setIsEnhancingPrompt(false)
        // TODO: surface a toast to the user about timeout
      }, 30000) // 30s

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)

          if (event.type === "ResponseUpdate" || data.type === "update") {
            enhancedPrompt += data.text || data.content || ""
          } else if (event.type === "End" || data.type === "end") {
            clearTimeout(timeoutId)
            eventSource.close()

            const finalPrompt = data.fullPrompt || enhancedPrompt.trim()
            if (finalPrompt) {
              setAgentConfig((prev) => ({
                ...prev,
                systemPrompt: finalPrompt,
              }))
            }
            setIsEnhancingPrompt(false)
          }
        } catch (parseError) {
          // Handle non-JSON responses (raw text chunks)
          if (typeof event.data === "string") {
            enhancedPrompt += event.data
          }
        }
      }

      eventSource.onerror = (error) => {
        console.error("EventSource error:", error)
        clearTimeout(timeoutId)
        eventSource.close()
        setIsEnhancingPrompt(false)

        // Fallback enhancement
        const fallbackEnhancement = `You are a professional ${agentConfig.name.toLowerCase()} AI agent specialized in ${agentConfig.description || "data processing"}.

CORE RESPONSIBILITIES:
${agentConfig.systemPrompt}

BEHAVIORAL GUIDELINES:
- Maintain a professional and helpful tone at all times
- Provide accurate, relevant, and well-structured responses
- Follow clear output formatting standards
- Ensure all responses are actionable and clear
- Process input thoroughly before responding

OUTPUT REQUIREMENTS:
- Structure responses with clear headings when appropriate
- Use bullet points or numbered lists for complex information
- Maintain consistency in tone and style
- Always double-check accuracy before providing final output

Always strive for excellence and helpfulness in your responses while adhering to these guidelines.`

        setAgentConfig((prev) => ({
          ...prev,
          systemPrompt: fallbackEnhancement,
        }))
      }
    } catch (error) {
      console.error("Error enhancing prompt:", error)
      setIsEnhancingPrompt(false)

      // Fallback enhancement for any other errors
      const fallbackEnhancement = `You are a professional ${agentConfig.name.toLowerCase()} AI agent. ${agentConfig.systemPrompt}

Key responsibilities:
- Analyze and process the provided input thoroughly
- Maintain a professional and helpful tone
- Provide accurate and relevant responses
- Follow structured output formatting
- Ensure all responses are clear and actionable

Always strive for accuracy and helpfulness in your responses.`

      setAgentConfig((prev) => ({
        ...prev,
        systemPrompt: fallbackEnhancement,
      }))

      alert("Enhancement failed. A basic improvement has been applied.")
    }
  }

  const handleSave = async () => {
    try {
      // If we have a toolId, update the tool via API
      if (toolId) {
        const updatedToolData = {
          type: "ai_agent",
          value: agentConfig,
          config: {
            ...toolData?.config,
            model: agentConfig.model,
            name: agentConfig.name,
            description: agentConfig.description,
          },
        }

        await workflowToolsAPI.updateTool(toolId, updatedToolData)
        console.log("AI Agent tool updated successfully")
      }

      // Call the parent save handler
      onSave?.(agentConfig)
    } catch (error) {
      console.error("Failed to save AI agent configuration:", error)
      // Still call the parent handler even if API call fails
      onSave?.(agentConfig)
    }
  }

  return (
    <div
      className={`fixed top-[80px] right-0 h-[calc(100vh-80px)] bg-white dark:bg-gray-900 border-l border-slate-200 dark:border-gray-700 flex flex-col overflow-hidden z-50 ${
        isVisible ? "translate-x-0 w-[380px]" : "translate-x-full w-0"
      }`}
    >
      {/* Header */}
      <div
        className="flex items-center border-b"
        style={{
          display: "flex",
          padding: "20px",
          alignItems: "center",
          gap: "10px",
          alignSelf: "stretch",
          borderBottom: "1px solid var(--gray-300, #E4E6E7)",
        }}
      >
        {showBackButton && (
          <button
            onClick={onBack}
            className="flex items-center justify-center"
            style={{
              width: "24px",
              height: "24px",
              padding: "0",
              border: "none",
              background: "transparent",
              cursor: "pointer",
            }}
          >
            <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-400" />
          </button>
        )}

        <h2
          className="flex-1 text-gray-900 dark:text-gray-100"
          style={{
            alignSelf: "stretch",
            fontFamily: "Inter",
            fontSize: "16px",
            fontStyle: "normal",
            fontWeight: "600",
            lineHeight: "normal",
            letterSpacing: "-0.16px",
            textTransform: "capitalize",
          }}
        >
          AI Agent
        </h2>

        <button
          onClick={onClose || onBack}
          className="flex items-center justify-center"
          style={{
            width: "24px",
            height: "24px",
            padding: "0",
            border: "none",
            background: "transparent",
            cursor: "pointer",
          }}
        >
          <X className="w-5 h-5 text-gray-600 dark:text-gray-400" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col">
        <div className="space-y-6 flex-1">
          {/* Agent Name */}
          <div className="space-y-2">
            <Label
              htmlFor="agent-name"
              className="text-sm font-medium text-slate-700 dark:text-gray-300"
            >
              Agent Name
            </Label>
            <Input
              id="agent-name"
              value={agentConfig.name}
              onChange={(e) =>
                setAgentConfig((prev) => ({ ...prev, name: e.target.value }))
              }
              placeholder="Enter agent name"
              className="w-full dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600"
            />
          </div>

          {/* Agent Description */}
          <div className="space-y-2">
            <Label
              htmlFor="agent-description"
              className="text-sm font-medium text-slate-700 dark:text-gray-300"
            >
              Agent Description
            </Label>
            <Textarea
              id="agent-description"
              value={agentConfig.description}
              onChange={(e) =>
                setAgentConfig((prev) => ({
                  ...prev,
                  description: e.target.value,
                }))
              }
              placeholder="Describe what this agent does"
              className="w-full min-h-[80px] resize-none dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600"
            />
          </div>

          {/* Choose Model */}
          <div className="space-y-2">
            <Label className="text-sm font-medium text-slate-700 dark:text-gray-300">
              Choose Model
            </Label>
            <div className="relative">
              <button
                onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
                className="w-full h-10 px-3 py-2 bg-white dark:bg-gray-800 border border-slate-200 dark:border-gray-600 rounded-md text-sm text-left flex items-center justify-between focus:outline-none focus:ring-1 focus:ring-slate-400 dark:focus:ring-gray-500 focus:border-slate-400 dark:focus:border-gray-500"
              >
                <span className="text-slate-900 dark:text-gray-300">{agentConfig.model}</span>
                <ChevronDown
                  className={`w-4 h-4 text-slate-500 dark:text-gray-400 transition-transform ${isModelDropdownOpen ? "rotate-180" : ""}`}
                />
              </button>

              {isModelDropdownOpen && (
                <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-white dark:bg-gray-800 border border-slate-200 dark:border-gray-600 rounded-md shadow-lg">
                  {models.map((model) => (
                    <button
                      key={model}
                      onClick={() => {
                        setAgentConfig((prev) => ({ ...prev, model }))
                        setIsModelDropdownOpen(false)
                      }}
                      className="w-full px-3 py-2 text-sm text-left hover:bg-slate-50 dark:hover:bg-gray-700 text-slate-900 dark:text-gray-300"
                    >
                      {model}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* System Prompt */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label
                htmlFor="system-prompt"
                className="text-sm font-medium text-slate-700 dark:text-gray-300"
              >
                System Prompt
              </Label>
              <button
                onClick={enhanceSystemPrompt}
                disabled={isEnhancingPrompt || !agentConfig.systemPrompt.trim()}
                className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                title="Enhance with AI"
              >
                {isEnhancingPrompt ? (
                  <div className="w-5 h-5 animate-spin">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="20"
                      height="20"
                      viewBox="0 0 20 20"
                      fill="none"
                    >
                      <path
                        d="M10 2V6"
                        stroke="#FF4F4F"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                      <path
                        d="M10 14V18"
                        stroke="#FF4F4F"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                      <path
                        d="M4.22 4.22L6.34 6.34"
                        stroke="#FF4F4F"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                      <path
                        d="M13.66 13.66L15.78 15.78"
                        stroke="#FF4F4F"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                      <path
                        d="M2 10H6"
                        stroke="#FF4F4F"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                      <path
                        d="M14 10H18"
                        stroke="#FF4F4F"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                      <path
                        d="M4.22 15.78L6.34 13.66"
                        stroke="#FF4F4F"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                      <path
                        d="M13.66 6.34L15.78 4.22"
                        stroke="#FF4F4F"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </div>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 20 20"
                    fill="none"
                  >
                    <path
                      d="M15.6285 8.12116C15.3535 8.12116 15.1201 7.94616 15.0368 7.68783C14.7285 6.74616 13.9868 6.00449 13.0535 5.70449C12.7951 5.62116 12.6201 5.37949 12.6201 5.11283C12.6201 4.84616 12.7951 4.60449 13.0535 4.52116C13.9951 4.21283 14.7368 3.47116 15.0368 2.53783C15.1201 2.27949 15.3618 2.10449 15.6285 2.10449C15.8951 2.10449 16.1368 2.27949 16.2201 2.53783C16.5285 3.47949 17.2701 4.22116 18.2035 4.52116C18.4618 4.60449 18.6368 4.84616 18.6368 5.11283C18.6368 5.37949 18.4618 5.62116 18.2035 5.70449C17.2618 6.01283 16.5201 6.75449 16.2201 7.68783C16.1368 7.94616 15.8951 8.12116 15.6285 8.12116ZM14.6118 5.11283C15.0035 5.39616 15.3451 5.73783 15.6285 6.12949C15.9118 5.73783 16.2535 5.39616 16.6451 5.11283C16.2535 4.82949 15.9118 4.48783 15.6285 4.09616C15.3451 4.48783 15.0035 4.82949 14.6118 5.11283Z"
                      fill="#FF4F4F"
                    />
                    <path
                      d="M9.16175 17.8957C8.72009 17.8957 8.32838 17.6123 8.18671 17.1873L6.93671 13.3457L3.09504 12.0957C2.67004 11.954 2.38672 11.5707 2.38672 11.1207C2.38672 10.6707 2.67004 10.2873 3.09504 10.1457L6.93671 8.89567L8.18671 5.05404C8.32838 4.62904 8.71175 4.3457 9.16175 4.3457C9.61175 4.3457 9.99509 4.62904 10.1368 5.05404L11.3868 8.89567L15.2284 10.1457C15.6534 10.2873 15.9368 10.6707 15.9368 11.1207C15.9368 11.5707 15.6534 11.954 15.2284 12.0957L11.3868 13.3457L10.1368 17.1873C9.99509 17.6123 9.61175 17.8957 9.16175 17.8957ZM4.14505 11.1207L7.43672 12.1873C7.75339 12.2873 7.99504 12.5373 8.09504 12.854L9.16175 16.1373L10.2284 12.8457C10.3284 12.5373 10.5701 12.2873 10.8868 12.1873L14.1784 11.1207L10.8868 10.054C10.5784 9.954 10.3284 9.704 10.2284 9.39567L9.16175 6.11237L8.09504 9.404C7.99504 9.71234 7.75339 9.96234 7.43672 10.0623L4.14505 11.129V11.1207Z"
                      fill="#FF4F4F"
                    />
                  </svg>
                )}
              </button>
            </div>
            <Textarea
              id="system-prompt"
              value={agentConfig.systemPrompt}
              onChange={(e) =>
                setAgentConfig((prev) => ({
                  ...prev,
                  systemPrompt: e.target.value,
                }))
              }
              placeholder="Enter system prompt"
              className="w-full min-h-[120px] resize-none dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600"
            />
            <p className="text-xs text-slate-500 dark:text-gray-400">
              A system prompt is the initial instruction that sets an AI model's
              behavior, style, and constraints.
            </p>
          </div>
        </div>
        
        {/* Save Button - Sticky to bottom */}
        <div className="pt-6 px-0">
          <Button
            onClick={handleSave}
            className="w-full bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-full"
          >
            Save Configuration
          </Button>
        </div>
      </div>
    </div>
  )
}

export default AIAgentConfigUI
