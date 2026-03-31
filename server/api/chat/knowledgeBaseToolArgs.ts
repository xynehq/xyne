import { XyneTools } from "@/shared/types"

type RawLsArgs = Record<string, unknown> & {
  target?: unknown
}
type RawSearchFilters = Record<string, unknown> & {
  targets?: unknown
}
type RawSearchArgs = Record<string, unknown> & {
  filters?: unknown
}

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function tryParseStructuredJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value

  const trimmed = value.trim()
  if (!trimmed) return value

  const looksLikeObject =
    trimmed.startsWith("{") && trimmed.endsWith("}")
  const looksLikeArray =
    trimmed.startsWith("[") && trimmed.endsWith("]")

  if (!looksLikeObject && !looksLikeArray) {
    return value
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

export function normalizeKnowledgeBaseToolArgs(
  toolName: string,
  args: unknown,
): unknown {
  if (!isPlainObject(args)) return args

  if (toolName === "ls") {
    const normalizedArgs = { ...args } as RawLsArgs
    normalizedArgs.target = tryParseStructuredJsonString(
      normalizedArgs.target,
    )
    return normalizedArgs
  }

  if (toolName !== XyneTools.searchKnowledgeBase) {
    return args
  }

  const normalizedArgs = { ...args } as RawSearchArgs
  normalizedArgs.filters = tryParseStructuredJsonString(
    normalizedArgs.filters,
  )

  if (!isPlainObject(normalizedArgs.filters)) {
    return normalizedArgs
  }

  const filters = { ...normalizedArgs.filters } as RawSearchFilters
  filters.targets = tryParseStructuredJsonString(filters.targets)

  if (Array.isArray(filters.targets)) {
    const targets = filters.targets
    filters.targets = targets.map((target) =>
      tryParseStructuredJsonString(target),
    )
  }

  normalizedArgs.filters = filters
  return normalizedArgs
}
