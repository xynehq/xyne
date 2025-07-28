// Constants for character limits and truncation
export const SNIPPET_MAX_LENGTH = 200
export const TITLE_MAX_LENGTH = 150
export const TITLE_MAX_LENGTH_SHARED = 300
export const SNIPPET_MAX_LENGTH_SHARED = 150
export const SNIPPET_MAX_LENGTH_SOURCES = 80
export const QUERY_DISPLAY_MAX_LENGTH = 100
export const RESPONSE_MODAL_MAX_LENGTH = 2000
export const RESPONSE_SHARED_MAX_LENGTH = 2800
export const MESSAGE_MAX_LENGTH = 1000
export const MODAL_MAX_CHARACTERS = 40000
export const MODAL_HEADER_CHARACTERS = 200
export const MODAL_DIVIDER_CHARACTERS = 10
export const MAX_RESULTS_IN_MODAL = 5
export const MAX_AGENTS_IN_DROPDOWN = 10
export const MAX_RECENT_MESSAGES = 3
export const MAX_CITATIONS_IN_MODAL = 2
export const MAX_CITATIONS_IN_SHARED = 5
export const MAX_SOURCES_IN_MODAL = 20

export const FRONTEND_BASE_URL =
  process.env.FRONTEND_URL ||
  (process.env.NODE_ENV === "production"
    ? process.env.HOST || "http://localhost:3000"
    : "http://localhost:5173")

// Constants from client.ts
export const CACHE_TTL = 10 * 60 * 1000 // 10 minutes
export const MODAL_RESULTS_DISPLAY_LIMIT = 5
export const SNIPPET_TRUNCATION_LENGTH = 200

export const ACTION_IDS = {
  VIEW_SEARCH_MODAL: "view_search_modal",
  VIEW_AGENT_MODAL: "view_agent_modal",
  SHARE_RESULT_DIRECTLY: "share_result",
  SHARE_FROM_MODAL: "share_from_modal", // For sharing to the channel
  SHARE_IN_THREAD_FROM_MODAL: "share_in_thread_from_modal", // For sharing to a thread
  SHARE_AGENT_FROM_MODAL: "share_agent_from_modal", // For sharing agent responses
  SHARE_AGENT_IN_THREAD_FROM_MODAL: "share_agent_in_thread_from_modal", // For sharing agent responses to a thread

  VIEW_ALL_SOURCES: "view_all_sources", // For viewing all sources in a modal
  NEXT_SOURCE_PAGE: "next_source_page",
  PREVIOUS_SOURCE_PAGE: "previous_source_page",
}

// Constants for slack Ingestion
export const periodicSaveState = 4000 // 4 seconds

// Constants from client.ts
export const EVENT_CACHE_TTL = 30000 // 30 seconds
