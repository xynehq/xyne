# Server Agent System Documentation

## Overview
The server-side agent system provides the backend infrastructure for AI agent management, processing, and interaction. It handles agent CRUD operations, integration management, search functionality, file processing, and AI provider orchestration.

## File Structure & Dependencies

### Core Agent Components

#### 1. Agent API Routes
**Location:** `api/agent/`
- **Structure:**
  ```
  api/agent/
  ├── index.ts          # Agent CRUD operations
  ├── [id].ts           # Individual agent operations
  └── integration.ts    # Integration management
  ```

**Key Features:**
- Agent creation, retrieval, update, deletion
- Integration configuration management
- Agent sharing and permissions
- Validation and error handling

#### 2. Chat Agent API
**Location:** `api/chat/agents.ts`
- **Purpose:** Main agent conversation handler
- **Key Features:**
  - Message processing and streaming
  - Multi-provider AI integration (Bedrock, Vertex AI, OpenAI)
  - Context management and working sets
  - File attachment processing
  - Citation generation
  - JAF (Juspay Agentic Framework) integration

**Core Functions:**
```typescript
export const AgentMessageApi = async (c: Context) => {
  // Main entry point for agent conversations
  // Handles streaming and non-streaming responses
  // Manages working sets and context
}
```

**Dependencies:**
- AI providers (`ai/provider/`)
- Search system (`search/vespa.ts`)
- File processing (`fileProcessingWorker.ts`)
- Database models (`db/schema/`)

### Search System

#### 1. Main Search API
**Location:** `api/search.ts`
- **Purpose:** Unified search interface
- **Key Features:**
  - Global search across all integrations
  - Agent-specific search with context
  - Google Drive item navigation
  - Result transformation and formatting

**Key Functions:**
```typescript
// Global search endpoint
export const SearchApi = async (c: Context) => {
  // Handles search across multiple data sources
  // Returns VespaSearchResults format
}

// Google Drive navigation
export const DriveItemApi = async (c: Context) => {
  // Returns folder contents for Google Drive navigation
  // Uses getFolderItems from Vespa service
}
```

#### 2. Vespa Search Integration
**Location:** `search/vespa.ts`
- **Purpose:** Vespa search engine interface
- **Key Functions:**
  - `searchVespaAgent()`: Agent-specific search
  - `getFolderItems()`: Google Drive folder navigation
  - `GetDocumentsByDocIds()`: Retrieve specific documents
  - `getAllDocumentsForAgent()`: Get agent's document context

**Type Integration:**
```typescript
import type {
  VespaSearchResult,
  VespaSearchResults,
  VespaFile,
  FileSchema
} from "@xyne/vespa-ts/types"
```

### AI Provider System

#### 1. Provider Architecture
**Location:** `ai/provider/`
- **Structure:**
  ```
  ai/provider/
  ├── index.ts          # Provider factory and routing
  ├── bedrock.ts        # AWS Bedrock integration
  ├── vertex_ai.ts      # Google Vertex AI integration
  ├── openai.ts         # OpenAI integration
  └── anthropic.ts      # Direct Anthropic integration
  ```

#### 2. Vertex AI Provider
**Location:** `ai/provider/vertex_ai.ts`
- **Purpose:** Google Vertex AI integration with cost tracking
- **Key Features:**
  - Multi-model support (Anthropic Claude, Google models)
  - Cost calculation and tracking
  - Streaming response handling
  - Error handling and retries

**Cost Calculation:**
```typescript
const mapApiModelIdToMapperModel = (modelId: string) => {
  // Maps API model IDs to internal cost tracking models
  // Handles both Anthropic and Google model pricing
}

const converseAnthropic = async (...) => {
  // Handles Anthropic models on Vertex AI
  // Calculates costs based on input/output tokens
}
```

### Database Schema

#### 1. Agent Schema
**Location:** `db/schema/agents.ts`
- **Purpose:** Agent data model definition
- **Key Fields:**
  - Basic info (name, description, etc.)
  - Configuration (model, temperature, etc.)
  - Integration settings
  - Sharing and permissions

