# JAF Practical Implementation: Single Agent with Dynamic Behavior

## Executive Summary

**Important Clarification**: The "Plan Agent", "Review Agent", and "Execute Agent" mentioned in the architecture plan are **NOT separate JAF agents**. They are **different behavioral modes of a SINGLE JAF agent** achieved through dynamic instructions and tools.

This document explains the practical, achievable implementation using JAF's actual capabilities.

---

## Reality Check: JAF's Actual Architecture

### What JAF Provides
```typescript
// JAF supports ONE agent at a time in runStream
const agent: Agent<Context, Output> = {
  name: "xyne-agent",
  instructions: () => "...", // Can be dynamic function
  tools: [...],
  modelConfig: {...}
};

// One agent runs through the stream
for await (const event of runStream(runState, runConfig)) {
  // Process events
}
```

### What We CANNOT Do
❌ Run multiple separate agents simultaneously  
❌ Have "Plan Agent" and "Execute Agent" as separate JAF agents  
❌ Switch between different agent instances during execution  

### What We CAN Do (Practical Approach)
✅ ONE agent with **dynamic instructions** that change based on context  
✅ Different **behavioral phases** (planning, executing, reviewing)  
✅ **Tools that call LLMs** for specialized tasks (like review)  
✅ **Context-driven prompts** that guide agent behavior  

---

## Practical Implementation: Single Agent with Phases

### Architecture Revision

```
┌─────────────────────────────────────────────────────────┐
│                  SINGLE JAF AGENT                        │
│                  "xyne-agent"                            │
│                                                          │
│  ┌────────────────────────────────────────────────┐     │
│  │  Dynamic Instructions Function                 │     │
│  │  (Changes behavior based on context.phase)     │     │
│  └────────────────────────────────────────────────┘     │
│                                                          │
│  Phase-Based Behavior:                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ PLANNING │→ │EXECUTING │→ │REVIEWING │ → Loop       │
│  │  Mode    │  │  Mode    │  │  Mode    │             │
│  └──────────┘  └──────────┘  └──────────┘             │
│                                                          │
│  Tools Available:                                       │
│  • toDoWrite (planning)                                 │
│  • searchGmail, searchDrive, etc. (execution)           │
│  • review_results (calls LLM for review)                │
│  • list_custom_agents (agent selection)                 │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Details

### 1. Single Agent with Dynamic Instructions

```typescript
// Context tracks the current phase
interface JAFAdapterCtx {
  email: string;
  userCtx: string;
  agentPrompt?: string;
  userMessage: string;
  
  // Phase management
  phase: 'planning' | 'executing' | 'reviewing' | 'synthesizing';
  plan: TodoPlan | null;
  toolCallHistory: ToolCallRecord[];
  gatheredFragments: MinimalAgentFragment[];
  // ... other context
}

// ONE agent with dynamic instructions
const xyneAgent: Agent<JAFAdapterCtx, string> = {
  name: "xyne-agent",
  
  // Instructions change based on context.phase
  instructions: (context) => {
    const baseInstructions = getBaseInstructions(context);
    
    // Add phase-specific instructions
    switch (context.phase) {
      case 'planning':
        return baseInstructions + getPlanningInstructions(context);
      
      case 'executing':
        return baseInstructions + getExecutingInstructions(context);
      
      case 'reviewing':
        return baseInstructions + getReviewingInstructions(context);
      
      case 'synthesizing':
        return baseInstructions + getSynthesizingInstructions(context);
      
      default:
        return baseInstructions;
    }
  },
  
  tools: allTools, // All tools available, but instructions guide usage
  modelConfig: { name: defaultBestModel }
};
```

### 2. Phase-Specific Instructions

```typescript
function getPlanningInstructions(ctx: JAFAdapterCtx): string {
  return `
<phase>PLANNING</phase>

CURRENT OBJECTIVE: Create an execution plan

REQUIRED ACTION:
- You MUST call the toDoWrite tool to create a plan
- Break the task into clear, actionable goals
- For each goal, define specific steps
- Indicate if steps should run in parallel or sequentially

Do NOT execute tools yet - only plan the approach.
`;
}

