export enum WorkflowStatus {
  DRAFT = "draft",
  ACTIVE = "active",
  PAUSED = "paused",
  COMPLETED = "completed",
  FAILED = "failed",
}

export enum StepType {
  MANUAL = "manual",
  AUTOMATED = "automated",
}

export enum ToolType {
  DELAY = "delay",
  SLACK = "slack",
  GMAIL = "gmail",
  AGENT = "agent",
  MERGED_NODE = "merged_node",
  FORM = "form",
  EMAIL = "email",
  AI_AGENT = "ai_agent",
  WEBHOOK = "webhook",
  HTTP_REQUEST = "http_request",
  JIRA = "jira",
}

export enum ToolExecutionStatus {
  PENDING = "pending",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
}