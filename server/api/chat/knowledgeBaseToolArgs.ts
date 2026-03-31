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

  let normalizedArgs = args as RawSearchArgs
  const normalizedFilters = tryParseStructuredJsonString(normalizedArgs.filters)
  if (normalizedFilters !== normalizedArgs.filters) {
    normalizedArgs = {
      ...normalizedArgs,
      filters: normalizedFilters,
    }
  }

  if (!isPlainObject(normalizedArgs.filters)) {
    return normalizedArgs
  }

  let filters = normalizedArgs.filters as RawSearchFilters
  const normalizedTargets = tryParseStructuredJsonString(filters.targets)
  if (normalizedTargets !== filters.targets) {
    filters = {
      ...filters,
      targets: normalizedTargets,
    }
  }

  if (!Array.isArray(filters.targets)) {
    return filters === normalizedArgs.filters
      ? normalizedArgs
      : {
          ...normalizedArgs,
          filters,
        }
  }

  const originalTargets = filters.targets
  const parsedTargets = originalTargets.map((target) =>
    tryParseStructuredJsonString(target),
  )
  const targetsChanged = parsedTargets.some(
    (target, index) => target !== originalTargets[index],
  )

  if (!targetsChanged && filters === normalizedArgs.filters) {
    return normalizedArgs
  }

  return {
    ...normalizedArgs,
    filters: {
      ...filters,
      targets: targetsChanged ? parsedTargets : originalTargets,
    },
  }
}
