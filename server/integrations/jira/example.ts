/**
 * Jira Integration Usage Examples
 * Demonstrates how to use the Jira integration in your workflows
 */

import { JiraTrigger, JiraActions } from './index'

// ==================== EXAMPLE 1: Basic Webhook Setup ====================

async function setupBasicWebhook() {
  const trigger = new JiraTrigger({
    credentials: {
      domain: 'your-company.atlassian.net',
      email: 'you@example.com',
      apiToken: process.env.JIRA_API_TOKEN!,
    },
    webhookUrl: 'https://your-app.com/api/webhooks/jira',
    events: ['jira:issue_created', 'jira:issue_updated'],
    name: 'Xyne Workflow - Issue Events',
  })

  try {
    // Register webhook with Jira
    const { webhookId, success } = await trigger.register()
    console.log('✅ Webhook registered:', webhookId)

    // Later, when workflow is deleted:
    // await trigger.unregister()
  } catch (error) {
    console.error('❌ Failed to register webhook:', error)
  }
}

// ==================== EXAMPLE 2: Filtered Webhook (Only Bugs) ====================

async function setupFilteredWebhook() {
  const trigger = new JiraTrigger({
    credentials: {
      domain: 'your-company.atlassian.net',
      email: 'you@example.com',
      apiToken: process.env.JIRA_API_TOKEN!,
    },
    webhookUrl: 'https://your-app.com/api/webhooks/jira-bugs',
    events: ['jira:issue_created'],
    filters: {
      jqlFilter: 'project = "PROJ" AND issuetype = "Bug" AND priority IN ("High", "Highest")',
    },
    name: 'Xyne - Critical Bugs',
  })

  await trigger.register()
}

// ==================== EXAMPLE 3: Process Webhook Event ====================

function handleWebhookEvent(payload: any) {
  const event = JiraTrigger.processWebhookEvent(payload)

  console.log('Event type:', event.event)
  console.log('Issue key:', event.issue?.key)
  console.log('Changed by:', event.user?.displayName)

  // Check what changed (for update events)
  if (event.changelog) {
    event.changelog.items.forEach((change: any) => {
      console.log(
        `Field "${change.field}" changed from "${change.fromString}" to "${change.toString}"`
      )
    })
  }

  return event
}

// ==================== EXAMPLE 4: Create Issue ====================

async function createBugIssue() {
  const actions = new JiraActions({
    domain: 'your-company.atlassian.net',
    email: 'you@example.com',
    apiToken: process.env.JIRA_API_TOKEN!,
  })

  try {
    const result = await actions.createIssue({
      projectKey: 'PROJ',
      summary: 'Login page returns 500 error',
      description: `
**Steps to reproduce:**
1. Navigate to /login
2. Enter valid credentials
3. Click "Sign In"

**Expected:** Successfully logged in
**Actual:** 500 Internal Server Error

**Environment:** Production
**Browser:** Chrome 120.0
      `.trim(),
      issueType: 'Bug',
      priority: 'High',
      labels: ['production', 'backend', 'urgent'],
      components: ['Authentication'],
    })

    console.log('✅ Created issue:', result.issueKey)
    console.log('URL:', result.issueUrl)
  } catch (error) {
    console.error('❌ Failed to create issue:', error)
  }
}

// ==================== EXAMPLE 5: Create Subtask ====================

async function createSubtask() {
  const actions = new JiraActions({
    domain: 'your-company.atlassian.net',
    email: 'you@example.com',
    apiToken: process.env.JIRA_API_TOKEN!,
  })

  const result = await actions.createIssue({
    projectKey: 'PROJ',
    summary: 'Fix database connection pooling',
    issueType: 'Subtask',
    parentKey: 'PROJ-123', // Parent issue
    priority: 'Medium',
    assignee: 'user-account-id-here',
  })

  console.log('Created subtask:', result.issueKey)
}

// ==================== EXAMPLE 6: Update Issue ====================

async function updateIssueStatus() {
  const actions = new JiraActions({
    domain: 'your-company.atlassian.net',
    email: 'you@example.com',
    apiToken: process.env.JIRA_API_TOKEN!,
  })

  try {
    const result = await actions.updateIssue({
      issueKey: 'PROJ-123',
      status: 'In Progress',
      assignee: 'user-account-id-here',
      labels: ['in-development'],
    })

    console.log('✅ Updated issue:', result.issueKey)
  } catch (error) {
    console.error('❌ Failed to update issue:', error)
  }
}

// ==================== EXAMPLE 7: Unassign Issue ====================

async function unassignIssue() {
  const actions = new JiraActions({
    domain: 'your-company.atlassian.net',
    email: 'you@example.com',
    apiToken: process.env.JIRA_API_TOKEN!,
  })

  await actions.updateIssue({
    issueKey: 'PROJ-123',
    assignee: null, // Unassign
  })
}

// ==================== EXAMPLE 8: Complete Workflow ====================

