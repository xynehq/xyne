/**
 * Jira Integration Configuration
 */

export const JIRA_CONFIG = {
  // API version
  apiVersion: '2', // Jira Cloud REST API v2 (more compatible with n8n)

  // Base paths
  basePaths: {
    cloud: (domain: string) => {
      // Strip https:// or http:// if provided
      const cleanDomain = domain.replace(/^https?:\/\//, '')
      return `https://${cleanDomain}/rest/api/2`
    },
    webhook: (domain: string) => {
      const cleanDomain = domain.replace(/^https?:\/\//, '')
      return `https://${cleanDomain}/rest/webhooks/1.0/webhook`
    },
  },

  // Webhook settings
  webhook: {
    maxRetries: 3,
    timeout: 30000, // 30 seconds
  },

  // Default issue fields to fetch
  defaultFields: [
    'summary',
    'description',
    'status',
    'priority',
    'assignee',
    'reporter',
    'created',
    'updated',
    'issuetype',
    'project',
    'labels',
    'components',
    'fixVersions',
    'parent',
  ],

  // Rate limiting
  rateLimit: {
    requestsPerSecond: 100,
    burstSize: 200,
  },
} as const

export const JIRA_ISSUE_TYPES = [
  'Task',
  'Story',
  'Bug',
  'Epic',
  'Subtask',
] as const

export const JIRA_PRIORITIES = [
  'Highest',
  'High',
  'Medium',
  'Low',
  'Lowest',
] as const

export const JIRA_STATUS_CATEGORIES = [
  'To Do',
  'In Progress',
  'Done',
] as const
