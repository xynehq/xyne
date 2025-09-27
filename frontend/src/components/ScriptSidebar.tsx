import React, { useState, useEffect } from "react"
import { X, ChevronDown, ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { api } from "@/api"
import { CodeEditor } from "./CodeEditor"
import { workflowStepsAPI, workflowToolsAPI } from "./workflow/api/ApiHandlers"

interface ScriptLanguage {
  language: string
  codeWritingBlock: string
}

interface ScriptSidebarProps {
  isOpen: boolean
  onClose: () => void
  onBack?: () => void // Back button callback
  onCodeSaved?: (language: string, code: string) => void
  zIndex?: number
  // Workflow integration props
  selectedNodeId?: string | null
  selectedTemplate?: any
  onStepCreated?: (stepData: any) => void
  initialData?: any // Script tool data for editing existing scripts
  onToolUpdated?: (nodeId: string, updatedTool: any) => void // Callback when tool is updated
  showBackButton?: boolean // Show back button flag
}

export const ScriptSidebar: React.FC<ScriptSidebarProps> = ({
  isOpen,
  onClose,
  onBack,
  onCodeSaved,
  zIndex = 50,
  selectedNodeId,
  selectedTemplate,
  onStepCreated,
  initialData,
  onToolUpdated,
  showBackButton = false,
}) => {
  const [languages, setLanguages] = useState<ScriptLanguage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedLanguage, setSelectedLanguage] = useState<string>("")
  const [code, setCode] = useState<string>("")
  const [config, setConfig] = useState<string>("{}")
  const [savedCodes, setSavedCodes] = useState<Record<string, string>>({})
  const [savedConfigs, setSavedConfigs] = useState<Record<string, string>>({})
  const [isLanguageDropdownOpen, setIsLanguageDropdownOpen] = useState(false)
  const [isCodeEditorOpen, setIsCodeEditorOpen] = useState(false)
  const [isConfigEditorOpen, setIsConfigEditorOpen] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)

  const fetchLanguages = async () => {
    try {
      setIsLoading(true)
      setError(null)
      const response = await api.workflow.script.languages.$get()
      
      if (!response.ok) {
        throw new Error("Failed to fetch script languages")
      }
      
      const data = await response.json()
      setLanguages(data.availableLanguages)
      
      // Only set default language and code if we don't have initial data
      if (data.availableLanguages.length > 0 && !initialData) {
        const defaultLang = data.availableLanguages[0]
        setSelectedLanguage(defaultLang.language)
        setCode(defaultLang.codeWritingBlock)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load languages")
      console.error("Error fetching script languages:", err)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (isOpen) {
      fetchLanguages()
    } else {
      // Reset state when sidebar closes
      setSelectedLanguage("")
      setCode("")
      setConfig("{}")
      setSavedCodes({})
      setSavedConfigs({})
      setConfigError(null)
    }
  }, [isOpen])

  // Handle initial data for editing existing script nodes
  useEffect(() => {
    if (isOpen && languages.length > 0 && initialData && (initialData.value || initialData.val)) {
      // Try to get data from value first, then val for backward compatibility
      const scriptData = initialData.value || initialData.val
      const { script, language, config } = scriptData
      
      if (language) {
        setSelectedLanguage(language)
      }
      if (script) {
        setCode(script)
        setSavedCodes(prev => ({
          ...prev,
          [language || ""]: script
        }))
      }
      if (config) {
        const configString = typeof config === "string" ? config : JSON.stringify(config, null, 2)
        setConfig(configString)
        setSavedConfigs(prev => ({
          ...prev,
          [language || ""]: configString
        }))
      }
    }
  }, [isOpen, languages, initialData])

  // Handle language change
  const handleLanguageChange = (newLanguage: string) => {
    // Save current code and config before switching
    if (selectedLanguage) {
      if (code) {
        setSavedCodes(prev => ({
          ...prev,
          [selectedLanguage]: code
        }))
      }
      if (config && config !== "{}") {
        setSavedConfigs(prev => ({
          ...prev,
          [selectedLanguage]: config
        }))
      }
    }

    setSelectedLanguage(newLanguage)
    setIsLanguageDropdownOpen(false)

    // Load saved code or default template for new language
    const savedCode = savedCodes[newLanguage]
    if (savedCode) {
      setCode(savedCode)
    } else {
      const languageData = languages.find(lang => lang.language === newLanguage)
      setCode(languageData?.codeWritingBlock || "")
    }

    // Load saved config or default for new language
    const savedConfig = savedConfigs[newLanguage]
    setConfig(savedConfig || "{}")
    setConfigError(null)
  }

  // Handle opening Monaco editor
  const handleOpenCodeEditor = () => {
    setIsCodeEditorOpen(true)
  }

  // Handle opening config editor
  const handleOpenConfigEditor = () => {
    setIsConfigEditorOpen(true)
  }

  // Handle Monaco editor save
  const handleCodeEditorSave = (newCode: string) => {
    setCode(newCode)
    // Save to the current language's saved codes
    setSavedCodes(prev => ({
      ...prev,
      [selectedLanguage]: newCode
    }))
  }

  // Validate JSON
  const validateJSON = (jsonString: string): boolean => {
    try {
      JSON.parse(jsonString)
      return true
    } catch {
      return false
    }
  }

  // Handle config editor save
  const handleConfigEditorSave = (newConfig: string) => {
    if (validateJSON(newConfig)) {
      setConfig(newConfig)
      setConfigError(null)
      // Save to the current language's saved configs
      setSavedConfigs(prev => ({
        ...prev,
        [selectedLanguage]: newConfig
      }))
    } else {
      setConfigError("Invalid JSON format. Please check your syntax.")
    }
  }

  // Handle save configuration
  const handleSave = async () => {
    // Validate config before saving
    if (!validateJSON(config)) {
      setConfigError("Invalid JSON format. Please fix the configuration before saving.")
      return
    }

    // Save current code and config
    setSavedCodes(prev => ({
      ...prev,
      [selectedLanguage]: code
    }))
    
    setSavedConfigs(prev => ({
      ...prev,
      [selectedLanguage]: config
    }))
    
    // Call parent callback with both code and config
    onCodeSaved?.(selectedLanguage, code)
    
    // Prepare script tool payload
    const scriptData = {
      script: code,
      language: selectedLanguage,
      config: JSON.parse(config)
    }
    const scriptToolPayload = {
      type: "script",
      value: scriptData,
      val: scriptData, // Ensure both value and val are updated for consistency
      config: {
        language: selectedLanguage,
        timeout: 300,
      }
    }

    // If we have initialData, this is editing an existing tool
    if (initialData && initialData.id) {
      // Always update the visual node first
      if (onToolUpdated && selectedNodeId) {
        const updatedTool = {
          ...initialData,
          ...scriptToolPayload,
        }
        onToolUpdated(selectedNodeId, updatedTool)
      }

      // Try to update API only if we have a template (not in blank mode)
      if (selectedTemplate) {
        try {
          const response = await workflowToolsAPI.updateTool(initialData.id, scriptToolPayload)
          
          // Update with any additional data from API response
          if (onToolUpdated && selectedNodeId && response?.data?.tool) {
            const updatedToolWithResponse = {
              ...initialData,
              ...scriptToolPayload,
              ...response.data.tool
            }
            onToolUpdated(selectedNodeId, updatedToolWithResponse)
          }
        } catch (error) {
          console.error("Failed to update script tool in API:", error)
          // Don't return early - visual update already happened
        }
      }
      
      // Close the sidebar after update
      onClose()
      return
    }
    
    // Create workflow step if in workflow context (for new scripts)
    if (selectedNodeId && onStepCreated && !initialData) {
      try {
        const stepData = {
          name: "Script",
          description: `${selectedLanguage.charAt(0).toUpperCase() + selectedLanguage.slice(1)} script execution`,
          type: "script",
          tool: {
            id: `script-tool-${Date.now()}`, // Generate a unique ID for the tool
            type: "script",
            value: {
              script: code,
              config: JSON.parse(config),
              language: selectedLanguage
            },
            val: {
              script: code,
              config: JSON.parse(config),
              language: selectedLanguage
            },
            config: {
              language: selectedLanguage,
              timeout: 300,
            }
          },
          prevStepIds: [selectedNodeId],
          timeEstimate: 180,
          metadata: {
            icon: "📜",
            step_order: 999,
            automated_description: `${selectedLanguage} script execution`,
          },
        }

        // Call callback to create visual step FIRST
        onStepCreated(stepData)

        // Try to save to API if template is available, but don't block UI updates
        if (selectedTemplate) {
          try {
            await workflowStepsAPI.createStep(
              selectedTemplate.id,
              stepData,
            )
          } catch (error) {
            console.error("Failed to save step to API:", error)
            // Continue with UI update even if API call fails
          }
        }
      } catch (error) {
        console.error("Failed to create workflow step:", error)
      }
    }
    
    onClose()
  }

  if (!isOpen) return null

  return (
    <>
      <div
        className={`fixed top-[80px] right-0 h-[calc(100vh-80px)] bg-white dark:bg-gray-900 border-l border-slate-200 dark:border-gray-700 flex flex-col overflow-hidden ${
          isOpen ? "translate-x-0 w-[380px]" : "translate-x-full w-0"
        }`}
        style={{ zIndex }}
      >
        {/* Header */}
        <div className="flex items-center border-b px-6 py-5 gap-3">
          {showBackButton && onBack && (
            <button
              onClick={onBack}
              className="flex items-center justify-center w-6 h-6 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
            >
              <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            </button>
          )}
          <h2 className="flex-1 text-gray-900 dark:text-gray-100 font-semibold text-base">
            Run Script
          </h2>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-6 h-6 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
          >
            <X className="w-4 h-4 text-gray-600 dark:text-gray-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin w-6 h-6 border-2 border-gray-300 border-t-gray-600 rounded-full"></div>
              <span className="ml-2 text-gray-600 dark:text-gray-400">Loading languages...</span>
            </div>
          ) : error ? (
            <div className="py-8 text-center">
              <p className="text-red-500 mb-4">{error}</p>
              <Button
                onClick={fetchLanguages}
                variant="outline"
                className="text-sm"
              >
                Try Again
              </Button>
            </div>
          ) : (
            <div className="space-y-6 flex-1">
              {/* Language Selection */}
              <div className="space-y-2">
                <Label className="text-sm font-medium text-slate-700 dark:text-gray-300">
                  Select Language
                </Label>
                <div className="relative">
                  <button
                    onClick={() => setIsLanguageDropdownOpen(!isLanguageDropdownOpen)}
                    className="w-full h-10 px-3 py-2 bg-white dark:bg-gray-800 border border-slate-200 dark:border-gray-600 rounded-md text-sm text-left flex items-center justify-between focus:outline-none focus:ring-1 focus:ring-slate-400 dark:focus:ring-gray-500 focus:border-slate-400 dark:focus:border-gray-500"
                  >
                    <span className="text-slate-900 dark:text-gray-300 capitalize">
                      {selectedLanguage || "Select a language"}
                    </span>
                    <ChevronDown
                      className={`w-4 h-4 text-slate-500 dark:text-gray-400 transition-transform ${
                        isLanguageDropdownOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>

                  {isLanguageDropdownOpen && (
                    <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-white dark:bg-gray-800 border border-slate-200 dark:border-gray-600 rounded-md shadow-lg max-h-48 overflow-y-auto">
                      {languages.map((lang) => (
                        <button
                          key={lang.language}
                          onClick={() => handleLanguageChange(lang.language)}
                          className="w-full px-3 py-2 text-sm text-left hover:bg-slate-50 dark:hover:bg-gray-700 text-slate-900 dark:text-gray-300 capitalize"
                        >
                          {lang.language}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <p className="text-xs text-slate-500 dark:text-gray-400">
                  Choose the programming language for your script
                </p>
              </div>

              {/* Code Editor */}
              <div className="space-y-2">
                <Label className="text-sm font-medium text-slate-700 dark:text-gray-300">
                  Code
                </Label>
                <div 
                  className="border border-gray-300 dark:border-gray-600 rounded-md cursor-pointer hover:border-blue-500 dark:hover:border-blue-400 transition-colors"
                  onClick={handleOpenCodeEditor}
                >
                  <pre className="p-3 bg-gray-50 dark:bg-gray-900 text-sm font-mono text-gray-800 dark:text-gray-200 whitespace-pre-wrap max-h-48 overflow-y-auto">
                    {code || `// Click to edit ${selectedLanguage || "code"}`}
                  </pre>
                </div>
                <p className="text-xs text-slate-500 dark:text-gray-400">
                  Click to open the editor
                </p>
              </div>

              {/* Config Editor */}
              <div className="space-y-2">
                <Label className="text-sm font-medium text-slate-700 dark:text-gray-300">
                  Config
                </Label>
                <div 
                  className={`border rounded-md cursor-pointer transition-colors ${
                    configError 
                      ? "border-red-500 dark:border-red-400" 
                      : "border-gray-300 dark:border-gray-600 hover:border-blue-500 dark:hover:border-blue-400"
                  }`}
                  onClick={handleOpenConfigEditor}
                >
                  <div className="flex items-center justify-between p-2 border-b border-gray-200 dark:border-gray-700">
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      json
                    </span>
                  </div>
                  <pre className="p-3 bg-gray-50 dark:bg-gray-900 text-sm font-mono text-gray-800 dark:text-gray-200 whitespace-pre-wrap max-h-32 overflow-y-auto">
                    {config || "{}"}
                  </pre>
                </div>
                {configError && (
                  <p className="text-xs text-red-500">{configError}</p>
                )}
                {!configError && (
                  <p className="text-xs text-slate-500 dark:text-gray-400">
                    Click to open the JSON editor
                  </p>
                )}
              </div>
            </div>
          )}
          
          {/* Save Button - Sticky to bottom */}
          {!isLoading && !error && (
            <div className="pt-6 px-0">
              <Button
                onClick={handleSave}
                disabled={!selectedLanguage}
                className="w-full bg-gray-900 hover:bg-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 text-white rounded-full"
              >
                Save Configuration
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Code Editor - Full Screen */}
      <CodeEditor
        isOpen={isCodeEditorOpen}
        onClose={() => setIsCodeEditorOpen(false)}
        language={selectedLanguage}
        initialValue={code}
        onChange={setCode}
        onSave={handleCodeEditorSave}
      />

      {/* Config Editor - Full Screen */}
      <CodeEditor
        isOpen={isConfigEditorOpen}
        onClose={() => setIsConfigEditorOpen(false)}
        language="json"
        initialValue={config}
        onChange={setConfig}
        onSave={handleConfigEditorSave}
      />
    </>
  )
}