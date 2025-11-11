# MessageWithTools JAF Redesign Plan

## Objectives
- Replace the fragile single-function flow (`server/api/chat/agents.ts:745-2240`) with a modular, agentic pipeline that fully leverages JAF primitives.
- Honor the new orchestration rules (mandatory planning, clarification-first, batched independent tools, sequential dependent tools) while remaining achievable with the existing JAF runtime.
- Introduce structured schemas so every tool call, review step, and prompt injection is machine-auditable (latency, estimated cost, failure counts, context impact).
- Provide a concrete implementation roadmap plus prompt/agent templates so engineering can execute iteratively.

## Current Implementation Findings
1. **Monolithic controller** – `MessageWithToolsApi` mixes auth, context gathering, MCP setup, JAF streaming, synthesis, and SSE writing in one 1.5k-line block (`server/api/chat/agents.ts:745-2240`). The flow is hard to reason about, nearly impossible to extend with review or planning hooks, and duplicates logic already present in other controllers.
2. **Missing planning/clarification layer** – The current system prompt forces “first action must be tool call”, but it never checks if ambiguous requests (e.g., “What does Alex say about Q4?”) should trigger a clarification or person disambiguation flow. There is no `ListCustomAgents`/`runCustomAgents` pre-pass and no Chain-of-Thought (<Plan></Plan>) section to expose planning state.
3. **No tool-call telemetry** – JAF’s `onAfterToolExecution` only tries to dedupe fragments (lines 1823-1909) and discards latency, parameters, connector provenance, or failures. We cannot enforce “skip duplicate parameter calls”, “remove failing tools after 3 attempts”, or “map latency/time/money” without a structured history.
4. **Tool descriptions embedded in code** – Tool metadata is constructed inline (e.g., `buildToolsOverview`, `buildContextSection`), so the LLM instructions cannot include a reusable reference file as requested. There is no single source of truth for tool schemas/usage examples.
5. **Review/iteration logic absent** – We stream JAF events directly to the client but never run a reviewer agent/tool to inspect outputs, re-order pending actions, or mutate the todo/plan. The “plan” concept is implicit and cannot be surfaced in prompts or SSE events.

## Target Architecture Overview
### Phase 0 – Request + Auth Guard
1. **Auth & chat resolution** (unchanged).
2. **Capability gate** – ensure `isAgentic && !enableWebSearch && !deepResearchEnabled` still selects this flow. If not, short-circuit.
3. **Initialize `AgentRunContext`** (schema below) with request metadata, empty `plan`, and `toolCallHistory=[]`.

### Phase 1 – Planning & Clarification
1. **Plan bootstrap (`PlanAgent`)** – Run a light JAF agent (fast model) whose sole tool is `WritePlan` (wrapper around TodoWrite) to:
   - Decide if clarification is required (`needsClarification=true/false`, `clarificationPrompt`).
   - Identify candidate connectors/agents by calling `ListCustomAgentsTool` (new).
   - Produce `<Plan>` tags (goal, substeps) plus `ChainOfThought` text saved in `AgentRunContext.plan`.
2. **Clarification** – If ambiguous user, call `ClarificationTool` (provided by JAF) before any expensive run. The clarifier uses the `clarificationPrompt` and updates context.
3. **Query rewrite rule** – The plan may suggest rewrite instructions, but the main agent prompt must remind the LLM: *“Do not auto-run Query Rewrite Tool. If the plan requires it, surface the rewritten query in <Plan> but keep original user text in execution.”*

### Phase 2 – Execution (MessageWithTools Main Loop)
1. **Tool inventory build**
   - **Internal tools** from `buildInternalJAFTools`.
   - **MCP tools** derived from connectors; also register per-connector MCP sub-agents (one agent per MCP server for plan agent to reason about).
   - **ListCustomAgentsTool** & **RunCustomAgentTool** (new) to orchestrate user-created agents.
   - **ReviewAgent tool** for retrospective analysis.
   - **Clarification tool** (if available from JAF standard library) stays enabled.
   - **Tool description registry** is loaded from a new file `server/api/chat/tool-descriptions.md` and appended to system prompt (see Prompt Strategy).
2. **Dynamic instruction builder**
   - Compose base prompt + `ToolDescriptions` excerpt + `<Plan>` block + `<ToolCallHistory>` snippet.
   - Guarantee mention of “Chain-of-thought approach while planning” by embedding instructions like:
     ```
     <Plan>
       {plan.goal}
       Steps:
       1. ...
     </Plan>
     ```
   - Add example templates for dependent vs independent tool batches.
