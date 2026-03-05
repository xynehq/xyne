import { ConversationRole } from "@aws-sdk/client-bedrock-runtime"
import type { Message } from "@aws-sdk/client-bedrock-runtime"
import type { MinimalAgentFragment } from "./types"

const METADATA_VALUE_MAX_LENGTH = 220
const METADATA_TERM_MAX_LENGTH = 96
const AGENT_SYSTEM_PROMPT_MAX_LENGTH = 6000
const AGENT_SYSTEM_PROMPT_LABEL = "This is the system prompt of agent:"
const METADATA_QUERY_TRIGGER =
  /\b(only|strictly|exclusively|from|source|sources|document|documents|doc|docs|file|files|app|entity|exclude|excluding|except|without|not)\b/i
const METADATA_STRICT_TRIGGER = /\b(only|strictly|exclusively|just)\b/i
const METADATA_TARGETED_TRIGGER =
  /\b(only|strictly|exclusively|source|sources|document|documents|doc|docs|file|files|app|entity|exclude|excluding|except|without|not)\b/i
const NON_SIGNAL_TERMS = new Set([
  "the",
  "a",
  "an",
  "document",
  "documents",
  "doc",
  "docs",
  "file",
  "files",
  "source",
  "sources",
  "app",
  "entity",
  "metadata",
  "chunk",
  "chunks",
  "context",
  "data",
  "result",
  "results",
])

type MetadataQueryConstraints = {
  includeTerms: string[]
  excludeTerms: string[]
  strict: boolean
}

type RankedMetadataCandidate = {
  fragment: MinimalAgentFragment
  includeScore: number
  excludeScore: number
  score: number
  compliant: boolean
}

function truncateValue(value: string, maxLength = 160): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1)}…`
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

export function sanitizeAgentSystemPromptSnapshot(
  prompt: string | undefined
): string | undefined {
  if (!prompt || typeof prompt !== "string") {
    return undefined
  }
  const normalized = normalizeWhitespace(prompt)
  if (!normalized) {
    return undefined
  }
  return truncateValue(normalized, AGENT_SYSTEM_PROMPT_MAX_LENGTH)
}

export function buildAgentSystemPromptContextBlock(
  prompt: string | undefined
): string | undefined {
  const snapshot = sanitizeAgentSystemPromptSnapshot(prompt)
  if (!snapshot) {
    return undefined
  }
  return `${AGENT_SYSTEM_PROMPT_LABEL}
<system prompt>
${snapshot}
</system prompt>`
}

function hasAgentSystemPromptBlock(messages: Message[]): boolean {
  return messages.some((message) => {
    const content = (message as any)?.content
    if (!Array.isArray(content)) return false
    return content.some((entry: any) => {
      return (
        typeof entry?.text === "string" &&
        entry.text.includes(AGENT_SYSTEM_PROMPT_LABEL)
      )
    })
  })
}

export function withAgentSystemPromptMessage(
  messages: Message[],
  prompt: string | undefined
): Message[] {
  const block = buildAgentSystemPromptContextBlock(prompt)
  if (!block || hasAgentSystemPromptBlock(messages)) {
    return messages
  }
  return [
    ...messages,
    {
      role: ConversationRole.USER,
      content: [{ text: block }],
    },
  ]
}

function normalizeMetadataValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  let serialized = ""
  if (typeof value === "string") {
    serialized = value
  } else if (typeof value === "number" || typeof value === "boolean") {
    serialized = String(value)
  } else if (Array.isArray(value)) {
    serialized = value
      .map((entry) => (entry === undefined || entry === null ? "" : String(entry)))
      .filter(Boolean)
      .join(", ")
  } else {
    try {
      serialized = JSON.stringify(value)
    } catch {
      serialized = String(value)
    }
  }
  const normalized = normalizeWhitespace(serialized)
  if (!normalized) return null
  return truncateValue(normalized, METADATA_VALUE_MAX_LENGTH)
}

function collectFragmentMetadataEntries(
  fragment: MinimalAgentFragment
): Array<[string, string]> {
  const source = (fragment.source || {}) as Record<string, unknown>
  const preferredOrder = [
    "title",
    "page_title",
    "app",
    "entity",
    "docId",
    "url",
    "threadId",
    "itemId",
    "clId",
    "parentThreadId",
    "createdAt",
    "resolvedAt",
    "closedAt",
    "status",
    "ticketNumber",
  ]
  const keys = Object.keys(source)
  const orderedKeys = [
    ...preferredOrder.filter((key) => key in source),
    ...keys.filter((key) => !preferredOrder.includes(key)).sort(),
  ]

  const entries: Array<[string, string]> = []
  for (const key of orderedKeys) {
    const normalized = normalizeMetadataValue(source[key])
    if (!normalized) continue
    entries.push([key, normalized])
  }

  const fragmentId = normalizeMetadataValue(fragment.id)
  if (fragmentId) {
    entries.push(["fragmentId", fragmentId])
  }
  return entries
}

function buildFragmentMetadataSearchText(fragment: MinimalAgentFragment): string {
  const pairs = collectFragmentMetadataEntries(fragment)
  const metadataText = pairs.map(([key, value]) => `${key}: ${value}`).join(" | ")
  const confidenceText =
    typeof fragment.confidence === "number" && Number.isFinite(fragment.confidence)
      ? ` | confidence: ${fragment.confidence.toFixed(3)}`
      : ""
  return `${metadataText}${confidenceText}`.toLowerCase()
}

export function formatFragmentWithMetadata(
  fragment: MinimalAgentFragment,
  index: number
): string {
  const metadataEntries = collectFragmentMetadataEntries(fragment)
  if (typeof fragment.confidence === "number" && Number.isFinite(fragment.confidence)) {
    metadataEntries.push(["confidence", fragment.confidence.toFixed(3)])
  }
  const metadataBlock = metadataEntries.length
    ? metadataEntries.map(([key, value]) => `- ${key}: ${value}`).join("\n")
    : "- unavailable"
  const content = fragment.content?.trim() || "No content."
  return `index ${index + 1} {file context begins here...}
