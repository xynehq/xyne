import { Apps } from "@xyne/vespa-ts/types"
import { getAppSyncJobsByEmail } from "@/db/syncJob"
import { db } from "@/db/client"
import config from "@/config"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"

import {
  getSlackRelatedMessagesTool,
  lsKnowledgeBaseTool,
  searchKnowledgeBaseTool,
  toDoWriteTool,
  getDocumentOutlineTool,
  getPageContentTool,
  searchGlobalTool,
  searchGmailTool,
  searchDriveFilesTool,
  searchCalendarEventsTool,
  searchGoogleContactsTool,
} from "./"

export interface ConnectionStatus {
  isDriveConnected: boolean
  isGmailConnected: boolean
  isCalendarConnected: boolean
  isGoogleContactsConnected: boolean
  isSlackConnected: boolean
}

export async function checkConnectionStatus(
  email: string,
): Promise<ConnectionStatus> {
  const [
    driveConnector,
    gmailConnector,
    calendarConnector,
    contactsConnector,
    slackConnector,
  ] = await Promise.all([
    getAppSyncJobsByEmail(db, Apps.GoogleDrive, config.CurrentAuthType, email),
    getAppSyncJobsByEmail(db, Apps.Gmail, config.CurrentAuthType, email),
    getAppSyncJobsByEmail(
      db,
      Apps.GoogleCalendar,
      config.CurrentAuthType,
      email,
    ),
    getAppSyncJobsByEmail(
      db,
      Apps.GoogleWorkspace,
      config.CurrentAuthType,
      email,
    ),
    getAppSyncJobsByEmail(db, Apps.Slack, config.CurrentAuthType, email),
  ])

  return {
    isDriveConnected: Boolean(driveConnector && driveConnector.length > 0),
    isGmailConnected: Boolean(gmailConnector && gmailConnector.length > 0),
    isCalendarConnected: Boolean(
      calendarConnector && calendarConnector.length > 0,
    ),
    isGoogleContactsConnected: Boolean(
      contactsConnector && contactsConnector.length > 0,
    ),
    isSlackConnected: Boolean(slackConnector && slackConnector.length > 0),
  }
}

export async function getAvailableTools(
  email: string,
): Promise<ToolDefinition<any, any, any>[]> {
  const connectionStatus = await checkConnectionStatus(email)

  // Base tools that are always available
  const tools: ToolDefinition<any, any, any>[] = [
    toDoWriteTool,
    lsKnowledgeBaseTool,
    searchKnowledgeBaseTool,
    getDocumentOutlineTool,
    getPageContentTool,
  ]

  // Add Google tools based on connection status
  if (connectionStatus.isGmailConnected) {
    tools.push(searchGmailTool)
  }

  if (connectionStatus.isDriveConnected) {
    tools.push(searchDriveFilesTool)
  }

  if (connectionStatus.isCalendarConnected) {
    tools.push(searchCalendarEventsTool)
  }

  if (connectionStatus.isGoogleContactsConnected) {
    tools.push(searchGoogleContactsTool)
  }

  if (connectionStatus.isSlackConnected) {
    tools.push(getSlackRelatedMessagesTool)
  }

  // Global search is available if any Google app is connected
  if (
    connectionStatus.isGmailConnected ||
    connectionStatus.isDriveConnected ||
    connectionStatus.isCalendarConnected ||
    connectionStatus.isGoogleContactsConnected ||
    connectionStatus.isSlackConnected
  ) {
    tools.push(searchGlobalTool)
  }

  return tools
}
