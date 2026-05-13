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

// Collections
export async function listCollections() {
  return request<{
    collections: Array<{
      id: string
      name: string
      description: string | null
      totalItems: number
      uploadStatus: string
      createdAt: string
      updatedAt: string
    }>
  }>("/collections")
}

export async function createCollection(data: { name: string; description?: string }) {
  return request<{
    id: string
    name: string
    description: string | null
    uploadStatus: string
    createdAt: string
  }>("/collections", { method: "POST", body: JSON.stringify(data) })
}

export async function deleteCollection(id: string) {
  return request<{ success: boolean; deletedCount: number }>(`/collections/${id}`, { method: "DELETE" })
}

export async function listCollectionItems(collectionId: string) {
  return request<{
    items: Array<{
      id: string
      name: string
      type: string
      mimeType: string | null
      fileSize: number | null
      uploadStatus: string
      statusMessage: string | null
      createdAt: string
      updatedAt: string
    }>
  }>(`/collections/${collectionId}/items`)
}

// Documents
export async function listDocuments() {
  return request<{
    documents: Array<{
      docId: string
      title: string
      visibility: "public" | "authenticated"
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
    visibility: "public" | "authenticated"
    access_tags: string[]
    source_url?: string
  }>
}) {
  return request<{ collection_id: string; documents: Array<{ docId: string; title: string; status: string }>; total: number }>(
    "/documents",
    { method: "POST", body: JSON.stringify(data) },
  )
}

export async function uploadFiles(data: {
  files: File[]
  collection_id: string
  visibility: "public" | "authenticated"
  access_tags: string[]
}) {
  const token = getToken()
  const formData = new FormData()
  formData.append("collection_id", data.collection_id)
  formData.append("visibility", data.visibility)
  formData.append("access_tags", JSON.stringify(data.access_tags))
  for (const file of data.files) {
    formData.append("files", file)
  }

  const res = await fetch(`${BASE_URL}/documents/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  })

  if (res.status === 401) {
    localStorage.removeItem("provider_token")
    window.location.href = "/login"
    throw new Error("Unauthorized")
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || `Upload failed: ${res.status}`)
  }

  return res.json() as Promise<{
    collection_id: string
    documents: Array<{ docId: string; title: string; status: string }>
    total: number
  }>
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
