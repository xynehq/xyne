import { UserMetadata, UserWorkflowRole } from "@/server/shared/types"

export interface UserDetail {
  id: string
  name: string
  email: string
  role: string
}

export type Status =
  | "UPCOMING"
  | "SCHEDULED"
  | "PENDING"
  | "DONE"
  | "BLOCKED"
  | "OVERDUE"
  | "INCOMPLETE"
  | "IN_REVIEW"
  | "NOTHING"
  | "ADHOC_DONE"
  | "HIDDEN"
  | "pending"
  | "draft"

export type Content = {
  id: string
  template_scope_id: string
  display: string
  content_type: string
}

// New structure for template steps
export type TemplateStep = {
  id: string
  prevStepIds: string[]
  nextStepIds: string[]
  tool_id: string | null
}

// Tool configuration types
export type ToolConfig = {
  unit?: string
  description?: string
  url?: string
  webhook_type?: string
  message?: string
  webhook_url?: string
  [key: string]: any
}

export type ToolValue = {
  script?: string
  message?: string
  webhook_url?: string
  [key: string]: any
}

export type Tool = {
  id: string
  config: ToolConfig
  type: string
  val: number | ToolValue
}

// Legacy Step type for backward compatibility
export type Step = {
  id: string
  name?: string
  description?: string
  type?: string
  status?: string
  parentStepId?: string | null
  nextStepIds?: string[] | null
  toolIds?: string[] | null
  timeEstimate?: number
  metadata?: any | null
  config?: any | null
  createdAt?: string
  updatedAt?: string
  // Legacy fields for backward compatibility
  blocked_by_step_ids?: string[]
  blocking_step_ids?: string[]
  parent_step_id?: string
  child_step_ids?: string[]
  assignee_id?: string
  template_step_id?: string
  unblocked_at?: string
  completed_by?: string
  completed_at?: string
  contents?: Content[]
  fall_back_step_id?: string
  time_needed?: string
  position?: number
}

// Template Flow structure for workflow templates
export type TemplateFlow = {
  template_id: string
  template_steps: TemplateStep[]
  tools: Tool[]
}

// Running workflow step execution type
export type StepExecution = {
  id: string
  workflow_exe_id: string
  workflow_step_template_id: string
  name: string
  type: string
  status: string
  parent_step_id: string | null
  metadata: {
    step_order?: number
    description?: string
    user_action?: string
    tool_type?: string
    value_type?: string
    [key: string]: any
  }
  next_step_ids: string[]
  completed_at: string | null
  completed_by: string | null
  time_estimate: number
  tool_ids: string | null
  created_at: string
  updated_at: string
  prevStepIds: string[]
  nextStepIds: string[]
}

// Tool execution result type
export type ToolExecution = {
  id: string
  result: {
    output?: string
    success?: boolean
    exitCode?: number
    executedAt?: string
    delayMs?: number
    message?: string
    delaySeconds?: number
    executeAfter?: string
    [key: string]: any
  }
  tool_id: string
  step_id: string
  status: string
  created_at: string
  updated_at: string
}

// Workflow info type
export type WorkflowInfo = {
  id: string
  name: string
  status: string
  created_at: string
  completed_at: string | null
}

// Running workflow structure (for real-time polling)
export type Flow = {
  template_id: string
  step_exe: StepExecution[]
  tools_exe: ToolExecution[]
  workflow_info: WorkflowInfo
}

// Legacy Flow type for backward compatibility
export type LegacyFlow = {
  id: string
  merchant_id: string
  flow_id: string
  scenario: string
  root_step_id: string
  last_step_id: string
  product_info_id: string
  steps: Step[]
}

export interface FlowContextProps {
  flow: Flow | TemplateFlow | LegacyFlow
  setFlow: (flow: Flow | TemplateFlow | LegacyFlow) => void
  activeSubStep: Step | null
  setActiveSubStep: (step: Step | null) => void
}

export interface FlowProps {
  title?: string
  flow?: Flow | TemplateFlow | LegacyFlow
  className?: string
  user?: UserDetail
}

export interface StepGeneratorData {
  step: Step
  stepNumber: number
  isRootStep: boolean
  isLastStep: boolean
  isConnectedStep: boolean
}

export type SerialComponents = { type: "Step"; data: StepGeneratorData }

export interface ComponentListData {
  level: number
  marginLeft: number
  serialComponents: SerialComponents[]
  className: string
}

export interface FlowBFSResult {
  componentList: ComponentListData[]
  stepNumber: number
  doneCount: number
  etaSum: string
}

export type ChangeStepStatusObject = {
  id: string
  status: Status
}

export type ChangeStepStatusResponse = {
  steps: ChangeStepStatusObject[]
  latest_version: string
}

export interface WorkflowTemplate {
  id: string
  name: string
  userId: number
  SharedUserMetadata?: UserMetadata
  workspaceId: number
  description: string
  version: string
  status: string
  isPublic?: boolean
  config: {
    ai_model?: string
    max_file_size?: string
    auto_execution?: boolean
    schema_version?: string
    allowed_file_types?: string[]
    supports_file_upload?: boolean
  }
  rootWorkflowStepTemplateId: string
  createdAt: string
  updatedAt: string
  role?: UserWorkflowRole
  rootStep?: {
    id: string
    workflowTemplateId: string
    name: string
    description: string
    type: string
    timeEstimate: number
    metadata: {
      icon?: string
      step_order?: number
      schema_version?: string
      user_instructions?: string
    }
    tool?: {
      id: string
      type: string
      value: {
        fields?: Array<{
          name: string
          type: string
          required?: boolean
          default?: any
        }>
        [key: string]: any
      }
      config: any
      createdAt: string
      updatedAt: string
    }
  }
}

export interface WorkflowCardProps {
  workflow: WorkflowTemplate
  onViewClick?: (templateId: string) => void
  onViewExecution?: (executionId: string) => void
}

export interface WorkflowExecutionModalProps {
  isOpen: boolean
  onClose: () => void
  workflowName: string
  workflowDescription: string
  templateId?: string
  workflowTemplate?: WorkflowTemplate
  workflowData?: {
    name: string
    description: string
    version?: string
    config?: any
    nodes: any[]
    edges: any[]
    metadata?: any
  }
  onViewExecution?: (executionId: string) => void
}

export interface WebhookConfig {
  webhookUrl: string
  httpMethod: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
  path: string
  authentication: "none" | "basic" | "bearer" | "api_key"
  selectedCredential?: string
  responseMode: "immediately" | "wait_for_completion" | "custom"
  options?: Record<string, any>
  headers?: Record<string, string>
  queryParams?: Record<string, string>
  requestBody?: string
}

export interface LegacyWorkflowTemplate {
  id: string
  name: string
  description?: string
  version?: string
  status?: string
  config?: {
    complexity?: string
    estimatedDuration?: string
    [key: string]: any
  }
  createdAt?: string
  updatedAt?: string
  serviceConfigId?: string
  rootWorkflowStepTemplateId?: string | null
  steps: Step[]
  // Legacy fields for backward compatibility
  category?: string
  created_at?: string
  updated_at?: string
}


export interface AgentToolData {
  agentId: string
  name: string
  description?: string
  model?: string
  isExistingAgent?: boolean
  prompt?: string
  isRagOn?: boolean
  appIntegrations?: any
}

// ✅ Type for the tool object passed as prop
export interface AgentTool {
  id: string
  type: string
  val?: AgentToolData
  value?: AgentToolData
  config?: AgentToolData
}
