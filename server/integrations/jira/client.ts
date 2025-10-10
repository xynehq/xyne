/**
 * Jira API Client
 * Handles authentication and API requests to Jira Cloud
 */

import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios'
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

export class JiraClient {
  private client: AxiosInstance
  private webhookClient: AxiosInstance
  private credentials: JiraCredentials

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
      throw new Error(`Jira connection failed: ${formatJiraError(error)}`)
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
      throw new Error(`Failed to get projects: ${formatJiraError(error)}`)
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
      throw new Error(`Failed to get project: ${formatJiraError(error)}`)
    }
  }

  // ==================== ISSUE TYPE METHODS ====================

  /**
   * Get issue types for a project
   */
  async getIssueTypes(projectKey: string): Promise<JiraIssueType[]> {
    try {
      const response = await this.client.get(`/project/${projectKey}`)
      return response.data.issueTypes || []
    } catch (error) {
      throw new Error(`Failed to get issue types: ${formatJiraError(error)}`)
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
      throw new Error(`Failed to get priorities: ${formatJiraError(error)}`)
    }
  }

  // ==================== USER METHODS ====================

  /**
   * Search for users
   */
  async searchUsers(query: string): Promise<JiraUser[]> {
    try {
      const response = await this.client.get('/user/search', {
        params: { query },
      })
      return response.data
    } catch (error) {
      throw new Error(`Failed to search users: ${formatJiraError(error)}`)
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
      throw new Error(`Failed to get user: ${formatJiraError(error)}`)
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
      throw new Error(`Failed to get issue: ${formatJiraError(error)}`)
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
      throw new Error(`Failed to create issue: ${formatJiraError(error)}`)
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
      throw new Error(`Failed to update issue: ${formatJiraError(error)}`)
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
      throw new Error(`Failed to transition issue: ${formatJiraError(error)}`)
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
          fields: JIRA_CONFIG.defaultFields,
        },
      })

      return {
        issues: response.data.issues,
        total: response.data.total,
      }
    } catch (error) {
      throw new Error(`Failed to search issues: ${formatJiraError(error)}`)
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
      throw new Error(`Failed to get webhooks: ${formatJiraError(error)}`)
    }
  }

  /**
   * Create a webhook
   */
  async createWebhook(webhook: Omit<JiraWebhook, 'id'>): Promise<JiraWebhook> {
    try {
      console.log('🚀 Creating webhook with payload:', JSON.stringify(webhook, null, 2))
      console.log('📍 Webhook endpoint:', this.webhookClient.defaults.baseURL)

      const response = await this.webhookClient.post('', webhook)

      console.log('✅ Webhook created successfully:', response.data)
      return response.data
    } catch (error: any) {
      console.error('❌ Webhook creation failed!')
      console.error('Error status:', error.response?.status)
      console.error('Error data:', JSON.stringify(error.response?.data, null, 2))
      console.error('Request payload:', JSON.stringify(webhook, null, 2))

      throw new Error(`Failed to create webhook: ${formatJiraError(error)}`)
    }
  }

  /**
   * Delete a webhook
   */
  async deleteWebhook(webhookId: string): Promise<void> {
    try {
      await this.webhookClient.delete(`/${webhookId}`)
    } catch (error) {
      throw new Error(`Failed to delete webhook: ${formatJiraError(error)}`)
    }
  }

  /**
   * Check if webhook exists by URL
   */
  async webhookExists(url: string, events: string[]): Promise<string | null> {
    try {
      const webhooks = await this.getWebhooks()

      for (const webhook of webhooks) {
        if (
          webhook.url === url &&
          events.every(event => webhook.events.includes(event))
        ) {
          return webhook.id || null
        }
      }

      return null
    } catch (error) {
      return null
    }
  }
}
