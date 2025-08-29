export interface UserDetail {
  id: string;
  name: string;
  email: string;
  role: string;
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

export type Content = {
  id: string
  template_scope_id: string
  display: string
  content_type: string
}

export type Step = {
  id: string
  type: string
  blocked_by_step_ids?: string[]
  blocking_step_ids?: string[]
  parent_step_id?: string
  child_step_ids?: string[]
  status: Status
  assignee_id?: string
  template_step_id?: string
  unblocked_at?: string
  completed_by?: string
  completed_at?: string
  contents: Content[]
  fall_back_step_id?: string
  time_needed?: string
  name?: string
  position?: number
}

export type Flow = {
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
  flow: Flow
  setFlow: (flow: Flow) => void
  activeSubStep: Step | null
  setActiveSubStep: (step: Step | null) => void
}

export interface FlowProps {
  title?: string;
  flow?: Flow;
  className?: string;
  user?: UserDetail;
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
  description?: string
  category?: string
  steps: Step[]
  created_at?: string
  updated_at?: string
}