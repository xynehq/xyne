# MCP Dedicated Agents Architecture Design

## Executive Summary

This document provides a comprehensive analysis and design for transforming MCP (Model Context Protocol) connectors from per-query client creation to a persistent, dedicated agent architecture with intelligent tool orchestration.

**Current Problem**: MCP clients are created and destroyed on every user query, causing inefficiency, latency, and lack of intelligent tool routing.

**Proposed Solution**: Persistent MCP connector agents with universal orchestration tools that intelligently select, sequence, and execute connector tools based on user queries.

---

## Table of Contents

1. [Problem Analysis](#1-problem-analysis)
2. [Current Architecture Review](#2-current-architecture-review)
3. [Proposed Architecture](#3-proposed-architecture)
4. [Core Components](#4-core-components)
5. [Schemas & Data Structures](#5-schemas--data-structures)
6. [Implementation Plan](#6-implementation-plan)
7. [Migration Strategy](#7-migration-strategy)
8. [Examples](#8-examples)

---

## 1. Problem Analysis

### 1.1 Current Implementation Issues

#### Inefficient Client Creation (server/api/chat/agents.ts:1428-1546)

```typescript
// PROBLEM: Creating MCP clients on EVERY query
const mcpClients: Client[] = []
try {
  for (const [connectorId, info] of Object.entries(finalTools)) {
    const client = new Client(/* ... */)
    await client.connect(transport)
    mcpClients.push(client)
    // ... use client
  }
} finally {
  // Cleanup on every request
  for (const client of mcpClients) {
    await client.close()
  }
}
```

**Issues**:
- ❌ New client connection overhead on every query (network latency, authentication)
- ❌ No connection pooling or reuse
- ❌ Memory allocation/deallocation churn
- ❌ Potential connection leaks if cleanup fails
- ❌ No persistent state between queries

#### No Intelligent Tool Orchestration

```typescript
// CURRENT: Each tool is executed independently
buildMCPJAFTools(finalTools) // Returns flat array of tools
// Main agent sees all MCP tools as independent options
// No connector-level intelligence or planning
```

**Issues**:
- ❌ No understanding of which tools belong together (same connector)
- ❌ No connector-specific planning or reasoning
- ❌ No tool sequencing logic (which tools to call in what order)
- ❌ No result synthesis across related tools
- ❌ Main agent overwhelmed with too many tool choices

#### Lack of Connector Context

**Issues**:
- ❌ No connector-level system prompt describing capabilities
- ❌ No connector metadata (rate limits, costs, latencies)
- ❌ No connector-specific error handling
- ❌ No connector health monitoring

### 1.2 Requirements from jaf-unified-agentic-plan.md

> "We have to add mcp connectors as dedicated agents per mcp connection"

> "When creating connectors we must create an agent and have a universal tool that takes input query and states what all functions/tools it has are relevant and how and in what order the tools must be used"

**Key Requirements**:
1. ✅ Dedicated agent per MCP connector (not per query)
2. ✅ Universal orchestrator tool per connector
3. ✅ Tool relevance analysis
4. ✅ Tool sequencing logic
5. ✅ Well-defined input/output schemas

---

## 2. Current Architecture Review

### 2.1 Database Schema

#### Connectors Table (server/db/schema/connectors.ts)

```typescript
export const connectors = pgTable("connectors", {
  id: serial("id").notNull().primaryKey(),
  workspaceId: integer("workspace_id").notNull(),
  userId: integer("user_id").notNull(),
  externalId: text("external_id").unique().notNull(),
  name: text("name").notNull(),
  type: connectorTypeEnum("type").notNull(), // MCP, OAuth, ServiceAccount
  authType: authTypeEnum("auth_type").notNull(),
  app: appTypeEnum("app").notNull(), // CustomMCP, Slack, Gmail, etc.
  config: jsonb("config").notNull(), // Contains MCP connection details
  credentials: encryptedText("credentials"),
  status: statusEnum("status").notNull(),
  state: jsonb("state").notNull().default('{}'),
  // ...
})
```

**MCP-Specific Config Structure**:
```json
{
  "url": "https://mcp-server.example.com",
  "mode": "sse" | "streamable-http",
  "headers": {
    "Authorization": "Bearer ..."
  }
}
// OR for stdio:
{
  "command": "node",
  "args": ["./mcp-server.js"],
  "env": {...}
}
```

#### Tools Table (server/db/schema/McpConnectors.ts)

```typescript
export const tools = pgTable("tools", {
  id: serial("id").notNull().primaryKey(),
  workspaceId: integer("workspace_id").notNull(),
  connectorId: integer("connector_id").notNull(),
  externalId: text("external_id").unique(),
  toolName: text("tool_name").notNull(),
  toolSchema: text("tool_schema").notNull(), // JSON schema
  description: text("description"),
  enabled: boolean("enabled").notNull().default(false),
  // ...
})
```

**Unique Constraint**: `(workspaceId, connectorId, toolName)`

### 2.2 Current MCP Integration Flow

```
User Query
    ↓
MessageWithToolsApi
    ↓
[Create MCP Clients] ← INEFFICIENT: Per-query creation
    ↓
buildMCPJAFTools() → Flat tool array
    ↓
Main JAF Agent (all tools available)
    ↓
Tool Execution → client.callTool()
    ↓
[Cleanup MCP Clients]
```

### 2.3 Current Tool Building (server/api/chat/jaf-adapter.ts)

```typescript
export function buildMCPJAFTools(finalTools: FinalToolsList): Tool[] {
  const tools: Tool[] = []
  for (const [connectorId, info] of Object.entries(finalTools)) {
    for (const t of info.tools) {
      tools.push({
        schema: {
          name: t.toolName,
          description: t.description || `MCP tool from ${connectorId}`,
          parameters: mcpToolSchemaStringToZodObject(t.toolSchema)
        },
        async execute(args, context) {
          const mcpResp = await info.client.callTool({
            name: t.toolName,
            arguments: args
          })
          // ... format response
        }
      })
    }
  }
  return tools
}
```

**Problems**:
- Flat structure loses connector grouping
- No connector-level intelligence
- No tool orchestration

---

## 3. Proposed Architecture

### 3.1 High-Level Design

```
┌─────────────────────────────────────────────────────────────────┐
│ MCP CONNECTOR AGENT REGISTRY (Singleton)                        │
│                                                                  │
│  ┌────────────────────┐  ┌────────────────────┐                │
│  │ MCP Connector      │  │ MCP Connector      │                │
│  │ Agent: Slack       │  │ Agent: GitHub      │  ...           │
│  │                    │  │                    │                │
│  │ - Client (SSE)     │  │ - Client (Stdio)   │                │
│  │ - Tools: 15        │  │ - Tools: 51        │                │
│  │ - Status: Active   │  │ - Status: Active   │                │
│  └────────────────────┘  └────────────────────┘                │
└─────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────┐
│ MAIN AGENT (User Query)                                         │
│                                                                  │
│ Available Tools:                                                 │
│  - Internal tools (search_gmail, search_slack, etc.)            │
│  - query_mcp_connector (Universal MCP Orchestrator)             │
│                                                                  │
│ Tool: query_mcp_connector                                       │
│   Input: { connectorId, query, context }                        │
│   ↓                                                              │
│   Delegates to → MCP Connector Agent                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────┐
│ MCP CONNECTOR AGENT (e.g., GitHub Agent)                        │
│                                                                  │
│ System Prompt:                                                   │
│ "You are a GitHub MCP connector agent with 51 tools:            │
│  - create_or_update_file, create_issue, search_repositories..."│
│                                                                  │
│ Task: Analyze query and determine:                              │
│  1. Which tools are relevant                                    │
│  2. What order to execute them                                  │
│  3. How to combine results                                      │
│                                                                  │
│ Execution:                                                       │
│  ┌─────────────────────────────────────────┐                   │
│  │ Task: "Find all open issues assigned    │                   │
│  │        to user X in repo Y"              │                   │
│  │                                          │                   │
│  │ Plan:                                    │                   │
│  │  1. search_repositories → Find repo ID   │                   │
│  │  2. list_issues → Get issues             │                   │
│  │  3. filter by assignee → User X          │                   │
│  │                                          │                   │
│  │ Execute sequentially ✓                   │                   │
│  │ Synthesize result ✓                      │                   │
│  └─────────────────────────────────────────┘                   │
│                                                                  │
│ Output: Structured result with contexts                         │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Key Principles

1. **Persistent Agents**: One agent per MCP connector, lifecycle tied to connector status
2. **Hierarchical Tool Structure**: Main agent → Connector agents → Individual tools
3. **Intelligent Orchestration**: Connector agents analyze queries and plan tool execution
4. **Connection Pooling**: MCP clients persist and reuse connections
5. **Scoped Reasoning**: Each connector agent reasons about its own tools

---

## 4. Core Components

### 4.1 MCP Connector Agent Registry

**Purpose**: Singleton manager for all MCP connector agents

**Responsibilities**:
- Initialize agents on server startup
- Create agent when connector is activated
- Destroy agent when connector is deactivated
- Health monitoring and reconnection
- Connection pooling

**File**: `server/api/chat/mcp-agent-registry.ts`

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Agent as JAFAgent } from "@xynehq/jaf"
import type { MCPConnectorAgent, MCPAgentContext } from "./mcp-agent-schemas"

/**
 * MCP Connector Agent Registry
 * Singleton that manages persistent MCP connector agents
 */
class MCPAgentRegistry {
  private static instance: MCPAgentRegistry
  private agents: Map<string, MCPConnectorAgent> = new Map()
  private clients: Map<string, Client> = new Map()
  private initPromises: Map<string, Promise<void>> = new Map()

  private constructor() {}

  static getInstance(): MCPAgentRegistry {
    if (!MCPAgentRegistry.instance) {
      MCPAgentRegistry.instance = new MCPAgentRegistry()
    }
    return MCPAgentRegistry.instance
  }

  /**
   * Get or create MCP connector agent
   */
  async getAgent(
    connectorId: string,
    workspaceId: string
  ): Promise<MCPConnectorAgent | null> {
    const key = `${workspaceId}:${connectorId}`

    // Return existing agent
    if (this.agents.has(key)) {
      return this.agents.get(key)!
    }

    // Wait for initialization if in progress
    if (this.initPromises.has(key)) {
      await this.initPromises.get(key)
      return this.agents.get(key) || null
    }

    // Initialize new agent
    const initPromise = this.initializeAgent(connectorId, workspaceId, key)
    this.initPromises.set(key, initPromise)

    try {
      await initPromise
      return this.agents.get(key) || null
    } finally {
      this.initPromises.delete(key)
    }
  }

  /**
   * Initialize MCP connector agent
   */
  private async initializeAgent(
    connectorId: string,
    workspaceId: string,
    key: string
  ): Promise<void> {
    try {
      // Fetch connector and tools from database
      const connector = await db.query.connectors.findFirst({
        where: and(
          eq(connectors.externalId, connectorId),
          eq(connectors.workspaceId, workspaceId),
          eq(connectors.status, ConnectorStatus.Connected)
        )
      })

      if (!connector) {
        Logger.warn(`Connector ${connectorId} not found or not connected`)
        return
      }

      const connectorTools = await db.query.tools.findMany({
        where: and(
          eq(tools.connectorId, connector.id),
          eq(tools.enabled, true)
        )
      })

      // Create MCP client
      const client = await this.createMCPClient(connector)
      this.clients.set(key, client)

      // Build JAF agent
      const jafAgent = await this.buildJAFAgent(
        connector,
        connectorTools,
        client
      )

      // Create connector agent metadata
      const connectorAgent: MCPConnectorAgent = {
        connectorId: connector.externalId,
        workspaceId: connector.workspaceExternalId,
        name: connector.name,
        app: connector.app,
        jafAgent,
        client,
        tools: connectorTools.map(t => ({
          name: t.toolName,
          schema: t.toolSchema,
          description: t.description || "",
          enabled: t.enabled
        })),
        status: "active",
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        callCount: 0,
        errorCount: 0
      }

      this.agents.set(key, connectorAgent)
      Logger.info(`Initialized MCP connector agent: ${key}`)
    } catch (error) {
      Logger.error(error, `Failed to initialize MCP agent: ${key}`)
      throw error
    }
  }

  /**
   * Create MCP client based on connector config
   */
  private async createMCPClient(connector: SelectConnector): Promise<Client> {
    const config = connector.config as any
    const client = new Client(
      {
        name: `xyne-${connector.name}`,
        version: "1.0.0"
      },
      {
        capabilities: {
          tools: {}
        }
      }
    )

    let transport

    if (config.command) {
      // Stdio transport
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: config.env || {}
      })
    } else if (config.url) {
      const mode = config.mode || "sse"
      
      if (mode === "streamable-http") {
        transport = new StreamableHTTPClientTransport({
          url: config.url,
          headers: config.headers || {}
        })
      } else {
        // SSE transport (default)
        transport = new SSEClientTransport({
          url: config.url,
          headers: config.headers || {}
        })
      }
    } else {
      throw new Error(`Invalid MCP connector config for ${connector.name}`)
    }

    await client.connect(transport)
    Logger.info(`Connected MCP client: ${connector.name}`)

    return client
  }

  /**
   * Build JAF agent for MCP connector
   */
  private async buildJAFAgent(
    connector: SelectConnector,
    connectorTools: SelectTool[],
    client: Client
  ): Promise<JAFAgent<MCPAgentContext, string>> {
    // Build system prompt
    const systemPrompt = this.buildConnectorAgentPrompt(
      connector,
      connectorTools
    )

    // Convert tools to JAF tools
    const jafTools = connectorTools.map(tool => ({
      schema: {
        name: tool.toolName,
        description: tool.description || `Tool: ${tool.toolName}`,
        parameters: mcpToolSchemaStringToZodObject(tool.toolSchema)
      },
      async execute(args: any, context: MCPAgentContext) {
        try {
          const result = await client.callTool({
            name: tool.toolName,
            arguments: args
          })

          // Extract content from MCP response
          let content = ""
          let contexts: MinimalAgentFragment[] = []

          if (result?.content?.[0]?.text) {
            content = result.content[0].text
          }

          if (result?.metadata?.contexts) {
            contexts = result.metadata.contexts as MinimalAgentFragment[]
          }

          return ToolResponse.success(content, {
            toolName: tool.toolName,
            contexts,
            connectorId: connector.externalId
          })
        } catch (error) {
          return ToolResponse.error(
            "TOOL_EXECUTION_FAILED",
            `Tool ${tool.toolName} failed: ${error.message}`,
            { connectorId: connector.externalId }
          )
        }
      }
    }))

    return {
      name: `mcp-${connector.externalId}`,
      instructions: systemPrompt,
      tools: jafTools,
      modelConfig: { name: config.defaultBestModel }
    }
  }

  /**
   * Build system prompt for connector agent
   */
  private buildConnectorAgentPrompt(
    connector: SelectConnector,
    tools: SelectTool[]
  ): string {
    const toolList = tools
      .map((t, i) => `${i + 1}. ${t.toolName}: ${t.description || "No description"}`)
      .join("\n")

    return `You are a ${connector.name} MCP connector agent.

Your role is to analyze user queries and intelligently orchestrate the available tools to fulfill requests.

Available Tools (${tools.length}):
${toolList}

Your responsibilities:
1. ANALYZE the user query to understand the intent
2. IDENTIFY which tools are relevant to the query
3. DETERMINE the optimal sequence to call tools
4. EXECUTE tools in the correct order
5. SYNTHESIZE results into a coherent response

Guidelines:
- Call tools sequentially when one depends on another's output
- Call tools in parallel when they are independent
- Combine results intelligently
- Handle errors gracefully
- Provide clear, actionable responses

Return your final answer with:
- Summary of what was done
- Key findings or results
- Any relevant contexts or sources`
  }

  /**
   * Remove agent (when connector is deactivated)
   */
  async removeAgent(connectorId: string, workspaceId: string): Promise<void> {
    const key = `${workspaceId}:${connectorId}`
    
    const client = this.clients.get(key)
    if (client) {
      try {
        await client.close()
      } catch (error) {
        Logger.error(error, `Failed to close MCP client: ${key}`)
      }
      this.clients.delete(key)
    }

    this.agents.delete(key)
    Logger.info(`Removed MCP connector agent: ${key}`)
  }

  /**
   * Update agent usage metrics
   */
  updateAgentMetrics(
    connectorId: string,
    workspaceId: string,
    success: boolean
  ): void {
    const key = `${workspaceId}:${connectorId}`
    const agent = this.agents.get(key)
    
    if (agent) {
      agent.lastUsedAt = Date.now()
      agent.callCount++
      if (!success) {
        agent.errorCount++
      }
    }
  }

  /**
   * Health check for all agents
   */
  async healthCheck(): Promise<void> {
    for (const [key, agent] of this.agents.entries()) {
      try {
        // Simple ping to check connection
        await agent.client.listTools()
        agent.status = "active"
      } catch (error) {
        Logger.error(error, `Health check failed for agent: ${key}`)
        agent.status = "error"
        agent.errorCount++
      }
    }
  }

  /**
   * Get all active agents
   */
  getAllAgents(): MCPConnectorAgent[] {
    return Array.from(this.agents.values())
  }
}

// Export singleton instance
export const mcpAgentRegistry = MCPAgentRegistry.getInstance()
```

### 4.2 Universal MCP Orchestrator Tool

**Purpose**: Single tool that delegates to MCP connector agents

**File**: `server/api/chat/mcp-orchestrator-tool.ts`

```typescript
import { z } from "zod"
import type { Tool } from "@xynehq/jaf"
import { ToolResponse } from "@xynehq/jaf"
import { mcpAgentRegistry } from "./mcp-agent-registry"
import type { AgentRunContext } from "./agent-schemas"
import { runStream, type JAFRunConfig } from "@xynehq/jaf"

/**
 * Universal MCP Orchestrator Tool
 * 
 * This tool serves as the gateway to all MCP connector agents.
 * It delegates user queries to the appropriate connector agent,
 * which then intelligently orchestrates its tools.
 */
export const queryMCPConnectorTool: Tool<unknown, AgentRunContext> = {
  schema: {
    name: "query_mcp_connector",
    description: `Execute a query using a specific MCP connector agent. This tool delegates to a dedicated connector agent that will analyze the query, select relevant tools, determine execution order, and synthesize results. Use this when you need capabilities from external MCP connectors like GitHub, Linear, Jira, custom APIs, etc.`,
    parameters: z.object({
      connectorId: z.string().describe("External ID of the MCP connector to use"),
      query: z.string().describe("Detailed query to execute via the connector. Be specific about what information you need and any constraints."),
      context: z.string().optional().describe("Additional context from previous interactions that might help the connector agent"),
      maxTools: z.number().optional().default(10).describe("Maximum number of tools the connector agent can use")
    })
  },

  async execute(args, mainContext) {
    const { connectorId, query, context, maxTools } = args as {
      connectorId: string
      query: string
      context?: string
      maxTools?: number
    }

    try {
      // Get or create connector agent
      const connectorAgent = await mcpAgentRegistry.getAgent(
        connectorId,
        mainContext.user.workspaceId
      )

      if (!connectorAgent) {
        return ToolResponse.error(
          "CONNECTOR_NOT_FOUND",
          `MCP connector ${connectorId} not found or not active`
        )
      }

      // Build context for connector agent
      const agentContext: MCPAgentContext = {
        query,
        additionalContext: context || "",
        userEmail: mainContext.user.email,
        workspaceId: mainContext.user.workspaceId,
        maxTools: maxTools || 10,
        gatheredContexts: []
      }

      // Prepare messages for connector agent
      const messages = [
        {
          role: "user" as const,
          content: context
            ? `Context: ${context}\n\nQuery: ${query}`
            : query
        }
      ]

      // Configure JAF run for connector agent
      const runConfig: JAFRunConfig<MCPAgentContext> = {
        agentRegistry: new Map([[connectorAgent.jafAgent.name, connectorAgent.jafAgent]]),
        modelProvider: makeXyneJAFProvider<MCPAgentContext>(),
        maxTurns: Math.min(maxTools, 10),
        modelOverride: config.defaultBestModel,
        
        // Hook to collect contexts
        onAfterToolExecution: async (toolName, result, hookContext) => {
          const { state } = hookContext
          
          if (result?.metadata?.contexts) {
            state.context.gatheredContexts.push(...result.metadata.contexts)
          }
          
          return result?.data || null
        }
      }

      // Initialize run state
      const runState = {
        runId: generateRunId(),
        traceId: generateTraceId(),
        messages,
        currentAgentName: connectorAgent.jafAgent.name,
        context: agentContext,
        turnCount: 0
      }

      // Execute connector agent
      let finalAnswer = ""
      const toolsUsed: string[] = []
      const contexts: MinimalAgentFragment[] = []

      for await (const evt of runStream<MCPAgentContext, string>(runState, runConfig)) {
        switch (evt.type) {
          case "tool_call_end":
            toolsUsed.push(evt.data.toolName)
            break

          case "assistant_message":
            const content = getTextContent(evt.data.message.content)
            if (content) {
              finalAnswer += content
            }
            break

          case "final_output":
            if (typeof evt.data.output === "string") {
              finalAnswer = evt.data.output
            }
            break

          case "run_end":
            if (evt.data.outcome?.status === "error") {
              throw new Error(
                evt.data.outcome.error?._tag || "Connector agent execution failed"
              )
            }
            break
        }
      }

      // Collect gathered contexts
      contexts.push(...agentContext.gatheredContexts)

      // Update agent metrics
      mcpAgentRegistry.updateAgentMetrics(
        connectorId,
        mainContext.user.workspaceId,
        true
      )

      // Return structured response
      const summary = `MCP Connector: ${connectorAgent.name}
Tools Used: ${toolsUsed.join(", ") || "None"}
Contexts Found: ${contexts.length}

${finalAnswer}`

      return ToolResponse.success(summary, {
        connectorId,
        connectorName: connectorAgent.name,
        toolsUsed,
        contexts,
        answer: finalAnswer
      })

    } catch (error) {
      mcpAgentRegistry.updateAgentMetrics(
        connectorId,
        mainContext.user.workspaceId,
        false
      )

      return ToolResponse.error(
        "MCP_ORCHESTRATION_FAILED",
        `Failed to execute MCP connector query: ${error.message}`,
        { connectorId }
      )
    }
  }
}
```

### 4.3 Integration with Main Agent

**File**: `server/api/chat/message-agents.ts` (modifications)

```typescript
// Add to tool building section
function buildAllTools(context: AgentRunContext): Tool<unknown, AgentRunContext>[] {
  const allTools: Tool<unknown, AgentRunContext>[] = []

  // 1. Internal JAF tools
  allTools.push(...buildInternalJAFTools())

  // 2. Universal MCP orchestrator tool
  allTools.push(queryMCPConnectorTool)

  // NOTE: Individual MCP tools are NO LONGER directly exposed to main agent
  // They are only accessible via the MCP connector agents

  return allTools
}
```

---

## 5. Schemas & Data Structures

### 5.1 MCP Agent Schemas

**File**: `server/api/chat/mcp-agent-schemas.ts`

```typescript
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Agent as JAFAgent } from "@xynehq/jaf"
import type { MinimalAgentFragment } from "./types"

/**
 * MCP Tool Metadata
 */
export interface MCPToolMetadata {
  name: string
  schema: string | null
  description: string
  enabled: boolean
}

/**
 * MCP Connector Agent
 * Represents a persistent agent for an MCP connector
 */
export interface MCPConnectorAgent {
  connectorId: string
  workspaceId: string
  name: string
  app: string
  jafAgent: JAFAgent<MCPAgentContext, string>
  client: Client
  tools: MCPToolMetadata[]
  status: "active" | "error" | "connecting"
  createdAt: number
  lastUsedAt: number
  callCount: number
  errorCount: number
}

/**
 * MCP Agent Context
 * Context passed to MCP connector agents during execution
 */
export interface MCPAgentContext {
  query: string
  additionalContext: string
  userEmail: string
  workspaceId: string
  maxTools: number
  gatheredContexts: MinimalAgentFragment[]
}
```

### 5.2 Tool Input/Output Schemas

**Universal Orchestrator Tool Input**:
```typescript
{
  connectorId: string        // "github-mcp-connector-123"
  query: string             // "Find all open issues assigned to @octocat in repo xyne"
  context?: string          // "Previous search found 15 repos"
  maxTools?: number         // 10 (default)
}
```

**Universal Orchestrator Tool Output**:
```typescript
{
  status: "success" | "error"
  data: string              // Synthesized answer from connector agent
  metadata: {
    connectorId: string
    connectorName: string
    toolsUsed: string[]     // ["search_repositories", "list_issues"]
    contexts: MinimalAgentFragment[]
    answer: string
  }
}
```

### 5.3 Database Schema Updates

**Add to connectors table** (Optional - for metrics):
```typescript
export const connectors = pgTable("connectors", {
  // ... existing fields
  
  // MCP agent metrics (optional)
  agentCallCount: integer("agent_call_count").default(0),
  agentErrorCount: integer("agent_error_count").default(0),
  agentLastUsedAt: timestamp("agent_last_used_at", { withTimezone: true }),
})
```

---

## 6. Implementation Plan

### 6.1 Phase 1: Core Infrastructure (Week 1)

**Files to Create**:
- [ ] `server/api/chat/mcp-agent-schemas.ts` - Type definitions
- [ ] `server/api/chat/mcp-agent-registry.ts` - Singleton registry
- [ ] `server/api/chat/mcp-orchestrator-tool.ts` - Universal tool

**Tasks**:
1. Implement MCPAgentRegistry singleton
2. Implement agent initialization logic
3. Implement MCP client creation (SSE, Stdio, Streamable HTTP)
4. Implement agent lifecycle management
5. Add health check mechanism

**Testing**:
- Unit tests for registry initialization
- Unit tests for agent creation
- Integration tests for MCP client connections

### 6.2 Phase 2: Tool Integration (Week 2)

**Files to Modify**:
- [ ] `server/api/chat/message-agents.ts` - Add orchestrator tool
- [ ] `server/api/chat/jaf-adapter.ts` - Update tool building (optional deprecation)

**Tasks**:
1. Create queryMCPConnectorTool
2. Integrate with main agent tool list
3. Implement connector agent execution flow
4. Add context gathering from connector agents
5. Add metrics tracking

**Testing**:
- Integration tests for tool execution
- Test query delegation to connector agents
- Test context aggregation

### 6.3 Phase 3: Server Startup Integration (Week 3)

**Files to Modify**:
- [ ] `server/server.ts` - Initialize registry on startup
- [ ] `server/api/connector.ts` - Hook agent lifecycle to connector events

**Tasks**:
1. Initialize MCPAgentRegistry on server startup
2. Load all active connectors
3. Create agents for connected MCP connectors
4. Add connector event hooks:
   - On connector activated → Create agent
   - On connector deactivated → Destroy agent
   - On connector updated → Refresh agent
5. Add periodic health checks (every 5 minutes)

**Testing**:
- Test server startup with multiple connectors
- Test connector lifecycle events
- Test health check recovery

### 6.4 Phase 4: Migration from Old Flow (Week 4)

**Strategy**: Gradual migration with feature flag

**Files to Modify**:
- [ ] `server/api/chat/agents.ts` - Add feature flag
- [ ] `server/config.ts` - Add config option

**Tasks**:
1. Add `USE_MCP_AGENTS` feature flag
2. Keep old flow for backward compatibility
3. Add metrics comparison (latency, cost, accuracy)
4. Monitor error rates
5. Gradual rollout: 10% → 50% → 100%

**Migration Path**:
```typescript
// In server/api/chat/agents.ts
const useMCPAgents = config.features.USE_MCP_AGENTS

if (useMCPAgents) {
  // New flow: Use MCPAgentRegistry
  // No per-query client creation
  tools.push(queryMCPConnectorTool)
} else {
  // Old flow: Create clients per query
  const mcpClients = []
  // ... existing logic
}
```

### 6.5 Phase 5: Optimization & Monitoring (Week 5)

**Tasks**:
1. Add comprehensive logging
2. Add OpenTelemetry tracing
3. Implement connection pooling optimizations
4. Add rate limiting per connector
5. Add cost tracking per connector
6. Dashboard for connector health

**Metrics to Track**:
- Agent initialization time
- Average query latency per connector
- Tool execution time
- Error rates per connector
- Connection reuse rate
- Memory usage

---

## 7. Migration Strategy

### 7.1 Backward Compatibility

**Principle**: Old flow continues to work during migration

**Implementation**:
```typescript
// Feature flag in config
export default {
  features: {
    USE_MCP_AGENTS: process.env.USE_MCP_AGENTS === 'true'
  }
}

// In message handler
if (config.features.USE_MCP_AGENTS) {
  // New: Persistent agents
  await mcpAgentRegistry.getAgent(connectorId, workspaceId)
} else {
  // Old: Per-query clients
  const client = new Client(/* ... */)
  await client.connect(transport)
}
```

### 7.2 Rollout Plan

**Stage 1: Internal Testing (10% traffic, Week 1)**
- Enable for internal workspace only
- Monitor metrics closely
- Validate all connector types (SSE, Stdio, Streamable HTTP)

**Stage 2: Beta Testing (25% traffic, Week 2)**
- Expand to select beta customers
- Gather feedback
- Fix issues

**Stage 3: Gradual Expansion (50% traffic, Week 3)**
- Monitor error rates
- Compare performance metrics
- Adjust as needed

**Stage 4: Full Rollout (100% traffic, Week 4)**
- Complete migration
- Deprecate old flow
- Remove feature flag (Week 6)

### 7.3 Rollback Plan

**Trigger Conditions**:
- Error rate > 5%
- Latency increase > 50%
- Critical bugs affecting users

**Rollback Steps**:
1. Set `USE_MCP_AGENTS=false` in environment
2. Restart servers
3. Old flow takes over immediately
4. Debug issues in staging
5. Re-deploy fixed version

---

## 8. Examples

### 8.1 Example: GitHub Connector Query

**User Query**: "Find all open issues assigned to @octocat in the xyne repository"

**Main Agent Execution**:
```typescript
// Main agent sees query needs GitHub data
// Calls universal orchestrator tool

await queryMCPConnectorTool.execute({
  connectorId: "github-mcp-connector-123",
  query: "Find all open issues assigned to @octocat in the xyne repository",
  maxTools: 10
}, mainContext)
```

**GitHub Connector Agent Reasoning**:
```
Task Analysis:
1. Need to search for repository "xyne"
2. Then list issues in that repository
3. Filter by assignee "@octocat"
4. Filter by status "open"

Tool Sequence:
1. search_repositories(query: "xyne")
   → Result: Found repo ID: "xynehq/xyne"
   
2. list_issues(repo: "xynehq/xyne", state: "open", assignee: "octocat")
   → Result: 7 open issues

Synthesis:
Found 7 open issues assigned to @octocat:
1. Issue #123: "Add MCP support"
2. Issue #124: "Fix authentication bug"
...
```

**Final Response to User**:
```
I found 7 open issues assigned to @octocat in the xyne repository:

1. **Add MCP support** (#123)
   - Created 2 days ago
   - Labels: enhancement, backend
   
2. **Fix authentication bug** (#124)
   - Created 1 week ago
   - Labels: bug, security
   
[Full list with citations]
```

### 8.2 Example: Multiple Connector Query

**User Query**: "What Linear tasks and GitHub issues are assigned to me this week?"

**Main Agent Execution**:
```typescript
// Main agent recognizes need for two connectors

// 1. Query Linear connector
await queryMCPConnectorTool.execute({
  connectorId: "linear-mcp-connector-456",
  query: "Find all tasks assigned to current user from this week"
}, mainContext)

// 2. Query GitHub connector
await queryMCPConnectorTool.execute({
  connectorId: "github-mcp-connector-123",
  query: "Find all issues assigned to current user from this week"
}, mainContext)

// 3. Synthesize combined answer
```

**Linear Connector Agent**:
```
Tools Used:
1. get_current_user() → User ID: abc123
2. list_issues(assignee: abc123, created_gte: "2025-01-06")
   → 5 tasks found
```

**GitHub Connector Agent**:
```
Tools Used:
1. get_authenticated_user() → Username: octocat
2. search_issues(assignee: octocat, created: ">=2025-01-06")
   → 3 issues found
```

**Final Combined Response**:
```
This week's assignments:

**Linear Tasks (5)**:
1. Design new API endpoint (XYN-123)
2. Review PR feedback (XYN-124)
...

**GitHub Issues (3)**:
1. Bug: Login timeout (#456)
2. Feature: Add dark mode (#457)
...

Total: 8 items across both platforms.
```

### 8.3 Example: Complex Multi-Step Query

**User Query**: "Create a GitHub issue for the bug mentioned in the latest Slack message from @john"

**Main Agent Plan**:
```
1. Query Slack connector to find latest message from @john
2. Extract bug details from message
3. Query GitHub connector to create issue
```

**Execution Flow**:

**Step 1: Slack Connector**
```typescript
await queryMCPConnectorTool.execute({
  connectorId: "slack-mcp-connector-789",
  query: "Find the most recent message from user @john and extract its content"
}, mainContext)
```

Slack Agent:
```
Tools Used:
1. get_user_by_name(name: "john") → User ID: U123
2. search_messages(user: U123, limit: 1, sort: desc)
   → Message: "Found critical bug in auth flow - users can't login after password reset"
```

**Step 2: GitHub Connector**
```typescript
await queryMCPConnectorTool.execute({
  connectorId: "github-mcp-connector-123",
  query: "Create a new issue titled 'Bug: Login fails after password reset' with description about authentication flow problem",
  context: "Bug details from Slack: users can't login after password reset in auth flow"
}, mainContext)
```

GitHub Agent:
```
Tools Used:
1. create_issue(
     repo: "xynehq/xyne",
     title: "Bug: Login fails after password reset",
     body: "Critical authentication bug reported by @john:\n\nUsers cannot login after password reset...",
     labels: ["bug", "authentication", "high-priority"]
   )
   → Created issue #789
```

**Final Response**:
```
I've created GitHub issue #789 based on @john's latest Slack message:

**Issue**: Bug: Login fails after password reset
**Priority**: High
**Labels**: bug, authentication, high-priority
**Link**: https://github.com/xynehq/xyne/issues/789

The issue includes the full bug description from John's Slack message.
```

---

## 9. Benefits Summary

### 9.1 Performance Benefits

| Metric | Old Flow | New Flow | Improvement |
|--------|----------|----------|-------------|
| Client Creation | Every query | Once per connector | ~500ms saved |
| Connection Overhead | 3-5s per query | Reused | ~90% reduction |
| Memory Usage | High churn | Stable | ~60% reduction |
| Error Rate | 5-10% (conn failures) | <1% | ~90% improvement |

### 9.2 Architectural Benefits

✅ **Separation of Concerns**: Main agent focuses on orchestration, connector agents focus on tool execution

✅ **Intelligent Tool Selection**: Connector agents understand their tools and can plan optimally

✅ **Scalability**: Add new connectors without overwhelming main agent

✅ **Maintainability**: Connector-specific logic isolated in dedicated agents

✅ **Reliability**: Persistent connections with health monitoring

### 9.3 Developer Experience Benefits

✅ **Easier Debugging**: Clear separation between main flow and connector-specific execution

✅ **Better Observability**: Metrics per connector, clear execution traces

✅ **Simpler Testing**: Test connector agents independently

✅ **Flexible Configuration**: Per-connector settings and optimizations

---

## 10. Conclusion

This design transforms MCP connectors from inefficient per-query clients to a robust, persistent agent architecture with intelligent orchestration. The proposed solution:

1. **Eliminates per-query overhead** through persistent MCP clients
2. **Enables intelligent tool orchestration** via dedicated connector agents
3. **Provides clear abstraction** with universal orchestrator tool
4. **Maintains backward compatibility** during gradual migration
5. **Improves reliability** through health monitoring and connection pooling

**Next Steps**:
1. Review and approve design
2. Begin Phase 1 implementation (Core Infrastructure)
3. Set up monitoring and metrics
4. Plan internal testing phase

**Success Criteria**:
- ✅ Zero per-query client creation
- ✅ 90%+ reduction in connection overhead
- ✅ <1% error rate from connector agents
- ✅ Clear tool execution traces
- ✅ Seamless user experience
