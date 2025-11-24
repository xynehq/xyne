# Agent LLM Architecture Documentation

## Overview
This document explains how LLM calls work in the Xyne agent system, including prompts, JAF integration, tool schemas, sub-agent handling, and the concept of "turns".

---

## 1. LLM Calls and Prompt Construction

### When a Query Comes to an Agent

When a user query arrives at an agent, here's what happens:

1. **User Message Added**: The query is added to the message array as a `user` role message
2. **System Instructions Built**: Dynamic instructions are generated for the LLM
3. **Prompt Sent to LLM**: The complete prompt is constructed and sent

### What Gets Passed to the LLM?

The prompt sent to the LLM consists of:

#### **System Message** (First message in prompt)
Generated dynamically by the `agentInstructions()` function in `server/api/chat/agents.ts`:

```typescript
const agentInstructions = () => {
  const toolOverview = buildToolsOverview(allJAFTools)
  const contextSection = buildContextSection(gatheredFragments)
  const agentSection = agentPromptForLLM
    ? `\n\nAgent Constraints:\n${agentPromptForLLM}`
    : ""
  
  return (
    `The current date is: ${dateForAI} \n\n
    You are Xyne, an enterprise search assistant.\n` +
    `- Your first action must be to call an appropriate tool to gather authoritative context before answering.\n` +
    `- Do NOT answer from general knowledge. Always retrieve context via tools first.\n` +
    `- Always cite sources inline using bracketed indices [n]...\n` +
    `\nAvailable Tools:\n${toolOverview}` +
    contextSection +
    agentSection +
    // ... citation format instructions
  )
}
```

**Components:**
- **Date/Time Context**: Current date in user's timezone
- **Base Instructions**: Core behavior ("You are Xyne...")
- **Tool Overview**: List of all available tools with descriptions
- **Context Fragments**: Previously gathered search results (if any)
- **Agent Constraints**: Agent's custom description/prompt from database
- **Citation Format**: Instructions on how to format citations

#### **Conversation History**
All previous messages in the conversation (user and assistant messages).

#### **Current User Query**
The latest user message.

---

## 2. What JAF Adds to the System

### JAF (Juspay Agentic Framework) Responsibilities

JAF is an **orchestration layer** that manages:

1. **Agent Loop Management**
   - Runs iterative turn-by-turn execution
   - Manages state between turns
   - Enforces `maxTurns` limit (default: 10)

2. **Tool Calling Protocol**
   - Parses LLM tool call requests
   - Executes tools with proper error handling
   - Formats tool results back to LLM
   - Supports parallel/sequential tool execution

3. **Message History Management**
   - Maintains conversation state
   - Tracks tool calls and results
   - Builds proper message format for different LLM providers

4. **Event Streaming**
   - Emits events for monitoring: `turn_start`, `tool_call_start`, `llm_call_end`, etc.
   - Allows real-time tracking of agent progress

5. **Provider Abstraction**
   - Works with any LLM provider (via `ModelProvider` interface)
   - Xyne uses a custom provider (`makeXyneJAFProvider`) that wraps AI SDK

### JAF Does NOT Add:
- ❌ Built-in planning logic
- ❌ Todo list management
- ❌ Automatic task breakdown
- ❌ Search strategy optimization

**These capabilities come from the agent's instructions/prompt**, not JAF itself.

---

## 3. Tool and Agent Response Schemas

### How LLM Returns Tool Calls

The LLM returns tool calls in a specific format defined by the provider:

```json
{
  "content": "I'll search for that information...",
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "search_knowledge_base",
        "arguments": "{\"query\":\"user's question\",\"limit\":10}"
      }
    }
  ]
}
```

### Schema Definition Location

**Tool schemas are defined in two places:**

1. **Internal Tools** (`server/api/chat/tools.ts`)
   - Each tool has a `parameters` object defining expected inputs
   - Converted to Zod schemas in `jaf-adapter.ts`

2. **MCP Tools** (from external connectors)
   - Schema stored in database as JSON
   - Converted to Zod in `jaf-adapter.ts` via `mcpToolSchemaStringToZodObject()`

**Schema Conversion Pipeline:**
```
Tool Definition → Zod Schema → JSON Schema → LLM Tool Schema
```

**Example from `jaf-adapter.ts`:**

```typescript
function paramsToZod(parameters: Record<string, AgentToolParameter>) {
  const shape: Record<string, ZodType> = {}
  
  for (const [key, spec] of Object.entries(parameters)) {
    let schema: ZodType
    switch (spec.type) {
      case "string": schema = z.string(); break
      case "number": schema = z.number(); break
      // ... etc
    }
    shape[key] = spec.required ? schema : schema.optional()
  }
  
  return z.looseObject(shape)
}
```

