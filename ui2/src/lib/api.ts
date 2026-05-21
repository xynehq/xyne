// Thin fetch wrapper for backendv2 (/v2/*).
// - sends cookies (`credentials: "include"`) so the shared `access-token` /
//   `refresh-token` cookies issued by xyne are forwarded through the Vite proxy.
// - on 401, tries POST /v2/refresh-token once, then retries the original
//   request. If the refresh fails the caller gets the original 401.

export class ApiError extends Error {
  public override readonly name = "ApiError"
  public readonly status: number
  public constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const tryRefresh = async (): Promise<boolean> => {
  const res = await fetch("/v2/refresh-token", {
    method: "POST",
    credentials: "include",
  })
  return res.ok
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const isMultipart =
    typeof FormData !== "undefined" && init.body instanceof FormData
  const send = (): Promise<Response> =>
    fetch(path, {
      ...init,
      credentials: "include",
      headers: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        ...(isMultipart ? {} : { "Content-Type": "application/json" }),
        ...(init.headers ?? {}),
      },
    })

  let res = await send()
  if (res.status === 401) {
    const refreshed = await tryRefresh()
    if (refreshed) {
      res = await send()
    }
  }

  if (!res.ok) {
    let message = `HTTP ${String(res.status)}`
    try {
      const body = (await res.json()) as { error?: string; message?: string }
      message = body.error ?? body.message ?? message
    } catch {
      // ignore
    }
    throw new ApiError(res.status, message)
  }

  // Allow void responses (204 / empty body on DELETE) without forcing the
  // caller to swallow a JSON parse error.
  if (res.status === 204) {
    return undefined as T
  }
  const text = await res.text()
  if (!text) {
    return undefined as T
  }
  return JSON.parse(text) as T
}

export type Me = {
  email: string
  role: string
  workspaceId: string
  tokenType: "access" | "refresh"
}

// ── Message feedback ────────────────────────────────────────────────────────
// Single PUT endpoint upserts on (user, message). Returning the saved row so
// the client can rehydrate filled-icon state without re-fetching.

export type FeedbackRating = "like" | "dislike"

export type MessageFeedbackRecord = {
  id: string
  messageId: string
  conversationId: string
  rating: FeedbackRating
  tags: string[]
  comment?: string
  shareChat: boolean
  createdAt: number
  updatedAt: number
}

export const submitMessageFeedback = (
  conversationId: string,
  messageId: string,
  input: {
    rating: FeedbackRating
    tags?: string[]
    comment?: string
    shareChat?: boolean
  },
): Promise<MessageFeedbackRecord> =>
  apiFetch<MessageFeedbackRecord>(
    `/v2/chat/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/feedback`,
    { method: "PUT", body: JSON.stringify(input) },
  )

export const deleteMessageFeedback = (
  conversationId: string,
  messageId: string,
): Promise<{ deleted: boolean }> =>
  apiFetch<{ deleted: boolean }>(
    `/v2/chat/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/feedback`,
    { method: "DELETE" },
  )

export const getMe = (): Promise<Me> => apiFetch<Me>("/v2/me")

export type ModelInfo = {
  labelName: string
  reasoning: boolean
  websearch: boolean
  deepResearch: boolean
  description: string
}

export const getModels = (): Promise<{ models: ModelInfo[] }> =>
  apiFetch<{ models: ModelInfo[] }>("/v2/models")

/** Minimal projection of the server-side `agents` row the agent picker
 *  needs. Heavy fields (appIntegrations, docIds) stay server-side; the scope
 *  is materialized at sendMessage time. */
export type AgentInfo = {
  externalId: string
  name: string
  description: string
  model: string
  isPublic: boolean
  isRagOn: boolean
  allowWebSearch: boolean
}

export const getAgents = (): Promise<{ agents: AgentInfo[] }> =>
  apiFetch<{ agents: AgentInfo[] }>("/v2/agents")

// ── Agents CRUD ─────────────────────────────────────────────────────────────
// All handlers live on backendv2 under /v2/agents/*. Same business logic as
// v1: workspace-scoped, JWT-gated, per-agent permission checks (owner |
// editor | viewer | public). Wire shapes are preserved so the form payloads
// don't change.

