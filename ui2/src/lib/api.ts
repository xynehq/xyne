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

  return (await res.json()) as T
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
