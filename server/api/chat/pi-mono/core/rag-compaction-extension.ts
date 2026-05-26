// Pi-coding-agent's built-in auto-compaction asks the LLM to fill in a
// coding-assistant summary template ("Goal / Done / Next Steps / Critical
// Context / file paths"). That template is wrong for our RAG/research
// sessions — the conversation is a sequence of vespaSearch tool calls,
// not "edit these files, finish these tasks". Nemotron correctly answers
// "(none)" for every section because none of those things happened, and
// the post-compaction continue loop then loses all context of what the
// user actually asked.
//
// This extension intercepts the `session_before_compact` event (the
// supported hook documented at earendil-works/pi-coding-agent compaction
// docs) and replaces the entire summary path: we build our own
// RAG-flavored prompt — user question, searches performed, key findings,
// open gaps — and call the model directly with it. Pi-coding-agent then
// uses our summary instead of running its built-in compact().
//
// References:
//   - extension hook: agent-session.js _runAutoCompaction → emit("session_before_compact")
//   - default prompt being replaced: pi-agent-core/harness/compaction/compaction.js SUMMARIZATION_PROMPT
//   - docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md

import { complete, type Model, type ThinkingLevel } from "@earendil-works/pi-ai"

import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Chat)

type ExtensionMessage = {
  role?: string
  content?: unknown
  toolName?: string
  toolCallId?: string
  // pi-coding-agent's SessionMessageEntry wraps these on `.message`,
  // but the event we receive has them flattened — handle both shapes.
  message?: { role?: string; content?: unknown }
}

type PreparationLike = {
  firstKeptEntryId: string
  messagesToSummarize: ExtensionMessage[]
  turnPrefixMessages: ExtensionMessage[]
  isSplitTurn: boolean
  tokensBefore: number
  previousSummary?: string
  settings: { reserveTokens: number }
}

type SessionBeforeCompactEvent = {
  preparation: PreparationLike
  branchEntries?: unknown[]
  customInstructions?: string
  signal?: AbortSignal
}

type SessionBeforeCompactResult =
  | { cancel: true }
  | {
      compaction: {
        summary: string
        firstKeptEntryId: string
        tokensBefore: number
        details?: unknown
      }
    }
  | undefined

// Minimal subset of pi-coding-agent's ExtensionAPI we use.
type ExtensionAPILike = {
  on: (
    eventName: string,
    handler: (
      event: SessionBeforeCompactEvent,
    ) => Promise<SessionBeforeCompactResult> | SessionBeforeCompactResult,
  ) => void
}

export type RagCompactionDeps = {
  /** Resolved pi-ai Model — pass the same instance the session uses. */
  model: Model
  apiKey?: string
  /** Provider-specific headers from the auth chain (LiteLLM bearer, etc). */
  headers?: Record<string, string>
  /** Optional thinking budget for the summarization call. */
  thinkingLevel?: ThinkingLevel
}

// Token estimate for a single ExtensionMessage. We just need it to bound
// the prompt size; chars/4 matches what pi-agent-core itself uses (see
// `estimateTokens` in compaction.js).
const approxTokens = (s: string): number => Math.ceil(s.length / 4)

const SYSTEM_PROMPT = `You are summarizing a research conversation for context-window management.

The conversation is between a user and an AI research assistant that searches a knowledge base via tools (vespaSearch, getChunks, etc.). Your output replaces the older messages in the assistant's context so it can continue answering the user. The assistant relies on what YOU surface — so preserve concrete quotes, doc IDs, and the work that has ALREADY been done so the assistant doesn't repeat it.

Your summary is read by the assistant as guidance on what to do NEXT. Avoid framing that invites more tool calls if the user's question is already answerable.

Do NOT continue the conversation. Do NOT answer the user's question yourself. ONLY output the structured summary.`

