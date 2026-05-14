/**
 * Shared constants for pi-mono tools
 *
 * Centralizes descriptions and constants used across multiple tools
 * to ensure consistency and avoid duplication.
 */

// ============================================================================
// KNOWLEDGE BASE DESCRIPTIONS
// ============================================================================

export const KNOWLEDGE_BASE_TARGET_DESCRIPTION =
  "A discriminated knowledge-base target object for browse/search. Set `type` to one of `collection`, `folder`, `file`, or `path`, then provide only the matching ID/path fields for that variant."

export const KNOWLEDGE_BASE_OFFSET_DESCRIPTION =
  "Pagination offset. Use it after reviewing the current page to continue from the next unseen rows or fragments."

export const KNOWLEDGE_BASE_EXCLUDED_IDS_DESCRIPTION =
  "Previously seen result document `docId`s to suppress on follow-up KB searches. Prefer `fragment.source.docId` values from prior results. Do not pass collection, folder, file, path, or fragment IDs."

export const LS_KNOWLEDGE_BASE_TOOL_DESCRIPTION = [
  "Browse the caller's accessible knowledge-base namespace.",
  "Use it to discover collections, inspect folder/file layout, confirm canonical paths, answer inventory or metadata questions directly, or obtain IDs for a later `searchKnowledgeBase.filters.targets` call.",
  "It is especially useful when the user wants answers constrained by structure or metadata such as a specific folder, collection, file set, or file type like PDFs.",
  "Skip `ls` only when the exact KB scope is already known and browsing will not improve the answer.",
  "Start shallow with `depth: 1` and `metadata: false` if unsure; but you are always free to enable metadata or deepen traversal only when the task truly needs row details or more hierarchy.",
].join(" ")

export const SEARCH_KNOWLEDGE_BASE_TOOL_DESCRIPTION = [
  "Search document content inside the caller's accessible knowledge-base scope and return cited fragments.",
  "Use it directly when the task is about document contents and the relevant KB scope is already known or broad KB search is acceptable.",
  "Pair it with `ls` when you need structural scoping, canonical-path confirmation, or file preselection such as searching only .txt files from a folder.",
  "If the collection, folder, file, or path is known, pass it in `filters.targets`; file targets can come from prior `ls` output.",
  "`filters.targets` narrows search by location, while `excludedIds` should contain previously seen document/result IDs to avoid rereading the same hits.",
].join(" ")

// ============================================================================
// STANDARD DESCRIPTIONS
// ============================================================================

export const STANDARD_LIMIT_DESCRIPTION =
  "Maximum number of results to return. Keep this small for precision-first retrieval and increase only when broader coverage is necessary."

export const STANDARD_OFFSET_DESCRIPTION =
  "Pagination offset. Use it after reviewing the current page to continue from the next unseen results."

export const FOLLOW_UP_EXCLUDED_IDS_DESCRIPTION =
  "Previously seen result document `docId`s to suppress on follow-up searches. Prefer prior `fragment.source.docId` values. Do not pass collection, folder, file, path, or fragment IDs."

// ============================================================================
// RETRIEVAL QUERY DESCRIPTIONS
// ============================================================================

export const GMAIL_RETRIEVAL_QUERY_DESCRIPTION = `
Create SHORT, targeted search terms optimized for retrieval systems. Focus on 1-3 key terms rather than long descriptive phrases.

Step 1: Identify the MOST IMPORTANT specific keywords:
- Person names (e.g., "John", "Sarah")
- Business/project names (e.g., "uber", "zomato") 
- Core topics (e.g., "contract", "invoice", "proposal")
- Company names (e.g., "OpenAI", "Google")
- Product names or key identifiers

Step 2: EXCLUDE these generic terms:
- Action words: "find", "show", "get", "search", "give", "recent", "latest"
- Pronouns: "my", "your", "their"
- Time references: "recent", "latest", "last week", "old", "new"
- Quantity words: "5", "10", "most", "all", "some"
- Generic types: "emails", "files", "documents", "meetings" (when used alone)
- Filler words: "summary", "details", "info", "information", "about", "regarding"

Step 3: Create CONCISE query (1-3 key terms max):

Examples:
- "reimbursement procedure application process policy guidelines" → "reimbursement policy"
- "meeting notes from last week about project updates" → "project updates"
- "emails from John about the marketing campaign" → "John marketing"

Step 4: Apply the rule:
- IF specific content keywords found → create SHORT semantic query (1-3 terms)
- IF no specific content keywords found → set query to null
`

