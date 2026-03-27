# Agentic RAG System Architecture Analysis & Redesign Proposal

## Executive Summary

This document provides a deep analysis of the current Xyne chat/RAG system architecture and proposes a clean, extensible framework-level redesign. The current implementation suffers from significant architectural debt that makes it difficult to extend, maintain, and adopt across teams.

---

## Part 1: Current Architecture Analysis

### 1.1 Overview of Current Implementation

The current system spans multiple files with overlapping responsibilities:

```
server/api/chat/
├── pi-mono/
│   ├── message-agents.ts       (1065 lines) - Main HTTP handler, business logic, streaming
│   ├── adapter.ts              (491 lines) - State management, tool adapter, session store
│   ├── helpers.ts              (527 lines) - Bootstrap, persistence, attachment handling
│   ├── xyne-handlers.ts        (266 lines) - Event handlers for pi-mono runtime
│   ├── core/
│   │   ├── runtime.ts          (178 lines) - pi-mono session wrapper
│   │   └── event-router.ts     (53 lines) - Simple event routing
│   ├── prompts/
│   │   └── xyne-prompts.ts     (310 lines) - Prompt building with sections
│   └── tools/                  (20+ files) - Individual tool implementations
├── message-agents.ts           (2000+ lines) - Legacy JAF implementation
├── jaf-provider.ts             (876 lines) - JAF provider with LiteLLM/AI SDK routing
├── utils.ts                    (1619 lines) - Citation handling, file processing
└── types.ts                    (214 lines) - Type definitions
```

### 1.2 Critical Anti-Patterns Identified

#### 1.2.1 God Functions and Files

**message-agents.ts** (pi-mono version) combines:
- HTTP request/response handling
- JWT authentication and validation
- Model configuration parsing (200+ lines)
- File ID extraction and attachment processing
- Database transactions for chat/message creation
- Session registration and state initialization
- Memory retrieval (episodic + chat)
- Tool assembly (hardcoded list)
- Streaming SSE response generation
- Citation extraction and deduplication
- Error handling and fallback logic
- Message persistence and tracing

**Single function `MessageAgentsPiMono` is 900+ lines**, handling the entire request lifecycle.

#### 1.2.2 Global State Management

The `adapter.ts` file implements session-scoped storage using module-level variables:

```typescript
// module-level state - shared across all requests
let activeSessionId: string | null = null
const sessionStore = new Map<string, SessionContext>()

export function registerSession(...) {
  sessionStore.set(sessionId, { state, runtime, persistFn })
  activeSessionId = sessionId  // race condition risk
}
```

**Problems:**
- Race conditions with concurrent requests
- Memory leaks (no TTL on sessions)
- No isolation between requests
- Impossible to unit test
- Difficult to reason about state

#### 1.2.3 Tight Coupling Between Layers

```typescript
// message-agents.ts imports from everywhere:
import config from "@/config"
import { db } from "@/db/client"
import { getAgentByExternalIdWithPermissionCheck } from "@/db/agent"
import { expandSheetIds } from "@/search/utils"
import { extractFileIdsFromMessage } from "@/api/chat/utils"
import { emitReasoningEvent } from "@/api/chat/reasoning-steps"
import { activeStreams } from "@/api/chat/stream"
import type { Citation } from "@/api/chat/types"
import { checkAndYieldCitationsForAgent } from "@/api/chat/utils"
import { getModelValueFromLabel } from "@/ai/modelConfig"
import { Models } from "@/ai/types"
import { parseAttachmentMetadata } from "@/utils/parseAttachment"
import { userContext } from "@/ai/context"
import { retrieveEpisodicMemories } from "@/services/episodicMemoryRetriever"
import { retrieveRelevantChatHistory } from "@/services/chatMemoryRetriever"
```

The main handler knows about:
- Database schema and queries
- Search infrastructure (Vespa)
- AI providers and models
- File systems and attachments
- Multiple tool implementations
- Event streaming internals

**This violates Dependency Inversion Principle** - high-level policy depends on low-level details.

#### 1.2.4 Hardcoded Tool Assembly

```typescript
// message-agents.ts
function buildXyneTools(): any[] {
  return [
    searchGlobalTool,
    searchGmailTool,
    searchDriveFilesTool,
    // ... 15+ tools manually listed
    synthesizeFinalAnswerTool,
    listCustomAgentsTool,
    runPublicAgentTool,
  ]
}
```

