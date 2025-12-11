import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getProviderByModel } from "@/ai/provider"
import config from "@/config"
import type { LLMProvider } from "@/ai/types"
import { MessageRole } from "@/types"

const Logger = getLogger(Subsystem.Queue).child({ module: "transcriptRefinement" })

// Types matching Python script output
export interface TranscriptSegment {
  speaker: string
  text: string
  start: number
  end: number
  words?: Array<{
    word: string
    start: number
    end: number
    speaker: string
    probability: number
    language?: string
  }>
}

export interface TranscriptResult {
  text: string
  segments: TranscriptSegment[]
  word_segments?: Array<{
    word: string
    start: number
    end: number
    speaker: string
    probability: number
    language?: string
  }>
  language: string
  speakers: string[]
  timing?: Record<string, number>
  refinement_applied?: boolean
}

interface RefinementOptions {
  maxTokens?: number
  customPrompt?: string
  chunkSize?: number
}

const DEFAULT_REFINEMENT_PROMPT = `You are a transcript refinement expert used in an automated speech pipeline.
Your job is to CLEAN the text but NEVER break alignment.

NON-NEGOTIABLE RULES (follow in this exact priority order):

1. DO NOT change the number of segments. If input has N segments, output MUST have N segments.
2. DO NOT change timestamps. Keep each segment's \`start\` and \`end\` exactly as in the input.
3. DO NOT merge, split, reorder, or drop segments.
4. Only change:
   - \`speaker\`
   - \`text\`
   Keep everything else as-is.

REFINEMENT RULES:

1. Speaker assignment:
   - Use stable, descriptive labels: "Person A", "Person B", "Person C", etc. Assign the same label for the same speaker across all segments in this chunk.
   - Do NOT invent real names, even if mentioned in the text.

2. Spelling & grammar:
   - Fix obvious ASR mistakes and casing.
   - Keep technical terms, product names, code, and IDs exactly if they look intentional.

3. Punctuation:
   - Add commas, periods, and question marks to make it readable.
   - Do not add long stylistic rewrites.

4. Multilingual / Hindi-English:
   - When text is in Hindi or mixed Hindi-English, translate to clear conversational English.
   - Preserve cultural/intent nuance ("yaar", "acha", "haan") by using lightweight equivalents ("hey", "okay", "yeah") when needed.
   - If translation is ambiguous, keep the original phrase.

5. Filler words:
   - Remove only obvious fillers that don't change meaning ("um", "uh", "like" at the start).
   - Keep hesitations that show intent ("I… I don't know", "let me think").

OUTPUT FORMAT:

- Return ONLY a JSON array.
- Each item MUST have exactly these keys: \`speaker\`, \`text\`, \`start\`, \`end\`.
- \`start\` and \`end\` MUST be the original numeric values from input.
- Do NOT wrap the JSON in markdown fences.
- Do NOT add explanations, comments, or metadata.`

/**
 * Heuristically fix UNKNOWN "bridge" segments:
 * Pattern: Speaker X -> UNKNOWN (very short) -> Speaker X
 * We assume the UNKNOWN segment actually belongs to Speaker X.
 */
export function normalizeUnknownBridgeSegments(
  segments: TranscriptSegment[]
): TranscriptSegment[] {
  if (!segments || segments.length === 0) return []

  // Shallow clone so we don't mutate the original array from the caller.
  const normalized = segments.map(seg => ({
    ...seg,
    text: seg.text ?? "",
    words: seg.words ?? [],
  }))

  for (let i = 0; i < normalized.length - 2; i++) {
    const prev = normalized[i]
    const mid = normalized[i + 1]
    const next = normalized[i + 2]

    if (!prev || !mid || !next) continue

    const isUnknown =
      !mid.speaker ||
      mid.speaker.toUpperCase() === "UNKNOWN" ||
      mid.speaker.toUpperCase().startsWith("SPEAKER_")

    const sameSpeaker = prev.speaker && prev.speaker === next.speaker

    if (!isUnknown || !sameSpeaker) continue

    const midText = (mid.text || "").trim()
    const midWordCount = midText.length ? midText.split(/\s+/).filter(Boolean).length : 0
    const midDuration = (mid.end ?? 0) - (mid.start ?? 0)

    // Only treat as a bridge if it's very short (e.g., a 1–2 word interjection)
    if (midWordCount <= 2 && midDuration <= 1.5) {
      mid.speaker = prev.speaker
    }
  }

  return normalized
}

/**
 * Merge consecutive segments from the same speaker
 */
