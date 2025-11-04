# Jira Integration for Xyne Workflow

A simplified Jira integration with **webhook triggers** and **two core actions**: `issue_create` and `issue_update`.

## Compatibility

- ✅ **Jira Cloud** - Fully supported with REST API v2
- ✅ **Jira Spaces** - Compatible (Spaces is an organizational layer above Projects; all project-level APIs continue to work)
- ❌ **Jira Server/Data Center** - Not supported (requires different API endpoints)

## Features

### ✅ Webhook Trigger Support
- **Automatic webhook registration** with Jira Cloud API
- **4 event types** supported:
  - `jira:issue_created` - When a new issue is created
  - `jira:issue_updated` - When an issue is updated
  - `project_created` - When a new project is created (works with Jira Spaces)
  - `project_updated` - When a project is updated (works with Jira Spaces)
- **JQL filtering** - Filter events using Jira Query Language (for issue events)
- **Automatic cleanup** - Webhooks are removed when workflow is deleted

### ✅ Issue Actions
1. **Create Issue** - Create new Jira issues with:
   - Project, summary, description
   - Issue type (Task, Story, Bug, Epic, Subtask)
   - Priority, assignee, labels, components
   - Support for subtasks (parent key)

2. **Update Issue** - Update existing issues with:
   - Summary, description, priority, status
   - Assignee (or unassign with null)
   - Labels, components
   - Status transitions

## Architecture

### Backend Structure
```text
xyne/server/integrations/jira/
├── types.ts          # TypeScript interfaces and types
├── config.ts         # Configuration constants
├── utils.ts          # Utility functions (ADF conversion, JQL builder, etc.)
├── client.ts         # Jira API client
├── trigger.ts        # Webhook trigger implementation
├── actions.ts        # Issue create/update actions
├── index.ts          # Main export
└── README.md         # This file
```

### Frontend Structure
```text
xyne/frontend/src/components/workflow/jira/
├── JiraTrigger.tsx       # Webhook trigger UI
├── JiraCreateIssue.tsx   # Create issue action UI
├── JiraUpdateIssue.tsx   # Update issue action UI
└── index.tsx             # Component exports
```

## Usage

### Backend: Setting up Webhook Trigger

```typescript
import { JiraTrigger } from './integrations/jira'

// Initialize trigger
const trigger = new JiraTrigger({
  credentials: {
    domain: 'your-company.atlassian.net',
    email: 'you@example.com',
    apiToken: 'your-api-token',
  },
  webhookUrl: 'https://your-app.com/api/v1/webhook/jira/<your-stable-webhook-id>',
  events: ['jira:issue_created', 'jira:issue_updated'],
  filters: {
    jqlFilter: 'project = "PROJ" AND issuetype = "Bug"',
  },
  name: 'My Workflow Trigger',
})

// Register webhook with Jira
const { webhookId, success } = await trigger.register()

// Later: Unregister webhook
await trigger.unregister()

// Process incoming webhook event
app.post('/webhook/jira', (req, res) => {
  const event = JiraTrigger.processWebhookEvent(req.body)

  console.log('Event:', event.event)
  console.log('Issue:', event.issue)
  console.log('User:', event.user)
  console.log('Changes:', event.changelog)

  res.status(200).send('OK')
})
```

### Backend: Using Actions

```typescript
import { JiraActions } from './integrations/jira'

// Initialize actions
const actions = new JiraActions({
  domain: 'your-company.atlassian.net',
  email: 'you@example.com',
  apiToken: 'your-api-token',
})

// Create an issue
const createResult = await actions.createIssue({
  projectKey: 'PROJ',
  summary: 'New bug found in production',
  description: 'Users are experiencing login issues.',
  issueType: 'Bug',
  priority: 'High',
  labels: ['production', 'urgent'],
})

console.log('Created issue:', createResult.issueKey)

// Update an issue
const updateResult = await actions.updateIssue({
  issueKey: 'PROJ-123',
  summary: 'Updated summary',
  status: 'In Progress',
  assignee: 'user-account-id',
})

console.log('Updated issue:', updateResult.issueKey)
```

### Frontend: Using Components

```tsx
import { JiraTrigger, JiraCreateIssue, JiraUpdateIssue } from './components/workflow/jira'

// Trigger component
<JiraTrigger
  onSave={(config) => {
    console.log('Trigger config:', config)
    // Save to backend
  }}
  initialConfig={{
    domain: 'company.atlassian.net',
    events: ['jira:issue_created'],
  }}
/>

// Create issue component
<JiraCreateIssue
  onSave={(config) => {
    console.log('Create config:', config)
    // Save to backend
  }}
/>

// Update issue component
<JiraUpdateIssue
  onSave={(config) => {
    console.log('Update config:', config)
    // Save to backend
  }}
/>
```

## API Reference

### JiraClient

Main client for interacting with Jira API.

```typescript
class JiraClient {
  constructor(credentials: JiraCredentials)

  // Connection
  async testConnection(): Promise<boolean>

  // Projects
  async getProjects(): Promise<JiraProject[]>
  async getProject(projectKey: string): Promise<JiraProject>

  // Issue Types
  async getIssueTypes(projectKey: string): Promise<JiraIssueType[]>

  // Priorities
  async getPriorities(): Promise<JiraPriority[]>

  // Users
  async searchUsers(query: string): Promise<JiraUser[]>
  async getUser(accountId: string): Promise<JiraUser>

  // Issues
  async getIssue(issueKey: string): Promise<JiraIssue>
  async createIssue(input: JiraIssueCreateInput): Promise<JiraIssue>
  async updateIssue(input: JiraIssueUpdateInput): Promise<JiraIssue>
  async searchIssues(jql: string, options?): Promise<{ issues, total }>

  // Webhooks
  async getWebhooks(): Promise<JiraWebhook[]>
  async createWebhook(webhook: Omit<JiraWebhook, 'id'>): Promise<JiraWebhook>
  async deleteWebhook(webhookId: string): Promise<void>
  async webhookExists(url: string, events: string[]): Promise<string | null>
}
```

