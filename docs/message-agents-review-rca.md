# MessageAgents Review Pipeline – Findings, RCA, and Fix Plan

This document captures the regressions called out in the 19 Nov 2025 logs for the new MessageAgents flow. Each section lists the observed behaviour, the root cause in the current implementation, and a concrete plan to fix it.

---

## 1. Expected-result blocks never reach the reviewer

**Finding** – `summarizeExpectations` always logs `expectations: []`, so the reviewer never sees success criteria.  
**RCA** – We only populate `expectationHistory` inside the `assistant_message` handler (server/api/chat/message-agents.ts:3248-3277), but we key the map by `currentTurn`. Before the first `turn_start` event, `currentTurn` is still `0`, so any `<expected_results>` block emitted while planning turn 1 is stored under key `0`. Later, `performAutomaticReview` reads `expectationHistory.get(turn)` (line 3172) and therefore misses those entries. Subsequent turns can suffer as well whenever the assistant emits expectations before `turn_start` fires.  
**Plan**
1. Track the “pending expectation turn” explicitly: when we push to `pendingExpectations` also record the active `evt.data.turn` that triggered the assistant output.
2. When `turn_start` fires, set a `currentExpectationTurn = evt.data.turn` and use it when calling `expectationHistory.set`.
3. Backfill: if expectations were logged before we heard a `turn_start`, retroactively assign them to `evt.data.turn` once it arrives.
4. Add telemetry asserting that the map for every turn reviewed is non-empty so we can alert when the agent fails to emit `<expected_results>`.

---

## 2. Normalizer treats `"false"`/`"true"` strings as truthy

**Finding** – `runReviewLLM normalized response` shows `planChangeNeeded: true` and `anomaliesDetected: true` even when the LLM replied with `"false"`.  
**RCA** – `normalizeReviewResponse` (server/api/chat/message-agents.ts:1568-1639) currently does `const planChangeNeeded = Boolean(raw.planChangeNeeded)` and similar checks. Any non-empty string (including `"false"`) becomes `true`, so our booleans are wrong.  
**Plan**
1. Introduce a helper `toBoolean(value)` that coerces `"false"`, `"False"`, `0`, `"0"` to `false`, and `"true"`, etc. to `true`.
2. Use it for `planChangeNeeded`, `anomaliesDetected`, and `ambiguityResolved`.
3. Add unit tests (new file under `server/tests/messageAgentsReview.test.ts`) that cover all input shapes (boolean, string, number, undefined).

---

## 3. Per-turn tool history is empty or capped at one record

**Finding** – `summarizeToolHistory input totalRecords` is often `0` or `1` even when three tools ran in the same turn, leading to review payloads claiming “No tool executions yet.”  
**RCA** – We rely on `toolCallTurnMap` inside `tool_requests` to remember the turn number for each tool call, but most toolCalls arrive without an `id`, so the map never stores anything. In `afterToolExecutionHook` the `turnNumber` argument stays `undefined`, we fall back to `context.turnCount`, and because `turnCount` has already advanced to the next turn by the time the hook fires, we stamp the record with the wrong turn. Later `currentTurnToolHistory` (line 3144) filters by `record.turnNumber === evt.data.turn` and drops everything.  
**Plan**
1. When handling `tool_requests`, synthesize a deterministic ID (e.g., `${evt.data.turn}:${idx}`) whenever the runtime does not provide one and store it in `toolCallTurnMap`.
2. Extend `beforeToolExecutionHook` to push the current turn into a `context.pendingToolTurns` stack keyed by call id so that even overlapping executions carry the right turn number.
3. Pass the recorded turn number into `afterToolExecutionHook`; stop relying on `context.turnCount`.
4. Add a defensive branch: if turn attribution is still missing, log an error once per turn and default to the previous turn instead of the current one so we never end up with zero records.

---



## 5. Review focus is always `"turn_end"`

**Finding** – `focus` never changes even when we could flag tool failures, run_end, etc.  
**RCA** – `performAutomaticReview` (line 567) hardcodes `focus: "turn_end"` whenever it calls `runReviewLLM`.  
**Plan**
1. Extend the event loop to trigger `performAutomaticReview` with `focus: "tool_error"` when a tool fails twice in a row, and `focus: "run_end"` before finalising.
2. Update `AutoReviewInput` so `focus` becomes mandatory, enabling future reviewers to tailor guidance.

---

## 6. Tool turn numbers rely on missing call IDs

**Finding** – Logs constantly show `Tool turnNumber not provided; falling back to current turnCount`.  
**RCA** – Same as section 3: the runtime omits `toolCall.id`, so our `toolCallTurnMap` never captures a mapping.  
**Plan**
1. Implement the synthesized ID strategy described in section 3.
2. Add a regression test in `server/scripts/testMessageAgentsTools.ts` that simulates tool_calls without IDs and asserts we still capture the turn.

---

## 7. `list_custom_agents` output hides agent IDs from the LLM

