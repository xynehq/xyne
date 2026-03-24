/**
 * Shared utilities for pi-mono tools
 *
 * Common helper functions used across multiple tools
 */

// ============================================================================
// TARGET BUILDER
// ============================================================================

/**
 * Build a KnowledgeBaseTarget from TypeBox params
 * Converts the flat params structure to the discriminated union expected by functions
 */
export function buildTargetFromParams(params: {
  type: "collection" | "folder" | "file" | "path"
  collectionId?: string
  folderId?: string
  fileId?: string
  path?: string
}):
  | { type: "collection"; collectionId: string }
  | { type: "folder"; folderId: string }
  | { type: "file"; fileId: string }
  | { type: "path"; collectionId: string; path: string }
  | undefined {
  if (!params) return undefined

  switch (params.type) {
    case "collection":
      if (!params.collectionId) return undefined
      return { type: "collection" as const, collectionId: params.collectionId }
    case "folder":
      if (!params.folderId) return undefined
      return { type: "folder" as const, folderId: params.folderId }
    case "file":
      if (!params.fileId) return undefined
      return { type: "file" as const, fileId: params.fileId }
    case "path":
      if (!params.collectionId || !params.path) return undefined
      return {
        type: "path" as const,
        collectionId: params.collectionId,
        path: params.path,
      }
    default:
      return undefined
  }
}

/**
 * Build multiple targets from params array
 */
export function buildTargetsFromParams(
  targets:
    | Array<{
        type: "collection" | "folder" | "file" | "path"
        collectionId?: string
        folderId?: string
        fileId?: string
        path?: string
      }>
    | undefined,
):
  | Array<
      | { type: "collection"; collectionId: string }
      | { type: "folder"; folderId: string }
      | { type: "file"; fileId: string }
      | { type: "path"; collectionId: string; path: string }
    >
  | undefined {
  if (!targets || targets.length === 0) return undefined

  const built = targets
    .map(buildTargetFromParams)
    .filter((t): t is NonNullable<typeof t> => t !== undefined)

  return built.length > 0 ? built : undefined
}

// ============================================================================
// EXCLUDED IDS NORMALIZATION
// ============================================================================

/**
 * Normalize excludedIds to string array
 * Handles various input formats and filters out invalid values
 */
export function normalizeExcludedIds(excludedIds: unknown): string[] {
  if (Array.isArray(excludedIds)) {
    return excludedIds
      .map((value) =>
        typeof value === "string"
          ? value
          : value === null || value === undefined
            ? ""
            : String(value),
      )
      .filter(Boolean)
  }
  if (excludedIds === null || excludedIds === undefined) {
    return []
  }
  const normalized =
    typeof excludedIds === "string" ? excludedIds : String(excludedIds)
  return normalized ? [normalized] : []
}

// ============================================================================
// TIME RANGE PARSING
// ============================================================================

export interface TimeRangeInput {
  startTime?: string
  endTime?: string
}

export interface TimeRangeOutput {
  startTime: number
  endTime: number
}

/**
 * Parse time range from string inputs to timestamps
 * Returns undefined if no valid time range provided
 */
export function parseTimeRange(
  timeRange?: TimeRangeInput,
): TimeRangeOutput | undefined {
  if (!timeRange) return undefined

  const hasStart = timeRange.startTime && timeRange.startTime.trim().length > 0
  const hasEnd = timeRange.endTime && timeRange.endTime.trim().length > 0

  if (!hasStart && !hasEnd) return undefined

  return {
    startTime: hasStart ? new Date(timeRange.startTime!).getTime() : 0,
    endTime: hasEnd ? new Date(timeRange.endTime!).getTime() : Date.now(),
  }
}

/**
 * Normalize timestamp range for Vespa search
 * Returns null if no valid range
 */
export function normalizeTimestampRange(
  range?: TimeRangeInput,
): { from: number | null; to: number | null } | null {
  if (!range) return null

  let hasValue = false
  const normalized: { from: number | null; to: number | null } = {
    from: null,
    to: null,
  }

  if (range.startTime) {
    const from = Date.parse(range.startTime)
    if (!Number.isNaN(from)) {
      normalized.from = from
      hasValue = true
    }
  }

  if (range.endTime) {
    const to = Date.parse(range.endTime)
    if (!Number.isNaN(to)) {
      normalized.to = to
      hasValue = true
    }
  }

  return hasValue ? normalized : null
}

// ============================================================================
// SORT BY NORMALIZATION
// ============================================================================

/**
 * Normalize sortBy parameter with default
 */
export function normalizeSortBy(
  sortBy: "asc" | "desc" | undefined,
  defaultValue: "asc" | "desc" = "desc",
): "asc" | "desc" {
  return sortBy || defaultValue
}

// ============================================================================
// LIMIT/OFFSET CALCULATION
// ============================================================================

/**
 * Calculate effective limit with max constraint
 */
export function calculateLimit(
  limit: number | undefined,
  maxLimit: number,
  offset: number = 0,
): number | undefined {
  if (!limit) return undefined
  return Math.min(limit, maxLimit) + offset
}

/**
 * Normalize offset to non-negative integer
 */
export function normalizeOffset(offset: number | undefined): number {
  return Math.max(offset || 0, 0)
}

// ============================================================================
// ERROR RESPONSE BUILDERS
// ============================================================================

/**
 * Build a standard pi-mono error response
 */
export function buildErrorResponse(
  message: string,
  toolName: string,
  code?: string,
  error?: string,
): {
  content: Array<{ type: "text"; text: string }>
  isError: true
  details: { toolName: string; code?: string; error?: string }
} {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: {
      toolName,
      ...(code && { code }),
      ...(error && { error }),
    },
  }
}

/**
 * Build a standard pi-mono success response
 */
export function buildSuccessResponse(
  message: string,
  toolName: string,
  data: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>
  details: { toolName: string } & Record<string, unknown>
} {
  return {
    content: [{ type: "text", text: message }],
    details: {
      toolName,
      ...data,
    },
  }
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Validate that at least one of the provided fields has a value
 */
export function hasAtLeastOneField(
  obj: Record<string, unknown>,
  fields: string[],
): boolean {
  return fields.some((field) => {
    const value = obj[field]
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === "string") return value.trim().length > 0
    return value !== undefined && value !== null
  })
}

/**
 * Check if an array is non-empty
 */
export function isNonEmptyArray<T>(arr: T[] | undefined): arr is T[] {
  return Array.isArray(arr) && arr.length > 0
}

/**
 * Safely parse JSON with fallback
 */
export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}