3. **JAF run config additions**
   - `onBeforeToolExecution` hook to enforce duplicate-parameter guard (schema-driven).
   - `onAfterToolExecution` hook now:
     - Stores `ToolExecutionRecord` (args, latency, estimated cost, success, fragments, tool type, connector).
     - Updates `AgentRunContext.toolCallHistory`.
     - Emits SSE `ChatSSEvents.ToolMetric`.
     - Removes tools after 3 consecutive failures (tracked in context).
   - `onTurnEnd` triggers `ReviewAgent` when `PlanAgent` flagged `needsReview` or when more than N tool calls occur without final answer.
4. **Parallel independent tool calls**
   - When JAF requests multiple tools, partition them:
     - Independent ones (no shared dependency) can be executed concurrently by letting JAF run them in `runStream` (already supported).
     - Dependent ones must be serialized by returning synthetic “waiting” tool responses that instruct the LLM to call them in next turn (documented in prompt examples).

### Phase 3 – Review, Replanning, and Finalization
1. **Reviewer agent** – After each batch (or when flagged), call `ReviewAgentTool` (LLM or rule-based) with:
   - Latest snippets, plan state, tool history.
   - Responsibilities: reorder pending substeps, request clarification/anomaly flags, update plan via `WritePlan`.
2. **RunPublicAgent gating** – Only allow `runPublicAgent` tool after `AgentRunContext` indicates `ambiguityResolved=true`. The clarifier/plan sets this.
3. **Exit criteria**
   - If plan marks `blocked=true` (missing data/anomaly), stream a structured error and stop.
   - If `maxTurns` hit, fallback to baseline RAG and include explanation referencing plan state.

## Agents & Tools
> All schemas include a top-level `status` object so errors can be propagated without exceptions.

### 1. Plan Agent (fast model, e.g., Claude Haiku)
- **Tools**: `WritePlanTool`, `ListCustomAgentsTool`.
- **Output schema**:
```json
{
  "goal": "string",
  "subTasks": [
    {"id": "string", "description": "string", "status": "pending|blocked|done",
     "parallelizable": true, "dependencies": ["id"]}
  ],
  "needsClarification": true,
  "clarificationPrompt": "string|null",
  "candidateAgents": ["agentId"],
  "chainOfThought": "string"
}
```

### 2. Clarification Tool (provided by JAF)
- Use plan output to craft the question.
- Store the resolution in `AgentRunContext.clarifications`.

### 3. ListCustomAgentsTool (new MCP/internal tool)
- **Input schema**:
```json
{
  "query": "string",
  "workspaceId": "string"
}
```
- **Output schema**:
```json
{
  "status": "ok|error",
  "agents": [
    {"id": "string", "name": "string", "domains": ["gmail","slack"], "confidence": 0.0}
  ],
  "error": {"code": "string", "message": "string"}
}
```

### 4. RunCustomAgentTool
- Requires `agentId`, `query`, optional `context`.
- Must check `AgentRunContext.ambiguityResolved` before allowing execution.

### 5. MCP Connector Agents
- For each MCP server, auto-generate an agent descriptor with:
  - `agentName = mcp::<connectorId>`
  - Tools: server tools + `PlanAgent` instructions.
  - Shared prompt snippet referencing tool description file.

### 6. Domain Search Tools
- **GmailSearch**, **SlackSearch**, **CalendarSearch**, **DriveSearch** etc. Each extends `executeVespaSearch` but enforces:
  - Parameter schema (query, filters, excludedIds, owner, timeRange).
  - Metadata fields for latency + cost.
  - Concurrency hints (Gmail vs Slack can run in same turn).

### 7. ReviewAgent Tool
- **Input**: plan, recent tool outputs, anomalies, SSE logs.
- **Output**:
```json
{
  "status": "ok",
  "updatedPlan": {...},        // optional
  "actions": [
    {"type": "clarify", "prompt": "string"},
    {"type": "reorder", "subTaskId": "string", "newIndex": 2},
    {"type": "stop", "reason": "string"}
  ],
  "notes": "string"
}
```

### 8. Tool Description Registry
- New file `server/api/chat/tool-descriptions.md`.
- Format suggestion:
```markdown
## search_gmail
- Summary: ...
- Parameters:
  - query (string, required) – ...
  - from (string, optional)
- Example:
```
- Loader reads this file during server boot, converts to JSON, and feeds into prompt builder + SSE debug panels.

## Core Schemas
### AgentRunContext
```json
{
  "user": {"email": "string", "workspaceId": "string"},
  "chat": {"externalId": "string", "metadata": {...}},
  "message": {"text": "string", "attachments": [], "timestamp": "ISO"},
  "plan": {"goal": "string", "subTasks": [], "chainOfThought": "string"},
  "clarifications": [{"question": "string", "answer": "string"}],
  "ambiguityResolved": false,
  "toolCallHistory": [ToolExecutionRecord],
  "failedTools": {"toolName": {"count": 0, "lastError": "string"}},
  "contextFragments": [MinimalAgentFragment],
  "review": {"lastReviewerSummary": "string", "nextReviewAt": "turn|time"}
}
```