**Problems:**
- Adding a new tool requires editing this function
- No dependency injection
- Cannot disable tools dynamically
- No tool versioning or scoping
- Testing requires mocking entire tool set

#### 1.2.5 Duplicated Logic Across Implementations

Two parallel implementations exist:
1. **JAF-based** (`message-agents.ts` - legacy)
2. **pi-mono-based** (`pi-mono/message-agents.ts` - new)

Both implement:
- Citation extraction (`checkAndYieldCitationsForAgent`)
- Final synthesis payload building (`buildFinalSynthesisPayload`)
- Tool execution and fragment handling
- Conversation history management

**Code duplication leads to:**
- Inconsistent behavior
- Double maintenance burden
- Diverging feature sets
- Confusion about which to use

#### 1.2.6 Lack of Abstractions for Chat Modes

Current code has no clear abstraction for different chat modes:
- Normal chat vs. agent-based chat
- Attachment-based retrieval
- Knowledge base search
- Multi-agent delegation

All logic is interwoven in the main handler with conditional branches:

```typescript
if (normalizedAgentId) {
  // Agent-specific logic
  agentRecord = await getAgentByExternalIdWithPermissionCheck(...)
  agentPromptForLLM = JSON.stringify(agentRecord)
}

if (allReferencedFileIds.length > 0) {
  // Attachment processing logic
  initialAttachmentContext = await prepareInitialAttachmentContext(...)
}

// Later, more conditional logic for synthesis, citations, etc.
```

#### 1.2.7 Streaming and Citation Logic Mixed

Citation extraction happens inline with streaming:

```typescript
setRuntime({
  streamAnswerText: async (text: string) => {
    answer += text
    await stream.writeSSE({ event: ChatSSEvents.ResponseUpdate, data: text })
    
    // Citation extraction happening DURING streaming
    for await (const citationEvent of checkAndYieldCitationsForAgent(...)) {
      await stream.writeSSE({ event: ChatSSEvents.CitationsUpdate, ... })
    }
  },
})
```

This makes the code difficult to test, reason about, and extend.

### 1.3 Data Flow Analysis

```
┌─────────────────────────────────────────────────────────────────┐
│                         HTTP Request                            │
│  POST /api/chat/message                                         │
└───────────────────────┬─────────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────────┐
│                    Request Parsing                              │
│  - JWT validation                                               │
│  - Model config parsing (200+ lines)                           │
│  - File ID extraction                                          │
│  - Attachment metadata parsing                                 │
└───────────────────────┬─────────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────────┐
│                    Database Operations                          │
│  - Get user/workspace                                           │
│  - Create/fetch chat                                           │
│  - Persist user message                                        │
│  - Fetch conversation history                                  │
└───────────────────────┬─────────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────────┐
│                    Context Preparation                          │
│  - Episodic memory retrieval                                   │
│  - Chat memory retrieval                                       │
│  - Attachment context preparation                              │
│  - Agent prompt resolution                                     │
└───────────────────────┬─────────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────────┐
│                    Session Initialization                       │
│  - Build tools list                                            │
│  - Build system prompt (complex prompt building)               │
│  - Create pi-mono session                                      │
│  - Register session in global store                            │
└───────────────────────┬─────────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────────┐
│                    Agent Execution                              │
│  - Start agent with user message                               │
│  - Event routing (tool calls, completions)                     │
│  - Tool execution with state updates                           │
│  - Fragment collection and ranking                             │
└───────────────────────┬─────────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────────┐
│                    Streaming Response                           │
│  - SSE event generation                                        │
│  - Citation extraction inline                                  │
│  - Final synthesis tool call                                   │
│  - Message persistence                                         │
└─────────────────────────────────────────────────────────────────┘
```

### 1.4 Extensibility Failures

| Extension Need | Current Approach | Problem |
|---------------|------------------|---------|
| Add new chat mode | Edit message-agents.ts | Risk of breaking existing modes |
| Add new tool | Edit buildXyneTools() | No dynamic tool discovery |
| Add new retrieval strategy | Edit search tools directly | No pluggable retrieval |
| Add new citation format | Edit checkAndYieldCitationsForAgent | Single hardcoded implementation |
| Add new LLM provider | Edit jaf-provider.ts | Provider logic scattered |
| Add new memory type | Edit message-agents.ts | Memory retrieval inline |
| Add MCP connector | Partial implementation | MCP agents mixed with native tools |