#### 2. User Agent Permissions
**Location:** `db/schema/userAgentPermissions.ts`
- **Purpose:** Agent sharing and access control
- **Key Features:**
  - Role-based permissions
  - Sharing management
  - Access auditing

#### 3. Integration Schemas
Various integration-specific schemas for:
- Google Drive items
- Slack messages
- Email attachments
- Knowledge base collections

### File Processing System

#### 1. File Processing Worker
**Location:** `fileProcessingWorker.ts`
- **Purpose:** Asynchronous file processing
- **Key Features:**
  - Document parsing (PDF, DOCX, etc.)
  - Text extraction and chunking
  - Metadata extraction
  - Error handling and retries

#### 2. File Upload API
**Location:** `api/files/`
- **Structure:**
  ```
  api/files/
  ├── upload.ts         # File upload handling
  ├── upload-attachment.ts  # Chat attachment uploads
  └── delete.ts         # File deletion
  ```

#### 3. Document Processing
**Location:** Various chunking files
- `pdfChunks.ts`: PDF processing
- `docxChunks.ts`: Word document processing
- `sheetChunk.ts`: Spreadsheet processing
- `pptChunks.ts`: Presentation processing

### Integration Management

#### 1. Google Drive Integration
**Location:** `integrations/googledrive/`
- **Key Features:**
  - OAuth authentication
  - File/folder browsing
  - Permission management
  - Real-time updates

#### 2. Slack Integration
**Location:** `integrations/slack/`
- **Key Features:**
  - Channel/message access
  - User authentication
  - Message formatting
  - File attachments

#### 3. Knowledge Base (Collections)
**Location:** `api/cl/` (Collections)
- **Key Features:**
  - Collection CRUD operations
  - File upload and processing
  - Search within collections
  - Permission management

## Data Flow & Architecture

### Agent Message Processing Flow
1. **Request Reception** → `api/chat/agents.ts` receives message
2. **Authentication & Validation** → User and agent validation
3. **Context Preparation** → Working set and integration context
4. **AI Provider Selection** → Based on agent configuration
5. **Search & Retrieval** → Relevant document retrieval
6. **AI Processing** → Message sent to AI provider
7. **Response Streaming** → Real-time response to client
8. **Citation Generation** → Source attribution
9. **Cost Tracking** → Usage and cost logging

### Search System Flow
1. **Search Request** → `api/search.ts` receives query
2. **Context Analysis** → Determine search scope and filters
3. **Vespa Query** → Formatted query to Vespa engine
4. **Result Processing** → Transform Vespa response
5. **Permission Filtering** → User access validation
6. **Response Formatting** → Standardized result format

### File Upload Flow
1. **Upload Request** → File received via API
2. **Validation** → File type, size, permissions
3. **Storage** → File saved to storage system
4. **Processing Queue** → Added to processing worker
5. **Document Processing** → Text extraction, chunking
6. **Indexing** → Added to Vespa search index
7. **Completion** → Status updated, client notified

## Type System & Validation

### Vespa Types
**Location:** `node_modules/@xyne/vespa-ts/`
- **Key Types:**
  - `VespaFile`: File document structure
  - `VespaSearchResults`: Search response format
  - `FileSchema`: File schema definition
  - Various entity types (DriveEntity, Apps, etc.)

### Zod Validation
**Location:** Various API files
- **Purpose:** Runtime type validation
- **Usage:** Request/response validation, data sanitization

### Database Types
**Location:** `db/schema/`
- **Generated Types:** From Drizzle ORM schema definitions
- **Relationships:** Foreign keys and joins
- **Migrations:** Schema versioning and updates

## AI Provider Integration

### Provider Selection Logic
```typescript
const getProvider = (modelId: string) => {
  // Routes to appropriate AI provider based on model
  // Supports Bedrock, Vertex AI, OpenAI, Anthropic
}
```

### Cost Tracking
Each provider implements cost calculation:
- **Input tokens**: Based on prompt and context
- **Output tokens**: Based on response length
- **Model-specific pricing**: Different rates per provider/model
- **Usage analytics**: Stored for billing and monitoring

### Streaming Implementation
All providers support streaming responses:
- **Server-Sent Events (SSE)**: Real-time response delivery
- **Incremental updates**: Partial response chunks
- **Error handling**: Graceful failure recovery
- **Stop mechanisms**: User-initiated cancellation

