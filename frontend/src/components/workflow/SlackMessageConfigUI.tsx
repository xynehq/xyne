import React, { useState, useEffect } from "react"
import { SlackIcon } from "./WorkflowIcons"
import { workflowToolsAPI } from "./api/ApiHandlers"
import { X } from "lucide-react"

export interface SlackMessageConfig {
  channelId: string
  message: string
  title?: string
  description?: string
}

interface SlackMessageConfigUIProps {
  isVisible: boolean
  onBack: () => void
  onClose: () => void
  onSave: (config: SlackMessageConfig) => Promise<void>
  initialConfig?: SlackMessageConfig
  toolId?: string
  showBackButton?: boolean
  builder?: boolean
}

const defaultConfig: SlackMessageConfig = {
  channelId: "",
  message: "",
}

export const SlackMessageConfigUI: React.FC<SlackMessageConfigUIProps> = ({
  isVisible,
  onBack,
  onClose,
  onSave,
  initialConfig,
  showBackButton = false,
  builder = true,
}) => {
  const [config, setConfig] = useState<SlackMessageConfig>(
    initialConfig || defaultConfig,
  )
  const [errors, setErrors] = useState<string[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([])
  const [channelsLoading, setChannelsLoading] = useState(false)
  const [channelInput, setChannelInput] = useState("")
  const [showSuggestions, setShowSuggestions] = useState(false)

  useEffect(() => {
    if (initialConfig) {
      setConfig(initialConfig)
    }
  }, [initialConfig])

  // Fetch channels when component mounts
  useEffect(() => {
    const fetchChannels = async () => {
      try {
        setChannelsLoading(true)
        const metadata = await workflowToolsAPI.fetchSlackMetadata()
        setChannels(metadata.channels)
      } catch (error) {
        console.error("Failed to fetch Slack channels:", error)
        setErrors(["Failed to load channels. Please try again."])
      } finally {
        setChannelsLoading(false)
      }
    }

    if (isVisible) {
      fetchChannels()
    }
  }, [isVisible])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (showSuggestions && !target.closest('.channel-input-container')) {
        setShowSuggestions(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showSuggestions])

  const validateConfig = (): { valid: boolean; errors: string[] } => {
    const validationErrors: string[] = []

    if (!config.channelId) {
      validationErrors.push("Channel selection is required")
    }

    if (!config.message || config.message.trim() === "") {
      validationErrors.push("Message content is required")
    }

    if (config.title && config.title.length > 100) {
      validationErrors.push("Title must be 100 characters or less")
    }

    if (config.description && config.description.length > 500) {
      validationErrors.push("Description must be 500 characters or less")
    }

    if (config.message && config.message.length > 4000) {
      validationErrors.push("Message must be 4000 characters or less")
    }

    return {
      valid: validationErrors.length === 0,
      errors: validationErrors,
    }
  }

  const handleSelectChannel = (channelName: string) => {
    // Normalize channel name (remove # if present)
    const normalizedChannel = channelName.startsWith('#') ? channelName.slice(1) : channelName

    setConfig({
      ...config,
      channelId: normalizedChannel
    })

    setChannelInput("")
    setShowSuggestions(false)
    setErrors([])
  }

  const handleChannelInputChange = (value: string) => {
    setChannelInput(value)
    
    // If input is cleared, clear the selected channel
    if (!value.trim()) {
      setConfig({
        ...config,
        channelId: ""
      })
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Prevent adding channels on Enter - users must select from dropdown
    if (e.key === "Enter") {
      e.preventDefault()
    }
  }

  // Filter channels based on input
  const filteredChannels = channels.filter(channel =>
    channel.name.toLowerCase().includes(channelInput.toLowerCase().replace('#', ''))
  )

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
      console.error("Failed to save Slack message config:", error)
      setErrors(["Failed to save configuration. Please try again."])
    } finally {
      setIsSaving(false)
    }
  }

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
              SLACK MESSAGE
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
        {/* Channel Selection */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-slate-700 dark:text-gray-300 mb-2">
            Select Channel <span className="text-red-500">*</span>
          </label>

          {/* Selected Channel Display */}
          {config.channelId && (
            <div className="mb-2">
              <div className="flex items-center justify-between p-1 bg-gray-50 dark:bg-gray-800 rounded-lg w-fit">
                <div className="text-xs font-medium text-slate-900 dark:text-gray-300">
                  {config.channelId}
                </div>
                <button
                  onClick={() => setConfig({ ...config, channelId: "" })}
                  className="p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
                >
                  <X className="w-4 h-4 text-gray-400 dark:text-gray-500" />
                </button>
              </div>
            </div>
          )}

          {/* Channel Input with Autocomplete */}
          {!config.channelId && (
            <div className="relative channel-input-container">
              <input
                type="text"
                value={channelInput}
                onChange={(e) => handleChannelInputChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => setShowSuggestions(true)}
                placeholder="Type channel name"
                className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-gray-900 dark:text-gray-300"
              />

              {/* Autocomplete Suggestions */}
              {showSuggestions && (
                <div className="absolute z-10 w-full mt-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                  {/* Channel Suggestions */}
                  {channelsLoading ? (
                    <div className="px-3 py-4 text-center text-sm text-gray-500 dark:text-gray-400">
                      Loading channels...
                    </div>
                  ) : filteredChannels.length === 0 ? (
                    <div className="px-3 py-4 text-center text-sm text-gray-500 dark:text-gray-400">
                      No matching channels
                    </div>
                  ) : (
                    filteredChannels.slice(0, 10).map((channel) => (
                      <button
                        key={channel.id}
                        onClick={() => handleSelectChannel(channel.name)}
                        className="w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                      >
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          #{channel.name}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Message Content */}
        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-gray-300 mb-2">
            Message <span className="text-red-500">*</span>
          </label>
          <textarea
            value={config.message}
            onChange={(e) => setConfig({ ...config, message: e.target.value })}
            placeholder="Enter the message to send to the channel..."
            maxLength={4000}
            rows={5}
            className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-gray-900 dark:text-gray-300 resize-none"
          />
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {config.message.length}/4000 characters
          </div>
        </div>

        {/* Title Input (Optional) */}
        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-gray-300 mb-2">
            Title <span className="text-sm font-medium text-slate-700 dark:text-gray-300">(Optional)</span>
          </label>
          <input
            type="text"
            value={config.title || ""}
            onChange={(e) => setConfig({ ...config, title: e.target.value })}
            placeholder="e.g., 'Send Notification'"
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
            placeholder="e.g., 'Sends notification message to team channel'"
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
            {isSaving ? "Saving..." : "Save Message Configuration"}
          </button>
        )}
      </div>
    </div>
  )
}

export default SlackMessageConfigUI
