# Pi-Mono Turn-End Race Condition: Deep Analysis & Solution

> **Date:** March 28, 2026  
> **Scope:** `server/api/chat/pi-mono/pi-mono-extension.ts`, `xyne-handlers.ts`, `core/runtime.ts`  
> **SDK:** `@mariozechner/pi-coding-agent` + `@mariozechner/pi-agent-core`

---

## 1. Executive Summary

The `turn_end` extension handler in `pi-mono-extension.ts` performs critical async work (LLM-based fragment ranking, automatic review) but **does NOT block the agent loop**. The agent proceeds to the next turn before ranking/review complete. This is a fundamental architectural issue caused by how pi-mono's event system dispatches events to extensions.

**Impact:** Review results are never available when the next turn starts. Ranked fragments may not be in `state.allFragments` before the agent uses them. The review system is effectively non-functional.

---

## 2. Root Cause: SDK Event Dispatch Architecture

### 2.1 The Agent Loop (pi-agent-core)

The agent loop in `agent-loop.ts` runs this sequence per turn:

```
┌─────────────────────────────────────────────────────────────────┐
│  while (hasMoreToolCalls || pendingMessages.length > 0) {       │
│    1. emit(turn_start)                                          │
│    2. Process pending/steering messages                         │
│    3. streamAssistantResponse()  ← calls transformContext       │
│    4. Execute tool calls (parallel or sequential)               │
│    5. emit(turn_end)                                            │
│    6. pendingMessages = getSteeringMessages()                   │
│  }                                                              │
│  emit(agent_end)                                                │
└─────────────────────────────────────────────────────────────────┘
```

**Key:** `emit()` in the loop is the `AgentEventSink` callback, which is `async (event) => this._processLoopEvent(event)`.

### 2.2 The Event Dispatch Chain

Events flow through **three layers**, each with different blocking semantics:

```
Layer 1: Agent Loop (agent-loop.ts)
  │  await emit(turn_end)
  ▼
Layer 2: Agent._processLoopEvent() [SYNCHRONOUS - returns void]
  │  Updates agent state (pendingToolCalls, error, etc.)
  │  Calls this.emit(event) → fires to all listeners synchronously
  ▼
Layer 3a: AgentSession._handleAgentEvent [SYNCHRONOUS listener]
  │  Chains onto _agentEventQueue (background promise chain)
  │  Returns void immediately
  ▼
Layer 3b: _agentEventQueue → _processAgentEvent() [BACKGROUND]
  │  await _emitExtensionEvent(event)  ← ExtensionRunner.emit()
  │  _emit(event) → external subscribers (Xyne event router)
  ▼
Layer 4: ExtensionRunner.emit() [AWAITED within queue, but queue is background]
  │  Iterates extensions, await handler(event, ctx) for each
  ▼
Layer 5: Extension turn_end handler [AWAITED by runner, but runner is in background]
```

### 2.3 The Race Condition

```
TIME →

Agent Loop:     emit(turn_end) ─→ getSteeringMessages() ─→ turn_start ─→ transformContext ─→ LLM call
                     │                                                          │
                     │ synchronous fire-and-forget                              │ BLOCKING (awaited)
                     ▼                                                          ▼
Background:    _agentEventQueue ─→ _processAgentEvent ─→ runner.emit ─→ extension turn_end
Queue:              │                                                          │
                    │                                                     ranking... review...
                    │                                              (STILL RUNNING when next LLM call fires)
```

**The agent loop's `emit(turn_end)` resolves immediately** because `_processLoopEvent` is synchronous. The extension handler runs in `_agentEventQueue`, which is a background promise chain. The loop doesn't wait for it.

### 2.4 Evidence in Source Code

**`pi-agent-core/src/agent.ts`** (line 608):
```typescript
private emit(e: AgentEvent) {
    for (const listener of this.listeners) {
        listener(e);  // Synchronous call - doesn't await
    }
}
```

