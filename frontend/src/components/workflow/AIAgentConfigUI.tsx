import React, { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ArrowLeft, X, ChevronDown, Loader, Sparkles } from "lucide-react"
import { workflowToolsAPI } from "./api/ApiHandlers"
import { api } from "../../api"
import { createAuthEventSource } from "@/hooks/useChatStream"
import { ChatSSEvents } from "shared/types"

interface AIAgentConfigUIProps {
  isVisible: boolean
  onBack: () => void
  onClose?: () => void 
  onSave?: (agentConfig: AIAgentConfig) => void
  toolData?: any
  toolId?: string 
  stepData?: any 
  showBackButton?: boolean 
  builder?: boolean
}

export interface AIAgentConfig {
  name: string
  description: string
  model: string
  inputPrompt: string
  systemPrompt: string
  knowledgeBase: string
  isExistingAgent: boolean
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
  builder = true,
}) => {
  const [agentConfig, setAgentConfig] = useState<AIAgentConfig>({
    name: "AI Agent",
    description: "some agent description",
    model: "vertex-gemini-2-5-flash",
    inputPrompt: "$json.input",
    systemPrompt: "",
    knowledgeBase: "",
    isExistingAgent: false,
  })

  
  React.useEffect(() => {
    if (isVisible) {
      
      let existingConfig = null
      
      if (stepData?.config) {
        existingConfig = stepData.config
      } else if (toolData) {
        
        existingConfig = toolData.val || toolData.value || toolData.config || {}
      }
      
      if (existingConfig) {
        setAgentConfig({
          name: existingConfig.name || "AI Agent",
          description: existingConfig.description || "some agent description",
          model: existingConfig.model,
          inputPrompt: existingConfig.inputPrompt || "$json.input",
          systemPrompt: existingConfig.systemPrompt || "",
          knowledgeBase: existingConfig.knowledgeBase || "",
          isExistingAgent: existingConfig.isExistingAgent || false,
        })
      } else {
        
        setAgentConfig({
          name: "AI Agent",
          description: "some agent description",
          model: getValidModelId(undefined), 
          inputPrompt: "$json.input",
          systemPrompt: "",
          knowledgeBase: "",
          isExistingAgent: false,
        })
      }
      setIsModelDropdownOpen(false)
      setIsEnhancingPrompt(false)
    }
  }, [isVisible, toolData, stepData])

  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false)
  const [isEnhancingPrompt, setIsEnhancingPrompt] = useState(false)

  const [models, setModels] = useState<string[]>(["vertex-gemini-2-5-flash"])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [modelsLoaded, setModelsLoaded] = useState(false)

  
  React.useEffect(() => {
    if (isVisible && !modelsLoaded) {
      const fetchGeminiModels = async () => {
        setIsLoadingModels(true)
        try {
          const response = await api.workflow.models.gemini.$get()
          
          if (response.ok) {
            const data = await response.json()
            if (data.success && data.data && Array.isArray(data.data)) {
              const enumValues = data.data
                .filter((model: any) => model.modelType==="gemini")
                .map((model: any) => model.enumValue)
              setModels(enumValues)
              setModelsLoaded(true)
            }
          } else {
            console.warn('Failed to fetch Gemini models from API, using defaults')
          }
        } catch (error) {
          console.warn('Error fetching Gemini models:', error)
        } finally {
          setIsLoadingModels(false)
        }
      }

      fetchGeminiModels()
    }
  }, [isVisible, modelsLoaded])
  
  
  const HIDDEN_APPEND_TEXT = "\n\nPlease convert the text output of the previous step in pure textual representation removing any html tags/escape sequences"
  
  
  const getValidModelId = (modelId: string | undefined): string => {
    return models.includes(modelId || "") ? (modelId as string) : (models[0] || "vertex-gemini-2-5-flash")
  }

  
  const getDisplaySystemPrompt = (systemPrompt: string): string => {
    if (systemPrompt.endsWith(HIDDEN_APPEND_TEXT)) {
      return systemPrompt.slice(0, -HIDDEN_APPEND_TEXT.length)
    }
    return systemPrompt
  }

  
  const getFullSystemPrompt = (displayPrompt: string): string => {
    if (displayPrompt.endsWith(HIDDEN_APPEND_TEXT)) {
      return displayPrompt 
    }
    return displayPrompt + HIDDEN_APPEND_TEXT
  }

  const enhanceSystemPrompt = async () => {
    const displayPrompt = getDisplaySystemPrompt(agentConfig.systemPrompt)
    if (!displayPrompt.trim()) {
      alert("Please enter a system prompt first")
      return
    }

    setIsEnhancingPrompt(true)

    try {
      
      const requirements = `Enhance this AI agent system prompt to be more professional, clear, and effective. Make it more structured and comprehensive while preserving the original intent.

Original prompt: "${displayPrompt}"

Please provide an enhanced version that:
1. Is clear and specific about the AI agent's role
2. Includes proper behavioral guidelines  
3. Has clear instructions for output format
4. Maintains the original purpose but makes it more professional

Return only the enhanced system prompt without any additional explanation.`

      
      try {
        
        const url = new URL(
          "/api/v1/agent/generate-prompt",
          window.location.origin,
        )
        url.searchParams.set("requirements", requirements)
        url.searchParams.set("modelId", agentConfig.model)

        let eventSource: EventSource | null = null
        let generatedPrompt = ""

        
        try {
          eventSource = await createAuthEventSource(url.toString())
        } catch (err) {
          console.error("Failed to create EventSource:", err)
          throw new Error("Failed to create EventSource")
        }

        
        await new Promise((resolve, reject) => {
          if (!eventSource) {
            reject(new Error("EventSource not created"))
            return
          }

          eventSource.addEventListener(ChatSSEvents.ResponseUpdate, (event) => {
            generatedPrompt += event.data
          })

          eventSource.addEventListener(ChatSSEvents.End, (event) => {
            try {
              const data = JSON.parse(event.data)
              const finalPrompt = data.fullPrompt || generatedPrompt
              
              if (finalPrompt.trim()) {
                setAgentConfig((prev) => ({
                  ...prev,
                  systemPrompt: getFullSystemPrompt(finalPrompt.trim()),
                }))
                setIsEnhancingPrompt(false)
                eventSource?.close()
                resolve(finalPrompt)
              } else {
                eventSource?.close()
                reject(new Error("No enhanced prompt received from API"))
              }
            } catch (parseError) {
              console.warn("Could not parse end event data:", parseError)
              if (generatedPrompt.trim()) {
                setAgentConfig((prev) => ({
                  ...prev,
                  systemPrompt: getFullSystemPrompt(generatedPrompt.trim()),
                }))
                setIsEnhancingPrompt(false)
                eventSource?.close()
                resolve(generatedPrompt)
              } else {
                eventSource?.close()
                reject(new Error("No enhanced prompt received from API"))
              }
            }
          })

          eventSource.addEventListener(ChatSSEvents.Error, (event) => {
            try {
              const data = JSON.parse(event.data)
              eventSource?.close()
              reject(new Error(data.error || "Error in prompt generation"))
            } catch (parseError) {
              eventSource?.close()
              reject(new Error("Error in prompt generation"))
            }
          })

          eventSource.addEventListener("error", () => {
            eventSource?.close()
            reject(new Error("Connection error during prompt generation"))
          })
        })
        
        
        return
      } catch (error) {
        console.error("Generate prompt API error:", error)

        
        const fallbackEnhancement = `You are a professional ${agentConfig.name.toLowerCase()} AI agent specialized in ${agentConfig.description || "data processing"}.

CORE RESPONSIBILITIES:
${getDisplaySystemPrompt(agentConfig.systemPrompt)}

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
          systemPrompt: getFullSystemPrompt(fallbackEnhancement),
        }))
        setIsEnhancingPrompt(false)
      }
    } catch (error) {
      console.error("Error in enhancePrompt:", error)
      setIsEnhancingPrompt(false)
    }
  }

  const handleSave = async () => {
    try {
      
      const configToSave = {
        ...agentConfig,
        description: agentConfig.description === "some agent description" ? "" : agentConfig.description
      }

      
      if (toolId && !builder) {
        const updatedToolData = {
          type: "ai_agent",
          value: configToSave,
          config: {
            ...toolData?.config,
            model: configToSave.model,
            name: configToSave.name,
            description: configToSave.description,
          },
        }

        await workflowToolsAPI.updateTool(toolId, updatedToolData)
      }

      
      onSave?.(configToSave)
    } catch (error) {
      console.error("Failed to save AI agent configuration:", error)
      
      const configToSave = {
        ...agentConfig,
        description: agentConfig.description === "some agent description" ? "" : agentConfig.description
      }
      onSave?.(configToSave)
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
                  {isLoadingModels ? (
                    <div className="px-3 py-2 text-sm text-slate-500 dark:text-gray-400 flex items-center">
                      <div className="animate-spin w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full mr-2"></div>
                      Loading models...
                    </div>
                  ) : (
                    models.map((model) => (
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
                    ))
                  )}
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
                disabled={isEnhancingPrompt || !getDisplaySystemPrompt(agentConfig.systemPrompt).trim()}
                className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                title="Enhance with AI"
              >
                {isEnhancingPrompt ? (
                  <Loader className="w-5 h-5 animate-spin text-red-500" />
                ) : (
                  <Sparkles className="w-5 h-5 text-red-500" />
                )}
              </button>
            </div>
            <Textarea
              id="system-prompt"
              value={getDisplaySystemPrompt(agentConfig.systemPrompt)}
              onChange={(e) =>
                setAgentConfig((prev) => ({
                  ...prev,
                  systemPrompt: getFullSystemPrompt(e.target.value),
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
            className="w-full bg-gray-900 hover:bg-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 text-white rounded-full"
          >
            Save Configuration
          </Button>
        </div>
      </div>
    </div>
  )
}

export default AIAgentConfigUI