## Performance & Optimization

### Caching Strategies
- **Search results**: Cached frequently accessed data
- **Document chunks**: Processed content caching
- **AI responses**: Partial response caching
- **Integration data**: OAuth tokens and metadata

### Database Optimization
- **Indexes**: Optimized for common query patterns
- **Connection pooling**: Efficient database connections
- **Query optimization**: Batched and optimized queries
- **Read replicas**: For read-heavy operations

### Memory Management
- **Streaming**: Prevents large response buffering
- **Chunked processing**: Large file handling
- **Garbage collection**: Proper cleanup of resources
- **Worker processes**: Isolated processing tasks

## Security & Privacy

### Authentication
- **JWT tokens**: Secure session management
- **OAuth integration**: Third-party service authentication
- **Permission validation**: Role-based access control
- **Rate limiting**: API abuse prevention

### Data Protection
- **Encryption**: At rest and in transit
- **PII handling**: Personal information protection
- **Audit logging**: Access and modification tracking
- **Data retention**: Configurable retention policies

## Error Handling & Monitoring

### Error Categories
- **Validation errors**: Input validation failures
- **Authentication errors**: Access control issues
- **Provider errors**: AI service failures
- **System errors**: Infrastructure issues

### Monitoring
- **Health checks**: System status monitoring
- **Performance metrics**: Response times, throughput
- **Error tracking**: Exception logging and alerting
- **Usage analytics**: Feature usage and patterns

### Logging
**Location:** `logger/` directory
- **Structured logging**: JSON format for analysis
- **Log levels**: Debug, info, warn, error
- **Context preservation**: Request tracing
- **External services**: Integration with monitoring tools

## Configuration & Environment

### Environment Variables
- **AI Provider Keys**: API credentials
- **Database URLs**: Connection strings
- **Feature flags**: Experimental feature toggles
- **Rate limits**: API throttling configuration

### Configuration Files
- **Model configurations**: AI provider settings
- **Integration configs**: Third-party service setup
- **Deployment configs**: Environment-specific settings

## Testing Strategy

### Unit Testing
- **Provider functions**: AI integration testing
- **Utility functions**: Helper function validation
- **Database operations**: CRUD operation testing
- **Validation logic**: Schema validation testing

### Integration Testing
- **API endpoints**: Full request/response cycles
- **Database interactions**: Real database testing
- **External services**: Mock provider interactions
- **File processing**: End-to-end file workflows

### Performance Testing
- **Load testing**: High traffic simulation
- **Memory testing**: Resource usage monitoring
- **Concurrency testing**: Parallel request handling
- **Scalability testing**: Growth capacity validation

## Deployment & Operations

### Docker Configuration
**Location:** `Dockerfile`, `docker-compose.yml`
- **Multi-stage builds**: Optimized image layers
- **Environment separation**: Dev/staging/prod configs
- **Service dependencies**: Database, cache, etc.

### Health Monitoring
**Location:** `health/` directory
- **Service health**: Component status checking
- **Dependency health**: External service monitoring
- **Performance metrics**: System resource usage

### Scaling Considerations
- **Horizontal scaling**: Multiple server instances
- **Database sharding**: Data distribution strategies
- **Caching layers**: Redis for session/data caching
- **Load balancing**: Traffic distribution

## Future Architecture Improvements

### Microservices Migration
- **Service separation**: Agent, search, file processing
- **API gateway**: Unified entry point
- **Service mesh**: Inter-service communication
- **Event-driven**: Asynchronous processing

### Performance Enhancements
- **Caching optimization**: Intelligent cache strategies
- **Database optimization**: Query and schema improvements
- **AI provider optimization**: Response caching, batching
- **CDN integration**: Static asset delivery

### Monitoring & Observability
- **Distributed tracing**: Request flow tracking
- **Metrics aggregation**: Performance dashboards
- **Log analysis**: Automated pattern detection
- **Alerting systems**: Proactive issue detection

# Server Architecture Documentation