/** Server-side agent row as returned by /v2/agents GET/PUT/POST handlers. The
 *  composer's AgentInfo above is a strict subset of this. */
export type Agent = {
  externalId: string
  name: string
  description: string
  prompt: string
  model: string
  isPublic: boolean
  isRagOn: boolean
  allowWebSearch: boolean
  // v1's GET single-agent response strips these from the public projection,
  // so they come back as `undefined` even when the row has them populated.
  // PUT requests still accept them. Treat optional everywhere on the client.
  userEmails?: string[]
  ownerEmails?: string[]
  uploadedFileNames?: string[]
  // v1 returns this as `any` — appIntegrations is a record keyed by app id
  // with selected items / filters. The CRUD page only round-trips it.
  appIntegrations?: unknown
  docIds?: unknown[]
  // M4a fields — three independently-editable system prompt sections plus
  // the registry tool allowlist. NULL on a section means "use the workspace
  // default" (the assembler does the fallback on the server). Empty `tools`
  // array means "all tools available".
  systemPromptMain?: string | null
  systemPromptTools?: string | null
  systemPromptSubagents?: string | null
  tools?: string[]
  // M4b — true for the per-workspace default agent. The admin form hides
  // identity / sharing on this row because they don't apply (the default
  // is workspace-wide and the row's name/visibility are fixed).
  isDefault?: boolean
}

export type AgentListFilter = "all" | "madeByMe" | "sharedToMe"

export type ListAgentsParams = {
  limit?: number
  offset?: number
  filter?: AgentListFilter
}

export type AgentCreateInput = {
  name: string
  /** Server requires this for create — callers inject "Auto" because the UI
   *  intentionally doesn't ask the user (matches v1 behavior). Optional in
   *  the type so the form's working state doesn't have to carry it. */
  model?: string
  description?: string
  prompt?: string
  isPublic?: boolean
  isRagOn?: boolean
  allowWebSearch?: boolean
  userEmails?: string[]
  ownerEmails?: string[]
  uploadedFileNames?: string[]
  docIds?: unknown[]
  appIntegrations?: unknown
  // M4a — section overrides + tool allowlist. Omit a field to leave the
  // server column unchanged; send `null` (or `""`) on a section field to
  // explicitly clear back to the workspace default.
  systemPromptMain?: string | null
  systemPromptTools?: string | null
  systemPromptSubagents?: string | null
  tools?: string[]
}

export type AgentUpdateInput = Partial<AgentCreateInput>

export const listAgents = async (
  params: ListAgentsParams = {},
): Promise<{ agents: Agent[] }> => {
  const qs = new URLSearchParams()
  if (params.limit !== undefined) qs.set("limit", String(params.limit))
  if (params.offset !== undefined) qs.set("offset", String(params.offset))
  if (params.filter !== undefined) qs.set("filter", params.filter)
  const q = qs.toString()
  const res = await apiFetch<{ agents: Agent[] }>(
    `/v2/agents${q ? `?${q}` : ""}`,
  )
  return { agents: res.agents ?? [] }
}

/** Permissions companion to `getAgent`. The single-agent GET omits user/owner
 *  email lists from its public projection; this fills them in. */
export const getAgentPermissions = (
  externalId: string,
): Promise<{ userEmails: string[]; ownerEmails: string[] }> =>
  apiFetch<{ userEmails: string[]; ownerEmails: string[] }>(
    `/v2/agents/${encodeURIComponent(externalId)}/permissions`,
  )

/** Fetch the agent row AND its permissions list in parallel, then merge so
 *  the caller doesn't have to remember they're split across two endpoints.
 *  Permissions failures degrade silently (empty lists) rather than killing
 *  the whole agent load — the user might have public-viewer access without
 *  being able to read the full member list. */
export const getAgent = async (externalId: string): Promise<Agent> => {
  const [agent, perms] = await Promise.all([
    apiFetch<Agent>(`/v2/agents/${encodeURIComponent(externalId)}`),
    getAgentPermissions(externalId).catch(() => ({
      userEmails: [] as string[],
      ownerEmails: [] as string[],
    })),
  ])
  return {
    ...agent,
    userEmails: perms.userEmails,
    ownerEmails: perms.ownerEmails,
  }
}

