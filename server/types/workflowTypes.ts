export enum WorkflowStatus {
  DRAFT = "draft",
  ACTIVE = "active",
  PAUSED = "paused",
  WAITING = "waiting",
  COMPLETED = "completed",
  FAILED = "failed",
}

export enum StepType {
  MANUAL = "manual",
  AUTOMATED = "automated",
}

export enum ToolCategory {
  TRIGGER = "trigger",
  ACTION = "action",
  SYSTEM = "system",
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
  SWITCH = "switch",
  MANUAL_TRIGGER = "manual_trigger",
  SCHEDULER_TRIGGER = "scheduler_trigger",
}

export enum ToolExecutionStatus {
  PENDING = "pending",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  AWAITING_USER_INPUT = "awaiting_user_input",
}

export enum TemplateState {
  ACTIVE = "active",
  INACTIVE = "inactive",
}