### Tool Response Format

Tools return responses using JAF's `ToolResponse` class:

```typescript
// Success
return ToolResponse.success(content, {
  toolName: name,
  contexts: newFragments,  // Additional metadata
})

// Error
return ToolResponse.error("EXECUTION_FAILED", errorMessage)
```

The LLM receives tool results as:

```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "Search results: ..."
}
```

---

## 4. Sub-Agent Handling (Handoffs & Agent-as-Tool)

### Handoff Mechanism

JAF supports **agent handoffs** - transferring control from one agent to another.

**Agent Definition with Handoffs:**
```typescript
const jafAgent: JAFAgent<Ctx, string> = {
  name: "main-agent",
  instructions: () => "...",
  tools: [...],
  handoffs: ["specialist-agent", "research-agent"]  // ← Allowed handoffs
}
```

### What Happens During Handoff?

1. **LLM Requests Handoff**: Main agent decides to hand off
2. **JAF Validates**: Checks if target agent is in `handoffs` array
3. **Context Transfer**: 
   - All messages transferred to new agent
   - Context object passed along
   - Turn counter continues
4. **New Agent Takes Over**: Specialist agent's instructions now apply
5. **Turn Counting**: Handoff **does count as a turn** in the main agent's context

**Prompt Changes:**
- Main agent's instructions → Specialist agent's instructions
- Tool availability changes to specialist's tools
- Agent constraints updated

**Example Flow:**
```
Turn 1: Main Agent (using main instructions)
  ↓ Decides to hand off
Turn 2: Specialist Agent (using specialist instructions)
  ↓ Works on subtask
Turn 3: Specialist Agent (continues)
  ↓ Completes and returns
Turn 4: Main Agent (resumes with specialist's results)
```

### Agent-as-Tool Pattern

Currently **not implemented** in the Xyne codebase, but JAF supports it conceptually:
- Wrap an entire agent as a tool
- Main agent calls "sub-agent tool"
- Sub-agent runs independently with its own turn limit
- Results returned to main agent

---

## 5. What is a "Turn"?

### Definition
A **turn** is one complete iteration of the agent loop:

```
User Message → LLM Call → Tool Requests → Tool Executions → Tool Results → [Loop or Finish]
```

### Turn Lifecycle

**Turn N:**
1. **Turn Start**: JAF emits `turn_start` event
2. **LLM Call**: Send messages + instructions to LLM
3. **LLM Response**: Receive text and/or tool calls
4. **Tool Execution** (if tool calls):
   - Execute each requested tool
   - Collect results
   - Format as tool messages
5. **Turn End**: JAF emits `turn_end` event
6. **Decision**: 
   - If final answer → Exit
   - If tool calls → Start Turn N+1
   - If max turns reached → Exit with error

### Turn Examples

**Example 1: Single Turn (Direct Answer)**
```
Turn 1:
  User: "What's 2+2?"
  LLM: "The answer is 4."
  → Complete (1 turn total)
```

**Example 2: Multi-Turn (Tool Usage)**
```
Turn 1:
  User: "Find documents about project X"
  LLM: [Calls search_knowledge_base tool]
  Tool: Returns 5 documents
  
Turn 2:
  LLM: "Based on the search results, here are the key documents: [1][2][3]..."
  → Complete (2 turns total)
```

**Example 3: Complex Multi-Turn**
```
Turn 1:
  User: "Summarize recent emails about budget"
  LLM: [Calls search_email tool]
  Tool: Returns 3 emails
  
Turn 2:
  LLM: [Notices more context needed, calls search_email with different params]
  Tool: Returns 2 more emails
  
Turn 3:
  LLM: "Here's a summary of 5 emails about budget: ..."
  → Complete (3 turns total)
```

### Turn Limits

- **Default**: `maxTurns = 10` (configured in `agents.ts`)
- **Why Limit?**: Prevent infinite loops, control costs
- **When Hit**: JAF emits `MaxTurnsExceeded` error
- **Fallback**: Xyne has special handling that triggers a fallback search tool

---

## 6. Planning and Todo Logic

### Does JAF Have Planning Logic?

**No.** JAF is purely an orchestration framework. It does not:
- ❌ Create todo lists automatically
- ❌ Break tasks into sub-goals
- ❌ Plan search strategies
- ❌ Optimize tool usage