export const DRIVE_RETRIEVAL_QUERY_DESCRIPTION = `
Create SHORT, targeted search terms optimized for retrieval systems. Focus on 1-3 key terms rather than long descriptive phrases.

Step 1: Identify the MOST IMPORTANT specific keywords:
- Person names (e.g., "John", "Sarah")
- Business/project names (e.g., "uber", "zomato") 
- Core topics (e.g., "contract", "invoice", "proposal")
- Company names (e.g., "OpenAI", "Google")
- Product names or key identifiers

Step 2: EXCLUDE these generic terms:
- Action words: "find", "show", "get", "search", "give", "recent", "latest"
- Pronouns: "my", "your", "their"
- Time references: "recent", "latest", "last week", "old", "new"
- Quantity words: "5", "10", "most", "all", "some"
- Generic types: "emails", "files", "documents", "meetings" (when used alone)
- Filler words: "summary", "details", "info", "information", "about", "regarding"

Step 3: Create CONCISE query (1-3 key terms max):
- File queries: Use topic + context (e.g., 'budget report', 'contract legal', 'project alpha')

Examples:
- "reimbursement procedure application process policy guidelines" → "reimbursement policy"
- "meeting notes from last week about project updates" → "project updates"
- "emails from John about the marketing campaign" → "John marketing"

Step 4: Apply the rule:
- IF specific content keywords found → create SHORT semantic query (1-3 terms)
- IF no specific content keywords found → set query to null
`

export const CALENDAR_RETRIEVAL_QUERY_DESCRIPTION = `
Create SHORT, targeted search terms optimized for retrieval systems. Focus on 1-3 key terms rather than long descriptive phrases.

Step 1: Identify the MOST IMPORTANT specific keywords:
- Person names (e.g., "John", "Sarah")
- Business/project names (e.g., "uber", "zomato") 
- Core topics (e.g., "contract", "invoice", "proposal")
- Company names (e.g., "OpenAI", "Google")
- Product names or key identifiers

Step 2: EXCLUDE these generic terms:
- Action words: "find", "show", "get", "search", "give", "recent", "latest"
- Pronouns: "my", "your", "their"
- Time references: "recent", "latest", "last week", "old", "new"
- Quantity words: "5", "10", "most", "all", "some"
- Generic types: "emails", "files", "documents", "meetings" (when used alone)
- Filler words: "summary", "details", "info", "information", "about", "regarding"

Step 3: Create CONCISE query (1-3 key terms max):
- Meeting queries: Use meeting topic + type (e.g., 'standup engineering', 'client demo', 'budget review')

Examples:
- "reimbursement procedure application process policy guidelines" → "reimbursement policy"
- "meeting notes from last week about project updates" → "project updates"
- "emails from John about the marketing campaign" → "John marketing"

Step 4: Apply the rule:
- IF specific content keywords found → create SHORT semantic query (1-3 terms)
- IF no specific content keywords found → set query to null
`

export const CONTACTS_RETRIEVAL_QUERY_DESCRIPTION = `
Create SHORT, targeted search terms optimized for retrieval systems. Focus on 1-3 key terms rather than long descriptive phrases.

Step 1: Identify the MOST IMPORTANT specific keywords:
- Person names (e.g., "John", "Sarah")
- Business/project names (e.g., "uber", "zomato") 
- Core topics (e.g., "contract", "invoice", "proposal")
- Company names (e.g., "OpenAI", "Google")
- Product names or key identifiers

Step 2: EXCLUDE these generic terms:
- Action words: "find", "show", "get", "search", "give", "recent", "latest"
- Pronouns: "my", "your", "their"
- Time references: "recent", "latest", "last week", "old", "new"
- Quantity words: "5", "10", "most", "all", "some"
- Generic types: "emails", "files", "documents", "meetings" (when used alone)
- Filler words: "summary", "details", "info", "information", "about", "regarding"

Step 3: Create CONCISE query (1-3 key terms max):
- Contact queries: Use person/company names, job titles (e.g., 'John Smith', 'OpenAI', 'CEO')

Examples:
- "reimbursement procedure application process policy guidelines" → "reimbursement policy"
- "meeting notes from last week about project updates" → "project updates"
- "emails from John about the marketing campaign" → "John marketing"

Step 4: Apply the rule:
- IF specific content keywords found → create SHORT semantic query (1-3 terms)
- IF no specific content keywords found → set query to null
`

export const SLACK_RETRIEVAL_QUERY_DESCRIPTION = `
Create SHORT, targeted search terms optimized for retrieval systems. Focus on 1-3 key terms rather than long descriptive phrases.

Step 1: Identify the MOST IMPORTANT specific keywords:
- Person names (e.g., "John", "Sarah")
- Business/project names (e.g., "uber", "zomato") 
- Core topics (e.g., "contract", "invoice", "proposal")
- Company names (e.g., "OpenAI", "Google")
- Product names or key identifiers

Step 2: EXCLUDE these generic terms:
- Action words: "find", "show", "get", "search", "give", "recent", "latest"
- Pronouns: "my", "your", "their"
- Time references: "recent", "latest", "last week", "old", "new"
- Quantity words: "5", "10", "most", "all", "some"
- Generic types: "emails", "files", "documents", "meetings" (when used alone)
- Filler words: "summary", "details", "info", "information", "about", "regarding"

Step 3: Create CONCISE query (1-3 key terms max):
- Slack queries: Use discussion topic + context (e.g., 'deployment issue', 'feature review', 'team sync')

Examples:
- "reimbursement procedure application process policy guidelines" → "reimbursement policy"
- "meeting notes from last week about project updates" → "project updates"
- "emails from John about the marketing campaign" → "John marketing"

Step 4: Apply the rule:
- IF specific content keywords found → create SHORT semantic query (1-3 terms)
- IF no specific content keywords found → set query to null
`

