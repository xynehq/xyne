import { SystemEntity, XyneTools } from "../shared-types"
import config from "../config"
import {
  Apps,
  MailEntity,
  MailAttachmentEntity,
  DriveEntity,
  CalendarEntity,
  GooglePeopleEntity,
} from "../search-types"
export interface ToolDefinition {
  name: string
  description: string
  params?: Array<{
    name: string
    type: string
    required: boolean
    description: string
  }>
}

export const slackTools: Record<string, ToolDefinition> = {
  [XyneTools.getSlackThreads]: {
    name: XyneTools.getSlackThreads,
    description:
      "Search and retrieve Slack thread messages for conversational context.",
    params: [
      {
        name: "filter_query",
        type: "string",
        required: false,
        description: "Keywords to refine the search.",
      },
      {
        name: "limit",
        type: "number",
        required: false,
        description: "Maximum number of items to retrieve.",
      },
      {
        name: "offset",
        type: "number",
        required: false,
        description: "Number of items to skip for pagination.",
      },
      {
        name: "order_direction",
        type: "string",
        required: false,
        description:
          "Sort direction ('asc' for oldest first, 'desc' for newest first).",
      },
    ],
  },
  [XyneTools.getSlackRelatedMessages]: {
    name: XyneTools.getSlackRelatedMessages,
    description: "Search and retrieve Slack messages with flexible filtering.",
    params: [
      {
        name: "channel_name",
        type: "string",
        required: true,
        description: "Name of the Slack channel.",
      },
      {
        name: "filter_query",
        type: "string",
        required: false,
        description: "Keywords to refine the search.",
      },
      {
        name: "user_email",
        type: "string",
        required: false,
        description: "Email address of the user whose messages to retrieve.",
      },
      {
        name: "limit",
        type: "number",
        required: false,
        description: "Maximum number of items to retrieve.",
      },
      {
        name: "offset",
        type: "number",
        required: false,
        description: "Number of items to skip for pagination.",
      },
      {
        name: "order_direction",
        type: "string",
        required: false,
        description:
          "Sort direction ('asc' for oldest first, 'desc' for newest first).",
      },
      {
        name: "from",
        type: "string",
        required: false,
        description: `Specify the start date for the search in UTC format (${config.llmTimeFormat}).`,
      },
      {
        name: "to",
        type: "string",
        required: false,
        description: `Specify the end date for the search in UTC format (${config.llmTimeFormat}).`,
      },
    ],
  },
  [XyneTools.getUserSlackProfile]: {
    name: XyneTools.getUserSlackProfile,
    description: "Get a user's Slack profile details by their email address.",
    params: [
      {
        name: "user_email",
        type: "string",
        required: true,
        description:
          "Email address of the user whose Slack profile to retrieve.",
      },
    ],
  },
}

export const internalTools: Record<string, ToolDefinition> = {
  [XyneTools.GetUserInfo]: {
    name: XyneTools.GetUserInfo,
    description:
      "Retrieves basic information about the current user and their environment (name, email, company, current date/time). No parameters needed. This tool does not accept/use.",
    params: [],
  },
  [XyneTools.MetadataRetrieval]: {
    name: XyneTools.MetadataRetrieval,
    description:
      "Retrieves items based on metadata filters (time range, app, entity). Use this tool when searching within a specific app/entity with optional keyword filtering.",
    params: [
      {
        name: "from",
        type: "string",
        required: false,
        description: `Specify the start date for the search in UTC format (${config.llmTimeFormat}). Use this when the query explicitly mentions a time range or a starting point (e.g., "emails from last week").`,
      },
      {
        name: "to",
        type: "string",
        required: false,
        description: `Specify the end date for the search in UTC format (${config.llmTimeFormat}). Use this when the query explicitly mentions a time range or an ending point (e.g., "emails until yesterday").`,
      },
      {
        name: "app",
        type: "string",
        required: true,
        description: `
            Valid app keywords that map to apps:
            - 'email', 'mail', 'emails', 'gmail' → '${Apps.Gmail}'
            - 'calendar', 'meetings', 'events', 'schedule' → '${Apps.GoogleCalendar}'  
            - 'drive', 'files', 'documents', 'folders' → '${Apps.GoogleDrive}'
            - 'contacts', 'people', 'address book' → '${Apps.GoogleWorkspace}'
          `,
      },
      {
        name: "entity",
        type: "string",
        required: false,
        description: `Specify the type of item being searched. Examples:
            Valid entity keywords that map to entities:
            - For App Gmail: 'email', 'emails', 'mail', 'message' → '${MailEntity.Email}'; 'pdf', 'attachment' → '${MailAttachmentEntity.PDF}';
            - For App Drive: 'document', 'doc' → '${DriveEntity.Docs}'; 'spreadsheet', 'sheet' → '${DriveEntity.Sheets}'; 'presentation', 'slide' → '${DriveEntity.Slides}'; 'pdf' → '${DriveEntity.PDF}'; 'folder' → '${DriveEntity.Folder}'
            - For App Calendar: 'event', 'meeting', 'appointment' → '${CalendarEntity.Event}'
            - For App Workspace: 'contact', 'person' → '${GooglePeopleEntity.Contacts}'
            `,
      },
      {
        name: "filter_query",
        type: "string",
        required: false,
        description: "Keywords to refine the search based on the user's query.",
      },
      {
        name: "limit",
        type: "number",
        required: false,
        description: "Maximum number of items to retrieve.",
      },
      {
        name: "offset",
        type: "number",
        required: false,
        description: "Number of items to skip for pagination.",
      },
      {
        name: "order_direction",
        type: "string",
        required: false,
        description:
          "Sort direction ('asc' for oldest first, 'desc' for newest first).",
      },
      {
        name: "excludedIds",
        type: "array",
        required: false,
        description: "Optional list of document IDs to exclude from results.",
      },
    ],
  },
  [XyneTools.Search]: {
    name: XyneTools.Search,
    description: "Search *content* across all sources.",
    params: [
      {
        name: "filter_query",
        type: "string",
        required: true,
        description: "Keywords to refine the search based on the user's query.",
      },
      {
        name: "limit",
        type: "number",
        required: false,
        description: "Maximum number of items to retrieve.",
      },
      {
        name: "order_direction",
        type: "string",
        required: false,
        description:
          "Sort direction ('asc' for oldest first, 'desc' for newest first).",
      },
      {
        name: "offset",
        type: "number",
        required: false,
        description: "Number of items to skip for pagination.",
      },
      {
        name: "excludedIds",
        type: "array",
        required: false,
        description: "Optional list of document IDs to exclude from results.",
      },
    ],
  },
  [XyneTools.Conversational]: {
    name: XyneTools.Conversational,
    description:
      'Determine if the user\'s query is conversational or a basic calculation. Examples include greetings like: "Hi", "Hello", "Hey", "What is the time in Japan". Select this tool with empty params. No parameters needed.',
    params: [],
  },
}

export function formatToolsSection(
  tools: Record<string, ToolDefinition>,
  sectionTitle: string,
): string {
  const toolDescriptions = Object.values(tools)
    .map((tool, index) => `    ${index + 1}. ${formatToolDescription(tool)}`)
    .join("\n")

  return `    **${sectionTitle}:**\n${toolDescriptions}`
}

export function formatToolDescription(tool: ToolDefinition): string {
  let description = `${tool.name}: ${tool.description}`

  if (tool.params && tool.params.length > 0) {
    description += `\n      Params:`
    tool.params.forEach((param) => {
      const requiredText = param.required ? "required" : "optional"
      description += `\n        - ${param.name} (${requiredText}): ${param.description}`
    })
  }

  return description
}
