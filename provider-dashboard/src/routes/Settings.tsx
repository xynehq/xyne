import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Key, Trash2, Plus, Copy, X, Check } from "lucide-react"
import * as api from "@/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export function Settings() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Manage API keys and configuration
        </p>
      </div>
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
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">API Keys</CardTitle>
          <CardDescription className="mt-1">
            Use API keys to authenticate your backend with the provider API.
          </CardDescription>
        </div>
        <Button
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          size="sm"
        >
          <Plus className="h-4 w-4 mr-2" />
          Create Key
        </Button>
      </CardHeader>
      <CardContent>
        {newKey && (
          <div className="mb-4 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-md">
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400 mb-2">
              New API key created. Copy it now — you won't see it again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-background border rounded-md text-sm font-mono break-all">
                {newKey}
              </code>
              <Button variant="ghost" size="icon" onClick={copyKey} className="h-8 w-8 shrink-0">
                {copied ? (
                  <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Copy className="h-4 w-4 text-muted-foreground" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setNewKey(null)}
                className="h-8 w-8 shrink-0"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : !data?.api_keys.length ? (
          <div className="flex flex-col items-center justify-center py-8">
            <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center mb-3">
              <Key className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">No API keys yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Create your first key to get started
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {data.api_keys.map((key) => (
              <div
                key={key.id}
                className="flex items-center justify-between px-4 py-3 bg-muted/50 rounded-md"
              >
                <div className="flex items-center gap-3">
                  <Key className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <span className="text-sm font-mono">
                      {key.key_prefix}{"*".repeat(28)}
                    </span>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Created {new Date(key.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => deleteMutation.mutate(key.id)}
                  disabled={deleteMutation.isPending}
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
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
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-sm text-muted-foreground text-center">
            Loading configuration...
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Configuration</CardTitle>
        <CardDescription>
          Token settings and CORS configuration for your provider.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label>Token Expiry (seconds)</Label>
          <Input
            type="number"
            min={300}
            max={86400}
            value={currentExpiry}
            onChange={(e) => setTokenExpiry(parseInt(e.target.value) || 3600)}
            className="w-48"
          />
          <p className="text-xs text-muted-foreground">
            How long provider tokens last (300–86400 seconds)
          </p>
        </div>

        <div className="space-y-2">
          <Label>Allowed Origins</Label>
          <div className="flex gap-2">
            <Input
              value={originInput}
              onChange={(e) => setOriginInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  addOrigin()
                }
              }}
              placeholder="https://example.com"
              className="flex-1"
            />
            <Button type="button" variant="outline" size="sm" onClick={addOrigin} className="h-9">
              Add
            </Button>
          </div>
          {currentOrigins.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {currentOrigins.map((origin) => (
                <Badge key={origin} variant="secondary" className="gap-1 pr-1 font-normal">
                  {origin}
                  <button
                    type="button"
                    onClick={() => removeOrigin(origin)}
                    className="rounded-full p-0.5 hover:bg-foreground/10"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Origins allowed to make requests with provider tokens (CORS)
          </p>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button onClick={handleSave} disabled={mutation.isPending}>
            {mutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
          {saved && (
            <span className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
              <Check className="h-4 w-4" /> Saved
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
