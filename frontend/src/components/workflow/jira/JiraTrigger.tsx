/**
 * Jira Trigger Component
 * UI for configuring Jira webhook triggers
 */

import React, { useState } from 'react'
import { JiraIcon } from '../WorkflowIcons'

interface JiraTriggerProps {
  onSave: (config: JiraTriggerConfig) => void
  initialConfig?: Partial<JiraTriggerConfig>
}

export interface JiraTriggerConfig {
  domain: string
  email: string
  apiToken: string
  events: string[]
  jqlFilter?: string
}

const JIRA_EVENTS = [
  { value: 'jira:issue_created', label: 'Issue Created' },
  { value: 'jira:issue_updated', label: 'Issue Updated' },
  { value: 'jira:issue_deleted', label: 'Issue Deleted' },
  { value: 'comment_created', label: 'Comment Created' },
  { value: 'comment_updated', label: 'Comment Updated' },
  { value: 'comment_deleted', label: 'Comment Deleted' },
]

export const JiraTrigger: React.FC<JiraTriggerProps> = ({
  onSave,
  initialConfig,
}) => {
  const [config, setConfig] = useState<JiraTriggerConfig>({
    domain: initialConfig?.domain || '',
    email: initialConfig?.email || '',
    apiToken: initialConfig?.apiToken || '',
    events: initialConfig?.events || ['jira:issue_created', 'jira:issue_updated'],
    jqlFilter: initialConfig?.jqlFilter || '',
  })

  const [showPassword, setShowPassword] = useState(false)

  const handleEventToggle = (eventValue: string) => {
    setConfig((prev) => ({
      ...prev,
      events: prev.events.includes(eventValue)
        ? prev.events.filter((e) => e !== eventValue)
        : [...prev.events, eventValue],
    }))
  }

  const handleSave = () => {
    // Validate required fields
    if (!config.domain || !config.email || !config.apiToken) {
      alert('Please fill in all required fields')
      return
    }

    if (config.events.length === 0) {
      alert('Please select at least one event')
      return
    }

    onSave(config)
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Header */}
      <div className="flex items-center gap-3 pb-3 border-b border-gray-200">
        <JiraIcon width={32} height={32} />
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Jira Trigger</h3>
          <p className="text-sm text-gray-500">
            Trigger workflow when Jira events occur
          </p>
        </div>
      </div>

      {/* Credentials Section */}
      <div className="space-y-4">
        <h4 className="text-sm font-medium text-gray-700">Jira Credentials</h4>

        {/* Domain */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Jira Domain *
          </label>
          <input
            type="text"
            placeholder="your-domain.atlassian.net"
            value={config.domain}
            onChange={(e) =>
              setConfig({ ...config, domain: e.target.value })
            }
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-gray-500 mt-1">
            Enter your Jira Cloud domain (e.g., company.atlassian.net)
          </p>
        </div>

        {/* Email */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Email *
          </label>
          <input
            type="email"
            placeholder="you@example.com"
            value={config.email}
            onChange={(e) => setConfig({ ...config, email: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* API Token */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
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
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-sm text-gray-500 hover:text-gray-700"
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            <a
              href="https://id.atlassian.com/manage-profile/security/api-tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Create an API token
            </a>
          </p>
        </div>
      </div>

      {/* Events Section */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-gray-700">Events to Listen *</h4>
        <div className="space-y-2">
          {JIRA_EVENTS.map((event) => (
            <label
              key={event.value}
              className="flex items-center gap-2 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={config.events.includes(event.value)}
                onChange={() => handleEventToggle(event.value)}
                className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">{event.label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* JQL Filter (Optional) */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          JQL Filter (Optional)
        </label>
        <textarea
          placeholder='project = "PROJ" AND issuetype = "Bug"'
          value={config.jqlFilter}
          onChange={(e) =>
            setConfig({ ...config, jqlFilter: e.target.value })
          }
          rows={2}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
        />
        <p className="text-xs text-gray-500 mt-1">
          Filter events using JQL (Jira Query Language)
        </p>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2 pt-4 border-t border-gray-200">
        <button
          onClick={handleSave}
          className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          Save Trigger
        </button>
      </div>
    </div>
  )
}
