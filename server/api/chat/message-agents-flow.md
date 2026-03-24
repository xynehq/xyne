# MessageAgents Flow Documentation

## Overview
`MessageAgents` is the main entry point for the JAF-based (Judgment Agent Framework) agentic chat system. It handles user messages, orchestrates tool execution, manages planning/review cycles, and streams responses back to the user.

---

## Entry Point: `MessageAgents(c: Context)`

**Location:** Line ~2936 in `message-agents.ts`

**Purpose:** Main HTTP handler for agentic chat requests. Called when a user sends a message to the chat API.

### What it does:

1. **Authentication & Setup**
   - Extracts user email and workspace from JWT token
   - Parses request body (message, chatId, agentId, toolsList, selectedModelConfig)
   - Resolves which AI model to use (with fallback chain)
   - Initializes telemetry/tracing

2. **User & Workspace Loading**
   - Loads user and workspace data from database
   - Loads connector state (which integrations are synced: Gmail, Drive, Slack, etc.)

3. **Chat Initialization**
   - Creates new chat or updates existing chat
   - Persists user message to database
   - Fetches conversation history

4. **Context Setup**
   - Initializes `AgentRunContext` (central state object)
   - Loads episodic memories (past similar conversations)
   - Loads chat memory (relevant chunks from current chat)
   - Processes attachments if user uploaded files

5. **Tool Building**
   - Builds internal tools (search, Gmail, Drive, etc.)
   - Builds MCP connector tools from provided toolsList
   - Builds custom agent tools (list/run agents) if delegation enabled
   - Filters tools based on connector availability

6. **JAF Execution**
   - Creates JAF agent configuration
   - Starts streaming response via SSE
   - Runs the main `runStream()` loop

---

## `streamSSE()` - The Streaming Response

**Code:** `return streamSSE(c, async (stream) => { ... })` (Line ~3354)

This is a Hono.js helper that enables **Server-Sent Events (SSE)** streaming. It keeps the HTTP connection open and allows the server to push events to the client in real-time.

### What it provides:
- **`stream.writeSSE({ event, data })`** - sends an SSE event to the client
- **`stream.closed`** - boolean indicating if client disconnected
- **`stream.close()`** - manually close the connection

### Inside the callback, the code:
1. Creates a stop controller for cancellation (AbortController)
2. Registers the stream in `activeStreams` map (for stop requests)
3. Sends initial metadata (`ChatTitleUpdate`, `ResponseMetadata`)
4. Sends attachment info if files were uploaded
5. Sets up MCP clients for connector tools
6. Builds JAF configuration and starts `runStream()`
7. Processes all events from the run loop via `for await...of`
8. Cleans up MCP clients and removes from active streams when done

### SSE Events Sent:
- `ChatSSEvents.ChatTitleUpdate` - new chat title
- `ChatSSEvents.AttachmentUpdate` - attachment metadata
- `ChatSSEvents.ResponseMetadata` - chatId, messageId, timeTaken
- `ChatSSEvents.Reasoning` - structured reasoning events
- `ChatSSEvents.ResponseUpdate` - answer text chunks
- `ChatSSEvents.CitationsUpdate` - citation mappings
- `ChatSSEvents.ImageCitationUpdate` - image citations
- `ChatSSEvents.Error` - error messages
- `ChatSSEvents.End` - stream completion

---

## Key Functions Called by `MessageAgents()`

### 1. `ensureChatAndPersistUserMessage()` (Line ~883)

**Purpose:** Handles chat creation and message persistence.

**What it does:**
- If no `chatId`: creates new chat with "Untitled" title
- If `chatId` exists: updates existing chat, fetches conversation history
- Inserts user message into database
- Stores attachment metadata if files were uploaded

**Calls:**
- `insertChat()` - creates new chat record
- `updateChatByExternalIdWithAuth()` - updates existing chat
- `getChatMessagesWithAuth()` - fetches previous messages
- `insertMessage()` - saves user message
- `maybeCompactAndIndex()` - compacts old chat history for memory retrieval

---

### 2. `initializeAgentContext()` (Line ~1219)

**Purpose:** Creates the central state object (`AgentRunContext`) that tracks everything throughout the agent run. This is the "brain" that remembers what's happening across all turns.

