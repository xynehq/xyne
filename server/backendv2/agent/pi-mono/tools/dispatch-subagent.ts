// dispatchSubagent — the parent agent's gateway into its sub-agents.
//
// Lifecycle (one execute() call):
//   1. The parent LLM emits a tool call with {name, query}.
//   2. We look up the sub-agent by name in the catalog the chat
//      service handed us. Unknown name → error tool result so the
//      parent can recover (try a different name or answer itself).
//   3. We ask the chat service's `persistence.start(...)` to insert a
//      fresh v2_chat_runs row (`parent_run_id = parentRunId`,
//      `sub_agent_id = subAgent.externalId`, status=running) and
//      hand us back the new run id.
//   4. We spin up an isolated pi-mono session for the sub-agent —
//      fresh SessionManager so working memory doesn't leak into the
//      parent; sub-agent's own systemPrompt; sub-agent's tools
//      resolved through the registry. The parent's agentScope (KB +
//      data sources + channels + filters) is inherited so vespa
//      visibility stays consistent.
//   5. The iteration runs to completion (no SSE forwarding — batch
//      mode). We collect every event into an in-memory trace.
//   6. We hand the full trace to `persistence.finish(nestedRunId,
//      batch)` which closes the run row and writes the sub-agent's
//      messages + tool_calls.
//   7. We return the sub-agent's final assistant text as the parent's
//      tool result, with isError=true on timeout / abort / error.
//
// What this file does NOT do:
//   • Touch any DB directly. All persistence flows through the
//     callbacks the chat service passes in.
//   • Aggregate tokens up to the parent run. Per the M7 design call
//     ("Nested row only"), the sub-agent's tokens land only on the
//     nested row; turn-level totals sum across the parent + nested
//     rows downstream.
//   • Register itself in TOOL_REGISTRY. The dispatch tool is added
//     conditionally by the runner when an agent has ≥1 sub-agent;
//     sub-agents themselves never receive it (flat hierarchy).