async function bugToProductionWorkflow() {
  const actions = new JiraActions({
    domain: 'your-company.atlassian.net',
    email: 'you@example.com',
    apiToken: process.env.JIRA_API_TOKEN!,
  })

  // Step 1: Create bug report
  const bugIssue = await actions.createIssue({
    projectKey: 'PROJ',
    summary: 'Critical bug in payment processing',
    description: 'Users cannot complete purchases',
    issueType: 'Bug',
    priority: 'Highest',
    labels: ['production', 'payment', 'critical'],
  })

  console.log('Created bug:', bugIssue.issueKey)

  // Step 2: Assign to on-call engineer
  await actions.updateIssue({
    issueKey: bugIssue.issueKey,
    assignee: 'on-call-engineer-account-id',
    status: 'In Progress',
  })

  // Step 3: After fix, update status
  await actions.updateIssue({
    issueKey: bugIssue.issueKey,
    status: 'In Review',
    summary: '[FIXED] Critical bug in payment processing',
  })

  // Step 4: Create follow-up task
  const followUpTask = await actions.createIssue({
    projectKey: 'PROJ',
    summary: 'Post-mortem: Payment processing bug',
    description: `Root cause analysis for ${bugIssue.issueKey}`,
    issueType: 'Subtask',
    priority: 'Medium',
    parentKey: bugIssue.issueKey,
  })

  console.log('Created follow-up:', followUpTask.issueKey)
}

// ==================== EXAMPLE 9: Webhook Event Handler ====================

async function webhookEventHandler(payload: any) {
  const event = JiraTrigger.processWebhookEvent(payload)
  const actions = new JiraActions({
    domain: 'your-company.atlassian.net',
    email: 'you@example.com',
    apiToken: process.env.JIRA_API_TOKEN!,
  })

  // Auto-label high priority bugs
  if (
    event.event === 'jira:issue_created' &&
    event.issue?.fields.issuetype.name === 'Bug' &&
    event.issue?.fields.priority.name === 'Highest'
  ) {
    await actions.updateIssue({
      issueKey: event.issue.key,
      labels: ['critical', 'needs-immediate-attention'],
      assignee: 'on-call-engineer-account-id',
    })

    console.log(`Auto-labeled critical bug: ${event.issue.key}`)
  }

  // Auto-create subtasks for epics
  if (
    event.event === 'jira:issue_created' &&
    event.issue?.fields.issuetype.name === 'Epic'
  ) {
    const subtasks = [
      'Design and architecture',
      'Implementation',
      'Testing',
      'Documentation',
    ]

    for (const taskName of subtasks) {
      await actions.createIssue({
        projectKey: event.issue.fields.project.key,
        summary: `${taskName}: ${event.issue.fields.summary}`,
        issueType: 'Task',
        parentKey: event.issue.key,
      })
    }

    console.log(`Created ${subtasks.length} subtasks for epic: ${event.issue.key}`)
  }

  // Notify on status change to Done
  if (event.event === 'jira:issue_updated') {
    const statusChange = event.changelog?.items.find(
      (item: any) => item.field === 'status' && item.toString === 'Done'
    )

    if (statusChange) {
      console.log(`✅ Issue ${event.issue?.key} was completed!`)
      // Send notification, update external system, etc.
    }
  }
}

// ==================== EXAMPLE 10: Batch Operations ====================

async function batchCreateIssues() {
  const actions = new JiraActions({
    domain: 'your-company.atlassian.net',
    email: 'you@example.com',
    apiToken: process.env.JIRA_API_TOKEN!,
  })

  const tasks = [
    'Setup development environment',
    'Create database schema',
    'Implement API endpoints',
    'Write unit tests',
    'Deploy to staging',
  ]

  const createdIssues = []

  for (const task of tasks) {
    const issue = await actions.createIssue({
      projectKey: 'PROJ',
      summary: task,
      issueType: 'Task',
      labels: ['sprint-1', 'setup'],
    })

    createdIssues.push(issue.issueKey)
    console.log(`Created: ${issue.issueKey}`)

    // Add small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  console.log('Created issues:', createdIssues)
}

// ==================== EXAMPLE 11: Test Connection ====================

async function testJiraConnection() {
  const actions = new JiraActions({
    domain: 'your-company.atlassian.net',
    email: 'you@example.com',
    apiToken: process.env.JIRA_API_TOKEN!,
  })

  try {
    const isConnected = await actions.testConnection()
    if (isConnected) {
      console.log('✅ Jira connection successful!')

      // Get available projects
      const projects = await actions.getProjects()
      console.log('Available projects:', projects.map((p) => p.key).join(', '))

      // Get issue types for a project
      const issueTypes = await actions.getIssueTypes('PROJ')
      console.log('Issue types:', issueTypes.map((t) => t.name).join(', '))
    }
  } catch (error) {
    console.error('❌ Jira connection failed:', error)
  }
}

// Export examples
export {
  setupBasicWebhook,
  setupFilteredWebhook,
  handleWebhookEvent,
  createBugIssue,
  createSubtask,
  updateIssueStatus,
  unassignIssue,
  bugToProductionWorkflow,
  webhookEventHandler,
  batchCreateIssues,
  testJiraConnection,
}
