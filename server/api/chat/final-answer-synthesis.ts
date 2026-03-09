import { getModelMaxInputTokens } from "@/ai/modelConfig"
import { getProviderByModel, jsonParseLLMOutput } from "@/ai/provider"
import { Models, type ConverseResponse, type ModelParams } from "@/ai/types"
import config from "@/config"
import { getLogger, getLoggerWithChild } from "@/logger"
import { AgentReasoningStepType } from "@/shared/types"
import { Subsystem } from "@/types"
import { ConversationRole } from "@aws-sdk/client-bedrock-runtime"
import type { Message } from "@aws-sdk/client-bedrock-runtime"
import { z } from "zod"
import type { AgentRunContext, PlanState, SubTask } from "./agent-schemas"
import {
  isMessageAgentStopError,
  raceWithStop,
  throwIfStopRequested,
} from "./agent-stop"
import {
  buildAgentSystemPromptContextBlock,
  formatFragmentWithMetadata,
  formatFragmentsWithMetadata,
} from "./message-agents-metadata"
import type { FragmentImageReference, MinimalAgentFragment } from "./types"

const { defaultBestModel, IMAGE_CONTEXT_CONFIG } = config

const Logger = getLogger(Subsystem.Chat)
const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

const IMAGE_TOKEN_ESTIMATE = 1_844
const FINAL_OUTPUT_HEADROOM_RATIO = 0.15
const FALLBACK_OUTPUT_TOKENS = 1_500
const PREVIEW_TEXT_LENGTH = 320
const MAX_SECTION_COUNT = 5
const MAPPER_CONCURRENCY = 4
const SECTION_CONCURRENCY = 4
const FINAL_SYNTHESIS_STREAM_CHUNK_SIZE = 200

export type FinalSynthesisExecutionResult = {
  textLength: number
  totalImagesAvailable: number
  imagesProvided: number
  estimatedCostUsd: number
  mode: "single" | "sectional"
}

type SynthesisModeSelection = {
  mode: "single" | "sectional"
  maxInputTokens: number
  safeInputBudget: number
  estimatedInputTokens: number
}

type FinalSection = {
  sectionId: number
  title: string
  objective: string
}

type SectionAnswerResult = {
  sectionId: number
  title: string
  body: string
}

type FragmentPreviewRecord = {
  fragmentIndex: number
  docId: string
  title?: string
  app?: string
  entity?: string
  timestamp?: string
  previewText: string
}

type FragmentAssignmentBatch = {
  fragmentIndex: number
  fragment: MinimalAgentFragment
}

type SelectedImagesResult = {
  selected: string[]
  total: number
  dropped: string[]
  userAttachmentCount: number
}

type SectionMappingEnvelope = {
  sections?: Record<string, number[]>
}

const SectionPlanSchema = z.object({
  sections: z
    .array(
      z.object({
        sectionId: z.number().int().positive().optional(),
        title: z.string().trim().min(1),
        objective: z.string().trim().min(1),
      }),
    )
    .min(1)
    .max(MAX_SECTION_COUNT),
})