### ToolExecutionRecord
```json
{
  "toolName": "string",
  "connectorId": "string|null",
  "agentName": "string",
  "arguments": "Record<string,unknown>",
  "startedAt": "ISO",
  "durationMs": 0,
  "estimatedCostUsd": 0.0,
  "resultSummary": "string",
  "fragmentsAdded": ["fragmentId"],
  "status": "success|error|skipped",
  "error": {"code": "string", "message": "string"}
}
```

### ToolCallHistory serialization
Embed in prompt as:
```
<ToolCallHistory>
1. search_gmail (success, 4 docs, 1200ms, $0.0023) – looked for "Q4 forecast" in Gmail.
2. search_slack (error INVALID_CHANNEL, retried 3x – disabled)
</ToolCallHistory>
```

## Prompt Strategy
1. **System prompt skeleton**:
```
You are Xyne...
<Plan>{serialized plan}</Plan>
<Clarifications>...</Clarifications>
<ToolCallHistory>...</ToolCallHistory>
Tool Definitions (from file):
{{excerpt}}
Rules:
- State your chain-of-thought in planning only; keep final answers concise.
- Never run QueryRewrite tool automatically.
- Dependent tool calls MUST occur in sequential turns. Independent calls SHOULD be parallelized.
```
2. **Tool descriptions** – append relevant sections from registry based on tools enabled for the run (avoid exceeding token budget by selecting top-N relevant).
3. **Examples** – include short templates demonstrating:
   - `Dependent`: “If calendar event details depend on Gmail search, call Gmail first this turn, then Calendar next turn after summarizing the results in <Plan>.”
   - `Parallel`: “When gathering Gmail and Slack evidence for the same question, request both tools within the same turn.”

## Review & Reordering Examples (“What does Alex say about Q4?”)
1. **Initial plan**: identify `Alex` ambiguity → call Clarification tool to list Alex contacts (ListPeople). If multiple, issue clarifying question.
2. **After Gmail search**: ToolCallHistory shows Gmail results but Slack pending. ReviewAgent notices `subTask slack_q4` still pending → reorders to run Slack before summary.
3. **Replanning**: If Gmail returns nothing, ReviewAgent updates `<Plan>` to add `runPublicAgent` with `agentId=finance-briefing` once ambiguity resolved.
4. **Exit**: If clarification fails thrice, ReviewAgent emits `stop` action -> SSE message instructing user to provide more info.

## Implementation Roadmap
1. **Scaffold context & schema files**
   - Define TypeScript interfaces for `AgentRunContext`, `ToolExecutionRecord`, `PlanState`, `ToolDescription`.
   - Add loader for `tool-descriptions.md`.
2. **Planning layer**
   - Implement `PlanAgent` runner (fast model) + `WritePlanTool` wrapper (backed by TodoWrite storage).
   - Add `ListCustomAgentsTool` & `RunCustomAgentTool`.
3. **Clarification + gating**
   - Wire `ClarificationTool` invocation before main run when `needsClarification`.
   - Track `ambiguityResolved`.
4. **JAF run config refactor**
   - Extract orchestrator into `messageWithToolsOrchestrator.ts` with pluggable hooks.
   - Add before/after tool hooks, telemetry, failure budgets.
5. **Prompt builder enhancements**
   - New module `buildAgentInstructions` that ingests context state + tool descriptions + plan/rescribed tags.
6. **Review agent integration**
   - Implement `ReviewAgentTool`.
   - Hook triggers after each turn / on demand.
7. **SSE + logging updates**
   - New events for tool metrics, plan updates, review actions.
   - Persist `ToolCallHistory` + plan snapshots in DB for replay/debug.
8. **Testing**
   - Unit tests for schema validation + dedupe guard.
   - Integration tests simulating “Alex Q4” + “multi-source search” + “tool failure removal”.

## Open Questions / Risks
1. **Clarification tool availability** – confirm JAF exposes a callable clarification tool. If not, we must implement it as regular tool.
2. **Cost estimation** – we can log `usage.inputTokens/outputTokens` from tool responses, but MCP connectors might not provide cost. Need heuristic.
3. **Parallel execution control** – JAF currently issues tool batch sequentially. Enforcing “independent => same turn” may require plan instructions + provider configuration rather than runtime enforcement.
4. **TodoWrite backing store** – ensure persisted plan survives restarts and does not conflict with client-managed todos.

This plan keeps implementation within current JAF capabilities while layering the requested planning, clarification, telemetry, and review logic in a structured, testable manner.