### Utility Functions

```typescript
// Convert plain text to Atlassian Document Format (ADF)
textToADF(text: string): JiraDocument

// Convert ADF to plain text
adfToText(doc: JiraDocument): string

// Validate Jira domain
validateJiraDomain(domain: string): boolean

// Build JQL query from filters
buildJQLQuery(filters: {
  projectKeys?: string[]
  issueTypes?: string[]
  statuses?: string[]
  assignee?: string
  reporter?: string
  customJQL?: string
}): string

// Parse issue key (e.g., "PROJ-123")
parseIssueKey(issueKey: string): { projectKey, issueNumber } | null

// Format error messages
formatJiraError(error: any): string

// Sanitize webhook name
sanitizeWebhookName(name: string): string
```

## Authentication

This integration uses **Jira Cloud REST API v2** with **Basic Authentication**.

### Getting API Token

1. Go to [Atlassian API Tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click "Create API token"
3. Give it a label (e.g., "Xyne Workflow")
4. Copy the token (you won't be able to see it again!)

### Required Permissions

Your Jira user needs:
- **Browse Projects** - View projects and issues
- **Create Issues** - Create new issues
- **Edit Issues** - Update existing issues
- **Administer Jira** - Register webhooks (or use project admin)

## Webhook Security

### Option 1: HTTP Query Auth (Recommended)

Add query parameters to webhook URL for authentication:

```typescript
const trigger = new JiraTrigger({
  // ... other config
  webhookUrl: 'https://your-app.com/api/v1/webhook/jira/<your-stable-webhook-id>?auth=your-secret-token',
})
```

Then validate in your endpoint:

```typescript
app.post('/webhook/jira', (req, res) => {
  if (req.query.auth !== 'your-secret-token') {
    return res.status(403).send('Unauthorized')
  }

  // Process event
})
```

### Option 2: IP Allowlist

Jira Cloud webhooks come from specific IP ranges. See [Atlassian's documentation](https://support.atlassian.com/organization-administration/docs/ip-addresses-and-domains-for-atlassian-cloud-products/).

## Limitations

- **Cloud only** - This integration currently supports Jira Cloud (not Server/Data Center)
- **Rate limits** - Jira Cloud has rate limits (100 requests/second)
- **Webhook delivery** - Jira will retry failed webhooks for 24 hours
- **ADF format** - Descriptions use Atlassian Document Format (converted from plain text)

## Differences from n8n

Unlike n8n's Jira node which has **39+ triggers**, this integration is intentionally simplified:

| Feature | n8n | Xyne |
|---------|-----|------|
| Triggers | 39+ events | 6 core events |
| Actions | 20+ operations | 2 operations (create, update) |
| Complexity | High | Low |
| Use Case | General purpose | Workflow automation |

## Examples

### Example 1: Auto-assign bugs to on-call engineer

```typescript
// Trigger: When bug is created
events: ['jira:issue_created']
jqlFilter: 'issuetype = "Bug" AND priority IN ("Highest", "High")'

// Action: Update issue
await actions.updateIssue({
  issueKey: event.issue.key,
  assignee: 'on-call-engineer-account-id',
  labels: ['on-call'],
})
```

### Example 2: Create follow-up task when issue is closed

```typescript
// Trigger: When issue transitions to Done
events: ['jira:issue_updated']

// Check if status changed to Done
if (event.changelog?.items.some(item =>
  item.field === 'status' && item.toString === 'Done'
)) {
  // Action: Create follow-up task
  await actions.createIssue({
    projectKey: event.issue.fields.project.key,
    summary: `Follow-up: ${event.issue.fields.summary}`,
    issueType: 'Task',
    parentKey: event.issue.key,
  })
}
```

### Example 3: Sync issues to external system

```typescript
// Trigger: When any issue is created or updated
events: ['jira:issue_created', 'jira:issue_updated']

// Process and sync
const syncData = {
  key: event.issue.key,
  summary: event.issue.fields.summary,
  status: event.issue.fields.status.name,
  assignee: event.issue.fields.assignee?.displayName,
}

await externalSystem.sync(syncData)
```

## Troubleshooting

### Webhook not receiving events

1. Check webhook is registered: `GET https://your-domain.atlassian.net/rest/webhooks/1.0/webhook`
2. Verify webhook URL is publicly accessible
3. Check JQL filter isn't too restrictive
4. Look at Jira webhook logs (Admin > System > Webhooks)

### Authentication errors

1. Verify API token is valid
2. Check email matches the token owner
3. Ensure domain format: `company.atlassian.net` (no https://)

### Issue creation fails

1. Verify project key exists
2. Check issue type is available in project
3. Ensure required custom fields are provided
4. Test with minimal fields first

## Further Reading

- [Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
- [Jira Webhooks](https://developer.atlassian.com/cloud/jira/platform/webhooks/)
- [Atlassian Document Format (ADF)](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)
- [JQL (Jira Query Language)](https://support.atlassian.com/jira-service-management-cloud/docs/use-advanced-search-with-jira-query-language-jql/)

## License

Part of the Xyne Workflow project.
