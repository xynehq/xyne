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

export const MAX_GD_PDF_SIZE = 20 // In MB
export const MAX_GD_SHEET_ROWS = 3000
export const MAX_GD_SHEET_TEXT_LEN = 300000
export const MAX_GD_SLIDES_TEXT_LEN = 300000
export const ServiceAccountUserConcurrency = 2
export const GoogleDocsConcurrency = 15
export const GmailConcurrency = 15
export const PDFProcessingConcurrency = 15
