# Frontend Agent System Documentation

## Overview
The frontend agent system provides a comprehensive interface for creating, managing, and interacting with AI agents. It includes features for integration management, file uploads, chat interfaces, and knowledge base interactions.

## File Structure & Dependencies

### Core Agent Components

#### 1. Main Agent Route
**Location:** `src/routes/_authenticated/agent.tsx`
- **Purpose:** Primary agent creation/editing interface
- **Key Features:**
  - Agent form management
  - Integration selection (Google Drive, Collections,slack,gmail,etc)
  - File/folder navigation and selection in Collections and Google Drive
  - Real-time search functionality
  - Breadcrumb navigation in Collections and Google Drive
  

**Dependencies:**
```typescript
import { GoogleDriveNavigation } from "@/components/GoogleDriveNavigation"
import { Apps, DriveEntity } from "shared/types"
import { api } from "@/api"
```

**State Management:**
- `selectedIntegrations`: Record of enabled integrations
- `selectedItemsInGoogleDrive`: Set of selected Google Drive items
- `selectedItemDetailsInGoogleDrive`: Detailed item information
- `navigationPath`: Current navigation breadcrumb trail
- `currentItems`: Items in current folder/context
- `searchResults`: Global search results
- `dropdownSearchQuery`: Current search query

#### 2. Google Drive Navigation
**Location:** `src/components/GoogleDriveNavigation.tsx`
- **Purpose:** File browser for Google Drive items
- **Key Features:**
  - Hierarchical file/folder display
  - Selection management with inheritance
  - Search result rendering
  - Loading states
  - sorting Google Drive items based on Folder and then on alphabet- **Breadcrumb navigation**: Shows current path in Google Drive hierarchy
- **Item type indicators**: Visual distinction between files and folders
- **Selection state persistence**: Maintains

**Key Functions:**
- `isItemSelectedWithInheritance()`: Checks if item is selected via parent
- `navigateToDriveFolder()`: Handles folder navigation
- `handleItemSelection()`: Manages item selection logic

#### 3. View Agent Component
**Location:** `src/components/ViewAgent.tsx`
- **Purpose:** Display existing agent details if the agent is shared or public
- **Key Features:**
  - Agent information display
  - Integration listing
  - Loading states for remote data

### Chat System Components

#### 1. ChatBox Component
**Location:** `src/components/ChatBox.tsx`
- **Purpose:** Main chat interface for agent interactions,normal chat and Knowledge base chat.
- **Key Features:**
  - Message input/output
  - File attachments (up to 5 files)
  - Real-time streaming
  - Source citations
  - Agent/model selection

**File Attachment System:**
```typescript
interface SelectedFile {
  file: File
  id: string
  preview?: string
  uploading?: boolean
  metadata?: AttachmentMetadata
  uploadError?: string
  fileType?: FileType
}
```

**Key Functions:**
- `uploadFiles()`: Handles file upload to server
- `removeFile()`: Removes files from UI and server
- `handleSendMessage()`: Sends messages with attachments
- `handleFileChange()`: Processes file selection

#### 2. Document Chat Component
**Location:** `src/components/DocumentChat.tsx`
- **Purpose:** Specialized chat for document-focused conversations in Knowledge Base and Knowledge Base interactions
- **Key Features:**
  - Automatic document context inclusion
  - Document-specific UI
  - Chunk navigation support
  - Simplified interface for document interaction

### Knowledge Management

#### 1. Knowledge Management Route
**Location:** `src/routes/_authenticated/knowledgeManagement.tsx`
- **Purpose:** Main knowledge base management interface
- **Key Features:**
  - Collection creation and management
  - File tree navigation
  - Document viewer integration
  - Chat integration for documents

**Collection Management:**
```typescript
interface Collection {
  id: string
  name: string
  description: string
  files: number
  items: FileNode[]
  isOpen: boolean
}
```

**Key Functions:**
- `handleUpload()`: Creates collections and uploads files
- `handleFileClick()`: Opens document viewer with chat
- `loadChatForDocument()`: Manages document-specific chat state

#### 2. File Upload Components
**Location:** `src/components/ClFileUpload.tsx`
- **Purpose:** Collection file upload interface
- **Key Features:**
  - Drag & drop file upload
  - File type validation
  - Upload progress tracking
  - Collection name validation

### Integration System