## 📋 Overview
The Xyne server is a sophisticated **Bun-powered backend** using the **Hono framework** with **TypeScript**, implementing an enterprise-grade AI-powered knowledge management platform. The server features multi-tenant architecture, comprehensive integrations, real-time collaboration, and advanced AI capabilities.

## 🏗️ Technology Stack

### Core Framework
- **Runtime**: Bun (JavaScript runtime)
- **Framework**: Hono (lightweight, fast web framework)
- **Language**: TypeScript with strict typing
- **Database**: PostgreSQL with Drizzle ORM
- **Search Engine**: Vespa (enterprise search platform)
- **Queue System**: pg-boss (PostgreSQL-based job queue)
- **Authentication**: JWT with Google OAuth integration

### Key Dependencies
```json
{
  "@hono/node-server": "Hono.js web framework",
  "drizzle-orm": "Type-safe SQL ORM",
  "postgres": "PostgreSQL driver",
  "pg-boss": "PostgreSQL-based job queue",
  "@xyne/vespa-ts": "Custom Vespa search client",
  "arctic": "OAuth implementation",
  "jose": "JWT token handling",
  "pino": "Structured logging",
  "zod": "Runtime type validation"
}
```

### AI & ML Integration
```json
{
  "@anthropic-ai/sdk": "Claude models via Anthropic",
  "@aws-sdk/client-bedrock-runtime": "AWS Bedrock integration", 
  "@google/generative-ai": "Gemini models",
  "openai": "OpenAI GPT models",
  "together-ai": "Together AI platform",
  "fireworks-ai": "Fireworks AI models",
  "ollama": "Local model inference"
}
```

## 📁 Directory Structure

```
server/
├── server.ts                  # Main Hono application entry point
├── sync-server.ts             # Dedicated sync server for background operations
├── worker.ts                  # Background job processing with pg-boss
├── config.ts                  # Centralized configuration management
├── api/                       # Feature-based API routes (50+ endpoints)
│   ├── auth.ts                # JWT auth, API keys, workspace management
│   ├── chat/                  # Chat system with streaming and agents
│   │   ├── chat.ts            # Main chat API and message handling
│   │   ├── agents.ts          # Agent-specific chat endpoints
│   │   ├── stream.ts          # Server-sent events for real-time chat
│   │   ├── tools.ts           # Tool integration and execution
│   │   ├── sharedChat.ts      # Chat sharing functionality
│   │   └── utils.ts           # Chat utilities and helpers
│   ├── workflow.ts            # Workflow automation and templates
│   ├── agent.ts               # AI agent management and permissions
│   ├── knowledgeBase.ts       # Document collections and file management
│   ├── search.ts              # Search API with Vespa integration
│   ├── files.ts               # File upload and processing
│   ├── admin.ts               # Admin dashboard and analytics
│   ├── oauth.ts               # OAuth provider management
│   ├── calls.ts               # LiveKit real-time communication
│   └── tuning.ts              # Model tuning and dataset management
├── db/                        # Database layer with Drizzle ORM
│   ├── client.ts              # PostgreSQL connection setup
│   ├── schema/                # Database schema definitions
│   │   ├── index.ts           # Schema exports and type definitions
│   │   ├── workspaces.ts      # Multi-tenant workspace isolation
│   │   ├── users.ts           # User accounts with RBAC
│   │   ├── chats.ts           # Chat sessions with agent integration
│   │   ├── messages.ts        # Message storage with metadata
│   │   ├── agents.ts          # AI agent configurations
│   │   ├── workflows.ts       # Workflow automation system
│   │   ├── knowledgeBase.ts   # Document collections
│   │   ├── connectors.ts      # Integration connectors
│   │   ├── oauthProviders.ts  # OAuth configurations
│   │   ├── McpConnectors.ts   # Model Context Protocol integrations
│   │   ├── apiKey.ts          # API key management
│   │   └── syncJobs.ts        # Background sync tracking
│   └── migrations/            # Database migration scripts
├── services/                  # Business logic layer
│   ├── fileProcessor.ts       # Document processing pipeline
│   ├── emailService.ts        # Email notifications
│   └── callNotifications.ts   # Real-time call notifications
├── integrations/              # External service integrations
│   ├── google/                # Google Workspace integration
│   ├── microsoft/             # Microsoft Graph integration
│   ├── slack/                 # Slack workspace sync
│   └── notion/                # Notion document import
├── ai/                        # AI framework and providers
│   ├── provider/              # AI provider implementations
│   │   ├── index.ts           # Provider orchestration
│   │   ├── bedrock.ts         # AWS Bedrock integration
│   │   ├── gemini.ts          # Google Gemini models
│   │   ├── vertex_ai.ts       # Google Vertex AI
│   │   └── openai.ts          # OpenAI GPT models
│   ├── mappers.ts             # Response format mappers
│   ├── modelConfig.ts         # Model configuration management
│   └── prompts.ts             # System prompt templates
├── search/                    # Search engine integration
│   ├── vespa.ts               # Vespa client and query building
│   └── mappers.ts             # Search result transformation
├── health/                    # System health monitoring
│   └── index.ts               # Health checks for all services
├── metrics/                   # Observability and monitoring
│   └── prometheus.ts          # Prometheus metrics collection
├── tests/                     # Test suites
│   ├── unit/                  # Unit tests
│   ├── integration/           # Integration tests
│   └── e2e/                   # End-to-end tests
└── types.ts                   # Shared type definitions
```

