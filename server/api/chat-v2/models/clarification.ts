/**
 * User clarification Q&A
 */
export interface Clarification {
  /** Unique ID */
  id: string
  
  /** Question asked by agent */
  question: string
  
  /** User's answer */
  answer: string
  
  /** When clarification was requested */
  askedAt: Date
  
  /** When clarification was answered */
  answeredAt?: Date
  
  /** Related turn */
  turn: number
}