Metadata:
${metadataBlock}
Content:
${content}`
}

export function formatFragmentsWithMetadata(
  fragments: MinimalAgentFragment[],
  maxFragments?: number
): string {
  if (!fragments || fragments.length === 0) {
    return ""
  }
  const limit =
    typeof maxFragments === "number"
      ? Math.max(0, Math.min(maxFragments, fragments.length))
      : fragments.length
  if (limit === 0) {
    return ""
  }
  return fragments
    .slice(0, limit)
    .map((fragment, index) => formatFragmentWithMetadata(fragment, index))
    .join("\n\n")
}

function splitConstraintCandidates(raw: string): string[] {
  return raw
    .split(/,|;|\band\b|\bor\b/gi)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean)
}

function normalizeConstraintTerm(raw: string): string | null {
  let normalized = normalizeWhitespace(raw.toLowerCase())
  if (!normalized) return null
  normalized = normalized
    .replace(/^[\s"'`]+|[\s"'`]+$/g, "")
    .replace(
      /\b(?:documents?|docs?|files?|sources?|metadata|records?|items?)\b/g,
      " "
    )
  normalized = normalizeWhitespace(normalized).replace(/[.?!,:;]+$/g, "")
  if (!normalized || normalized.length < 2) return null
  if (NON_SIGNAL_TERMS.has(normalized)) return null
  if (
    /^(last|this|next)\s+(day|week|month|quarter|year)$/i.test(normalized) ||
    /^(today|yesterday|tomorrow)$/i.test(normalized) ||
    /^\d{4}$/.test(normalized)
  ) {
    return null
  }
  if (normalized.split(/\s+/).length > 8) return null
  return truncateValue(normalized, METADATA_TERM_MAX_LENGTH)
}

function addConstraintTerms(
  target: Set<string>,
  rawValue: string
): void {
  splitConstraintCandidates(rawValue).forEach((candidate) => {
    const normalized = normalizeConstraintTerm(candidate)
    if (normalized) {
      target.add(normalized)
    }
  })
}

export function extractMetadataConstraintsFromUserMessage(
  userMessage: string
): MetadataQueryConstraints {
  const includeTerms = new Set<string>()
  const excludeTerms = new Set<string>()
  const normalizedMessage = normalizeWhitespace(userMessage)
  if (!normalizedMessage) {
    return { includeTerms: [], excludeTerms: [], strict: false }
  }

  const hasConstraintSignal = METADATA_QUERY_TRIGGER.test(normalizedMessage)
  const hasTargetedSignal = METADATA_TARGETED_TRIGGER.test(normalizedMessage)
  const strict = METADATA_STRICT_TRIGGER.test(normalizedMessage)

  if (hasTargetedSignal || strict) {
    const quotedPattern = /"([^"]{2,180})"|'([^']{2,180})'/g
    let quotedMatch: RegExpExecArray | null
    while ((quotedMatch = quotedPattern.exec(normalizedMessage)) !== null) {
      addConstraintTerms(includeTerms, quotedMatch[1] || quotedMatch[2])
    }
  }

  if (hasConstraintSignal) {
    const includePatterns: RegExp[] = [
      /\bonly\s+from\s+([^,.!?;\n]{2,180})/gi,
      /\b(?:source|sources|app|entity|document|documents|doc|docs|file|files)\s*(?:is|are|=|:)?\s*([^,.!?;\n]{2,180})/gi,
    ]
    if (hasTargetedSignal || includeTerms.size > 0) {
      includePatterns.push(/\bfrom\s+([^,.!?;\n]{2,180})/gi)
    }
    const excludePatterns = [
      /\bnot\s+from\s+([^,.!?;\n]{2,180})/gi,
      /\b(?:exclude|excluding|except|without)\s+([^,.!?;\n]{2,180})/gi,
    ]

    for (const pattern of includePatterns) {
      let match: RegExpExecArray | null
      while ((match = pattern.exec(normalizedMessage)) !== null) {
        addConstraintTerms(includeTerms, match[1])
      }
    }
    for (const pattern of excludePatterns) {
      let match: RegExpExecArray | null
      while ((match = pattern.exec(normalizedMessage)) !== null) {
        addConstraintTerms(excludeTerms, match[1])
      }
    }
  }

  for (const excluded of excludeTerms) {
    includeTerms.delete(excluded)
  }

  return {
    includeTerms: Array.from(includeTerms),
    excludeTerms: Array.from(excludeTerms),
    strict,
  }
}