**Parameters:**
- `userEmail` - user's email address
- `workspaceId` - workspace external ID
- `userId` - numeric user ID
- `chatExternalId` - chat's external ID
- `messageText` - the user's message
- `attachments` - array of file attachments with fileId and isImage
- `options` - optional config (userContext, agentPrompt, modelId, stopController, etc.)

**What it returns:** `AgentRunContext` object

---

### The `AgentRunContext` Object Structure:

#### User & Chat Info
```typescript
user: {
  email,           // User's email
  workspaceId,     // Workspace external ID
  id,              // String user ID
  numericId,       // Numeric user ID
  workspaceNumericId
}
chat: {
  id,              // Numeric chat ID (undefined initially)
  externalId,      // Chat external ID
  metadata         // Arbitrary metadata (attachment phase tracking)
}
message: {
  text,            // User's message text
  attachments,     // Array of {fileId, isImage}
  timestamp        // ISO timestamp
}
```

#### Plan State
```typescript
plan: PlanState | null  // The execution plan with goal and subtasks
currentSubTask: string | null  // ID of currently active subtask
```
The plan has subtasks with: `id`, `description`, `status` (pending/in_progress/completed/failed/blocked), `toolsRequired`, `result`, `completedAt`, `error`

#### Tool & Execution Tracking
```typescript
toolCallHistory: ToolExecutionRecord[]  // Every tool call made
enabledTools: Set<string>               // Tools available this turn
usedAgents: string[]                    // Custom agents that were called
failedTools: Map<string, ToolFailureInfo>  // Tools that failed (for cooldown)
retryCount, maxRetries                  // Retry tracking
```

#### Context Fragments (Retrieved Data)
```typescript
seenDocuments: Set<string>              // Vespa doc IDs already fetched
allFragments: MinimalAgentFragment[]    // All retrieved fragments
turnFragments: Map<number, Fragment[]>  // Fragments grouped by turn number
currentTurnArtifacts: {
  fragments[],                           // Fragments from this turn
  unrankedFragmentsByTool,              // Deferred ranking storage
  expectations[],                        // Tool expectations this turn
  toolOutputs[],                         // Tool results this turn
  images[],                              // Image references this turn
  executionToolsCalled,                  // Count of tools called
  todoWriteCalled                        // Whether plan was updated
}
```

#### Image Tracking
```typescript
allImages: FragmentImageReference[]      // All images from attachments/tools
imagesByTurn: Map<number, ImageRef[]>    // Images grouped by turn
recentImages: FragmentImageReference[]   // Last 2 turns of images (for context)
```

#### Review State
```typescript
review: {
  lastReviewTurn: number | null          // When last review happened
  reviewFrequency: number                // Turns between reviews (default 5)
  lastReviewedFragmentIndex: number      // Where we left off
  lastReviewResult: ReviewResult | null  // Last review output
  outstandingAnomalies: string[]         // Issues found by reviewer
  clarificationQuestions: string[]       // Questions for user
  lockedByFinalSynthesis: boolean        // Review locked when synthesis starts
  lockedAtTurn: number | null
  pendingReview: Promise<void> | undefined  // In-flight review
}
ambiguityResolved: boolean               // Whether user clarifications done
clarifications: Array<{question, answer}> // Q&A with user
```

#### Final Synthesis State
```typescript
finalSynthesis: {
  requested: boolean                     // User asked for final answer
  completed: boolean                     // Synthesis finished
  suppressAssistantStreaming: boolean    // Don't stream intermediate text
  streamedText: string                   // Accumulated answer text
  ackReceived: boolean                   // LLM acknowledged completion
}
```

#### Runtime & Control
```typescript
modelId: string | undefined              // Which AI model to use
maxOutputTokens: number | undefined      // Token limit for final answer
runtime: {
  streamAnswerText,                      // Function to stream text to user
  emitReasoning                          // Function to emit reasoning events
}
stopController: AbortController          // For cancellation
stopSignal: AbortSignal
stopRequested: boolean                   // Whether stop was requested
delegationEnabled: boolean               // Whether custom agents can be called
mcpAgents: MCPVirtualAgentRuntime[]      // Available MCP agents
```

---

### `delegationEnabled` Explained

**`delegationEnabled`** controls whether the agent can delegate tasks to other custom agents.