---

## Part 2: Proposed Architecture

### 2.1 Design Principles

1. **Separation of Concerns**: Clear boundaries between HTTP, business logic, and infrastructure
2. **Dependency Inversion**: Depend on abstractions, not concrete implementations
3. **Composition over Inheritance**: Build chat modes by composing strategies
4. **Plugin Architecture**: Tools, retrievers, and citation handlers are plugins
5. **Testability**: All components are independently testable with mock dependencies
6. **Type Safety**: Strong TypeScript interfaces at all boundaries

### 2.2 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         API Layer (Hono)                            │
│  - HTTP request/response handling                                   │
│  - Authentication/authorization                                     │
│  - Input validation                                                 │
└───────────────────────┬─────────────────────────────────────────────┘
                        │ ChatRequest
                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Chat Orchestrator                              │
│  - Route to appropriate ChatModeStrategy                            │
│  - Manage request lifecycle                                         │
│  - Coordinate between components                                    │
└───────────────────────┬─────────────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        │               │               │
        ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   Normal     │ │   Agentic    │ │  Attachment  │
│   Chat       │ │   Chat       │ │   Chat       │
│  Strategy    │ │  Strategy    │ │  Strategy    │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │
       └────────┬───────┴───────┬────────┘
                │               │
                ▼               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Chat Pipeline                                  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                │
│  │   Context    │ │  Retrieval   │ │  Generation  │                │
│  │   Assembly   │ │   Pipeline   │ │   Pipeline   │                │
│  └──────────────┘ └──────────────┘ └──────────────┘                │
└─────────────────────────────────────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        │               │               │
        ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  Tool        │ │  Citation    │ │  Memory      │
│  Registry    │ │  Manager     │ │  Service     │
└──────────────┘ └──────────────┘ └──────────────┘
```

### 2.3 Folder/Module Structure

```
server/api/chat/
├── api/
│   ├── routes.ts                 # Hono route definitions
│   ├── middleware.ts             # Auth, validation middleware
│   └── handlers/
│       ├── chat.handler.ts       # Main chat endpoint
│       └── streaming.handler.ts  # SSE streaming utilities
├── core/
│   ├── orchestrator/
│   │   ├── chat-orchestrator.ts  # Main coordination logic
│   │   └── request-context.ts    # Per-request context (replaces global state)
│   ├── strategies/
│   │   ├── chat-mode-strategy.interface.ts
│   │   ├── normal-chat.strategy.ts
│   │   ├── agentic-chat.strategy.ts
│   │   ├── attachment-chat.strategy.ts
│   │   └── knowledge-base-chat.strategy.ts
│   ├── pipeline/
│   │   ├── context-assembly/
│   │   │   ├── context-assembler.interface.ts
│   │   │   ├── default-context-assembler.ts
│   │   │   └── agent-context-assembler.ts
│   │   ├── retrieval/
│   │   │   ├── retrieval-pipeline.interface.ts
│   │   │   ├── default-retrieval-pipeline.ts
│   │   │   └── knowledge-base-pipeline.ts
│   │   └── generation/
│   │       ├── generation-pipeline.interface.ts
│   │       ├── streaming-generator.ts
│   │       └── synthesis-generator.ts
│   └── runtime/
│       ├── runtime.interface.ts
│       ├── pi-mono-runtime.ts
│       └── jaf-runtime.ts
├── plugins/
│   ├── tools/
│   │   ├── tool.interface.ts
│   │   ├── tool-registry.ts
│   │   ├── base/
│   │   │   ├── search-tool.base.ts
│   │   │   └── delegation-tool.base.ts
│   │   └── implementations/
│   │       ├── search-global.tool.ts
│   │       ├── search-gmail.tool.ts
│   │       ├── search-kb.tool.ts
│   │       ├── list-agents.tool.ts
│   │       └── synthesize.tool.ts
│   ├── retrievers/
│   │   ├── retriever.interface.ts
│   │   ├── retriever-registry.ts
│   │   ├── vespa-retriever.ts
│   │   ├── kb-retriever.ts
│   │   └── memory-retriever.ts
│   ├── citations/
│   │   ├── citation-handler.interface.ts
│   │   ├── citation-registry.ts
│   │   ├── standard-citation-handler.ts
│   │   └── chunk-citation-handler.ts
│   └── memory/
│       ├── memory-provider.interface.ts
│       ├── episodic-memory.provider.ts
│       └── chat-memory.provider.ts
├── models/
│   ├── chat-request.ts           # Request DTOs
│   ├── chat-response.ts          # Response DTOs
│   ├── fragment.ts               # Fragment/Context models
│   ├── citation.ts               # Citation models
│   └── agent-state.ts            # Agent state interface
├── services/
│   ├── chat-session.service.ts   # Session lifecycle management
│   ├── message-persistence.service.ts
│   ├── citation-extraction.service.ts
│   └── prompt-builder.service.ts
└── shared/
    ├── types.ts                  # Shared type definitions
    ├── events.ts                 # Event definitions
    └── constants.ts              # Constants
