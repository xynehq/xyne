# LLM Prompt, Tooling, And Turn Flow

This note traces how a user query becomes an LLM call, what gets injected into the prompt, how tools and sub‑agents behave, and how JAF tracks turns.

## 1. Agent metadata → prompt text
- When a chat is tied to an agent, the DB row is serialized and stored in `agentPromptForLLM` (`server/api/chat/agents.ts:952-979`). This JSON carries the agent's description, doc scopes, and toggles.
- Before each model call we recompute `agentInstructions()`, which stitches together: the current date, hardcoded guardrails (tool-first, cite sources), a tools overview, the live `Context Fragments` list, and an `Agent Constraints` block that embeds the serialized agent (`server/api/chat/agents.ts:1754-1786`).
- Because `agent.instructions` is a thunk, JAF calls it for every turn with the up-to-date run state (`server/api/chat/jaf-provider.ts:48-74`), so any new fragments gathered mid-run appear in the very next prompt.

**What the LLM sees:** a single system message that contains everything above, followed by the conversation history (user + assistant + tool roles) for that run.

## 2. What JAF adds
- We create one JAFAgent called `xyne-agent` whose `instructions` callback is `agentInstructions()` and whose tools are the union of all internal agent tools plus any MCP tools (`server/api/chat/agents.ts:1754-1810`).
- `buildInternalJAFTools` converts each existing `AgentTool` into a JAF tool, turning our parameter metadata into a Zod schema and tagging each tool with a description (`server/api/chat/jaf-adapter.ts:136-182`). MCP tools are adapted the same way, reusing the JSON schema they provide (`server/api/chat/jaf-adapter.ts:203-289`).
- Those schemas are then translated into OpenAI/Anthropic-style function specs via `buildFunctionTools`, so the LLM knows the required argument structure without the agent prompt spelling it out (`server/api/chat/jaf-provider.ts:106-148`).
- JAF itself does **not** inject extra planning prompts. Aside from optional guardrail text (unused here), the only instructions the LLM receives are whatever `agentInstructions()` returns.

## 3. Message + prompt assembly
- `makeXyneJAFProvider` takes the current immutable `RunState` and builds a `LanguageModelV2` prompt by prepending the system instructions and replaying the message history (`server/api/chat/jaf-provider.ts:48-240`).
- Assistant messages that contained tool calls are replayed with `tool-call` parts, and tool results are replayed as `tool` role messages (`server/api/chat/jaf-provider.ts:182-240`). This is how the LLM “remembers” prior tool usage each turn.
- The `RunState` we seed contains every chat message on the thread so far (user + assistant) filtered for errors, so the LLM always sees the full conversation (`server/api/chat/agents.ts:1793-1819`).

## 4. Tool execution + schema guarantees
- The LLM emits tool invocations using the JSON schema advertised in section 2. Responses come back as `ToolResponse.success/error` objects so we can forward both the human-readable summary and any retrieved context chunks (`server/api/chat/jaf-adapter.ts:144-177` and `203-289`).
- After each tool finishes, `onAfterToolExecution` filters/merges the returned `contexts`, optionally ranks them, and extends `gatheredFragments`. Those fragments immediately influence the next system prompt and, later, inline citations (`server/api/chat/agents.ts:1823-1885`).
- There is no separate “format spec” the agent has to remind the LLM about—the JSON schema and tool wiring inside JAF enforce the function-call shape automatically.

## 5. Iterations, turns, and final prompting
- The `runStream` loop emits tracing events such as `turn_start`, `tool_requests`, `tool_call_start/end`, and `turn_end`. We forward those as SSE tokens so the UI shows planning steps (`server/api/chat/agents.ts:1929-2230`).
- Under the hood, a **turn** is defined as one pass through `runInternal`: JAF fires `turn_start`, calls the LLM with the current prompt, lets it request zero or more tools, feeds back the tool results, and finally emits `turn_end` (`server/node_modules/@xynehq/jaf/dist/core/engine.js:341-390`, `680-789`). If the LLM answers without tools, that still counts as a turn.
- Because the system prompt is regenerated every turn, the same instruction scaffold is re-sent along with the entire updated history.

### Example turn progression
1. Turn 1: user question is already in `messages`. JAF calls the model with the system prompt; the model requests `searchGlobal`. Tool runs, returns fragments, and `turn_end` fires.
2. Turn 2: the new fragments appear inside the “Context Fragments” section. The model can either answer or call another tool. The cycle repeats until the model emits a final answer or we hit the `maxTurns` (10 here).

## 6. Handoffs and agent-as-a-tool
- Handoffs are standard JAF behavior: if a tool result sets `isHandoff`, the engine switches `currentAgentName` to the requested agent, emits a `handoff` trace, and immediately reruns the loop with the target agent's own instructions (`server/node_modules/@xynehq/jaf/dist/core/engine.js:715-789`).
- In a handoff, **only** the target agent's instructions become the system prompt for subsequent turns; the parent agent’s text is not concatenated.
- `agentAsTool` spins up a brand-new `RunState` with the child agent's instructions and a single user message equal to the tool input, runs that mini-conversation (default `maxTurns` 5), and returns the child's final answer as the parent tool result (`server/node_modules/@xynehq/jaf/dist/core/agent-as-tool.js:1-74`). The parent counts this as a single tool call inside its current turn, while the child maintains its own internal turn counter.

## 7. What counts as “one turn”?
- Parent turns advance whenever the parent agent calls the LLM (even if the model immediately responds with a final answer). The whole “model output → tool execution(s) → tool results added” sequence is wrapped inside that single turn (`server/node_modules/@xynehq/jaf/dist/core/engine.js:341-789`).
- Sub-agents started via `agentAsTool` run their own mini-loop; their turns do **not** increment the parent counter, they just contribute to the parent tool’s latency metadata.

## 8. Planning or TODO behavior
- JAF exposes guardrail/policy hooks but does not impose planning checklists. Any “plan first, then execute actions, maintain TODOs” logic must live inside the agent instructions you supply (`agentInstructions()` in our case). There is no framework-level prompt that adds TODO directives—see that the system message is the exact string we build (`server/api/chat/jaf-provider.ts:150-240`).

## Quick reference
- Agent metadata serialization: `server/api/chat/agents.ts:952-979`
- Dynamic system prompt assembly: `server/api/chat/agents.ts:1754-1786`
- Tool adaptation + schemas: `server/api/chat/jaf-adapter.ts:136-289`
- Prompt construction per turn: `server/api/chat/jaf-provider.ts:48-240`
- Turn lifecycle + handoffs: `server/node_modules/@xynehq/jaf/dist/core/engine.js:341-789`
- Sub-agent-as-tool behavior: `server/node_modules/@xynehq/jaf/dist/core/agent-as-tool.js:1-74`
