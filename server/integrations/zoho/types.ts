// Zoho Desk API Types
// Based on Zoho Desk API v1 documentation and actual API responses

// OAuth Token Response
export interface ZohoTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  scope?: string
}

// Attachment structure
export interface ZohoAttachment {
  id: string
  name: string
  size: string // Zoho returns size as string (e.g., "1079")
  creator?: {
    id: string
    firstName?: string
    lastName?: string
    photoURL?: string | null
    email?: string
  }
  creatorId?: string
  createdTime: string
  href?: string
  isPublic?: boolean
}

// Source information
export interface ZohoSource {
  extId: string | null
  appName: string | null
  appPhotoURL: string | null
  permalink: string | null
  type: string
}

// Last thread preview
export interface ZohoLastThread {
  channel: string
  isDraft: boolean
  direction: string
  isForward?: boolean
}

// Thread/Comment structure
export interface ZohoThread {
  id: string
  channel?: string
  direction?: string
  summary?: string
  content?: string
  contentType?: string
  plainText?: string
  author?: {
    id: string | null
    name: string
    email: string | null
    type?: string | null
  }
  attachments?: ZohoAttachment[]
  createdTime: string
  modifiedTime?: string
  // Note: Zoho returns these as comma-separated strings, NOT arrays
  // Format: "\"Name\"<email@domain.com>,\"Name2\"<email2@domain.com>"
  to?: string
  cc?: string
  bcc?: string
  isForward?: boolean
  isDraft?: boolean
}

// Full ticket details
export interface ZohoTicket {
  id: string
  ticketNumber: string
  layoutId: string
  email: string
  phone: string | null
  subject: string
  description?: string
  status: string
  statusType: string
  createdTime: string
  modifiedTime: string
  closedTime: string | null
  category: string | null
  subCategory: string | null
  priority: string | null
  classification?: string
  language: string
  channel: string
  dueDate: string | null
  responseDueDate: string | null
  onholdTime: string | null
  commentCount: string
  threadCount: string
  attachmentCount?: string
  sentiment: string | null

  // IDs for related entities
  accountId: string | null
  departmentId: string
  contactId: string | null
  productId: string | null
  assigneeId: string | null
  teamId: string | null

  // Entity details (populated from ID lookups)
  contact?: {
    id: string
    lastName: string
    firstName: string
    email: string
  }
  assignee?: {
    id: string
    name: string
    email: string
  }
  department?: {
    id: string
    name: string
  }
  account?: {
    id: string
    accountName: string
  }
  product?: {
    id: string
    productName: string
  }
  team?: {
    id: string
    name: string
  }

  // Additional fields
  source: ZohoSource
  lastThread?: ZohoLastThread
  relationshipType: string
  channelCode: string | null
  isSpam: boolean
  isEscalated?: boolean
  isOverDue?: boolean
  isResponseOverdue?: boolean
  resolution?: string
  webUrl?: string
  sharedDepartments?: string[]
  createdBy?: {
    id: string
    name: string
    email: string
  }
  modifiedBy?: {
    id: string
    name: string
    email: string
  }

  // Custom fields (if any)
  cf?: Record<string, any>
}

// Paginated response wrapper
export interface ZohoPaginatedResponse<T> {
  data: T[]
  count?: number
  from?: number
  limit?: number
  sortBy?: string
}

// API response for ticket list
export type ZohoTicketListResponse = ZohoPaginatedResponse<ZohoTicket>

// API response for threads
export type ZohoThreadListResponse = ZohoPaginatedResponse<ZohoThread>

// API response for comments
export type ZohoCommentListResponse = ZohoPaginatedResponse<ZohoThread>

// Error response
export interface ZohoErrorResponse {
  errorCode: string
  message: string
  details?: any
}

// API Client configuration
export interface ZohoDeskConfig {
  orgId: string
  clientId: string
  clientSecret: string
  refreshToken: string
  apiDomain?: string // defaults to desk.zoho.com
  accountsDomain?: string // defaults to accounts.zoho.com
}

// Ingestion options
export interface ZohoIngestionOptions {
  modifiedSince?: string // ISO timestamp
  limit?: number // max 100
  from?: number // pagination offset
  departmentId?: string // filter by department
}