```

### 2.4 Core Abstractions

#### 2.4.1 Chat Mode Strategy Pattern

```typescript
// core/strategies/chat-mode-strategy.interface.ts

export interface ChatModeStrategy {
  readonly mode: ChatMode
  
  /**
   * Determine if this strategy can handle the request
   */
  canHandle(request: ChatRequest): boolean
  
  /**
   * Execute the chat flow
   */
  execute(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent>
}

export enum ChatMode {
  Normal = 'normal',
  Agentic = 'agentic',
  Attachment = 'attachment',
  KnowledgeBase = 'knowledge-base',
  MultiAgent = 'multi-agent',
}

// Registry for strategies
export class ChatModeStrategyRegistry {
  private strategies = new Map<ChatMode, ChatModeStrategy>()
  
  register(mode: ChatMode, strategy: ChatModeStrategy): void
  get(mode: ChatMode): ChatModeStrategy | undefined
  findFor(request: ChatRequest): ChatModeStrategy
}
```

#### 2.4.2 Request Context (Replaces Global State)

```typescript
// core/orchestrator/request-context.ts

export class RequestContext {
  constructor(
    public readonly requestId: string,
    public readonly user: UserContext,
    public readonly chat: ChatContext,
    public readonly session: SessionState,
    public readonly dependencies: DependencyContainer,
    private readonly abortSignal: AbortSignal
  ) {}
  
  // Factory method creates isolated context per request
  static async create(
    request: ChatRequest,
    dependencies: DependencyContainer
  ): Promise<RequestContext>
  
  // Check if request is cancelled
  get isAborted(): boolean
  
  // Access tools, retrievers, etc. through dependency container
  get tools(): ToolRegistry
  get retrievers(): RetrieverRegistry
  get citationHandlers(): CitationRegistry
}
```

#### 2.4.3 Pipeline Architecture

```typescript
// core/pipeline/context-assembly/context-assembler.interface.ts

export interface ContextAssembler {
  assemble(context: RequestContext): Promise<ChatContext>
}

export interface ChatContext {
  userMessage: string
  conversationHistory: Message[]
  attachments?: AttachmentContext
  memories?: MemoryContext
  agentConfig?: AgentConfig
}

// core/pipeline/retrieval/retrieval-pipeline.interface.ts

export interface RetrievalPipeline {
  retrieve(
    query: string,
    context: RequestContext
  ): AsyncIterable<RetrievalResult>
}

export interface RetrievalResult {
  fragments: Fragment[]
  source: RetrievalSource
  confidence: number
}

// core/pipeline/generation/generation-pipeline.interface.ts

export interface GenerationPipeline {
  generate(
    context: ChatContext,
    retrievedFragments: Fragment[],
    requestContext: RequestContext
  ): AsyncIterable<GenerationEvent>
}

export type GenerationEvent =
  | { type: 'token'; content: string }
  | { type: 'tool-call'; tool: string; args: unknown }
  | { type: 'tool-result'; tool: string; result: unknown }
  | { type: 'citation'; citation: Citation }
  | { type: 'complete' }
```

#### 2.4.4 Plugin Architecture for Tools

```typescript
// plugins/tools/tool.interface.ts

export interface Tool<TParams = unknown, TResult = unknown> {
  readonly name: string
  readonly description: string
  readonly parameters: JSONSchema
  
