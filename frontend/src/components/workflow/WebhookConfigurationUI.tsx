import React, { useState, useEffect } from "react"
import { WebhookConfig } from "./Types"
import { BackArrowIcon, CloseIcon } from "./WorkflowIcons"

interface WebhookConfigurationUIProps {
  isVisible: boolean
  onBack?: () => void
  onClose?: () => void
  onSave?: (config: WebhookConfig) => void
  showBackButton?: boolean
  builder?: boolean
  initialConfig?: WebhookConfig
  toolData?: any
  toolId?: string
}

export default function WebhookConfigurationUI({
  isVisible,
  onBack,
  onClose,
  onSave,
  showBackButton = false,
  builder = true,
  initialConfig,
  toolData,
}: WebhookConfigurationUIProps) {
  const [config, setConfig] = useState<WebhookConfig>({
    webhookUrl: "",
    httpMethod: "POST",
    path: "",
    authentication: "none",
    responseMode: "immediately",
    options: {},
    headers: {},
    queryParams: {},
  })

  const [newHeaderKey, setNewHeaderKey] = useState("")
  const [newHeaderValue, setNewHeaderValue] = useState("")
  const [newParamKey, setNewParamKey] = useState("")
  const [newParamValue, setNewParamValue] = useState("")

  // Initialize config from initialConfig or toolData
  useEffect(() => {
    if (initialConfig) {
      setConfig(initialConfig)
    } else if (toolData?.val || toolData?.config) {
      const data = toolData.val || toolData.config
      setConfig({
        webhookUrl: data.webhookUrl || "",
        httpMethod: data.httpMethod || "POST",
        path: data.path || "",
        authentication: data.authentication || "none",
        responseMode: data.responseMode || "immediately",
        options: data.options || {},
        headers: data.headers || {},
        queryParams: data.queryParams || {},
      })
    }
  }, [initialConfig, toolData])

  // Generate webhook URL based on the path
  const generateWebhookUrl = () => {
    const baseUrl = window.location.origin
    const cleanPath = config.path.startsWith('/') ? config.path : `/${config.path}`
    return `${baseUrl}/webhook${cleanPath}`
  }

  const handleSave = () => {
    if (!config.path.trim()) {
      alert("Please enter a webhook path")
      return
    }

    const webhookUrl = generateWebhookUrl()
    const finalConfig: WebhookConfig = {
      ...config,
      webhookUrl,
      path: config.path.startsWith('/') ? config.path : `/${config.path}`
    }

    onSave?.(finalConfig)
  }

  const addHeader = () => {
    if (newHeaderKey.trim() && newHeaderValue.trim()) {
      setConfig(prev => ({
        ...prev,
        headers: {
          ...prev.headers,
          [newHeaderKey]: newHeaderValue
        }
      }))
      setNewHeaderKey("")
      setNewHeaderValue("")
    }
  }

  const removeHeader = (key: string) => {
    setConfig(prev => ({
      ...prev,
      headers: Object.fromEntries(
        Object.entries(prev.headers || {}).filter(([k]) => k !== key)
      )
    }))
  }

  const addQueryParam = () => {
    if (newParamKey.trim() && newParamValue.trim()) {
      setConfig(prev => ({
        ...prev,
        queryParams: {
          ...prev.queryParams,
          [newParamKey]: newParamValue
        }
      }))
      setNewParamKey("")
      setNewParamValue("")
    }
  }

  const removeQueryParam = (key: string) => {
    setConfig(prev => ({
      ...prev,
      queryParams: Object.fromEntries(
        Object.entries(prev.queryParams || {}).filter(([k]) => k !== key)
      )
    }))
  }

  return (
    <div
      className={`fixed top-[80px] right-0 h-[calc(100vh-80px)] bg-white dark:bg-gray-900 border-l border-slate-200 dark:border-gray-700 flex flex-col overflow-hidden transition-all duration-300 ease-in-out z-50 ${
        isVisible ? "translate-x-0 w-[480px]" : "translate-x-full w-0"
      }`}
    >
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-3">
            {showBackButton && onBack && (
              <button
                onClick={onBack}
                className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
              >
                <BackArrowIcon width={20} height={20} />
              </button>
            )}
            <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 tracking-wider uppercase">
              WEBHOOK CONFIGURATION
            </div>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
            >
              <CloseIcon width={16} height={16} />
            </button>
          )}
        </div>
        <div className="text-sm text-slate-500 dark:text-gray-400 leading-5 font-normal">
          Configure your webhook to receive HTTP requests
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {/* Webhook URL Display */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Webhook URL
          </label>
          <div className="p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg">
            <div className="text-sm text-gray-600 dark:text-gray-400 font-mono break-all">
              {config.path ? generateWebhookUrl() : `${window.location.origin}/webhook/your-path`}
            </div>
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            This URL will be generated automatically based on your path
          </div>
        </div>

        {/* HTTP Method */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            HTTP Method
          </label>
          <select
            value={config.httpMethod}
            onChange={(e) => setConfig(prev => ({ ...prev, httpMethod: e.target.value as WebhookConfig['httpMethod'] }))}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="DELETE">DELETE</option>
            <option value="PATCH">PATCH</option>
          </select>
        </div>

        {/* Path */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Path *
          </label>
          <input
            type="text"
            value={config.path}
            onChange={(e) => setConfig(prev => ({ ...prev, path: e.target.value }))}
            placeholder="e.g., /my-webhook or 092dd758-c74d-4526-99df-3d075b4947c0"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          />
          <div className="text-xs text-gray-500 dark:text-gray-400">
            The path where your webhook will be accessible. Use a unique identifier.
          </div>
        </div>

        {/* Authentication */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Authentication
          </label>
          <select
            value={config.authentication}
            onChange={(e) => setConfig(prev => ({ ...prev, authentication: e.target.value as WebhookConfig['authentication'] }))}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            <option value="none">None</option>
            <option value="basic">Basic Auth</option>
            <option value="bearer">Bearer Token</option>
            <option value="api_key">API Key</option>
          </select>
        </div>

        {/* Response Mode */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Response
          </label>
          <select
            value={config.responseMode}
            onChange={(e) => setConfig(prev => ({ ...prev, responseMode: e.target.value as WebhookConfig['responseMode'] }))}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            <option value="immediately">Immediately</option>
            <option value="wait_for_completion">Wait for completion</option>
            <option value="custom">Custom</option>
          </select>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            If you are sending back a response, add a "Content-Type" response header with the appropriate value to avoid unexpected behavior
          </div>
        </div>

        {/* Headers */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Headers
          </label>
          
          {/* Existing Headers */}
          {Object.entries(config.headers || {}).length > 0 && (
            <div className="space-y-2">
              {Object.entries(config.headers || {}).map(([key, value]) => (
                <div key={key} className="flex items-center gap-2">
                  <div className="flex-1 px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg">
                    <span className="text-sm text-gray-900 dark:text-gray-100 font-mono">
                      {key}: {value}
                    </span>
                  </div>
                  <button
                    onClick={() => removeHeader(key)}
                    className="px-2 py-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/50 rounded transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add New Header */}
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                type="text"
                value={newHeaderKey}
                onChange={(e) => setNewHeaderKey(e.target.value)}
                placeholder="Header name"
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              />
              <input
                type="text"
                value={newHeaderValue}
                onChange={(e) => setNewHeaderValue(e.target.value)}
                placeholder="Header value"
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              />
              <button
                onClick={addHeader}
                disabled={!newHeaderKey.trim() || !newHeaderValue.trim()}
                className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
              >
                Add
              </button>
            </div>
          </div>
        </div>

        {/* Query Parameters */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Query Parameters
          </label>
          
          {/* Existing Parameters */}
          {Object.entries(config.queryParams || {}).length > 0 && (
            <div className="space-y-2">
              {Object.entries(config.queryParams || {}).map(([key, value]) => (
                <div key={key} className="flex items-center gap-2">
                  <div className="flex-1 px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg">
                    <span className="text-sm text-gray-900 dark:text-gray-100 font-mono">
                      {key}={value}
                    </span>
                  </div>
                  <button
                    onClick={() => removeQueryParam(key)}
                    className="px-2 py-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/50 rounded transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add New Parameter */}
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                type="text"
                value={newParamKey}
                onChange={(e) => setNewParamKey(e.target.value)}
                placeholder="Parameter name"
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              />
              <input
                type="text"
                value={newParamValue}
                onChange={(e) => setNewParamValue(e.target.value)}
                placeholder="Parameter value"
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              />
              <button
                onClick={addQueryParam}
                disabled={!newParamKey.trim() || !newParamValue.trim()}
                className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
              >
                Add
              </button>
            </div>
          </div>
        </div>

        {/* Options Info */}
        <div className="p-3 bg-blue-50 dark:bg-blue-900/50 border border-blue-200 dark:border-blue-800 rounded-lg">
          <div className="text-sm text-blue-800 dark:text-blue-200">
            <strong>Note:</strong> Once you save this configuration, the webhook will be available at the generated URL and will trigger your workflow when called.
          </div>
        </div>
      </div>

      {/* Footer */}
      {builder && (
        <div className="flex justify-end gap-3 p-6 border-t border-slate-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!config.path.trim()}
            className="px-6 py-2 bg-gray-900 dark:bg-gray-100 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:bg-gray-300 disabled:cursor-not-allowed text-white dark:text-gray-900 rounded-lg transition-colors"
          >
            Save Configuration
          </button>
        </div>
      )}
    </div>
  )
}

export { WebhookConfigurationUI }
export type { WebhookConfig }