import { defineTool } from "@mariozechner/pi-coding-agent"
import { SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"

import { createRAGAgent, type RAGAgent } from "@/api/chat/pi-mono/core"

import type { AgentScope, DispatchableSubAgent } from "../../agent-scope"
import type { Log } from "../../log"
import { buildToolsForRun } from "./registry"

// ── Persistence contract ────────────────────────────────────────────────────
//
// Chat service implements these by writing to the v2_chat_* tables.
// The dispatch tool stays storage-agnostic — it only emits two
// lifecycle calls (start + finish) per dispatch.

export type NestedRunBatch = {
  status: "completed" | "errored" | "aborted"
  endedAt: number
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  /** Set only when status !== "completed". The parent's error result
   *  carries this verbatim so the parent LLM can read the failure
   *  reason. */
  error?: string
  /** Final assistant text — what the parent's tool_result will carry
   *  as its content. Even on partial failure we ship whatever the
   *  sub-agent had emitted so the parent has something to work with. */
  finalText: string
  /** Buffered reasoning text from the sub-agent (thinking blocks).
   *  Persisted as a `thinking` block on the nested assistant message. */
  thinkingText: string
  /** Sub-agent's tool invocations, ordered by `startedAt`. Each
   *  becomes one v2_chat_tool_calls row under the nested run id. */
  toolCalls: ReadonlyArray<{
    toolName: string
    /** Pi-mono's `tool_call_id` — opaque per-call identifier from the
     *  LLM; useful for debugging and correlating with the tool result. */
    toolCallId: string
    args: unknown
    result: unknown
    isError: boolean
    startedAt: number
    completedAt: number
  }>
}

export type NestedRunPersistence = {
  /** Insert a v2_chat_runs row for this dispatch. Returns the new
   *  run id (string, opaque). The chat service owns id generation. */
  start: (input: {
    subAgentExternalId: string
    model: string
  }) => Promise<string>
  /** Close out the nested run row and write the sub-agent's
   *  assistant message + tool_call rows under that run id. */
  finish: (nestedRunId: string, batch: NestedRunBatch) => Promise<void>
}

// ── Build context ───────────────────────────────────────────────────────────

export type DispatchToolCtx = {
  userEmail: string
  /** Parent's turn logger; the dispatch tool attaches sub-agent name +
   *  nested run id at execute time. */
  logger: Log
  /** Parent's vespa scope — sub-agents inherit it verbatim. */
  agentScope?: AgentScope
  /** Sub-agents the parent can dispatch to. Already filtered to live
   *  rows by loadAgentScope / loadWorkspaceDefaultPromptInputs. */
  subAgents: ReadonlyArray<DispatchableSubAgent>
  /** LLM endpoint config. Same as the runner's so the nested session
   *  hits the same provider. Model name comes through verbatim — the
   *  M7 design call picks "same as parent". */
  llm: {
    model: string
    baseUrl: string
    apiKey: string
  }
  // NOTE: `thinkingLevel` is intentionally NOT on this context anymore —
  // it's now stored per sub-agent on the sub_agents row and read off
  // the DispatchableSubAgent at dispatch time. Keeping a parent-level
  // override here would re-introduce the "who decides reasoning effort
  // for the leaf" ambiguity the persistence move was meant to settle.
  maxTokens?: number
  contextWindow?: number
  reserveTokens?: number
  keepRecentTokens?: number
  timeoutMs?: number
  /** Implemented by chat service. The dispatch tool calls start at
   *  the top of each execute and finish at the end (success or
   *  failure). */
  persistence: NestedRunPersistence
}

const DESCRIPTION = [
  "Dispatch a focused query to one of the available sub-agents. Each ",
  "sub-agent runs in an ISOLATED session (its working memory doesn't ",
  "leak back to you), with its own system prompt and tool subset. Use ",
  "this when the user's question fits a sub-agent's description squarely ",
  "— pattern-match the description, not the agent name. Pass a focused ",
  "query the sub-agent can answer end-to-end; don't pre-decompose. Treat ",
  "the returned text as authoritative for the slice you delegated and ",
  "preserve its citations verbatim. If no sub-agent's description ",
  "matches, answer it yourself instead of force-dispatching.",
].join("")

const params = Type.Object({
  name: Type.String({
    description:
      "Slug of the sub-agent to dispatch to. Must match the `name` " +
      "attribute on one of the <subagent> entries above.",
    minLength: 1,
  }),
  query: Type.String({
    description:
      "Self-contained question for the sub-agent. Pass a focused " +
      "single-topic query the sub-agent can answer end-to-end without " +
      "needing follow-ups from you.",
    minLength: 1,
  }),
})

// ── Tool builder ────────────────────────────────────────────────────────────

// Union of every shape `execute` returns in `details`. defineTool is
// generic over a single TDetails per tool, so without this explicit
// shape TS picks the first branch's keys and rejects the others. Each
// field is optional because no single branch sets all of them: the
// "not found" branch has {error, requested, available}; persistence
// failures use {error, name}; sub-agent errors set {error, name,
// nestedRunId, partialChars}; the success branch omits `error` and
// adds {resultChars, toolCallCount, durationMs}.
type DispatchDetails = {
  error?: string
  requested?: string
  available?: string
  name?: string
  nestedRunId?: string
  partialChars?: number
  resultChars?: number
  toolCallCount?: number
  durationMs?: number
}

export const buildDispatchSubagentTool = (
  ctx: DispatchToolCtx,
): ReturnType<typeof defineTool> =>
  defineTool<typeof params, DispatchDetails>({
    name: "dispatchSubagent",
    label: "Dispatch sub-agent",
    description: DESCRIPTION,
    promptSnippet:
      "Use `dispatchSubagent({name, query})` when the user's question " +
      "fits one of the sub-agents above. Pick the sub-agent whose " +
      "description matches; pass a focused query.",
    parameters: params,
    async execute(toolCallId, p) {
      const log = ctx.logger.child({
        toolName: "dispatchSubagent",
        toolCallId,
        subAgentName: p.name,
      })

      // 1. Resolve the sub-agent by name.
      const sub = ctx.subAgents.find((s) => s.name === p.name)
      if (!sub) {
        const available = ctx.subAgents.map((s) => s.name).join(", ")
        log.warn(
          { available },
          "dispatchSubagent: sub-agent not found",
        )
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Sub-agent "${p.name}" not found. Available sub-agents: ` +
                `${available || "(none)"}.`,
            },
          ],
          details: { error: "not-found", requested: p.name, available },
          isError: true,
        }
      }

      const subLog = log.child({ subAgentExternalId: sub.externalId })
      const startedAt = Date.now()

      // 2. Open the nested run row.
      let nestedRunId: string
      try {
        nestedRunId = await ctx.persistence.start({
          subAgentExternalId: sub.externalId,
          model: ctx.llm.model,
        })
      } catch (err) {
        subLog.error(
          { err },
          "dispatchSubagent: nested-run start persistence failed",
        )
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Sub-agent "${p.name}" could not be dispatched — persistence ` +
                `setup failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: { error: "persistence-start-failed", name: p.name },
          isError: true,
        }
      }

      subLog.info(
        { nestedRunId, queryChars: p.query.length, subToolsCount: sub.tools.length },
        "dispatchSubagent: nested run starting",
      )

      // 3. Build the sub-agent's tools. M7-pre semantic: `[]` is
      //    literal — the sub-agent gets NO tools at run time. Listed
      //    names are resolved through the same registry the parent
      //    uses; unknown names are silently dropped. The dispatch
      //    tool is NOT in the registry, so the sub-agent never gets
      //    it (flat hierarchy enforced by construction).
      const subTools = buildToolsForRun(sub.tools, {
        userEmail: ctx.userEmail,
        logger: subLog,
        ...(ctx.agentScope ? { agentScope: ctx.agentScope } : {}),
      })

      // 4. Spin the nested session.
      const subSession = SessionManager.inMemory()
      const subAgent: RAGAgent<unknown> = await createRAGAgent({
        model: ctx.llm.model,
        baseUrl: ctx.llm.baseUrl,
        apiKey: ctx.llm.apiKey,
        tools: subTools,
        systemPrompt: sub.systemPrompt,
        sessionManager: subSession,
        settingsManager: SettingsManager.inMemory({
          compaction: {
            enabled: true,
            reserveTokens: ctx.reserveTokens ?? 40192,
            keepRecentTokens: ctx.keepRecentTokens ?? 50000,
          },
          retry: { enabled: true, maxRetries: 2 },
        }),
        modelOptions: {
          contextWindow: ctx.contextWindow ?? 250000,
          maxTokens: ctx.maxTokens ?? 64000,
          reasoning: true,
        },
        // Reasoning effort is stamped on the sub-agent at creation time
        // (see sub_agents.thinking_level). Read it off the resolved
        // record — the parent doesn't override leaves.
        thinkingLevel: sub.thinkingLevel,
        extensions: [],
        timeoutMs: ctx.timeoutMs ?? 10 * 60 * 1000,
      })

      // 5. Iterate to completion. We collect every event into a trace
      //    so the chat service can persist the full sub-agent
      //    execution under the nested run id.
      let finalText = ""
      let thinkingText = ""
      let error: string | undefined
      const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      // Tool calls are tracked by toolCallId so we can stitch
      // tool_call / tool_result events together into one row each.
      const pendingByCallId = new Map<
        string,
        {
          toolName: string
          toolCallId: string
          args: unknown
          startedAt: number
        }
      >()
      const completedToolCalls: NestedRunBatch["toolCalls"][number][] = []

      try {
        for await (const event of subAgent.run(p.query)) {
          if (event.type === "raw") {
            // Pull token usage out of message_end events on the raw
            // stream — the mapped RAGEvent doesn't carry them.
            const e = event.event as {
              type?: string
              message?: {
                role?: string
                usage?: {
                  input?: number
                  output?: number
                  cacheRead?: number
                  cacheWrite?: number
                }
              }
            }
            if (
              e.type === "message_end" &&
              e.message?.role === "assistant" &&
              e.message.usage
            ) {
              const u = e.message.usage
              tokens.input += u.input ?? 0
              tokens.output += u.output ?? 0
              tokens.cacheRead += u.cacheRead ?? 0
              tokens.cacheWrite += u.cacheWrite ?? 0
            }
            continue
          }
          switch (event.type) {
            case "text_delta": {
              if (event.delta) finalText += event.delta
              break
            }
            case "thinking_delta": {
              if (event.delta) thinkingText += event.delta
              break
            }
            case "tool_call": {
              pendingByCallId.set(event.toolCallId, {
                toolName: event.toolName,
                toolCallId: event.toolCallId,
                args: event.args,
                startedAt: Date.now(),
              })
              break
            }
            case "tool_result": {
              const pending = pendingByCallId.get(event.toolCallId)
              if (pending) {
                completedToolCalls.push({
                  toolName: pending.toolName,
                  toolCallId: pending.toolCallId,
                  args: pending.args,
                  result: event.result,
                  isError: event.isError,
                  startedAt: pending.startedAt,
                  completedAt: Date.now(),
                })
                pendingByCallId.delete(event.toolCallId)
              }
              break
            }
            case "message_end": {
              // Pi-mono sometimes only fills the full content on
              // message_end (no text_delta stream); pick it up so
              // finalText reflects the assistant's last word.
              if (
                event.message.role === "assistant" &&
                !finalText.trim() &&
                event.message.content
              ) {
                const content = event.message.content
                if (typeof content === "string") {
                  const trimmed = content.trim()
                  if (trimmed) finalText = trimmed
                }
              }
              break
            }
            case "error": {
              error = event.error.message
              subLog.warn(
                { errorMessage: event.error.message, code: event.error.code },
                "dispatchSubagent: sub-agent stream error",
              )
              break
            }
            default:
              break
          }
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        subLog.error({ err }, "dispatchSubagent: nested iteration threw")
      } finally {
        subAgent.dispose()
      }

      // Any tool_call without a matching tool_result is recorded as
      // an in-flight call that ended with the run. Without this they
      // would be lost from the trace.
      for (const [, pending] of pendingByCallId) {
        completedToolCalls.push({
          toolName: pending.toolName,
          toolCallId: pending.toolCallId,
          args: pending.args,
          result: { abandoned: true },
          isError: true,
          startedAt: pending.startedAt,
          completedAt: Date.now(),
        })
      }

      const endedAt = Date.now()
      const status: NestedRunBatch["status"] = error ? "errored" : "completed"

      // 6. Persist the trace + close the nested run row.
      try {
        await ctx.persistence.finish(nestedRunId, {
          status,
          endedAt,
          tokens,
          ...(error ? { error } : {}),
          finalText,
          thinkingText,
          toolCalls: completedToolCalls,
        })
      } catch (persistErr) {
        // Failing to persist the nested trace must NOT block the parent
        // from receiving the sub-agent's answer. Log loudly and ship
        // the result through anyway.
        subLog.error(
          { err: persistErr, nestedRunId },
          "dispatchSubagent: nested-run finish persistence failed (sub-agent text still returned to parent)",
        )
      }

      subLog.info(
        {
          nestedRunId,
          status,
          durationMs: endedAt - startedAt,
          finalTextChars: finalText.length,
          toolCallCount: completedToolCalls.length,
          tokens,
        },
        "dispatchSubagent: nested run done",
      )

      // 7. Return to the parent LLM.
      if (error) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Sub-agent "${p.name}" failed: ${error}` +
                (finalText
                  ? `\n\n— Partial response below —\n${finalText}`
                  : ""),
            },
          ],
          details: {
            error,
            name: p.name,
            nestedRunId,
            partialChars: finalText.length,
          },
          isError: true,
        }
      }
      return {
        content: [{ type: "text" as const, text: finalText }],
        details: {
          name: p.name,
          nestedRunId,
          resultChars: finalText.length,
          toolCallCount: completedToolCalls.length,
          durationMs: endedAt - startedAt,
        },
      }
    },
  })
