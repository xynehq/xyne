export type Ctx = {
  email: string
  userCtx: string
  userMessage: string
  agentPrompt?: string
}

export type WithExcludedIds<T> = T & { excludedIds?: string[] }
