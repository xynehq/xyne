/**
 * Jira API Client
 * Handles authentication and API requests to Jira Cloud
 */

import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios'
import { getLogger } from '@/logger'
import { Subsystem } from '@/types'
import type {
  JiraCredentials,
  JiraIssue,
  JiraProject,
  JiraIssueType,
  JiraPriority,
  JiraUser,
  JiraWebhook,
  JiraIssueCreateInput,
  JiraIssueUpdateInput,
} from './types'
import { JIRA_CONFIG } from './config'
import { textToADF, formatJiraError, parseIssueKey } from './utils'

const Logger = getLogger(Subsystem.Integrations).child({ module: 'jira' })

export class JiraClient {
  private client: AxiosInstance
  private webhookClient: AxiosInstance
  private credentials: JiraCredentials

  /**
   * Helper to preserve axios error metadata when rethrowing
   */
  private throwWithResponse(ctx: string, error: any): never {
    const enriched: any = new Error(`${ctx}: ${formatJiraError(error)}`)
    if (error?.response) enriched.response = error.response
    if (error?.code) enriched.code = error.code
    enriched.cause = error
    throw enriched
  }

  constructor(credentials: JiraCredentials) {
    this.credentials = credentials

    const auth = Buffer.from(
      `${credentials.email}:${credentials.apiToken}`
    ).toString('base64')

    // Main API client
    this.client = axios.create({
      baseURL: JIRA_CONFIG.basePaths.cloud(credentials.domain),
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 30000,
    })

    // Webhook API client
    this.webhookClient = axios.create({
      baseURL: JIRA_CONFIG.basePaths.webhook(credentials.domain),
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 30000,
    })
  }

  /**
   * Test connection to Jira
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.client.get('/myself')
      return true
    } catch (error) {
      this.throwWithResponse('Jira connection failed', error)
    }
  }

  // ==================== PROJECT METHODS ====================

  /**
   * Get all projects
   */
  async getProjects(): Promise<JiraProject[]> {
    try {
      const response = await this.client.get('/project')
      return response.data
    } catch (error) {
      this.throwWithResponse('Failed to get projects', error)
    }
  }

  /**
   * Get project by key
   */
  async getProject(projectKey: string): Promise<JiraProject> {
    try {
      const response = await this.client.get(`/project/${projectKey}`)
      return response.data
    } catch (error) {
      this.throwWithResponse('Failed to get project', error)
    }
  }

  // ==================== ISSUE TYPE METHODS ====================

  /**
   * Get issue types for a project
   */
  async getIssueTypes(projectKey: string): Promise<JiraIssueType[]> {
    try {
      // First get the project to retrieve its ID
      const projectResponse = await this.client.get(`/project/${projectKey}`)
      const projectId = projectResponse.data.id

      // Use the correct endpoint for issue types
      const response = await this.client.get('/issuetype/project', {
        params: { projectId },
      })
      return response.data
    } catch (error) {
      this.throwWithResponse('Failed to get issue types', error)
    }
  }

  // ==================== PRIORITY METHODS ====================

  /**
   * Get all priorities
   */
  async getPriorities(): Promise<JiraPriority[]> {
    try {
      const response = await this.client.get('/priority')
      return response.data
    } catch (error) {
      this.throwWithResponse('Failed to get priorities', error)
    }
  }

  // ==================== STATUS METHODS ====================

  /**
   * Get all statuses
   */
  async getStatuses(): Promise<any[]> {
    try {
      const response = await this.client.get('/status')
      return response.data
    } catch (error) {
      this.throwWithResponse('Failed to get statuses', error)
    }
  }

  /**
   * Get statuses for a specific project
   */
  async getProjectStatuses(projectKey: string): Promise<any[]> {
    try {
      const response = await this.client.get(`/project/${projectKey}/statuses`)
      return response.data
    } catch (error) {
      this.throwWithResponse('Failed to get project statuses', error)
    }
  }

  // ==================== COMPONENT METHODS ====================

  /**
   * Get components for a project
   */
  async getComponents(projectKey: string): Promise<any[]> {
    try {
      const response = await this.client.get(`/project/${projectKey}/components`)
      return response.data
    } catch (error) {
      this.throwWithResponse('Failed to get components', error)
    }
  }

  // ==================== EPIC METHODS ====================

