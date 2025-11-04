import React, { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ArrowLeft, X, Trash2, Plus, AlertCircle, CheckCircle } from "lucide-react"
import { workflowToolsAPI } from "./api/ApiHandlers"

interface HttpRequestConfigUIProps {
  isVisible: boolean
  onBack: () => void
  onClose?: () => void
  onSave?: (httpConfig: HttpRequestConfig) => void
  toolData?: any
  toolId?: string
  stepData?: any
  showBackButton?: boolean
  builder?: boolean
}

export interface HttpRequestConfig {
  url: string
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
  headers?: Record<string, string>
  queryParams?: Record<string, string>
  body?: string
  bodyType?: "json" | "form" | "raw"
  authentication?: "none" | "basic" | "bearer" | "api_key"
  authConfig?: {
    username?: string
    password?: string
    token?: string
    apiKey?: string
    apiKeyHeader?: string
  }
  timeout?: number
  followRedirects?: boolean
  title?: string
}

const HttpRequestConfigUI: React.FC<HttpRequestConfigUIProps> = ({
  isVisible,
  onBack,
  onClose,
  onSave,
  toolData,
  toolId,
  stepData,
  showBackButton = false,
  builder = true, // Indicates if component is used in workflow builder
}) => {
  const [httpConfig, setHttpConfig] = useState<HttpRequestConfig>({
    url: "",
    method: "GET",
    headers: {},
    queryParams: {},
    body: "",
    bodyType: "json",
    authentication: "none",
    authConfig: {},
    timeout: 30000,
    followRedirects: true,
    title: "",
  })

  const [newHeaderKey, setNewHeaderKey] = useState("")
  const [newHeaderValue, setNewHeaderValue] = useState("")
  const [newParamKey, setNewParamKey] = useState("")
  const [newParamValue, setNewParamValue] = useState("")
  const [urlValidationError, setUrlValidationError] = useState<string | null>(null)
  const [isUrlValid, setIsUrlValid] = useState<boolean>(false)
  const [isSaving, setIsSaving] = useState(false)

  // URL validation
  const validateUrl = (url: string): { isValid: boolean; error: string | null } => {
    if (!url.trim()) {
      return { isValid: false, error: "URL is required" }
    }
    
    try {
      new URL(url)
      return { isValid: true, error: null }
    } catch {
      return { isValid: false, error: "Please enter a valid URL" }
    }
  }

  // Load existing configuration
  useEffect(() => {
    if (toolData) {
      // Handle different data structures: value, val, or config
      const existingConfig = toolData.value || toolData.val || toolData.config || {}
      
      // Also check if there's additional config in toolData.config for auth settings
      const additionalConfig = toolData.config || {}
      
      setHttpConfig(prevConfig => ({
        ...prevConfig,
        ...existingConfig,
        // Merge any additional auth config
        ...(additionalConfig.authConfig && { authConfig: { ...prevConfig.authConfig, ...additionalConfig.authConfig } }),
        ...(additionalConfig.authentication && { authentication: additionalConfig.authentication }),
        ...(additionalConfig.timeout && { timeout: additionalConfig.timeout }),
        ...(additionalConfig.followRedirects !== undefined && { followRedirects: additionalConfig.followRedirects }),
      }))
    } else if (stepData?.config) {
      setHttpConfig(prevConfig => ({
        ...prevConfig,
        ...stepData.config,
      }))
    }
  }, [toolData, stepData])

  // Validate URL on change
  useEffect(() => {
    const validation = validateUrl(httpConfig.url)
    setUrlValidationError(validation.error)
    setIsUrlValid(validation.isValid)
  }, [httpConfig.url])

  const handleConfigChange = (field: keyof HttpRequestConfig, value: any) => {
    setHttpConfig(prev => ({
      ...prev,
      [field]: value,
    }))
  }

  const handleAddHeader = () => {
    if (newHeaderKey.trim() && newHeaderValue.trim()) {
      setHttpConfig(prev => ({
        ...prev,
        headers: {
          ...prev.headers,
          [newHeaderKey.trim()]: newHeaderValue.trim(),
        },
      }))
      setNewHeaderKey("")
      setNewHeaderValue("")
    }
  }

  const handleRemoveHeader = (key: string) => {
    setHttpConfig(prev => {
      const newHeaders = { ...prev.headers }
      delete newHeaders[key]
      return {
        ...prev,
        headers: newHeaders,
      }
    })
  }

  const handleAddQueryParam = () => {
    if (newParamKey.trim() && newParamValue.trim()) {
      setHttpConfig(prev => ({
        ...prev,
        queryParams: {
          ...prev.queryParams,
          [newParamKey.trim()]: newParamValue.trim(),
        },
      }))
      setNewParamKey("")
      setNewParamValue("")
    }
  }

  const handleRemoveQueryParam = (key: string) => {
    setHttpConfig(prev => {
      const newParams = { ...prev.queryParams }
      delete newParams[key]
      return {
        ...prev,
        queryParams: newParams,
      }
    })
  }

  const handleSave = async () => {
    if (!isUrlValid) {
      return
    }

    setIsSaving(true)
    try {
      if (onSave) {
        await onSave(httpConfig)
      } else if (toolId) {
        // Update existing tool
        await workflowToolsAPI.updateHttpRequestConfig(toolId, httpConfig)
      } else {
        // Create new tool
        await workflowToolsAPI.saveHttpRequestConfig(httpConfig)
      }
    } catch (error) {
      console.error("Failed to save HTTP request configuration:", error)
    } finally {
      setIsSaving(false)
    }
  }

  if (!isVisible) return null

  return (
    <div className="fixed top-[80px] right-0 h-[calc(100vh-80px)] bg-white dark:bg-gray-900 border-l border-slate-200 dark:border-gray-700 flex flex-col overflow-hidden z-50 w-[380px]">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-1.5">
          {showBackButton && (
            <button
              onClick={onBack}
              className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors mr-2"
            >
              <ArrowLeft className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            </button>
          )}
          <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 tracking-wider uppercase flex-1">
            HTTP REQUEST
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
          >
            <X className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          </button>
        </div>
        <div className="text-sm text-slate-500 dark:text-gray-400 leading-5 font-normal">
          Configure HTTP request parameters
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {/* Title */}
        <div className="space-y-2">
          <Label htmlFor="title" className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Title (Optional)
          </Label>
          <Input
            id="title"
            value={httpConfig.title}
            onChange={(e) => handleConfigChange("title", e.target.value)}
            placeholder="e.g., Get User Data"
            className="w-full"
          />
        </div>

        {/* URL */}
        <div className="space-y-2">
          <Label htmlFor="url" className="text-sm font-medium text-gray-700 dark:text-gray-300">
            URL *
          </Label>
          <div className="relative">
            <Input
              id="url"
              value={httpConfig.url}
              onChange={(e) => handleConfigChange("url", e.target.value)}
              placeholder="https://api.example.com/endpoint"
              className={`w-full pr-8 ${urlValidationError ? "border-red-500" : isUrlValid ? "border-green-500" : ""}`}
            />
            {urlValidationError && (
              <AlertCircle className="absolute right-2 top-1/2 transform -translate-y-1/2 w-4 h-4 text-red-500" />
            )}
            {isUrlValid && (
              <CheckCircle className="absolute right-2 top-1/2 transform -translate-y-1/2 w-4 h-4 text-green-500" />
            )}
          </div>
          {urlValidationError && (
            <p className="text-sm text-red-600 dark:text-red-400">{urlValidationError}</p>
          )}
        </div>

        {/* Method */}
        <div className="space-y-2">
          <Label htmlFor="method" className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Method
          </Label>
          <Select value={httpConfig.method} onValueChange={(value) => handleConfigChange("method", value)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="GET">GET</SelectItem>
              <SelectItem value="POST">POST</SelectItem>
              <SelectItem value="PUT">PUT</SelectItem>
              <SelectItem value="DELETE">DELETE</SelectItem>
              <SelectItem value="PATCH">PATCH</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Headers */}
        <div className="space-y-2">
          <Label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Headers
          </Label>
          <div className="space-y-2">
            {Object.entries(httpConfig.headers || {}).map(([key, value]) => (
              <div key={key} className="flex items-center gap-2">
                <Input value={key} readOnly className="flex-1" />
                <Input value={value} readOnly className="flex-1" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleRemoveHeader(key)}
                  className="p-2"
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Input
                placeholder="Header name"
                value={newHeaderKey}
                onChange={(e) => setNewHeaderKey(e.target.value)}
                className="flex-1"
              />
              <Input
                placeholder="Header value"
                value={newHeaderValue}
                onChange={(e) => setNewHeaderValue(e.target.value)}
                className="flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleAddHeader}
                disabled={!newHeaderKey.trim() || !newHeaderValue.trim()}
                className="p-2"
              >
                <Plus className="w-3 h-3" />
              </Button>
            </div>
          </div>
        </div>

        {/* Query Parameters */}
        <div className="space-y-2">
          <Label className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Query Parameters
          </Label>
          <div className="space-y-2">
            {Object.entries(httpConfig.queryParams || {}).map(([key, value]) => (
              <div key={key} className="flex items-center gap-2">
                <Input value={key} readOnly className="flex-1" />
                <Input value={value} readOnly className="flex-1" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleRemoveQueryParam(key)}
                  className="p-2"
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Input
                placeholder="Parameter name"
                value={newParamKey}
                onChange={(e) => setNewParamKey(e.target.value)}
                className="flex-1"
              />
              <Input
                placeholder="Parameter value"
                value={newParamValue}
                onChange={(e) => setNewParamValue(e.target.value)}
                className="flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleAddQueryParam}
                disabled={!newParamKey.trim() || !newParamValue.trim()}
                className="p-2"
              >
                <Plus className="w-3 h-3" />
              </Button>
            </div>
          </div>
        </div>

        {/* Request Body for POST, PUT, PATCH */}
        {["POST", "PUT", "PATCH"].includes(httpConfig.method) && (
          <>
            <div className="space-y-2">
              <Label htmlFor="bodyType" className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Body Type
              </Label>
              <Select value={httpConfig.bodyType} onValueChange={(value) => handleConfigChange("bodyType", value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="json">JSON</SelectItem>
                  <SelectItem value="form">Form Data</SelectItem>
                  <SelectItem value="raw">Raw</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="body" className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Request Body
              </Label>
              <Textarea
                id="body"
                value={httpConfig.body}
                onChange={(e) => handleConfigChange("body", e.target.value)}
                placeholder={
                  httpConfig.bodyType === "json"
                    ? '{"key": "value"}'
                    : httpConfig.bodyType === "form"
                    ? "key1=value1&key2=value2"
                    : "Raw request body"
                }
                rows={6}
                className="w-full font-mono text-sm"
              />
            </div>
          </>
        )}

        {/* Authentication */}
        <div className="space-y-2">
          <Label htmlFor="auth" className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Authentication
          </Label>
          <Select value={httpConfig.authentication} onValueChange={(value) => handleConfigChange("authentication", value)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="basic">Basic Auth</SelectItem>
              <SelectItem value="bearer">Bearer Token</SelectItem>
              <SelectItem value="api_key">API Key</SelectItem>
            </SelectContent>
          </Select>

          {/* Auth Configuration */}
          {httpConfig.authentication === "basic" && (
            <div className="space-y-2 mt-2">
              <Input
                placeholder="Username"
                value={httpConfig.authConfig?.username || ""}
                onChange={(e) => handleConfigChange("authConfig", { ...httpConfig.authConfig, username: e.target.value })}
              />
              <Input
                type="password"
                placeholder="Password"
                value={httpConfig.authConfig?.password || ""}
                onChange={(e) => handleConfigChange("authConfig", { ...httpConfig.authConfig, password: e.target.value })}
              />
            </div>
          )}

          {httpConfig.authentication === "bearer" && (
            <div className="mt-2">
              <Input
                placeholder="Bearer Token"
                value={httpConfig.authConfig?.token || ""}
                onChange={(e) => handleConfigChange("authConfig", { ...httpConfig.authConfig, token: e.target.value })}
              />
            </div>
          )}

          {httpConfig.authentication === "api_key" && (
            <div className="space-y-2 mt-2">
              <Input
                placeholder="API Key Header (e.g., X-API-Key)"
                value={httpConfig.authConfig?.apiKeyHeader || ""}
                onChange={(e) => handleConfigChange("authConfig", { ...httpConfig.authConfig, apiKeyHeader: e.target.value })}
              />
              <Input
                placeholder="API Key Value"
                value={httpConfig.authConfig?.apiKey || ""}
                onChange={(e) => handleConfigChange("authConfig", { ...httpConfig.authConfig, apiKey: e.target.value })}
              />
            </div>
          )}
        </div>

        {/* Advanced Options */}
        <div className="space-y-2">
          <Label htmlFor="timeout" className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Timeout (ms)
          </Label>
          <Input
            id="timeout"
            type="number"
            value={httpConfig.timeout}
            onChange={(e) => handleConfigChange("timeout", parseInt(e.target.value) || 30000)}
            min={1000}
            max={300000}
            className="w-full"
          />
        </div>
      </div>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-slate-200 dark:border-gray-700 flex gap-3">
        <Button
          variant="outline"
          onClick={onBack}
          className="flex-1"
          disabled={isSaving}
        >
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={!isUrlValid || isSaving}
          className="flex-1"
        >
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  )
}

export default HttpRequestConfigUI