const SectionMappingSchema = z.object({
  sections: z
    .record(z.string(), z.array(z.number().int().positive()))
    .default({}),
})

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(1, maxLength - 1))}…`
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function estimateImageTokens(imageCount: number): number {
  return imageCount * IMAGE_TOKEN_ESTIMATE
}

function estimatePromptTokens(
  systemPrompt: string,
  userMessage: string,
  imageCount = 0,
): number {
  return (
    estimateTextTokens(systemPrompt) +
    estimateTextTokens(userMessage) +
    estimateImageTokens(imageCount)
  )
}

function getErrorStringProperty(
  error: unknown,
  key: "code" | "name" | "message",
): string | undefined {
  if (typeof error !== "object" || error === null || !(key in error)) {
    return undefined
  }

  const value = (error as Record<string, unknown>)[key]
  if (value === undefined || value === null) {
    return undefined
  }

  return String(value)
}

function classifyPlannerFallbackError(error: unknown): {
  errorCode?: string
  errorName?: string
  errorMessage: string
  isContextLengthError: boolean
  isTransportError: boolean
} {
  const errorCode = getErrorStringProperty(error, "code")
  const errorName = getErrorStringProperty(error, "name")
  const errorMessage =
    getErrorStringProperty(error, "message") ??
    (error instanceof Error ? error.message : String(error))
  const normalized = `${errorName ?? ""} ${errorCode ?? ""} ${errorMessage}`.toLowerCase()

  return {
    errorCode,
    errorName,
    errorMessage,
    isContextLengthError:
      errorName === "ValidationException" ||
      normalized.includes("input is too long") ||
      normalized.includes("context length") ||
      normalized.includes("context window") ||
      normalized.includes("maximum context") ||
      normalized.includes("prompt is too long") ||
      normalized.includes("too many tokens"),
    isTransportError:
      errorName === "AbortError" ||
      normalized.includes("timeout") ||
      normalized.includes("timed out") ||
      normalized.includes("transport") ||
      normalized.includes("network") ||
      normalized.includes("connection reset") ||
      normalized.includes("econnreset") ||
      normalized.includes("etimedout") ||
      normalized.includes("econnaborted") ||
      normalized.includes("eai_again") ||
      normalized.includes("502") ||
      normalized.includes("503") ||
      normalized.includes("504"),
  }
}

function buildStoppedFinalSynthesisResult(
  mode: FinalSynthesisExecutionResult["mode"],
  imageSelection: SelectedImagesResult,
  estimatedCostUsd: number,
  textLength: number,
  imagesProvided: number,
): FinalSynthesisExecutionResult {
  return {
    textLength,
    totalImagesAvailable: imageSelection.total,
    imagesProvided,
    estimatedCostUsd,
    mode,
  }
}

function logFinalSynthesisStop(
  context: AgentRunContext,
  phase: string,
  details: Record<string, unknown> = {},
) {
  Logger.info(
    {
      chatId: context.chat.externalId,
      phase,
      ...details,
    },
    "[FinalAnswerSynthesis] Stop requested; ending synthesis early.",
  )
}

async function cancelConverseIterator(
  iterator: AsyncIterableIterator<ConverseResponse>,
) {
  const cancelableIterator = iterator as AsyncIterableIterator<ConverseResponse> & {
    cancel?: () => Promise<unknown> | unknown
    close?: () => Promise<unknown> | unknown
    return?: (
      value?: unknown,
    ) => Promise<IteratorResult<ConverseResponse>> | IteratorResult<ConverseResponse>
  }

  try {
    if (typeof cancelableIterator.return === "function") {
      await cancelableIterator.return(undefined)
      return
    }
    if (typeof cancelableIterator.cancel === "function") {
      await cancelableIterator.cancel()
      return
    }
    if (typeof cancelableIterator.close === "function") {
      await cancelableIterator.close()
    }
  } catch (error) {
    Logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
      },
      "[FinalAnswerSynthesis] Failed to cancel provider stream iterator after stop request.",
    )
  }
}

async function streamFinalAnswerChunk(
  context: AgentRunContext,
  text: string,
) {
  if (!text) return

  const streamAnswer = context.runtime?.streamAnswerText
  if (!streamAnswer) {
    throw new Error("Streaming channel unavailable. Cannot deliver final answer.")
  }

  throwIfStopRequested(context.stopSignal)
  await raceWithStop(streamAnswer(text), context.stopSignal)
  context.finalSynthesis.streamedText += text
}

function estimateSafeInputBudget(
  modelId: Models,
  maxOutputTokens?: number,
): { maxInputTokens: number; safeInputBudget: number } {
  const maxInputTokens = getModelMaxInputTokens(modelId)
  const reservedOutputTokens = Math.ceil(
    (maxOutputTokens ?? FALLBACK_OUTPUT_TOKENS) *
      (1 + FINAL_OUTPUT_HEADROOM_RATIO),
  )
  const safeInputBudget = Math.max(1_024, maxInputTokens - reservedOutputTokens)
  return { maxInputTokens, safeInputBudget }
}

export function formatPlanForPrompt(plan: PlanState | null): string {
  if (!plan) return ""
  const lines = [`Goal: ${plan.goal}`]
  plan.subTasks.forEach((task, idx) => {
    const icon =
      task.status === "completed"
        ? "✓"
        : task.status === "in_progress"
          ? "→"
          : task.status === "failed"
            ? "✗"
            : task.status === "blocked"
              ? "!"
              : "○"
    const baseLine = `${idx + 1}. [${icon}] ${task.description}`
    const detailParts: string[] = []
    if (task.result) detailParts.push(`Result: ${task.result}`)
    if (task.toolsRequired?.length) {
      detailParts.push(`Tools: ${task.toolsRequired.join(", ")}`)
    }
    lines.push(
      detailParts.length > 0 ? `${baseLine}\n   ${detailParts.join(" | ")}` : baseLine,
    )
  })
  return lines.join("\n")
}

export function formatClarificationsForPrompt(
  clarifications: AgentRunContext["clarifications"],
): string {
  if (!clarifications?.length) return ""
  return clarifications
    .map(
      (clarification, idx) =>
        `${idx + 1}. Q: ${clarification.question}\n   A: ${clarification.answer}`,
    )
    .join("\n")
}

export function buildSharedFinalAnswerContext(
  context: AgentRunContext,
): string {
  const agentSystemPromptBlock = buildAgentSystemPromptContextBlock(
    context.dedicatedAgentSystemPrompt,
  )
  const agentSystemPromptSection = agentSystemPromptBlock
    ? `Agent System Prompt Context:\n${agentSystemPromptBlock}`
    : ""
  const planSection = formatPlanForPrompt(context.plan)
  const clarificationSection = formatClarificationsForPrompt(
    context.clarifications,
  )
  const workspaceSection = context.userContext?.trim()
    ? `Workspace Context:\n${context.userContext}`
    : ""

  return [
    `User Question:\n${context.message.text}`,
    agentSystemPromptSection,
    planSection ? `Execution Plan Snapshot:\n${planSection}` : "",
    clarificationSection
      ? `Clarifications Resolved:\n${clarificationSection}`
      : "",
    workspaceSection,
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function buildBaseFinalAnswerSystemPrompt(
  mode: "final" | "section" = "final",
): string {
  const mission =
    mode === "final"
      ? "- Deliver the user's final answer using the conversation, plan snapshot, clarifications, workspace context, context fragments, and supplied images; never plan or call tools."
      : "- Deliver only the assigned answer section using the conversation, plan snapshot, clarifications, workspace context, mapped context fragments, and supplied images. Other sections are being generated in parallel and a final ordered answer will be assembled later; never attempt to write the full final answer."
  const sectionRules =
    mode === "section"
      ? `

### Section Constraints
- Write only the requested section body for the assigned section.
- Do not add a global introduction, conclusion, or next-step sentence that assumes other sections are already visible.
- Do not repeat section headings for other sections.
- Treat the provided section list as context only; answer exclusively for the assigned section.
`.trim()
      : ""

  return `
### Mission
${mission}

### Evidence Intake
- Prioritize the highest-signal fragments, but pull any supporting fragment that improves accuracy.
- Only draw on context that directly answers the user's question; ignore unrelated fragments even if they were retrieved earlier.
- Treat delegated-agent outputs as citeable fragments; reference them like any other context entry.
- Describe evidence gaps plainly before concluding; never guess.
- Extract actionable details from provided images and cite them via their fragment indices.
- Respect user-imposed constraints using fragment metadata (any metadata field). If compliant evidence is missing, state that clearly.
- If "This is the system prompt of agent:" is present, analyse for instructions relevant for answering and strictly bind by them .

### Response Construction
- Lead with the conclusion, then stack proof underneath.
- Organize output into tight sections (e.g., **Summary**, **Proof**, **Next Steps** when relevant); omit empty sections.
- Never mention internal tooling, planning logs, or this synthesis process.

### Constraint Handling
- When the user asks for an action the system cannot execute (e.g., sending an email), deliver the closest actionable substitute (draft, checklist, explicit next steps) inside the answer.
- Pair the substitute with a concise explanation of the limitation and the manual action the user must take.

### File & Chunk Formatting (CRITICAL)
- Each file starts with a header line exactly like:
  index {docId} {file context begins here...}