**`pi-coding-agent/src/core/agent-session.ts`** (line 393-407):
```typescript
private _handleAgentEvent = (event: AgentEvent): void => {
    this._createRetryPromiseForAgentEnd(event);
    // Queues async work - does NOT block
    this._agentEventQueue = this._agentEventQueue.then(
        () => this._processAgentEvent(event),
        () => this._processAgentEvent(event),
    );
    this._agentEventQueue.catch(() => {});
};
```

**`pi-coding-agent/src/core/agent-session.ts`** (line 440-462):
```typescript
private async _processAgentEvent(event: AgentEvent): Promise<void> {
    // ... 
    await this._emitExtensionEvent(event);  // Extensions run HERE
    this._emit(event);  // External subscribers run HERE
    // ...
}
```

---

## 3. What DOES Block in the Agent Loop

### 3.1 `transformContext` → Extension `context` Event ✅ BLOCKS

```
sdk.ts:
  transformContext: async (messages) => {
      return runner.emitContext(messages);  // Called DIRECTLY in agent loop
  }

agent-loop.ts → streamAssistantResponse():
  let messages = context.messages;
  if (config.transformContext) {
      messages = await config.transformContext(messages, signal);  // AWAITED
  }
  // Then calls LLM with these messages
```

The `context` event fires **before every LLM call** and the agent loop **awaits its result**. This is the SDK's intended blocking hook for context manipulation.

### 3.2 `beforeToolCall` / `afterToolCall` ✅ BLOCKS

```
agent-loop.ts → prepareToolCall():
  if (config.beforeToolCall) {
      const beforeResult = await config.beforeToolCall(context, signal);  // AWAITED
  }

agent-loop.ts → finalizeExecutedToolCall():
  if (config.afterToolCall) {
      const afterResult = await config.afterToolCall(context, signal);  // AWAITED
  }
```

Set directly on the `Agent` instance, these hooks run **inside the agent loop** and are **fully awaited**.

### 3.3 `getSteeringMessages` / `getFollowUpMessages` ✅ BLOCKS

Called between `turn_end` and the next `turn_start`:
```
await emit({ type: "turn_end", ... });
pendingMessages = (await config.getSteeringMessages?.()) || [];
```

### 3.4 Summary: What Blocks vs What Doesn't

| Hook | Location | Blocks Loop? | When Called |
|------|----------|-------------|-------------|
| `context` event (extension) | Via `transformContext` | ✅ **YES** | Before each LLM call |
| `beforeToolCall` | Direct on Agent | ✅ **YES** | Before each tool execution |
| `afterToolCall` | Direct on Agent | ✅ **YES** | After each tool execution |
| `getSteeringMessages` | Agent loop config | ✅ **YES** | After turn_end, before next turn |
| `turn_end` event (extension) | Via `_agentEventQueue` | ❌ **NO** | Background after turn ends |
| `turn_start` event (extension) | Via `_agentEventQueue` | ❌ **NO** | Background after turn starts |
| `tool_execution_end` (extension) | Via `_agentEventQueue` | ❌ **NO** | Background after tool ends |
| Xyne event router handlers | Via `_emit()` | ❌ **NO** | Background (after extensions) |

---

## 4. Solution Options

### Option A: Context-Driven Processing Gate (⭐ RECOMMENDED)

