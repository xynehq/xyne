// JQL Training Data Enhancement Script
// Addresses the 16 low-scoring query patterns identified

export const improvedJQLExamples = [
  // Fix comment counting issues
  {
    nlq: "Find issues with more than 10 comments",
    jql: "comment > 10",
    description: "Uses direct comment count syntax, not issueProperty[]",
    category: "comment_counting"
  },
  {
    nlq: "Issues with exactly 5 comments", 
    jql: "comment = 5",
    description: "Direct comment count equals operator",
    category: "comment_counting"
  },

  // Fix attachment counting and file types
  {
    nlq: "Bugs with more than 3 attachments",
    jql: "issuetype = Bug AND attachments > 3", 
    description: "Direct attachment count syntax",
    category: "attachment_counting"
  },
  {
    nlq: "Find tickets with log.txt attachments",
    jql: "attachments ~ \"log.txt\"",
    description: "Search attachment names, not text content",
    category: "attachment_search"
  },
  {
    nlq: "Issues with PDF attachments",
    jql: "attachments ~ \"*.pdf\"",
    description: "File extension pattern matching in attachments",
    category: "attachment_search"
  },

  // Fix epic-story relationships
  {
    nlq: "Epics with no linked stories",
    jql: "issuetype = Epic AND \"Epic Link\" IS EMPTY",
    description: "Correct way to find epics without stories",
    category: "epic_relationships"
  },
  {
    nlq: "Stories under epic PROJ-123",
    jql: "\"Epic Link\" = PROJ-123",
    description: "Find stories linked to specific epic",
    category: "epic_relationships"
  },
  {
    nlq: "Epics with more than 5 stories",
    jql: "issuetype = Epic AND issueFunction in linkedIssuesOf(\"Epic Link\") > 5",
    description: "Count stories linked to epics",
    category: "epic_relationships"
  },

  // Fix reopen counting
  {
    nlq: "Bugs reopened more than twice",
    jql: "issuetype = Bug AND status WAS \"Reopened\" AND statusChangeCount(\"Reopened\") > 2",
    description: "Count specific status changes (if available)",
    category: "status_history"
  },
  {
    nlq: "Issues reopened in last month",
    jql: "status CHANGED TO \"Reopened\" DURING (-30d, now())",
    description: "Recent reopens within timeframe",
    category: "status_history"
  },

  // Fix assignment change tracking
  {
    nlq: "Issues where assignee changed multiple times",
    jql: "assignee CHANGED DURING (-7d, now()) AND assignee WAS NOT EMPTY",
    description: "Track assignee changes in timeframe",
    category: "assignment_history"
  },

  // Fix comment author searches
  {
    nlq: "Issues commented on by QA team",
    jql: "issue in watchedBy(membersOf(\"qa-team\")) OR assignee IN membersOf(\"qa-team\")",
    description: "Alternative for comment author filtering",
    category: "comment_authors"
  },
  {
    nlq: "Last comment by specific user",
    jql: "issue in commentedBy(\"username\") AND updated >= -1d",
    description: "Recent comments by user (approximation)",
    category: "comment_authors"
  },

  // Fix description field checks
  {
    nlq: "Tasks with empty description",
    jql: "issuetype = Task AND description IS EMPTY",
    description: "Correct empty field syntax",
    category: "field_validation"
  },
  {
    nlq: "Issues where description starts with Draft",
    jql: "description ~ \"^Draft\"",
    description: "Use regex start anchor for starts-with",
    category: "text_matching"
  },

  // Fix dependency relationships
  {
    nlq: "Tasks dependent on epic ABC-123",
    jql: "issue in linkedIssues(ABC-123, \"depends on\")",
    description: "Specific dependency link type",
    category: "dependencies"
  },
  {
    nlq: "Issues blocked by multiple tickets",
    jql: "issueLinkType in (\"is blocked by\") AND linkedIssueCount > 1",
    description: "Count blocking relationships",
    category: "dependencies"
  },

  // Fix subtask relationships
  {
    nlq: "Subtasks without parent (orphaned)",
    jql: "issuetype in subtaskIssueTypes() AND parent IS EMPTY",
    description: "Find orphaned subtasks (rare but possible)",
    category: "subtask_relationships"
  }
];

export const enhancedPromptTemplate = `
You are a JQL expert with ENHANCED pattern recognition. Generate JQL for: "{userQuery}"

CRITICAL FIXES FOR COMMON ERRORS:
1. Comment counting: Use "comment > N" NOT "issueProperty[commentCount] > N"
2. Attachment search: Use "attachments ~ 'filename'" NOT "text ~ 'filename'"  
3. Epic relationships: Use "Epic Link" field NOT hasSubtasks()
4. Description checks: Use "description IS EMPTY" NOT "text !~ 'description'"
5. Reopen counting: Use status history functions when available
6. Assignment changes: Use "assignee CHANGED DURING" with timeframes

Retrieved Examples (FOLLOW THESE EXACTLY):
{vespaExamples}

ENHANCED VALIDATION CHECKLIST:
✓ All fields exist in examples
✓ All operators used in examples  
✓ All functions demonstrated in examples
✓ Syntax matches examples exactly
✓ Logic matches user intent

Generate ONLY the JQL query, no explanation:
`;