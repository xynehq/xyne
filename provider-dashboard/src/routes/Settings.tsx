import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Key, Trash2, Plus, Copy, X, Check } from "lucide-react"
import * as api from "@/api"

export function Settings() {
  return (
    <div className="space-y-8">
      <h2 className="text-xl font-semibold">Settings</h2>
      <ApiKeysSection />
      <ConfigSection />
    </div>
  )
}

function ApiKeysSection() {
  const queryClient = useQueryClient()
  const [newKey, setNewKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ["api-keys"],
    queryFn: api.listApiKeys,
  })

  const createMutation = useMutation({
    mutationFn: api.createApiKey,
    onSuccess: (res) => {
      setNewKey(res.api_key)
      queryClient.invalidateQueries({ queryKey: ["api-keys"] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: api.deleteApiKey,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["api-keys"] }),
  })

  const copyKey = () => {
    if (newKey) {
      navigator.clipboard.writeText(newKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <section className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-medium">API Keys</h3>
          <p className="text-sm text-gray-500 mt-1">
            Use API keys to authenticate your backend with the provider API.
          </p>
        </div>
        <button
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Create Key
        </button>
      </div>

      {newKey && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-md">
          <p className="text-sm font-medium text-green-800 mb-2">
            New API key created. Copy it now - you won't see it again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-white border border-green-200 rounded text-sm font-mono break-all">
              {newKey}
            </code>
            <button
              onClick={copyKey}
              className="p-2 text-green-700 hover:text-green-900 transition-colors"
              title="Copy to clipboard"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </button>
            <button
              onClick={() => setNewKey(null)}
              className="p-2 text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-gray-500">Loading...</div>
      ) : !data?.api_keys.length ? (
        <p className="text-sm text-gray-500">No API keys yet.</p>
      ) : (
        <div className="space-y-2">
          {data.api_keys.map((key) => (
            <div
              key={key.id}
              className="flex items-center justify-between px-4 py-3 bg-gray-50 rounded-md"
            >
              <div className="flex items-center gap-3">
                <Key className="h-4 w-4 text-gray-400" />
                <div>
                  <span className="text-sm font-mono text-gray-700">
                    {key.key_prefix}{"*".repeat(28)}
                  </span>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Created {new Date(key.created_at).toLocaleDateString()}
                  </p>
                </div>
              </div>
              <button
                onClick={() => deleteMutation.mutate(key.id)}
                disabled={deleteMutation.isPending}
                className="p-1 text-gray-400 hover:text-red-600 transition-colors"
                title="Revoke key"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function ConfigSection() {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ["config"],
    queryFn: api.getConfig,
  })

  const [tokenExpiry, setTokenExpiry] = useState<number | null>(null)
  const [origins, setOrigins] = useState<string[] | null>(null)
  const [originInput, setOriginInput] = useState("")
  const [saved, setSaved] = useState(false)

  // Initialize local state from fetched data
  const currentExpiry = tokenExpiry ?? data?.token_expiry_seconds ?? 3600
  const currentOrigins = origins ?? data?.allowed_origins ?? []

  const mutation = useMutation({
    mutationFn: api.updateConfig,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const addOrigin = () => {
    const origin = originInput.trim()
    if (origin && !currentOrigins.includes(origin)) {
      const updated = [...currentOrigins, origin]
      setOrigins(updated)
      setOriginInput("")
    }
  }

  const removeOrigin = (origin: string) => {
    setOrigins(currentOrigins.filter((o) => o !== origin))
  }

  const handleSave = () => {
    mutation.mutate({
      token_expiry_seconds: currentExpiry,
      allowed_origins: currentOrigins,
    })
  }

  if (isLoading) {
    return <div className="text-sm text-gray-500">Loading configuration...</div>
  }

  return (
    <section className="bg-white rounded-lg border border-gray-200 p-6">
      <h3 className="font-medium mb-4">Configuration</h3>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Token Expiry (seconds)
          </label>
          <input
            type="number"
            min={300}
            max={86400}
            value={currentExpiry}
            onChange={(e) => setTokenExpiry(parseInt(e.target.value) || 3600)}
            className="w-48 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="text-xs text-gray-500 mt-1">
            How long provider tokens last (300-86400 seconds)
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Allowed Origins
          </label>
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              value={originInput}
              onChange={(e) => setOriginInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  addOrigin()
                }
              }}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="https://example.com"
            />
            <button
              type="button"
              onClick={addOrigin}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm hover:bg-gray-50 transition-colors"
            >
              Add
            </button>
          </div>
          {currentOrigins.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {currentOrigins.map((origin) => (
                <span
                  key={origin}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded-md"
                >
                  {origin}
                  <button onClick={() => removeOrigin(origin)} className="hover:text-red-600">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <p className="text-xs text-gray-500 mt-1">
            Origins allowed to make requests with provider tokens (CORS)
          </p>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={handleSave}
            disabled={mutation.isPending}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {mutation.isPending ? "Saving..." : "Save Changes"}
          </button>
          {saved && (
            <span className="text-sm text-green-600 flex items-center gap-1">
              <Check className="h-4 w-4" /> Saved
            </span>
          )}
        </div>
      </div>
    </section>
  )
}