export function mergeConsecutiveSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  if (!segments || segments.length === 0) {
    return []
  }

  const merged: TranscriptSegment[] = []
  let current: TranscriptSegment = {
    speaker: segments[0].speaker,
    text: segments[0].text?.trim() || "",
    start: segments[0].start,
    end: segments[0].end,
    words: segments[0].words || [],
  }

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i]

    if (segment.speaker === current.speaker) {
      // Same speaker - merge
      const newText = segment.text?.trim() || ""
      if (current.text && newText) {
        current.text += " " + newText
      } else if (newText) {
        current.text = newText
      }

      current.end = segment.end
      if (current.words && segment.words) {
        current.words.push(...segment.words)
      }
    } else {
      // Different speaker - save current and start new
      merged.push(current)
      current = {
        speaker: segment.speaker,
        text: segment.text?.trim() || "",
        start: segment.start,
        end: segment.end,
        words: segment.words || [],
      }
    }
  }

  // Don't forget the last segment
  merged.push(current)

  Logger.info(
    `Merged ${segments.length} segments into ${merged.length} (reduction: ${
      segments.length - merged.length
    } segments, ${(((segments.length - merged.length) / segments.length) * 100).toFixed(1)}%)`
  )

  return merged
}

/**
 * Estimate token count for a string (rough estimate: 4 chars per token)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Create smart chunks that respect segment boundaries and token limits
 */
export function createSmartChunks(
  segments: TranscriptSegment[],
  maxTokens: number = 200000
): TranscriptSegment[][] {
  const chunks: TranscriptSegment[][] = []
  let currentChunk: TranscriptSegment[] = []
  let currentTokens = 0

  // Reserve tokens for system prompt and formatting overhead (~2000 tokens)
  const usableTokens = Math.max(maxTokens - 2000, 1000) // ensure some sane minimum

  for (const segment of segments) {
    // Estimate tokens for this segment
    const segmentText = `${segment.speaker || "UNKNOWN"}: ${segment.text || ""}`
    const segmentTokens = estimateTokens(segmentText) + 50 // +50 for JSON overhead

    // Check if adding this segment would exceed limit
    if (currentTokens + segmentTokens > usableTokens && currentChunk.length > 0) {
      // Current chunk is full, start new chunk
      chunks.push(currentChunk)
      currentChunk = [segment]
      currentTokens = segmentTokens
    } else {
      // Add segment to current chunk
      currentChunk.push(segment)
      currentTokens += segmentTokens
    }
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk)
  }

  Logger.info(`Created ${chunks.length} chunks from ${segments.length} segments`)

  return chunks
}

/**
 * Format segments for LLM input
 */
function formatSegmentsForLLM(segments: TranscriptSegment[]): string {
  const lines: string[] = []
  for (const seg of segments) {
    const speaker = seg.speaker || "UNKNOWN"
    const text = seg.text?.trim() || ""
    const start = seg.start || 0
    const end = seg.end || 0
    lines.push(`[${speaker}] (${start.toFixed(2)}-${end.toFixed(2)}s): ${text}`)
  }
  return lines.join("\n")
}

/**
 * Validate and merge refined segments with original timestamps
 * LLM is NOT allowed to change structure: same length, same timestamps.
 */
function validateAndMergeSegments(
  original: TranscriptSegment[],
  refined: unknown
): TranscriptSegment[] {
  if (!Array.isArray(refined)) {
    Logger.warn("Refined output is not an array, using original segments")
    return original
  }

  if (refined.length !== original.length) {
    Logger.warn(
      `Segment count mismatch (original: ${original.length}, refined: ${refined.length}), using original segments`
    )
    return original
  }

  const merged: TranscriptSegment[] = []

  for (let i = 0; i < original.length; i++) {
    const orig = original[i]
    const ref = refined[i]

    if (typeof ref !== "object" || ref === null) {
      merged.push(orig)
      continue
    }

    const refObj = ref as Record<string, unknown>
    const speaker = typeof refObj.speaker === "string" ? refObj.speaker : orig.speaker
    const text = typeof refObj.text === "string" ? refObj.text : orig.text

    merged.push({
      speaker,
      text,
      start: orig.start, // Always preserve original timestamps
      end: orig.end,
      words: orig.words,
    })
  }

  return merged
}

/**
 * Update word-level segments with refined speaker labels
 */
