import type { AgentRunContext } from "../agent-schemas"

export type Ctx = AgentRunContext

export type WithExcludedIds<T> = T & { excludedIds?: string[] }
