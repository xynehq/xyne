import { XyneTools } from "@/shared/types"

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
    const normalizedTarget = tryParseStructuredJsonString(args.target)
    return normalizedTarget === args.target
      ? args
      : { ...args, target: normalizedTarget }
  }

  if (toolName !== XyneTools.searchKnowledgeBase) {
    return args
  }

  let normalizedArgs = args
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

  let filters = normalizedArgs.filters
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

  const parsedTargets = filters.targets.map((target) =>
    tryParseStructuredJsonString(target),
  )
  const targetsChanged = parsedTargets.some(
    (target, index) => target !== filters.targets[index],
  )

  if (!targetsChanged && filters === normalizedArgs.filters) {
    return normalizedArgs
  }

  return {
    ...normalizedArgs,
    filters: {
      ...filters,
      targets: targetsChanged ? parsedTargets : filters.targets,
    },
  }
}