const PROMPT = `The messages above are a RAG research session to summarize.

Produce a markdown summary the assistant will use to continue the work, in this exact format:

## User's question
[The user's original information need, verbatim from the first user message — do NOT rephrase]

## Searches already performed (do NOT repeat these)
[Bulleted list of tool calls in order. Each line: \`tool(query/args) — N hits\`. The assistant must NOT issue duplicate or near-duplicate variations of these — they have been tried.]

## Key findings
[The most useful facts/quotes pulled from tool_result content so far. Preserve exact wording where it's a definition or rule, with doc IDs (e.g. \`[doc clf-xxx]\`). Group by topic, not by tool call. Drop anything that turned out to be irrelevant.]

## What is now answerable
[For each part of the user's question, state whether Key findings already contain enough to answer it. If yes, the assistant should STOP searching and produce the final answer using Key findings — do NOT request more searches just to "double-check". Only flag items as unanswered if a specific, named fact (a particular regulation, definition, or quoted clause) is missing AND cannot be inferred from what's already found.]

Be concise but PRESERVE quoted text, doc IDs, regulation numbers, and citation markers verbatim. The assistant cannot re-fetch what you drop.`

const UPDATE_PROMPT = `The messages above are NEW messages from a RAG research session, to fold into the existing summary in <previous-summary>.

Update the structured summary with new searches and findings. RULES:
- PRESERVE the user's original question verbatim
- APPEND new searches and findings to the existing lists — do NOT drop ones the previous summary captured
- UPDATE "What is now answerable" — be honest: if Key findings cover the user's question, say the assistant should stop searching and produce the final answer
- PRESERVE every doc ID, regulation number, and quoted definition the previous summary captured

Output the same markdown structure (## User's question / ## Searches already performed / ## Key findings / ## What is now answerable) as a complete replacement summary — not a diff.`

// Render an ExtensionMessage to plain text for the prompt. We unify the
// flattened vs `.message`-wrapped shapes pi-coding-agent uses across
// versions.
const renderMessage = (m: ExtensionMessage): string => {
  const inner = m.message ?? m
  const role = inner.role ?? m.role ?? "unknown"
  const content = inner.content ?? m.content
  let body: string
  if (typeof content === "string") {
    body = content
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== "object") continue
      if (block["type"] === "text" && typeof block["text"] === "string") {
        parts.push(block["text"] as string)
      } else if (
        block["type"] === "thinking" &&
        typeof block["thinking"] === "string"
      ) {
        // Skip thinking — it bloats the prompt and the actual reasoning
        // is already baked into the tool calls that followed.
        continue
      } else if (block["type"] === "toolCall") {
        const name = block["toolName"] ?? "tool"
        const args = block["args"]
        parts.push(
          `[tool_call ${String(name)}(${
            args !== undefined ? JSON.stringify(args).slice(0, 400) : ""
          })]`,
        )
      } else if (block["type"] === "toolResult") {
        const tool = block["toolName"] ?? "tool"
        const result = block["result"]
        // Truncate per-result so a single huge vespaSearch payload
        // doesn't push the summarization prompt past its own budget.
        // 2000 chars (~500 tokens) keeps the structure visible.
        const txt =
          typeof result === "string"
            ? result
            : JSON.stringify(result ?? null).slice(0, 2000)
        parts.push(`[tool_result ${String(tool)}]\n${txt}`)
      }
    }
    body = parts.join("\n")
  } else {
    body = JSON.stringify(content ?? null).slice(0, 2000)
  }
  return `--- ${role} ---\n${body}`
}

const serialize = (messages: ExtensionMessage[]): string =>
  messages.map(renderMessage).join("\n\n")

/**
 * Build a pi-coding-agent extension that overrides RAG/research session
 * compaction. Register it via `extensions: [ragCompactionExtension(deps)]`
 * on `createRAGAgent` — it transparently no-ops when called outside
 * `session_before_compact`.
 */
