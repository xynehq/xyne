/**
 * Jira Actions
 * Implements issue_create and issue_update actions
 */

import type {
  JiraCredentials,
  JiraIssueCreateInput,
  JiraIssueUpdateInput,
  JiraIssue,
} from './types'
import { JiraClient } from './client'

export class JiraActions {
  private client: JiraClient

  constructor(credentials: JiraCredentials) {
    this.client = new JiraClient(credentials)
  }

  /**
   * Action: Create Issue
   * Creates a new Jira issue
   */
  async createIssue(input: JiraIssueCreateInput): Promise<{
    success: boolean
    issue: JiraIssue
    issueKey: string
    issueUrl: string
  }> {
    try {
      // Validate required fields
      if (!input.projectKey) {
        throw new Error('Project key is required')
      }
      if (!input.summary) {
        throw new Error('Summary is required')
      }
      if (!input.issueType) {
        throw new Error('Issue type is required')
      }

      // Create the issue
      const issue = await this.client.createIssue(input)

      // Validate that required fields are present in the response
      if (!issue.key || !issue.self) {
        throw new Error('Jira API returned incomplete issue data (missing key or self)')
      }

      return {
        success: true,
        issue,
        issueKey: issue.key,
        issueUrl: issue.self,
      }
    } catch (error: any) {
      throw new Error(`Failed to create issue: ${error.message}`)
    }
  }

  /**
   * Action: Update Issue
   * Updates an existing Jira issue
   */
  async updateIssue(input: JiraIssueUpdateInput): Promise<{
    success: boolean
    issue: JiraIssue
    issueKey: string
    issueUrl: string
  }> {
    try {
      // Validate required fields
      if (!input.issueKey) {
        throw new Error('Issue key is required')
      }

      // Check if at least one field is being updated
      const hasUpdates =
        input.summary !== undefined ||
        input.description !== undefined ||
        input.priority !== undefined ||
        input.assignee !== undefined ||
        input.labels !== undefined ||
        input.components !== undefined ||
        input.status !== undefined ||
        (input.customFields && Object.keys(input.customFields).length > 0)

      if (!hasUpdates) {
        throw new Error('At least one field must be provided to update')
      }

      // Update the issue
      const issue = await this.client.updateIssue(input)

      // Validate that required fields are present in the response
      if (!issue.key || !issue.self) {
        throw new Error('Jira API returned incomplete issue data (missing key or self)')
      }

      return {
        success: true,
        issue,
        issueKey: issue.key,
        issueUrl: issue.self,
      }
    } catch (error: any) {
      throw new Error(`Failed to update issue: ${error.message}`)
    }
  }

  /**
   * Helper: Get Projects
   * Returns list of projects for UI dropdowns
   */
  async getProjects() {
    try {
      return await this.client.getProjects()
    } catch (error: any) {
      throw new Error(`Failed to get projects: ${error.message}`)
    }
  }

  /**
   * Helper: Get Issue Types
   * Returns list of issue types for a project
   */
  async getIssueTypes(projectKey: string) {
    try {
      return await this.client.getIssueTypes(projectKey)
    } catch (error: any) {
      throw new Error(`Failed to get issue types: ${error.message}`)
    }
  }

  /**
   * Helper: Get Priorities
   * Returns list of priorities for UI dropdowns
   */
  async getPriorities() {
    try {
      return await this.client.getPriorities()
    } catch (error: any) {
      throw new Error(`Failed to get priorities: ${error.message}`)
    }
  }

  /**
   * Helper: Search Users
   * Search for users to assign to issues
   */
  async searchUsers(query: string) {
    try {
      return await this.client.searchUsers(query)
    } catch (error: any) {
      throw new Error(`Failed to search users: ${error.message}`)
    }
  }

  /**
   * Helper: Get Issue
   * Get issue details by key
   */
  async getIssue(issueKey: string) {
    try {
      return await this.client.getIssue(issueKey)
    } catch (error: any) {
      throw new Error(`Failed to get issue: ${error.message}`)
    }
  }

  /**
   * Test connection
   */
  async testConnection(): Promise<boolean> {
    return await this.client.testConnection()
  }
}
