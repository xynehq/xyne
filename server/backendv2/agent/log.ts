// Shared logger type for backendv2 — every layer accepts/passes a pino logger
// bound with progressively more context (conversation → turn → run → tool call).
//
// Why centralise: keeps the type narrow so the runner / tools don't need to
// import pino itself, and gives us one place to add structured fields like
// requestId or traceId later.

import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

export type Log = ReturnType<typeof getLogger>

export const baseLogger = (mod: string): Log =>
  getLogger(Subsystem.Api).child({ module: mod })
