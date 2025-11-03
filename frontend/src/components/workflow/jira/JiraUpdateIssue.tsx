/**
 * Jira Update Issue Action Component
 * UI for configuring Jira issue updates
 */

import React, { useState } from 'react'
import { JiraIcon } from '../WorkflowIcons'

interface JiraUpdateIssueProps {
  onSave: (config: JiraUpdateIssueConfig) => void
  initialConfig?: Partial<JiraUpdateIssueConfig>
}

export interface JiraUpdateIssueConfig {
  // Credentials
  domain: string
  email: string
  apiToken: string

  // Issue Details
  issueKey: string
  summary?: string
  description?: string
  priority?: string
  assignee?: string | null
  labels?: string[]
  components?: string[]
  status?: string
}

const PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest']
const COMMON_STATUSES = [
  'To Do',
  'In Progress',
  'In Review',
  'Done',
  'Blocked',
]

export const JiraUpdateIssue: React.FC<JiraUpdateIssueProps> = ({
  onSave,
  initialConfig,
}) => {
  const [config, setConfig] = useState<JiraUpdateIssueConfig>({
    domain: initialConfig?.domain || '',
    email: initialConfig?.email || '',
    apiToken: initialConfig?.apiToken || '',
    issueKey: initialConfig?.issueKey || '',
    summary: initialConfig?.summary,
    description: initialConfig?.description,
    priority: initialConfig?.priority,
    assignee: initialConfig?.assignee,
    labels: initialConfig?.labels || [],
    components: initialConfig?.components || [],
    status: initialConfig?.status,
  })

  const [showPassword, setShowPassword] = useState(false)
  const [labelInput, setLabelInput] = useState('')
  const [updateFields, setUpdateFields] = useState<Set<string>>(
    new Set(
      Object.entries(initialConfig || {})
        .filter(([key, value]) =>
          value !== undefined &&
          !['domain', 'email', 'apiToken', 'issueKey'].includes(key)
        )
        .map(([key]) => key)
    )
  )

  const toggleField = (field: string) => {
    setUpdateFields((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(field)) {
        newSet.delete(field)
      } else {
        newSet.add(field)
      }
      return newSet
    })
  }

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

    if (!config.issueKey) {
      alert('Please enter the issue key')
      return
    }

    if (updateFields.size === 0) {
      alert('Please select at least one field to update')
      return
    }

    // Only include fields that are selected for update
    const configToSave: any = {
      domain: config.domain,
      email: config.email,
      apiToken: config.apiToken,
      issueKey: config.issueKey,
    }

    updateFields.forEach((field) => {
      if (field !== 'issueKey') {
        configToSave[field] = (config as any)[field]
      }
    })

    onSave(configToSave)
  }

  return (
    <div className="flex flex-col gap-4 p-4 max-h-[600px] overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-3 pb-3 border-b border-gray-200">
        <JiraIcon width={32} height={32} />
        <div>
          <h3 className="text-lg font-semibold text-gray-900">
            Update Jira Issue
          </h3>
          <p className="text-sm text-gray-500">
            Update an existing issue in Jira
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

      {/* Issue Key */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Issue Key *
        </label>
        <input
          type="text"
          placeholder="PROJ-123"
          value={config.issueKey}
          onChange={(e) =>
            setConfig({ ...config, issueKey: e.target.value.toUpperCase() })
          }
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p className="text-xs text-gray-500 mt-1">
          The key of the issue to update (e.g., PROJ-123)
        </p>
      </div>

      {/* Fields to Update */}
      <div className="space-y-4">
        <h4 className="text-sm font-medium text-gray-700">
          Fields to Update (select at least one)
        </h4>

        {/* Summary */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer mb-2">
            <input
              type="checkbox"
              checked={updateFields.has('summary')}
              onChange={() => toggleField('summary')}
              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            <span className="text-sm font-medium text-gray-700">Summary</span>
          </label>
          {updateFields.has('summary') && (
            <input
              type="text"
              placeholder="New summary"
              value={config.summary || ''}
              onChange={(e) =>
                setConfig({ ...config, summary: e.target.value })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
        </div>

        {/* Description */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer mb-2">
            <input
              type="checkbox"
              checked={updateFields.has('description')}
              onChange={() => toggleField('description')}
              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            <span className="text-sm font-medium text-gray-700">
              Description
            </span>
          </label>
          {updateFields.has('description') && (
            <textarea
              placeholder="New description"
              value={config.description || ''}
              onChange={(e) =>
                setConfig({ ...config, description: e.target.value })
              }
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
        </div>

        {/* Priority */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer mb-2">
            <input
              type="checkbox"
              checked={updateFields.has('priority')}
              onChange={() => toggleField('priority')}
              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            <span className="text-sm font-medium text-gray-700">Priority</span>
          </label>
          {updateFields.has('priority') && (
            <select
              value={config.priority || 'Medium'}
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
          )}
        </div>

        {/* Status */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer mb-2">
            <input
              type="checkbox"
              checked={updateFields.has('status')}
              onChange={() => toggleField('status')}
              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            <span className="text-sm font-medium text-gray-700">Status</span>
          </label>
          {updateFields.has('status') && (
            <select
              value={config.status || 'To Do'}
              onChange={(e) =>
                setConfig({ ...config, status: e.target.value })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {COMMON_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Assignee */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer mb-2">
            <input
              type="checkbox"
              checked={updateFields.has('assignee')}
              onChange={() => toggleField('assignee')}
              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            <span className="text-sm font-medium text-gray-700">Assignee</span>
          </label>
          {updateFields.has('assignee') && (
            <div>
              <input
                type="text"
                placeholder="User account ID (or leave empty to unassign)"
                value={config.assignee || ''}
                onChange={(e) =>
                  setConfig({ ...config, assignee: e.target.value || null })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">
                Leave empty to unassign the issue
              </p>
            </div>
          )}
        </div>

        {/* Labels */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer mb-2">
            <input
              type="checkbox"
              checked={updateFields.has('labels')}
              onChange={() => toggleField('labels')}
              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            <span className="text-sm font-medium text-gray-700">Labels</span>
          </label>
          {updateFields.has('labels') && (
            <div>
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
          )}
        </div>
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