  /**
   * Execute the tool
   */
  execute(
    params: TParams,
    context: ToolExecutionContext
  ): Promise<ToolResult<TResult>>
}

export interface ToolExecutionContext {
  requestContext: RequestContext
  toolCallId: string
  signal: AbortSignal
}

export interface ToolResult<TResult> {
  success: boolean
  data?: TResult
  error?: ToolError
  citations?: Citation[]
  fragments?: Fragment[]
}

// plugins/tools/tool-registry.ts

export class ToolRegistry {
  private tools = new Map<string, Tool>()
  
  register(tool: Tool): void
  get(name: string): Tool | undefined
  getAll(): Tool[]
  getForMode(mode: ChatMode): Tool[]
  
  // Dynamic tool discovery
  discoverFromPlugins(): void
}
```

#### 2.4.5 Citation Handler Abstraction

```typescript
// plugins/citations/citation-handler.interface.ts

export interface CitationHandler {
  /**
   * Extract citations from generated text
   */
  extractCitations(
    text: string,
    fragments: Fragment[],
    context: RequestContext
  ): AsyncIterable<CitationEvent>
  
  /**
   * Format citations for output
   */
  formatCitations(citations: Citation[]): FormattedCitation[]
  
  /**
   * Get citation pattern for prompting
   */
  getCitationFormat(): string
}

export interface CitationEvent {
  citation?: Citation
  imageCitation?: ImageCitation
  chunkCitation?: ChunkCitation
}

// Multiple implementations
export class StandardCitationHandler implements CitationHandler {
  // Handles [1], [2], [3] format
}

export class ChunkCitationHandler implements CitationHandler {
  // Handles K[1_0], K[1_1] format
}
```

#### 2.4.6 Runtime Abstraction (pi-mono vs JAF)

```typescript
// core/runtime/runtime.interface.ts

export interface AgentRuntime {
  /**
   * Create a new session
   */
  createSession(config: SessionConfig): Promise<AgentSession>
}

export interface AgentSession {
  readonly id: string
  
  /**
   * Send a message to the agent
   */
  sendMessage(message: string): Promise<void>
  
  /**
   * Subscribe to events
   */
  subscribe(handler: EventHandler): Unsubscribe
  
