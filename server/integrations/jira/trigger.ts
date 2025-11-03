/**
 * Jira Webhook Trigger
 * Handles webhook registration and event processing
 */

import type { JiraCredentials, JiraWebhookEvent as WebhookEventType, JiraTriggerConfig } from './types'
import { JiraClient } from './client'
import { sanitizeWebhookName } from './utils'

export class JiraTrigger {
  private client: JiraClient
  private config: JiraTriggerConfig
  private webhookId?: string

  constructor(config: JiraTriggerConfig) {
    this.config = config
    this.client = new JiraClient(config.credentials)
  }

  /**
   * Register the webhook with Jira
   */
  async register(): Promise<{ webhookId: string; success: boolean }> {
    try {
      // Check if webhook already exists with exact event match
      const existingWebhookId = await this.client.webhookExists(
        this.config.webhookUrl,
        this.config.events,
        { exact: true }
      )

      if (existingWebhookId) {
        this.webhookId = existingWebhookId
        return {
          webhookId: existingWebhookId,
          success: true,
        }
      }

      // Create new webhook
      const webhookName = this.config.name
        ? sanitizeWebhookName(this.config.name)
        : `xyne-webhook-${Date.now()}`

      const webhook = await this.client.createWebhook({
        name: webhookName,
        url: this.config.webhookUrl,
        events: this.config.events,
        filters: this.config.filters?.jqlFilter
          ? {
              'issue-related-events-section': this.config.filters.jqlFilter,
            }
          : {},
        excludeBody: false,
      })

      this.webhookId = webhook.id

      return {
        webhookId: webhook.id!,
        success: true,
      }
    } catch (error: any) {
      throw new Error(`Failed to register webhook: ${error.message}`)
    }
  }

  /**
   * Unregister the webhook from Jira
   */
  async unregister(): Promise<boolean> {
    try {
      if (!this.webhookId) {
        return true
      }

      await this.client.deleteWebhook(this.webhookId)
      this.webhookId = undefined

      return true
    } catch (error: any) {
      throw new Error(`Failed to unregister webhook: ${error.message}`)
    }
  }

  /**
   * Process incoming webhook event
   */
  static processWebhookEvent(payload: any): {
    event: string
    issue?: any
    project?: any
    user?: any
    changelog?: any
    timestamp: number
  } {
    const webhookEvent = payload.webhookEvent
    const timestamp = payload.timestamp || Date.now()

    // Extract issue data (for issue events)
    const issue = payload.issue
      ? {
          id: payload.issue.id,
          key: payload.issue.key,
          self: payload.issue.self,
          fields: payload.issue.fields,
        }
      : undefined

    // Extract project data (for project events: project_created, project_updated, project_deleted)
    const project = payload.project
      ? {
          id: payload.project.id,
          key: payload.project.key,
          name: payload.project.name,
          self: payload.project.self,
          projectTypeKey: payload.project.projectTypeKey,
        }
      : undefined

    // Extract user data
    const user = payload.user
      ? {
          accountId: payload.user.accountId,
          displayName: payload.user.displayName,
          emailAddress: payload.user.emailAddress,
        }
      : undefined

    // Extract changelog (for update events)
    const changelog = payload.changelog
      ? {
          id: payload.changelog.id,
          items: payload.changelog.items,
        }
      : undefined

    return {
      event: webhookEvent,
      issue,
      project,
      user,
      changelog,
      timestamp,
    }
  }

  /**
   * Validate webhook signature (optional, for security)
   * Note: Jira Cloud doesn't provide webhook signatures by default
   * You can use HTTP Query Auth instead (see n8n implementation)
   */
  static validateWebhook(
    payload: any,
    signature?: string,
    secret?: string
  ): boolean {
    // If no signature is provided, skip validation
    if (!signature || !secret) {
      return true
    }

    // Implement signature validation if needed
    // This would require configuring a shared secret with Jira

    return true
  }

  /**
   * Test the webhook connection
   */
  async test(): Promise<boolean> {
    return await this.client.testConnection()
  }
}