- \`docId\` is a unique identifier for that file (e.g., 0, 1, 2, etc.).
- Inside the file context, text is split into chunks.
- Each chunk might begin with a bracketed numeric index, e.g.: [0], [1], [2], etc.
- This is the chunk index within that file, if it exists.

### Guidelines for Response
1. Data Interpretation:
   - Use ONLY the provided files and their chunks as your knowledge base.
   - Treat every file header \`index {docId} ...\` as the start of a new document.
   - Treat every bracketed number like [0], [1], [2] as the authoritative chunk index within that document.
   - If dates exist, interpret them relative to the user's timezone when paraphrasing.
2. Response Structure:
   - Start with the most relevant facts from the chunks across files.
   - Keep order chronological when it helps comprehension.
   - Every factual statement MUST cite the exact chunk it came from using the format:
     K[docId_chunkIndex]
     where:
       - \`docId\` is taken from the file header line ("index {docId} ...").
       - \`chunkIndex\` is the bracketed number prefixed on that chunk within the same file.
   - Examples:
     - Single citation: "X is true K[12_3]."
     - Two citations in one sentence (from different files or chunks): "X K[12_3] and Y K[7_0]."
   - Use at most 1-2 citations per sentence; NEVER add more than 2 for one sentence.
3. Citation Rules (DOCUMENT+CHUNK LEVEL ONLY):
   - ALWAYS cite at the chunk level with the K[docId_chunkIndex] format.
   - Every chunk level citation must start with the K prefix eg. K[12_3] K[7_0] correct, but K[12_3] [7_0] is incorrect.
   - Place the citation immediately after the relevant claim.
   - Do NOT group indices inside one set of brackets (WRONG: "K[12_3,7_1]").
   - If a sentence draws on two distinct chunks (possibly from different files), include two separate citations inline, e.g., "... K[12_3] ... K[7_1]".
   - Only cite information that appears verbatim or is directly inferable from the cited chunk.
   - If you cannot ground a claim to a specific chunk, do not make the claim.
4. Quality Assurance:
   - Cross-check across multiple chunks/files when available and briefly note inconsistencies if they exist.
   - Keep tone professional and concise.
   - Acknowledge gaps if the provided chunks don't contain enough detail.

### Tone & Delivery
- Answer with confident, declarative, verb-first sentences that use concrete nouns.
- Highlight key deliverables using **bold** labels or short lists; keep wording razor-concise.
- Ask one targeted follow-up question only if missing info blocks action.

### Tool Spotlighting
- Reference critical tool outputs explicitly, e.g., "**Slack Search:** Ops escalated the RCA at 09:42 [2]."
- Explain why each highlighted tool mattered so reviewers see coverage breadth.
- When multiple tools contribute, show the sequence, e.g., "**Vespa Search:** context -> **Sheet Lookup:** metrics."
${sectionRules ? `\n\n${sectionRules}` : ""}

### Finish
- Close with a single sentence confirming completion or the next action you recommend.
`.trim()
}

export function buildFinalSynthesisPayload(
  context: AgentRunContext,
  fragmentsLimit = Math.max(12, context.allFragments.length || 1),
): { systemPrompt: string; userMessage: string } {
  const sharedContext = buildSharedFinalAnswerContext(context)
  const formattedFragments = formatFragmentsWithMetadata(
    context.allFragments,
    fragmentsLimit,
  )
  const fragmentsSection = formattedFragments
    ? `Context Fragments:\n${formattedFragments}`
    : ""

  return {
    systemPrompt: buildBaseFinalAnswerSystemPrompt("final"),
    userMessage: [sharedContext, fragmentsSection].filter(Boolean).join("\n\n"),
  }
}

function formatSectionPlanOverview(sections: FinalSection[]): string {
  return sections
    .map(
      (section) =>
        `${section.sectionId}. ${section.title}\n   Objective: ${section.objective}`,
    )
    .join("\n")
}

function buildPlannerSystemPrompt(): string {
  return `
You are planning a final answer for a large evidence set.

Return JSON only in the shape:
{
  "sections": [
    { "sectionId": 1, "title": "string", "objective": "string" }
  ]
}

Rules:
- Produce between 2 and ${MAX_SECTION_COUNT} sections when possible.
- Keep sections ordered exactly as the final answer should appear.
- Use concise, user-facing titles.
- Objectives should state what each section must accomplish.
- Do not include a catch-all section unless needed.
- Do not mention internal processing, tools, or token limits.
`.trim()
}

function buildMapperSystemPrompt(): string {
  return `
You are mapping evidence fragments to pre-planned answer sections.

Return JSON only in the shape:
{
  "sections": {
    "1": [3, 7],
    "2": [1]
  }
}

Rules:
- Keys are section ids.
- Values are fragment indexes from the provided batch.
- A fragment may belong to multiple sections when directly relevant.
- Omit fragments that do not help any section.
- Omit section ids with no fragments from this batch.
- Never invent fragment indexes.
`.trim()
}

function formatSectionFragments(
  entries: FragmentAssignmentBatch[],
): string {
  return entries
    .map((entry) => formatFragmentWithMetadata(entry.fragment, entry.fragmentIndex - 1))
    .join("\n\n")
}

function findTimestamp(fragment: MinimalAgentFragment): string | undefined {
  const source = fragment.source ?? {}
  return (
    source.closedAt ||
    source.resolvedAt ||
    source.createdAt ||
    undefined
  )
}

function buildFragmentPreviewRecord(
  fragment: MinimalAgentFragment,
  fragmentIndex: number,
): FragmentPreviewRecord {
  const source = fragment.source ?? {}
  const previewText = truncateText(
    normalizeWhitespace(fragment.content ?? ""),
    PREVIEW_TEXT_LENGTH,
  )

  return {
    fragmentIndex,
    docId: source.docId || fragment.id,
    title: source.title || source.page_title || undefined,
    app: source.app ? String(source.app) : undefined,
    entity: source.entity ? String(source.entity) : undefined,
    timestamp: findTimestamp(fragment),
    previewText,
  }
}

function formatPreviewRecord(preview: FragmentPreviewRecord): string {
  const meta = [
    `fragmentIndex: ${preview.fragmentIndex}`,
    `docId: ${preview.docId}`,
    preview.title ? `title: ${preview.title}` : "",
    preview.app ? `app: ${preview.app}` : "",
    preview.entity ? `entity: ${preview.entity}` : "",
    preview.timestamp ? `timestamp: ${preview.timestamp}` : "",
  ]
    .filter(Boolean)
    .join(" | ")

  return `${meta}\npreviewText: ${preview.previewText}`
}

