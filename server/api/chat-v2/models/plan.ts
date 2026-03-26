/**
 * Execution plan for agentic mode
 */
export interface Plan {
  /** Plan goal/description */
  goal: string
  
  /** Individual subtasks */
  subTasks: SubTask[]
  
  /** When the plan was created */
  createdAt: number
  
  /** When the plan was last updated */
  updatedAt: number
}

export interface SubTask {
  /** Unique task ID */
  id: string
  
  /** Task description */
  description: string
  
  /** Current status */
  status: SubTaskStatus
  
  /** Tools required for this task */
  toolsRequired?: string[]
  
  /** Task result (if completed) */
  result?: string
  
  /** Error message (if failed) */
  error?: string
  
  /** When task was started */
  startedAt?: number
  
  /** When task was completed */
  completedAt?: number
  
  /** Dependencies on other tasks */
  dependsOn?: string[]
}

export type SubTaskStatus = 
  | "pending"
  | "in_progress" 
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