  /**
   * Stop the session
   */
  stop(): void
}

// Implementations
export class PiMonoRuntime implements AgentRuntime {
  // Wraps @mariozechner/pi-coding-agent
}

export class JAFRuntime implements AgentRuntime {
  // Wraps @xynehq/jaf
}
```

### 2.5 Example Flow: Agentic Chat with Citations

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. HTTP Request Received                                         │
│    POST /api/chat/message                                        │
│    { message, agentId, modelConfig, attachments? }               │
└─────────────────────┬────────────────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────────────────┐
│ 2. Orchestrator Processes Request                                │
│    - Validate JWT                                                │
│    - Parse model configuration                                   │
│    - Create RequestContext (isolated per-request)                │
└─────────────────────┬────────────────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────────────────┐
│ 3. Strategy Selection                                            │
│    - AgenticChatStrategy.canHandle({ agentId }) → true           │
│    - Selected: AgenticChatStrategy                               │
└─────────────────────┬────────────────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────────────────┐
│ 4. Context Assembly                                              │
│    AgentContextAssembler.assemble():                             │
│    - Fetch agent configuration                                   │
│    - Load conversation history                                   │
│    - Retrieve episodic memories                                  │
│    - Retrieve chat memories                                      │
│    - Process attachments                                         │
└─────────────────────┬────────────────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────────────────┐
│ 5. Pipeline Execution                                            │
│    AgenticChatStrategy.execute():                                │
│                                                                  │
│    a) Tool Discovery:                                            │
│       - Get base tools (search, synthesis)                       │
│       - Add agent-specific tools                                 │
│       - Build tool registry                                      │
│                                                                  │
│    b) Prompt Building:                                           │
│       - Use PromptBuilder service                                │
│       - Compose sections (identity, tools, plan, etc.)           │
│                                                                  │
│    c) Runtime Creation:                                          │
│       - Create AgentSession via AgentRuntime                     │
│       - Subscribe to events                                      │
│                                                                  │
│    d) Agent Loop:                                                │
│       - Stream events from runtime                               │
│       - Execute tools via ToolRegistry                           │
│       - Collect fragments                                        │
│       - Yield SSE events                                         │
└─────────────────────┬────────────────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────────────────┐
│ 6. Synthesis & Citations                                         │
│    - Final synthesis tool called                                 │
│    - CitationHandler extracts [1], [2] patterns                  │
│    - Map to fragments                                            │
│    - Stream citations as SSE events                              │
└─────────────────────┬────────────────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────────────────┐
│ 7. Persistence                                                   │
│    MessagePersistenceService.persist():                          │
│    - Save assistant message                                      │
│    - Store citations                                             │
│    - Save trace                                                  │
└─────────────────────┬────────────────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────────────────┐
│ 8. Cleanup                                                       │
│    - Close runtime session                                       │
│    - Dispose RequestContext                                      │
│    - End SSE stream                                              │
└──────────────────────────────────────────────────────────────────┘
```

---

## Part 3: Migration Strategy

### 3.1 Phase 1: Foundation (Week 1-2)

1. **Create new folder structure**
   - Set up `core/`, `plugins/`, `services/` directories
   - Move types to `models/`

2. **Define core abstractions**
   - Implement interfaces (no implementations yet)
   - ChatModeStrategy, RequestContext, Pipeline interfaces

3. **Create RequestContext** (replaces global state)
   - Implement per-request context with dependency injection
   - Migrate away from module-level `sessionStore`

4. **Extract Tool Registry**
   - Move from hardcoded `buildXyneTools()` to registry pattern
   - Keep existing tool implementations, add adapter layer

### 3.2 Phase 2: Pipeline Implementation (Week 3-4)

1. **Implement Context Assembler**
   - Extract context assembly logic from message-agents.ts
   - Create NormalContextAssembler, AgentContextAssembler

2. **Implement Retrieval Pipeline**
   - Create VespaRetriever, KBRetriever
   - Migrate search logic from tools to retrievers

3. **Implement Generation Pipeline**
   - Streaming generator with event-based output
   - Synthesis generator for final answer

4. **Implement Citation Handlers**
   - Extract citation logic from utils.ts
   - StandardCitationHandler, ChunkCitationHandler

### 3.3 Phase 3: Strategy Implementation (Week 5-6)

1. **Implement NormalChatStrategy**
   - Simple chat without agentic loop
   - Direct generation pipeline

2. **Implement AgenticChatStrategy**
   - Full agentic loop with tools
   - Uses pi-mono runtime

3. **Implement AttachmentChatStrategy**
   - Pre-loads attachment context
   - Can delegate to AgenticChatStrategy

4. **Implement KnowledgeBaseChatStrategy**
   - KB-specific retrieval pipeline
   - Scoped to collections/folders

### 3.4 Phase 4: Orchestrator & Migration (Week 7-8)

1. **Implement ChatOrchestrator**
   - Route to appropriate strategy
   - Handle common concerns (auth, persistence, SSE)

2. **Create API layer**
   - Hono routes with new handlers
   - Middleware for auth/validation

3. **Feature flags for gradual rollout**
   - New code behind feature flags
   - Can fall back to legacy implementation
   - can show a button in frontend to try out new code implementation


### 3.5 Phase 5: Cleanup (Week 9-10)

1. **Remove legacy code**
   - Delete old message-agents.ts once migrated
   - Remove global state from adapter.ts

2. **Documentation**
   - Architecture decision records (ADRs)
   - Developer documentation for adding new chat modes
   - Migration guide for other teams

3. **Team enablement**
   - Training sessions on new architecture
   - Code review guidelines

---

## Part 4: Key Design Decisions

### 4.1 Why Class-Based Abstractions?

While functional programming is elegant, class-based abstractions provide:

1. **Clear contracts**: Interfaces define what implementations must provide
2. **State management**: RequestContext can encapsulate per-request state cleanly
3. **Testing**: Easy to mock with jest/mockery
4. **Extensibility**: New strategies/plugins implement well-defined interfaces
5. **IDE support**: Better autocomplete and refactoring

### 4.2 Why Plugin Architecture?

```typescript
// Instead of:
function buildXyneTools() {
  return [searchGlobalTool, searchGmailTool, ...] // edit this function
}

// We have:
const registry = new ToolRegistry()
registry.register(new SearchGlobalTool())
registry.register(new SearchGmailTool())
// Plugins can register themselves
```

Benefits:
- **Discoverability**: Tools self-register
- **Scoping**: Different tools for different modes
- **Versioning**: Can have multiple versions of same tool
- **Testing**: Register mock tools in tests

### 4.3 Why Strategy Pattern for Chat Modes?

Different chat modes share common concerns (auth, persistence, streaming) but differ in:
- Context assembly
- Tool availability
- Retrieval approach
- Generation strategy

Strategy pattern allows:
- Adding new modes without touching existing code
- Composing behaviors (Attachment mode + Agentic mode)
- Clear separation between mode-specific and common logic

### 4.4 Why RequestContext Instead of Global State?

Global state (module-level variables) causes:
- Race conditions
- Memory leaks
- Testing difficulties
- Hidden dependencies

RequestContext provides:
- Isolation per request
- Clear lifecycle (create → use → dispose)
- Dependency injection
- Testability

---

## Part 5: Usage Examples

### 5.1 Adding a New Chat Mode

```typescript
// core/strategies/structured-reasoning-chat.strategy.ts

export class StructuredReasoningChatStrategy implements ChatModeStrategy {
  readonly mode = ChatMode.StructuredReasoning
  
  constructor(
    private contextAssembler: ContextAssembler,
    private reasoningPipeline: ReasoningPipeline,
    private generator: GenerationPipeline
  ) {}
  
  canHandle(request: ChatRequest): boolean {
    return request.modelConfig?.reasoning === true
  }
  
  async *execute(
    request: ChatRequest,
    context: RequestContext
  ): AsyncIterable<ChatEvent> {
    // 1. Assemble context
    const chatContext = await this.contextAssembler.assemble(context)
    
    // 2. Run structured reasoning
    const reasoningResult = await this.reasoningPipeline.reason(
      chatContext,
      context
    )
    
    // 3. Generate response with reasoning steps
    for await (const event of this.generator.generate(
      chatContext,
      reasoningResult,
      context
    )) {
      yield event
    }
  }
}

// Registration (in bootstrap)
registry.register(
  ChatMode.StructuredReasoning,
  new StructuredReasoningChatStrategy(...)
)
```

### 5.2 Adding a New Tool

```typescript
// plugins/tools/implementations/web-search.tool.ts

export class WebSearchTool implements Tool<WebSearchParams, WebSearchResult> {
  readonly name = 'webSearch'
  readonly description = 'Search the web for current information'
  readonly parameters = WebSearchParamsSchema
  
  constructor(private searchClient: WebSearchClient) {}
  
  async execute(
    params: WebSearchParams,
    context: ToolExecutionContext
  ): Promise<ToolResult<WebSearchResult>> {
    const results = await this.searchClient.search(params.query)
    
    return {
      success: true,
      data: results,
      citations: results.map(r => ({
        docId: r.url,
        title: r.title,
        url: r.url,
        app: Apps.WebSearch,
        entity: WebSearchEntity.Result
      }))
    }
  }
}

// Registration
registry.register(new WebSearchTool(searchClient))
```

### 5.3 Adding a New Retriever

```typescript
// plugins/retrievers/notion-retriever.ts

export class NotionRetriever implements Retriever {
  readonly name = 'notion'
  
  constructor(private notionClient: NotionClient) {}
  
  async *retrieve(
    query: string,
    context: RequestContext
  ): AsyncIterable<RetrievalResult> {
    const pages = await this.notionClient.search(query)
    
    yield {
      fragments: pages.map(p => ({
        id: p.id,
        content: p.content,
        source: {
          docId: p.id,
          title: p.title,
          url: p.url,
          app: Apps.Notion,
          entity: NotionEntity.Page
        },
        confidence: p.score
      })),
      source: RetrievalSource.Notion,
      confidence: Math.max(...pages.map(p => p.score))
    }
  }
}

// Registration
retrieverRegistry.register(new NotionRetriever(client))
```

### 5.4 Adding a New Citation Handler

```typescript
// plugins/citations/inline-citation-handler.ts

export class InlineCitationHandler implements CitationHandler {
  readonly pattern = /\[source:\s*([^\]]+)\]/g
  
  async *extractCitations(
    text: string,
    fragments: Fragment[],
    context: RequestContext
  ): AsyncIterable<CitationEvent> {
    for (const match of text.matchAll(this.pattern)) {
      const sourceId = match[1]
      const fragment = fragments.find(f => f.source.docId === sourceId)
      
      if (fragment) {
        yield {
          citation: {
            index: fragments.indexOf(fragment),
            item: fragment.source
          }
        }
      }
    }
  }
  
  getCitationFormat(): string {
    return 'Cite sources using [source: docId] format'
  }
}
```

---

## Part 6: Benefits Summary

### For Extensibility

| Capability | Before | After |
|-----------|--------|-------|
| Add chat mode | Edit 900+ line file | Implement 1 interface |
| Add tool | Edit buildXyneTools() | Register in registry |
| Add retriever | Edit search tools | Implement Retriever interface |
| Add citation format | Edit utils.ts | Implement CitationHandler |
| Add memory provider | Edit message-agents.ts | Implement MemoryProvider |
| Change LLM runtime | Edit provider files | Swap Runtime implementation |

### For Testing

| Aspect | Before | After |
|--------|--------|-------|
| Unit tests | Difficult (global state) | Easy (injected dependencies) |
| Mocking | Complex module mocking | Simple interface mocking |
| Integration tests | Requires full stack | Can test pipelines in isolation |
| Test coverage | Low (hard to test) | High (clear boundaries) |

### For Team Adoption

| Concern | Before | After |
|---------|--------|-------|
| Understanding | Read 1000s of lines | Read interface definitions |
| Onboarding | Weeks | Days |
| Contributing | High risk of breaking | Clear extension points |
| Documentation | In code comments | Architecture + API docs |

---

## Appendix: Interface Definitions

### Full TypeScript Interfaces

```typescript
// models/chat-request.ts
export interface ChatRequest {
  message: string
  chatId?: string
  agentId?: string
  modelConfig?: ModelConfig
  attachments?: AttachmentMetadata[]
  toolsList?: MCPConnectorConfig[]
}

export interface ModelConfig {
  model: string
  reasoning?: boolean
  webSearch?: boolean
  deepResearch?: boolean
  temperature?: number
  maxTokens?: number
}

// models/fragment.ts
export interface Fragment {
  id: string
  content: string
  source: Citation
  confidence: number
  images?: FragmentImage[]
  metadata?: Record<string, unknown>
}

// models/citation.ts
export interface Citation {
  docId: string
  title?: string
  url?: string
  app: Apps
  entity: Entity
  chunkIndex?: number
  metadata?: Record<string, unknown>
}

// models/agent-state.ts
export interface AgentState {
  turnCount: number
  plan: Plan | null
  fragments: Fragment[]
  images: FragmentImage[]
  toolHistory: ToolExecution[]
  clarifications: Clarification[]
  review: ReviewState
  memory: MemoryState
}

// core/events.ts
export type ChatEvent =
  | { type: 'start' }
  | { type: 'metadata'; data: ResponseMetadata }
  | { type: 'reasoning'; step: ReasoningStep }
  | { type: 'token'; content: string }
  | { type: 'citation'; citation: Citation }
  | { type: 'tool-call'; tool: string; args: unknown }
  | { type: 'tool-result'; tool: string; result: unknown }
  | { type: 'error'; error: ChatError }
  | { type: 'complete' }
```

---

## Conclusion

The proposed architecture transforms the current cluttered, tightly-coupled RAG system into a clean, extensible framework. Key improvements:

1. **Clear separation** between HTTP, business logic, and infrastructure
2. **Plugin architecture** for tools, retrievers, and citation handlers
3. **Strategy pattern** for chat modes enables easy extension
4. **Request-scoped context** eliminates global state issues
5. **Pipeline architecture** allows composing behaviors
6. **Strong TypeScript interfaces** at all boundaries

This architecture supports:
- Multiple chat modes (normal, agentic, attachment, KB, structured reasoning, multi-agent)
- Pluggable retrieval strategies (Vespa, KB, Notion, Confluence, etc.)
- Multiple LLM runtimes (pi-mono, JAF, future alternatives)
- Custom citation formats
- Memory providers
- Team-specific extensions

The migration is designed to be gradual with feature flags, ensuring zero downtime and allowing teams to adopt the new architecture at their own pace.
