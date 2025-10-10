/**
 * Jira Configuration UI
 * Handles both trigger setup and credential configuration
 */

import React, { useState, useEffect } from 'react'
import { JiraIcon } from './WorkflowIcons'
import { Check } from 'lucide-react'

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
}

const JIRA_EVENTS = [
  // Issue Events
  { value: 'jira:issue_created', label: 'Issue Created', description: 'When a new issue is created', category: 'Issue' },
  { value: 'jira:issue_updated', label: 'Issue Updated', description: 'When an issue is updated', category: 'Issue' },
  { value: 'jira:issue_deleted', label: 'Issue Deleted', description: 'When an issue is deleted', category: 'Issue' },

  // Comment Events
  { value: 'comment_created', label: 'Comment Created', description: 'When a comment is added', category: 'Comment' },
  { value: 'comment_updated', label: 'Comment Updated', description: 'When a comment is updated', category: 'Comment' },
  { value: 'comment_deleted', label: 'Comment Deleted', description: 'When a comment is deleted', category: 'Comment' },

  // Project Events
  { value: 'project_created', label: 'Project Created', description: 'When a new project is created', category: 'Project' },
  { value: 'project_updated', label: 'Project Updated', description: 'When a project is updated', category: 'Project' },
  { value: 'project_deleted', label: 'Project Deleted', description: 'When a project is deleted', category: 'Project' },

  // Board Events
  { value: 'board_created', label: 'Board Created', description: 'When a new board is created', category: 'Board' },
  { value: 'board_updated', label: 'Board Updated', description: 'When a board is updated', category: 'Board' },
  { value: 'board_deleted', label: 'Board Deleted', description: 'When a board is deleted', category: 'Board' },
  { value: 'board_configuration_changed', label: 'Board Configuration Changed', description: 'When board configuration is changed', category: 'Board' },

  // Sprint Events
  { value: 'sprint_created', label: 'Sprint Created', description: 'When a new sprint is created', category: 'Sprint' },
  { value: 'sprint_updated', label: 'Sprint Updated', description: 'When a sprint is updated', category: 'Sprint' },
  { value: 'sprint_deleted', label: 'Sprint Deleted', description: 'When a sprint is deleted', category: 'Sprint' },
  { value: 'sprint_started', label: 'Sprint Started', description: 'When a sprint is started', category: 'Sprint' },
  { value: 'sprint_closed', label: 'Sprint Closed', description: 'When a sprint is closed', category: 'Sprint' },

  // Version Events
  { value: 'jira:version_created', label: 'Version Created', description: 'When a new version is created', category: 'Version' },
  { value: 'jira:version_updated', label: 'Version Updated', description: 'When a version is updated', category: 'Version' },
  { value: 'jira:version_deleted', label: 'Version Deleted', description: 'When a version is deleted', category: 'Version' },
  { value: 'jira:version_released', label: 'Version Released', description: 'When a version is released', category: 'Version' },
  { value: 'jira:version_unreleased', label: 'Version Unreleased', description: 'When a version is unreleased', category: 'Version' },
  { value: 'jira:version_moved', label: 'Version Moved', description: 'When a version is moved', category: 'Version' },

  // User Events
  { value: 'user_created', label: 'User Created', description: 'When a new user is created', category: 'User' },
  { value: 'user_updated', label: 'User Updated', description: 'When a user is updated', category: 'User' },
  { value: 'user_deleted', label: 'User Deleted', description: 'When a user is deleted', category: 'User' },

  // Worklog Events
  { value: 'worklog_created', label: 'Worklog Created', description: 'When a worklog entry is created', category: 'Worklog' },
  { value: 'worklog_updated', label: 'Worklog Updated', description: 'When a worklog entry is updated', category: 'Worklog' },
  { value: 'worklog_deleted', label: 'Worklog Deleted', description: 'When a worklog entry is deleted', category: 'Worklog' },

  // Issue Link Events
  { value: 'issuelink_created', label: 'Issue Link Created', description: 'When an issue link is created', category: 'Issue Link' },
  { value: 'issuelink_deleted', label: 'Issue Link Deleted', description: 'When an issue link is deleted', category: 'Issue Link' },

  // Option Events
  { value: 'option_voting_changed', label: 'Option Voting Changed', description: 'When voting option is changed', category: 'Options' },
  { value: 'option_watching_changed', label: 'Option Watching Changed', description: 'When watching option is changed', category: 'Options' },
  { value: 'option_unassigned_issues_changed', label: 'Option Unassigned Issues Changed', description: 'When unassigned issues option is changed', category: 'Options' },
  { value: 'option_subtasks_changed', label: 'Option Subtasks Changed', description: 'When subtasks option is changed', category: 'Options' },
  { value: 'option_attachments_changed', label: 'Option Attachments Changed', description: 'When attachments option is changed', category: 'Options' },
  { value: 'option_issuelinks_changed', label: 'Option Issue Links Changed', description: 'When issue links option is changed', category: 'Options' },
  { value: 'option_timetracking_changed', label: 'Option Timetracking Changed', description: 'When timetracking option is changed', category: 'Options' },
]

