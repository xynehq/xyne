import { z } from "zod"

// Enhanced feedback data structure
export const enhancedFeedbackSchema = z.object({
  type: z.enum(["like", "dislike"]),
  feedback: z.array(z.string()).min(1), // Array of feedback responses, first element is custom feedback
})

export type EnhancedFeedback = z.infer<typeof enhancedFeedbackSchema>

// Predefined feedback questions for different feedback types
export const FEEDBACK_QUESTIONS = {
  like: [
    "Summarized information was accurate and clear",
    "Citations were helpful and relevant",
    "AI notes were returned quickly",
    "Transcript was accurate",
    "Action items were helpful and assigned correctly",
  ],
  dislike: [
    "Didn't receive AI notes",
    "Summarized information was inaccurate or confusing",
    "Citations were missing or linked to irrelevant messages",
    "Took too long to receive AI notes",
    "Transcript was inaccurate",
    "Action items were missing or not assigned correctly",
  ],
} as const

// Request schema for enhanced feedback API
export const enhancedFeedbackRequestSchema = z.object({
  messageId: z.string(),
  type: z.enum(["like", "dislike"]),
  customFeedback: z.string().optional(), // User's custom written feedback
  selectedOptions: z.array(z.string()).optional(), // Selected predefined options
})

export type EnhancedFeedbackRequest = z.infer<
  typeof enhancedFeedbackRequestSchema
>

// Helper function to convert to internal format
export function createEnhancedFeedback(
  type: "like" | "dislike",
  customFeedback?: string,
  selectedOptions?: string[],
): EnhancedFeedback {
  const feedback: string[] = []

  // Add custom feedback as first element if provided
  if (customFeedback && customFeedback.trim()) {
    feedback.push(customFeedback.trim())
  }

  // Add selected predefined options
  if (selectedOptions && selectedOptions.length > 0) {
    feedback.push(...selectedOptions)
  }

  // Ensure at least one feedback item
  if (feedback.length === 0) {
    feedback.push("") // Empty string placeholder
  }

  return {
    type,
    feedback,
  }
}

// Helper function to check if a message has enhanced feedback
export function hasEnhancedFeedback(
  feedbackData: any,
): feedbackData is EnhancedFeedback {
  return (
    feedbackData &&
    typeof feedbackData === "object" &&
    feedbackData.type &&
    Array.isArray(feedbackData.feedback)
  )
}

// Helper function to get feedback type from either old or new format
export function getFeedbackType(
  oldFeedback: string | null,
  newFeedback: any,
): "like" | "dislike" | null {
  if (hasEnhancedFeedback(newFeedback)) {
    return newFeedback.type
  }
  if (oldFeedback === "like" || oldFeedback === "dislike") {
    return oldFeedback
  }
  return null
}