**Principle:** Move all critical processing (ranking, review) from `turn_end` into the `context` event handler. Since `context` fires before every LLM call and IS blocking, this guarantees processing completes before the agent uses the results.

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│  Turn N                                                         │
│                                                                 │
│  turn_start                                                     │
│    │                                                            │
│    ▼                                                            │
│  context event (BLOCKING) ──────────────────────────────┐       │
│    │  • Rank fragments accumulated from Turn N-1        │       │
│    │  • Run review if triggers met                      │       │
│    │  • Inject review steering messages                 │       │
│    │  • Update state.allFragments                       │       │
│    │  • Return modified messages                        │       │
│    ▼                                                    │       │
│  LLM call (uses updated context)                        │       │
│    │                                                    │       │
│    ▼                                                    │       │
│  Tool execution                                         │       │
│    │  afterToolCall: collect fragments → pending buffer  │       │
│    ▼                                                    │       │
│  turn_end (LIGHTWEIGHT - fire-and-forget)               │       │
│    │  • Mark needsProcessing = true                     │       │
│    │  • Basic cleanup / turn counter                    │       │
│    │  • NO ranking, NO review                           │       │
│    ▼                                                    │       │
│  getSteeringMessages                                    │       │
│    ▼                                                    │       │
│  Turn N+1 → context event processes Turn N's fragments  │       │
└─────────────────────────────────────────────────────────────────┘
```

**Key changes to `pi-mono-extension.ts`:**
- `tool_execution_end`: Keep accumulating fragments (same as now)
- `turn_end`: Set `needsProcessing = true`, basic counter/cleanup ONLY
- `context`: **ADD** - If `needsProcessing`, do ranking + review + message injection

**Pros:**
- Zero race conditions (all blocking hooks)
- Clean separation: collection (tool_execution_end) → processing (context) → cleanup (turn_end)
- Uses the SDK's intended architecture
- No promise gymnastics
- Review results are immediately available to the LLM

**Cons:**
- Processing timing shifts (from "after turn" to "before next turn's LLM call")
- First turn has no processing needed (no previous fragments) - not an issue
- If agent stops after last turn, last turn's fragments won't be ranked - but the agent already generated its response with them via `synthesizeFinalAnswer` which accesses `state.allFragments` directly

---

### Option B: Promise Gate in `context` Event

**Principle:** Keep ranking/review in `turn_end`, but add a promise-based synchronization gate in the `context` handler.

**How it works:**
```typescript
let turnEndProcessingPromise: Promise<void> | null = null;

pi.on("turn_end", async (event, ctx) => {
    // Create promise SYNCHRONOUSLY (before any await)
    turnEndProcessingPromise = new Promise((resolve) => { turnEndResolve = resolve; });
    
    try {
        await doRanking();     // Async work
        await doReview();      // Async work
        cleanup();
    } finally {
        turnEndResolve!();
        turnEndProcessingPromise = null;
    }
});