export const JiraConfigurationUI: React.FC<JiraConfigurationUIProps> = ({
  isVisible,
  onClose,
  onSave,
  onBack,
  initialConfig,
}) => {
  const [config, setConfig] = useState<JiraConfig>({
    domain: initialConfig?.domain || '',
    email: initialConfig?.email || '',
    apiToken: initialConfig?.apiToken || '',
    events: initialConfig?.events || [],
    title: initialConfig?.title || 'Jira Trigger',
    description: initialConfig?.description || '',
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

  // Generate unique webhook ID if not present
  useEffect(() => {
    if (!config.webhookId && !initialConfig?.webhookId) {
      const uniqueId = `jira-webhook-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      setConfig((prev) => ({ ...prev, webhookId: uniqueId }))
    }
  }, [])

  // Generate webhook URLs
  const generateWebhookUrls = () => {
    // Use ngrok URL for development (Jira requires HTTPS)
    // In production, use the actual domain
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    const baseUrl = isLocalhost
      ? 'https://dc17f2a8bbf0.ngrok-free.app'  // ngrok HTTPS tunnel
      : window.location.origin

    const webhookId = config.webhookId || initialConfig?.webhookId || 'pending'
    const testUrl = `${baseUrl}/webhook-test/jira/${webhookId}`
    const productionUrl = `${baseUrl}/webhook/jira/${webhookId}`

    return { testUrl, productionUrl }
  }

  // Reset state when initialConfig changes
  useEffect(() => {
    if (initialConfig) {
      setConfig({
        domain: initialConfig.domain || '',
        email: initialConfig.email || '',
        apiToken: initialConfig.apiToken || '',
        events: initialConfig.events || [],
        webhookId: initialConfig.webhookId || config.webhookId,
        webhookUrl: initialConfig.webhookUrl,
        testWebhookUrl: initialConfig.testWebhookUrl,
        productionWebhookUrl: initialConfig.productionWebhookUrl,
        title: initialConfig.title || 'Jira Trigger',
        description: initialConfig.description || '',
      })
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
    try {
      await navigator.clipboard.writeText(url)
      if (isTest) {
        setCopiedTest(true)
        setTimeout(() => setCopiedTest(false), 2000)
      } else {
        setCopiedProduction(true)
        setTimeout(() => setCopiedProduction(false), 2000)
      }
    } catch (err) {
      console.error('Failed to copy URL:', err)
      // Fallback for browsers that don't support clipboard API
      const textArea = document.createElement('textarea')
      textArea.value = url
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      if (isTest) {
        setCopiedTest(true)
        setTimeout(() => setCopiedTest(false), 2000)
      } else {
        setCopiedProduction(true)
        setTimeout(() => setCopiedProduction(false), 2000)
      }
    }
  }

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
    } catch (error: any) {
      console.error('Connection test failed:', error)
      setConnectionTestResult({
        success: false,
        message: error.message || 'Connection test failed. Please check your credentials.',
      })
    } finally {
      setIsTestingConnection(false)
    }
  }

  const handleSave = async () => {
    // Validate required fields
    if (!config.domain || !config.email || !config.apiToken) {
      alert('Please fill in all required credential fields')
      return
    }

    // Require successful connection test before save
    if (!connectionTestResult || !connectionTestResult.success) {
      alert('Please test the connection successfully before saving')
      return
    }

    if (config.events.length === 0) {
      alert('Please select at least one event')
      return
    }

    setIsRegisteringWebhook(true)
    setWebhookRegistrationResult(null)

    try {
      // Generate webhook URLs
      const { testUrl, productionUrl } = generateWebhookUrls()

      // Register webhook with Jira
      const { workflowToolsAPI } = await import('./api/ApiHandlers')
      const webhookResult = await workflowToolsAPI.registerJiraWebhook({
        domain: config.domain,
        email: config.email,
        apiToken: config.apiToken,
        webhookUrl: productionUrl,
        events: config.events,
        name: config.title || 'Xyne Jira Trigger',
      })

      setWebhookRegistrationResult({
        success: true,
        message: 'Webhook registered successfully',
        webhookId: webhookResult.webhookId,
      })

      // Save config with webhook details
      const finalConfig = {
        ...config,
        testWebhookUrl: testUrl,
        productionWebhookUrl: productionUrl,
        webhookUrl: productionUrl,
        webhookId: webhookResult.webhookId,
      }

      onSave(finalConfig)
    } catch (error: any) {
      console.error('Webhook registration failed:', error)
      setWebhookRegistrationResult({
        success: false,
        message: error.message || 'Failed to register webhook. Please try again.',
      })
    } finally {
      setIsRegisteringWebhook(false)
    }
  }

  if (!isVisible) return null

  return (
    <div className="fixed top-0 right-0 h-full w-[450px] bg-white dark:bg-gray-900 shadow-2xl z-50 flex flex-col animate-slide-in-right border-l border-gray-200 dark:border-gray-700">
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
              ? 'text-orange-600 dark:text-orange-400 border-b-2 border-orange-600 dark:border-orange-400 bg-white dark:bg-gray-900'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
          }`}
        >
          Parameters
        </button>
        <button
          onClick={() => setActiveTab('settings')}
          className={`flex-1 px-6 py-3 text-sm font-medium transition-colors ${
            activeTab === 'settings'
              ? 'text-orange-600 dark:text-orange-400 border-b-2 border-orange-600 dark:border-orange-400 bg-white dark:bg-gray-900'
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
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-orange-500 dark:bg-gray-800 dark:text-gray-100 text-sm"
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
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-orange-500 dark:bg-gray-800 dark:text-gray-100 text-sm"
                />
              </div>

              {/* API Token */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  API Token *
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Your Jira API token"
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
                  className="px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-medium rounded-md transition-colors text-sm flex items-center gap-2"
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
                  <label
                    key={event.value}
                    className="flex items-start gap-3 p-3 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors border border-transparent hover:border-gray-200 dark:hover:border-gray-700"
                  >
                    <input
                      type="checkbox"
                      checked={config.events.includes(event.value)}
                      onChange={() => handleEventToggle(event.value)}
                      className="mt-0.5 w-4 h-4 text-orange-600 border-gray-300 dark:border-gray-600 rounded focus:ring-orange-500 dark:bg-gray-700"
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {event.label}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {event.description}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
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
        {/* Webhook Registration Status */}
        {webhookRegistrationResult && (
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
          className="w-full px-4 py-2.5 bg-orange-600 hover:bg-orange-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 flex items-center justify-center gap-2"
        >
          {isRegisteringWebhook ? (
            <>
              <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Registering Webhook...
            </>
          ) : (
            'Save & Register Webhook'
          )}
        </button>
      </div>
    </div>
  )
}