export const GLOBAL_RETRIEVAL_QUERY_DESCRIPTION = `
Create SHORT, targeted search terms optimized for retrieval systems. Focus on 1-3 key terms rather than long descriptive phrases.

Step 1: Identify the MOST IMPORTANT specific keywords:
- Person names (e.g., "John", "Sarah")
- Business/project names (e.g., "uber", "zomato") 
- Core topics (e.g., "contract", "invoice", "proposal")
- Company names (e.g., "OpenAI", "Google")
- Product names or key identifiers

Step 2: EXCLUDE these generic terms:
- Action words: "find", "show", "get", "search", "give", "recent", "latest"
- Pronouns: "my", "your", "their"
- Time references: "recent", "latest", "last week", "old", "new"
- Quantity words: "5", "10", "most", "all", "some"
- Generic types: "emails", "files", "documents", "meetings" (when used alone)
- Filler words: "summary", "details", "info", "information", "about", "regarding"

Step 3: Create CONCISE query (1-3 key terms max):
- File queries: Use topic + context (e.g., 'budget report', 'contract legal', 'project alpha')
- Meeting queries: Use meeting topic + type (e.g., 'standup engineering', 'client demo', 'budget review')
- Contact queries: Use person/company names, job titles (e.g., 'John Smith', 'OpenAI', 'CEO')
- Slack queries: Use discussion topic + context (e.g., 'deployment issue', 'feature review', 'team sync')

Examples:
- "reimbursement procedure application process policy guidelines" → "reimbursement policy"
- "meeting notes from last week about project updates" → "project updates"
- "emails from John about the marketing campaign" → "John marketing"

Step 4: Apply the rule:
- Global search: query is MANDATORY. Use 1-3 most important terms from available keywords to search across all apps.
`

// ============================================================================
// PARTICIPANT DESCRIPTIONS
// ============================================================================

export const PARTICIPANTS_SCHEMA_DESCRIPTION =
  "Structured Gmail participant filter object with optional `from`, `to`, `cc`, and `bcc` string arrays."

export const PARTICIPANT_FROM_DESCRIPTION =
  "Sender identifier string. Email is preferred; full name or organization name can also work."

export const PARTICIPANT_TO_DESCRIPTION =
  "Primary recipient identifier string. Email is preferred; full name or organization name can also work."

export const PARTICIPANT_CC_DESCRIPTION =
  "CC recipient identifier string. Email is preferred; full name or organization name can also work."

export const PARTICIPANT_BCC_DESCRIPTION =
  "BCC recipient identifier string. Email is preferred; full name or organization name can also work."

// ============================================================================
// SORT DESCRIPTIONS
// ============================================================================

export const SORT_BY_DESCRIPTION =
  "Sort direction. Valid values are `asc` and `desc`. Use `desc` for newest-first or most-recent-first ordering when supported."

// ============================================================================
// TIME RANGE DESCRIPTIONS
// ============================================================================

export const TIME_RANGE_DESCRIPTION =
  "Optional time-range object with string fields `{ startTime, endTime }`. Use it when the query is bounded by an explicit time window."

export const TIME_RANGE_START_DESCRIPTION = "Inclusive start time as a string."

export const TIME_RANGE_END_DESCRIPTION = "Inclusive end time as a string."

// ============================================================================
// TOOL DESCRIPTIONS
// ============================================================================

export const FALLBACK_TOOL_DESCRIPTION =
  "Generate detailed reasoning about why the search failed when initial iterations are exhausted but synthesis is still not complete."

export const SEARCH_GLOBAL_TOOL_DESCRIPTION =
  "Search across all connected applications and data sources when the likely source is unclear. Prefer a more specific tool when the query already points clearly to Gmail, Drive, Slack, Calendar, Contacts, or a known knowledge-base location."

export const SEARCH_GMAIL_TOOL_DESCRIPTION =
  "Search Gmail messages by content with optional participant, label, and time filters. Omit the query when the sender/recipient/time constraints already define the request well enough."

export const SEARCH_DRIVE_FILES_TOOL_DESCRIPTION =
  "Search Google Drive files by title/content with optional owner, file-type, and time filters. Use file types when the ask is constrained to PDFs, folders, spreadsheets, or other specific Drive entities."

export const SEARCH_CALENDAR_EVENTS_TOOL_DESCRIPTION =
  "Search Google Calendar events by meeting topic with optional attendee, status, and time filters. Use attendee and time fields for scheduling or meeting-history queries instead of overloading the query text."

export const SEARCH_GOOGLE_CONTACTS_TOOL_DESCRIPTION =
  "Search Google Contacts for people or organizations by name, email, phone number, title, or company. Use this to disambiguate identity before searching other apps."

export const GET_SLACK_RELATED_MESSAGES_TOOL_DESCRIPTION =
  "Search Slack messages with flexible filters for content, channel, author, mentions, and time range. Automatically includes thread replies when thread roots are found, and defaults to recent Slack history only when no query and no Slack filter fields are supplied."
