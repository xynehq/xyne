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
    "Response time was quick",
    "Answer provided was accurate and to the point",
    "Citations were relevant and added value to the response",
  ],
  dislike: [
    "No response was received or an error occurred",
    "Response took too long to load",
    "Answer was entirely incorrect",
    "Citations were inaccurate and not relevant to the content",
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
