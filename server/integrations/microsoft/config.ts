// Microsoft Graph API scopes for OAuth
export const scopes = [
  "https://graph.microsoft.com/.default",
  "offline_access", // Required for refresh tokens
]

export const MAX_ONEDRIVE_FILE_SIZE = 15 // In MB
export const MAX_OUTLOOK_ATTACHMENT_SIZE = 15 // In MB
export const MAX_CALENDAR_EVENTS_PER_REQUEST = 1000
export const MAX_CONTACTS_PER_REQUEST = 1000
export const MicrosoftGraphConcurrency = 8
export const OutlookConcurrency = 8
export const OneDriveConcurrency = 8

// Microsoft Graph API endpoints
export const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0"
export const GRAPH_API_BETA = "https://graph.microsoft.com/beta"

// if true will directly ingest the data without checking
// if false will check for its existence in vespa
export const skipMailExistCheck = false