## 🔄 Server Architecture

### Main Entry Point (server.ts - 1700+ lines)
```typescript
// Comprehensive Hono.js application with:
interface ServerFeatures {
  authentication: "JWT + Google OAuth + API Keys",
  realTimeSupport: "WebSockets + Server-Sent Events",
  roleBasedAccess: "User | Admin | SuperAdmin",
  healthMonitoring: "PostgreSQL + Vespa checks",
  integrations: ["Google", "Microsoft", "Slack", "LiveKit"],
  aiCapabilities: "Multi-provider AI with MCP integration"
}
```

### Authentication Architecture
```typescript
// JWT-based authentication with multi-factor support
interface AuthSystem {
  jwtTokens: {
    access: "Short-lived access tokens",
    refresh: "Encrypted refresh tokens in database"
  },
  oauthProviders: ["Google Workspace", "Microsoft Graph"],
  apiKeys: "Scoped programmatic access",
  workspaceIsolation: "Multi-tenant security boundary",
  roleBasedAccess: "Granular permission system"
}
```

## 🗄️ Database Schema Architecture

### Core Entity Relationships
```
Workspaces (Multi-tenant isolation)
├── Users (Role-based access: User/Admin/SuperAdmin)
│   ├── Chats (Agent-powered conversations)
│   │   └── Messages (Rich content with tool integration)
│   ├── Agents (AI configuration with RAG capabilities)
│   ├── KnowledgeBase (Document collections)
│   └── Workflows (Automation templates)
├── Connectors (External integrations)
├── OAuthProviders (Authentication sources)
└── SyncJobs (Background operation tracking)
```

### Key Schema Features

**Multi-Tenant Architecture:**
```sql
-- Workspace isolation
workspaces: {
  id: uuid PRIMARY KEY,
  name: text NOT NULL,
  domain: text UNIQUE,  -- Domain-based tenant separation
  createdBy: text,      -- Creator email
  externalId: text      -- External system integration
}

-- User workspace association
users: {
  id: uuid PRIMARY KEY,
  workspaceId: uuid REFERENCES workspaces(id),
  role: role_enum DEFAULT 'User',  -- RBAC implementation
  email: text UNIQUE,
  encryptedRefreshToken: text,     -- Secure token storage
  timezone: text DEFAULT 'UTC'
}
```

**Agent System:**
```sql
agents: {
  id: uuid PRIMARY KEY,
  workspaceId: uuid REFERENCES workspaces(id),
  model: text,                    -- AI model selection
  ragEnabled: boolean DEFAULT false,
  webSearchEnabled: boolean DEFAULT false,
  appIntegrations: jsonb,         -- Flexible integration config
  docIds: text[],                 -- Knowledge base association
  isPublic: boolean DEFAULT false,
  creationSource: creation_source_enum
}
```