#### 1. Integration Routes
**Location:** `src/routes/_authenticated/integrations/`
- **Structure:**
  ```
  integrations/
  ├── index.tsx (redirects to fileupload)
  ├── fileupload/
  ├── googledrive/
  └── other integration routes
  ```

### API Integration

#### 1. API Client
**Location:** `src/api/index.ts`
- **Purpose:** Type-safe API client using Hono RPC
- **Key Endpoints:**
  - `api.search.$get()`: Global search
  - `api.search.driveitem.$post()`: Google Drive navigation
  - `api.agent.*`: Agent CRUD operations
  - `api.cl.*`: Collection management
  - `api.files.*`: File operations

### Type System

#### 1. Shared Types
**Location:** `shared/types.ts`
- **Purpose:** Common type definitions
- **Key Types:**
  - `Apps`: Integration application types
  - `DriveEntity`: Google Drive entity types
  - `FileSchema`: File structure definitions

#### 2. Component Types
Various components define their own interfaces:
```typescript
// Agent form types
interface AgentFormData {
  name: string
  description: string
  integrations: string[]
  // ...
}

// Search result types
interface SearchResult {
  id: string
  title: string
  relevance: number
  source: string
  // ...
}
```

## Data Flow

### Agent Creation Flow
1. **User opens agent form** → `agent.tsx` renders
2. **User selects integrations** → Updates `selectedIntegrations` state
3. **User navigates Google Drive** → `GoogleDriveNavigation` component handles navigation
4. **User searches items** → Global search updates `searchResults`
5. **User selects items** → Updates selection states
6. **User saves agent** → API call creates agent with selected integrations

### Chat Interaction Flow
1. **User types message** → `ChatBox` captures input
2. **User attaches files** → Files uploaded via `uploadFiles()`
3. **User sends message** → `handleSendMessage()` processes and sends
4. **Server responds** → Streaming response updates UI
5. **Citations displayed** → Source references shown with message

### Knowledge Base Flow
1. **User creates collection** → Upload modal in `knowledgeManagement.tsx`
2. **Files uploaded** → Batch upload via `ClFileUpload`
3. **User clicks document** → Opens document viewer + chat
4. **User chats about document** → `DocumentChat` provides context

## Search System

### Global Search
- **Contextual search**: Adapts based on current navigation context
- **Google Drive search**: When in drive navigation, searches drive items
- **Collection search**: When in collections, searches collection items
- **Debounced input**: 300ms delay to prevent excessive API calls

### Search Result Rendering
- **Duplicate logic issue**: Both `agent.tsx` and `GoogleDriveNavigation.tsx` render search results
- **Recommendation**: Centralize search rendering in `agent.tsx`

## State Management

### Local State Patterns
- **useState**: Component-level state for UI interactions
- **useCallback**: Memoized functions for performance
- **useEffect**: Side effects for API calls and cleanup
- **Refs**: Direct DOM access and persistent storage

### Persistent State
- **localStorage**: Used for some agent configurations
- **sessionStorage**: Temporary chat mappings
- **URL search params**: Agent ID and navigation state

## Performance Considerations

### Memory Management
- **URL.revokeObjectURL()**: Cleanup file previews to prevent memory leaks
- **AbortController**: Cancel ongoing uploads when needed
- **Debounced search**: Reduce API call frequency

### Loading States
- **Skeleton loaders**: Show during data fetching
- **Progress indicators**: File upload progress
- **Optimistic updates**: Update UI before API confirmation

## Error Handling

### User Feedback
- **Toast notifications**: Success/error messages
- **Inline validation**: Form field validation
- **Retry mechanisms**: Failed upload retry options

### Graceful Degradation
- **Fallback states**: Show alternatives when features fail
- **Error boundaries**: Prevent complete app crashes
- **Network error handling**: Offline/timeout scenarios

## Testing Considerations

### Component Testing
- **File upload flows**: Test attachment and removal
- **Search functionality**: Various search contexts
- **Navigation flows**: Breadcrumb and folder navigation
- **Integration selection**: Multi-selection scenarios

### API Integration Testing
- **Mock API responses**: Test various response scenarios
- **Error scenarios**: Network failures, invalid data
- **Loading states**: Ensure proper loading indicators

## Future Improvements

### Code Quality
- **Reduce duplication**: Centralize search result rendering
- **Type safety**: Improve TypeScript coverage
- **Component splitting**: Break down large components