function getExecutingInstructions(ctx: JAFAdapterCtx): string {
  const plan = ctx.plan ? formatPlan(ctx.plan) : 'No plan available';
  
  return `
<phase>EXECUTING</phase>

CURRENT OBJECTIVE: Execute the plan to gather information

YOUR PLAN:
${plan}

EXECUTION GUIDELINES:
- Execute tools based on the current step in your plan
- For independent operations: Call multiple tools in the SAME turn (parallel)
- For dependent operations: Call tools in DIFFERENT turns (sequential)
- Track what you've gathered in each step

After gathering sufficient data, proceed to REVIEW phase.
`;
}

function getReviewingInstructions(ctx: JAFAdapterCtx): string {
  return `
<phase>REVIEWING</phase>

CURRENT OBJECTIVE: Evaluate gathered information

GATHERED SO FAR:
- ${ctx.gatheredFragments.length} fragments
- ${ctx.toolCallHistory.length} tool calls completed

REVIEW TASKS:
1. Call review_results tool to evaluate quality and completeness
2. Based on review:
   - If sufficient: Move to SYNTHESIZING phase
   - If gaps exist: Call toDoWrite to adjust plan, return to EXECUTING
   - If unrecoverable: Move to SYNTHESIZING with what you have

Do NOT answer the user yet - only review and decide next steps.
`;
}

function getSynthesizingInstructions(ctx: JAFAdapterCtx): string {
  return `
<phase>SYNTHESIZING</phase>

CURRENT OBJECTIVE: Generate final answer for the user

AVAILABLE CONTEXT:
${buildContextSection(ctx.gatheredFragments)}

SYNTHESIS GUIDELINES:
- Use gathered contexts to answer the user's query
- ALWAYS cite sources using [n] notation
- Be concise and accurate
- If information is incomplete, acknowledge limitations
- This is your FINAL response - do not call more tools
`;
}
```

### 3. Phase Transitions via Context Updates

```typescript
const runConfig: JAFRunConfig<JAFAdapterCtx> = {
  agentRegistry,
  modelProvider,
  maxTurns: 15,
  
  onAfterToolExecution: async (toolName, result, hookContext) => {
    const { state } = hookContext;
    
    // Automatic phase transitions based on tool usage
    if (toolName === 'toDoWrite' && state.context.phase === 'planning') {
      // Plan created, move to execution
      state.context.phase = 'executing';
      state.context.plan = result.metadata?.plan;
    }
    
    if (toolName === 'review_results') {
      const reviewResult = result.data as ReviewResult;
      
      if (reviewResult.recommendation === 'proceed') {
        // Good to synthesize
        state.context.phase = 'synthesizing';
      } else if (reviewResult.recommendation === 'gather_more') {
        // Need more data, back to executing
        state.context.phase = 'executing';
      }
    }
    
    // Check if we have enough data after each execution tool
    if (state.context.phase === 'executing') {
      const toolsExecuted = state.context.toolCallHistory.length;
      const fragmentsGathered = state.context.gatheredFragments.length;
      
      // After executing several tools, trigger review
      if (toolsExecuted >= 3 && fragmentsGathered > 0) {
        state.context.phase = 'reviewing';
      }
    }
    
    // ... rest of hook logic
  }
};
```

### 4. Review Tool (Not a Separate Agent!)

The "Reviewer Agent" is actually a **tool** that internally calls an LLM:

```typescript
const reviewResultsTool: Tool<ReviewInput, JAFAdapterCtx> = {
  schema: {
    name: 'review_results',
    description: 'Evaluate the quality and completeness of gathered information',
    parameters: z.object({
      currentGoal: z.string(),
      gatheredContexts: z.array(z.any())
    })
  },
  
  async execute(args, context) {
    // This tool INTERNALLY uses an LLM to review
    // It's NOT a separate JAF agent, just a tool that calls the model provider
    
    const reviewPrompt = `
You are a quality evaluator. Review the following gathered information:

User Query: ${context.userMessage}
Current Goal: ${args.currentGoal}

Gathered Contexts:
${args.gatheredContexts.map((c, i) => `[${i+1}] ${c.content}`).join('\n')}

Evaluate:
1. Completeness (0-1): Do we have enough information?
2. Relevance (0-1): Is the information relevant to the query?
3. Quality (0-1): Is the information reliable?

Provide:
- Overall quality score
- Gaps identified
- Recommendation: proceed | gather_more | clarify_query | replan

Return as JSON.
    `;
    
    // Call LLM directly (not through JAF agent)
    const reviewResponse = await modelProvider.getCompletion({
      messages: [{ role: 'user', content: reviewPrompt }],
      model: 'gpt-4',
      response_format: { type: 'json_object' }
    });
    
    const evaluation = JSON.parse(reviewResponse.content);
    
    return ToolResponse.success('Review completed', {
      evaluation,
      recommendation: evaluation.recommendation,
      qualityScore: evaluation.qualityScore
    });
  }
};
```

---

## Complete Flow Example

```typescript
// Initialize with PLANNING phase
const initialContext: JAFAdapterCtx = {
  email: user.email,
  userCtx: userContext,
  userMessage: message,
  phase: 'planning', // Start in planning
  plan: null,
  toolCallHistory: [],
  gatheredFragments: [],
  seenDocuments: new Set(),
  failedTools: new Map()
};

