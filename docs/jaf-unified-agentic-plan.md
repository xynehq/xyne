# JAF-Based Agentic Architecture: Unified Implementation Plan

## Executive Summary

This document provides a comprehensive, unified plan for redesigning Xyne's `MessageWithToolsApi` flow using JAF (Juspay Agent Framework) to create a sophisticated agentic system with intelligent tool orchestration, automatic review, and adaptive planning.

**Current State**: Monolithic 1.5k-line controller with basic JAF integration, no planning layer, missing telemetry, and fragile execution flow.

**Target State**: Single-agent system with toDoWrite for task-based planning, automatic turn-end review, sequential task execution, and complete telemetry. JAF's message history provides context awareness without explicit history passing.

**Key Success Metrics**:
- 95%+ queries create execution plans using toDoWrite
- 100% execution follows task-by-task sequential approach (one sub-goal at a time)
- Each task may involve multiple tool calls to achieve its sub-goal
- 100% turns get automatic review via code
- Complete tool call telemetry (latency, cost, parameters)

---

## Table of Contents

1. [Problem Analysis](#1-problem-analysis)
2. [Architecture Overview](#2-architecture-overview)
3. [Core Components & Agents](#3-core-components--agents)
4. [Context Management](#4-context-management)
5. [Tool Ecosystem](#5-tool-ecosystem)
6. [Execution Flow](#6-execution-flow)
7. [Schemas & Data Structures](#7-schemas--data-structures)
8. [Prompt Engineering Strategy](#8-prompt-engineering-strategy)
9. [Implementation Roadmap](#9-implementation-roadmap)
10. [Examples & Use Cases](#10-examples--use-cases)
11. [Testing Strategy](#11-testing-strategy)
12. [Migration & Rollout](#12-migration--rollout)

---

## 0. Current Implementation Feature Inventory

### 0.1 MessageWithToolsApi - Existing Features (Lines 745-2240)

**Entry Point & Configuration**
- ✅ JWT authentication and workspace validation
- ✅ Model configuration parsing (JSON with capabilities: reasoning, websearch, deepResearch)
- ✅ Model label to value conversion (e.g., "Claude Sonnet 4" → actual model ID)
- ✅ Deep research auto-forces Claude Sonnet 4
- ✅ Debug mode detection via `config.isDebugMode`
- ✅ Agent validation with permission checks
- ✅ Mock agent creation from form data for testing

**Context Extraction & Management**
- ✅ File ID extraction from message links (with max limit validation)
- ✅ Attachment metadata parsing (images vs non-images)
- ✅ Sheet ID expansion for spreadsheets
- ✅ Follow-up context carrying from previous user messages
- ✅ Path-based collection access with permission validation
- ✅ Document deduplication via `seenDocuments` Set
- ✅ Fragment uniqueness tracking via `gatheredFragmentskeys` Set

**Chat & Message Persistence**
- ✅ New chat creation with title "Untitled"
- ✅ Existing chat message retrieval
- ✅ User message insertion with fileIds
- ✅ Attachment metadata storage in DB
- ✅ Error message association with failed messages
- ✅ Chat trace JSON storage for debugging
- ✅ Cost and token tracking per message

**MCP Integration (Lines 1428-1546)**
- ✅ Support for 3 transport types:
  - SSE (Server-Sent Events)
  - Streamable HTTP
  - Stdio (local process)
- ✅ Custom MCP client detection via `isCustomMCP` flag
- ✅ Connector credential parsing (new format with headers object)
- ✅ Backward compatibility with old API key format
- ✅ Tool filtering by externalId
- ✅ Client lifecycle management (creation, connection, cleanup)
- ✅ Memory leak prevention via client cleanup in finally block

**JAF Run Configuration (Lines 1992-2150)**
- ✅ Single agent setup with user-selected model
- ✅ Max 10 turns per execution
- ✅ Dynamic instructions builder
- ✅ Tool composition (internal + MCP)
- ✅ Message history initialization from DB
- ✅ Run ID and Trace ID generation

**onAfterToolExecution Hook (Lines 2050-2150)**
```typescript
Critical Logic:
1. Extract contexts from tool result metadata
2. Filter contexts not already in gatheredFragmentskeys
3. Build context strings for AI evaluation
4. Call extractBestDocumentIndexes (LLM-based filtering)
5. Select best documents based on indexes
6. Add to gatheredFragments & gatheredFragmentskeys
7. Update seenDocuments to prevent re-fetching
8. Return selected document content as string
9. Fallback: add all contexts if extraction fails
```

**Reasoning Step Tracking (Lines 912-1162)**
- ✅ Structured reasoning steps with IDs and timestamps
- ✅ AI-generated summaries via `generateStepSummary`
- ✅ Fallback summaries when AI generation fails
- ✅ Step limit per iteration (MAX_STEPS_PER_ITERATION = 3)
- ✅ Iteration summary generation after each iteration
- ✅ Consolidated step summary using LLM
- ✅ Quick summaries for skipped steps (beyond limit)
- ✅ Reasoning step types: Iteration, ToolExecuting, ToolResult, LogMessage, etc.

**JAF Event Streaming (Lines 2154-2459)**
- ✅ `turn_start`: Iteration announcement
- ✅ `tool_requests`: Tool selection display
- ✅ `tool_call_start`: Tool execution start
- ✅ `tool_call_end`: Tool result with context count
- ✅ `assistant_message`: Streaming answer with citations
- ✅ `token_usage`: Track input/output tokens
- ✅ `guardrail_violation`: Safety violations
- ✅ `decode_error`: Model output parsing failures
- ✅ `handoff_denied`: Agent handoff rejections
- ✅ `turn_end`: Iteration completion
- ✅ `final_output`: Final answer delivery
- ✅ `run_end`: Execution completion or error

**Citation Management (Lines 570-730)**
- ✅ Real-time citation extraction during streaming
- ✅ Citation index validation (in-bounds check)
- ✅ Duplicate citation prevention via `yieldedCitations` Set
- ✅ Image citation handling with buffer encoding
- ✅ Citation grouping prevention ([1,2,3] → [1] [2] [3])
- ✅ Attachment entity filtering (no citations for chat attachments)
- ✅ Citation-to-source mapping
- ✅ MIME type resolution for images

**Error Handling & Recovery (Lines 2363-2459)**
- ✅ Graceful degradation on guardrail violations
- ✅ Decode error handling
- ✅ Max turns exceeded with fallback search execution
- ✅ Fallback search uses agent scratchpad from messages
- ✅ Tool log extraction from conversation history
- ✅ Error message persistence to DB
- ✅ SSE error event emission
- ✅ Stream closure on errors

**Fallback Search on MaxTurnsExceeded (Lines 2386-2445)**
```typescript
Flow:
1. Extract all messages from runState
2. Build agent scratchpad (all conversation context)
3. Extract tool log from tool execution messages
4. Execute fall_back tool with full context
5. Stream fallback response
6. Handle fallback contexts and citations
7. Persist fallback message to DB
8. Graceful error if fallback fails
```

**SSE Event Types**
- ✅ `ChatTitleUpdate`: New chat title
- ✅ `ResponseMetadata`: Chat/message IDs
- ✅ `AttachmentUpdate`: Attachment metadata
- ✅ `Reasoning`: Reasoning step updates
- ✅ `Start`: Response start signal
- ✅ `ResponseUpdate`: Incremental answer chunks
- ✅ `CitationsUpdate`: Citation batch updates
- ✅ `ImageCitationUpdate`: Individual image citations
- ✅ `Error`: Error messages
- ✅ `End`: Response completion

**Active Stream Management (Lines 1365-1370, 2543-2548)**
- ✅ Stream registration in `activeStreams` Map
- ✅ Stream key: `${chat.externalId}`
- ✅ Cleanup on completion, error, and finally blocks
- ✅ Premature closure detection via `stream.closed`
- ✅ Partial message persistence on premature closure

**Performance Tracking**
- ✅ Telemetry spans via OpenTelemetry tracer
- ✅ Cost accumulation per tool call
- ✅ Token usage tracking (input/output)
- ✅ Execution time measurement
- ✅ Tool call counting
- ✅ Fragment count tracking

**Referenced Context Flow (Lines 1754-1860)**
```typescript
When user provides fileIds or attachments:
1. Fetch documents by docIds from Vespa
2. Handle chat containers (Slack channels)
3. Search Slack channel messages if container found
4. Get thread context for Slack messages
5. Build planning context string
6. Perform synthesis to check if context is sufficient
7. Skip JAF execution if context is complete
8. Otherwise proceed with JAF tools
```

**Tool Composition (Lines 1992-2015)**
- ✅ Internal JAF tools via `buildInternalJAFTools()`
- ✅ MCP JAF tools via `buildMCPJAFTools(finalToolsList)`
- ✅ Combined tool array for agent
- ✅ Tool count telemetry

**Dynamic Instructions Builder (Lines 2016-2045)**
```typescript
Includes:
- Current date context
- Tool overview section
- Context fragments section
- Agent constraints (if provided)
- Synthesis section (if available)
- Citation format rules
- Tool usage guidelines
```

**Model Configuration Parsing (Lines 1199-1279)**
- ✅ Parse `selectedModelConfig` JSON
- ✅ Extract model, reasoning, websearch, deepResearch
- ✅ Handle both direct boolean format and capabilities object
- ✅ Handle array capabilities: ["reasoning", "websearch"]
- ✅ Handle object capabilities: { reasoning: true }
- ✅ Deep research forces Claude Sonnet 4
- ✅ Model label to value conversion
- ✅ Fallback to defaultBestModel

**Attachment Handling (Lines 1289-1342)**
- ✅ Parse attachment metadata from request
- ✅ Separate image vs non-image attachments
- ✅ Store attachment metadata in DB transaction
- ✅ Error tracking for storage failures
- ✅ SSE notification on storage errors
- ✅ Sheet ID expansion for spreadsheet files

**Agent Validation (Lines 1386-1416)**
- ✅ Agent lookup by externalId
- ✅ Permission check (workspace + user)
- ✅ RAG on/off detection (`agentForDb.isRagOn`)
- ✅ Agent prompt serialization for LLM
- ✅ Mock agent creation for testing

**Non-Streaming Mode Support**
- ✅ `collectIterator` helper for buffering streams
- ✅ Complete answer assembly before DB insert
- ✅ JSON response format
- ✅ Thinking always included in response
- ✅ Same error handling as streaming

### 0.2 Key Helper Functions

**generateStepSummary** (Lines 735-795)
- AI-generated summaries for reasoning steps
- Uses fast model (defaultFastModel)
- Fallback to generateFallbackSummary on error
- Telemetry tracking for summary generation

**generateFallbackSummary** (Lines 798-815)
- Rule-based summaries by step type
- No LLM required
- Deterministic output

**performSynthesis** (Lines 849-956)
- Context synthesis from gathered fragments
- JSON output parsing
- Three synthesis states: Complete, Partial, NotFound
- Handles synthesis errors gracefully
- Returns null on critical errors

**checkAndYieldCitationsForAgent** (Lines 570-730)
- Regex-based citation extraction
- Duplicate prevention
- Image citation handling
- Entity filtering
- Async generator pattern

**vespaResultToMinimalAgentFragment** (Lines 732-745)
- Converts Vespa results to fragments
- Includes source metadata
- Confidence scoring

### 0.3 Database Operations

**Transactions**
- ✅ Chat + first message creation (atomic)
- ✅ Message insertion with attachment metadata
- ✅ Chat trace storage
- ✅ Error message updates

**Queries**
- ✅ User and workspace lookup by email
- ✅ Agent retrieval with permission check
- ✅ Chat messages with auth
- ✅ Connector by ID
- ✅ Tools by connector ID

### 0.4 Missing Features (From Problem Statement)

**❌ Planning Layer**
- No pre-execution plan creation
- No plan serialization in prompts
- No plan state management
- No plan updates during execution

**❌ Review/Iteration**
- No automatic review after turns
- No quality assessment
- No gap detection
- No replanning logic

**❌ Tool Call Telemetry in Hook**
- onAfterToolExecution doesn't log ToolExecutionRecord
- No latency tracking in hook
- No failure count tracking
- No duplicate call prevention in hook
- ToolMetric SSE event not implemented

**❌ Tool Descriptions Registry**
- No tool-descriptions.md file
- Tool metadata constructed inline
- No reusable documentation

**❌ Explicit Tool History in Prompts**
- Not in current implementation (JAF handles via messages)
- But plan mentions adding it explicitly

**❌ Failed Tool Removal**
- No 3-strike failure tracking
- No tool blocking after repeated failures

## 1. Problem Analysis

### 1.1 Current Implementation Issues

**Monolithic Controller** (`server/api/chat/agents.ts:745-2240`)
- Single 1.5k-line function mixing auth, context gathering, MCP setup, JAF streaming, synthesis, and SSE
- Impossible to extend with review or planning hooks
- Duplicates logic present in other controllers
- Hard to reason about, test, or debug

**Missing Planning Layer**
- System prompt forces "first action must be tool call"
- No disambiguation for ambiguous requests ("What does Alex say about Q4?")
- No Chain-of-Thought or `<Plan>` section to expose planning state
- No pre-pass for `ListCustomAgents` or agent selection

**No Tool Call Telemetry**
- `onAfterToolExecution` only dedupes fragments (lines 1823-1909)
- No latency tracking, parameter logging, or failure counts
- Cannot enforce "skip duplicate calls" or "remove failing tools after 3 attempts"
- No cost/performance mapping

**Embedded Tool Descriptions**
- Tool metadata constructed inline (`buildToolsOverview`, `buildContextSection`)
- No single source of truth for tool schemas/usage
- Cannot provide LLM with reusable reference documentation

**No Review/Iteration**
- JAF events stream directly to client
- No reviewer agent to inspect outputs, reorder actions, or adjust plans
- Cannot surface plan state in prompts or SSE events

### 1.2 Design Goals

1. **Single-Agent Architecture**: One agent handles planning, execution, and adaptation via toDoWrite
2. **Automatic Review**: Deterministic review after every turn via code (not conditional)
3. **Context from Messages**: JAF passes all messages - no need for explicit tool history in prompts
4. **Telemetry-Driven**: Track every tool call with full context in hooks
5. **Task-Based Sequential Execution**: Execute one sub-goal/task at a time; each task may involve multiple tools
6. **Schema-Based**: Strict typing for reliability and auditability
7. **Graceful Degradation**: Handle failures intelligently via hooks
8. **Modular & Testable**: Replace monolith with composable functions

---

## 2. Architecture Overview

### 2.1 High-Level Flow

```
User Query
    ↓
┌─────────────────────────────────────────────────────────────┐
│ INITIALIZATION                                               │
│ - Authenticate user                                          │
│ - Resolve chat context                                       │
│ - Initialize AgentRunContext                                 │
│ - Build system prompt with tool descriptions                 │
└───────────────────────────┬─────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ CONTINUOUS EXECUTION LOOP (max 15 turns)                     │
│                                                              │
│  ┌──────────────────────────────────────────┐               │
│  │ Single Agent (user-selected model)       │               │
│  │ Available Tools:                          │               │
│  │  - toDoWrite (planning)                   │               │
│  │  - search tools (Gmail, Slack, Drive...)  │               │
│  │  - list_custom_agents                     │               │
│  │  - run_public_agent                       │               │
│  │  - clarification                          │               │
│  │                                            │               │
│  │ Context from JAF:                          │               │
│  │  - All conversation messages (automatic)   │               │
│  │  - context.plan (read from state)          │               │
│  └──────────────────┬───────────────────────┘               │
│                     ↓                                        │
│  ┌──────────────────────────────────────────┐               │
│  │ JAF Turn Execution                       │               │
│  │                                           │               │
│  │ onBeforeToolExecution:                   │               │
│  │  - Duplicate detection                   │               │
│  │  - Add excludedIds                       │               │
│  │  - Check failure budget (3 strikes)      │               │
│  │                                           │               │
│  │ Tool Execution:                          │               │
│  │  ┌────────────────────────────────────┐ │               │
│  │  │ TASK-BY-TASK SEQUENTIAL            │ │               │
│  │  │                                     │ │               │
│  │  │ Task 1: Identify User               │ │               │
│  │  │   └─ Tool: searchContacts           │ │               │
│  │  │   └─ Complete ✓                     │ │               │
│  │  │                                     │ │               │
│  │  │ Task 2: Search Communications       │ │               │
│  │  │   ├─ Tool: searchGmail              │ │               │
│  │  │   ├─ Tool: searchSlack              │ │               │
│  │  │   └─ Tool: searchDrive              │ │               │
│  │  │   └─ Complete ✓                     │ │               │
│  │  │                                     │ │               │
│  │  │ Task 3: Next sub-goal...            │ │               │
│  │  └────────────────────────────────────┘ │               │
│  │                                           │               │
│  │ onAfterToolExecution:                    │               │
│  │  - Log ToolExecutionRecord (in context)  │               │
│  │  - Extract & filter contexts             │               │
│  │  - Update metrics                        │               │
│  │  - Track failures                        │               │
│  │  - Emit SSE events                       │               │
│  └──────────────────┬───────────────────────┘               │
│                     ↓                                        │
│  ┌──────────────────────────────────────────┐               │
│  │ AUTOMATIC TURN-END REVIEW (via code)     │               │
│  │ - Called deterministically after turn     │               │
│  │ - Evaluates: quality, completeness, gaps  │               │
│  │ - Updates context.review state            │               │
│  │ - Agent sees review in next turn messages │               │
│  └──────────────────┬───────────────────────┘               │
│                     ↓                                        │
│         ┌───────────┴───────────┐                           │
│         │ Continue? Check:       │                           │
│         │ - Final answer given?  │                           │
│         │ - Max turns reached?   │                           │
│         │ - Error threshold?     │                           │
│         └───────────┬────────────┘                           │
│                     │                                        │
│            Loop if not complete                              │
└─────────────────────┼───────────────────────────────────────┘
                      ↓
              ┌───────────────┐
              │  SYNTHESIS    │
              │  - Final      │
              │    answer     │
              │  - Citations  │
              └───────────────┘
```

### 2.2 Design Principles

1. **Single-Agent with toDoWrite**: One agent uses toDoWrite for planning, no separate planning agent
2. **Message-Based Context**: JAF provides conversation history automatically - no manual tool history passing
3. **Deterministic Review**: Code automatically calls review after every turn (not conditional)
4. **Hook-Based Telemetry**: All metrics tracked in onBeforeToolExecution / onAfterToolExecution
5. **Task-Based Execution**: Execute one task/sub-goal at a time; each task can involve multiple tool calls
6. **Schema Validation**: All data structures strictly typed
7. **Fail Gracefully**: Hooks handle failures, remove failing tools after 3 attempts
8. **Observable**: Full telemetry via hooks and SSE events

---

## 3. Core Components & Agents

### 3.1 Single Main Agent (User-Selected Model)

**Model**: User-selected model (Claude Opus, GPT-4, etc.)  
**Purpose**: Plan, execute tools, adapt strategy, synthesize answers

**Available Tools**: 
- `toDoWrite` (planning - uses existing JAF TodoWrite tool)
- Search tools (Gmail, Slack, Drive, Calendar, etc.)
- `list_custom_agents` & `run_public_agent`
- Clarification tool
- All MCP-connected tools

**System Prompt Structure** (dynamically built, NO tool history):
```xml
You are Xyne, an enterprise search assistant with agentic capabilities.

<context>
User: ${userEmail}
Workspace: ${workspaceId}
Current Date: ${dateForAI}
</context>

<plan>
${context.plan ? serializePlan(context.plan) : 'No plan exists yet. Use toDoWrite to create one.'}
</plan>

<available_tools>
${loadToolDescriptionsFromRegistry(enabledTools)}
</available_tools>

<instructions>
# PLANNING
- ALWAYS start by creating a plan using toDoWrite
- Break the goal into clear, sequential tasks (one sub-goal per task)
- Each task represents one sub-goal that must be completed before moving to the next
- Within a task, identify all tools needed to achieve that sub-goal
- Update plan as you learn more

# EXECUTION STRATEGY
- Execute ONE TASK AT A TIME in sequential order
- Complete each task fully before moving to the next
- Within a single task, you may call multiple tools if they all contribute to that task's sub-goal
  Example Task: "Search for Alex's Q4 communications"
    ├─ Tool: searchGmail (all Q4 emails from Alex)
    ├─ Tool: searchSlack (all Q4 Slack messages from Alex)
    └─ Tool: searchDrive (all Q4 documents from Alex)
- Do NOT mix tools from different sub-goals in the same task

# QUALITY
- Before runPublicAgent: ensure ambiguity is resolved
- Craft specific queries for custom agents
- Always cite sources using [n] notation

# ADAPTATION
- JAF provides full conversation history automatically
- Review your previous messages to avoid duplication
- Adjust strategy based on results
- Don't retry failing tools more than 3 times
</instructions>
```

**Note**: No tool history or gathered context in prompt - JAF passes all conversation messages automatically, giving the LLM full context awareness.

### 3.2 Automatic Review (Called Deterministically)

**Purpose**: Automatic quality evaluation after every turn

**Implementation**: Code-triggered function (NOT conditional, runs after EVERY turn)

**Trigger**: Deterministically called in code after each JAF turn completes

**Input Schema**:
```typescript
interface AutoReviewInput {
  turnNumber: number;
  contextFragments: MinimalAgentFragment[];
  toolCallHistory: ToolExecutionRecord[];
  plan: PlanState | null;
}
```

**Output Schema**:
```typescript
interface ReviewAgentOutput {
  status: 'ok' | 'error';
  qualityScore: number; // 0-1
  completeness: number; // 0-1
  relevance: number; // 0-1
  needsMoreData: boolean;
  gaps: string[];
  suggestedActions: ReviewAction[];
  recommendation: 'proceed' | 'gather_more' | 'clarify_query' | 'replan';
  updatedPlan?: PlanState;
  notes: string;
}

interface ReviewAction {
  type: 'clarify' | 'reorder' | 'add_step' | 'remove_step' | 'stop';
  target?: string; // substep ID
  prompt?: string; // for clarifications
  reason: string;
}
```

**Review Criteria**:
1. **Completeness**: Did we gather enough information to answer the query?
2. **Relevance**: Is the gathered data actually relevant to the question?
3. **Quality**: Are the sources reliable and recent?
4. **Coverage**: Are there obvious gaps in the data?
5. **Efficiency**: Are we being redundant or wasteful?

**Implementation in Execution Loop**:
```typescript
// After EVERY JAF turn, automatically trigger review
async function executeJAFTurn(context: AgentRunContext): Promise<void> {
  // Run JAF turn
  const runResult = await jaf.runStream(/* ... */);
  
  // DETERMINISTIC: Always review after turn
  const reviewResult = await performAutomaticReview({
    turnNumber: context.currentTurn,
    contextFragments: context.contextFragments,
    toolCallHistory: context.toolCallHistory,
    plan: context.plan
  });
  
  // Store review in context for next turn
  context.review.lastReviewSummary = reviewResult.notes;
  context.review.lastReviewTurn = context.currentTurn;
  
  // Agent will see review in next turn's message history (automatic via JAF)
}
```

---

## 4. Context Management

### 4.1 AgentRunContext Schema

**Core State Container** for entire execution lifecycle:

```typescript
interface AgentRunContext {
  // Request metadata
  user: {
    email: string;
    workspaceId: string;
    id: string;
  };
  chat: {
    externalId: string;
    metadata: Record<string, unknown>;
  };
  message: {
    text: string;
    attachments: Attachment[];
    timestamp: string;
  };
  
  // Planning state
  plan: PlanState | null;
  currentSubTask: string | null; // Active substep ID
  
  // Clarification tracking
  clarifications: Clarification[];
  ambiguityResolved: boolean;
  
  // Execution history
  toolCallHistory: ToolExecutionRecord[];
  contextFragments: MinimalAgentFragment[];
  seenDocuments: Set<string>; // Prevent re-fetching
  
  // Performance metrics
  totalLatency: number;
  totalCost: number;
  tokenUsage: {
    input: number;
    output: number;
  };
  
  // Agent & tool tracking
  availableAgents: AgentCapability[];
  usedAgents: string[];
  enabledTools: Set<string>;
  
  // Error & retry tracking
  failedTools: Map<string, ToolFailureInfo>;
  retryCount: number;
  maxRetries: number;
  
  // Review state
  review: {
    lastReviewTurn: number | null;
    reviewFrequency: number; // Review every N turns
    lastReviewSummary: string | null;
  };
  
  // Decision log (for debugging)
  decisions: Decision[];
}

interface PlanState {
  id: string;
  goal: string;
  subTasks: SubTask[];
  chainOfThought: string;
  needsClarification: boolean;
  clarificationPrompt: string | null;
  candidateAgents: string[];
  createdAt: number;
  updatedAt: number;
}

interface SubTask {
  id: string;
  description: string; // The sub-goal this task achieves
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed';
  toolsRequired: string[]; // All tools needed to achieve this sub-goal
  result?: string;
  completedAt?: number;
  error?: string;
}

interface Clarification {
  question: string;
  answer: string;
  timestamp: number;
}

interface ToolFailureInfo {
  count: number;
  lastError: string;
  lastAttempt: number;
}

interface Decision {
  id: string;
  timestamp: number;
  type: 'tool_selection' | 'plan_modification' | 'strategy_change' | 'error_recovery';
  reasoning: string;
  outcome: 'success' | 'failure' | 'pending';
  relatedToolCalls: string[];
}
```

### 4.2 Context Lifecycle

```
Initialize → Plan Created → Clarify (if needed) → Execute Tools → Review → Update → Repeat → Finalize
```

**Initialization**:
```typescript
const context: AgentRunContext = {
  user: { email, workspaceId, id: userId },
  chat: { externalId: chatId, metadata: chatMetadata },
  message: { text: userMessage, attachments, timestamp: new Date().toISOString() },
  plan: null,
  currentSubTask: null,
  clarifications: [],
  ambiguityResolved: false,
  toolCallHistory: [],
  contextFragments: [],
  seenDocuments: new Set(),
  totalLatency: 0,
  totalCost: 0,
  tokenUsage: { input: 0, output: 0 },
  availableAgents: [],
  usedAgents: [],
  enabledTools: new Set(),
  failedTools: new Map(),
  retryCount: 0,
  maxRetries: 3,
  review: {
    lastReviewTurn: null,
    reviewFrequency: 5,
    lastReviewSummary: null
  },
  decisions: []
};
```

**Updates** occur:
- After plan creation/modification
- After clarification
- After each tool execution
- After review
- On errors

### 4.3 Simplified Prompt Construction

**Note**: JAF automatically passes all conversation messages to the LLM, providing full context. We only need to inject:
1. Current plan state (read from context.plan)
2. Tool descriptions

```typescript
function buildAgentInstructions(ctx: AgentRunContext): string {
  let prompt = BASE_SYSTEM_PROMPT;
  
  // Add basic context
  prompt += `\n<context>\n`;
  prompt += `User: ${ctx.user.email}\n`;
  prompt += `Workspace: ${ctx.workspaceId}\n`;
  prompt += `Current Date: ${new Date().toISOString()}\n`;
  prompt += `</context>\n`;
  
  // Add plan (read from context.plan - updated by toDoWrite)
  if (ctx.plan) {
    prompt += `\n<plan>\n`;
    prompt += `Goal: ${ctx.plan.goal}\n\n`;
    prompt += `Steps:\n`;
    ctx.plan.subTasks.forEach((task, i) => {
      const status = task.status === 'completed' ? '✓' : 
                     task.status === 'in_progress' ? '→' :
                     task.status === 'failed' ? '✗' : '○';
      prompt += `${i+1}. [${status}] ${task.description}\n`;
      if (task.dependencies.length > 0) {
        prompt += `   Dependencies: ${task.dependencies.join(', ')}\n`;
      }
    });
    prompt += `\n</plan>\n`;
  } else {
    prompt += `\n<plan>\nNo plan exists yet. Use toDoWrite to create one.\n</plan>\n`;
  }
  
  // Add tool descriptions from registry
  prompt += `\n<available_tools>\n`;
  prompt += loadToolDescriptionsFromRegistry(ctx.enabledTools);
  prompt += `</available_tools>\n`;
  
  return prompt;
}
```

**What's NOT in the prompt** (JAF handles automatically):
- ❌ Tool call history (in message history)
- ❌ Previous clarifications (in message history)
- ❌ Gathered contexts (in message history as tool results)
- ❌ Failed tools warnings (LLM sees failures in message history)

---

## 5. Tool Ecosystem

### 5.1 Core Tools

#### toDoWrite (Using Existing JAF Tool)

**Note**: We use JAF's existing `toDoWrite` tool directly - no custom wrapper needed!

**How it works**:
- Agent calls toDoWrite with plan data
- JAF's hook (`onAfterToolExecution`) intercepts the result
- We extract the plan and store in `context.plan`
- Next prompt includes updated plan from context

**Hook Integration**:
```typescript
onAfterToolExecution: async (toolName, result, hookContext) => {
  const { state } = hookContext;
  
  // Special handling for toDoWrite
  if (toolName === 'toDoWrite') {
    // Extract plan from tool result and store in context
    const planData = result?.data?.plan || result?.data;
    if (planData) {
      state.plan = {
        id: planData.id || generateId(),
        goal: planData.goal,
        subTasks: planData.subTasks || planData.tasks || [],
        chainOfThought: planData.reasoning || '',
        needsClarification: planData.needsClarification || false,
        clarificationPrompt: planData.clarificationPrompt || null,
        candidateAgents: planData.candidateAgents || [],
        createdAt: planData.createdAt || Date.now(),
        updatedAt: Date.now()
      };
    }
  }
  
  // ... rest of hook logic
};
```

**Agent usage** (agent just calls toDoWrite naturally):
```typescript
// Agent's first turn creates a task-based plan:
await toDoWrite({
  goal: "Find what Alex says about Q4",
  tasks: [
    {
      id: "task_1",
      description: "Identify which Alex user is referring to",
      tools: ["searchGoogleContacts"]
    },
    {
      id: "task_2",
      description: "Search all of Alex's Q4 communications across platforms",
      tools: ["searchGmail", "searchSlack", "searchDrive"]
      // All 3 tools are part of achieving this ONE sub-goal
    },
    {
      id: "task_3",
      description: "Analyze findings and synthesize answer",
      tools: []
      // This task may not need tools, just synthesis
    }
  ]
});

// Execution flow:
// Turn 1: Complete Task 1 (searchGoogleContacts) → Alex identified
// Turn 2: Complete Task 2 (searchGmail + searchSlack + searchDrive) → All communications gathered
// Turn 3: Complete Task 3 (synthesis) → Final answer
```

#### ListCustomAgentsTool

```typescript
interface ListCustomAgentsInput {
  query: string;
  workspaceId: string;
  requiredCapabilities?: string[];
  maxAgents?: number;
}

interface AgentCapability {
  agentId: string;
  agentName: string;
  description: string;
  capabilities: string[];
  domains: string[]; // gmail, slack, drive, etc.
  suitabilityScore: number; // 0-1
  confidence: number; // 0-1
  estimatedCost: 'low' | 'medium' | 'high';
  averageLatency: number; // ms
}

const listCustomAgentsTool: Tool<ListCustomAgentsInput, AgentRunContext> = {
  schema: {
    name: 'list_custom_agents',
    description: 'Identify relevant custom agents for the query. Use before runPublicAgent.',
    parameters: z.object({
      query: z.string(),
      workspaceId: z.string(),
      requiredCapabilities: z.array(z.string()).optional(),
      maxAgents: z.number().default(5)
    })
  },
  async execute(args, context) {
    // Fetch agents from database
    const allAgents = await db.query.agents.findMany({
      where: eq(agents.workspaceId, args.workspaceId)
    });
    
    // Score each agent based on query relevance
    const scoredAgents: AgentCapability[] = await Promise.all(
      allAgents.map(async (agent) => {
        const score = await calculateAgentSuitability(
          args.query,
          agent.description,
          agent.capabilities || []
        );
        
        return {
          agentId: agent.externalId,
          agentName: agent.name,
          description: agent.description || '',
          capabilities: agent.capabilities || [],
          domains: extractDomains(agent),
          suitabilityScore: score,
          confidence: score,
          estimatedCost: estimateCostTier(agent),
          averageLatency: agent.avgLatency || 5000
        };
      })
    );
    
    // Filter and sort
    const topAgents = scoredAgents
      .filter(a => a.suitabilityScore > 0.3)
      .sort((a, b) => b.suitabilityScore - a.suitabilityScore)
      .slice(0, args.maxAgents);
    
    // Update context
    context.availableAgents = topAgents;
    
    const summary = topAgents.length > 0
      ? `Found ${topAgents.length} suitable agents:\n` +
        topAgents.map((a, i) => 
          `${i+1}. ${a.agentName} (score: ${a.suitabilityScore.toFixed(2)}, ` +
          `latency: ~${a.averageLatency}ms, cost: ${a.estimatedCost})`
        ).join('\n')
      : 'No suitable custom agents found for this query.';
    
    return ToolResponse.success(summary, {
      agents: topAgents,
      totalEvaluated: allAgents.length
    });
  }
};
```

#### RunPublicAgentTool (Enhanced)

```typescript
interface RunPublicAgentInput {
  agentId: string;
  query: string; // Modified query specific to this agent
  context?: string;
  maxTokens?: number;
}

const runPublicAgentTool: Tool<RunPublicAgentInput, AgentRunContext> = {
  schema: {
    name: 'run_public_agent',
    description: 'Execute a custom agent. IMPORTANT: Only use after ambiguityResolved=true. Call list_custom_agents first.',
    parameters: z.object({
      agentId: z.string(),
      query: z.string().describe('Detailed, specific query for this agent'),
      context: z.string().optional(),
      maxTokens: z.number().optional()
    })
  },
  async execute(args, context) {
    // Gate check
    if (!context.ambiguityResolved) {
      return ToolResponse.error(
        'AMBIGUITY_NOT_RESOLVED',
        'Cannot run custom agent until query ambiguities are resolved'
      );
    }
    
    const startTime = Date.now();
    
    try {
      const result = await executeCustomAgent({
        agentId: args.agentId,
        query: args.query,
        context: args.context,
        userEmail: context.user.email
      });
      
      const durationMs = Date.now() - startTime;
      const fragmentIds = result.contexts?.map(c => c.id) || [];
      
      return ToolResponse.success(result.answer, {
        agentId: args.agentId,
        durationMs,
        estimatedCostUsd: result.cost || 0,
        fragmentsAdded: fragmentIds,
        contexts: result.contexts || []
      });
    } catch (error) {
      return ToolResponse.error('AGENT_EXECUTION_FAILED', error.message);
    }
  }
};
```

### 5.2 Tool Description Registry

**File**: `server/api/chat/tool-descriptions.md`

Create a single source of truth for tool documentation:

```markdown
# Tool Descriptions Registry

## search_gmail
**Purpose**: Search Gmail messages for specific content
**When to use**: When user asks about emails, communications, messages
**Parameters**:
- `query` (string, required): Search query
- `from` (string, optional): Filter by sender email
- `to` (string, optional): Filter by recipient
- `timeRange` (object, optional): Date range filter
- `excludedIds` (array, optional): Document IDs to exclude
**Example**:
```json
{
  "query": "Q4 performance review",
  "from": "alex@company.com",
  "timeRange": { "start": "2024-10-01", "end": "2024-12-31" }
}
```
**Can be combined with**: search_slack, search_drive (when they contribute to same sub-goal)

## search_slack
**Purpose**: Search Slack messages and channels
**Parameters**:
- `query` (string, required): Search query
- `channel` (string, optional): Specific channel
- `timeRange` (object, optional): Date range
**Can be combined with**: search_gmail, search_drive (when they contribute to same sub-goal)

## list_custom_agents
**Purpose**: Find relevant custom agents for a query
**When to use**: Before calling run_public_agent
**Parameters**:
- `query` (string, required): User query
- `requiredCapabilities` (array, optional): Specific capabilities needed
**Example**:
```json
{
  "query": "Analyze Q4 financial performance",
  "requiredCapabilities": ["financial_analysis", "reporting"]
}
```

## run_public_agent
**Purpose**: Execute a custom agent
**Prerequisites**: 
- Must call list_custom_agents first
- ambiguityResolved must be true
**Parameters**:
- `agentId` (string, required): Agent ID from list_custom_agents
- `query` (string, required): Specific, detailed query
- `context` (string, optional): Additional context
**Example**:
```json
{
  "agentId": "agent_12345",
  "query": "Based on the Q4 financial data, what are the top 3 growth areas?",
  "context": "Previous search found 47 documents mentioning Q4 performance"
}
```

## write_plan
**Purpose**: Create or modify the execution plan
**When to use**: 
- First action (create plan)
- When strategy changes (update plan)
- When substep completes (mark complete)
**Actions**: create, update, complete_step, add_step, remove_step

## review_agent
**Purpose**: Evaluate current execution quality and suggest improvements
**When to use**:
- Every 5 turns
- When results seem incomplete
- Before final answer
**Input**: Current plan, tool results, gathered contexts
**Output**: Quality scores, gaps, suggested actions
```

**Loading Function**:
```typescript
function loadToolDescriptionsFromRegistry(enabledTools: Set<string>): string {
  const registryPath = path.join(__dirname, 'tool-descriptions.md');
  const fullRegistry = fs.readFileSync(registryPath, 'utf-8');
  
  // Parse and filter only enabled tools
  const toolSections = parseToolRegistry(fullRegistry);
  const relevantSections = toolSections.filter(section => 
    enabledTools.has(section.toolName)
  );
  
  return relevantSections.map(s => s.content).join('\n\n');
}
```

---

## 6. Execution Flow

### 6.1 Complete Orchestration Flow

```typescript
async function messageWithToolsOrchestrator(
  request: MessageRequest,
  context: AgentRunContext
): Promise<void> {
  
  // PHASE 0: Initialization
  const { user, chat, message } = await initializeRequest(request);
  context.user = user;
  context.chat = chat;
  context.message = message;
  
  // PHASE 1: Planning
  const planResult = await executePlanningPhase(context);
  context.plan = planResult.plan;
  
  // PHASE 1.5: Clarification (if needed)
  if (planResult.needsClarification) {
    const clarified = await executeClarificationPhase(context, planResult.clarificationPrompt);
    context.clarifications.push(clarified);
    context.ambiguityResolved = true;
  } else {
    context.ambiguityResolved = true;
  }
  
  // PHASE 2: Main Execution Loop
  let turnCount = 0;
  const maxTurns = 15;
  let shouldContinue = true;
  
  while (shouldContinue && turnCount < maxTurns) {
    turnCount++;
    
    // Build dynamic prompt
    const systemPrompt = buildAgentInstructions(context);
    
    // Execute JAF run
    const runResult = await executeJAFRun(context, systemPrompt);
    
    // Check if review needed
    if (shouldTriggerReview(context, turnCount)) {
      const reviewResult = await executeReviewPhase(context);
      
      if (reviewResult.recommendation === 'replan') {
        context.plan = reviewResult.updatedPlan!;
        continue;
      } else if (reviewResult.recommendation === 'proceed') {
        shouldContinue = false; // Ready to synthesize
      }
    }
    
    // Check completion criteria
    const allTasksComplete = context.plan?.subTasks.every(
      t => t.status === 'completed'
    );
    
    if (allTasksComplete || runResult.hasF inalAnswer) {
      shouldContinue = false;
    }
  }
  
  // PHASE 3: Synthesis
  await synthesizeFinalAnswer(context);
  
  // Persistence
  await persistExecutionState(context);
}
```

### 6.2 JAF Run Configuration with Hooks

```typescript
const runConfig: JAFRunConfig<AgentRunContext> = {
  agentRegistry,
  modelProvider,
  maxTurns: 1, // One turn per loop iteration
  modelOverride: userSelectedModel,
  
  // BEFORE TOOL EXECUTION
  onBeforeToolExecution: async (toolName, args, hookContext) => {
    const { state } = hookContext;
    
    // 1. Duplicate detection
    const isDuplicate = state.toolCallHistory.some(
      record =>
        record.toolName === toolName &&
        JSON.stringify(record.arguments) === JSON.stringify(args) &&
        record.status === 'success' &&
        (Date.now() - record.startedAt.getTime()) < 60000 // 1 minute
    );
    
    if (isDuplicate) {
      await emitSSE({
        type: ChatSSEvents.ReasoningStep,
        message: `⚠️ Skipping duplicate ${toolName} call`
      });
      return null; // Skip execution
    }
    
    // 2. Failed tool budget check
    const failureInfo = state.failedTools.get(toolName);
    if (failureInfo && failureInfo.count >= 3) {
      await emitSSE({
        type: ChatSSEvents.ReasoningStep,
        message: `⚠️ ${toolName} has failed ${failureInfo.count} times, blocked`
      });
      return null;
    }
    
    // 3. Add excludedIds to prevent re-fetching
    if (args.excludedIds !== undefined) {
      const seenIds = Array.from(state.seenDocuments);
      return {
        ...args,
        excludedIds: [...(args.excludedIds || []), ...seenIds]
      };
    }
    
    return args;
  },
  
  // AFTER TOOL EXECUTION
  onAfterToolExecution: async (toolName, result, hookContext) => {
    const { state, executionTime, status, args } = hookContext;
    
    // 1. Create execution record
    const record: ToolExecutionRecord = {
      toolName,
      connectorId: result?.metadata?.connectorId || null,
      agentName: result?.metadata?.agentName || 'main',
      arguments: args,
      startedAt: new Date(Date.now() - executionTime),
      durationMs: executionTime,
      estimatedCostUsd: result?.metadata?.estimatedCostUsd || 0,
      resultSummary: truncate(JSON.stringify(result?.data), 200),
      fragmentsAdded: result?.metadata?.fragmentsAdded || [],
      status: status === 'success' ? 'success' : 'error',
      error: status !== 'success' ? {
        code: result?.error?.code || 'UNKNOWN',
        message: result?.error?.message || 'Unknown error'
      } : undefined
    };
    
    // 2. Add to history
    state.toolCallHistory.push(record);
    
    // 3. Update metrics
    state.totalLatency += executionTime;
    state.totalCost += record.estimatedCostUsd;
    
    // 4. Track failures
    if (status !== 'success') {
      const existing = state.failedTools.get(toolName) || {
        count: 0,
        lastError: '',
        lastAttempt: 0
      };
      state.failedTools.set(toolName, {
        count: existing.count + 1,
        lastError: record.error!.message,
        lastAttempt: Date.now()
      });
    }
    
    // 5. Extract and filter contexts
    const contexts = result?.metadata?.contexts;
    if (Array.isArray(contexts) && contexts.length > 0) {
      const newContexts = contexts.filter(
        c => !state.seenDocuments.has(c.id)
      );
      
      if (newContexts.length > 0) {
        // Use extractBestDocumentIndexes to filter
        try {
          const contextStrings = newContexts.map(c => c.content);
          const bestIndexes = await extractBestDocumentIndexes(
            state.message.text,
            contextStrings,
            { modelId: defaultFastModel },
            []
          );
          
          const selectedContexts = bestIndexes
            .map(idx => newContexts[idx - 1])
            .filter(Boolean);
          
          state.contextFragments.push(...selectedContexts);
          selectedContexts.forEach(c => state.seenDocuments.add(c.id));
          
          // Update record
          record.fragmentsAdded = selectedContexts.map(c => c.id);
        } catch (error) {
          // Fallback: add all
          state.contextFragments.push(...newContexts);
          newContexts.forEach(c => state.seenDocuments.add(c.id));
          record.fragmentsAdded = newContexts.map(c => c.id);
        }
      }
    }
    
    // 6. Emit SSE event
    await emitSSE({
      type: ChatSSEvents.ToolMetric,
      data: {
        toolName,
        durationMs: executionTime,
        cost: record.estimatedCostUsd,
        status,
        fragmentsAdded: record.fragmentsAdded.length
      }
    });
    
    return result?.data;
  }
};
```

---

## 7. Schemas & Data Structures

### 7.1 ToolExecutionRecord

```typescript
interface ToolExecutionRecord {
  toolName: string;
  connectorId: string | null;
  agentName: string;
  arguments: Record<string, unknown>;
  startedAt: Date;
  durationMs: number;
  estimatedCostUsd: number;
  resultSummary: string;
  fragmentsAdded: string[]; // Fragment IDs
  status: 'success' | 'error' | 'skipped';
  error?: {
    code: string;
    message: string;
  };
}
```

### 7.2 Review Schemas

```typescript
interface ReviewResult {
  status: 'ok' | 'error';
  qualityScore: number; // 0-1
  completeness: number; // 0-1
  relevance: number; // 0-1
  needsMoreData: boolean;
  gaps: string[];
  suggestedActions: ReviewAction[];
  recommendation: 'proceed' | 'gather_more' | 'clarify_query' | 'replan';
  updatedPlan?: PlanState;
  notes: string;
}

interface ReviewAction {
  type: 'clarify' | 'reorder' | 'add_step' | 'remove_step' | 'stop';
  target?: string;
  prompt?: string;
  reason: string;
}
```

---

## 8. Prompt Engineering Strategy

### 8.1 Base System Prompt

```xml
You are Xyne, an enterprise search assistant with advanced agentic capabilities.

Your core responsibilities:
1. Create execution plans before taking action
2. Resolve ambiguities through clarification
3. Execute tools intelligently (parallel when independent, sequential when dependent)
4. Gather high-quality context from multiple sources
5. Synthesize comprehensive answers with citations
6. Adapt strategy based on results

You have access to:
- Planning tools (write_plan)
- Search tools (Gmail, Slack, Drive, Calendar, etc.)
- Custom agent tools (list_custom_agents, run_public_agent)
- Review tools (review_agent)
- Clarification tools

Core principles:
- PLAN FIRST: Always create a structured plan before execution
- CLARIFY AMBIGUITY: Resolve unclear entities before expensive operations
- CITE SOURCES: Always reference specific documents [n]
- AVOID DUPLICATION: Never call the same tool with same parameters
- HANDLE FAILURES: After 3 failures, find alternative approaches
- PARALLEL > SEQUENTIAL: Execute independent operations concurrently
```

### 8.2 Dynamic Sections

Sections injected based on context state:
- `<plan>` - Current execution plan with substep status
- `<clarifications>` - Previous clarifications and resolutions
- `<tool_call_history>` - All tool executions with metrics
- `<gathered_context>` - Summary of collected information
- `<failed_tools>` - Tools to avoid due to repeated failures
- `<available_tools>` - Filtered tool descriptions from registry

---

## 9. Implementation Roadmap

### Phase 1: Foundation (Week 1-2)
- [ ] Define TypeScript schemas (AgentRunContext, PlanState, ToolExecutionRecord)
- [ ] Create tool-descriptions.md registry file
- [ ] Implement dynamic prompt builder (`buildAgentInstructions`)
- [ ] Refactor MessageWithToolsApi into orchestrator module
- [ ] Implement basic WritePlanTool
- [ ] Add tool call history tracking

### Phase 2: Planning Layer (Week 3)
- [ ] Implement PlanAgent with fast model
- [ ] Create ListCustomAgentsTool
- [ ] Integrate clarification flow
- [ ] Add ambiguityResolved gating for runPublicAgent
- [ ] Implement plan persistence to database

### Phase 3: Execution Hooks (Week 4)
- [ ] Implement onBeforeToolExecution hook (duplicate detection, excludedIds)
- [ ] Implement onAfterToolExecution hook (metrics, context filtering)
- [ ] Add extractBestDocumentIndexes integration
- [ ] Implement failed tool tracking and removal
- [ ] Add SSE events for tool metrics

### Phase 4: Review System (Week 5)
- [ ] Implement ReviewAgentTool
- [ ] Create review trigger logic (every N turns)
- [ ] Implement replanning based on review feedback
- [ ] Add decision logging

### Phase 5: Testing & Refinement (Week 6-7)
- [ ] Unit tests for all tools
- [ ] Integration tests for complete flow
- [ ] Test "Alex Q4" scenario (task-by-task execution)
- [ ] Test multi-tool single-task execution
- [ ] Test error recovery and replanning
- [ ] Performance optimization

### Phase 6: Migration & Rollout (Week 8)
- [ ] Feature flag for new vs old flow
- [ ] Gradual rollout (10% → 50% → 100%)
- [ ] Monitor metrics (latency, cost, quality)
- [ ] Documentation and training

---

## 10. Examples & Use Cases

### Example 1: "What does Alex say about Q4?"

**Phase 1: Planning**
```json
{
  "goal": "Find what Alex says about Q4",
  "subTasks": [
    {
      "id": "task_1",
      "description": "Identify which Alex user is referring to",
      "toolsRequired": ["searchGoogleContacts"],
      "status": "pending"
    },
    {
      "id": "task_2",
      "description": "Search all of Alex's Q4 communications across all platforms",
      "toolsRequired": ["searchGmail", "searchSlack", "searchDrive"],
      "status": "pending"
    },
    {
      "id": "task_3",
      "description": "Synthesize findings into comprehensive answer",
      "toolsRequired": [],
      "status": "pending"
    }
  ],
  "needsClarification": true,
  "clarificationPrompt": "Found 3 people named Alex. Which one?"
}
```

**Phase 2: Clarification**
- User selects: Alex Johnson (alex.j@company.com)
- Context updated: `ambiguityResolved = true`

**Phase 3: Sequential Task Execution**

**Turn 1 - Task 1: Identify Alex**
- Tool: searchGoogleContacts
- Result: Alex Johnson (alex.j@company.com) identified
- Status: task_1 = "completed" ✓

**Turn 2 - Task 2: Search All Communications**
- Tools called as part of this ONE task:
  * searchGmail → 23 Q4 emails found
  * searchSlack → 15 Q4 messages found  
  * searchDrive → 9 Q4 documents found
- All results filtered to 12 high-quality contexts
- Status: task_2 = "completed" ✓

**Turn 3 - Task 3: Synthesize**
- Synthesis of gathered contexts
- Status: task_3 = "completed" ✓

**Final Answer**
```
Based on communications from Alex Johnson across email, Slack, and Drive:

1. Q4 exceeded targets by 15% [1]
2. Key growth in APAC region [2,3]
3. Recommended doubling Q1 investment in product [4]

[1] Email: "Q4 Results Summary" (Dec 15)
[2] Slack #quarterly-review: "APAC performance" (Dec 10)
[3] Drive: "Q4 Analysis.pdf" (Dec 20)
[4] Email: "2025 Planning" (Dec 28)
```

### Example 2: Complex Multi-Agent Query

**Query**: "Analyze Q4 performance and create action plan"

**Task-Based Sequential Execution**:

**Task 1**: Identify relevant custom agents
- Tool: list_custom_agents
- Result: "Financial Analyzer" agent found
- Status: completed ✓

**Task 2**: Gather all Q4 performance data
- Tools (all part of achieving this sub-goal):
  * searchGmail → Financial reports
  * searchSlack → Performance discussions
  * searchDrive → Q4 spreadsheets and presentations
- Result: 47 documents gathered and filtered
- Status: completed ✓

**Task 3**: Run financial analysis
- Tool: run_public_agent (Financial Analyzer)
- Result: Detailed financial analysis received
- Review identifies gap in competitive data
- Status: completed ✓

**Task 4**: Gather competitive analysis data (replanned)
- Tools:
  * searchGmail (competitor mentions)
  * searchDrive (market research)
- Result: Competitive context added
- Status: completed ✓

**Task 5**: Synthesize comprehensive action plan
- Synthesis of all gathered data
- Result: Final comprehensive report with action items
- Status: completed ✓

---

## 11. Testing Strategy

### 11.1 Unit Tests

```typescript
describe('WritePlanTool', () => {
  it('should create valid plan', async () => {
    const result = await writePlanTool.execute({
      action: 'create',
      plan: mockPlan
    }, mockContext);
    
    expect(result.status).toBe('success');
    expect(mockContext.plan).toEqual(mockPlan);
  });
  
  it('should reject invalid plan structure', async () => {
    const result = await writePlanTool.execute({
      action: 'create',
      plan: { ...mockPlan, subTasks: null }
    }, mockContext);
    
    expect(result.status).toBe('error');
  });
});
```

### 11.2 Integration Tests

```typescript
describe('MessageWithTools Orchestrator', () => {
  it('should complete Alex Q4 scenario', async () => {
    const result = await messageWithToolsOrchestrator({
      message: 'What does Alex say about Q4?',
      user: mockUser,
      chat: mockChat
    });
    
    expect(result.plan).toBeDefined();
    expect(result.plan.needsClarification).toBe(true);
    expect(result.toolCallHistory.length).toBeGreaterThan(0);
    expect(result.contextFragments.length).toBeGreaterThan(0);
  });
});
```

---

## 12. Migration & Rollout

### 12.1 Feature Flag

```typescript
const USE_AGENTIC_FLOW = process.env.ENABLE_AGENTIC_FLOW === 'true';

async function messageWithTools(request) {
  if (USE_AGENTIC_FLOW) {
    return await messageWithToolsOrchestrator(request);
  } else {
    return await legacyMessageWithTools(request);
  }
}
```

### 12.2 Rollout Plan

1. **Week 1-2**: Internal testing (10% traffic)
2. **Week 3-4**: Beta users (25% traffic)
3. **Week 5-6**: Expanded rollout (50% traffic)
4. **Week 7-8**: Full rollout (100% traffic)
5. **Week 9+**: Remove legacy code

### 12.3 Success Metrics

Monitor:
- Plan creation rate
- Clarification frequency
- Task completion rate (one task at a time)
- Tools per task ratio
- Tool failure recovery rate
- Average latency per task
- Average cost per query
- User satisfaction scores

---

## Conclusion

This unified plan combines:
- **Architectural depth** from the first document (comprehensive schemas, detailed flows)
- **Practical implementation focus** from the second document (concrete roadmap, realistic constraints)

Key differentiators:
1. **Modular architecture** replacing monolithic controller
2. **Mandatory planning** before any tool execution
3. **Clarification-first** approach for ambiguous queries
4. **Full telemetry** tracking every tool call with complete metadata
5. **Task-based sequential execution** (one sub-goal at a time, multiple tools per task allowed)
6. **Review & adaptation** through continuous evaluation
7. **Schema-based** everything for reliability and auditability
8. **Practical roadmap** with clear phases and milestones

The system is designed to be implemented iteratively, tested thoroughly, and rolled out gradually while maintaining backward compatibility with the existing system.