function updateWordSegments(
  wordSegments: TranscriptSegment["words"],
  refinedSegments: TranscriptSegment[]
): TranscriptSegment["words"] {
  if (!wordSegments || wordSegments.length === 0) {
    return []
  }

  const updated = [...wordSegments]
  const starts = refinedSegments.map(seg => seg.start)

  for (const word of updated) {
    const mid = (word.start + word.end) / 2

    // Find the segment this word belongs to using a simple forward scan
    let matchIndex = 0
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] <= mid) {
        matchIndex = i
      } else {
        break
      }
    }

    // Check neighborhood (±1) for better match
    let match: TranscriptSegment | null = null
    for (const offset of [-1, 0, 1]) {
      const idx = matchIndex + offset
      if (idx >= 0 && idx < refinedSegments.length) {
        const seg = refinedSegments[idx]
        if (seg.start <= mid && mid <= seg.end) {
          match = seg
          break
        }
      }
    }

    if (match) {
      word.speaker = match.speaker
    }
  }

  return updated
}

/**
 * Refine a single chunk of segments using LLM
 */
async function refineChunk(
  provider: LLMProvider,
  segments: TranscriptSegment[],
  customPrompt?: string
): Promise<TranscriptSegment[]> {
  const transcriptText = formatSegmentsForLLM(segments)
  const systemPrompt = customPrompt || DEFAULT_REFINEMENT_PROMPT

  const userPrompt = `Refine this transcript chunk:

${transcriptText}

Return ONLY a valid JSON array of segments. Each segment must have: speaker, text, start, end.
Do not include any explanation or markdown formatting, just the JSON array.`

  try {
    const { defaultBestModel } = config
    const response = await provider.converse(
      [
        {
          role: MessageRole.User,
          content: [{ text: userPrompt }],
        },
      ],
      {
        systemPrompt: systemPrompt,
        max_new_tokens: 8000,
        temperature: 0.3,
        modelId: defaultBestModel,
        stream: false,
      }
    )

    let responseText = (response.text || "").trim()

    // Remove markdown code blocks if present
    if (responseText.startsWith("```")) {
      const lines = responseText.split("\n")
      if (lines.length >= 2 && lines[lines.length - 1].trim().startsWith("```")) {
        responseText = lines.slice(1, -1).join("\n")
      }
      if (responseText.trim().toLowerCase().startsWith("json")) {
        responseText = responseText.slice(4).trim()
      }
    }

    const refinedSegments = JSON.parse(responseText)
    return validateAndMergeSegments(segments, refinedSegments)
  } catch (error) {
    Logger.warn({ error }, "LLM refinement failed for chunk, using original segments")
    return segments
  }
}

/**
 * Refine entire transcript with LLM chunking and processing
 */
export async function refineTranscript(
  result: TranscriptResult,
  options: RefinementOptions = {}
): Promise<TranscriptResult> {
  const { maxTokens = 200000, customPrompt } = options

  Logger.info("Starting transcript refinement with LLM")

  const segments = result.segments
  const wordSegments = result.word_segments || []

  // STEP 1: Normalize UNKNOWN bridge segments deterministically
  Logger.info("Normalizing UNKNOWN bridge segments...")
  const normalizedSegments = normalizeUnknownBridgeSegments(segments)

  // STEP 2: Merge consecutive segments from same speaker BEFORE LLM refinement
  Logger.info("Merging consecutive speaker segments...")
  const mergedInputSegments = mergeConsecutiveSegments(normalizedSegments)

  // STEP 3: Create chunks based on token limit
  Logger.info(`Creating chunks (max ${maxTokens} tokens per chunk)...`)
  const chunks = createSmartChunks(mergedInputSegments, maxTokens)

  // STEP 4: Get LLM provider
  const { defaultBestModel } = config
  const provider = getProviderByModel(defaultBestModel)

  // STEP 5: Process each chunk for LLM refinement
  const refinedSegments: TranscriptSegment[] = []

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    Logger.info(`Processing chunk ${i + 1}/${chunks.length} (${chunk.length} segments)...`)

    const refinedChunk = await refineChunk(provider, chunk, customPrompt)
    refinedSegments.push(...refinedChunk)
  }

  // STEP 6: Update word segments
  const refinedWordSegments = updateWordSegments(wordSegments, refinedSegments)

  // STEP 7: Get unique speakers
  const speakers = Array.from(
    new Set(refinedSegments.map(seg => seg.speaker).filter(Boolean))
  ).sort()

  Logger.info(`Refinement complete! Detected speakers: ${speakers.join(", ")}`)
  Logger.info(`Final segments: ${refinedSegments.length}`)

  return {
    text: result.text,
    segments: refinedSegments,
    word_segments: refinedWordSegments,
    language: result.language,
    speakers,
    refinement_applied: true,
    timing: result.timing,
  }
}