### Where Planning Happens

Planning comes from **the agent's instructions** (the prompt):

**Current Instructions Snippet:**
```typescript
`You are Xyne, an enterprise search assistant.\n
- Your first action must be to call an appropriate tool to gather authoritative context before answering.
- Do NOT answer from general knowledge. Always retrieve context via tools first.
- If context is missing or insufficient, use respective tools to fetch more, or ask a brief clarifying question, then search.`
```

**This is implicit planning** - the LLM follows these instructions to:
1. Identify what information is needed
2. Choose appropriate tools
3. Evaluate if more searching is needed
4. Synthesize final answer

### Reasoning Steps in Xyne

Xyne **tracks reasoning steps** but doesn't enforce a todo structure:

```typescript
// Tracked reasoning steps
type AgentReasoningStep = {
  type: "Iteration" | "ToolExecuting" | "ToolResult" | "Synthesis" | ...
  iteration?: number
  details?: string
  stepSummary?: string
  aiGeneratedSummary?: string
}
```

**These are logged for transparency**, not used to drive behavior.

### Could You Add Planning?

**Yes!** You could enhance the agent's instructions:

```typescript
const agentInstructions = () => {
  return `
    You are Xyne, an enterprise search assistant.
    
    PLANNING PROCESS:
    1. First, analyze the user's query and create a mental checklist of sub-tasks
    2. For each sub-task:
       a. Identify required information
       b. Choose appropriate tool(s)
       c. Execute and evaluate results
    3. After each tool execution:
       - Update your mental checklist
       - Decide if more information is needed
       - Move to next sub-task or synthesize answer
    
    Available Tools:
    ${toolOverview}
    
    Current Context:
    ${contextSection}
  `
}
```

Or implement **explicit todo tracking** in the tool execution callback:

```typescript
onAfterToolExecution: async (toolName, result, context) => {
  // Parse result for todo items
  // Update state with completed/remaining tasks
  // Return modified result with todo context
}
```

---

## 7. Prompt Flow Summary

### Complete Flow for One Query

```
1. User sends query
   ↓
2. System builds RunState:
   - messages: [previous messages, new user message]
   - context: { email, userCtx, agentPrompt, userMessage }
   - currentAgentName: "xyne-agent"
   
3. JAF starts run:
   ↓
   TURN 1:
   ├─ Build prompt:
   │  ├─ System message (agent.instructions())
   │  │  ├─ Date/time
   │  │  ├─ Base instructions
   │  │  ├─ Tool overview
   │  │  ├─ Context fragments
   │  │  ├─ Agent constraints
   │  │  └─ Citation format
   │  ├─ Conversation history
   │  └─ Current user query
   │
   ├─ Send to LLM
   ├─ LLM responds with tool calls
   ├─ Execute tools
   └─ Add tool results to messages
   
   TURN 2:
   ├─ Build prompt (same structure, now includes tool results)
   ├─ Send to LLM
   ├─ LLM responds with final answer + citations
   └─ Complete
   
4. Stream response to user
5. Save to database
```

### Iteration Summary Generation

Xyne has special logic to **summarize each iteration**:

```typescript
// After each iteration completes
const generateAndStreamIterationSummary = async (
  iterationNumber,
  allSteps,
  userQuery
) => {
  // Calls LLM to summarize what was accomplished
  // Streams summary to user
  // Saves to reasoning steps
}
```

This provides **user-visible progress tracking** without affecting the agent's behavior.

---

## Key Takeaways

1. **Prompts are Dynamic**: Built from agent config + gathered context + tool results
2. **JAF is Orchestration**: Manages loop, not planning
3. **Tools Have Schemas**: Zod → JSON Schema → LLM understands
4. **Turns = Iterations**: One LLM call + tool execution cycle
5. **Planning = Prompt Engineering**: Instructions guide the LLM's search strategy
6. **Sub-agents Supported**: Via handoffs, with context transfer
7. **Reasoning Tracked**: For transparency, not enforcement

---

## Files Reference

- **Prompt Construction**: `server/api/chat/agents.ts` (agentInstructions function)
- **JAF Provider**: `server/api/chat/jaf-provider.ts` (buildPromptFromMessages)
- **Tool Schemas**: `server/api/chat/jaf-adapter.ts` (paramsToZod, buildInternalJAFTools)
- **JAF Types**: `server/node_modules/@xynehq/jaf/dist/core/types.d.ts`
- **Agent Execution**: `server/api/chat/agents.ts` (MessageWithToolsApi)
