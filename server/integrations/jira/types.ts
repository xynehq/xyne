/**
 * Jira Integration Types
 * Simplified Jira integration with only issue create/update actions and webhook triggers
 */

export interface JiraCredentials {
  domain: string // e.g., "your-domain.atlassian.net"
  email: string
  apiToken: string
}

export interface JiraWebhook {
  id?: string
  name: string
  url: string
  events: string[]
  filters?: {
    'issue-related-events-section'?: string
  }
  excludeBody?: boolean
}

export interface JiraIssue {
  id?: string
  key?: string
  self?: string
  fields: {
    summary: string
    description?: string | JiraDocument
    project: {
      key: string
    }
    issuetype: {
      name: string
    }
    priority?: {
      name: string
    }
    assignee?: {
      accountId?: string
      emailAddress?: string
    } | null
    reporter?: {
      accountId?: string
    }
    labels?: string[]
    components?: Array<{ name: string }>
    fixVersions?: Array<{ name: string }>
    parent?: {
      key: string
    }
    customfield_10016?: any // Story points
    duedate?: string
    [key: string]: any
  }
}

// Atlassian Document Format (ADF)
export interface JiraDocument {
  version: number
  type: 'doc'
  content: JiraDocumentNode[]
}

export interface JiraDocumentNode {
  type: string
  content?: JiraDocumentNode[]
  text?: string
  marks?: Array<{
    type: string
    attrs?: Record<string, any>
  }>
  attrs?: Record<string, any>
}

export interface JiraProject {
  id: string
  key: string
  name: string
  projectTypeKey: string
}

export interface JiraIssueType {
  id: string
  name: string
  subtask: boolean
}

export interface JiraPriority {
  id: string
  name: string
}

export interface JiraUser {
  accountId: string
  emailAddress?: string
  displayName: string
  active: boolean
}

export interface JiraWebhookEventPayload {
  timestamp: number
  webhookEvent: string
  issue_event_type_name?: string
  user?: {
    accountId: string
    displayName: string
    emailAddress?: string
  }
  issue?: JiraIssue
  changelog?: {
    id: string
    items: Array<{
      field: string
      fieldtype: string
      from: string | null
      fromString: string | null
      to: string | null
      toString: string | null
    }>
  }
}

// Action types
export type JiraAction = 'issue_create' | 'issue_update'

export interface JiraIssueCreateInput {
  projectKey: string
  summary: string
  description?: string
  issueType: string
  priority?: string
  assignee?: string
  labels?: string[]
  components?: string[]
  parentKey?: string
  customFields?: Record<string, any>
}

export interface JiraIssueUpdateInput {
  issueKey: string
  summary?: string
  description?: string
  priority?: string
  assignee?: string | null
  labels?: string[]
  components?: string[]
  status?: string
  customFields?: Record<string, any>
}

export const JIRA_WEBHOOK_EVENTS = [
  'jira:issue_created',
  'jira:issue_updated',
  'project_created',
  'project_updated',
] as const

export type JiraWebhookEvent = typeof JIRA_WEBHOOK_EVENTS[number]

// Webhook trigger configuration
export interface JiraTriggerConfig {
  credentials: JiraCredentials
  webhookUrl: string
  events: string[]
  filters?: {
    jqlFilter?: string
  }
  name?: string
}
