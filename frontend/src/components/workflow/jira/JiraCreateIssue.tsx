/**
 * Jira Create Issue Action Component
 * UI for configuring Jira issue creation
 */

import React, { useState } from 'react'
import { JiraIcon } from '../WorkflowIcons'

interface JiraCreateIssueProps {
  onSave: (config: JiraCreateIssueConfig) => void
  initialConfig?: Partial<JiraCreateIssueConfig>
}

export interface JiraCreateIssueConfig {
  // Credentials
  domain: string
  email: string
  apiToken: string

  // Issue Details
  projectKey: string
  summary: string
  description?: string
  issueType: string
  priority?: string
  assignee?: string
  labels?: string[]
  components?: string[]
  parentKey?: string
}

const ISSUE_TYPES = ['Task', 'Story', 'Bug', 'Epic', 'Subtask']
const PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest']

export const JiraCreateIssue: React.FC<JiraCreateIssueProps> = ({
  onSave,
  initialConfig,
}) => {
  const [config, setConfig] = useState<JiraCreateIssueConfig>({
    domain: initialConfig?.domain || '',
    email: initialConfig?.email || '',
    apiToken: initialConfig?.apiToken || '',
    projectKey: initialConfig?.projectKey || '',
    summary: initialConfig?.summary || '',
    description: initialConfig?.description || '',
    issueType: initialConfig?.issueType || 'Task',
    priority: initialConfig?.priority || 'Medium',
    assignee: initialConfig?.assignee || '',
    labels: initialConfig?.labels || [],
    components: initialConfig?.components || [],
    parentKey: initialConfig?.parentKey || '',
  })

  const [showPassword, setShowPassword] = useState(false)
  const [labelInput, setLabelInput] = useState('')

  const handleAddLabel = () => {
    if (labelInput.trim() && !config.labels?.includes(labelInput.trim())) {
      setConfig({
        ...config,
        labels: [...(config.labels || []), labelInput.trim()],
      })
      setLabelInput('')
    }
  }

  const handleRemoveLabel = (label: string) => {
    setConfig({
      ...config,
      labels: config.labels?.filter((l) => l !== label) || [],
    })
  }


  const handleSave = () => {
    // Validate required fields
    if (!config.domain || !config.email || !config.apiToken) {
      alert('Please fill in Jira credentials')
      return
    }

    if (!config.projectKey || !config.summary || !config.issueType) {
      alert('Please fill in required issue fields')
      return
    }

    // Validate parentKey for Subtask
    if (config.issueType === 'Subtask' && !config.parentKey) {
      alert('Please provide Parent Issue Key for a Subtask')
      return
    }

    onSave(config)
  }

  return (
    <div className="flex flex-col gap-4 p-4 max-h-[600px] overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-3 pb-3 border-b border-gray-200">
        <JiraIcon width={32} height={32} />
        <div>
          <h3 className="text-lg font-semibold text-gray-900">
            Create Jira Issue
          </h3>
          <p className="text-sm text-gray-500">
            Create a new issue in Jira
          </p>
        </div>
      </div>

      {/* Credentials Section */}
      <div className="space-y-4">
        <h4 className="text-sm font-medium text-gray-700">Jira Credentials</h4>

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
        </div>

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
        </div>
      </div>

      {/* Issue Details Section */}
      <div className="space-y-4">
        <h4 className="text-sm font-medium text-gray-700">Issue Details</h4>

        <div className="grid grid-cols-2 gap-3">
          {/* Project Key */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Project Key *
            </label>
            <input
              type="text"
              placeholder="PROJ"
              value={config.projectKey}
              onChange={(e) =>
                setConfig({ ...config, projectKey: e.target.value.toUpperCase() })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Issue Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Issue Type *
            </label>
            <select
              value={config.issueType}
              onChange={(e) =>
                setConfig({ ...config, issueType: e.target.value })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {ISSUE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Summary */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Summary *
          </label>
          <input
            type="text"
            placeholder="Issue summary"
            value={config.summary}
            onChange={(e) =>
              setConfig({ ...config, summary: e.target.value })
            }
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Description
          </label>
          <textarea
            placeholder="Issue description"
            value={config.description}
            onChange={(e) =>
              setConfig({ ...config, description: e.target.value })
            }
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* Priority */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Priority
            </label>
            <select
              value={config.priority}
              onChange={(e) =>
                setConfig({ ...config, priority: e.target.value })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {priority}
                </option>
              ))}
            </select>
          </div>

          {/* Assignee */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Assignee (Account ID)
            </label>
            <input
              type="text"
              placeholder="User account ID"
              value={config.assignee}
              onChange={(e) =>
                setConfig({ ...config, assignee: e.target.value })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Labels */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Labels
          </label>
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              placeholder="Add label"
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddLabel()}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleAddLabel}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200"
            >
              Add
            </button>
          </div>
          {config.labels && config.labels.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {config.labels.map((label) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 text-blue-800 rounded text-sm"
                >
                  {label}
                  <button
                    onClick={() => handleRemoveLabel(label)}
                    className="text-blue-600 hover:text-blue-800"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Parent Key (for subtasks) */}
        {config.issueType === 'Subtask' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Parent Issue Key
            </label>
            <input
              type="text"
              placeholder="PROJ-123"
              value={config.parentKey}
              onChange={(e) =>
                setConfig({ ...config, parentKey: e.target.value.toUpperCase() })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2 pt-4 border-t border-gray-200 sticky bottom-0 bg-white">
        <button
          onClick={handleSave}
          className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          Save Action
        </button>
      </div>
    </div>
  )
}