pi.on("context", async (event, ctx) => {
    // GATE: Block until turn_end processing completes
    if (turnEndProcessingPromise) {
        await turnEndProcessingPromise;
    }
    // Now ranking/review results are available
    // Inject steering messages
    return { messages: event.messages };
});
```

**Why this is safe (microtask ordering analysis):**

1. Agent loop calls `emit(turn_end)` → `_processLoopEvent` → fires `_handleAgentEvent`
2. `_handleAgentEvent` chains onto `_agentEventQueue` via `.then()` → queued as **microtask M1**
3. Agent loop continues to `await getSteeringMessages()` → queued as **microtask M2**
4. **M1 runs first** (FIFO ordering): starts `_processAgentEvent` → `runner.emit(turn_end)` → extension handler creates `turnEndProcessingPromise` synchronously, then starts async ranking
5. **M2 runs**: loop continues → eventually reaches `streamAssistantResponse` → `transformContext` → `emitContext` → extension `context` handler checks `turnEndProcessingPromise` → **it exists** → awaits it
6. Ranking/review complete → promise resolves → `context` handler continues

**Pros:**
- Minimal code restructuring
- Same logical flow as current code
- Guaranteed by JavaScript microtask ordering

**Cons:**
- More complex synchronization code
- Relies on understanding microtask ordering (harder to maintain)
- If SDK changes event queue implementation, could break

---

### Option C: Use Agent.steer() for Review Results

**Principle:** After turn-end processing, inject review steering via the SDK's built-in `steer()` method.

```typescript
// After review completes in turn_end handler:
const piSession = getUnderlyingSession();
piSession.agent.steer({
    role: "user",
    content: [{ type: "text", text: reviewSteeringMessage }],
    timestamp: Date.now(),
});
```

The agent loop's `getSteeringMessages()` will pick this up after `turn_end` and inject it before the next LLM call.

**Pros:**
- Uses SDK's native mechanism
- Steering messages are properly sequenced

**Cons:**
- Only solves steering message injection, not fragment ranking timing
- Steering messages appear as "user" role, not system
- Requires access to the underlying pi-mono session from the extension
- Does NOT block - if ranking is slow, the steering message might be empty

---

### Option D: Abandon Extension, Use Direct Hooks Only

**Principle:** Remove `pi-mono-extension.ts` entirely. Consolidate all logic into:
- `afterToolCall` hook for fragment collection
- `beforeToolCall` hook for state injection  
- A custom `transformContext` wrapper for ranking/review

**Pros:**
- All hooks are guaranteed blocking
- No extension timing issues
- Simpler architecture

**Cons:**
- Major refactoring
- Loses the clean separation of the extension model
- `transformContext` is set by the SDK's `createAgentSession` - overriding it requires forking or wrapping
- `afterToolCall` runs per-tool, not per-turn (ranking needs all tools' results)

---

### Option E: Hybrid - Option A + Safety Gate from Option B

**Principle:** Primary processing in `context` (Option A), with a defensive promise gate (Option B) as safety net.

This is the most robust approach but adds complexity.

---

## 5. Recommended Implementation: Option A (Context-Driven Processing)

### 5.1 Detailed Changes

#### `pi-mono-extension.ts` - Restructured

```typescript
export default function piMonoTurnProcessor(pi: ExtensionAPI) {
    // ── Accumulators (populated by tool_execution_end, drained by context) ──
    const pendingFragments: MinimalAgentFragment[] = [];
    const toolExecutions: any[] = [];
    let executionToolsCalled = 0;
    let todoWriteCalled = false;
    let needsProcessing = false;  // Flag set by turn_end, checked by context

    // ── Fragment collection (unchanged) ──
    pi.on("tool_execution_end", async (event, ctx) => {
        // Same as current: collect fragments, track tool types
        // ... (no changes needed)
    });

    // ── PRE-LLM PROCESSING GATE (NEW - this is where the magic happens) ──
    pi.on("context", async (event, ctx) => {
        const state = extensionStateRef;
        if (!state) return;

        // Only process if turn_end flagged it
        if (!needsProcessing || pendingFragments.length === 0) {
            // Still check for max turns, steering injection, etc.
            return handleContextDefaults(event, state);
        }

        const { xyneState, currentTurn, agenticModelId, message, email, emitReasoningStep } = state;
        const turnIndex = currentTurn.value;

        try {
            // ── Step 1: Batch fragment ranking (was in turn_end) ──
            const selectedFragments = await rankPendingFragments(
                pendingFragments, message, xyneState, emitReasoningStep
            );
            
            if (selectedFragments.length > 0) {
                xyneState.allFragments.push(...selectedFragments);
                xyneState.turnFragments.set(turnIndex, selectedFragments);
            }

            // ── Step 2: Review (was in turn_end) ──
            await performTurnReview(
                xyneState, turnIndex, toolExecutions, agenticModelId, emitReasoningStep
            );

            // ── Step 3: Inject review steering messages ──
            const modifiedMessages = [...event.messages];
            if (xyneState.review?.lastReviewResult) {
                const steeringContent = buildReviewSteeringMessage(
                    xyneState.review.lastReviewResult
                );
                modifiedMessages.push({
                    role: "user",
                    content: [{ type: "text", text: steeringContent }],
                } as any);
            }

            // ── Step 4: Clear accumulators ──
            pendingFragments.length = 0;
            toolExecutions.length = 0;
            executionToolsCalled = 0;
            todoWriteCalled = false;
            needsProcessing = false;

            return { messages: modifiedMessages };
        } catch (error) {
            Logger.error({ error, turn: turnIndex }, 
                "[Pi-Mono Extension] Error in context processing");
            needsProcessing = false;
            return { messages: event.messages };
        }
    });

    // ── LIGHTWEIGHT TURN-END (no async LLM calls) ──
    pi.on("turn_end", async (event, ctx) => {
        const state = extensionStateRef;
        if (!state) return;

        const { xyneState, currentTurn } = state;
        const turnIndex = currentTurn.value;

        // Skip if final synthesis locked
        if (xyneState.review.lockedByFinalSynthesis && 
            xyneState.review.lockedAtTurn === turnIndex) {
            cleanupTurnArtifacts(xyneState, turnIndex);
            return;
        }

        // No-op detection
        const isNoOpTurn = executionToolsCalled === 0 && todoWriteCalled;
        const isReasoningOnlyTurn = executionToolsCalled === 0 && !todoWriteCalled;

        if (isNoOpTurn || isReasoningOnlyTurn) {
            cleanupTurnArtifacts(xyneState, turnIndex);
            return;
        }

        // Transfer tool executions to history (lightweight, no LLM calls)
        toolExecutions.forEach((exec) => {
            xyneState.toolCallHistory.push({
                ...exec,
                turnNumber: turnIndex,
                startedAt: new Date(),
                durationMs: 0,
                estimatedCostUsd: 0,
            });
        });

        // Flag for context handler to process before next LLM call
        needsProcessing = true;

        // Basic cleanup (non-critical)
        clearAttachmentPhase(xyneState);
        finalizeTurnImages(xyneState, turnIndex);
        xyneState.pendingExpectations.length = 0;
    });
}
```

### 5.2 Why This Works

1. **`tool_execution_end`** runs in background queue → collects fragments into `pendingFragments` buffer
2. **`turn_end`** runs in background queue → sets `needsProcessing = true`, does lightweight cleanup
3. **`context`** runs in agent loop (BLOCKING) → checks `needsProcessing`, performs ranking/review
4. Because `_agentEventQueue` processes `turn_end` before the loop reaches `transformContext` (proven by microtask FIFO ordering), the `needsProcessing` flag is guaranteed to be set

**Microtask ordering proof:**
```
emit(turn_end) fires synchronously:
  → _handleAgentEvent chains _processAgentEvent onto queue (microtask M1)