export const ragCompactionExtension =
  (deps: RagCompactionDeps) =>
  (pi: ExtensionAPILike): void => {
    const log = (msg: string, fields?: Record<string, unknown>): void => {
      Logger.info({ ...(fields ?? {}) }, `rag-compaction: ${msg}`)
    }

    log("registered session_before_compact handler")

    pi.on(
      "session_before_compact",
      async (event: SessionBeforeCompactEvent) => {
        const { preparation, signal } = event
        // Pi-coding-agent populates EITHER `messagesToSummarize` (history
        // from previous turns) OR `turnPrefixMessages` (the prefix of the
        // CURRENT turn, when it's being split mid-flight). For our
        // mid-turn compaction case the meaningful content lives in
        // `turnPrefixMessages` — `messagesToSummarize` is usually empty
        // because we trip the threshold inside the first turn. Combine
        // both so we always have something useful to summarize.
        const history = preparation?.messagesToSummarize ?? []
        const turnPrefix = preparation?.turnPrefixMessages ?? []
        const combined = [...history, ...turnPrefix]
        log("handler invoked", {
          hasPreparation: !!preparation,
          historyCount: history.length,
          turnPrefixCount: turnPrefix.length,
          isSplitTurn: preparation?.isSplitTurn,
        })
        if (combined.length === 0) {
          // Truly nothing to summarize — let pi-coding-agent run its
          // default path (which will also no-op).
          log("nothing to summarize — falling back", {})
          return undefined
        }

        const conversationText = serialize(combined)
        const previousSummary = preparation.previousSummary
        const basePrompt = previousSummary ? UPDATE_PROMPT : PROMPT
        const userPrompt = previousSummary
          ? `<conversation>\n${conversationText}\n</conversation>\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${basePrompt}`
          : `<conversation>\n${conversationText}\n</conversation>\n\n${basePrompt}`

        // Mirror pi-agent-core/compaction.js:362 — 80% of reserve, bounded by model maxTokens.
        const modelMax = deps.model.maxTokens > 0 ? deps.model.maxTokens : Number.POSITIVE_INFINITY
        const maxTokens = Math.min(
          Math.floor(0.8 * preparation.settings.reserveTokens),
          modelMax,
        )

        log("invoking custom summarizer", {
          messagesToSummarize: preparation.messagesToSummarize.length,
          tokensBefore: preparation.tokensBefore,
          approxPromptTokens: approxTokens(userPrompt),
          maxTokens,
          hasPreviousSummary: !!previousSummary,
        })

        const startedAt = Date.now()
        let summary: string
        try {
          const response = await complete(
            deps.model,
            {
              systemPrompt: SYSTEM_PROMPT,
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: userPrompt }],
                  timestamp: Date.now(),
                },
              ],
            },
            {
              maxTokens,
              ...(signal ? { signal } : {}),
              ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
              ...(deps.headers ? { headers: deps.headers } : {}),
              ...(deps.model.reasoning && deps.thinkingLevel
                ? { reasoning: deps.thinkingLevel }
                : {}),
            },
          )
          if (response.stopReason === "aborted") {
            log("aborted", {})
            return { cancel: true }
          }
          if (response.stopReason === "error") {
            log("model error — falling back to default", {
              errorMessage: response.errorMessage,
            })
            // Returning undefined hands control back to pi-coding-agent's
            // built-in compact() — better than killing the run.
            return undefined
          }
          const textParts = response.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
          summary = textParts.join("\n").trim()
        } catch (err) {
          log("threw — falling back to default", {
            error: (err as Error)?.message,
          })
          return undefined
        }

        if (!summary) {
          log("empty response — falling back to default", {})
          return undefined
        }

        log("produced summary", {
          summaryChars: summary.length,
          durationMs: Date.now() - startedAt,
        })

        return {
          compaction: {
            summary,
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            details: { customizer: "rag-compaction-extension" },
          },
        }
      },
    )
  }