const runState: JAFRunState<JAFAdapterCtx> = {
  runId: generateRunId(),
  traceId: generateTraceId(),
  messages: initialMessages,
  currentAgentName: 'xyne-agent', // ALWAYS the same agent
  context: initialContext,
  turnCount: 0
};

// Run the SINGLE agent
for await (const evt of runStream(runState, runConfig)) {
  switch (evt.type) {
    case 'turn_start':
      // Agent decides what to do based on current phase in context
      const currentPhase = evt.data.state.context.phase;
      console.log(`Turn ${evt.data.turn} - Phase: ${currentPhase}`);
      break;
      
    case 'tool_call_end':
      // Phase might change after tool execution
      // (handled in onAfterToolExecution hook)
      break;
      
    case 'assistant_message':
      // Agent's response, guided by phase-specific instructions
      break;
  }
}
```

---

## Why This Approach Works

### 1. Single Agent = Simpler State Management
- One RunState to track
- No coordination between agents needed
- JAF's turn management works naturally

### 2. Dynamic Instructions = Flexible Behavior
- Same agent, different instructions per phase
- Instructions update automatically based on context
- Agent "knows" what to do in each phase

### 3. Tools for Specialization
- Review logic in a tool (can use LLM internally)
- Planning logic in toDoWrite tool
- Each tool is a specialized capability

### 4. Context-Driven Everything
- Phase stored in context
- Plan stored in context
- History stored in context
- One source of truth

---

## Comparison: Original Plan vs. Practical Implementation

### Original Plan (Conceptual)
```
Plan Agent → Execute Agent → Review Agent → Replan
   ↓             ↓               ↓            ↓
Separate      Separate       Separate     Different
JAF Agent     JAF Agent      JAF Agent    Agents
```

### Practical Implementation (Actual)
```
Single JAF Agent with Dynamic Behavior
         ↓
    Phase: Planning
    Instructions emphasize: Create plan with toDoWrite
         ↓
    Phase: Executing  
    Instructions emphasize: Execute tools based on plan
         ↓
    Phase: Reviewing
    Instructions emphasize: Call review_results tool
         ↓
    Phase: Synthesizing
    Instructions emphasize: Generate final answer
```

---

## Key Takeaways

1. **One Agent, Multiple Modes**: Not separate agents, but one agent with different behavioral phases

2. **Dynamic Instructions**: The "agent's personality" changes based on context.phase

3. **Tools Are Capabilities**: Review, planning, etc. are tools, not agents

4. **Context Is State**: Everything tracked in one context object

5. **JAF Handles Execution**: We just configure the agent and hooks properly

---

## Implementation Checklist

- [ ] Create phase enum: `'planning' | 'executing' | 'reviewing' | 'synthesizing'`
- [ ] Add phase to JAFAdapterCtx
- [ ] Implement dynamic instructions function with phase switching
- [ ] Create phase-specific instruction builders
- [ ] Implement phase transition logic in onAfterToolExecution hook
- [ ] Create review_results tool (calls LLM internally)
- [ ] Test phase transitions with simple queries
- [ ] Add phase to streaming events for frontend display
- [ ] Document phase flow for team

---

## Conclusion

The architecture plan's "separate agents" concept translates to:
- **One JAF agent** (xyne-agent)
- **Four behavioral phases** (planning, executing, reviewing, synthesizing)
- **Dynamic instructions** that change per phase
- **Specialized tools** (including review tool that uses LLM)

This is **100% achievable with JAF** and actually simpler than trying to orchestrate multiple agents. It leverages JAF's strengths:
- Single agent execution model
- Dynamic instructions
- Rich tool system
- Context management
- Hooks for state updates

The result is a sophisticated agentic system that *behaves* as if it has specialized sub-agents, but is implemented as one agent with intelligent phase-based behavior.
