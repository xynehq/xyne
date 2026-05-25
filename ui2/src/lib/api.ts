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

/** Server-side defaults for the agent form. Today this only exposes the
 *  default system prompt; we keep the envelope generic so we can add other
 *  defaults (model, reasoning level, …) without a second round-trip. */
export const getAgentDefaults = (): Promise<{ prompt: string }> =>
  apiFetch<{ prompt: string }>("/v2/agents/defaults")

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

// ── Batch processing ───────────────────────────────────────────────────────
// CSV/XLSX of questions → per-row pi-mono runs → progressive result XLSX.
// All endpoints live under /v2/batches; routes mirror the chat module's
// owner-only permission model.

export type BatchStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

export type BatchRowStatus = "pending" | "running" | "done" | "error"

export type Batch = {
  id: string
  ownerId: string
  workspaceId: string
  name: string
  model: string | null
  agentId: string | null
  status: BatchStatus
  totalRows: number
  completedRows: number
  erroredRows: number
  questionColumn: string
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  archivedAt: number | null
  error: string | null
  columnOrder: string[]
}

export type BatchRow = {
  id: string
  batchId: string
  ordinal: number
  question: string
  originalColumns: Record<string, unknown>
  answer: string | null
  status: BatchRowStatus
  error: string | null
  tokensIn: number | null
  tokensOut: number | null
  durationMs: number | null
  startedAt: number | null
  finishedAt: number | null
}

export type CreateBatchResult = {
  batch: Batch
  preview: {
    columns: string[]
    questionColumn: string
    sampleRows: Array<Record<string, unknown>>
    totalRows: number
  }
}

export const createBatch = (form: FormData): Promise<CreateBatchResult> =>
  apiFetch<CreateBatchResult>("/v2/batches", { method: "POST", body: form })

export const listBatches = async (): Promise<{ batches: Batch[] }> => {
  const res = await apiFetch<{ batches: Batch[] }>("/v2/batches?limit=100")
  return { batches: res.batches ?? [] }
}

export const getBatch = (id: string): Promise<Batch> =>
  apiFetch<Batch>(`/v2/batches/${encodeURIComponent(id)}`)

export const listBatchRows = async (
  id: string,
  opts: { afterOrdinal?: number; limit?: number } = {},
): Promise<{ rows: BatchRow[] }> => {
  const qs = new URLSearchParams()
  if (opts.afterOrdinal !== undefined) qs.set("after", String(opts.afterOrdinal))
  qs.set("limit", String(opts.limit ?? 500))
  const res = await apiFetch<{ rows: BatchRow[] }>(
    `/v2/batches/${encodeURIComponent(id)}/rows?${qs.toString()}`,
  )
  return { rows: res.rows ?? [] }
}

export const cancelBatch = (id: string): Promise<{ ok: true }> =>
  apiFetch<{ ok: true }>(`/v2/batches/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: "{}",
  })

export const deleteBatch = (id: string): Promise<{ ok: true }> =>
  apiFetch<{ ok: true }>(`/v2/batches/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })

/** Returns the result XLSX as a Blob plus the X-Batch-Partial flag so the
 *  caller can suffix the saved filename ("_partial.xlsx") and avoid users
 *  mistaking an in-progress download for the final result. */
export const downloadBatchResult = async (
  id: string,
): Promise<{ blob: Blob; partial: boolean; filename: string }> => {
  const res = await fetch(
    `/v2/batches/${encodeURIComponent(id)}/download`,
    { credentials: "include" },
  )
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
  const partial = res.headers.get("X-Batch-Partial") === "true"
  const disposition = res.headers.get("Content-Disposition") ?? ""
  const filenameMatch = /filename="([^"]+)"/.exec(disposition)
  const filename = filenameMatch?.[1] ?? `${id}.xlsx`
  const blob = await res.blob()
  return { blob, partial, filename }
}