### Performance
- **Virtual scrolling**: For large file lists
- **Caching strategies**: Reduce redundant API calls
- **Bundle optimization**: Code splitting for routes

### User Experience
- **Keyboard navigation**: Improve accessibility
- **Mobile responsiveness**: Better mobile experience
- **Offline support**: PWA capabilities

# Agent System Documentation

## 📋 Overview
The Xyne frontend is a sophisticated **React 19** application built with modern web technologies, featuring real-time collaboration, comprehensive document processing, and AI-powered chat capabilities. The application follows a component-based architecture with file-based routing and emphasizes type safety throughout.

## 🏗️ Technology Stack

### Core Framework
- **Frontend Framework**: React 19 with TypeScript
- **Routing**: TanStack Router (file-based routing)
- **State Management**: TanStack Query + React Context
- **UI Components**: Radix UI primitives with custom design system
- **Styling**: Tailwind CSS with custom utilities
- **Build Tool**: Vite with comprehensive configuration
- **Testing**: Vitest with React Testing Library
- **Package Manager**: Bun with circular dependency checking

### Key Dependencies
```json
{
  "react": "19.x",
  "@tanstack/react-router": "File-based routing with type safety",
  "@tanstack/react-query": "Server state management and caching",
  "@radix-ui/react-*": "Accessible UI primitives",
  "tailwindcss": "Utility-first CSS framework",
  "livekit-client": "Real-time audio/video communication",
  "pdf-lib": "PDF processing and manipulation",
  "mermaid": "Diagram rendering",
  "lucide-react": "Icon library"
}
```

## 📁 Directory Structure

```
frontend/src/
├── main.tsx                    # Application entry point with providers
├── routes/                     # File-based routing structure
│   ├── __root.tsx             # Global layout with call notifications
│   ├── _authenticated.tsx     # Authentication boundary
│   └── _authenticated/        # Protected routes
│       ├── dashboard.tsx      # Main dashboard
│       ├── chat/              # Chat-related routes
│       ├── search.tsx         # Search interface
│       ├── integrations/      # Integration management
│       └── admin/             # Admin panel routes
├── components/                 # React components
│   ├── ui/                    # Reusable UI primitives (8 components)
│   ├── workflow/              # Workflow builder system (15+ components)
│   ├── feedback/              # User feedback components (2 components)
│   ├── viewers/               # Document viewers (5 specialized viewers)
│   ├── ChatBox.tsx            # Primary chat interface
│   ├── Dashboard.tsx          # Main dashboard component
│   ├── DocumentChat.tsx       # Document-specific chat
│   └── integrations/          # Integration components
├── hooks/                      # Custom React hooks
│   ├── useChatStream.ts       # Core streaming architecture
│   ├── useChatHistory.ts      # Chat persistence
│   ├── use-toast.ts           # Notification system
│   ├── useMermaidRenderer.tsx # Diagram rendering
│   └── useScopedFind.ts       # Search functionality
├── utils/                      # Utility functions
│   ├── authFetch.ts           # Authenticated API calls
│   ├── chatUtils.tsx          # Chat helpers
│   ├── fileUtils.ts           # File operations
│   ├── streamRenderer.ts      # Streaming response handling
│   └── pdfBunCompat.ts        # PDF compatibility layer
├── types/                      # TypeScript definitions
│   ├── types.ts               # Core application types
│   ├── vespa.ts               # Search engine types
│   ├── knowledgeBase.ts       # Knowledge management types
│   └── vespa-exports.ts       # Search exports
├── store/                      # Client state management
│   └── uploadProgressStore.ts # Upload progress tracking
└── assets/                     # Static assets and resources
```

## 🔄 Application Architecture

### Provider Hierarchy
```typescript
// main.tsx
<React.StrictMode>
  <ThemeProvider>           // Global theming
    <QueryClientProvider>   // Server state management
      <RouterProvider>      // Navigation and routing
        <App />
      </RouterProvider>
    </QueryClientProvider>
  </ThemeProvider>
</React.StrictMode>
```

### Routing Structure
```
Root Layout (__root.tsx)
├── Global call notifications
├── Toaster notifications
└── Authenticated Routes (_authenticated.tsx)
    ├── Auth guard with user verification
    ├── Timezone setup
    └── Protected Routes:
        ├── /dashboard          - Main dashboard
        ├── /chat/$chatId       - Individual chat sessions
        ├── /search             - Search interface
        ├── /integrations/*     - Integration management
        └── /admin/*            - Admin panel
```