function buildPreviewOmissionSummary(previews: FragmentPreviewRecord[]): string {
  if (previews.length === 0) return ""
  const counts = new Map<string, number>()
  for (const preview of previews) {
    const key = preview.app || "unknown"
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const summary = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key}: ${count}`)
    .join(", ")
  return `Additional fragment previews omitted due to budget: ${previews.length} (${summary}).`
}

function buildPreviewTextWithinBudget(
  previews: FragmentPreviewRecord[],
  budgetTokens: number,
): { includedText: string; omittedSummary: string } {
  if (previews.length === 0) {
    return { includedText: "None.", omittedSummary: "" }
  }

  const included: string[] = []
  let usedTokens = 0
  let cutoff = previews.length

  for (let index = 0; index < previews.length; index++) {
    const previewText = formatPreviewRecord(previews[index])
    const previewTokens = estimateTextTokens(`${previewText}\n\n`)
    if (included.length > 0 && usedTokens + previewTokens > budgetTokens) {
      cutoff = index
      break
    }
    if (included.length === 0 && previewTokens > budgetTokens) {
      included.push(previewText)
      cutoff = index + 1
      usedTokens += previewTokens
      break
    }
    included.push(previewText)
    usedTokens += previewTokens
  }

  return {
    includedText: included.join("\n\n"),
    omittedSummary: buildPreviewOmissionSummary(previews.slice(cutoff)),
  }
}

function buildFragmentBatchesWithinBudget(
  entries: FragmentAssignmentBatch[],
  baseTokens: number,
  budgetTokens: number,
): FragmentAssignmentBatch[][] {
  if (entries.length === 0) return []

  const batches: FragmentAssignmentBatch[][] = []
  let currentBatch: FragmentAssignmentBatch[] = []
  let currentTokens = baseTokens

  for (const entry of entries) {
    const itemTokens = estimateTextTokens(
      `${formatFragmentWithMetadata(entry.fragment, entry.fragmentIndex - 1)}\n\n`,
    )
    const wouldOverflow =
      currentBatch.length > 0 && currentTokens + itemTokens > budgetTokens

    if (wouldOverflow) {
      batches.push(currentBatch)
      currentBatch = []
      currentTokens = baseTokens
    }

    currentBatch.push(entry)
    currentTokens += itemTokens
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch)
  }

  return batches
}

function normalizeSectionPlan(data: z.infer<typeof SectionPlanSchema>): FinalSection[] {
  return data.sections.slice(0, MAX_SECTION_COUNT).map((section, index) => ({
    sectionId: index + 1,
    title: normalizeWhitespace(section.title),
    objective: normalizeWhitespace(section.objective),
  }))
}

function normalizeSectionAssignments(
  raw: SectionMappingEnvelope,
  sections: FinalSection[],
): Map<number, Set<number>> {
  const validSectionIds = new Set(sections.map((section) => section.sectionId))
  const merged = new Map<number, Set<number>>()

  for (const [key, indexes] of Object.entries(raw.sections ?? {})) {
    const sectionId = Number(key)
    if (!validSectionIds.has(sectionId)) continue
    const target = merged.get(sectionId) ?? new Set<number>()
    for (const index of indexes) {
      if (Number.isInteger(index) && index > 0) {
        target.add(index)
      }
    }
    if (target.size > 0) {
      merged.set(sectionId, target)
    }
  }

  return merged
}

function mergeSectionAssignments(
  assignments: Array<Map<number, Set<number>>>,
  sections: FinalSection[],
): Map<number, number[]> {
  const merged = new Map<number, Set<number>>()
  for (const section of sections) {
    merged.set(section.sectionId, new Set<number>())
  }
  for (const batchAssignment of assignments) {
    for (const [sectionId, indexes] of batchAssignment.entries()) {
      const target = merged.get(sectionId) ?? new Set<number>()
      for (const index of indexes) {
        target.add(index)
      }
      merged.set(sectionId, target)
    }
  }

  return new Map(
    Array.from(merged.entries()).map(([sectionId, indexes]) => [
      sectionId,
      Array.from(indexes).sort((a, b) => a - b),
    ]),
  )
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let cursor = 0

  const runWorker = async () => {
    while (true) {
      const current = cursor
      cursor += 1
      if (current >= items.length) {
        return
      }
      results[current] = await worker(items[current], current)
    }
  }

  const concurrency = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: concurrency }, () => runWorker()))
  return results
}

function buildDefaultSectionPlan(): FinalSection[] {
  return [
    {
      sectionId: 1,
      title: "Answer",
      objective: "Provide the best complete answer using the mapped evidence.",
    },
  ]
}

function createSelectedImagesResult(
  images: FragmentImageReference[],
  turnCount: number,
): SelectedImagesResult {
  const total = images.length
  if (!IMAGE_CONTEXT_CONFIG.enabled || total === 0) {
    return { selected: [], total, dropped: [], userAttachmentCount: 0 }
  }

  const attachments = images.filter((img) => img.isUserAttachment)
  const nonAttachments = images
    .filter((img) => !img.isUserAttachment)
    .sort((a, b) => {
      const ageA = turnCount - a.addedAtTurn
      const ageB = turnCount - b.addedAtTurn
      return ageA - ageB
    })

  const prioritized = [...attachments, ...nonAttachments]
  const uniqueNames: string[] = []
  const seen = new Set<string>()
  for (const image of prioritized) {
    if (seen.has(image.fileName)) continue
    seen.add(image.fileName)
    uniqueNames.push(image.fileName)
  }

  let selected = uniqueNames
  let dropped: string[] = []

  if (
    IMAGE_CONTEXT_CONFIG.maxImagesPerCall > 0 &&
    uniqueNames.length > IMAGE_CONTEXT_CONFIG.maxImagesPerCall
  ) {
    selected = uniqueNames.slice(0, IMAGE_CONTEXT_CONFIG.maxImagesPerCall)
    dropped = uniqueNames.slice(IMAGE_CONTEXT_CONFIG.maxImagesPerCall)
  }

  return {
    selected,
    total,
    dropped,
    userAttachmentCount: attachments.length,
  }
}

function selectImagesForFinalSynthesis(
  context: AgentRunContext,
): SelectedImagesResult {
  return createSelectedImagesResult(context.allImages, context.turnCount)
}

function selectImagesForFragmentIds(
  context: AgentRunContext,
  fragmentIds: Set<string>,
): SelectedImagesResult {
  const images = context.allImages.filter((image) =>
    fragmentIds.has(image.sourceFragmentId),
  )
  return createSelectedImagesResult(images, context.turnCount)
}

function selectMappedEntriesWithinBudget(
  entries: FragmentAssignmentBatch[],
  baseTokens: number,
  budgetTokens: number,
): {
  selected: FragmentAssignmentBatch[]
  trimmedCount: number
  skippedForBudgetCount: number
} {
  if (entries.length === 0) {
    return { selected: [], trimmedCount: 0, skippedForBudgetCount: 0 }
  }

  const selected: FragmentAssignmentBatch[] = []
  let usedTokens = baseTokens
  let skippedForBudgetCount = 0

  for (const entry of entries) {
    const entryTokens = estimateTextTokens(
      `${formatFragmentWithMetadata(entry.fragment, entry.fragmentIndex - 1)}\n\n`,
    )
    if (usedTokens + entryTokens > budgetTokens) {
      skippedForBudgetCount += 1
      continue
    }
    selected.push(entry)
    usedTokens += entryTokens
  }

  return {
    selected,
    trimmedCount: Math.max(entries.length - selected.length, 0),
    skippedForBudgetCount,
  }
}

function buildSectionAnswerPayload(
  context: AgentRunContext,
  sections: FinalSection[],
  section: FinalSection,
  entries: FragmentAssignmentBatch[],
  imageFileNames: string[],
): { systemPrompt: string; userMessage: string; imageFileNames: string[] } {
  const sharedContext = buildSharedFinalAnswerContext(context)
  const sectionOverview = formatSectionPlanOverview(sections)
  const fragmentsText = formatSectionFragments(entries)
  const fragmentsSection = fragmentsText
    ? `Context Fragments For This Section:\n${fragmentsText}`
    : "Context Fragments For This Section:\nNone."

  const userMessage = [
    sharedContext,
    `All Planned Sections (generated in parallel; a final ordered answer will be assembled later):\n${sectionOverview}`,
    `Assigned Section:\n${section.sectionId}. ${section.title}\nObjective: ${section.objective}`,
    [
      "Section Instructions:",
      "- Write only this section.",
      "- Do not write the full final answer.",
      "- Other sections are being generated in parallel.",
      "- A final ordered answer will be assembled afterwards.",
      "- Avoid intro or outro language that assumes the whole answer is already visible.",
      "- Use the provided global fragment indexes exactly as shown for citations.",
    ].join("\n"),
    fragmentsSection,
  ]
    .filter(Boolean)
    .join("\n\n")

  return {
    systemPrompt: buildBaseFinalAnswerSystemPrompt("section"),
    userMessage,
    imageFileNames,
  }
}

function decideSynthesisMode(
  context: AgentRunContext,
  modelId: Models,
  imageSelection: SelectedImagesResult,
): SynthesisModeSelection {
  const payload = buildFinalSynthesisPayload(
    context,
    Math.max(12, context.allFragments.length || 1),
  )
  const { maxInputTokens, safeInputBudget } = estimateSafeInputBudget(
    modelId,
    context.maxOutputTokens,
  )
  const estimatedInputTokens = estimatePromptTokens(
    payload.systemPrompt,
    payload.userMessage,
    imageSelection.selected.length,
  )

  return {
    mode: estimatedInputTokens > safeInputBudget ? "sectional" : "single",
    maxInputTokens,
    safeInputBudget,
    estimatedInputTokens,
  }
}

async function planSections(
  context: AgentRunContext,
  providerModelId: Models,
  safeInputBudget: number,
): Promise<{ sections: FinalSection[]; estimatedCostUsd: number }> {
  throwIfStopRequested(context.stopSignal)

  const previews = context.allFragments.map((fragment, index) =>
    buildFragmentPreviewRecord(fragment, index + 1),
  )
  const sharedContext = buildSharedFinalAnswerContext(context)
  const plannerUserIntro = [
    sharedContext,
    "Create the final answer section plan using the fragment previews below.",
    `Return at most ${MAX_SECTION_COUNT} sections.`,
    "Fragment Previews:",
  ].join("\n\n")
  const baseTokens =
    estimatePromptTokens(
      buildPlannerSystemPrompt(),
      plannerUserIntro,
      0,
    ) + 256
  if (baseTokens >= safeInputBudget) {
    Logger.warn(
      {
        baseTokens,
        safeInputBudget,
        chatId: context.chat.externalId,
      },
      "[FinalAnswerSynthesis] Planner base prompt exceeds safe budget; falling back to default section plan.",
    )
    return {
      sections: buildDefaultSectionPlan(),
      estimatedCostUsd: 0,
    }
  }

  const previewBudget = safeInputBudget - baseTokens
  const { includedText, omittedSummary } = buildPreviewTextWithinBudget(
    previews,
    previewBudget,
  )
  const userMessage = [plannerUserIntro, includedText, omittedSummary]
    .filter(Boolean)
    .join("\n\n")

  let response: ConverseResponse
  throwIfStopRequested(context.stopSignal)
  try {
    response = await raceWithStop(
      getProviderByModel(providerModelId).converse(
        [
          {
            role: ConversationRole.USER,
            content: [{ text: userMessage }],
          },
        ],
        {
          modelId: providerModelId,
          json: true,
          stream: false,
          temperature: 0,
          max_new_tokens: 800,
          systemPrompt: buildPlannerSystemPrompt(),
        },
      ),
      context.stopSignal,
    )
  } catch (error) {
    if (isMessageAgentStopError(error)) {
      throw error
    }

    const {
      errorCode,
      errorMessage,
      errorName,
      isContextLengthError,
      isTransportError,
    } = classifyPlannerFallbackError(error)
    Logger.warn(
      {
        baseTokens,
        previewBudget,
        errorCode,
        errorMessage,
        errorName,
        isContextLengthError,
        isTransportError,
        chatId: context.chat.externalId,
      },
      "[FinalAnswerSynthesis] Planner request failed; falling back to default section plan.",
    )
    return {
      sections: buildDefaultSectionPlan(),
      estimatedCostUsd: 0,
    }
  }

  throwIfStopRequested(context.stopSignal)
  const parsed = SectionPlanSchema.safeParse(
    jsonParseLLMOutput(response.text ?? ""),
  )

  if (!parsed.success) {
    Logger.warn(
      {
        issues: parsed.error.issues,
        response: response.text,
        chatId: context.chat.externalId,
      },
      "[FinalAnswerSynthesis] Invalid planner output; falling back to default section plan.",
    )
    return {
      sections: buildDefaultSectionPlan(),
      estimatedCostUsd: response.cost ?? 0,
    }
  }

  return {
    sections: normalizeSectionPlan(parsed.data),
    estimatedCostUsd: response.cost ?? 0,
  }
}

async function mapFragmentsToSections(
  context: AgentRunContext,
  sections: FinalSection[],
  providerModelId: Models,
  safeInputBudget: number,
): Promise<{ assignments: Map<number, number[]>; estimatedCostUsd: number }> {
  throwIfStopRequested(context.stopSignal)

  const sharedContext = buildSharedFinalAnswerContext(context)
  const sectionOverview = formatSectionPlanOverview(sections)
  const batchIntro = [
    sharedContext,
    `Sections:\n${sectionOverview}`,
    "Map the following fragments to the relevant section ids.",
    "Fragments:",
  ].join("\n\n")
  const baseTokens =
    estimatePromptTokens(buildMapperSystemPrompt(), batchIntro, 0) + 256
  const entries = context.allFragments.map((fragment, index) => ({
    fragmentIndex: index + 1,
    fragment,
  }))
  const batches = buildFragmentBatchesWithinBudget(
    entries,
    baseTokens,
    safeInputBudget,
  )

  if (batches.length === 0) {
    return { assignments: new Map(), estimatedCostUsd: 0 }
  }

  const batchResults = await raceWithStop(
    runWithConcurrency(
      batches,
      MAPPER_CONCURRENCY,
      async (batch) => {
        throwIfStopRequested(context.stopSignal)

        const fragmentsText = formatSectionFragments(batch)
        const userMessage = [batchIntro, fragmentsText].join("\n\n")
        try {
          const response = await raceWithStop(
            getProviderByModel(providerModelId).converse(
              [
                {
                  role: ConversationRole.USER,
                  content: [{ text: userMessage }],
                },
              ],
              {
                modelId: providerModelId,
                json: true,
                stream: false,
                temperature: 0,
                max_new_tokens: 1_000,
                systemPrompt: buildMapperSystemPrompt(),
              },
            ),
            context.stopSignal,
          )

          throwIfStopRequested(context.stopSignal)
          const parsed = SectionMappingSchema.safeParse(
            jsonParseLLMOutput(response.text ?? ""),
          )
          if (!parsed.success) {
            Logger.warn(
              {
                issues: parsed.error.issues,
                response: response.text,
                chatId: context.chat.externalId,
              },
              "[FinalAnswerSynthesis] Invalid mapper output for batch; skipping batch.",
            )
            return {
              assignments: new Map<number, Set<number>>(),
              estimatedCostUsd: response.cost ?? 0,
            }
          }

          return {
            assignments: normalizeSectionAssignments(parsed.data, sections),
            estimatedCostUsd: response.cost ?? 0,
          }
        } catch (error) {
          if (isMessageAgentStopError(error)) {
            throw error
          }

          Logger.warn(
            {
              err: error instanceof Error ? error.message : String(error),
              chatId: context.chat.externalId,
            },
            "[FinalAnswerSynthesis] Mapper batch failed; skipping batch.",
          )
          return {
            assignments: new Map<number, Set<number>>(),
            estimatedCostUsd: 0,
          }
        }
      },
    ),
    context.stopSignal,
  )

  return {
    assignments: mergeSectionAssignments(
      batchResults.map((result) => result.assignments),
      sections,
    ),
    estimatedCostUsd: batchResults.reduce(
      (sum, result) => sum + result.estimatedCostUsd,
      0,
    ),
  }
}

function buildDefaultAssignments(
  context: AgentRunContext,
  sections: FinalSection[],
): Map<number, number[]> {
  const indexes = context.allFragments.map((_, index) => index + 1)
  return new Map(
    sections.map((section) => [section.sectionId, [...indexes]]),
  )
}

async function synthesizeSingleAnswer(
  context: AgentRunContext,
  modelId: Models,
  imageSelection: SelectedImagesResult,
): Promise<FinalSynthesisExecutionResult> {
  if (!context.runtime?.streamAnswerText) {
    throw new Error("Streaming channel unavailable. Cannot deliver final answer.")
  }
  if (context.stopSignal?.aborted) {
    logFinalSynthesisStop(context, "single:before-stream-start")
    return buildStoppedFinalSynthesisResult(
      "single",
      imageSelection,
      0,
      context.finalSynthesis.streamedText.length,
      0,
    )
  }

  const { systemPrompt, userMessage } = buildFinalSynthesisPayload(context)
  const provider = getProviderByModel(modelId)
  let streamedCharacters = 0
  let estimatedCostUsd = 0

  const iterator = provider.converseStream(
    [
      {
        role: ConversationRole.USER,
        content: [
          {
            text: `${userMessage}\n\nSynthesize the final answer using the evidence above.`,
          },
        ],
      },
    ],
    {
      modelId,
      systemPrompt,
      stream: true,
      temperature: 0.2,
      max_new_tokens: context.maxOutputTokens ?? FALLBACK_OUTPUT_TOKENS,
      imageFileNames: imageSelection.selected,
    },
  )

  let stopRequested = false
  try {
    throwIfStopRequested(context.stopSignal)
    for await (const chunk of iterator) {
      throwIfStopRequested(context.stopSignal)

      if (chunk.text) {
        await streamFinalAnswerChunk(context, chunk.text)
        streamedCharacters += chunk.text.length
        throwIfStopRequested(context.stopSignal)
      }

      const chunkCost = chunk.metadata?.cost
      if (typeof chunkCost === "number" && !Number.isNaN(chunkCost)) {
        estimatedCostUsd += chunkCost
      }
    }
    throwIfStopRequested(context.stopSignal)
  } catch (error) {
    if (!isMessageAgentStopError(error)) {
      throw error
    }

    stopRequested = true
    logFinalSynthesisStop(context, "single:streaming", {
      estimatedCostUsd,
      streamedCharacters,
    })
    return buildStoppedFinalSynthesisResult(
      "single",
      imageSelection,
      estimatedCostUsd,
      streamedCharacters,
      imageSelection.selected.length,
    )
  } finally {
    if (stopRequested || context.stopSignal?.aborted) {
      await cancelConverseIterator(iterator)
    }
  }

  return {
    textLength: streamedCharacters,
    totalImagesAvailable: imageSelection.total,
    imagesProvided: imageSelection.selected.length,
    estimatedCostUsd,
    mode: "single",
  }
}

async function synthesizeSection(
  context: AgentRunContext,
  sections: FinalSection[],
  section: FinalSection,
  mappedIndexes: number[],
  providerModelId: Models,
  safeInputBudget: number,
): Promise<{
  result: SectionAnswerResult | null
  estimatedCostUsd: number
  imageFileNames: string[]
}> {
  throwIfStopRequested(context.stopSignal)

  const orderedEntries = mappedIndexes
    .map((index) => ({
      fragmentIndex: index,
      fragment: context.allFragments[index - 1],
    }))
    .filter((entry) => !!entry.fragment) as FragmentAssignmentBatch[]

  if (orderedEntries.length === 0) {
    return { result: null, estimatedCostUsd: 0, imageFileNames: [] }
  }

  let emptyPayload = buildSectionAnswerPayload(
    context,
    sections,
    section,
    [],
    [],
  )
  let baseTokens =
    estimatePromptTokens(emptyPayload.systemPrompt, emptyPayload.userMessage, 0) +
    128
  let { selected, trimmedCount, skippedForBudgetCount } =
    selectMappedEntriesWithinBudget(
    orderedEntries,
    baseTokens,
    safeInputBudget,
    )
  let fragmentIds = new Set(selected.map((entry) => entry.fragment.id))
  let imageSelection = selectImagesForFragmentIds(context, fragmentIds)

  emptyPayload = buildSectionAnswerPayload(
    context,
    sections,
    section,
    [],
    imageSelection.selected,
  )
  const imageAwareBaseTokens =
    estimatePromptTokens(
      emptyPayload.systemPrompt,
      emptyPayload.userMessage,
      imageSelection.selected.length,
    ) + 128

  if (imageAwareBaseTokens > baseTokens) {
    baseTokens = imageAwareBaseTokens
    const imageAwareSelection = selectMappedEntriesWithinBudget(
      orderedEntries,
      baseTokens,
      safeInputBudget,
    )
    selected = imageAwareSelection.selected
    trimmedCount = imageAwareSelection.trimmedCount
    skippedForBudgetCount = imageAwareSelection.skippedForBudgetCount
    fragmentIds = new Set(selected.map((entry) => entry.fragment.id))
    imageSelection = selectImagesForFragmentIds(context, fragmentIds)
  }

  if (trimmedCount > 0) {
    loggerWithChild({ email: context.user.email }).info(
      {
        chatId: context.chat.externalId,
        sectionId: section.sectionId,
        orderedEntryCount: orderedEntries.length,
        selectedCount: selected.length,
        trimmedCount,
        skippedForBudgetCount,
        imageCount: imageSelection.selected.length,
      },
      "[FinalAnswerSynthesis] Trimmed mapped fragments to fit section input budget.",
    )
  }

  if (selected.length === 0) {
    loggerWithChild({ email: context.user.email }).info(
      {
        chatId: context.chat.externalId,
        sectionId: section.sectionId,
        orderedEntryCount: orderedEntries.length,
        skippedForBudgetCount,
      },
      "[FinalAnswerSynthesis] No mapped fragments fit within the section input budget; omitting section.",
    )
    return { result: null, estimatedCostUsd: 0, imageFileNames: [] }
  }

  const payload = buildSectionAnswerPayload(
    context,
    sections,
    section,
    selected,
    imageSelection.selected,
  )
  const sectionMaxTokens = Math.min(
    context.maxOutputTokens ?? FALLBACK_OUTPUT_TOKENS,
    Math.max(
      250,
      Math.ceil(
        (context.maxOutputTokens ?? FALLBACK_OUTPUT_TOKENS) /
          Math.max(sections.length, 1),
      ),
    ),
  )

  throwIfStopRequested(context.stopSignal)
  try {
    const response = await raceWithStop(
      getProviderByModel(providerModelId).converse(
        [
          {
            role: ConversationRole.USER,
            content: [{ text: payload.userMessage }],
          },
        ],
        {
          modelId: providerModelId,
          stream: false,
          temperature: 0.2,
          max_new_tokens: sectionMaxTokens,
          systemPrompt: payload.systemPrompt,
          imageFileNames: payload.imageFileNames,
        },
      ),
      context.stopSignal,
    )

    throwIfStopRequested(context.stopSignal)
    const body = response.text?.trim() ?? ""
    return {
      result: body
        ? {
            sectionId: section.sectionId,
            title: section.title,
            body,
          }
        : null,
      estimatedCostUsd: response.cost ?? 0,
      imageFileNames: payload.imageFileNames,
    }
  } catch (error) {
    if (isMessageAgentStopError(error)) {
      throw error
    }

    Logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        chatId: context.chat.externalId,
        sectionId: section.sectionId,
      },
      "[FinalAnswerSynthesis] Section synthesis failed; omitting section.",
    )
    return {
      result: null,
      estimatedCostUsd: 0,
      imageFileNames: payload.imageFileNames,
    }
  }
}

function assembleSectionAnswers(results: SectionAnswerResult[]): string {
  return results
    .sort((a, b) => a.sectionId - b.sectionId)
    .map((result) => `**${result.title}**\n${result.body}`)
    .join("\n\n")
    .trim()
}

async function synthesizeSectionalAnswer(
  context: AgentRunContext,
  modelId: Models,
  imageSelection: SelectedImagesResult,
  safeInputBudget: number,
): Promise<FinalSynthesisExecutionResult> {
  let estimatedCostUsd = 0
  const uniqueImagesProvided = new Set<string>()

  try {
    throwIfStopRequested(context.stopSignal)

    await raceWithStop(
      context.runtime?.emitReasoning?.({
        text: `Final synthesis exceeded the model input budget. Switching to sectional synthesis across ${context.allFragments.length} fragments.`,
        step: { type: AgentReasoningStepType.LogMessage },
      }) ?? Promise.resolve(),
      context.stopSignal,
    )

    throwIfStopRequested(context.stopSignal)
    const planned = await raceWithStop(
      planSections(context, modelId, safeInputBudget),
      context.stopSignal,
    )
    estimatedCostUsd += planned.estimatedCostUsd
    let sections = planned.sections

    throwIfStopRequested(context.stopSignal)
    const mapped = await raceWithStop(
      mapFragmentsToSections(context, sections, modelId, safeInputBudget),
      context.stopSignal,
    )
    estimatedCostUsd += mapped.estimatedCostUsd

    let assignments = mapped.assignments
    const hasAssignments = Array.from(assignments.values()).some(
      (indexes) => indexes.length > 0,
    )

    if (!hasAssignments) {
      sections = buildDefaultSectionPlan()
      assignments = buildDefaultAssignments(context, sections)
    }

    throwIfStopRequested(context.stopSignal)
    const sectionResults = await raceWithStop(
      runWithConcurrency(
        sections,
        SECTION_CONCURRENCY,
        async (section) =>
          synthesizeSection(
            context,
            sections,
            section,
            assignments.get(section.sectionId) ?? [],
            modelId,
            safeInputBudget,
          ),
      ),
      context.stopSignal,
    )

    estimatedCostUsd += sectionResults.reduce(
      (sum, result) => sum + result.estimatedCostUsd,
      0,
    )

    for (const result of sectionResults) {
      for (const imageName of result.imageFileNames) {
        uniqueImagesProvided.add(imageName)
      }
    }

    let assembledText = assembleSectionAnswers(
      sectionResults
        .map((result) => result.result)
        .filter((result): result is SectionAnswerResult => !!result),
    )

    if (!assembledText) {
      throwIfStopRequested(context.stopSignal)
      const fallbackSections = buildDefaultSectionPlan()
      const fallbackAssignments = buildDefaultAssignments(
        context,
        fallbackSections,
      )
      const fallback = await raceWithStop(
        synthesizeSection(
          context,
          fallbackSections,
          fallbackSections[0],
          fallbackAssignments.get(1) ?? [],
          modelId,
          safeInputBudget,
        ),
        context.stopSignal,
      )
      estimatedCostUsd += fallback.estimatedCostUsd
      assembledText = assembleSectionAnswers(
        fallback.result ? [fallback.result] : [],
      )
      if (fallback.result) {
        sectionResults.push(fallback)
      }
      for (const imageName of fallback.imageFileNames) {
        uniqueImagesProvided.add(imageName)
      }
    }

    throwIfStopRequested(context.stopSignal)
    if (!assembledText) {
      throw new Error("Sectional final synthesis produced no answer text.")
    }

    context.finalSynthesis.streamedText = ""
    let streamedCharacters = 0
    for (
      let offset = 0;
      offset < assembledText.length;
      offset += FINAL_SYNTHESIS_STREAM_CHUNK_SIZE
    ) {
      throwIfStopRequested(context.stopSignal)
      const chunk = assembledText.slice(
        offset,
        offset + FINAL_SYNTHESIS_STREAM_CHUNK_SIZE,
      )
      await streamFinalAnswerChunk(context, chunk)
      streamedCharacters += chunk.length
    }

    return {
      textLength: streamedCharacters,
      totalImagesAvailable: imageSelection.total,
      imagesProvided: uniqueImagesProvided.size,
      estimatedCostUsd,
      mode: "sectional",
    }
  } catch (error) {
    if (!isMessageAgentStopError(error)) {
      throw error
    }

    logFinalSynthesisStop(context, "sectional", {
      estimatedCostUsd,
      streamedCharacters: context.finalSynthesis.streamedText.length,
      imagesProvided: uniqueImagesProvided.size,
    })
    return buildStoppedFinalSynthesisResult(
      "sectional",
      imageSelection,
      estimatedCostUsd,
      context.finalSynthesis.streamedText.length,
      uniqueImagesProvided.size,
    )
  }
}

export async function executeFinalSynthesis(
  context: AgentRunContext,
): Promise<FinalSynthesisExecutionResult> {
  const modelId =
    (context.modelId as Models) ||
    (defaultBestModel as Models) ||
    Models.Gpt_4o
  const imageSelection = selectImagesForFinalSynthesis(context)
  const modeSelection = decideSynthesisMode(context, modelId, imageSelection)

  loggerWithChild({ email: context.user.email }).debug(
    {
      chatId: context.chat.externalId,
      mode: modeSelection.mode,
      maxInputTokens: modeSelection.maxInputTokens,
      safeInputBudget: modeSelection.safeInputBudget,
      estimatedInputTokens: modeSelection.estimatedInputTokens,
      fragmentsCount: context.allFragments.length,
      selectedImages: imageSelection.selected,
      droppedImages: imageSelection.dropped,
      userAttachmentCount: imageSelection.userAttachmentCount,
    },
    "[FinalAnswerSynthesis] Selected final synthesis mode.",
  )

  if (imageSelection.dropped.length > 0) {
    loggerWithChild({ email: context.user.email }).info(
      {
        chatId: context.chat.externalId,
        droppedCount: imageSelection.dropped.length,
        limit: IMAGE_CONTEXT_CONFIG.maxImagesPerCall,
        totalImages: imageSelection.total,
      },
      "[FinalAnswerSynthesis] Image limit enforced for single-shot selection.",
    )
  }

  if (context.stopSignal?.aborted) {
    logFinalSynthesisStop(context, "execute:before-mode-branch")
    return buildStoppedFinalSynthesisResult(
      modeSelection.mode,
      imageSelection,
      0,
      context.finalSynthesis.streamedText.length,
      0,
    )
  }

  return modeSelection.mode === "single"
    ? synthesizeSingleAnswer(context, modelId, imageSelection)
    : synthesizeSectionalAnswer(
        context,
        modelId,
        imageSelection,
        modeSelection.safeInputBudget,
      )
}

export const __finalAnswerSynthesisInternals = {
  buildFragmentPreviewRecord,
  buildSectionAnswerPayload,
  decideSynthesisMode,
  selectImagesForFragmentIds,
  selectMappedEntriesWithinBudget,
  synthesizeSection,
}
