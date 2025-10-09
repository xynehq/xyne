// for service account
export const scopes = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/presentations.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
]

export const MAX_GD_PDF_SIZE = 15 // In MB
export const MAX_GD_SHEET_SIZE = 10 // In MB
export const MAX_GD_SLIDES_TEXT_LEN = 300000
export const ServiceAccountUserConcurrency = 2
export const GoogleDocsConcurrency = 8
export const GmailConcurrency = 8
export const PDFProcessingConcurrency = 8

export const MAX_ATTACHMENT_PDF_SIZE = 15
export const MAX_ATTACHMENT_TEXT_SIZE = 10
export const MAX_ATTACHMENT_DOCX_SIZE = 15
export const MAX_ATTACHMENT_PPTX_SIZE = 15
export const MAX_ATTACHMENT_SHEET_SIZE = 10

// if true will directly ingest the data without checking
// if false will check for its existance in vespa
export const skipMailExistCheck = false