  /**
   * Search for epics in a project using JQL
   */
  async getEpics(projectKey: string): Promise<any[]> {
    try {
      const response = await this.client.get('/search', {
        params: {
          jql: `project = "${projectKey}" AND issuetype = Epic ORDER BY created DESC`,
          maxResults: 100,
          fields: 'summary,key,status'
        }
      })
      return response.data.issues || []
    } catch (error) {
      this.throwWithResponse('Failed to get epics', error)
    }
  }

  /**
   * Search for issues in projects using JQL
   */
  async searchIssuesByProjects(projectKeys: string[], searchText?: string, maxResults: number = 50): Promise<any[]> {
    try {
      let jql = ''

      // Build project filter
      if (projectKeys.length === 1) {
        jql = `project = "${projectKeys[0]}"`
      } else if (projectKeys.length > 1) {
        const projectList = projectKeys.map(k => `"${k}"`).join(', ')
        jql = `project IN (${projectList})`
      } else {
        // If no projects specified, search all projects (limited by maxResults)
        jql = 'project IS NOT EMPTY'
      }

      // Add text search if provided
      if (searchText && searchText.trim()) {
        jql += ` AND (summary ~ "${searchText}" OR key ~ "${searchText}")`
      }

      // Order by most recently updated
      jql += ' ORDER BY updated DESC'

      const response = await this.client.get('/search', {
        params: {
          jql,
          maxResults,
          fields: 'summary,key,status,issuetype,priority'
        }
      })
      return response.data.issues || []
    } catch (error) {
      this.throwWithResponse('Failed to search issues', error)
    }
  }

  // ==================== USER METHODS ====================

  /**
   * Search for users
   */
  async searchUsers(query: string): Promise<JiraUser[]> {
    try {
      const response = await this.client.get('/user/search/query', {
        params: { query },
      })
      return response.data
    } catch (error) {
      this.throwWithResponse('Failed to search users', error)
    }
  }

  /**
   * Get user by account ID
   */
  async getUser(accountId: string): Promise<JiraUser> {
    try {
      const response = await this.client.get('/user', {
        params: { accountId },
      })
      return response.data
    } catch (error) {
      this.throwWithResponse('Failed to get user', error)
    }
  }

  // ==================== ISSUE METHODS ====================

