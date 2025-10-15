export interface VespaDocument {
  id: string
  relevance?: number
  source: string
  fields: {
    docId?: string
    title?: string
    fileName?: string
    name?: string
    email?: string
    app?: string
    entity?: string
    owner?: string
    ownerEmail?: string
    updatedAt?: number
    createdAt?: number
    mimeType?: string
    url?: string
    [key: string]: any
  }
}

export interface VespaResponse {
  root: {
    id: string
    relevance: number
    fields: {
      totalCount: number
    }
    coverage: {
      coverage: number
      documents: number
      full: boolean
      nodes: number
      results: number
      resultsFull: number
    }
    children: VespaDocument[]
  }
}

export interface AllDocsApiResponse {
  success: boolean
  data: VespaResponse
  count: number
  page: number
  limit: number
  totalCount: number
}

export interface DeleteDocRequest {
  schema: string
  id: string
}

export interface DeleteDocResponse {
  success: boolean
  message: string
}
