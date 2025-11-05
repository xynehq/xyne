/**
 * Jira Integration Utilities
 */

import type { JiraDocument, JiraDocumentNode } from './types'

/**
 * Convert plain text to Atlassian Document Format (ADF)
 */
export function textToADF(text: string): JiraDocument {
  const paragraphs = text.split('\n\n').filter(p => p.trim())

  const content: JiraDocumentNode[] = paragraphs.map(paragraph => ({
    type: 'paragraph',
    content: [{
      type: 'text',
      text: paragraph.trim(),
    }],
  }))

  return {
    version: 1,
    type: 'doc',
    content: content.length > 0 ? content : [{
      type: 'paragraph',
      content: [],
    }],
  }
}

/**
 * Convert ADF to plain text
 */
export function adfToText(doc: JiraDocument): string {
  const extractText = (node: JiraDocumentNode): string => {
    if (node.text) {
      return node.text
    }

    if (node.content) {
      return node.content.map(extractText).join('')
    }

    return ''
  }

  if (!doc.content) {
    return ''
  }

  return doc.content.map(node => {
    if (node.type === 'paragraph') {
      return extractText(node)
    }
    if (node.type === 'heading') {
      return extractText(node)
    }
    if (node.type === 'bulletList' || node.type === 'orderedList') {
      return node.content?.map(item => {
        if (item.type === 'listItem' && item.content) {
          return '• ' + item.content.map(extractText).join('')
        }
        return extractText(item)
      }).join('\n') || ''
    }
    return extractText(node)
  }).join('\n\n').trim()
}

/**
 * Validate Jira domain format
 */
export function validateJiraDomain(domain: string): boolean {
  // Should be in format: your-domain.atlassian.net or self-hosted domain
  const cloudPattern = /^[a-z0-9-]+\.atlassian\.net$/i
  const urlPattern = /^[a-z0-9-.]+(:[0-9]+)?$/i

  return cloudPattern.test(domain) || urlPattern.test(domain)
}

/**
 * Build JQL query from filters
 */
/**
 * Escape JQL string values to prevent injection
 * Escapes backslashes, double quotes, and newlines
 */
const esc = (v: string) =>
  `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').trim()}"`;

export function buildJQLQuery(filters: {
  projectKeys?: string[]
  issueTypes?: string[]
  statuses?: string[]
  assignee?: string
  reporter?: string
  customJQL?: string
}): string {
  const conditions: string[] = []

  if (filters.projectKeys && filters.projectKeys.length > 0) {
    const projects = filters.projectKeys.map(k => esc(k)).join(', ')
    conditions.push(`project IN (${projects})`)
  }

  if (filters.issueTypes && filters.issueTypes.length > 0) {
    const types = filters.issueTypes.map(t => esc(t)).join(', ')
    conditions.push(`issuetype IN (${types})`)
  }

  if (filters.statuses && filters.statuses.length > 0) {
    const statuses = filters.statuses.map(s => esc(s)).join(', ')
    conditions.push(`status IN (${statuses})`)
  }

  if (filters.assignee) {
    conditions.push(`assignee = ${esc(filters.assignee)}`)
  }

  if (filters.reporter) {
    conditions.push(`reporter = ${esc(filters.reporter)}`)
  }

  let jql = conditions.join(' AND ')

  if (filters.customJQL) {
    jql = jql ? `(${jql}) AND (${filters.customJQL})` : filters.customJQL
  }

  return jql
}

/**
 * Parse Jira issue key (e.g., "PROJ-123")
 */
export function parseIssueKey(issueKey: string): { projectKey: string; issueNumber: number } | null {
  const match = /^([A-Z][A-Z0-9]+)-(\d+)$/i.exec(issueKey)

  if (!match) {
    return null
  }

  return {
    projectKey: match[1].toUpperCase(),
    issueNumber: parseInt(match[2], 10),
  }
}

/**
 * Format error message from Jira API response
 */
export function formatJiraError(error: any): string {
  if (error.response?.data?.errorMessages) {
    return error.response.data.errorMessages.join('; ')
  }

  if (error.response?.data?.errors) {
    const errors = Object.entries(error.response.data.errors)
      .map(([field, message]) => `${field}: ${message}`)
      .join('; ')
    return errors
  }

  if (error.message) {
    return error.message
  }

  return 'Unknown Jira API error'
}

/**
 * Sanitize webhook name for Jira
 */
export function sanitizeWebhookName(name: string): string {
  // Remove special characters, limit length
  return name
    .replace(/[^a-zA-Z0-9-_\s]/g, '')
    .substring(0, 100)
    .trim()
}
