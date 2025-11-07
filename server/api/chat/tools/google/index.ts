import { searchGmailTool } from "./gmail"
import { searchDriveFilesTool } from "./drive"
import { searchCalendarEventsTool } from "./calendar"
import { searchGoogleContactsTool } from "./contacts"

export type { GmailSearchToolParams } from "./gmail"
export type { DriveSearchToolParams } from "./drive"
export type { CalendarSearchToolParams } from "./calendar"
export type { ContactsSearchToolParams } from "./contacts"

export default [
  searchGmailTool,
  searchDriveFilesTool,
  searchCalendarEventsTool,
  searchGoogleContactsTool,
]