Agent loop continues:
  → await getSteeringMessages() (microtask M2)
  
M1 runs first (FIFO): _processAgentEvent → _emitExtensionEvent → runner.emit
  → extension turn_end handler runs: sets needsProcessing = true
  → extension tool_execution_end handlers already ran (earlier events)

M2 runs: loop continues → turn_start → streamAssistantResponse → transformContext
  → runner.emitContext → extension context handler
  → checks needsProcessing → TRUE → does ranking/review
```

### 5.3 Edge Cases Handled

| Edge Case | Handling |
|-----------|----------|
| No-op turn (only toDoWrite) | `turn_end` detects, skips flagging |
| Reasoning-only turn (no tools) | `turn_end` detects, skips flagging |
| Final synthesis locked | `turn_end` skips, cleanup only |
| Max turns exceeded | `context` handler injects force-synthesis message |
| Agent stops after last turn | Last turn's fragments already used by synthesizeFinalAnswer |
| First turn (no previous fragments) | `context` sees `needsProcessing = false`, skips |
| Multiple tools in one turn | All fragments accumulated before `turn_end` flags |

---

## 6. Files Affected

| File | Change |
|------|--------|
| `server/api/chat/pi-mono/pi-mono-extension.ts` | Major restructure: move ranking/review from `turn_end` to `context` |
| `server/api/chat/pi-mono/xyne-handlers.ts` | Minor: update `turn_end` comments, remove stale notes |
| `server/api/chat/pi-mono/message-agents.ts` | None (afterToolCall/beforeToolCall hooks unchanged) |
| `server/api/chat/pi-mono/core/runtime.ts` | None (extension registration unchanged) |
| `server/api/chat/pi-mono/review.ts` | None (review functions unchanged, just called from different location) |

---

## 7. SDK Hooks Reference (for future development)

### Hooks that BLOCK the agent loop:

```typescript
// 1. transformContext → extension context event
//    Called before every LLM call
agent = new Agent({
    transformContext: async (messages) => {
        return runner.emitContext(messages);
    }
});

