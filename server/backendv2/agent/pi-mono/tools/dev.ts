/* eslint-disable @typescript-eslint/require-await --
 * Test tool `execute` methods must return a Promise (pi-mono's interface
 * requires it), but most of these tools don't actually await anything. */
// Test tools for backendv2 — exercise pi-mono's tool-call loop end-to-end.
//
// - currentTime: trivial, no inputs, single text result
// - calculator: takes an expression, runs it through a tiny safe evaluator
// - lookupFact: simulates a KB lookup against a hardcoded map
// - delegateToWriter: SUB-AGENT — spawns a nested pi-mono session for a focused
//   sub-task, returns its final text. Verifies that an agent-inside-a-tool works.

import { defineTool, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"

import { createRAGAgent } from "@/api/chat/pi-mono/core"
import {
  getActualNameFromEnum,
} from "@/ai/modelConfig"
import config from "@/config"

import { baseLogger } from "../../log"

const Logger = baseLogger("backendv2/tools/dev")

type ToolReturn = {
  content: { type: "text"; text: string }[]
  details: unknown
  isError?: boolean
}

const textResult = (text: string, details: unknown = {}): ToolReturn => ({
  content: [{ type: "text", text }],
  details,
})

// ─── currentTime ────────────────────────────────────────────────────────────
const currentTime = defineTool({
  name: "currentTime",
  label: "Current time",
  description:
    "Get the current date and time as an ISO string. Useful for any " +
    "question about today's date, the current time, or scheduling.",
  promptSnippet:
    "Use `currentTime` whenever the user asks about the date or time.",
  parameters: Type.Object({}),
  async execute() {
    const now = new Date()
    const text = `Current time: ${now.toISOString()} (Unix: ${String(Math.floor(now.getTime() / 1000))})`
    return textResult(text, { iso: now.toISOString() })
  },
})

// ─── calculator ─────────────────────────────────────────────────────────────
const SAFE_EXPR = /^[\d+\-*/().\s]+$/u

const calculator = defineTool({
  name: "calculator",
  label: "Calculator",
  description:
    "Evaluate a basic arithmetic expression. Supports +, -, *, /, parentheses, " +
    "and decimal numbers. Use this for any non-trivial math.",
  promptSnippet:
    "Use `calculator` for arithmetic — do not compute by hand.",
  parameters: Type.Object({
    expression: Type.String({
      description: "Arithmetic expression, e.g., '(12 + 7) * 3.5'",
    }),
  }),
  async execute(_toolCallId, params) {
    const expr = params.expression
    if (!SAFE_EXPR.test(expr)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Refused: expression contains unsupported characters. Only digits, + - * / ( ) and whitespace are allowed.`,
          },
        ],
        details: { error: "unsafe_expression" },
        isError: true,
      }
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function(`"use strict"; return (${expr})`) as () => unknown
      const value = fn()
      return textResult(`${expr} = ${String(value)}`, { value })
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to evaluate: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        details: { error: "eval_failed" },
        isError: true,
      }
    }
  },
})

// ─── lookupFact ─────────────────────────────────────────────────────────────
const FACTS: Record<string, string> = {
  founder: "Xyne was founded as a workspace AI for engineering teams.",
  hq: "Headquartered in Bangalore, India.",
  team: "A small distributed team across India and Singapore.",
  product: "Xyne unifies search, chat, and agents over your work tools.",
}

const lookupFact = defineTool({
  name: "lookupFact",
  label: "Lookup fact",
  description:
    "Look up a fact about Xyne from the internal knowledge base. " +
    "Valid keys: 'founder', 'hq', 'team', 'product'.",
  promptSnippet:
    "Use `lookupFact` when the user asks about Xyne (the company / product).",
  parameters: Type.Object({
    key: Type.Union(
      [
        Type.Literal("founder"),
        Type.Literal("hq"),
        Type.Literal("team"),
        Type.Literal("product"),
      ],
      { description: "Which fact to fetch." },
    ),
  }),
  async execute(_toolCallId, params) {
    const value = FACTS[params.key]
    if (!value) {
      return {
        content: [
          { type: "text" as const, text: `No fact found for '${params.key}'` },
        ],
        details: { error: "not_found" },
        isError: true,
      }
    }
    return textResult(value, { key: params.key })
  },
})

// ─── delegateToWriter (sub-agent) ───────────────────────────────────────────
// Tool-based delegation: the parent agent calls this with a focused prompt;
// we spin up a brand-new pi-mono session in memory (no JSONL, no shared state),
// run it once, return its final text. The sub-agent has NO tools of its own —
// it's a pure synthesiser. Concurrent calls are independent (separate sessions).
const delegateToWriter = defineTool({
  name: "delegateToWriter",
  label: "Delegate to writer sub-agent",
  description:
    "Delegate a self-contained writing or rewriting sub-task to a specialist " +
    "sub-agent. Pass a complete, standalone prompt — the sub-agent has no " +
    "context from this conversation. Returns the sub-agent's final text.",
  promptSnippet:
    "Use `delegateToWriter` for self-contained sub-tasks like 'rewrite X in Y style' " +
    "or 'summarise this passage in N words'.",
  parameters: Type.Object({
    prompt: Type.String({
      description:
        "Full, self-contained prompt for the sub-agent. Include all needed context.",
    }),
  }),
  async execute(toolCallId, params) {
    const modelId = config.defaultBestModel
    const llmModelName = getActualNameFromEnum(modelId) ?? modelId
    const baseUrl = config.LiteLLMBaseUrl?.endsWith("/v1")
      ? config.LiteLLMBaseUrl
      : `${config.LiteLLMBaseUrl ?? ""}/v1`
    const apiKey = config.LiteLLMApiKey ?? ""

    const subAgentId = `sub_${crypto.randomUUID().split("-")[0] ?? String(Date.now())}`
    const log = Logger.child({
      toolName: "delegateToWriter",
      toolCallId,
      subAgentId,
    })
    const startedAt = Date.now()
    log.info(
      { promptPreview: params.prompt.slice(0, 120) },
      "sub-agent: starting",
    )

    try {
      const sub = await createRAGAgent({
        model: llmModelName,
        baseUrl,
        apiKey,
        tools: [],
        systemPrompt:
          "You are a focused writing specialist. Respond directly to the " +
          "prompt with the final text only. No preamble, no commentary.",
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.inMemory({
          retry: { enabled: true, maxRetries: 1 },
        }),
        modelOptions: {
          contextWindow: 200000,
          maxTokens: 2000,
          reasoning: false,
        },
        thinkingLevel: "off",
        extensions: [],
        timeoutMs: 60_000,
      })

      let text = ""
      for await (const event of sub.run(params.prompt)) {
        if (event.type === "text_delta" && event.delta) {
          text += event.delta
        } else if (
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          !text.trim() &&
          typeof event.message.content === "string"
        ) {
          text = event.message.content
        }
      }
      sub.dispose()
      log.info(
        { chars: text.length, durationMs: Date.now() - startedAt },
        "sub-agent: done",
      )
      return textResult(text.trim() || "(no output)", {
        chars: text.length,
        subAgentId,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn(
        { err, durationMs: Date.now() - startedAt },
        "sub-agent failed",
      )
      return {
        content: [{ type: "text" as const, text: `Sub-agent failed: ${msg}` }],
        details: { error: msg },
        isError: true,
      }
    }
  },
})

// ─── exports ────────────────────────────────────────────────────────────────
export const devTools = [currentTime, calculator, lookupFact]
export { delegateToWriter }