## 🔌 Core Component Architecture

### 1. Streaming Architecture (Central Hub)

**`useChatStream` Hook** - Primary orchestrator for real-time chat
```typescript
// Location: frontend/src/hooks/useChatStream.ts
interface ChatStreamHook {
  // Core Functions
  startStream: (chatId: string, messages: Message[]) => Promise<void>
  stopStream: (streamKey: string) => void
  retryMessage: (messageId: string) => Promise<void>
  
  // State Management
  getStreamState: (streamKey: string) => StreamState
  notifySubscribers: (streamKey: string, state: StreamState) => void
  
  // Content Updates
  patchResponseContent: (streamKey: string, content: string) => void
  patchReasoningContent: (streamKey: string, reasoning: string) => void
}
```

**Dependencies:**
- Server-Sent Events (SSE) for real-time communication
- TanStack Query for cache invalidation
- Toast notifications for user feedback
- Subscriber pattern for component synchronization

### 2. Primary Chat Components

**DocumentChat Component**
```typescript
// Location: frontend/src/components/DocumentChat.tsx
// Primary consumer of useChatStream
interface DocumentChatFeatures {
  realTimeStreaming: true,
  citationHandling: true,
  feedbackSystem: true,
  retryFunctionality: true,
  attachmentGallery: true,
  reasoningDisplay: true
}
```

**ChatBox Component**
```typescript
// Location: frontend/src/components/ChatBox.tsx
// Advanced chat interface with file handling
interface ChatBoxFeatures {
  fileUploadSystem: true,
  multiSourceIntegration: ["Google Drive", "Slack", "Gmail", "Calendar"],
  agentSelection: true,
  modelConfiguration: true,
  dragAndDropSupport: true,
  filePreviewGeneration: true
}
```

### 3. Document Processing System

**Supported Formats:**
- **PDF**: Full processing with PDF.js, WASM support, OCR capabilities
- **Microsoft Office**: DOCX, PPTX, Excel with preview generation
- **Text Formats**: CSV, TXT, Markdown with syntax highlighting
- **Images**: Preview generation and metadata extraction

**File Viewers:**
```typescript
frontend/src/components/viewers/
├── PDFViewer.tsx          // PDF.js integration
├── ExcelViewer.tsx        // Spreadsheet rendering
├── DocxViewer.tsx         // Word document display
├── CsvViewer.tsx          // Tabular data rendering
└── TxtViewer.tsx          // Plain text with highlighting
```

### 4. UI Component Library

**Base Components (Radix UI):**
```typescript
frontend/src/components/ui/
├── button.tsx             // Button variants and states
├── input.tsx              // Form inputs with validation
├── dropdown-menu.tsx      // Accessible dropdowns
├── dialog.tsx             // Modal dialogs
├── toast.tsx              // Notification system
├── tabs.tsx               // Tab navigation
├── scroll-area.tsx        // Custom scrollbars
└── tooltip.tsx            // Hover information
```

## 🔄 Data Flow Patterns

### 1. Real-Time Streaming Flow
```
User Input → startStream() → SSE Connection → Event Listeners → 
notifySubscribers() → Component State Updates → UI Re-render
```

### 2. Authentication Flow
```
Route Access → _authenticated.tsx → Auth Check (/api/v1/me) →
Success: Load Route | Failure: Redirect to /auth
```

### 3. File Upload Flow
```
File Selection → Validation → Preview Generation → Upload to Server →
Progress Tracking → Attachment Association → Chat Integration
```

### 4. Search & Knowledge Flow
```
User Query → Search API → Vespa Engine → Result Processing →
Citation Generation → Context Integration → Response Display
```

## 🎯 Key Architectural Patterns

### 1. Component Composition
- **Memoization**: Prevents unnecessary re-renders with `React.memo`
- **Ref Forwarding**: Imperative APIs where needed (ChatBoxRef)
- **Custom Hooks**: Reusable logic extraction (useChatStream, useChatHistory)
- **Context Providers**: Theme, document operations, authentication state

### 2. State Management Strategy
- **Server State**: TanStack Query for caching and synchronization
- **Client State**: React hooks and context for UI state
- **Streaming State**: Custom subscriber pattern with activeStreams map
- **Persistent State**: Local storage for user preferences

