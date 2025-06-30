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

// PDF processing limits (applies to native PDFs, Docs converted to PDF, Slides converted to PDF)
export const MAX_GD_PDF_SIZE = 15 // In MB

// Native Google Sheets processing limits (Sheets are still processed in native format)
export const MAX_GD_SHEET_ROWS = 3000
export const MAX_GD_SHEET_TEXT_LEN = 300000

// DEPRECATED: No longer used since Slides are now converted to PDF
// export const MAX_GD_SLIDES_TEXT_LEN = 300000

export const ServiceAccountUserConcurrency = 2
export const GoogleDocsConcurrency = 8
export const GmailConcurrency = 8
export const PDFProcessingConcurrency = 8

export const MAX_ATTACHMENT_PDF_SIZE = 15
export const MAX_ATTACHMENT_TEXT_SIZE = 10

// if true will directly ingest the data without checking
// if false will check for its existance in vespa
export const skipMailExistCheck = false
