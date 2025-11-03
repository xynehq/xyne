/**
 * Jira Configuration UI
 * Handles both trigger setup and credential configuration
 */

import React, { useState, useEffect } from 'react'
import { JiraIcon } from './WorkflowIcons'
import { Check } from 'lucide-react'
import { MultiSelect } from '../ui/MultiSelect'
import { Snackbar } from '../ui/Snackbar'

export interface JiraConfig {
  // Credentials
  domain: string
  email: string
  apiToken: string

  // Trigger events
  events: string[]

  // Webhook URLs
  webhookUrl?: string
  testWebhookUrl?: string
  productionWebhookUrl?: string
  webhookId?: string

  // Filtering
  jqlFilter?: string
  simpleFilters?: {
    projects?: string[]
    issueTypes?: string[]
    priorities?: string[]
    statuses?: string[]
    epics?: string[]
    issues?: string[]
  }

  // Optional metadata
  title?: string
  description?: string
}

interface JiraConfigurationUIProps {
  isVisible: boolean
  onClose: () => void
  onSave: (config: JiraConfig) => void
  onBack?: () => void
  initialConfig?: Partial<JiraConfig>
  toolId?: string // Tool ID for fetching existing credentials when editing
}

const JIRA_EVENTS = [
  // Issue Events
  { value: 'jira:issue_created', label: 'Issue Created', description: 'When a new issue is created', category: 'Issue' },
  { value: 'jira:issue_updated', label: 'Issue Updated', description: 'When an issue is updated', category: 'Issue' },

  // Project Events
  { value: 'project_created', label: 'Project Created', description: 'When a new project is created', category: 'Project' },
  { value: 'project_updated', label: 'Project Updated', description: 'When a project is updated', category: 'Project' },
]