**Workflow Automation:**
```sql
workflowTemplate: {
  id: uuid PRIMARY KEY,
  workspaceId: uuid REFERENCES workspaces(id),
  name: text NOT NULL,
  description: text,
  config: jsonb                   -- Flexible workflow configuration
}

workflowStepTemplate: {
  id: uuid PRIMARY KEY,
  workflowTemplateId: uuid REFERENCES workflowTemplate(id),
  prevStepIds: uuid[],            -- Step dependency graph
  nextStepIds: uuid[],
  stepType: step_type_enum,       -- automated | manual
  estimatedTimeSeconds: integer
}
```

## 🚀 API Architecture

### Feature-Based Organization (50+ endpoints)

**Chat System:**
```typescript
// Central chat orchestration
interface ChatAPI {
  endpoints: {
    "POST /api/v1/chat/message": "Send message with streaming response",
    "GET /api/v1/chat/stream": "Server-sent events for real-time updates",
    "POST /api/v1/chat/feedback": "Message feedback (thumbs up/down)",
    "POST /api/v1/chat/retry": "Retry failed message generation",
    "GET /api/v1/chat/agents": "List available agents",
    "POST /api/v1/chat/shared": "Create shareable chat links"
  },
  coreProcessor: "MessageWithToolsApi with 32+ dependencies"
}
```

**Agent Management:**
```typescript
interface AgentAPI {
  endpoints: {
    "POST /api/v1/agent": "Create new agent",
    "PUT /api/v1/agent/:id": "Update agent configuration", 
    "DELETE /api/v1/agent/:id": "Delete agent",
    "GET /api/v1/agent/public": "List public agents",
    "POST /api/v1/agent/permission": "Grant agent access"
  },
  features: ["RAG integration", "Tool selection", "Permission management"]
}
```

**Knowledge Base:**
```typescript
interface KnowledgeBaseAPI {
  endpoints: {
    "POST /api/v1/knowledgeBase": "Create document collection",
    "GET /api/v1/knowledgeBase": "List collections",
    "POST /api/v1/knowledgeBase/files": "Upload documents",
    "DELETE /api/v1/knowledgeBase/:id/files/:fileId": "Remove documents"
  },
  processing: "Multi-format document chunking and indexing"
}
```

**Workflow System:**
```typescript
interface WorkflowAPI {
  endpoints: {
    "POST /api/v1/workflow/template": "Create workflow template",
    "POST /api/v1/workflow/execute": "Execute workflow instance",
    "GET /api/v1/workflow/executions": "List workflow runs",
    "POST /api/v1/workflow/form": "Submit workflow form data"
  },
  capabilities: ["Step orchestration", "Tool integration", "Form handling"]
}
```

## 🤖 AI Framework Architecture

### Multi-Provider Support (8 providers)
```typescript
interface AIProviders {
  primary: ["AWS Bedrock", "OpenAI", "Google Gemini"],
  secondary: ["Vertex AI", "Together AI", "Fireworks"],
  local: ["Ollama"],
  specialty: ["Anthropic Claude"]
}

// Provider Selection Logic
const providerPriority = [
  "bedrock",    // AWS Bedrock (primary)
  "openai",     // OpenAI GPT models
  "ollama",     // Local inference
  "together",   // Together AI
  "fireworks",  // Fireworks AI
  "gemini",     // Google Gemini
  "vertex"      // Google Vertex AI
];
```

### Agent Framework
```typescript
interface AgentSystem {
  reasoning: "Multi-step planning with context synthesis",
  toolIntegration: "MCP (Model Context Protocol) support",
  ragPipeline: "Vector search with citation generation", 
  contextManagement: "Dynamic context building from knowledge base",
  streaming: "Real-time response generation via SSE"
}
```

### Model Context Protocol (MCP)
```typescript
interface MCPIntegration {
  purpose: "External tool orchestration and execution",
  toolTypes: ["Search", "Calculator", "Code execution", "API calls"],
  execution: "Sandboxed tool execution with result integration",
  security: "Permission-based tool access control"
}
```

## 🔍 Search & Knowledge Architecture

