# JAF-Based Agentic Architecture Design Plan

## Executive Summary

This document outlines a comprehensive redesign of Xyne's `MessageWithToolsApi` flow using the JAF (Juspay Agent Framework) to create a sophisticated agentic system with advanced planning, execution, review, and re-planning capabilities.

**Current State**: Basic JAF integration with simple tool execution
**Target State**: Fully agentic system with planning, parallel execution, review cycles, and intelligent decision-making

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Core Components](#core-components)
3. [Context Management](#context-management)
4. [Tool Ecosystem](#tool-ecosystem)
5. [Execution Flow](#execution-flow)
6. [Schemas & Data Structures](#schemas--data-structures)
7. [Implementation Roadmap](#implementation-roadmap)
8. [Examples & Use Cases](#examples--use-cases)

---

## 1. Architecture Overview

### 1.1 High-Level Architecture

```
User Query → Planning Phase → Execution Phase → Review Phase → Re-planning (if needed) → Final Answer
              ↓                ↓                  ↓                                        ↑
           toDoWrite        Tool Calls       Reviewer          ← Context Updates ─────────┘
           Tool             (Parallel/Seq)    Agent
```

### 1.2 Key Design Principles

1. **Planning-First Approach**: Always create a plan before execution
2. **Context-Driven Prompts**: Dynamic system prompts based on context state
3. **Intelligent Tool Selection**: Choose between parallel and sequential execution
4. **Review & Iterate**: Evaluate results and adjust strategy
5. **Schema-Based Everything**: Strict typing for reliability
6. **Graceful Degradation**: Handle failures intelligently

### 1.3 JAF Integration Points

- **RunState Context**: Store all execution state and history
- **Tool System**: Leverage JAF's tool execution with hooks
- **Event Streaming**: Use JAF events for real-time updates
- **Multi-Turn Execution**: JAF's turn management for iterative refinement

---

## 2. Core Components

### 2.1 Planning Agent (Primary)

**Purpose**: Analyze query, create execution plan, coordinate tool calls

**Capabilities**:
- Query analysis and decomposition
- Tool selection (which tools, parallel vs sequential)
- Plan creation via `toDoWrite` tool
- Dynamic replanning based on results

**System Prompt Structure**:
```typescript
<system>
Current Date: ${dateForAI}

You are Xyne, an enterprise search assistant with planning capabilities.

<context>
${contextState}
</context>

<plan>
${currentPlan || "No plan exists - create one using toDoWrite tool"}
</plan>

<tool_execution_history>
${toolCallHistory}
</tool_execution_history>

<available_tools>
${toolsOverview}
</available_tools>

<instructions>
# PLANNING PHASE
If no plan exists, you MUST first call toDoWrite to create a plan.
Break the task into clear, actionable sub-goals.

# EXECUTION STRATEGY
- For independent tool calls: Execute in PARALLEL (same turn)
- For dependent tool calls: Execute SEQUENTIALLY (different turns)
- Example: Searching Gmail + Drive = PARALLEL
- Example: Get user profile → Search their messages = SEQUENTIAL

# TOOL USAGE GUIDELINES
- Call tools to gather context before answering
- Always cite sources using [n] notation
- If results are insufficient, use toDoWrite to adjust plan

# QUALITY OVER SPEED
Before calling runPublicAgent (expensive operation):
1. Ensure no ambiguity about entities (user, place, etc.)
2. Consider if clarification tool is needed
3. Craft specific, detailed queries for agents
</instructions>
</system>
```

### 2.2 Reviewer Agent (as Tool)

**Purpose**: Evaluate tool results, identify gaps, suggest improvements

**Implementation**: Special tool that acts as an evaluator

```typescript
const reviewerTool: Tool<ReviewerInput, JAFAdapterCtx> = {
  schema: {
    name: "review_results",
    description: "Evaluate current results and provide feedback on next steps",
    parameters: ReviewerInputSchema
  },
  async execute(args, context) {
    // Review logic
    const evaluation = await evaluateResults({
      query: args.userQuery,
      plan: context.plan,
      toolResults: args.toolResults,
      gatheredContexts: args.contexts
    });
    
    return ToolResponse.success(evaluation, {
      needsMoreData: evaluation.needsMoreData,
      suggestedActions: evaluation.suggestedActions,
      qualityScore: evaluation.qualityScore
    });
  }
};
```

**Review Criteria**:
- Completeness: Did we get enough information?
- Relevance: Is the data relevant to the query?
- Quality: Are the results reliable?
- Coverage: Are there gaps we should fill?

### 2.3 Context Manager

**Purpose**: Maintain and update execution state

**Structure**:
```typescript
interface AgenticContext {
  // Core query info
  userQuery: string;
  userEmail: string;
  dateForAI: string;
  
  // Planning state
  plan: TodoPlan | null;
  currentSubGoal: string | null;
  
  // Execution history
  toolCallHistory: ToolCallRecord[];
  gatheredFragments: MinimalAgentFragment[];
  seenDocuments: Set<string>;
  
  // Performance metrics
  totalLatency: number;
  totalCost: number;
  tokenUsage: TokenUsage;
  
  // Agent selection
  availableAgents: AgentCapability[];
  usedAgents: string[];
  
  // Error tracking
  failedTools: Map<string, number>; // tool name -> failure count
  retryCount: number;
  
  // Decision log
  decisions: Decision[];
}
```

---

## 3. Context Management

### 3.1 Context Lifecycle

```
Initialize → Update After Each Tool → Review → Modify Plan → Update → Finalize
```

### 3.2 Dynamic Prompt Construction

The system prompt is dynamically constructed based on context state:

```typescript
function buildAgentInstructions(ctx: AgenticContext): string {
  let prompt = BASE_INSTRUCTION;
  
  // Add plan section if exists
  if (ctx.plan) {
    prompt += `\n<current_plan>\n${formatPlan(ctx.plan)}\n</current_plan>`;
  } else {
    prompt += `\n<plan_status>No plan exists. First action: Call toDoWrite to create a plan.</plan_status>`;
  }
  
  // Add tool history with metrics
  if (ctx.toolCallHistory.length > 0) {
    prompt += `\n<tool_history>\n${formatToolHistory(ctx.toolCallHistory)}\n</tool_history>`;
  }
  
  // Add gathered context summary
  if (ctx.gatheredFragments.length > 0) {
    prompt += `\n<gathered_context>\n`;
    prompt += `Total fragments: ${ctx.gatheredFragments.length}\n`;
    prompt += `Unique documents: ${ctx.seenDocuments.size}\n`;
    prompt += buildContextSection(ctx.gatheredFragments);
    prompt += `\n</gathered_context>`;
  }
  
  // Add failed tools warning
  if (ctx.failedTools.size > 0) {
    prompt += `\n<failed_tools>\n`;
    ctx.failedTools.forEach((count, toolName) => {
      prompt += `- ${toolName}: ${count} failures\n`;
      if (count >= 3) {
        prompt += `  ⚠️ AVOID using this tool - consider alternatives\n`;
      }
    });
    prompt += `</failed_tools>`;
  }
  
  // Add available agents info
  if (ctx.availableAgents.length > 0) {
    prompt += `\n<available_custom_agents>\n${formatAgentCapabilities(ctx.availableAgents)}\n</available_custom_agents>`;
  }
  
  return prompt;
}
```

### 3.3 Context Update Triggers

Context updates occur:
1. **After every tool execution** (update history, fragments)
2. **After review** (update decisions, plan modifications)
3. **On errors** (update failed tools counter)
4. **On plan changes** (via toDoWrite)

---

## 4. Tool Ecosystem

### 4.1 New Core Tools

#### 4.1.1 toDoWrite Tool

```typescript
interface TodoWriteInput {
  action: 'create' | 'update' | 'complete_step' | 'add_step' | 'remove_step';
  plan?: TodoPlan;
  stepId?: string;
  newStep?: TodoStep;
}

interface TodoPlan {
  id: string;
  userQuery: string;
  goals: TodoGoal[];
  createdAt: number;
  updatedAt: number;
}

interface TodoGoal {
  id: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  steps: TodoStep[];
  dependencies?: string[]; // IDs of goals this depends on
  estimatedComplexity: 'simple' | 'moderate' | 'complex';
}

interface TodoStep {
  id: string;
  description: string;
  toolsRequired: string[];
  executionStrategy: 'parallel' | 'sequential';
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
  completedAt?: number;
}

const toDoWriteToolSchema = z.object({
  action: z.enum(['create', 'update', 'complete_step', 'add_step', 'remove_step']),
  plan: TodoPlanSchema.optional(),
  stepId: z.string().optional(),
  newStep: TodoStepSchema.optional()
});

const toDoWriteTool: Tool<TodoWriteInput, JAFAdapterCtx> = {
  schema: {
    name: 'toDoWrite',
    description: 'Create, update, or modify the execution plan for the current task',
    parameters: toDoWriteToolSchema
  },
  async execute(args, context) {
    const currentPlan = context.plan;
    
    switch (args.action) {
      case 'create':
        if (!args.plan) {
          return ToolResponse.error('INVALID_INPUT', 'Plan required for create action');
        }
        context.plan = args.plan;
        return ToolResponse.success('Plan created successfully', {
          plan: args.plan
        });
        
      case 'update':
        // Update existing plan
        break;
        
      case 'complete_step':
        // Mark step as complete
        break;
        
      case 'add_step':
        // Add new step to existing goal
        break;
        
      case 'remove_step':
        // Remove step (e.g., if determined unnecessary)
        break;
    }
  }
};
```

**Hook Integration**:
```typescript
onAfterToolExecution: async (toolName, result, hookContext) => {
  if (toolName === 'toDoWrite') {
    // Update context with new plan
    const updatedPlan = result.metadata?.plan;
    if (updatedPlan) {
      hookContext.state.context.plan = updatedPlan;
    }
  }
}
```

#### 4.1.2 ListCustomAgents Tool

```typescript
interface ListCustomAgentsInput {
  query: string;
  requiredCapabilities?: string[];
  maxAgents?: number;
}

interface AgentCapability {
  agentId: string;
  agentName: string;
  description: string;
  capabilities: string[];
  suitabilityScore: number; // 0-1 based on query match
  estimatedCost: 'low' | 'medium' | 'high';
  averageLatency: number; // milliseconds
}

const listCustomAgentsTool: Tool<ListCustomAgentsInput, JAFAdapterCtx> = {
  schema: {
    name: 'list_custom_agents',
    description: 'Identify relevant custom agents (runPublicAgent) for the current query. Use this before calling runPublicAgent to ensure the right agent is selected.',
    parameters: z.object({
      query: z.string().describe('The user query to match against agent capabilities'),
      requiredCapabilities: z.array(z.string()).optional().describe('Specific capabilities needed'),
      maxAgents: z.number().optional().describe('Maximum number of agents to return')
    })
  },
  async execute(args, context) {
    // 1. Fetch available agents from database
    const allAgents = await fetchAvailableAgents(context.email);
    
    // 2. Score each agent based on query relevance
    const scoredAgents: AgentCapability[] = await Promise.all(
      allAgents.map(async (agent) => {
        const score = await calculateAgentSuitability(
          args.query,
          agent.description,
          agent.capabilities
        );
        
        return {
          agentId: agent.id,
          agentName: agent.name,
          description: agent.description,
          capabilities: agent.capabilities,
          suitabilityScore: score,
          estimatedCost: estimateCost(agent),
          averageLatency: agent.metrics?.avgLatency || 5000
        };
      })
    );
    
    // 3. Sort by suitability and filter
    const topAgents = scoredAgents
      .filter(a => a.suitabilityScore > 0.3) // Threshold
      .sort((a, b) => b.suitabilityScore - a.suitabilityScore)
      .slice(0, args.maxAgents || 5);
    
    // 4. Format response
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

#### 4.1.3 runPublicAgent Tool (Enhanced)

```typescript
interface RunPublicAgentInput {
  agentId: string;
  query: string; // Modified/enriched query specific to this agent
  context?: string; // Additional context to provide
  maxTokens?: number;
}

const runPublicAgentTool: Tool<RunPublicAgentInput, JAFAdapterCtx> = {
  schema: {
    name: 'run_public_agent',
    description: 'Execute a custom agent with a specific query. IMPORTANT: Call list_custom_agents first to identify the right agent. Craft a detailed, specific query for the agent.',
    parameters: z.object({
      agentId: z.string().describe('ID of the agent to run (from list_custom_agents)'),
      query: z.string().describe('Detailed query tailored for this specific agent'),
      context: z.string().optional().describe('Additional context to provide to the agent'),
      maxTokens: z.number().optional().describe('Maximum response tokens')
    })
  },
  async execute(args, context) {
    // Record start time
    const startTime = Date.now();
    
    try {
      // Execute the agent
      const result = await executeCustomAgent({
        agentId: args.agentId,
        query: args.query,
        context: args.context,
        userEmail: context.email
      });
      
      const latency = Date.now() - startTime;
      
      // Track metrics
      context.toolCallHistory.push({
        toolName: 'run_public_agent',
        agentId: args.agentId,
        latency,
        cost: result.cost || 0,
        success: true,
        timestamp: Date.now()
      });
      
      return ToolResponse.success(result.answer, {
        agentId: args.agentId,
        latency,
        cost: result.cost,
        contexts: result.contexts || []
      });
    } catch (error) {
      const latency = Date.now() - startTime;
      
      // Track failure
      context.toolCallHistory.push({
        toolName: 'run_public_agent',
        agentId: args.agentId,
        latency,
        success: false,
        error: error.message,
        timestamp: Date.now()
      });
      
      return ToolResponse.error('AGENT_EXECUTION_FAILED', error.message);
    }
  }
};
```

#### 4.1.4 MCP Plan Tool (for each MCP server)

```typescript
interface MCPPlanInput {
  query: string;
  availableTools: string[]; // Tool names from this MCP server
}

interface MCPPlanOutput {
  recommendedTools: string[];
  executionOrder: 'parallel' | 'sequential';
  reasoning: string;
  estimatedResults: string;
}

const createMCPPlanTool = (mcpServerName: string): Tool<MCPPlanInput, JAFAdapterCtx> => ({
  schema: {
    name: `plan_${mcpServerName}_tools`,
    description: `Analyze the query and recommend which ${mcpServerName} tools to use and in what order`,
    parameters: z.object({
      query: z.string(),
      availableTools: z.array(z.string())
    })
  },
  async execute(args, context) {
    // Use LLM to plan tool usage
    const plan = await planMCPToolUsage({
      query: args.query,
      mcpServer: mcpServerName,
      availableTools: args.availableTools,
      context: context
    });
    
    return ToolResponse.success(plan.reasoning, {
      recommendedTools: plan.recommendedTools,
      executionOrder: plan.executionOrder,
      estimatedResults: plan.estimatedResults
    });
  }
});
```

### 4.2 Tool Modifications

#### 4.2.1 Enhanced Tool Schemas with Error Handling

All tools should return structured responses:

```typescript
interface ToolExecutionResult {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
    suggestedAction?: string;
  };
  metadata: {
    latency: number;
    cost?: number;
    contexts?: MinimalAgentFragment[];
    toolName: string;
    timestamp: number;
  };
}

// Update all existing tools to follow this schema
```

---

## 5. Execution Flow

### 5.1 Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     USER QUERY RECEIVED                          │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  INITIALIZATION PHASE                                            │
│  - Parse query                                                   │
│  - Load user context                                             │
│  - Initialize AgenticContext                                     │
│  - Build initial system prompt                                   │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  PLANNING PHASE (Turn 1)                                         │
│  ┌──────────────────────────────────────────────────┐            │
│  │ Check: Does plan exist in context?               │            │
│  └──────┬───────────────────────────────┬───────────┘            │
│         │ NO                            │ YES                    │
│         ▼                               ▼                        │
│  ┌────────────────┐            ┌───────────────────┐            │
│  │ Call toDoWrite │            │ Proceed to        │            │
│  │ to create plan │            │ execution         │            │
│  └────────┬───────┘            └─────────┬─────────┘            │
│           │                              │                       │
│           └──────────────┬───────────────┘                       │
└──────────────────────────┼───────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  TOOL SELECTION PHASE (Turn 2+)                                  │
│  ┌──────────────────────────────────────────────────┐            │
│  │ Analyze current sub-goal from plan               │            │
│  │ Determine tool execution strategy:               │            │
│  │  - Which tools needed?                           │            │
│  │  - Parallel or sequential?                       │            │
│  │  - Need clarification first?                     │            │
│  └──────────────────────────┬───────────────────────┘            │
└─────────────────────────────┼───────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────┴─────────────────────┐
        │                                            │
        ▼                                            ▼
┌──────────────────┐                       ┌──────────────────┐
│ PARALLEL         │                       │ SEQUENTIAL       │
│ EXECUTION        │                       │ EXECUTION        │
│                  │                       │                  │
│ - Multiple tools │                       │ - Tool 1         │
│   in same turn   │                       │   Wait result    │
│ - Independent    │                       │ - Tool 2 (uses   │
│   operations     │                       │   Tool 1 output) │
│                  │                       │   Wait result    │
│ Example:         │                       │                  │
│ • Search Gmail   │                       │ Example:         │
│ • Search Drive   │                       │ • Get user ID    │
│ • Search Slack   │                       │ • Search user's  │
│   (all at once)  │                       │   messages       │
└────────┬─────────┘                       └────────┬─────────┘
         │                                          │
         └────────────────┬─────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  HOOKS: onAfterToolExecution                                     │
│  ┌──────────────────────────────────────────────────┐            │
│  │ For each tool result:                            │            │
│  │ 1. Check for duplicate calls (same params)       │            │
│  │ 2. Log parameters & metrics to context           │            │
│  │ 3. Extract & store contexts/fragments            │            │
│  │ 4. Update tool call history                      │            │
│  │ 5. Track latency & cost                          │            │
│  │ 6. Check for errors (increment fail counter)     │            │
│  │ 7. Filter best documents (extractBestDocIndexes) │            │
│  └──────────────────────────────────────────────────┘            │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  REVIEW PHASE (Every N turns or after goal completion)          │
│  ┌──────────────────────────────────────────────────┐            │
│  │ Call review_results tool:                        │            │
│  │ - Evaluate gathered contexts                     │            │
│  │ - Check completeness vs query                    │            │
│  │ - Assess quality & relevance                     │            │
│  │ - Identify gaps or issues                        │            │
│  └──────┬───────────────────────────────┬───────────┘            │
│         │                               │                        │
│         ▼                               ▼                        │
│  ┌──────────────┐              ┌──────────────────┐            │
│  │ Quality OK   │              │ Needs more data  │            │
│  │ Continue     │              │ or refinement    │            │
│  └──────┬───────┘              └────────┬─────────┘            │
└─────────┼──────────────────────────────┼───────────────────────┘
          │                              │
          │                              ▼
          │                    ┌──────────────────────┐
          │                    │ REPLANNING PHASE     │
          │                    │ ┌──────────────────┐ │
          │                    │ │ Call toDoWrite   │ │
          │                    │ │ - Adjust plan    │ │
          │                    │ │ - Add new steps  │ │
          │                    │ │ - Remove failed  │ │
          │                    │ └──────────────────┘ │
          │                    └──────────┬───────────┘
          │                               │
          │    ┌──────────────────────────┘
          │    │ Loop back to execution
          │    │
          ▼    ▼
┌─────────────────────────────────────────────────────────────────┐
│  DECISION CHECKPOINT                                             │
│  ┌──────────────────────────────────────────────────┐            │
│  │ Evaluate:                                        │            │
│  │ - All plan goals completed?                      │            │
│  │ - Sufficient context gathered?                   │            │
│  │ - Max iterations reached?                        │            │
│  │ - Unrecoverable errors?                          │            │
│  └──────┬───────────────────────────────┬───────────┘            │
│         │ Continue                      │ Exit                   │
│         ▼                               ▼                        │
│  ┌────────────┐                 ┌──────────────┐                │
│  │ Next turn  │                 │ Finalize     │                │
│  │ in loop    │                 │ answer       │                │
│  └────────────┘                 └──────┬───────┘                │
└─────────────────────────────────────────┼───────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  SYNTHESIS PHASE                                                 │
│  - Compile all gathered contexts                                │
│  - Generate final answer with citations                          │
│  - Stream to user                                                │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  PERSISTENCE                                                     │
│  - Save message to database                                      │
│  - Store tool call history                                       │
│  - Log metrics (latency, cost, tokens)                           │
│  - Save plan state for future reference                          │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 JAF RunConfig with Hooks

```typescript
const runConfig: JAFRunConfig<JAFAdapterCtx> = {
  agentRegistry,
  modelProvider,
  maxTurns: 15,
  modelOverride: actualModelId,
  
  // HOOK: Before tool execution - prevent duplicates, modify args
  onBeforeToolExecution: async (toolName, args, context) => {
    const { state } = context;
    
    // 1. Check for duplicate tool calls
    const isDuplicate = state.context.toolCallHistory.some(
      record => 
        record.toolName === toolName &&
        JSON.stringify(record.args) === JSON.stringify(args) &&
        record.success === true &&
        (Date.now() - record.timestamp) < 60000 // Within last minute
    );
    
    if (isDuplicate) {
      await logAndStreamReasoning({
        type: AgentReasoningStepType.LogMessage,
        message: `⚠️ Skipping duplicate call to ${toolName} with same parameters`,
      });
      return null; // Skip this tool call
    }
    
    // 2. Add excludedIds to prevent re-fetching same documents
    const seenDocIds = Array.from(state.context.seenDocuments);
    if (seenDocIds.length > 0 && args.excludedIds) {
      return {
        ...args,
        excludedIds: [...(args.excludedIds || []), ...seenDocIds]
      };
    }
    
    return args; // Proceed with original args
  },
  
  // HOOK: After tool execution - log, extract, filter
  onAfterToolExecution: async (toolName, result, hookContext) => {
    const { state, executionTime, status, args } = hookContext;
    
    // 1. Log the tool call with full details
    const toolRecord: ToolCallRecord = {
      toolName,
      args,
      result: result?.data,
      success: status === 'success',
      error: status !== 'success' ? result?.error : undefined,
      latency: executionTime,
      cost: result?.metadata?.cost || 0,
      timestamp: Date.now(),
      contexts: result?.metadata?.contexts || []
    };
    
    state.context.toolCallHistory.push(toolRecord);
    
    // 2. Track failed tools
    if (!toolRecord.success) {
      const failCount = (state.context.failedTools.get(toolName) || 0) + 1;
      state.context.failedTools.set(toolName, failCount);
      
      // Remove tool from available list if it fails 3+ times
      if (failCount >= 3) {
        await logAndStreamReasoning({
          type: AgentReasoningStepType.LogMessage,
          message: `⚠️ Tool ${toolName} has failed ${failCount} times. Consider using alternatives.`,
        });
      }
    }
    
    // 3. Extract contexts if present
    const contexts = result?.metadata?.contexts;
    if (Array.isArray(contexts) && contexts.length > 0) {
      // Filter out already seen documents
      const newContexts = contexts.filter(
        c => !state.context.seenDocuments.has(c.id)
      );
      
      if (newContexts.length > 0) {
        // Use extractBestDocumentIndexes to filter quality contexts
        try {
          const contextStrings = newContexts.map(c => c.content);
          const bestIndexes = await extractBestDocumentIndexes(
            state.context.userQuery,
            contextStrings,
            { modelId: defaultFastModel, json: false, stream: false },
            []
          );
          
          const selectedContexts = bestIndexes.map(idx => newContexts[idx - 1]).filter(Boolean);
          state.context.gatheredFragments.push(...selectedContexts);
          
          // Mark as seen
          selectedContexts.forEach(c => state.context.seenDocuments.add(c.id));
          
          await logAndStreamReasoning({
            type: AgentReasoningStepType.ToolResult,
            toolName,
            itemsFound: selectedContexts.length,
            stepSummary: `Added ${selectedContexts.length} high-quality contexts`
          });
        } catch (error) {
          // Fallback: add all contexts if filtering fails
          state.context.gatheredFragments.push(...newContexts);
          newContexts.forEach(c => state.context.seenDocuments.add(c.id));
        }
      }
    }
    
    // 4. Update metrics
    state.context.totalLatency += executionTime;
    state.context.totalCost += toolRecord.cost;
    
    // 5. Return processed contexts to model
    return newContexts.map(c => c.content).join('\n');
  }
};
```

---

## 6. Schemas & Data Structures

### 6.1 Core Schemas

```typescript
// ============ Tool Call History ============
interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  success: boolean;
  error?: string;
  latency: number;
  cost: number;
  timestamp: number;
  contexts: MinimalAgentFragment[];
  agentId?: string; // For runPublicAgent calls
}

// ============ Decision Log ============
interface Decision {
  id: string;
  timestamp: number;
  decisionType: 'tool_selection' | 'plan_modification' | 'strategy_change' | 'error_recovery';
  reasoning: string;
  outcome: 'success' | 'failure' | 'pending';
  relatedToolCalls?: string[];
}

// ============ Review Results ============
interface ReviewResult {
  qualityScore: number; // 0-1
  completeness: number; // 0-1
  relevance: number; // 0-1
  needsMoreData: boolean;
  gaps: string[];
  suggestedActions: string[];
  recommendation: 'proceed' | 'gather_more' | 'clarify_query' | 'replan';
}

// ============ Clarification Request ============
interface ClarificationRequest {
  ambiguity: string;
  options: string[];
  context: string;
  urgency: 'high' | 'medium' | 'low';
}
```

### 6.2 Error Schemas

```typescript
interface ToolError {
  code: string;
  message: string;
  recoverable: boolean;
  suggestedAction?: string;
  stack?: string;
}

// Common error codes
enum ToolErrorCode {
  EXECUTION_FAILED = 'EXECUTION_FAILED',
  INVALID_INPUT = 'INVALID_INPUT',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  NOT_FOUND = 'NOT_FOUND',
  TIMEOUT = 'TIMEOUT',
  RATE_LIMIT = 'RATE_LIMIT',
  NETWORK_ERROR = 'NETWORK_ERROR',
  DUPLICATE_CALL = 'DUPLICATE_CALL'
}
```

---

## 7. Implementation Roadmap

### Phase 1: Foundation (Week 1-2)
- [ ] Implement `AgenticContext` structure
- [ ] Create `toDoWrite` tool with full CRUD operations
- [ ] Build dynamic prompt construction function
- [ ] Implement basic tool call history tracking
- [ ] Add duplicate detection in `onBeforeToolExecution` hook

### Phase 2: Tool Ecosystem (Week 3-4)
- [ ] Implement `listCustomAgents` tool
- [ ] Enhance `runPublicAgent` tool with metrics
- [ ] Create MCP plan tools for each connector
- [ ] Update all existing tools to return structured errors
- [ ] Implement `extractBestDocumentIndexes` in hooks

### Phase 3: Review & Planning (Week 5-6)
- [ ] Implement `review_results` tool
- [ ] Build plan evaluation logic
- [ ] Create replanning mechanism
- [ ] Add decision logging
- [ ] Implement failed tool tracking and removal

### Phase 4: Advanced Features (Week 7-8)
- [ ] Implement parallel vs sequential execution logic
- [ ] Add clarification tool integration
- [ ] Build query rewriting for agents
- [ ] Create cost/latency optimization
- [ ] Implement graceful degradation on errors

### Phase 5: Testing & Refinement (Week 9-10)
- [ ] Comprehensive unit tests for all tools
- [ ] Integration tests for full flow
- [ ] Performance optimization
- [ ] Error handling edge cases
- [ ] Documentation and examples

---

## 8. Examples & Use Cases

### Example 1: Simple Query with Planning

**Query**: "What does Alex say about Q4?"

**Execution Flow**:

1. **Planning Phase**:
   ```json
   {
     "action": "create",
     "plan": {
       "id": "plan_001",
       "userQuery": "What does Alex say about Q4?",
       "goals": [
         {
           "id": "goal_1",
           "description": "Identify which Alex the user is referring to",
           "priority": "high",
           "steps": [
             {
               "id": "step_1_1",
               "description": "Search for people named Alex in organization",
               "toolsRequired": ["searchGoogleContacts"],
               "executionStrategy": "parallel"
             }
           ]
         },
         {
           "id": "goal_2",
           "description": "Search communications from identified Alex about Q4",
           "priority": "high",
           "dependencies": ["goal_1"],
           "steps": [
             {
               "id": "step_2_1",
               "description": "Search Gmail, Slack, and Drive in parallel",
               "toolsRequired": ["searchGmail", "getSlackMessages", "searchDriveFiles"],
               "executionStrategy": "parallel"
             }
           ]
         }
       ]
     }
   }
   ```

2. **Execution Turn 1**: Search contacts → Find 3 Alexes
3. **Clarification**: Ask user which Alex (if needed)
4. **Execution Turn 2**: Search Gmail + Slack + Drive in parallel
5. **Review**: Check if results mention Q4
6. **Synthesis**: Generate answer with citations

### Example 2: Complex Multi-Agent Query

**Query**: "Analyze Q4 performance across all departments and summarize action items"

**Execution Flow**:

1. **Planning**:
   - Goal 1: Identify relevant custom agents
   - Goal 2: Gather Q4 data from multiple sources
   - Goal 3: Run specialized analysis agents
   - Goal 4: Consolidate and summarize

2. **Tool Selection**:
   ```typescript
   // Turn 1: Plan
   toDoWrite({ action: 'create', plan: {...} })
   
   // Turn 2: Identify agents
   list_custom_agents({ 
     query: "Q4 performance analysis", 
     requiredCapabilities: ["data_analysis", "reporting"] 
   })
   
   // Turn 3: Gather data (parallel)
   [
     searchGmail({ query: "Q4 performance", timeRange: {...} }),
     searchDriveFiles({ query: "Q4 report" }),
     getSlackMessages({ filter_query: "Q4 results" })
   ]
   
   // Turn 4: Run agents (sequential - expensive operations)
   run_public_agent({ 
     agentId: "financial_analyzer",
     query: "Analyze Q4 financial performance based on: [gathered data]"
   })
   
   // Turn 5: Review and replan if needed
   review_results({ query, toolResults, contexts })
   ```

### Example 3: Error Recovery

**Scenario**: Gmail search fails 3 times

**Execution**:

1. First failure: Retry with different parameters
2. Second failure: Log in `failedTools` map
3. Third failure: 
   - Mark tool as unavailable
   - Update system prompt to exclude it
   - Replan using alternative tools (Slack, Drive)
4. Continue execution without Gmail data
5. Note limitation in final answer

---

## 9. Key Implementation Details

### 9.1 Preventing Tool Call Loops

```typescript
// In onBeforeToolExecution
const recentCalls = state.context.toolCallHistory.filter(
  r => r.toolName === toolName && (Date.now() - r.timestamp) < 120000
);

if (recentCalls.length >= 3) {
  return ToolResponse.error(
    'TOO_MANY_CALLS',
    `Tool ${toolName} called ${recentCalls.length} times recently. Preventing loop.`
  );
}
```

### 9.2 Cost & Latency Tracking

```typescript
interface PerformanceMetrics {
  totalLatency: number;
  totalCost: number;
  toolLatencies: Map<string, number[]>;
  toolCosts: Map<string, number[]>;
  averageLatencyPerTool: Map<string, number>;
}

function updateMetrics(toolName: string, latency: number, cost: number) {
  if (!metrics.toolLatencies.has(toolName)) {
    metrics.toolLatencies.set(toolName, []);
    metrics.toolCosts.set(toolName, []);
  }
  
  metrics.toolLatencies.get(toolName)!.push(latency);
  metrics.toolCosts.get(toolName)!.push(cost);
  metrics.totalLatency += latency;
  metrics.totalCost += cost;
  
  // Calculate running average
  const latencies = metrics.toolLatencies.get(toolName)!;
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  metrics.averageLatencyPerTool.set(toolName, avg);
}
```

### 9.3 Dynamic Prompt Example

```typescript
// Full example of dynamic prompt at different stages

// Stage 1: Initial (no plan)
const prompt1 = `
You are Xyne, an enterprise search assistant.
Current Date: 2025-01-10

<plan_status>No plan exists. First action: Call toDoWrite to create a plan.</plan_status>

<available_tools>
1. toDoWrite: Create execution plan
2. searchGlobal: Search across all data sources
3. list_custom_agents: Find relevant custom agents
...
</available_tools>

User Query: "What does Alex say about Q4?"
`;

// Stage 2: After planning
const prompt2 = `
You are Xyne, an enterprise search assistant.
Current Date: 2025-01-10

<current_plan>
Goal 1: Identify which Alex [IN PROGRESS]
  - Step 1.1: Search contacts [PENDING]
Goal 2: Search Alex's communications about Q4 [PENDING]
  - Step 2.1: Search Gmail, Slack, Drive [PENDING]
</current_plan>

<tool_history>
1. toDoWrite (50ms, $0.001) - Plan created
</tool_history>

<available_tools>
1. searchGoogleContacts: Search organization contacts
2. searchGmail: Search email
...
</available_tools>

User Query: "What does Alex say about Q4?"
Next Action: Execute Step 1.1 - Search for people named Alex
`;

// Stage 3: After data gathering
const prompt3 = `
You are Xyne, an enterprise search assistant.
Current Date: 2025-01-10

<current_plan>
Goal 1: Identify which Alex [COMPLETED]
  - Step 1.1: Search contacts [COMPLETED] - Found 3 Alexes
Goal 2: Search Alex's communications about Q4 [IN PROGRESS]
  - Step 2.1: Search Gmail, Slack, Drive [COMPLETED] - 47 results
</current_plan>

<tool_history>
1. toDoWrite (50ms, $0.001) - Plan created
2. searchGoogleContacts (234ms, $0.005) - 3 contacts found
3. searchGmail (456ms, $0.012) - 15 emails found
4. getSlackMessages (389ms, $0.008) - 12 messages found
5. searchDriveFiles (512ms, $0.015) - 20 files found
</tool_history>

<gathered_context>
Total fragments: 47
Unique documents: 45
[1] Email from Alex Johnson (alex.j@company.com) - "Q4 targets exceeded by 15%..."
[2] Slack message in #quarterly-review - "Our Q4 performance shows..."
...
</gathered_context>

User Query: "What does Alex say about Q4?"
Next Action: Synthesize answer using gathered context with citations
`;
```

---

## 10. Missing Information & Clarifications Needed

Based on the task requirements, here are areas where additional information would be helpful:

### 10.1 Clarification Tool
- **Status**: Mentioned as available from JAF (like handoff)
- **Question**: What is the exact schema and interface for the clarification tool?
- **Impact**: Need to know how to integrate it into planning phase

### 10.2 Query Rewriting
- **Current**: Task mentions "No write query from LLM for now"
- **Question**: Should query rewriting be done in main prompt or separate tool?
- **Impact**: Affects how we handle ambiguous queries

### 10.3 Substep Creation Timing
- **Question**: "When should substep creation happen?"
- **Answer Based on Design**: 
  - Initial substeps created during planning phase (Turn 1)
  - Additional substeps added via `toDoWrite` during replanning
  - Substeps should be task-goal specific, not granular tool calls
  - Example: ✅ "Identify relevant users" ❌ "Call tool1, call tool2"

### 10.4 runPublicAgent Specifics
- **Question**: How to pass modified queries to custom agents?
- **Design Answer**: Use `runPublicAgent` tool with dedicated `query` parameter
- **Example**: Different queries for different agents based on their specialization

### 10.5 Context Persistence
- **Question**: Should plan state be saved to database for multi-session tasks?
- **Consideration**: Useful for long-running analyses or follow-up queries

---

## 11. Success Criteria

### 11.1 Functional Requirements
- [x] System creates plan before execution
- [x] Parallel tool execution for independent operations
- [x] Sequential execution for dependent operations
- [x] Review mechanism evaluates results
- [x] Replanning capability when needed
- [x] Duplicate detection prevents redundant calls
- [x] Failed tool tracking and removal
- [x] Cost and latency monitoring

### 11.2 Quality Metrics
- Plan creation rate: >95% of queries
- Parallel execution usage: >60% of multi-tool scenarios
- Review accuracy: >85% correct gap identification
- Failed tool recovery: >90% successful replanning
- Duplicate prevention: >99% detection rate

### 11.3 Performance Targets
- Planning overhead: <2 seconds
- Tool selection: <1 second
- Review evaluation: <3 seconds
- Total latency reduction: 20-30% through parallelization

---

## 12. Conclusion

This design provides a comprehensive blueprint for transforming Xyne's MessageWithToolsApi into a sophisticated agentic system leveraging JAF's capabilities. The architecture emphasizes:

1. **Intelligence**: Planning-first approach with dynamic adaptation
2. **Efficiency**: Parallel execution and smart tool selection
3. **Reliability**: Error handling, review cycles, and graceful degradation
4. **Transparency**: Clear logging and reasoning steps
5. **Scalability**: Schema-based design ready for future expansion

The implementation roadmap provides a clear path forward, with each phase building on the previous one. The extensive use of schemas ensures type safety and reliability, while JAF's functional programming paradigm keeps the system maintainable and testable.

---

**Next Steps**: Begin Phase 1 implementation, starting with the AgenticContext structure and toDoWrite tool, which form the foundation for all subsequent features.
