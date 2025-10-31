import {
  searchCalendarEventsTool,
  searchDriveFilesTool,
  searchGmailTool,
  searchGoogleContactsTool,
} from "./google"
import { searchGlobalTool } from "./global"

const googleTools = [
  searchGmailTool,
  searchCalendarEventsTool,
  searchDriveFilesTool,
  searchGoogleContactsTool,
]

export { googleTools, searchGlobalTool }
