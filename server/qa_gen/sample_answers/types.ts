export interface QAItem {
  User_data: {
    UserID: string
    User_name: string
  }
  Question_weights: {
    Coverage_preference: "low" | "medium" | "high"
    Vagueness: number
    Question_Complexity: "low" | "medium" | "high"
    Realness: number
    Reasoning: "fact-based" | "inferential"
    Question_format: "definitive" | "listing" | "status"
  }
  Question: string
  Answer_weights: {
    Factuality: number
    Completeness: number
    Domain_relevance: number
  }
  Answer: string
  Confidence: number
}