### Vespa Search Engine Integration
```typescript
interface VespaIntegration {
  client: "Custom @xyne/vespa-ts wrapper",
  searchProfiles: {
    hybrid: "Dense + sparse vector search",
    semantic: "Pure vector similarity",
    keyword: "Traditional text matching"
  },
  documentTypes: ["files", "emails", "events", "users"],
  features: ["Relevance scoring", "Faceted search", "Real-time indexing"]
}
```

### Document Processing Pipeline
```typescript
interface DocumentProcessor {
  supportedFormats: ["PDF", "DOCX", "PPTX", "Excel", "Images", "Text"],
  capabilities: {
    ocr: "Optical character recognition for scanned documents",
    chunking: "Intelligent text segmentation for search",
    metadata: "File property extraction and indexing",
    imageExtraction: "Image extraction and description"
  },
  queueSystem: "Parallel processing with configurable worker pools"
}
```

### Citation System
```typescript
interface CitationGeneration {
  searchToCitation: "Convert search results to structured citations",
  appSpecificUrls: "Generate application-specific reference URLs", 
  chunkRanking: "Relevance-based chunk scoring and sorting",
  contextBuilding: "Progressive context assembly from multiple sources"
}
```

## 🔌 Integration Architecture

### Google Workspace Integration
```typescript
interface GoogleIntegration {
  services: ["Drive", "Gmail", "Calendar", "Sheets"],
  authentication: ["OAuth2", "Service Accounts"],
  capabilities: {
    drive: "File sync, permission mapping, real-time updates",
    gmail: "Email ingestion, thread processing, attachment handling",
    calendar: "Event sync, meeting integration, scheduling",
    sheets: "Spreadsheet processing, data extraction, formula parsing"
  },
  syncMechanism: "Webhook + polling hybrid with change detection"
}
```

### Microsoft Graph Integration
```typescript
interface MicrosoftIntegration {
  services: ["OneDrive", "Outlook", "Teams", "SharePoint"],
  authentication: "Azure AD OAuth with refresh token rotation",
  capabilities: {
    oneDrive: "File synchronization and permission management",
    outlook: "Email and calendar integration",
    teams: "Chat and meeting integration",
    sharePoint: "Document library sync"
  }
}
```

### Slack Integration
```typescript
interface SlackIntegration {
  modes: ["Socket Mode", "Events API"],
  capabilities: {
    channels: "Channel message ingestion and sync",
    botInteraction: "Interactive bot responses",
    fileSharing: "File upload and sharing integration",
    userMapping: "Slack to workspace user mapping"
  },
  realTime: "WebSocket-based real-time message processing"
}
```

## 🔐 Security Architecture

### Authentication & Authorization
```typescript
interface SecurityFramework {
  authentication: {
    jwt: "Access/refresh token rotation with encryption",
    oauth: "Google Workspace and Microsoft Graph integration",
    apiKeys: "Scoped programmatic access with rate limiting"
  },
  authorization: {
    rbac: "Role-based access control (User/Admin/SuperAdmin)",
    workspace: "Multi-tenant isolation and permission boundaries",
    agent: "Per-agent access control and sharing permissions"
  },
  dataProtection: {
    encryption: "At-rest and in-transit encryption",
    tokenSecurity: "Encrypted refresh token storage",
    inputValidation: "Zod schema validation for all inputs"
  }
}
```

### Multi-Tenant Security
```typescript
interface MultiTenancy {
  isolation: "Workspace-based data separation",
  domainMapping: "Automatic workspace assignment by email domain",
  permissionInheritance: "Hierarchical permission propagation",
  crossTenantSecurity: "Strict boundary enforcement"
}
```

## 🔄 Real-Time Communication

### WebSocket Architecture
```typescript
interface RealTimeSystem {
  websockets: {
    callNotifications: "LiveKit integration for audio/video calls",
    tuningUpdates: "Model tuning progress notifications",
    systemAlerts: "Admin notifications and system status"
  },
  serverSentEvents: {
    chatStreaming: "Real-time chat response streaming",
    progressUpdates: "File processing and sync progress",
    workflowExecution: "Workflow step completion notifications"
  }
}
```

### LiveKit Integration
```typescript
interface LiveKitIntegration {
  capabilities: ["Audio calls", "Video calls", "Screen sharing"],
  features: {
    roomManagement: "Dynamic room creation and management",
    participantHandling: "User join/leave notifications",
    qualityAdaptation: "Adaptive bitrate and quality control"
  },
  integration: "WebSocket notifications for call events"
}
```