  /**
   * Get issue by key
   */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    try {
      const response = await this.client.get(`/issue/${issueKey}`)
      return response.data
    } catch (error) {
      this.throwWithResponse('Failed to get issue', error)
    }
  }

  /**
   * Create a new issue
   */
  async createIssue(input: JiraIssueCreateInput): Promise<JiraIssue> {
    try {
      const fields: any = {
        project: {
          key: input.projectKey,
        },
        summary: input.summary,
        issuetype: {
          name: input.issueType,
        },
      }

      // Add description in ADF format
      if (input.description) {
        fields.description = textToADF(input.description)
      }

      // Add priority
      if (input.priority) {
        fields.priority = {
          name: input.priority,
        }
      }

      // Add assignee
      if (input.assignee) {
        fields.assignee = {
          accountId: input.assignee,
        }
      }

      // Add labels
      if (input.labels && input.labels.length > 0) {
        fields.labels = input.labels
      }

      // Add components
      if (input.components && input.components.length > 0) {
        fields.components = input.components.map(name => ({ name }))
      }

      // Add parent (for subtasks)
      if (input.parentKey) {
        fields.parent = {
          key: input.parentKey,
        }
      }

      // Add custom fields
      if (input.customFields) {
        Object.assign(fields, input.customFields)
      }

      const response = await this.client.post('/issue', {
        fields,
      })

      // Fetch the created issue to return full details
      return await this.getIssue(response.data.key)
    } catch (error) {
      this.throwWithResponse('Failed to create issue', error)
    }
  }

  /**
   * Update an existing issue
   */
  async updateIssue(input: JiraIssueUpdateInput): Promise<JiraIssue> {
    try {
      const parsed = parseIssueKey(input.issueKey)
      if (!parsed) {
        throw new Error(`Invalid issue key format: ${input.issueKey}`)
      }

      const fields: any = {}

      // Update summary
      if (input.summary !== undefined) {
        fields.summary = input.summary
      }

      // Update description
      if (input.description !== undefined) {
        fields.description = textToADF(input.description)
      }

      // Update priority
      if (input.priority !== undefined) {
        fields.priority = {
          name: input.priority,
        }
      }

      // Update assignee (null to unassign)
      if (input.assignee !== undefined) {
        fields.assignee = input.assignee
          ? { accountId: input.assignee }
          : null
      }

      // Update labels
      if (input.labels !== undefined) {
        fields.labels = input.labels
      }

      // Update components
      if (input.components !== undefined) {
        fields.components = input.components.map(name => ({ name }))
      }

      // Add custom fields
      if (input.customFields) {
        Object.assign(fields, input.customFields)
      }

      // Update the issue
      await this.client.put(`/issue/${input.issueKey}`, {
        fields,
      })

      // Handle status transition separately if provided
      if (input.status) {
        await this.transitionIssue(input.issueKey, input.status)
      }

      // Fetch the updated issue to return full details
      return await this.getIssue(input.issueKey)
    } catch (error) {
      this.throwWithResponse('Failed to update issue', error)
    }
  }

  /**
   * Transition issue to a new status
   */
  private async transitionIssue(
    issueKey: string,
    statusName: string
  ): Promise<void> {
    try {
      // Get available transitions
      const transitionsResponse = await this.client.get(
        `/issue/${issueKey}/transitions`
      )
      const transitions = transitionsResponse.data.transitions

      // Find the transition that matches the desired status
      const transition = transitions.find(
        (t: any) => t.to.name.toLowerCase() === statusName.toLowerCase()
      )

      if (!transition) {
        throw new Error(
          `Status "${statusName}" not available for issue ${issueKey}`
        )
      }

      // Perform the transition
      await this.client.post(`/issue/${issueKey}/transitions`, {
        transition: {
          id: transition.id,
        },
      })
    } catch (error) {
      this.throwWithResponse('Failed to transition issue', error)
    }
  }

  /**
   * Search issues using JQL
   */
  async searchIssues(
    jql: string,
    options: { maxResults?: number; startAt?: number } = {}
  ): Promise<{ issues: JiraIssue[]; total: number }> {
    try {
      const response = await this.client.get('/search', {
        params: {
          jql,
          maxResults: options.maxResults || 50,
          startAt: options.startAt || 0,
          fields: JIRA_CONFIG.defaultFields.join(','),
        },
      })

      return {
        issues: response.data.issues,
        total: response.data.total,
      }
    } catch (error) {
      this.throwWithResponse('Failed to search issues', error)
    }
  }

  // ==================== WEBHOOK METHODS ====================

  /**
   * Get all webhooks
   */
  async getWebhooks(): Promise<JiraWebhook[]> {
    try {
      const response = await this.webhookClient.get('')
      return response.data
    } catch (error) {
      this.throwWithResponse('Failed to get webhooks', error)
    }
  }

  /**
   * Create a webhook
   */
  async createWebhook(webhook: Omit<JiraWebhook, 'id'>): Promise<JiraWebhook> {
    try {
      Logger.debug({
        webhookUrl: webhook.url,
        events: webhook.events,
        endpoint: this.webhookClient.defaults.baseURL
      }, 'Creating Jira webhook')

      const response = await this.webhookClient.post('', webhook)

      Logger.info({ webhookId: response.data.id, url: webhook.url }, 'Jira webhook created successfully')
      return response.data
    } catch (error: any) {
      Logger.error({
        error: formatJiraError(error),
        status: error.response?.status,
        errorData: error.response?.data,
        webhookUrl: webhook.url
      }, 'Failed to create Jira webhook')

      this.throwWithResponse('Failed to create webhook', error)
    }
  }

  /**
   * Delete a webhook
   */
  async deleteWebhook(webhookId: string): Promise<void> {
    try {
      await this.webhookClient.delete(`/${webhookId}`)
    } catch (error) {
      this.throwWithResponse('Failed to delete webhook', error)
    }
  }

  /**
   * Check if webhook exists by URL
   * @param url - Webhook URL to check
   * @param events - Array of event types
   * @param opts - Options for matching behavior
   * @param opts.exact - If true, require exact event set match (default: true)
   */
  async webhookExists(
    url: string,
    events: string[],
    opts?: { exact?: boolean }
  ): Promise<string | null> {
    try {
      const webhooks = await this.getWebhooks()
      const exact = opts?.exact !== false // Default to true

      for (const webhook of webhooks) {
        if (webhook.url !== url) continue

        // Create Sets for comparison
        const a = new Set(events)
        const b = new Set(webhook.events)

        // Check for exact match or superset match based on opts
        const isSuperset = [...a].every(e => b.has(e))
        const isExact = isSuperset && a.size === b.size

        if ((exact && isExact) || (!exact && isSuperset)) {
          return webhook.id || null
        }
      }

      return null
    } catch (error) {
      return null
    }
  }
}
