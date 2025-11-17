import React, { useState, useEffect } from "react"
import { SlackIcon } from "../WorkflowIcons"
import SlackChannelInput from "./SlackChannlesInput"


export interface SlackTriggerConfig {
  triggerType: "app_mention" | "direct_message" 
  channelIds?: string[]
  title?: string
  description?: string
}

interface SlackTriggerConfigUIProps {
  isVisible: boolean
  onBack: () => void
  onClose: () => void
  onSave: (config: SlackTriggerConfig) => Promise<void>
  initialConfig?: SlackTriggerConfig
  toolId?: string
  showBackButton?: boolean
  builder?: boolean
}

const defaultConfig: SlackTriggerConfig = {
  triggerType: "app_mention",
}

const triggerTypeOptions = [
  {
    value: "app_mention" as const,
    label: "App Mention",
    description: "When bot/app is mentioned in channel with @botname",
  },
  {
    value: "direct_message" as const,
    label: "Direct Message (DM)",
    description: "When a user sends a direct message to the bot",
  },
]

export const SlackTriggerConfigUI: React.FC<SlackTriggerConfigUIProps> = ({
  isVisible,
  onBack,
  onClose,
  onSave,
  initialConfig,
  showBackButton = false,
  builder = true,
}) => {
  const [config, setConfig] = useState<SlackTriggerConfig>(
    initialConfig || defaultConfig,
  )
  const [errors, setErrors] = useState<string[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)

  useEffect(() => {
    if (initialConfig) {
      setConfig(initialConfig)
    }
  }, [initialConfig])



  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (showSuggestions && !target.closest('.channel-input-container')) {
        setShowSuggestions(false)
      }
      if (dropdownOpen && !target.closest('.trigger-dropdown-container')) {
        setDropdownOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showSuggestions, dropdownOpen])

  const validateConfig = (): { valid: boolean; errors: string[] } => {
    const validationErrors: string[] = []

    if (!config.triggerType) {
      validationErrors.push("Trigger type is required")
    }

    if (config.triggerType === "app_mention") {
      if (!config.channelIds || config.channelIds.length === 0) {
        validationErrors.push(
          "At least one channel is required for 'App Mention' trigger",
        )
      }
    }

    if (config.title && config.title.length > 100) {
      validationErrors.push("Title must be 100 characters or less")
    }

    if (config.description && config.description.length > 500) {
      validationErrors.push("Description must be 500 characters or less")
    }

    return {
      valid: validationErrors.length === 0,
      errors: validationErrors,
    }
  }
 

  const handleSave = async () => {
    const validation = validateConfig()

    if (!validation.valid) {
      setErrors(validation.errors)
      return
    }

    setIsSaving(true)
    setErrors([])

    try {
      await onSave(config)
    } catch (error) {
      console.error("Failed to save Slack trigger config:", error)
      setErrors(["Failed to save configuration. Please try again."])
    } finally {
      setIsSaving(false)
    }
  }

  const selectedOption = triggerTypeOptions.find(
    (opt) => opt.value === config.triggerType,
  )

  if (!isVisible) return null

  return (
    <div className="fixed top-[80px] right-0 h-[calc(100vh-80px)] bg-white dark:bg-gray-900 border-l border-slate-200 dark:border-gray-700 flex flex-col overflow-hidden z-50 w-[380px] shadow-xl">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-3">
            {showBackButton && (
              <button
                onClick={onBack}
                className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
              >
                <svg
                  className="w-4 h-4 text-gray-500 dark:text-gray-400"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
              </button>
            )}
            <SlackIcon width={20} height={20} />
            <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 tracking-wider uppercase">
              SLACK TRIGGER
            </div>
          </div>
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
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
        {/* Trigger Type Dropdown */}
        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-gray-300 mb-2">
            Trigger Type <span className="text-red-500">*</span>
          </label>
          <div className="relative trigger-dropdown-container">
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="w-full px-3 py-2.5 text-left bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:border-gray-400 dark:hover:border-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div>
                    <div className="text-sm font-medium text-slate-700 dark:text-gray-300">
                      {selectedOption?.label}
                    </div>
                  </div>
                </div>
                <svg
                  className={`w-4 h-4 text-gray-400 transition-transform ${
                    dropdownOpen ? "rotate-180" : ""
                  }`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
            </button>

            {/* Dropdown Menu */}
            {dropdownOpen && (
              <div className="absolute z-10 w-full mt-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg overflow-hidden">
                {triggerTypeOptions.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => {
                      setConfig({ ...config, triggerType: option.value })
                      setDropdownOpen(false)
                      setErrors([])
                    }}
                    className={`w-full px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
                      config.triggerType === option.value
                        ? "bg-blue-50 dark:bg-blue-900/20"
                        : ""
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="flex-1">
                        <div className="text-xs font-medium text-gray-900 dark:text-gray-100 flex items-center gap-2">
                          {option.label}
                          {config.triggerType === option.value && (
                            <svg
                              className="w-3 h-3 text-blue-600"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <polyline points="20 6 9 17 4 12"></polyline>
                            </svg>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {option.description}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Channel Input (Conditional) */}
        {config.triggerType === "app_mention" && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-700 dark:text-gray-300 mb-2">
              Add Channels <span className="text-red-500">*</span>
            </label>

            <SlackChannelInput
              selectedChannels={config.channelIds || []}
              onChannelsChange={(channelIds) => {
                setConfig({ ...config, channelIds: channelIds })
                setErrors([])
              }}
              allowAll={true}
              placeholder="Type channel name or 'all'"
            />
          </div>
        )}

        {/* Title Input (Optional) */}
        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-gray-300 mb-2">
            Title <span className="text-sm font-medium text-slate-700 dark:text-gray-300">(Optional)</span>
          </label>
          <input
            type="text"
            value={config.title || ""}
            onChange={(e) => setConfig({ ...config, title: e.target.value })}
            placeholder="e.g., 'Support Request Trigger'"
            maxLength={100}
            className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm font-medium text-slate-700 dark:text-gray-300"
          />
        </div>

        {/* Description Textarea (Optional) */}
        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-gray-300 mb-2">
            Description{" "}
            <span className="text-sm font-medium text-slate-700 dark:text-gray-300">(Optional)</span>
          </label>
          <textarea
            value={config.description || ""}
            onChange={(e) =>
              setConfig({ ...config, description: e.target.value })
            }
            placeholder="e.g., 'Triggers when users request support via Slack'"
            maxLength={500}
            rows={3}
            className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm font-medium text-slate-700 dark:text-gray-300 resize-none"
          />
        </div>

        {/* Error Messages */}
        {errors.length > 0 && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
            <div className="flex items-start gap-2">
              <svg
                className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <div className="flex-1">
                <h4 className="text-sm font-medium text-red-800 dark:text-red-300 mb-1">
                  Validation Errors
                </h4>
                <ul className="list-disc list-inside space-y-1">
                  {errors.map((error, index) => (
                    <li
                      key={index}
                      className="text-sm text-red-700 dark:text-red-400"
                    >
                      {error}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer with Action Buttons */}
      <div className="px-6 py-4 border-t border-slate-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
        {builder && (
          <button
            onClick={handleSave}
            disabled={isSaving}
            className={`w-full bg-gray-900 hover:bg-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 text-white rounded-full px-6 py-2 text-sm transition-all ${
              isSaving
                ? "opacity-50 cursor-not-allowed"
                : "cursor-pointer"
            }`}
          >
            {isSaving ? "Saving..." : "Save Trigger Configuration"}
          </button>
        )}
      </div>
    </div>
  )
}

export default SlackTriggerConfigUI