**Finding** – The agent makes up `agent_id_from_list` because the tool result string is only “Found a perfect match…”, so the LLM never sees the candidate IDs.  
**RCA** – `createListCustomAgentsTool` (lines 1994-2031) returns `ToolResponse.success(result.result, { metadata: result })`. The textual `result` contains only the summary sentence; the agent list lives exclusively inside `metadata`, which the LLM cannot read.  
**Plan**
1. Change the tool response to surface both the summary and a JSON payload, e.g. `ToolResponse.success(JSON.stringify(result), {...})`.
2. Alternatively, wrap the text response so it contains a markdown table of `{agentName, agentId, confidence}`.
3. Update the prompt instructions to remind the LLM to copy the exact `agentId` string into subsequent `run_public_agent` calls.

---

## 8. `run_public_agent` reports success even when execution fails

**Finding** – Tool history logs `status: success` while the payload says `"Agent execution failed"`.  
**RCA** – `createRunPublicAgentTool` (lines 2038-2089) always returns `ToolResponse.success`. The wrapped `executeCustomAgent` response includes `error` and `code`, but because we ignore it, `afterToolExecutionHook` records a success.  
**Plan**
1. Check `toolOutput.error`; when present, return `ToolResponse.error` with the vendor error code/message instead of `success`.
2. Teach `afterToolExecutionHook` to inspect `result?.data?.error` as a fallback (for historical data) and downgrade the record if necessary.
3. Emit better reasoning text so the reviewer sees why the delegate failed (e.g., prompt too long, 413).

---

## 9. Review keeps flagging unrelated “unmet expectations”

**Finding** – The reviewer keeps mentioning “Search across all data sources…” even when that sub-task was not due yet.  
**RCA** – We never update `plan.subTasks[*].status`, so every subtask stays `pending`. The reviewer only sees “pending” tasks and assumes they were expected during that turn.  
**Plan**
1. Whenever `toDoWrite` sets `context.plan`, immediately mark the first subtask as `in_progress`.
2. After each tool run, evaluate whether its required tool list matches the active subtask; once all required tools report success, mark the task `completed` and move to the next.
3. Persist these status updates in `context.plan` so `buildAgentInstructions` and the review payload show real-time progress.

---

## 10. `performAutomaticReview` sometimes receives an empty tool list

**Finding** – Despite tool calls happening, the reviewer payload says “No tool executions yet.”  
**RCA** – Same root cause as section 3: wrong `turnNumber` stamping causes `currentTurnToolHistory` to filter everything out.  
**Plan**
1. Fix turn attribution (section 3) so the filter works.
2. As a guard, if `currentTurnToolHistory` is empty but there were tool logs since the previous turn, pass the delta slice (by array index) instead of filtering by turn.

---

## 11. Guidance for `recommendation` / `ambiguityResolved` is unclear

**Finding** – The reviewer sets these fields unpredictably; e.g., `ambiguityResolved` flips even without new clarifications.  
**RCA** – The system prompt only says “Respond strictly in JSON … recommendation: proceed.” It never defines when to set `gather_more`, `clarify_query`, or when ambiguity should remain `false`.  
**Plan**
1. Extend the `runReviewLLM` system prompt with explicit heuristics:
   - If outstanding clarifications exist, force `ambiguityResolved=false`.
   - Recommend `gather_more` when unmet expectations reference missing evidence, `clarify_query` when ambiguity notes exist, etc.
2. Add a short criteria table to the prompt and work it into automated tests by mocking the review output.

---

## 12. Sub-task status is never updated from tool outcomes

**Finding** – Beyond the review noise, the plan object itself never leaves the “pending/pending/…” state.  
**RCA** – After `toDoWrite`, we just store the plan (lines 1858-1886) and set `context.currentSubTask`, but we never mutate `plan.subTasks[i].status` again. No hook listens for tool completion to flip statuses.  
**Plan**
1. Introduce a helper `advancePlan(context, toolRecord)` that:
   - Verifies the tool belongs to the current subtask by ID/tool list.
   - Marks the task as `in_progress` when its first tool starts.
   - Marks it `completed` (and sets `result` text) when the requisite tools finish successfully.
2. Call the helper from `afterToolExecutionHook`.
3. Update `selectActiveSubTaskId` to skip completed/failed tasks and log transitions.

---

## 13. Reviewer sometimes thinks “No tools executed” even though they did

**Finding** – Same as bullet “Even if tool calls have happened we are having No tool calls made in performAutomaticReview.”  
**RCA** – Combination of misattributed turn numbers and the fact that we only hand the reviewer the slice filtered by `turnNumber`. When attribution fails, the slice is empty.  
**Plan**
1. Same remediation as sections 3 and 10.
2. Additionally, dump `currentTurnToolHistory` into the log before invoking `runReviewLLM` so we can assert the pipeline is feeding data.

---

By executing the plans above—starting with the shared root causes around turn attribution and expectation handling—we can stabilise the automatic review loop and make the MessageAgents flow observable and reliable again.