## 📊 Background Processing

### Queue System (pg-boss)
```typescript
interface BackgroundJobs {
  queues: {
    FileProcessingQueue: "Document processing and chunking",
    PdfFileProcessingQueue: "Specialized PDF processing with OCR",
    SyncQueue: "External service synchronization",
    EmailQueue: "Email notification delivery"
  },
  concurrency: "Configurable worker thread pools",
  reliability: "Retry logic with exponential backoff",
  monitoring: "Job status tracking and error reporting"
}
```

### File Processing Pipeline
```typescript
interface FileProcessing {
  workflow: "Upload → Validation → Processing → Chunking → Indexing",
  parallelization: "Batch processing with Promise.all",
  errorHandling: "Comprehensive error tracking and recovery",
  statusReporting: "Real-time progress updates via WebSocket"
}
```

## 📈 Monitoring & Observability

### Health Monitoring
```typescript
interface HealthChecks {
  services: ["PostgreSQL", "Vespa", "External integrations"],
  endpoints: {
    "/health": "Overall system health",
    "/health/db": "Database connectivity",
    "/health/search": "Search engine status"
  },
  metrics: ["Response times", "Error rates", "Resource utilization"],
  alerting: "Degraded status thresholds and notifications"
}
```

### Logging & Metrics
```typescript
interface Observability {
  logging: {
    framework: "Pino structured logging",
    levels: ["debug", "info", "warn", "error"],
    context: "Request correlation and tracing"
  },
  metrics: {
    collection: "Prometheus metrics",
    tracking: ["API latency", "Database queries", "AI model usage"],
    visualization: "Grafana dashboard integration"
  }
}
```

## 🚀 Deployment & Scaling

### Production Architecture
```typescript
interface ProductionSetup {
  runtime: "Bun with optimized startup performance",
  database: "PostgreSQL with connection pooling",
  search: "Vespa cluster with replication",
  caching: "In-memory caching with Redis fallback",
  loadBalancing: "Multiple server instances with session affinity"
}
```

### Scaling Considerations
```typescript
interface ScalingStrategy {
  horizontal: "Stateless server design for easy scaling",
  database: "Read replicas and connection pooling",
  search: "Vespa cluster scaling and sharding",
  backgroundJobs: "Queue-based processing with worker scaling",
  fileStorage: "Distributed storage with CDN integration"
}
```

## 🔧 Configuration Management

### Environment-Based Configuration
```typescript
interface ConfigurationSystem {
  environments: ["development", "staging", "production"],
  secrets: "Environment variable based secret management",
  aiProviders: "Priority-based provider selection",
  integrations: "Feature flags for external service integration",
  performance: "Tunable parameters for worker threads and timeouts"
}
```

### Feature Flags
```typescript
interface FeatureFlags {
  aiProviders: "Toggle individual AI provider availability",
  integrations: "Enable/disable specific external integrations", 
  ragFeatures: "Control RAG pipeline features",
  experimentalFeatures: "Beta feature rollout control"
}
```

## 📝 Development Guidelines

### Code Organization Principles
1. **Feature-Based**: Group related API endpoints, services, and schemas
2. **Separation of Concerns**: Clear boundaries between API, business logic, and data layers
3. **Type Safety**: Comprehensive TypeScript coverage with runtime validation
4. **Error Handling**: Consistent error patterns with proper logging

### API Design Standards
1. **RESTful Design**: Standard HTTP methods and status codes
2. **Consistent Responses**: Standardized response format across all endpoints
3. **Validation**: Zod schema validation for all inputs
4. **Documentation**: Comprehensive API documentation with examples

### Database Best Practices
1. **Schema Evolution**: Migration-based schema changes
2. **Performance**: Proper indexing and query optimization
3. **Data Integrity**: Foreign key constraints and validation rules
4. **Audit Trail**: Change tracking for critical operations

This server architecture provides a robust, scalable foundation for an enterprise-grade AI-powered knowledge management platform with comprehensive integration capabilities and real-time collaboration features.