#### When `true` (default chat mode):
- No specific agent selected by user
- Agent can call `listCustomAgents` and `runPublicAgent` tools
- Can find and delegate to specialized agents
- Episodic memories searched globally (all user's chats)

#### When `false` (dedicated agent mode):
- User explicitly selected an agent (e.g., "Sales Agent")
- `listCustomAgents` and `runPublicAgent` tools are NOT included
- That agent runs directly without delegation
- Prevents "agentception" (agents calling agents infinitely)
- Episodic memories scoped to that agent's chats only

**Set in code:**
```typescript
const hasExplicitAgent = Boolean(resolvedAgentId && agentPromptForLLM)
agentContext.delegationEnabled = !hasExplicitAgent
```

---

### What `initializeAgentContext()` Actually Does:

1. **Creates empty state objects** for all the above
2. **Initializes `finalSynthesis`** with `requested: false, completed: false`
3. **Creates empty `currentTurnArtifacts`** to track this turn's data
4. **Sets up the context object** with all properties
5. **Logs the initialization** via `logContextMutation()`
6. **Returns the context** ready for the run

This context object is **mutable** and gets updated throughout the agent run by various functions. It gets passed to tools via JAF's `execute()` method and to hooks like `beforeToolExecutionHook()` and `afterToolExecutionHook()`.

---

### 3. `prepareInitialAttachmentContext()` (Line ~979)

**Purpose:** Processes user-uploaded files before the main agent loop starts.

**What it does:**
- Searches Vespa for file content using file IDs
- Splits content into fragments with citations
- Handles different file types (regular files, collection files, attachments)
- Processes email threads if thread IDs provided
- Extracts images from attachments separately

**Calls:**
- `searchVespaInFiles()` - searches regular files
- `searchCollectionRAG()` - searches knowledge base files
- `SearchEmailThreads()` - fetches email thread content
- `getChunkCountPerDoc()` - determines how many chunks per document

---

### 4. `buildInternalToolAdapters()` (Line ~1848)

**Purpose:** Creates all the **built-in tool implementations** that the agent can use. These are the core tools that don't require MCP connectors.

**Returns:** `Array<Tool<unknown, AgentRunContext>>` - An array of tool objects ready for JAF to use.

**What it does:**
Simply creates and returns an array of tool objects:

```typescript
return [
  createToDoWriteTool(),           // Plan management
  searchGlobalTool,                 // Global search
  lsKnowledgeBaseTool,              // List knowledge bases
  searchKnowledgeBaseTool,          // Search knowledge bases
  searchChatHistoryTool,            // Search current chat history
  ...googleTools,                   // Gmail, Drive, Calendar, Contacts
  getSlackRelatedMessagesTool,      // Slack messages
  fallbackTool,                     // When no tool matches
  createFinalSynthesisTool(),       // Generate final answer
]
```

---

### The Tools Explained:

#### Planning & Execution Tools

| Tool | Purpose | Key Function |
|------|---------|--------------|
| `toDoWrite` | Creates/updates the execution plan | `createToDoWriteTool()` |
| `synthesizeFinalAnswer` | Streams the final answer to user | `createFinalSynthesisTool()` |
| `fallbackTool` | Used when no other tool matches | `fallbackTool` |

#### Search Tools

| Tool | Purpose | Data Source |
|------|---------|-------------|
| `searchGlobal` | Search across all connected data | Vespa (files, emails, etc.) |
| `searchGmail` | Search emails | Gmail connector |
| `searchDriveFiles` | Search Google Drive files | Google Drive connector |
| `searchCalendarEvents` | Search calendar events | Google Calendar connector |
| `searchGoogleContacts` | Search contacts | Google Workspace connector |
| `searchKnowledgeBase` | Search uploaded knowledge bases | Knowledge Base connector |
| `searchChatHistory` | Search within current conversation | Chat memory (Vespa) |
| `ls` | List knowledge base collections | Knowledge Base connector |

#### Communication Tools

| Tool | Purpose | Data Source |
|------|---------|-------------|
| `getSlackRelatedMessages` | Get Slack messages by user/channel | Slack connector |
| `getSlackThreads` | Get Slack thread replies | Slack connector |
| `getSlackUserProfile` | Get Slack user info | Slack connector |

---

### Tool Structure

Each tool follows the JAF Tool interface:

```typescript
{
  schema: {
    name: string,           // Tool name (e.g., "searchGlobal")
    description: string,    // What the tool does
    parameters: ZodSchema   // Input validation schema
  },
  execute: async (args, context) => {
    // Tool implementation
    // Returns ToolResponse.success(data) or ToolResponse.error(code, message)
  }
}
```

The `context` parameter is the `AgentRunContext` - so tools can access:
- User info
- Current plan state
- Previous tool results
- etc.

---

### How Tools Get Filtered

After `buildInternalToolAdapters()` returns all tools, they go through `filterToolsByAvailability()` which:
- Removes Gmail tools if `gmailSynced = false`
- Removes Drive tools if `googleDriveSynced = false`
- Removes Calendar tools if `googleCalendarSynced = false`
- Removes Slack tools if `slackConnected = false`
- Removes tools not in agent's `allowedAgentApps` (if using dedicated agent)

---

### 5. `filterToolsByAvailability()` (Line ~1896)

**Purpose:** Removes tools that the user doesn't have connectors for.

**What it does:**
- Checks connector state (gmailSynced, googleDriveSynced, etc.)
- Removes tools requiring unavailable connectors
- Also filters by agent's allowed apps (if using a specific agent)

---

### 6. `buildCustomAgentTools()` (Line ~1756)

**Purpose:** Creates tools for delegating to custom agents.

**Returns:** Array with:
- `listCustomAgents` - lists available custom agents
- `runPublicAgent` - runs a selected custom agent

**Only included when `delegationEnabled` is true** (i.e., not using a specific dedicated agent).

---

### `buildMCPJAFTools()` Explained

**Location:** `server/api/chat/jaf-adapter.ts`

**Purpose:** Converts **MCP (Model Context Protocol) connector tools** into JAF-compatible Tool objects.

#### What It Does:

1. **Iterates through connector tools** from `FinalToolsList`
2. **Extracts metadata** (name, description, schema)
3. **Converts MCP JSON schema to Zod** for JAF compatibility
4. **Creates JAF Tool with execute function** that:
   - Calls the MCP client
   - Formats the response
   - Returns `ToolResponse.success()` with fragments
5. **Returns array of JAF Tools**

#### Input: `FinalToolsList`
```typescript
Record<connectorId, {
  tools: Array<{ toolName, toolSchema?, description? }>
  client: { callTool, close? }
  metadata?: { name?, description? }
}>
```

#### Output: `Tool<unknown, AgentRunContext>[]`

This allows external MCP tools to be used seamlessly alongside internal tools in the agent.

---

### `createFinalSynthesisTool()` Explained

**Location:** Line ~1565 in `message-agents.ts`

**Purpose:** The tool that generates and streams the **final answer** to the user. Called when the agent determines it has enough evidence to answer.

#### What It Does (Step by Step):

1. **Validate Input** - Optional `insightsUsefulForAnswering` parameter
2. **Lock Review State** - Sets `review.lockedByFinalSynthesis = true` (no more reviews)
3. **Check for Duplicate Calls** - Can't synthesize twice
4. **Get Streaming Function** - Gets `streamAnswerText` for SSE
5. **Select Images** - Chooses best images up to `maxImagesPerCall` limit
6. **Build Synthesis Request** - Creates system prompt + user message with all context
7. **Update State** - Marks synthesis as requested
8. **Emit Reasoning Event** - "Synthesizing final answer..."
9. **Stream the Answer** - Calls LLM with streaming, sends chunks to user
10. **Mark Complete** - Sets `completed = true`
11. **Return Success** - With metadata

#### Key Design Points:
- **Streaming**: Answer streamed token-by-token via SSE
- **Review Lock**: No reviews during/after synthesis  
- **Image Limits**: Respects `maxImagesPerCall` config
- **Cancellation**: Respects stop signal

#### When Is It Called?
When the agent determines it has enough evidence to answer - typically the **last tool call** in a run.

---

## Next Steps

The following sections will be documented:
- The JAF run loop (`runStream()`)
- Turn lifecycle events (turn_start, tool_requests, tool_call_end, turn_end)
- Tool execution hooks (before/after)
- Review and synthesis pipeline
- Custom agent delegation flow