function computeTermMatchScore(metadataText: string, term: string): number {
  if (!term || !metadataText) return 0
  if (metadataText.includes(term)) {
    return term.includes(" ") ? 3 : 2
  }
  const tokens = term
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !NON_SIGNAL_TERMS.has(token))
  if (tokens.length === 0) return 0
  let tokenHits = 0
  for (const token of tokens) {
    if (metadataText.includes(token)) {
      tokenHits++
    }
  }
  if (tokenHits === tokens.length) return 2
  if (tokenHits >= Math.max(1, Math.ceil(tokens.length / 2))) return 1
  return 0
}

export function rankFragmentsByMetadataConstraints(
  fragments: MinimalAgentFragment[],
  constraints: MetadataQueryConstraints
): {
  rankedCandidates: RankedMetadataCandidate[]
  hasConstraints: boolean
  hasCompliantCandidates: boolean
} {
  const hasConstraints =
    constraints.includeTerms.length > 0 || constraints.excludeTerms.length > 0
  const scored: RankedMetadataCandidate[] = fragments.map((fragment) => {
    const metadataText = buildFragmentMetadataSearchText(fragment)
    const includeScore = constraints.includeTerms.reduce((total, term) => {
      return total + computeTermMatchScore(metadataText, term)
    }, 0)
    const excludeScore = constraints.excludeTerms.reduce((total, term) => {
      return total + computeTermMatchScore(metadataText, term)
    }, 0)
    const includeCompliant =
      constraints.includeTerms.length === 0 || includeScore > 0
    const excludeCompliant = excludeScore === 0
    const compliant = includeCompliant && excludeCompliant
    let score =
      includeScore * 3 -
      excludeScore * 4 +
      (fragment.confidence || 0)
    if (constraints.strict && !compliant) {
      score -= 100
    }
    return {
      fragment,
      includeScore,
      excludeScore,
      score,
      compliant,
    }
  })

  if (!hasConstraints) {
    return {
      rankedCandidates: scored,
      hasConstraints: false,
      hasCompliantCandidates: false,
    }
  }

  scored.sort((a, b) => {
    if (a.compliant !== b.compliant) {
      return a.compliant ? -1 : 1
    }
    if (a.score !== b.score) {
      return b.score - a.score
    }
    return (b.fragment.confidence || 0) - (a.fragment.confidence || 0)
  })

  const compliantCandidates = scored.filter((candidate) => candidate.compliant)
  if (constraints.strict && compliantCandidates.length > 0) {
    return {
      rankedCandidates: compliantCandidates,
      hasConstraints: true,
      hasCompliantCandidates: true,
    }
  }

  return {
    rankedCandidates: scored,
    hasConstraints: true,
    hasCompliantCandidates: compliantCandidates.length > 0,
  }
}

export function enforceMetadataConstraintsOnSelection(
  selected: MinimalAgentFragment[],
  rankedCandidates: RankedMetadataCandidate[],
  constraints: MetadataQueryConstraints
): MinimalAgentFragment[] {
  const hasConstraints =
    constraints.includeTerms.length > 0 || constraints.excludeTerms.length > 0
  if (!hasConstraints || selected.length === 0) {
    return selected
  }

  const candidateById = new Map(
    rankedCandidates.map((candidate) => [candidate.fragment.id, candidate])
  )
  const compliantSelected = selected.filter((fragment) => {
    return candidateById.get(fragment.id)?.compliant
  })
  if (constraints.strict) {
    return compliantSelected
  }
  if (compliantSelected.length > 0) {
    return selected
  }
  const compliantFallback = rankedCandidates
    .filter((candidate) => candidate.compliant)
    .slice(0, Math.min(3, rankedCandidates.length))
    .map((candidate) => candidate.fragment)
  if (compliantFallback.length === 0) {
    return selected
  }
  const merged = [...compliantFallback, ...selected]
  const seen = new Set<string>()
  return merged.filter((fragment) => {
    if (seen.has(fragment.id)) return false
    seen.add(fragment.id)
    return true
  })
}

export const __messageAgentsMetadataInternals = {
  formatFragmentWithMetadata,
  formatFragmentsWithMetadata,
  extractMetadataConstraintsFromUserMessage,
  rankFragmentsByMetadataConstraints,
}
