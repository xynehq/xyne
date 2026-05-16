/**
 * Standardized tool result types and helpers (in-tree replacement for
 * the former @juspay-xyne-jaf/jaf ToolResult / ToolResponse / ToolErrorCodes).
 *
 * Shape is preserved verbatim so existing consumers (pi-mono tool wrappers
 * that read `result.status`, `result.data`, `result.error.message`, etc.)
 * continue to work unchanged.
 */

export type ToolResultStatus =
  | "success"
  | "error"
  | "validation_error"
  | "permission_denied"
  | "not_found"

export interface ToolResult<T = any> {
  readonly status: ToolResultStatus
  readonly data?: T
  readonly error?: {
    readonly code: string
    readonly message: string
    readonly details?: any
  }
  readonly metadata?: {
    readonly executionTimeMs?: number
    readonly toolName?: string
    readonly [key: string]: any
  }
}

export const ToolErrorCodes = {
  INVALID_INPUT: "INVALID_INPUT",
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
  INVALID_FORMAT: "INVALID_FORMAT",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  INSUFFICIENT_PERMISSIONS: "INSUFFICIENT_PERMISSIONS",
  NOT_FOUND: "NOT_FOUND",
  RESOURCE_UNAVAILABLE: "RESOURCE_UNAVAILABLE",
  EXECUTION_FAILED: "EXECUTION_FAILED",
  TIMEOUT: "TIMEOUT",
  EXTERNAL_SERVICE_ERROR: "EXTERNAL_SERVICE_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const

export type ToolErrorCode = (typeof ToolErrorCodes)[keyof typeof ToolErrorCodes]

export class ToolResponse {
  static success<T>(data: T, metadata?: ToolResult["metadata"]): ToolResult<T> {
    return { status: "success", data, metadata }
  }

  static error(
    code: ToolErrorCode,
    message: string,
    details?: any,
    metadata?: ToolResult["metadata"],
  ): ToolResult {
    return {
      status: "error",
      error: { code, message, details },
      metadata,
    }
  }

  static validationError(
    message: string,
    details?: any,
    metadata?: ToolResult["metadata"],
  ): ToolResult {
    return {
      status: "validation_error",
      error: { code: ToolErrorCodes.INVALID_INPUT, message, details },
      metadata,
    }
  }

  static permissionDenied(
    message: string,
    requiredPermissions?: string[],
    metadata?: ToolResult["metadata"],
  ): ToolResult {
    return {
      status: "permission_denied",
      error: {
        code: ToolErrorCodes.PERMISSION_DENIED,
        message,
        details: { requiredPermissions },
      },
      metadata,
    }
  }

  static notFound(
    resource: string,
    identifier?: string,
    metadata?: ToolResult["metadata"],
  ): ToolResult {
    return {
      status: "not_found",
      error: {
        code: ToolErrorCodes.NOT_FOUND,
        message: `${resource}${identifier ? ` "${identifier}"` : ""} not found`,
      },
      metadata,
    }
  }
}
