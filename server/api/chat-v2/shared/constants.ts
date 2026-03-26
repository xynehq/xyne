/**
 * Constants for chat-v2
 */

export const DEFAULT_REVIEW_FREQUENCY = 5
export const MIN_REVIEW_FREQUENCY = 1
export const MAX_REVIEW_FREQUENCY = 50
export const DEFAULT_MAX_RETRIES = 3
export const DEFAULT_WORKING_MEMORY_MESSAGES = 6
export const RECENT_IMAGE_WINDOW = 2
export const MAX_FILES_PER_REQUEST = 12
export const MAX_CITATIONS_PER_SENTENCE = 2

export const CHAT_V2_FEATURE_FLAG = "CHAT_V2_ENABLED"

export enum ChatSSEvents {
  Start = "START",
  ResponseMetadata = "RESPONSE_METADATA",
  Reasoning = "REASONING",
  ResponseUpdate = "RESPONSE_UPDATE",
  CitationsUpdate = "CITATIONS_UPDATE",
  ImageCitationUpdate = "IMAGE_CITATION_UPDATE",
  ToolCall = "TOOL_CALL",
  ToolResult = "TOOL_RESULT",
  Error = "ERROR",
  End = "END",
  AttachmentUpdate = "ATTACHMENT_UPDATE",
  ChatTitleUpdate = "CHAT_TITLE_UPDATE",
}