### 3. Type Safety Approach
- **Zod Schemas**: Runtime validation for API responses
- **Shared Types**: Common types between frontend and backend
- **Generic Components**: Type-safe reusable components
- **Route Types**: Generated route tree with type safety

### 4. Error Handling & Recovery
- **Optimistic Updates**: Immediate UI feedback with rollback capability
- **Retry Mechanisms**: Automatic retry for failed operations
- **Error Boundaries**: Component-level error isolation
- **Toast Notifications**: User-friendly error communication

## 🔧 Development Configuration

### Vite Configuration Highlights
```typescript
// vite.config.ts
export default defineConfig({
  plugins: [
    react(),                    // React with automatic JSX
    TanStackRouterVite(),      // File-based routing
    // PDF.js static file copying
    {
      name: 'copy-pdf-js-files',
      generateBundle() {
        // Copy PDF.js workers, fonts, WASM files
      }
    }
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',    // API proxying
      '/ws': 'http://localhost:8080'      // WebSocket proxying
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared')
    }
  }
})
```

### Build Process
- **Development**: Vite dev server with hot module replacement
- **Production**: Optimized build with code splitting
- **Testing**: Vitest with coverage reporting
- **Linting**: ESLint with TypeScript support
- **Dependency Analysis**: Madge for circular dependency detection

## 🌐 Integration Points

### Backend Communication
- **REST API**: Authenticated requests via authFetch utility
- **Real-time**: Server-Sent Events for streaming responses
- **WebSockets**: Call notifications and real-time updates
- **File Upload**: Multipart form data with progress tracking

### External Services
- **Google Workspace**: Drive, Gmail, Calendar integration
- **Microsoft Office**: OneDrive, Outlook integration
- **Slack**: Channel sync and bot interactions
- **LiveKit**: Real-time audio/video communication

### Cross-Platform Support
- **Responsive Design**: Mobile-first approach with Tailwind
- **Progressive Enhancement**: Works without JavaScript for core features
- **Accessibility**: ARIA compliance via Radix UI components
- **Performance**: Code splitting and lazy loading

## 📊 Performance Optimizations

### Code Splitting Strategy
- **Route-based**: Automatic splitting by TanStack Router
- **Component-based**: Lazy loading for heavy components
- **Library-based**: Separate chunks for large dependencies

### Caching Strategy
- **TanStack Query**: Intelligent server state caching
- **Browser Caching**: Static assets with long cache headers
- **Service Worker**: Offline support for core functionality

### Bundle Optimization
- **Tree Shaking**: Eliminate unused code
- **Compression**: Gzip/Brotli compression
- **Asset Optimization**: Image compression and format conversion

## 🔍 Testing Strategy

### Unit Testing
- **Component Tests**: React Testing Library for UI components
- **Hook Tests**: Custom hook testing with renderHook
- **Utility Tests**: Pure function testing with Vitest

### Integration Testing
- **Route Testing**: End-to-end route functionality
- **API Integration**: Mock API responses for testing
- **Real-time Testing**: WebSocket and SSE connection testing

## 🚀 Deployment & Production

### Build Artifacts
- **Static Assets**: Optimized HTML, CSS, JS bundles
- **Service Worker**: Offline support and caching
- **Source Maps**: Development debugging support

### Environment Configuration
- **Development**: Local development with API proxying
- **Staging**: Pre-production testing environment
- **Production**: Optimized build with CDN integration

## 📝 Development Guidelines

### Code Organization
1. **Feature-based**: Group related components, hooks, and utilities
2. **Separation of Concerns**: UI components separate from business logic
3. **Reusability**: Extract common patterns into custom hooks
4. **Type Safety**: Comprehensive TypeScript coverage

### Component Design Principles
1. **Single Responsibility**: Components focused on one concern
2. **Composability**: Small, reusable building blocks
3. **Accessibility**: ARIA compliance and keyboard navigation
4. **Performance**: Memoization and optimization where needed

### State Management Best Practices
1. **Server State**: Use TanStack Query for API data
2. **UI State**: Local component state for simple UI logic
3. **Global State**: Context providers for cross-component needs
4. **Persistent State**: Local storage for user preferences

This frontend architecture provides a robust foundation for an enterprise-grade AI-powered knowledge management platform with real-time collaboration capabilities.