export const createAgent = (input: AgentCreateInput): Promise<Agent> =>
  apiFetch<Agent>("/v2/agents", {
    method: "POST",
    body: JSON.stringify(input),
  })

export const updateAgent = (
  externalId: string,
  input: AgentUpdateInput,
): Promise<Agent> =>
  apiFetch<Agent>(`/v2/agents/${encodeURIComponent(externalId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  })

export const deleteAgent = (externalId: string): Promise<void> =>
  apiFetch<void>(`/v2/agents/${encodeURIComponent(externalId)}`, {
    method: "DELETE",
  })

// ── Workspace-wide default agent (M4b) ──────────────────────────────────────
// The default agent is created lazily on first GET. Every workspace member
// sees the same row; only its system-prompt sections, tools allowlist, and
// sub-agents are user-editable from the admin UI (name + sharing are
// fixed on the row and ignored by the PUT route).
export const getDefaultAgent = (): Promise<Agent> =>
  apiFetch<Agent>("/v2/agents/default")

export const updateDefaultAgent = (input: AgentUpdateInput): Promise<Agent> =>
  apiFetch<Agent>("/v2/agents/default", {
    method: "PUT",
    body: JSON.stringify(input),
  })

// ── Effective prompt (view page) ────────────────────────────────────────────
// What the LLM actually sees when a turn starts under a given agent —
// the result of running resolveAgentSystemPrompt on the agent's row +
// its live sub-agents. The `sources` map tells the view which section
// came from the override, the legacy `prompt`, or the workspace default.

// Per-section labels for the assembled prompt. Each section is either
// an explicit per-agent override or the workspace default; the
// sub-agents section reads "suppressed" when the agent has zero
// sub-agents because the block isn't emitted at all in that case.
export type AgentEffectivePromptSources = {
  main: "override" | "default"
  tools: "override" | "default"
  subagents: "override" | "default" | "suppressed"
}

export type AgentEffectivePrompt = {
  prompt: string
  sources: AgentEffectivePromptSources
}

export const getEffectivePrompt = (
  externalId: string,
): Promise<AgentEffectivePrompt> =>
  apiFetch<AgentEffectivePrompt>(
    `/v2/agents/${encodeURIComponent(externalId)}/effective-prompt`,
  )

export const getDefaultEffectivePrompt = (): Promise<AgentEffectivePrompt> =>
  apiFetch<AgentEffectivePrompt>("/v2/agents/default/effective-prompt")

/** Server-side defaults for the agent form. `prompt` is the assembled
 *  default (back-compat with the older single-textarea UI); `sections` is
 *  the three independently-editable defaults the new form binds to a
 *  "Use default" button per section. */
export type AgentDefaults = {
  prompt: string
  sections: {
    main: string
    tools: string
    subagents: string
  }
}
export const getAgentDefaults = (): Promise<AgentDefaults> =>
  apiFetch<AgentDefaults>("/v2/agents/defaults")

/** Catalog of pi-mono tools the agent's tool picker offers. Pure data,
 *  cacheable for the page lifetime — fetched once on AgentForm mount. */
export type AgentToolDescriptor = {
  name: string
  label: string
  description: string
  category: string
}
export const getAgentToolsCatalog = (): Promise<{
  tools: AgentToolDescriptor[]
}> => apiFetch<{ tools: AgentToolDescriptor[] }>("/v2/agents/tools")

// ── Sub-agents CRUD ─────────────────────────────────────────────────────────
// All scoped under a parent agent's external_id. The route layer enforces
// that the caller has access to the parent before letting them list/edit.

// Pi-ai's ThinkingLevel minus "xhigh" — same closed set the server
// stores on sub_agents.thinking_level. Exported so the form's select
// can pull options from one source of truth.
export const SUB_AGENT_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
] as const
export type SubAgentThinkingLevel = (typeof SUB_AGENT_THINKING_LEVELS)[number]

export type SubAgent = {
  externalId: string
  name: string
  description: string
  systemPrompt: string
  tools: string[]
  // Reasoning effort for the nested pi-mono session this sub-agent
  // runs in. Set at create time on the form; not inherited from the
  // parent agent or the chat request.
  thinkingLevel: SubAgentThinkingLevel
  createdAt: string
  updatedAt: string
}

export type SubAgentCreateInput = {
  name: string
  description: string
  systemPrompt: string
  tools?: string[]
  thinkingLevel?: SubAgentThinkingLevel
}

export type SubAgentUpdateInput = Partial<SubAgentCreateInput>

const subAgentsBase = (parentExternalId: string): string =>
  `/v2/agents/${encodeURIComponent(parentExternalId)}/sub-agents`

export const listSubAgents = async (
  parentExternalId: string,
): Promise<SubAgent[]> => {
  const res = await apiFetch<{ subAgents: SubAgent[] }>(
    subAgentsBase(parentExternalId),
  )
  return res.subAgents ?? []
}

export const createSubAgent = (
  parentExternalId: string,
  input: SubAgentCreateInput,
): Promise<SubAgent> =>
  apiFetch<SubAgent>(subAgentsBase(parentExternalId), {
    method: "POST",
    body: JSON.stringify(input),
  })

export const updateSubAgent = (
  parentExternalId: string,
  subExternalId: string,
  input: SubAgentUpdateInput,
): Promise<SubAgent> =>
  apiFetch<SubAgent>(
    `${subAgentsBase(parentExternalId)}/${encodeURIComponent(subExternalId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  )

export const deleteSubAgent = (
  parentExternalId: string,
  subExternalId: string,
): Promise<void> =>
  apiFetch<void>(
    `${subAgentsBase(parentExternalId)}/${encodeURIComponent(subExternalId)}`,
    { method: "DELETE" },
  )

// ── Workspace user lookup ───────────────────────────────────────────────────
// Used by the agent form's viewer / co-owner pickers so users get autocomplete
// instead of having to type 200 emails by hand. Falls back gracefully if the
// endpoint isn't available — the bulk-paste path still works.

export type WorkspaceUser = {
  email: string
  name?: string
  photoLink?: string | null
}

export const searchWorkspaceUsers = async (
  query: string,
  limit = 10,
): Promise<WorkspaceUser[]> => {
  const qs = new URLSearchParams({ q: query, limit: String(limit) })
  try {
    const res = await apiFetch<{ users: WorkspaceUser[] }>(
      `/v2/users/search?${qs.toString()}`,
    )
    return res.users ?? []
  } catch {
    return []
  }
}

// ── Knowledge base browse + search ──────────────────────────────────────────
// Backing data for the agent's "Knowledge sources" picker. We treat
// collections as the top-level folders, descend into them via parentId, and
// search across all collections via /cl/search.

export type KbItem = {
  id: string
  collectionId: string
  parentId: string | null
  name: string
  type: "folder" | "file"
  path?: string
  vespaDocId?: string | null
}

export type KbCollection = {
  id: string
  name: string
  description?: string
  isPrivate?: boolean
}

export type KbSearchResult = {
  id: string
  name: string
  type: "collection" | "folder" | "file"
  collectionId: string
  collectionName?: string
  path?: string
  vespaDocId?: string | null
}

export const listKbCollections = async (): Promise<KbCollection[]> => {
  const res = await apiFetch<{ collections: KbCollection[] }>(
    "/v2/kb/collections",
  )
  return res.collections ?? []
}

export const listKbItems = async (
  collectionId: string,
  parentId: string | null = null,
): Promise<KbItem[]> => {
  const qs = new URLSearchParams()
  if (parentId) qs.set("parentId", parentId)
  const q = qs.toString()
  const res = await apiFetch<{ items: KbItem[] }>(
    `/v2/kb/collections/${encodeURIComponent(collectionId)}/items${q ? `?${q}` : ""}`,
  )
  return res.items ?? []
}

/** Cross-collection search isn't yet exposed on backendv2's KB router.
 *  Degrade gracefully — the picker still works by browsing collections.
 *  Callers already wrap this in try/catch and tolerate an empty result. */
export const searchKb = async (
  _query: string,
  _limit = 25,
): Promise<KbSearchResult[]> => {
  return []
}
