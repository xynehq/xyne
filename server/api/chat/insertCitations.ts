/**
 * insertCitations — a dedicated "citation grammar" pass.
 *
 * Why this exists:
 *   The main synthesis call has to do many things at once (answer, reason,
 *   maintain tone, follow citation grammar). Citation format compliance is the
 *   first thing the model drops under that load — we've seen mangled formats
 *   like [K1_17], K[7], or no markers at all.
 *
 *   Instead of fighting non-determinism with regexes, we run a second focused
 *   LLM pass that does ONLY one thing: insert `K[N_M]` markers into the prose
 *   the synthesis already produced. Same model (Kimi-latest in our setup) but
 *   a small, single-purpose prompt — much higher format-compliance rate.
 *
 * Failure mode:
 *   If the cite-pass produces output we can't trust (no markers at all, or
 *   throws), we fall back to the original answer. The user still sees the
 *   answer; only the inline citations are missing.
 */
import { getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { ConversationRole } from "@aws-sdk/client-bedrock-runtime"
import { getProviderByModel } from "@/ai/provider"
import type { Models } from "@/ai/types"
import type { MinimalAgentFragment } from "@/api/chat/types"
import type { Message } from "@aws-sdk/client-bedrock-runtime"

const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

const SYSTEM_PROMPT = `You are a citation marker inserter for a RAG system.

Your job: take an ANSWER and a numbered list of SOURCES, then return the
SAME ANSWER with citation markers inserted after factual claims.

CITATION FORMAT — use exactly this grammar:
  K[N_M]   where N is the 1-based source index and M is the 0-based chunk
           index inside that source.

Examples:
  Input:  "IBFSL provided ₹293.90 crores to seven companies."
  Output: "IBFSL provided ₹293.90 crores to seven companies K[1_5]."

  Input:  "The settlement was dated November 18, 2009 and the loan was ₹232.50 crores."
  Output: "The settlement was dated November 18, 2009 K[1_5] and the loan was ₹232.50 crores K[2_3]."

RULES:
1. DO NOT change any wording, punctuation, sentence order, or formatting.
   Preserve markdown bullets, bold, lists, line breaks exactly as given.
2. Insert markers immediately after the claim they support, with one space
   before the marker.
3. Use the source index (N) and chunk index (M) of the chunk that contains
   the supporting evidence.
4. If a sentence has two distinct claims from different chunks, include two
   markers.
5. Maximum 2 markers per sentence.
6. If a claim cannot be grounded in any provided source, leave it WITHOUT
   a marker.
7. Output ONLY the cited answer text. No preamble. No explanation. No JSON.
   No markdown code fences.`

const MAX_CHUNK_CHARS = 600 // truncate per-fragment content sent to the model
const MIN_VALID_MARKER_REGEX = /K\[\d+_\d+\]/ // at least one well-formed marker

/**
 * Build the user message presenting numbered sources + the answer to cite.
 */
function buildUserPrompt(
  answer: string,
  fragments: MinimalAgentFragment[],
): string {
  const sourceBlocks = fragments.map((frag, idx) => {
    const title =
      frag.source?.title || frag.source?.docId || `fragment ${frag.id}`
    const visible = (frag.visibleChunkIndices ?? []).filter((v) =>
      Number.isFinite(v),
    )
    const chunkIdxLabel =
      visible.length > 0 ? visible.map((v) => `[${v}]`).join(" ") : "[0]"
    // Trim long chunks — the model only needs enough to know what the chunk
    // is about so it can decide whether to cite it.
    const trimmed = frag.content
      ? frag.content.length > MAX_CHUNK_CHARS
        ? `${frag.content.slice(0, MAX_CHUNK_CHARS)}…`
        : frag.content
      : "(no content)"
    return `[Source ${idx + 1}] (file: ${title})\n  Chunks: ${chunkIdxLabel}\n  Content: ${trimmed}`
  })

  return `SOURCES:
${sourceBlocks.join("\n\n")}

ANSWER:
${answer}`
}

/**
 * Insert K[N_M] citation markers into the synthesis answer using a focused
 * second-pass LLM call. Same model as synthesis; we just give it ONE job.
 *
 * Returns the cited answer on success, or the original answer if the pass
 * fails (logged so we can monitor reliability). Two attempts max, both at
 * temperature 0 — second attempt only if the first returns no markers at all.
 */
export async function insertCitations(args: {
  answer: string
  fragments: MinimalAgentFragment[]
  modelId: Models
  email: string
}): Promise<string> {
  const { answer, fragments, modelId, email } = args

  if (!answer || answer.trim().length === 0) return answer
  if (!fragments.length) {
    loggerWithChild({ email }).info(
      "[insertCitations] No retrieved fragments — skipping cite-pass",
    )
    return answer
  }

  const userPrompt = buildUserPrompt(answer, fragments)
  const messages: Message[] = [
    {
      role: ConversationRole.USER,
      content: [{ text: userPrompt }],
    },
  ]

  // Compute total chunk count across all fragments. Each fragment can map
  // to multiple chunk indices (e.g. when docling's HybridChunker groups
  // several paragraphs as one semantic chunk). Logging this gives a clearer
  // signal than `fragmentsCount` alone of how much grounding evidence the
  // cite-pass is being asked to consider.
  const chunksCount = fragments.reduce((sum, frag) => {
    const visible = (frag.visibleChunkIndices ?? []).filter((v) =>
      Number.isFinite(v),
    )
    return sum + (visible.length > 0 ? visible.length : 1)
  }, 0)
  const promptChars = userPrompt.length

  for (let attempt = 1; attempt <= 2; attempt++) {
    const startedAt = Date.now()
    try {
      loggerWithChild({ email }).info(
        {
          attempt,
          modelId,
          fragmentsCount: fragments.length,
          chunksCount,
          answerLen: answer.length,
          promptChars,
        },
        "[insertCitations] running cite-pass",
      )

      const provider = getProviderByModel(modelId)
      const { text } = await provider.converse(messages, {
        modelId,
        systemPrompt: SYSTEM_PROMPT,
        temperature: 0,
        stream: false,
        json: false,
      })

      const tookMs = Date.now() - startedAt
      const cited = (text || "").trim()

      if (cited.length === 0) {
        loggerWithChild({ email }).warn(
          { attempt, tookMs },
          "[insertCitations] empty response from cite-pass",
        )
        continue
      }

      if (!MIN_VALID_MARKER_REGEX.test(cited)) {
        loggerWithChild({ email }).warn(
          { attempt, tookMs, preview: cited.slice(0, 200) },
          "[insertCitations] no K[N_M] markers in response — retrying once",
        )
        continue
      }

      loggerWithChild({ email }).info(
        {
          attempt,
          tookMs,
          fragmentsCount: fragments.length,
          chunksCount,
          markersFound: (cited.match(/K\[\d+_\d+\]/g) || []).length,
        },
        "[insertCitations] cite-pass succeeded",
      )
      return cited
    } catch (err) {
      loggerWithChild({ email }).warn(
        { attempt, tookMs: Date.now() - startedAt, err },
        "[insertCitations] cite-pass call threw",
      )
    }
  }

  loggerWithChild({ email }).warn(
    "[insertCitations] all attempts failed; returning original answer",
  )
  return answer
}
