import { useState, useEffect } from "react"
import { Copy, Check, X, Terminal } from "lucide-react"
import { WebhookConfig } from "./Types"
import { BackArrowIcon } from "./WorkflowIcons"
import Dropdown from "@/components/ui/dropdown"
import { CredentialSelector } from "./CredentialSelector"
import { credentialsAPI, type Credential } from "./api/ApiHandlers"

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
  // Initialize config from props
  const [config, setConfig] = useState<WebhookConfig>(() => {
    // First priority: use initialConfig if provided
    if (initialConfig) {
      return initialConfig
    }
    
    // Second priority: extract from toolData (workflow tools structure)
    if (toolData) {
      let extractedConfig: WebhookConfig
      
      // Handle workflow tool structure: { type: 'webhook', value: {...}, config: {...} }
      if (toolData.type === 'webhook' && toolData.value && toolData.config) {
        const valueData = toolData.value
        const configData = toolData.config
        
        extractedConfig = {
          webhookUrl: valueData.webhookUrl || "",
          httpMethod: (valueData.httpMethod || "GET") as WebhookConfig['httpMethod'],
          path: valueData.path || "",
          authentication: (configData.authentication || "none") as WebhookConfig['authentication'],
          selectedCredential: configData.selectedCredential || undefined,
          responseMode: (configData.responseMode || "immediately") as WebhookConfig['responseMode'],
          options: configData.options || {},
          headers: configData.headers || {},
          queryParams: configData.queryParams || {},
          requestBody: valueData.requestBody || configData.requestBody || "",
        }
      } else {
        // Handle legacy structures
        const valueData = toolData.value || toolData.val || toolData
        const configData = toolData.config || toolData
        
        extractedConfig = {
          webhookUrl: valueData.webhookUrl || configData.webhookUrl || "",
          httpMethod: (valueData.httpMethod || configData.httpMethod || "GET") as WebhookConfig['httpMethod'],
          path: valueData.path || configData.path || "",
          authentication: (configData.authentication || "none") as WebhookConfig['authentication'],
          selectedCredential: configData.selectedCredential || undefined,
          responseMode: (configData.responseMode || "immediately") as WebhookConfig['responseMode'],
          options: configData.options || {},
          headers: configData.headers || {},
          queryParams: configData.queryParams || {},
          requestBody: valueData.requestBody || configData.requestBody || "",
        }
      }
      
      return extractedConfig
    }
    
    // Default config if no data provided
    return {
      webhookUrl: "",
      httpMethod: "GET",
      path: "",
      authentication: "none",
      selectedCredential: undefined,
      responseMode: "immediately",
      options: {},
      headers: {},
      queryParams: {},
      requestBody: "",
    }
  })

  const [newHeaderKey, setNewHeaderKey] = useState("")
  const [newHeaderValue, setNewHeaderValue] = useState("")
  const [newParamKey, setNewParamKey] = useState("")
  const [newParamValue, setNewParamValue] = useState("")
  const [copied, setCopied] = useState(false)
  const [curlCopied, setCurlCopied] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)
  const [originalConfig, setOriginalConfig] = useState<WebhookConfig | null>(null)
  const [selectedCredentialData, setSelectedCredentialData] = useState<Credential | null>(null)

  // Handle prop changes - force update when toolData changes
  useEffect(() => {
    if (!originalConfig) {
      setOriginalConfig(config)
      setHasChanges(false)
    }
    
    if (toolData && toolData.type === 'webhook' && toolData.value && toolData.config) {
      const valueData = toolData.value
      const configData = toolData.config
      
      const newConfig: WebhookConfig = {
        webhookUrl: valueData.webhookUrl || "",
        httpMethod: (valueData.httpMethod || "GET") as WebhookConfig['httpMethod'],
        path: valueData.path || "",
        authentication: (configData.authentication || "none") as WebhookConfig['authentication'],
        selectedCredential: configData.selectedCredential || undefined,
        responseMode: (configData.responseMode || "immediately") as WebhookConfig['responseMode'],
        options: configData.options || {},
        headers: configData.headers || {},
        queryParams: configData.queryParams || {},
        requestBody: valueData.requestBody || configData.requestBody || "",
      }
      
      // Force update the config
      setConfig(newConfig)
      setOriginalConfig(newConfig)
      setHasChanges(false)
    } else if (initialConfig) {
      setConfig(initialConfig)
      setOriginalConfig(initialConfig)
      setHasChanges(false)
    }
  }, [toolData, initialConfig, config, originalConfig])

  // Track changes in config
  useEffect(() => {
    if (originalConfig) {
      const configChanged = JSON.stringify(config) !== JSON.stringify(originalConfig)
      setHasChanges(configChanged)
    }
  }, [config, originalConfig])

  // Get credential data from tool config or fetch from API
  useEffect(() => {
    const getCredentialData = async () => {
      if (config.selectedCredential && config.authentication !== "none") {
        try {
          console.log('🔧 Looking for credential data for:', config.selectedCredential, 'type:', config.authentication)
          
          // First check if we have credentials in the tool config (for existing workflows)
          if (toolData?.config?.credentials && Array.isArray(toolData.config.credentials)) {
            console.log('🔧 Found credentials in tool config:', toolData.config.credentials)
            const selectedCred = toolData.config.credentials.find((cred: any) => cred.isSelected === true)
            if (selectedCred) {
              console.log('🔧 Found selected credential in tool config:', selectedCred)
              // Convert tool config credential format to our expected format
              const credentialData: Credential = {
                id: config.selectedCredential,
                name: selectedCred.name,
                type: config.authentication as "basic" | "bearer" | "api_key",
                user: selectedCred.user,
                password: selectedCred.password,
                isValid: true
              }
              setSelectedCredentialData(credentialData)
              return
            }
          }
          
          // Fallback to API fetch for new credentials
          console.log('🔧 Fetching credential data from API for:', config.selectedCredential, 'type:', config.authentication)
          const credentials = await credentialsAPI.fetchByType(config.authentication as "basic" | "bearer" | "api_key")
          console.log('🔧 Available credentials from API:', credentials)
          const credential = credentials.find(cred => cred.id === config.selectedCredential)
          console.log('🔧 Found credential from API:', credential)
          setSelectedCredentialData(credential || null)
        } catch (error) {
          console.error('Failed to get credential data:', error)
          setSelectedCredentialData(null)
        }
      } else {
        setSelectedCredentialData(null)
      }
    }

    getCredentialData()
  }, [config.selectedCredential, config.authentication, toolData])

  // Generate webhook URL based on the path
  const generateWebhookUrl = () => {
    // If we have a saved webhookUrl and it's not empty, use it
    if (config.webhookUrl && config.webhookUrl.trim()) {
      return config.webhookUrl
    }
    
    // Otherwise, generate based on path
    // In development, use the backend server URL (port 3000)
    // In production, use the same origin
    const isDevelopment = window.location.port === '5173'
    const baseUrl = isDevelopment ? 'http://localhost:3000' : window.location.origin
    const cleanPath = config.path?.startsWith('/') ? config.path : `/${config.path || ''}`
    let url = `${baseUrl}/workflow/webhook${cleanPath}`
    
    // Add query parameters if they exist
    const queryParams = config.queryParams || {}
    const queryString = Object.entries(queryParams)
      .filter(([key, value]) => key.trim() && value.trim())
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&')
    
    if (queryString) {
      url += `?${queryString}`
    }
    
    return url
  }

  const validateHeaders = () => {
    const headers = config.headers || {}
    const errors: string[] = []
    
    for (const [key, value] of Object.entries(headers)) {
      if (!key.trim()) {
        errors.push("Header name cannot be empty")
      }
      if (!value.trim()) {
        errors.push(`Header "${key}" value cannot be empty`)
      }
      // Basic header name validation (no spaces, special chars)
      if (!/^[a-zA-Z0-9-_]+$/.test(key.trim())) {
        errors.push(`Header name "${key}" contains invalid characters. Use only letters, numbers, hyphens, and underscores.`)
      }
    }
    
    return errors
  }

  const handleSave = () => {
    if (!config.path?.trim()) {
      alert("Please enter a webhook path")
      return
    }

    // Validate headers
    const headerErrors = validateHeaders()
    if (headerErrors.length > 0) {
      alert(`Header validation failed:\n${headerErrors.join('\n')}`)
      return
    }

    // Validate request body for POST method
    if (config.httpMethod === "POST" && !config.requestBody?.trim()) {
      alert("Request body is mandatory for POST method webhooks")
      return
    }

    // Validate JSON format for request body if provided
    if (config.requestBody?.trim()) {
      try {
        JSON.parse(config.requestBody)
      } catch (error) {
        alert("Request body must be valid JSON format")
        return
      }
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
    setConfig(prev => {
      const newHeaders = { ...prev.headers };
      delete newHeaders[key];
      return { ...prev, headers: newHeaders };
    });
  }

  // Copy webhook URL to clipboard
  const copyWebhookUrl = async () => {
    const url = generateWebhookUrl()
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000) // Reset after 2 seconds
    } catch (err) {
      console.error('Failed to copy URL:', err)
      // Fallback for browsers that don't support clipboard API
      const textArea = document.createElement('textarea')
      textArea.value = url
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  // Generate curl command with authentication
  const generateCurlCommand = () => {
    const url = generateWebhookUrl()
    const method = config.httpMethod
    let curlCommand = `curl --location --request ${method} '${url}'`

    // Add Content-Type header
    curlCommand += ` \\\n--header 'Content-Type: application/json'`

    // Add authentication header if present
    if (config.authentication === "basic" && config.selectedCredential) {
      // First try to get basic_auth from tool config (for existing workflows)
      const toolCredentials = toolData?.config?.credentials
      const selectedToolCred = toolCredentials?.find((cred: any) => cred.isSelected === true)
      
      if (selectedToolCred && selectedToolCred.basic_auth) {
        // Use the pre-encoded basic_auth from tool config
        curlCommand += ` \\\n--header 'Authorization: Basic ${selectedToolCred.basic_auth}'`
      } else if (selectedCredentialData && selectedCredentialData.user && selectedCredentialData.password) {
        // Create Basic Auth token from fetched credential data
        const credentials = `${selectedCredentialData.user}:${selectedCredentialData.password}`
        const basicAuthToken = btoa(credentials) // Base64 encode
        curlCommand += ` \\\n--header 'Authorization: Basic ${basicAuthToken}'`
      } else {
        // Fallback message if credential data is not available
        curlCommand += ` \\\n--header 'Authorization: Basic <CREDENTIAL_NOT_LOADED>'`
      }
    }

    // Add custom headers
    if (config.headers && Object.keys(config.headers).length > 0) {
      Object.entries(config.headers).forEach(([key, value]) => {
        // Skip Content-Type if already added, and Authorization if auth is handled above
        if (key.toLowerCase() !== 'content-type' && key.toLowerCase() !== 'authorization') {
          curlCommand += ` \\\n--header '${key}: ${value}'`
        }
      })
    }

    // Add request body for POST, PUT, PATCH methods
    if ((method === "POST" || method === "PUT" || method === "PATCH") && config.requestBody) {
      // Escape single quotes in JSON for shell
      const escapedBody = config.requestBody.replace(/'/g, "'\"'\"'")
      curlCommand += ` \\\n--data '${escapedBody}'`
    } else if (method === "GET") {
      curlCommand += ` \\\n--data '{}'`
    }

    return curlCommand
  }

  // Copy curl command to clipboard
  const copyCurlCommand = async () => {
    const curlCommand = generateCurlCommand()
    try {
      await navigator.clipboard.writeText(curlCommand)
      setCurlCopied(true)
      setTimeout(() => setCurlCopied(false), 2000) // Reset after 2 seconds
    } catch (err) {
      console.error('Failed to copy curl command:', err)
      // Fallback for browsers that don't support clipboard API
      const textArea = document.createElement('textarea')
      textArea.value = curlCommand
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      setCurlCopied(true)
      setTimeout(() => setCurlCopied(false), 2000)
    }
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
    setConfig(prev => {
      const newQueryParams = { ...prev.queryParams };
      delete newQueryParams[key];
      return { ...prev, queryParams: newQueryParams };
    });
  }

  return (
    <div
      className={`fixed top-[80px] right-0 h-[calc(100vh-80px)] bg-white dark:bg-gray-900 border-l border-slate-200 dark:border-gray-700 flex flex-col overflow-hidden z-50 ${
        isVisible ? "translate-x-0 w-[380px]" : "translate-x-full w-0"
      }`}
    >
      {/* Panel Header */}
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
        {showBackButton && onBack && (
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
            <BackArrowIcon width={24} height={24} />
          </button>
        )}
        <h2
          className="flex-1 text-gray-900 dark:text-gray-100"
          style={{
            fontFamily: "Inter",
            fontSize: "16px",
            fontStyle: "normal",
            fontWeight: "600",
            lineHeight: "normal",
            letterSpacing: "-0.16px",
            textTransform: "capitalize",
          }}
        >
          Webhook Configuration
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

      {/* Panel Content */}
      <div className="flex-1 overflow-y-auto p-6 dark:bg-gray-900 flex flex-col">
        <div className="space-y-4 flex-1">
          {/* Webhook URL Display */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-slate-700 dark:text-gray-300">
                Webhook URL
              </label>
              
              {/* Copy cURL Button */}
              <button
                onClick={copyCurlCommand}
                disabled={!config.path?.trim()}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed border border-gray-300 dark:border-gray-600 rounded-md transition-colors"
                title={curlCopied ? "cURL command copied!" : "Copy cURL command for testing"}
              >
                {curlCopied ? (
                  <>
                    <Check className="w-3 h-3 text-green-600" />
                    <span className="text-green-600">Copied!</span>
                  </>
                ) : (
                  <>
                    <Terminal className="w-3 h-3" />
                    <span>Copy cURL</span>
                  </>
                )}
              </button>
            </div>
            
            <div className="space-y-2">
              <div className="relative">
                <div className="p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg pr-12">
                  <div className="text-xs text-gray-600 dark:text-gray-400 font-mono break-all leading-relaxed">
                    {generateWebhookUrl()}
                  </div>
                </div>
                <button
                  onClick={copyWebhookUrl}
                  className="absolute right-2 top-1/2 transform -translate-y-1/2 p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
                  title={copied ? "URL copied!" : "Copy URL"}
                >
                  {copied ? (
                    <Check className="w-3 h-3 text-green-600" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                This URL will be generated automatically based on your path
              </div>
            </div>
          </div>


          {/* HTTP Method */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700 dark:text-gray-300">
              HTTP Method
            </label>
            <Dropdown
              options={[
                { value: "GET", label: "GET" },
                { value: "POST", label: "POST" },
                { value: "PUT", label: "PUT" },
                { value: "DELETE", label: "DELETE" },
                { value: "PATCH", label: "PATCH" }
              ]}
              value={config.httpMethod}
              onSelect={(value) => setConfig(prev => ({ ...prev, httpMethod: value as WebhookConfig['httpMethod'] }))}
              placeholder="Select HTTP method"
              className="w-full dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600"
              variant="outline"
            />
          </div>

          {/* Path */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700 dark:text-gray-300">
              Path *
            </label>
            <input
              type="text"
              value={config.path}
              onChange={(e) => setConfig(prev => ({ ...prev, path: e.target.value }))}
              placeholder="e.g., /my-webhook"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            />
            <div className="text-xs text-gray-500 dark:text-gray-400">
              The path where your webhook will be accessible. Use a unique identifier.
            </div>
          </div>

          {/* Authentication */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700 dark:text-gray-300">
              Authentication
            </label>
            <Dropdown
              options={[
                { value: "none", label: "None" },
                { value: "basic", label: "Basic Auth" }
              ]}
              value={config.authentication}
              onSelect={(value) => setConfig(prev => ({ ...prev, authentication: value as WebhookConfig['authentication'], selectedCredential: undefined }))}
              placeholder="Select authentication type"
              className="w-full dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600"
              variant="outline"
            />
          </div>

          {/* Credential Selector - Shows when authentication is not "none" */}
          {config.authentication !== "none" && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700 dark:text-gray-300">
                Credential for {config.authentication === "basic" ? "Basic Auth" : config.authentication === "bearer" ? "Bearer Token" : "API Key"}
              </label>
              <CredentialSelector
                authType={config.authentication as "basic" | "bearer" | "api_key"}
                selectedCredentialId={config.selectedCredential}
                onSelect={(credentialId) => setConfig(prev => ({ ...prev, selectedCredential: credentialId || undefined }))}
                existingCredentials={toolData?.config?.credentials || []}
              />
            </div>
          )}

          {/* Response Mode */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700 dark:text-gray-300">
              Response
            </label>
            <Dropdown
              options={[
                { value: "immediately", label: "Immediately" }
              ]}
              value={config.responseMode}
              onSelect={(value) => setConfig(prev => ({ ...prev, responseMode: value as WebhookConfig['responseMode'] }))}
              placeholder="Select response mode"
              className="w-full dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600"
              variant="outline"
            />
            <div className="text-xs text-gray-500 dark:text-gray-400">
              If you are sending back a response, add a "Content-Type" response header with the appropriate value to avoid unexpected behavior
            </div>
          </div>

          {/* Request Body - Shows only for POST, PUT, PATCH methods */}
          {(config.httpMethod === "POST" || config.httpMethod === "PUT" || config.httpMethod === "PATCH") && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700 dark:text-gray-300">
                Request Body {config.httpMethod === "POST" && <span className="text-red-500">*</span>}
              </label>
              <div className="space-y-2">
                <textarea
                  value={config.requestBody || ""}
                  onChange={(e) => setConfig(prev => ({ ...prev, requestBody: e.target.value }))}
                  placeholder='{"key": "value", "message": "Hello World"}'
                  rows={6}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-mono text-sm resize-vertical"
                />
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {config.httpMethod === "POST" 
                    ? "JSON request body is mandatory for POST webhooks. External systems must send this exact JSON structure." 
                    : "Optional JSON request body. Must be valid JSON format if provided."}
                </div>
                {config.requestBody && (() => {
                  try {
                    JSON.parse(config.requestBody)
                    return (
                      <div className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                        Valid JSON format
                      </div>
                    )
                  } catch (error) {
                    return (
                      <div className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                        </svg>
                        Invalid JSON format
                      </div>
                    )
                  }
                })()}
              </div>
            </div>
          )}

          {/* Headers */}
          <div className="space-y-3">
            <label className="text-sm font-medium text-slate-700 dark:text-gray-300">
              Headers
            </label>
          
            {/* Existing Headers */}
            {Object.entries(config.headers || {}).length > 0 && (
              <div className="space-y-2">
                {Object.entries(config.headers || {}).map(([key, value]) => (
                  <div key={key} className="relative">
                    <div className="p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Name</div>
                        <div className="text-sm text-gray-900 dark:text-gray-100 font-mono break-all">{key}</div>
                      </div>
                      <div className="space-y-1 mt-2">
                        <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Value</div>
                        <div className="text-sm text-gray-900 dark:text-gray-100 font-mono break-all">{value}</div>
                      </div>
                    </div>
                    <button
                      onClick={() => removeHeader(key)}
                      className="absolute top-2 right-2 p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/50 rounded transition-colors"
                      title="Remove header"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add New Header */}
            <div className="p-3 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg space-y-3">
              <div className="space-y-2">
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Header Name</label>
                <input
                  type="text"
                  value={newHeaderKey}
                  onChange={(e) => setNewHeaderKey(e.target.value)}
                  placeholder="e.g., Content-Type"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Header Value</label>
                <input
                  type="text"
                  value={newHeaderValue}
                  onChange={(e) => setNewHeaderValue(e.target.value)}
                  placeholder="e.g., application/json"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                />
              </div>
              <button
                onClick={addHeader}
                disabled={!newHeaderKey.trim() || !newHeaderValue.trim()}
                className="w-full px-3 py-2 bg-gray-900 hover:bg-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm rounded-full transition-colors"
              >
                Add Header
              </button>
            </div>
          </div>

          {/* Query Parameters */}
          <div className="space-y-3">
            <label className="text-sm font-medium text-slate-700 dark:text-gray-300">
              Query Parameters
            </label>
          
            {/* Existing Parameters */}
            {Object.entries(config.queryParams || {}).length > 0 && (
              <div className="space-y-2">
                {Object.entries(config.queryParams || {}).map(([key, value]) => (
                  <div key={key} className="relative">
                    <div className="p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Parameter Name</div>
                        <div className="text-sm text-gray-900 dark:text-gray-100 font-mono break-all">{key}</div>
                      </div>
                      <div className="space-y-1 mt-2">
                        <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Parameter Value</div>
                        <div className="text-sm text-gray-900 dark:text-gray-100 font-mono break-all">{value}</div>
                      </div>
                    </div>
                    <button
                      onClick={() => removeQueryParam(key)}
                      className="absolute top-2 right-2 p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/50 rounded transition-colors"
                      title="Remove parameter"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add New Parameter */}
            <div className="p-3 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg space-y-3">
              <div className="space-y-2">
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Parameter Name</label>
                <input
                  type="text"
                  value={newParamKey}
                  onChange={(e) => setNewParamKey(e.target.value)}
                  placeholder="e.g., api_key"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Parameter Value</label>
                <input
                  type="text"
                  value={newParamValue}
                  onChange={(e) => setNewParamValue(e.target.value)}
                  placeholder="e.g., your-api-key"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                />
              </div>
              <button
                onClick={addQueryParam}
                disabled={!newParamKey.trim() || !newParamValue.trim()}
                className="w-full px-3 py-2 bg-gray-900 hover:bg-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm rounded-full transition-colors"
              >
                Add Parameter
              </button>
            </div>
          </div>

          {/* Options Info */}
          <div className="p-3 bg-blue-50 dark:bg-blue-900/50 border border-blue-200 dark:border-blue-800 rounded-lg">
            <div className="text-sm text-blue-800 dark:text-blue-200">
              <strong>Note:</strong> Once you save this configuration, the webhook will be available at the generated URL and will trigger your workflow when called.
            </div>
          </div>
        </div>
        
        {/* Save Button - Sticky to bottom */}
        {builder && (
          <div className="pt-6 px-0">
            <button
              onClick={handleSave}
              disabled={(() => {
                // For new webhooks, require path
                if (!toolData && !initialConfig) {
                  return !config.path?.trim()
                }
                // For editing webhooks, require path and changes
                return !config.path?.trim() || !hasChanges
              })()}
              className="w-full bg-gray-900 hover:bg-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-full shadow-none py-2 px-6 transition-colors"
            >
              Save Configuration
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export { WebhookConfigurationUI }
export type { WebhookConfig }