export const JiraConfigurationUI: React.FC<JiraConfigurationUIProps> = ({
  isVisible,
  onClose,
  onSave,
  onBack,
  initialConfig,
  toolId,
}) => {
  const [config, setConfig] = useState<JiraConfig>({
    domain: '',
    email: '',
    apiToken: '',
    events: [],
    jqlFilter: '',
    title: 'Jira Trigger',
    description: '',
  })

  const [showPassword, setShowPassword] = useState(false)
  const [activeTab, setActiveTab] = useState<'params' | 'settings'>('params')
  const [copiedTest, setCopiedTest] = useState(false)
  const [copiedProduction, setCopiedProduction] = useState(false)
  const [isTestingConnection, setIsTestingConnection] = useState(false)
  const [connectionTestResult, setConnectionTestResult] = useState<{
    success: boolean
    message: string
  } | null>(null)
  const [isRegisteringWebhook, setIsRegisteringWebhook] = useState(false)
  const [webhookRegistrationResult, setWebhookRegistrationResult] = useState<{
    success: boolean
    message: string
    webhookId?: string
  } | null>(null)
  const [validationSnackbar, setValidationSnackbar] = useState<{
    isVisible: boolean
    message: string
  }>({ isVisible: false, message: '' })

  // Filter mode and metadata state
  const [filterMode, setFilterMode] = useState<'simple' | 'advanced'>('simple')
  const [jiraMetadata, setJiraMetadata] = useState<{
    projects: Array<{ key: string; name: string; id: string }>
    priorities: Array<{ id: string; name: string }>
    statuses: Array<{ id: string; name: string }>
    issueTypes: Array<{ id: string; name: string }>
    epics: Array<{ key: string; summary: string }>
    components: Array<{ id: string; name: string }>
    issues: Array<{ key: string; summary: string; status?: string; issuetype?: string; priority?: string }>
  } | null>(null)
  const [isFetchingMetadata, setIsFetchingMetadata] = useState(false)

  // Simple filter selections
  const [simpleFilters, setSimpleFilters] = useState({
    projects: [] as string[],
    issueTypes: [] as string[],
    priorities: [] as string[],
    statuses: [] as string[],
    epics: [] as string[],
    issues: [] as string[],
  })

  // Generate unique webhook ID if not present
  useEffect(() => {
    if (!config.webhookId && !initialConfig?.webhookId) {
      const uniqueId = `jira-webhook-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
      setConfig((prev) => ({ ...prev, webhookId: uniqueId }))
    }
  }, [])

  // Generate webhook URLs
  const generateWebhookUrls = () => {
    // Get webhook base URL from environment or current origin
    // Priority: ENV variable > Current origin
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'

    // For local development, use VITE_WEBHOOK_URL env var or fallback to window.location.origin
    // For production, always use window.location.origin (your deployed domain)
    const baseUrl = isLocalhost
      ? (import.meta.env.VITE_WEBHOOK_URL || window.location.origin)
      : window.location.origin

    const webhookId = config.webhookId || initialConfig?.webhookId || 'pending'
    const testUrl = `${baseUrl}/api/v1/webhook-test/jira/${webhookId}`
    const productionUrl = `${baseUrl}/api/v1/webhook/jira/${webhookId}`

    return { testUrl, productionUrl }
  }

  // Reset state when initialConfig changes
  useEffect(() => {
    if (initialConfig) {
      setConfig({
        domain: initialConfig.domain || '',
        email: initialConfig.email || '',
        apiToken: '', // Never hydrate apiToken - it's write-only for security
        events: initialConfig.events || [],
        jqlFilter: initialConfig.jqlFilter || '',
        webhookId: initialConfig.webhookId,
        webhookUrl: initialConfig.webhookUrl,
        testWebhookUrl: initialConfig.testWebhookUrl,
        productionWebhookUrl: initialConfig.productionWebhookUrl,
        title: initialConfig.title || 'Jira Trigger',
        description: initialConfig.description || '',
      })

      // Restore simple filters if they exist
      if (initialConfig.simpleFilters) {
        setSimpleFilters({
          projects: initialConfig.simpleFilters.projects || [],
          issueTypes: initialConfig.simpleFilters.issueTypes || [],
          priorities: initialConfig.simpleFilters.priorities || [],
          statuses: initialConfig.simpleFilters.statuses || [],
          epics: initialConfig.simpleFilters.epics || [],
          issues: initialConfig.simpleFilters.issues || [],
        })
      }

      // If webhook is already registered, clear any previous registration messages
      if (initialConfig.webhookId && initialConfig.productionWebhookUrl) {
        setWebhookRegistrationResult(null)
      }
    } else {
      // Clear webhook registration result when there's no initial config
      setWebhookRegistrationResult(null)
    }
  }, [initialConfig])

  // Clear connection test result when credentials change
  useEffect(() => {
    setConnectionTestResult(null)
  }, [config.domain, config.email, config.apiToken])

  const handleEventToggle = (eventValue: string) => {
    setConfig((prev) => ({
      ...prev,
      events: prev.events.includes(eventValue)
        ? prev.events.filter((e) => e !== eventValue)
        : [...prev.events, eventValue],
    }))
  }

  // Copy webhook URL to clipboard
  const copyWebhookUrl = async (url: string, isTest: boolean) => {
    const setCopied = isTest ? setCopiedTest : setCopiedProduction
    const showCopiedMessage = () => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }

    try {
      await navigator.clipboard.writeText(url)
    } catch (err) {
      console.error('Failed to copy URL:', err)
      // Fallback for browsers that don't support clipboard API
      const textArea = document.createElement('textarea')
      textArea.value = url
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
    }

    showCopiedMessage()
  }

  // Auto-generate JQL from simple filters
  const generateJQLFromSimpleFilters = () => {
    const conditions: string[] = []

    if (simpleFilters.projects.length > 0) {
      if (simpleFilters.projects.length === 1) {
        conditions.push(`project = "${simpleFilters.projects[0]}"`)
      } else {
        const projectList = simpleFilters.projects.map(p => `"${p}"`).join(', ')
        conditions.push(`project IN (${projectList})`)
      }
    }

    if (simpleFilters.issueTypes.length > 0) {
      if (simpleFilters.issueTypes.length === 1) {
        conditions.push(`issuetype = "${simpleFilters.issueTypes[0]}"`)
      } else {
        const typeList = simpleFilters.issueTypes.map(t => `"${t}"`).join(', ')
        conditions.push(`issuetype IN (${typeList})`)
      }
    }

    if (simpleFilters.priorities.length > 0) {
      if (simpleFilters.priorities.length === 1) {
        conditions.push(`priority = "${simpleFilters.priorities[0]}"`)
      } else {
        const priorityList = simpleFilters.priorities.map(p => `"${p}"`).join(', ')
        conditions.push(`priority IN (${priorityList})`)
      }
    }

    if (simpleFilters.statuses.length > 0) {
      if (simpleFilters.statuses.length === 1) {
        conditions.push(`status = "${simpleFilters.statuses[0]}"`)
      } else {
        const statusList = simpleFilters.statuses.map(s => `"${s}"`).join(', ')
        conditions.push(`status IN (${statusList})`)
      }
    }

    if (simpleFilters.epics.length > 0) {
      if (simpleFilters.epics.length === 1) {
        conditions.push(`"Epic Link" = "${simpleFilters.epics[0]}"`)
      } else {
        const epicList = simpleFilters.epics.map(e => `"${e}"`).join(', ')
        conditions.push(`"Epic Link" IN (${epicList})`)
      }
    }

    if (simpleFilters.issues.length > 0) {
      if (simpleFilters.issues.length === 1) {
        conditions.push(`key = "${simpleFilters.issues[0]}"`)
      } else {
        const issueList = simpleFilters.issues.map(k => `"${k}"`).join(', ')
        conditions.push(`key IN (${issueList})`)
      }
    }

    return conditions.join(' AND ')
  }

  // Update JQL when simple filters change (only in simple mode)
  useEffect(() => {
    if (filterMode === 'simple') {
      const generatedJQL = generateJQLFromSimpleFilters()
      setConfig((prev) => ({ ...prev, jqlFilter: generatedJQL }))
    }
  }, [simpleFilters, filterMode])

  // Refetch metadata when projects change (to get project-specific issues)
  useEffect(() => {
    const fetchProjectSpecificData = async () => {
      if (
        jiraMetadata &&
        simpleFilters.projects.length > 0 &&
        config.domain &&
        config.email &&
        config.apiToken
      ) {
        setIsFetchingMetadata(true)
        try {
          const { workflowToolsAPI } = await import('./api/ApiHandlers')
          const metadata = await workflowToolsAPI.fetchJiraMetadata({
            domain: config.domain,
            email: config.email,
            apiToken: config.apiToken,
            projectKeys: simpleFilters.projects,
          })
          setJiraMetadata(metadata)
          console.log('✅ Project-specific metadata refetched:', metadata)
        } catch (error) {
          console.error('Failed to fetch project-specific metadata:', error)
        } finally {
          setIsFetchingMetadata(false)
        }
      }
    }

    fetchProjectSpecificData()
  }, [simpleFilters.projects])

  // Test Jira connection
  const handleTestConnection = async () => {
    // Validate required fields
    if (!config.domain || !config.email || !config.apiToken) {
      setConnectionTestResult({
        success: false,
        message: 'Please fill in domain, email, and API token fields',
      })
      return
    }

    setIsTestingConnection(true)
    setConnectionTestResult(null)

    try {
      const { workflowToolsAPI } = await import('./api/ApiHandlers')
      const result = await workflowToolsAPI.testJiraConnection({
        domain: config.domain,
        email: config.email,
        apiToken: config.apiToken,
      })

      setConnectionTestResult(result)

      // If connection is successful, fetch metadata for dropdowns
      if (result.success) {
        setIsFetchingMetadata(true)
        try {
          const metadata = await workflowToolsAPI.fetchJiraMetadata({
            domain: config.domain,
            email: config.email,
            apiToken: config.apiToken,
          })
          setJiraMetadata(metadata)
          console.log('✅ Jira metadata fetched:', metadata)
        } catch (metadataError) {
          console.error('Failed to fetch Jira metadata:', metadataError)
          // Don't fail the connection test if metadata fetch fails
        } finally {
          setIsFetchingMetadata(false)
        }
      }
    } catch (error: any) {
      console.error('Connection test failed:', error)

      // Provide helpful error messages
      let errorMessage = error.message || 'Failed to connect to Jira'

      // If it's a generic network error, provide more context
      if (errorMessage.toLowerCase().includes('network error') || errorMessage.toLowerCase() === 'failed to fetch') {
        errorMessage = 'Unable to connect to Jira. Please verify the domain, email, and API token are correct.'
      }

      setConnectionTestResult({
        success: false,
        message: errorMessage,
      })
    } finally {
      setIsTestingConnection(false)
    }
  }

  const handleSave = async () => {
    // Prevent double submissions
    if (isRegisteringWebhook) {
      console.log('⚠️ Save already in progress, ignoring duplicate call')
      return
    }

    // Validate required fields for NEW configurations
    // For existing configs, apiToken is optional (preserved from backend if empty)
    const isNewConfig = !initialConfig
    if (isNewConfig && (!config.domain || !config.email || !config.apiToken)) {
      setValidationSnackbar({
        isVisible: true,
        message: 'Please fill in all required credential fields'
      })
      return
    }

    if (!config.domain || !config.email) {
      setValidationSnackbar({
        isVisible: true,
        message: 'Please fill in domain and email'
      })
      return
    }

    // Require successful connection test only for NEW configs or if credentials changed
    const credentialsChanged = config.apiToken !== '' // User entered a new token
    if ((isNewConfig || credentialsChanged) && (!connectionTestResult || !connectionTestResult.success)) {
      setValidationSnackbar({
        isVisible: true,
        message: 'Please test the connection successfully before saving'
      })
      return
    }

    if (config.events.length === 0) {
      setValidationSnackbar({
        isVisible: true,
        message: 'Please select at least one event'
      })
      return
    }

    setIsRegisteringWebhook(true)
    setWebhookRegistrationResult(null)

    try {
      // Generate webhook URLs
      const { testUrl, productionUrl } = generateWebhookUrls()

      // Get actual API token - fetch from backend if user didn't provide a new one
      const { workflowToolsAPI } = await import('./api/ApiHandlers')
      let actualApiToken = config.apiToken

      if (!actualApiToken && initialConfig && toolId) {
        // User is editing and didn't provide new token - fetch existing from backend
        const existingTool = await workflowToolsAPI.getTool(toolId)
        actualApiToken = existingTool.config?.apiToken || ''
      }

      if (!actualApiToken) {
        throw new Error('API token is required. Please enter your Jira API token.')
      }

      // Register webhook with Jira
      const webhookResult = await workflowToolsAPI.registerJiraWebhook({
        domain: config.domain,
        email: config.email,
        apiToken: actualApiToken,
        webhookUrl: productionUrl,
        events: config.events,
        name: config.title || 'Xyne Jira Trigger',
        filters: config.jqlFilter ? { jqlFilter: config.jqlFilter } : undefined,
      })

      // Don't show success message - it's confusing on reopening
      setWebhookRegistrationResult(null)

      // Save config with webhook details and filters
      const finalConfig = {
        ...config,
        testWebhookUrl: testUrl,
        productionWebhookUrl: productionUrl,
        webhookUrl: productionUrl,
        webhookId: webhookResult.webhookId,
        simpleFilters: simpleFilters,
      }

      setIsRegisteringWebhook(false)
      onSave(finalConfig)
    } catch (error: any) {
      console.error('Webhook registration failed:', error)
      setWebhookRegistrationResult({
        success: false,
        message: error.message || 'Failed to register webhook. Please try again.',
      })
      // Re-enable button on error so user can retry
      setIsRegisteringWebhook(false)
    }
  }

  if (!isVisible) return null

  return (
    <div className="fixed top-[80px] right-0 h-[calc(100vh-80px)] w-[380px] bg-white dark:bg-gray-900 shadow-2xl z-50 flex flex-col animate-slide-in-right border-l border-gray-200 dark:border-gray-700">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
              aria-label="Go back"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
          )}
          <JiraIcon width={24} height={24} />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Jira Trigger
          </h2>
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <button
          onClick={() => setActiveTab('params')}
          className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
            activeTab === 'params'
              ? 'text-gray-900 dark:text-white border-b-2 border-gray-900 dark:border-white bg-white dark:bg-gray-900'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
        >
          Parameters
        </button>
        <button
          onClick={() => setActiveTab('settings')}
          className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
            activeTab === 'settings'
              ? 'text-gray-900 dark:text-white border-b-2 border-gray-900 dark:border-white bg-white dark:bg-gray-900'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
        >
          Settings
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {activeTab === 'params' ? (
          <div className="space-y-6">
            {/* Credentials Section */}
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3 pb-2 border-b border-gray-200 dark:border-gray-700">
                Credentials to Connect to Jira
              </h3>

              {/* Domain */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Domain *
                </label>
                <input
                  type="text"
                  placeholder="your-company.atlassian.net"
                  value={config.domain}
                  onChange={(e) =>
                    setConfig({ ...config, domain: e.target.value })
                  }
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-white dark:bg-gray-800 dark:text-gray-100 text-sm"
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Your Jira Cloud domain (e.g., company.atlassian.net)
                </p>
              </div>

              {/* Email */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Email *
                </label>
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={config.email}
                  onChange={(e) =>
                    setConfig({ ...config, email: e.target.value })
                  }
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-white dark:bg-gray-800 dark:text-gray-100 text-sm"
                />
              </div>

              {/* API Token */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  API Token {initialConfig ? '' : '*'}
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder={initialConfig ? "••••••••••••••••" : "Your Jira API token"}
                    title={initialConfig ? "Existing API token is saved. Leave empty to keep it, or enter a new one to update" : "Enter your Jira API token"}
                    value={config.apiToken}
                    onChange={(e) =>
                      setConfig({ ...config, apiToken: e.target.value })
                    }
                    className="w-full px-3 py-2 pr-16 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-orange-500 dark:bg-gray-800 dark:text-gray-100 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  <a
                    href="https://id.atlassian.com/manage-profile/security/api-tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Create an API token →
                  </a>
                </p>
              </div>

              {/* Test Connection Section */}
              <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={isTestingConnection || !config.domain || !config.email || !config.apiToken}
                  className="px-4 py-2 bg-gray-900 hover:bg-gray-800 dark:bg-white dark:hover:bg-gray-100 disabled:bg-gray-400 disabled:cursor-not-allowed text-white dark:text-gray-900 font-medium rounded-md transition-colors text-sm flex items-center gap-2"
                >
                  {isTestingConnection ? (
                    <>
                      <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Testing...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      Test Connection
                    </>
                  )}
                </button>

                {/* Connection Test Result */}
                {connectionTestResult && (
                  <div
                    className={`mt-3 p-3 rounded-md flex items-start gap-2 ${
                      connectionTestResult.success
                        ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
                        : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
                    }`}
                  >
                    {connectionTestResult.success ? (
                      <Check className="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                    ) : (
                      <svg className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    )}
                    <div className="flex-1">
                      <p className={`text-sm font-medium ${
                        connectionTestResult.success
                          ? 'text-green-800 dark:text-green-200'
                          : 'text-red-800 dark:text-red-200'
                      }`}>
                        {connectionTestResult.message}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Events Section */}
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3 pb-2 border-b border-gray-200 dark:border-gray-700">
                Events *
              </h3>
              <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
                Select which Jira events should trigger this workflow
              </p>
              <div className="space-y-2">
                {JIRA_EVENTS.map((event) => (
                  <div
                    key={event.value}
                    onClick={() => handleEventToggle(event.value)}
                    className="flex items-start gap-3 p-3 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors border border-transparent hover:border-gray-200 dark:hover:border-gray-700"
                  >
                    {/* Custom Checkbox */}
                    <div
                      className={`mt-0.5 relative flex items-center justify-center w-4 h-4 rounded border transition-colors ${
                        config.events.includes(event.value)
                          ? 'bg-black dark:bg-white border-black dark:border-white'
                          : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600'
                      }`}
                    >
                      {config.events.includes(event.value) && (
                        <Check className="w-3 h-3 text-white dark:text-black" strokeWidth={3} />
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {event.label}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {event.description}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Filter Section */}
            <div>
              <div className="flex items-center justify-between mb-3 pb-2 border-b border-gray-200 dark:border-gray-700">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Filter Events (Optional)
                </h3>
                {/* Mode Toggle */}
                {jiraMetadata && (
                  <div className="flex gap-1 p-0.5 bg-gray-100 dark:bg-gray-800 rounded-md">
                    <button
                      onClick={() => setFilterMode('simple')}
                      className={`px-2 py-1 text-xs font-medium rounded transition-colors ${
                        filterMode === 'simple'
                          ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                          : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                      }`}
                    >
                      Simple
                    </button>
                    <button
                      onClick={() => setFilterMode('advanced')}
                      className={`px-2 py-1 text-xs font-medium rounded transition-colors ${
                        filterMode === 'advanced'
                          ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                          : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                      }`}
                    >
                      Advanced
                    </button>
                  </div>
                )}
              </div>

              {/* Simple Mode - Dropdowns */}
              {filterMode === 'simple' && jiraMetadata && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-600 dark:text-gray-400">
                      Select filters using dropdowns. JQL will be generated automatically.
                    </p>
                    {(simpleFilters.projects.length > 0 ||
                      simpleFilters.issueTypes.length > 0 ||
                      simpleFilters.priorities.length > 0 ||
                      simpleFilters.statuses.length > 0 ||
                      simpleFilters.epics.length > 0 ||
                      simpleFilters.issues.length > 0) && (
                      <button
                        onClick={() =>
                          setSimpleFilters({
                            projects: [],
                            issueTypes: [],
                            priorities: [],
                            statuses: [],
                            epics: [],
                            issues: [],
                          })
                        }
                        className="text-xs text-orange-600 dark:text-orange-400 hover:text-orange-700 dark:hover:text-orange-300 font-medium"
                      >
                        Clear All Filters
                      </button>
                    )}
                  </div>

                  {/* Projects Multi-Select */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        Projects
                      </label>
                      {simpleFilters.projects.length > 0 && (
                        <button
                          onClick={() => {
                            // Clear projects and all dependent filters
                            setSimpleFilters({
                              projects: [],
                              issueTypes: simpleFilters.issueTypes,
                              priorities: simpleFilters.priorities,
                              statuses: simpleFilters.statuses,
                              epics: [],
                              issues: [],
                            })
                          }}
                          className="text-xs text-orange-600 dark:text-orange-400 hover:text-orange-700 dark:hover:text-orange-300"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    <MultiSelect
                      options={jiraMetadata.projects.map(p => ({
                        value: p.key,
                        label: `${p.name} (${p.key})`,
                      }))}
                      value={simpleFilters.projects}
                      onChange={(selected) =>
                        setSimpleFilters({ ...simpleFilters, projects: selected })
                      }
                      placeholder="All projects"
                    />
                  </div>

                  {/* Issue Types Multi-Select */}
                  {jiraMetadata.issueTypes.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          Issue Types
                        </label>
                        {simpleFilters.issueTypes.length > 0 && (
                          <button
                            onClick={() => setSimpleFilters({ ...simpleFilters, issueTypes: [] })}
                            className="text-xs text-orange-600 dark:text-orange-400 hover:text-orange-700 dark:hover:text-orange-300"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <MultiSelect
                        options={jiraMetadata.issueTypes.map(it => ({
                          value: it.name,
                          label: it.name,
                        }))}
                        value={simpleFilters.issueTypes}
                        onChange={(selected) =>
                          setSimpleFilters({ ...simpleFilters, issueTypes: selected })
                        }
                        placeholder="All issue types"
                      />
                    </div>
                  )}

                  {/* Priorities Multi-Select */}
                  {jiraMetadata.priorities.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          Priorities
                        </label>
                        {simpleFilters.priorities.length > 0 && (
                          <button
                            onClick={() => setSimpleFilters({ ...simpleFilters, priorities: [] })}
                            className="text-xs text-orange-600 dark:text-orange-400 hover:text-orange-700 dark:hover:text-orange-300"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <MultiSelect
                        options={jiraMetadata.priorities.map(p => ({
                          value: p.name,
                          label: p.name,
                        }))}
                        value={simpleFilters.priorities}
                        onChange={(selected) =>
                          setSimpleFilters({ ...simpleFilters, priorities: selected })
                        }
                        placeholder="All priorities"
                      />
                    </div>
                  )}

                  {/* Statuses Multi-Select */}
                  {jiraMetadata.statuses.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          Status
                        </label>
                        {simpleFilters.statuses.length > 0 && (
                          <button
                            onClick={() => setSimpleFilters({ ...simpleFilters, statuses: [] })}
                            className="text-xs text-orange-600 dark:text-orange-400 hover:text-orange-700 dark:hover:text-orange-300"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <MultiSelect
                        options={jiraMetadata.statuses.map(s => ({
                          value: s.name,
                          label: s.name,
                        }))}
                        value={simpleFilters.statuses}
                        onChange={(selected) =>
                          setSimpleFilters({ ...simpleFilters, statuses: selected })
                        }
                        placeholder="All status"
                      />
                    </div>
                  )}

                  {/* Epics Multi-Select (if projects selected) */}
                  {simpleFilters.projects.length > 0 && jiraMetadata.epics.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          Epics
                        </label>
                        {simpleFilters.epics.length > 0 && (
                          <button
                            onClick={() => setSimpleFilters({ ...simpleFilters, epics: [] })}
                            className="text-xs text-orange-600 dark:text-orange-400 hover:text-orange-700 dark:hover:text-orange-300"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <MultiSelect
                        options={jiraMetadata.epics.map(e => ({
                          value: e.key,
                          label: `${e.key}: ${e.summary}`,
                        }))}
                        value={simpleFilters.epics}
                        onChange={(selected) =>
                          setSimpleFilters({ ...simpleFilters, epics: selected })
                        }
                        placeholder="All epics"
                      />
                    </div>
                  )}

                  {/* Issues Multi-Select (if projects selected) */}
                  {simpleFilters.projects.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          Specific Issues
                        </label>
                        {simpleFilters.issues.length > 0 && (
                          <button
                            onClick={() => setSimpleFilters({ ...simpleFilters, issues: [] })}
                            className="text-xs text-orange-600 dark:text-orange-400 hover:text-orange-700 dark:hover:text-orange-300"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <MultiSelect
                        options={jiraMetadata.issues?.map(issue => ({
                          value: issue.key,
                          label: `${issue.key}: ${issue.summary}`,
                        })) || []}
                        value={simpleFilters.issues}
                        onChange={(selected) =>
                          setSimpleFilters({ ...simpleFilters, issues: selected })
                        }
                        placeholder={
                          isFetchingMetadata
                            ? "Loading issues..."
                            : jiraMetadata.issues?.length === 0
                            ? "No issues found in selected projects"
                            : "All issues"
                        }
                        disabled={isFetchingMetadata}
                      />
                      {isFetchingMetadata ? (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          ⏳ Loading issues from selected projects...
                        </p>
                      ) : jiraMetadata.issues?.length > 0 ? (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          Showing {jiraMetadata.issues.length} most recent issues from selected projects
                        </p>
                      ) : (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          No issues found. The selected project(s) may be empty.
                        </p>
                      )}
                    </div>
                  )}

                  {/* Generated JQL Preview */}
                  {config.jqlFilter && (
                    <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                      <p className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                        Generated JQL:
                      </p>
                      <code className="text-xs text-gray-900 dark:text-gray-100 font-mono break-all">
                        {config.jqlFilter}
                      </code>
                    </div>
                  )}
                </div>
              )}

              {/* Advanced Mode - Manual JQL */}
              {(filterMode === 'advanced' || !jiraMetadata) && (
                <div>
                  <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
                    {jiraMetadata
                      ? 'Write custom JQL query for advanced filtering.'
                      : 'Test connection first to enable Simple mode with dropdowns.'}
                  </p>
                  <textarea
                    placeholder='Example: project = "MYPROJECT" AND issuetype = "Bug"'
                    value={config.jqlFilter}
                    onChange={(e) => setConfig({ ...config, jqlFilter: e.target.value })}
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-orange-500 dark:bg-gray-800 dark:text-gray-100 font-mono text-xs"
                  />
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Common examples:
                    </p>
                    <ul className="text-xs text-gray-500 dark:text-gray-400 space-y-1 ml-4">
                      <li className="font-mono">• project = "BACKEND"</li>
                      <li className="font-mono">• project IN ("PROJ1", "PROJ2")</li>
                      <li className="font-mono">• project = "API" AND issuetype = "Bug"</li>
                      <li className="font-mono">• status CHANGED FROM "In Progress" TO "Done"</li>
                    </ul>
                  </div>
                </div>
              )}
            </div>

            {/* Webhook URLs Section */}
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3 pb-2 border-b border-gray-200 dark:border-gray-700">
                Webhook URLs
              </h3>
              <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">
                Use these webhook URLs to configure Jira webhooks for the selected events
              </p>

              {/* Test URL */}
              <div className="mb-3">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Test URL
                </label>
                <div className="relative">
                  <div className="p-2.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg pr-10">
                    <div className="text-xs text-gray-600 dark:text-gray-400 font-mono break-all leading-relaxed">
                      {generateWebhookUrls().testUrl}
                    </div>
                  </div>
                  <button
                    onClick={() => copyWebhookUrl(generateWebhookUrls().testUrl, true)}
                    className="absolute right-2 top-1/2 transform -translate-y-1/2 p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
                    title={copiedTest ? "Copied!" : "Copy URL"}
                  >
                    {copiedTest ? (
                      <Check className="w-3.5 h-3.5 text-green-600" />
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              {/* Production URL */}
              <div className="mb-1">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5 flex items-center gap-1.5">
                  Production URL
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                    POST
                  </span>
                </label>
                <div className="relative">
                  <div className="p-2.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg pr-10">
                    <div className="text-xs text-gray-600 dark:text-gray-400 font-mono break-all leading-relaxed">
                      {generateWebhookUrls().productionUrl}
                    </div>
                  </div>
                  <button
                    onClick={() => copyWebhookUrl(generateWebhookUrls().productionUrl, false)}
                    className="absolute right-2 top-1/2 transform -translate-y-1/2 p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
                    title={copiedProduction ? "Copied!" : "Copy URL"}
                  >
                    {copiedProduction ? (
                      <Check className="w-3.5 h-3.5 text-green-600" />
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Title */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Trigger Name
              </label>
              <input
                type="text"
                placeholder="Jira Trigger"
                value={config.title}
                onChange={(e) =>
                  setConfig({ ...config, title: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-orange-500 dark:bg-gray-800 dark:text-gray-100 text-sm"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Description
              </label>
              <textarea
                placeholder="Describe what this trigger does..."
                value={config.description}
                onChange={(e) =>
                  setConfig({ ...config, description: e.target.value })
                }
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-orange-500 dark:bg-gray-800 dark:text-gray-100 text-sm"
              />
            </div>

            {/* Info */}
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <div className="flex gap-3">
                <svg
                  className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                    clipRule="evenodd"
                  />
                </svg>
                <div className="text-sm text-blue-900 dark:text-blue-100">
                  <p className="font-medium mb-1">How Jira triggers work</p>
                  <p className="text-xs text-blue-800 dark:text-blue-200">
                    A webhook will be automatically registered with Jira when you save this workflow.
                    When the selected events occur in Jira, this workflow will be triggered.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        {/* Webhook Registration Status - only show when there's a message */}
        {webhookRegistrationResult && webhookRegistrationResult.message && (
          <div
            className={`mb-3 p-3 rounded-md flex items-start gap-2 ${
              webhookRegistrationResult.success
                ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
                : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
            }`}
          >
            {webhookRegistrationResult.success ? (
              <Check className="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
            ) : (
              <svg className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
            <div className="flex-1">
              <p className={`text-sm font-medium ${
                webhookRegistrationResult.success
                  ? 'text-green-800 dark:text-green-200'
                  : 'text-red-800 dark:text-red-200'
              }`}>
                {webhookRegistrationResult.message}
              </p>
              {webhookRegistrationResult.webhookId && (
                <p className="text-xs text-green-700 dark:text-green-300 mt-1">
                  Webhook ID: {webhookRegistrationResult.webhookId}
                </p>
              )}
            </div>
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={isRegisteringWebhook}
          className="w-full px-4 py-2.5 bg-gray-900 hover:bg-gray-800 dark:bg-white dark:hover:bg-gray-100 disabled:bg-gray-400 disabled:cursor-not-allowed text-white dark:text-gray-900 rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-white focus:ring-offset-2 dark:focus:ring-offset-gray-900 flex items-center justify-center gap-2"
        >
          {isRegisteringWebhook ? (
            <>
              <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Registering Webhook...
            </>
          ) : (config.webhookId || initialConfig?.webhookId) ? (
            'Save Changes'
          ) : (
            'Save & Register Webhook'
          )}
        </button>
      </div>

      {/* Validation Snackbar */}
      <Snackbar
        message={validationSnackbar.message}
        type="error"
        isVisible={validationSnackbar.isVisible}
        onClose={() => setValidationSnackbar({ isVisible: false, message: '' })}
        duration={5000}
        position="top-center"
      />
    </div>
  )
}
