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

export interface VespaSearchResult {
  fields: {
    docId: string
    type: "file" | "email" | "slack" | "event"
    chunks?: string[]
    text?: string
    description?: string
    title?: string
    url?: string
    timestamp?: number
    [key: string]: any
  }
  id?: string
  relevance?: number
}

export interface ProcessingResult {
  selectedDocId: string
  selectedDocBody: string
  relevantDocs: VespaSearchResult[]
  qaResults: QAItem[]
}

export interface GenerationConfig {
  vespaExportPath: string
  relevantDocsLimit: number
  qaPairsPerDoc: number
  testEmail: string
}