// 2. beforeToolCall - called before each tool execution
agent.setBeforeToolCall(async (context) => {
    // Can modify args, block execution
    return { block: false };
});

// 3. afterToolCall - called after each tool execution
agent.setAfterToolCall(async (context) => {
    // Can modify result
    return { content: modifiedContent };
});

// 4. getSteeringMessages - called between turns
config.getSteeringMessages = async () => {
    return agent.dequeueSteeringMessages();
};

// 5. Agent.steer() - inject messages between turns
piSession.agent.steer({
    role: "user",
    content: [{ type: "text", text: "Do X next" }],
    timestamp: Date.now(),
});
```

### Hooks that DON'T block:

```typescript
// Extension events via pi.on() - all fire-and-forget from loop perspective:
pi.on("turn_end", handler);        // ❌ Non-blocking
pi.on("turn_start", handler);      // ❌ Non-blocking
pi.on("tool_execution_end", handler); // ❌ Non-blocking
pi.on("agent_start", handler);     // ❌ Non-blocking
pi.on("agent_end", handler);       // ❌ Non-blocking

// Exception: context event IS blocking (wired through transformContext)
pi.on("context", handler);         // ✅ BLOCKING (special case)
```

---

## 8. Testing Strategy

1. **Unit test:** Verify `context` handler performs ranking when `needsProcessing = true`
2. **Unit test:** Verify `context` handler is no-op when `needsProcessing = false`
3. **Integration test:** Run multi-turn agent, verify fragments are ranked before next LLM call
4. **Timing test:** Add logging timestamps to confirm `turn_end` flag is set before `context` checks it
5. **Review test:** Verify review steering messages appear in LLM context on next turn

---

## 9. Decision Log

| Date | Decision | Reason |
|------|----------|--------|
| 2026-03-28 | Confirmed `turn_end` extension handler is non-blocking | Traced through SDK source: agent-loop.ts → agent.ts → agent-session.ts → extensions/runner.ts |
| 2026-03-28 | Confirmed `context` event IS blocking | Wired through `transformContext` in sdk.ts, called directly in agent-loop.ts |
| 2026-03-28 | Chose Option A (Context-Driven) over Option B (Promise Gate) | Simpler, no promise gymnastics, uses SDK's intended architecture |
| 2026-03-28 | Confirmed microtask ordering guarantees flag visibility | `_agentEventQueue.then()` (M1) queued before `await getSteeringMessages()` (M2) by FIFO |

---

## 10. Is `synthesizeFinalAnswer` the Right Pattern? (Citations vs Compaction)

### 10.1 The Problem: Compaction Destroys Citation Evidence

Pi-mono's compaction is **enabled** in the Xyne runtime ([core/runtime.ts, line 106](server/api/chat/pi-mono/core/runtime.ts#L106)):

```typescript
SettingsManager.inMemory({
    compaction: { enabled: true },
})
```

When compaction fires (context overflow or threshold), it:

1. **Serializes the entire conversation** (user messages, assistant messages, tool results) into a text blob
2. **Calls an LLM** to generate a structured summary (Goal, Progress, Key Decisions, Next Steps, Critical Context)
3. **Replaces all messages** with the summary via `agent.replaceMessages(sessionContext.messages)`
4. The original tool results — which contain the **raw fragment content, docIds, chunk indexes** — are **permanently lost** from the agent's context window

The compaction summary format (from `compaction.ts`) is:

```
## Goal
[What is the user trying to accomplish?]

