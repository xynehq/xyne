/**
 * Citation pass — second focused LLM call that takes a finished answer +
 * retrieved chunks and emits the SAME answer with inline `K[N_X]` citations
 * inserted. Decouples answer quality from citation-format compliance so that
 * weaker / non-compliant models (Nemotron etc.) don't poison the rendered
 * answer with mangled citation tokens.
 *
 * Design notes:
 * - Called AFTER pi-mono's synthesis loop completes. Synthesis text is
 *   buffered (not streamed to user) and passed in as `answer`.
 * - This call's output IS what the user sees — it streams to the SSE.
 * - Uses the existing LiteLLM provider plumbing (`getProviderByModel`).
 * - On failure the caller falls back to streaming the uncited answer.
 */

import { getProviderByModel } from "@/ai/provider"
import { ConversationRole, type Message } from "@aws-sdk/client-bedrock-runtime"
import type { ConverseResponse, RuntimeModelId } from "@/ai/types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { buildCitationPassSystemPrompt } from "./prompts/xyne-prompts"

const Logger = getLogger(Subsystem.Chat).child({ module: "citation-pass" })

/** Rough token estimate: ~4 characters per token (English). Good enough for logs. */
const approxTokens = (s: string): number => Math.ceil(s.length / 4)

export interface RunCitationPassOpts {
  /** Chunks formatted via `formatFragmentsForLLM` — already contain
   *  `citationDocId: N — cite as K[N_X]` headers and `[chunk:X]` markers. */
  chunks: string
  /** The synthesised answer text. Citations will be inserted into this verbatim. */
  answer: string
  /** Model to use for the citation pass. Defaults to caller's synthesis model. */
  modelId: RuntimeModelId
  /** Number of distinct fragments being passed (for logging only). */
  numFragments?: number
  /** Email for log context (optional). */
  email?: string
  /** Sampling temperature — defaults to 0 so the rewrite is deterministic. */
  temperature?: number
  /** Max output tokens — defaults to answer length + headroom for citation tokens. */
  maxNewTokens?: number
}

/**
 * Streams the cited answer token-by-token. Caller is responsible for
 * forwarding each yielded chunk to the SSE response and running citation
 * extraction on the cumulative output.
 */
export async function* runCitationPass(
  opts: RunCitationPassOpts,
): AsyncGenerator<string, void, void> {
  const { chunks, answer, modelId, numFragments, email } = opts

  // Build the user message: chunks first, then a clear separator, then the
  // answer to cite. The system prompt has the rules; the user message is data.
  const userText =
    `# CHUNKS\n\n${chunks}\n\n` +
    `# ANSWER TO CITE\n\n${answer}`

  const systemPrompt = buildCitationPassSystemPrompt()

  const messages: Message[] = [
    {
      role: ConversationRole.USER,
      content: [{ text: userText }],
    },
  ]

  // Budget a healthy headroom on top of the answer length so the cited output
  // (which is the answer + a sprinkling of `K[N_X]` tokens) fits comfortably.
  // Average citation token ~10 chars; allow ~20% expansion.
  const approxAnswerTokens = Math.ceil(answer.length / 3)
  const maxNewTokens = opts.maxNewTokens ?? Math.max(4096, Math.ceil(approxAnswerTokens * 1.4))

  // ── Pre-call log: sizes of every input piece ─────────────────────────────
  const startTime = Date.now()
  const startIso = new Date(startTime).toISOString()
  const sysChars = systemPrompt.length
  const chunksChars = chunks.length
  const answerChars = answer.length
  const totalContextChars = sysChars + chunksChars + answerChars
  Logger.info(
    {
      event: "citation_pass_start",
      email,
      modelId,
      startedAt: startIso,
      numFragments,
      sizes: {
        chars: {
          systemPrompt: sysChars,
          chunks: chunksChars,
          answer: answerChars,
          totalInputContext: totalContextChars,
        },
        approxTokens: {
          systemPrompt: approxTokens(systemPrompt),
          chunks: approxTokens(chunks),
          answer: approxTokens(answer),
          totalInputContext: approxTokens(systemPrompt) + approxTokens(chunks) + approxTokens(answer),
        },
        maxNewTokens,
      },
    },
    "[citation-pass] starting",
  )

  let outputChars = 0
  let firstTokenAt: number | null = null
  try {
    const stream = getProviderByModel(modelId).converseStream(messages, {
      modelId,
      systemPrompt,
      stream: true,
      temperature: opts.temperature ?? 0,
      max_new_tokens: maxNewTokens,
      // Reasoning models tend to slow this pass down without helping — citation
      // insertion is a mechanical rewrite, not a reasoning task.
      reasoning: false,
    })

    for await (const chunk of stream as AsyncIterableIterator<ConverseResponse>) {
      if (chunk.text) {
        if (firstTokenAt === null) firstTokenAt = Date.now()
        outputChars += chunk.text.length
        yield chunk.text
      }
    }
  } finally {
    const endTime = Date.now()
    const durationMs = endTime - startTime
    const ttftMs = firstTokenAt !== null ? firstTokenAt - startTime : null
    Logger.info(
      {
        event: "citation_pass_end",
        email,
        modelId,
        startedAt: startIso,
        endedAt: new Date(endTime).toISOString(),
        durationMs,
        ttftMs,
        numFragments,
        sizes: {
          chars: {
            totalInputContext: totalContextChars,
            output: outputChars,
          },
          approxTokens: {
            totalInputContext: approxTokens(systemPrompt) + approxTokens(chunks) + approxTokens(answer),
            output: Math.ceil(outputChars / 4),
          },
        },
      },
      "[citation-pass] finished",
    )
  }
}
