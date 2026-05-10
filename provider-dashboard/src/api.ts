const BASE_URL = "/api/provider/dashboard"

function getToken(): string | null {
  return localStorage.getItem("provider_token")
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  })

  if (res.status === 401) {
    localStorage.removeItem("provider_token")
    window.location.href = "/login"
    throw new Error("Unauthorized")
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || `Request failed: ${res.status}`)
  }

  return res.json()
}

// Auth
export async function signup(data: {
  email: string
  password: string
  name: string
  workspace_name: string
}) {
  return request<{ token: string; workspace_id: string; user: { email: string; name: string } }>(
    "/auth/signup",
    { method: "POST", body: JSON.stringify(data) },
  )
}

export async function login(data: { email: string; password: string }) {
  return request<{ token: string; workspace_id: string; user: { email: string; name: string } }>(
    "/auth/login",
    { method: "POST", body: JSON.stringify(data) },
  )
}

// Me
export async function getMe() {
  return request<{
    user: { email: string; name: string; role: string }
    workspace_id: string
    config: { token_expiry_seconds: number; allowed_origins: string[]; enabled: boolean } | null
  }>("/me")
}

// Documents
export async function listDocuments() {
  return request<{
    documents: Array<{
      docId: string
      title: string
      accessTags: string[]
      createdAt: number
      collectionId: string
    }>
  }>("/documents")
}

export async function uploadDocuments(data: {
  collection_id: string
  documents: Array<{
    title: string
    content: string
    access_tags: string[]
    source_url?: string
  }>
}) {
  return request<{ collection_id: string; documents: Array<{ docId: string; title: string; status: string }>; total: number }>(
    "/documents",
    { method: "POST", body: JSON.stringify(data) },
  )
}

export async function deleteDocument(docId: string) {
  return request<{ success: boolean }>(`/documents/${docId}`, { method: "DELETE" })
}

// API Keys
export async function listApiKeys() {
  return request<{ api_keys: Array<{ id: string; name: string; key_prefix: string; created_at: string }> }>(
    "/api-keys",
  )
}

export async function createApiKey() {
  return request<{ api_key: string; id: string; name: string; created_at: string }>(
    "/api-keys",
    { method: "POST" },
  )
}

export async function deleteApiKey(id: string) {
  return request<{ success: boolean }>(`/api-keys/${id}`, { method: "DELETE" })
}

// Config
export async function getConfig() {
  return request<{ token_expiry_seconds: number; allowed_origins: string[]; enabled: boolean }>(
    "/config",
  )
}

export async function updateConfig(data: {
  allowed_origins?: string[]
  token_expiry_seconds?: number
}) {
  return request<{ token_expiry_seconds: number; allowed_origins: string[]; enabled: boolean }>(
    "/config",
    { method: "PUT", body: JSON.stringify(data) },
  )
}