## Progress
### Done
- [x] [Completed tasks]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Critical Context
- [Data, examples, or references needed to continue]
```

**This summary has zero citation information.** No `K[citationDocId_chunkIndex]` references, no fragment IDs, no source metadata. It's a narrative summary designed for a coding agent that needs to remember what files it edited, not a RAG agent that needs to cite specific document chunks.

### 10.2 Why `synthesizeFinalAnswer` Is Correct (and Necessary)

The `synthesizeFinalAnswer` tool is architecturally sound for the following reasons:

#### A. It Bypasses the Agent's Context Window Entirely

The synthesis tool does **NOT** use the pi-mono agent's message history for generating the final answer. Instead, it:

1. Reads `xyneState.allFragments` — the **side-channel state** that lives outside pi-mono's context window
2. Calls `buildFinalSynthesisPayload()` which formats all fragments with proper `citationDocId` headers and chunk indexes
3. Makes a **separate LLM call** (using `getProviderByModel()`, typically GPT-4o) with the full fragment content
4. Streams directly to the user via `runtime.streamAnswerText()`

This means even if pi-mono's context has been compacted 5 times, the fragments in `xyneState.allFragments` are **untouched** — they were never in the agent's message history to begin with.

#### B. The Citation Flow is a Closed Loop

```
┌──────────────────────────────────────────────────────────────────┐
│  1. Tools (searchGlobal, searchDrive, etc.) find documents       │
│     → Return fragments with {id, content, source: Citation}     │
│                                                                  │
│  2. afterToolCall hook stores fragments in xyneState.allFragments│
│     (side-channel, NEVER enters pi-mono's message history)       │
│                                                                  │
│  3. Extension context event ranks fragments (LLM call)           │
│     → Updates xyneState.allFragments with best subset            │
│                                                                  │
│  4. Agent calls synthesizeFinalAnswer()                          │
│     │                                                            │
│     ▼                                                            │
│  5. buildFinalSynthesisPayload() reads xyneState.allFragments    │
│     → Formats with citationDocId headers: "index {citationDocId: 1} ..."│
│     → Chunk indexes preserved: "[0] content... [1] content..."   │
│     → Returns citationDocIdMapping: Map<number, fragmentId>      │
│                                                                  │
│  6. Separate LLM call generates answer with K[docId_chunkIdx]   │
│     citations inline                                             │
│                                                                  │
│  7. runtime.streamAnswerText() streams to user                   │
│     → checkAndYieldCitationsForAgent() parses K[3_12] citations  │
│     → Uses citationDocIdMapping to resolve back to fragments     │
│     → Emits CitationsUpdate SSE events to frontend               │
│                                                                  │
│  8. persistAssistantMessage() stores final answer + citations    │
│     in database with processMessage() citation mapping           │
└──────────────────────────────────────────────────────────────────┘
```

**Compaction cannot break this flow** because steps 2-8 never touch `agent.state.messages`.

#### C. Without the Tool, the Agent Would Try to "Answer" Itself

If you removed `synthesizeFinalAnswer` and let the agent generate the answer natively:

1. The agent's response would come through `message_update` events (text deltas)
2. These deltas go through the event router → `message_update` handler in `xyne-handlers.ts`
3. Currently, **ALL agent text goes to `thinkingLog` only** — it's never streamed to the user
4. Even if you streamed it, the agent's context window would need ALL fragment content available
5. After compaction, fragment content is replaced by a narrative summary → **no citations possible**
6. The agent would hallucinate citation references that don't map to any real fragment

#### D. The Dual-LLM Architecture is Intentional

```
┌───────────────────────┐        ┌───────────────────────┐
│  Agent LLM (pi-mono)  │        │  Synthesis LLM        │
│  via LiteLLM          │        │  via Xyne Provider    │
│                       │        │                       │
│  Purpose:             │        │  Purpose:             │
│  - Planning           │        │  - Final answer       │
│  - Tool selection     │        │  - Grounded citations │
│  - Query refinement   │        │  - Anti-hallucination │
│  - Review steering    │        │  - Streaming to user  │
│                       │        │                       │
│  Context:             │        │  Context:             │
│  - Compactable        │        │  - Fresh fragments    │
│  - Tool results       │        │  - Full content       │
│  - Steering messages  │        │  - Citation headers   │
│                       │        │  - Conversation hist  │
│  Model: agenticModel  │        │  Model: defaultBest   │
│  (e.g. kimi-latest)   │        │  (e.g. GPT-4o)       │
└───────────────────────┘        └───────────────────────┘
```

This separation means:
- The **agent LLM** can be a fast/cheap model optimized for tool use and planning
- The **synthesis LLM** can be a high-quality model optimized for grounded answers
- Compaction of the agent's context doesn't affect answer quality
- The synthesis prompt has **strict anti-hallucination guardrails** (temperature 0.1, explicit "ZERO EXTERNAL KNOWLEDGE" preamble)

### 10.3 Risks if You Remove `synthesizeFinalAnswer`

| Risk | Severity | Explanation |
|------|----------|-------------|
| **No citations after compaction** | 🔴 Critical | Compaction replaces fragment content with narrative summary. Agent can't cite what it can't see. |
| **Hallucinated citations** | 🔴 Critical | Agent might generate `K[3_12]` references that don't map to any fragment. Frontend shows broken/wrong citations. |
| **No anti-hallucination control** | 🟠 High | Agent's system prompt is for planning/tool use, not grounded answering. No `temperature: 0.1` or guardrails. |
| **Context window waste** | 🟠 High | All fragments would need to be in the agent's context (consuming tokens) alongside tool history, system prompt, etc. |
| **Can't use different models** | 🟡 Medium | Agent model might not be best for grounded Q&A. Synthesis can use a different, better model. |
| **Streaming complexity** | 🟡 Medium | Currently all agent text goes to `thinkingLog`. Changing this requires rearchitecting the streaming pipeline. |

### 10.4 Could You Disable Compaction Instead?

You could set `compaction: { enabled: false }`, but:

1. **Context overflow** would crash the agent instead of recovering
2. With 10-15 turns of tool calls returning large fragment content, you'd easily hit 128K tokens
3. The agent loop would fail with `stopReason: "error"` and no recovery path
4. Each tool result includes the full fragment content (can be 2-10K tokens per fragment)
5. With 5 tools × 5 fragments each × 3K tokens average = 75K tokens just from tool results

**Compaction is necessary for the agent to function in multi-turn scenarios.** The `synthesizeFinalAnswer` tool is the correct architectural response to this reality.

### 10.5 Potential Improvements to the Current Design

While `synthesizeFinalAnswer` is the right pattern, there are improvements to consider:

#### A. Hook into `session_before_compact` to Preserve Citation Context

The SDK fires a `session_before_compact` extension event that lets you **provide your own compaction summary**. You could intercept this to preserve fragment metadata:

```typescript
pi.on("session_before_compact", async (event, ctx) => {
    // Generate a compaction summary that includes fragment IDs
    const fragmentSummary = xyneState.allFragments
        .map(f => `- Fragment ${f.id}: ${f.source.title || f.source.docId}`)
        .join('\n');
    
    return {
        compaction: {
            summary: `${defaultSummary}\n\n## Retrieved Documents\n${fragmentSummary}`,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
        }
    };
});
```

This ensures the agent at least knows *which* documents it found, even after compaction, helping it make better planning decisions.

#### B. Consider Fragment Deduplication Before Synthesis

Currently `xyneState.allFragments` can accumulate duplicates across turns (same document found by different tools). The synthesis payload should deduplicate by `fragment.id` before formatting.

#### C. Add a `maxFragmentsForSynthesis` Cap

If the agent runs 15 turns and accumulates 60+ fragments, the synthesis LLM call could itself overflow. Consider capping at the top-N ranked fragments (e.g., 20-25).

### 10.6 Verdict

**Yes, `synthesizeFinalAnswer` is the correct and necessary pattern.** It's not a workaround — it's the architectural answer to the fundamental tension between:
- An **agentic loop** that needs compaction to survive multi-turn execution
- A **RAG system** that needs full fragment content for grounded citations

The tool bridges these by maintaining fragments in a side-channel (`xyneState.allFragments`) and making a separate, citation-optimized LLM call that never touches the compactable context window.
