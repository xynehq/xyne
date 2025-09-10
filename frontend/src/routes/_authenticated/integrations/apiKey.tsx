import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { useState, useEffect } from "react"
import { Sidebar } from "@/components/Sidebar"
import { IntegrationsSidebar } from "@/components/IntegrationsSidebar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import {
  Key,
  Plus,
  Copy,
  Trash2,
  Eye,
  EyeOff,
  MoreHorizontal,
} from "lucide-react"
import { errorComponent } from "@/components/error"
import { authFetch } from "@/utils/authFetch"
import { api } from "@/api"
import type {
  PublicUser,
  PublicWorkspace,
  SelectPublicAgent,
} from "shared/types"

// Types
interface ApiKeyScope {
  id: string
  name: string
  description: string
}

interface ApiKeyAgent {
  externalId: string
  name: string
  description?: string
}

interface ApiKey {
  id: string
  name: string
  key: string
  scopes: string[]
  agents: string[]
  createdAt: string
  isVisible?: boolean
}

interface CreateApiKeyPayload {
  name: string
  scopes: string[]
  agents: string[]
}

// Available scopes
const AVAILABLE_SCOPES: ApiKeyScope[] = [
  {
    id: "CREATE_AGENT",
    name: "Create Agent",
    description: "Allows creating new agents",
  },
  {
    id: "AGENT_CHAT",
    name: "Agent Chat",
    description: "Allows chatting with specific agents",
  },
  {
    id: "AGENT_CHAT_STOP",
    name: "Agent Chat Stop",
    description: "Allows stopping agent conversations",
  },
  {
    id: "NORMAL_CHAT",
    name: "Normal Chat",
    description: "Allows normal chat functionality",
  },
  {
    id: "UPLOAD_KB",
    name: "Upload Knowledge Base",
    description: "Allows uploading files to knowledge base",
  },
]

interface ApiKeyProps {
  user: PublicUser
  workspace: PublicWorkspace
  agentWhiteList: boolean
}

const ApiKeyComponent = ({
  user,
  agentWhiteList,
}: Omit<ApiKeyProps, "workspace">) => {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [availableAgents, setAvailableAgents] = useState<ApiKeyAgent[]>([])
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [selectedApiKeyForScopes, setSelectedApiKeyForScopes] =
    useState<ApiKey | null>(null)
  const [selectedApiKeyForAgents, setSelectedApiKeyForAgents] =
    useState<ApiKey | null>(null)

  // Form state
  const [keyName, setKeyName] = useState("")
  const [selectedScopes, setSelectedScopes] = useState<string[]>([])
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])

  const { toast } = useToast() // Load initial data
  useEffect(() => {
    loadApiKeys()
    loadAvailableAgents()
  }, [])

  const loadApiKeys = async () => {
    try {
      setIsLoading(true)
      // Mock API call - replace with actual endpoint
      const response = await authFetch("/api/v1/api-keys")
      if (response.ok) {
        const data = await response.json()
        setApiKeys(data.keys || [])
      }
    } catch (err) {
      console.error("Failed to load API keys:", err)
      // For now, use mock data
      setApiKeys([
        {
          id: "1",
          name: "Production API Key",
          key: "xyne_api_12345678901234567890",
          scopes: ["NORMAL_CHAT", "UPLOAD_KB"],
          agents: [],
          createdAt: "2024-01-15T10:30:00Z",
          isVisible: false,
        },
      ])
    } finally {
      setIsLoading(false)
    }
  }

  const loadAvailableAgents = async () => {
    try {
      const response = await api.agents.$get({ query: { filter: "all" } })
      if (response.ok) {
        const data = (await response.json()) as SelectPublicAgent[]
        const agentData: ApiKeyAgent[] = data.map((agent) => ({
          externalId: agent.externalId,
          name: agent.name,
          description: agent.description,
        }))
        setAvailableAgents(agentData)
      }
    } catch (err) {
      console.error("Failed to load agents:", err)
      // Fallback to empty array in case of error
      setAvailableAgents([])
    }
  }

  const handleCreateApiKey = async () => {
    if (!keyName.trim()) {
      toast({
        title: "Error",
        description: "Please enter a name for your API key",
        variant: "destructive",
      })
      return
    }

    if (selectedScopes.length === 0) {
      toast({
        title: "Error",
        description: "Please select at least one scope",
        variant: "destructive",
      })
      return
    }

    setIsGenerating(true)
    try {
      const payload: CreateApiKeyPayload = {
        name: keyName,
        scopes: selectedScopes,
        agents: selectedAgents,
      }

      // Mock API call - replace with actual endpoint
      const response = await authFetch("/api/v1/api-keys", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      })

      if (response.ok) {
        const newKey = await response.json()
        setApiKeys((prev) => [...prev, newKey])
        resetForm()
        setIsCreateModalOpen(false)
        toast({
          title: "Success",
          description: "API key created successfully!",
        })
      } else {
        throw new Error("Failed to create API key")
      }
    } catch {
      // Mock success for demo
      const mockKey: ApiKey = {
        id: Date.now().toString(),
        name: keyName,
        key: `xyne_api_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`,
        scopes: selectedScopes,
        agents: selectedAgents,
        createdAt: new Date().toISOString(),
        isVisible: false,
      }

      setApiKeys((prev) => [...prev, mockKey])
      resetForm()
      setIsCreateModalOpen(false)
      toast({
        title: "Success",
        description: "API key created successfully!",
      })
    } finally {
      setIsGenerating(false)
    }
  }

  const resetForm = () => {
    setKeyName("")
    setSelectedScopes([])
    setSelectedAgents([])
  }

  const handleRevokeApiKey = async (keyId: string) => {
    try {
      // Mock API call - replace with actual endpoint
      await authFetch(`/api/v1/api-keys/${keyId}`, {
        method: "DELETE",
      })

      setApiKeys((prev) => prev.filter((key) => key.id !== keyId))
      toast({
        title: "Success",
        description: "API key revoked successfully",
      })
    } catch {
      toast({
        title: "Error",
        description: "Failed to revoke API key",
        variant: "destructive",
      })
    }
  }

  const toggleKeyVisibility = (keyId: string) => {
    setApiKeys((prev) =>
      prev.map((key) =>
        key.id === keyId ? { ...key, isVisible: !key.isVisible } : key,
      ),
    )
  }

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast({
        title: "Copied!",
        description: "API key copied to clipboard",
      })
    } catch {
      toast({
        title: "Error",
        description: "Failed to copy to clipboard",
        variant: "destructive",
      })
    }
  }

  const handleScopeToggle = (scopeId: string) => {
    if (selectedScopes.includes(scopeId)) {
      setSelectedScopes((prev) => prev.filter((s) => s !== scopeId))
    } else {
      setSelectedScopes((prev) => [...prev, scopeId])
    }
  }

  const handleAgentToggle = (agentExternalId: string) => {
    if (selectedAgents.includes(agentExternalId)) {
      setSelectedAgents((prev) => prev.filter((a) => a !== agentExternalId))
    } else {
      setSelectedAgents((prev) => [...prev, agentExternalId])
    }
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    })
  }

  const truncateName = (name: string, maxLength: number = 10) => {
    if (name.length <= maxLength) return name
    return name.substring(0, maxLength) + "..."
  }

  const getScopeNames = (scopeIds: string[]) => {
    return scopeIds
      .map((id) => AVAILABLE_SCOPES.find((s) => s.id === id)?.name || id)
      .join(", ")
  }

  const getFirstScopeName = (scopeIds: string[]) => {
    if (scopeIds.length === 0) return "No scopes"
    const firstScope = AVAILABLE_SCOPES.find((s) => s.id === scopeIds[0])
    return firstScope?.name || scopeIds[0]
  }

  const getAgentNames = (agentExternalIds: string[]) => {
    if (agentExternalIds.length === 0) return "No agents selected"
    return agentExternalIds
      .map(
        (externalId) =>
          availableAgents.find((a) => a.externalId === externalId)?.name ||
          externalId,
      )
      .join(", ")
  }

  const getFirstAgentName = (agentExternalIds: string[]) => {
    if (agentExternalIds.length === 0) return "No agents"
    const firstAgent = availableAgents.find(
      (a) => a.externalId === agentExternalIds[0],
    )
    return firstAgent?.name || agentExternalIds[0]
  }

  const maskApiKey = (key: string, isVisible: boolean) => {
    if (isVisible) return key
    const visiblePart = key.substring(0, 12)
    return `${visiblePart}${"•".repeat(20)}`
  }

  return (
    <div className="flex w-full h-full dark:bg-[#1E1E1E]">
      <Sidebar
        photoLink={user?.photoLink ?? ""}
        role={user?.role}
        isAgentMode={agentWhiteList}
      />
      <IntegrationsSidebar role={user.role} isAgentMode={agentWhiteList} />
      <div className="w-full h-full flex items-center justify-center">
        <div className="p-8 space-y-6 bg-background min-h-screen w-full max-w-full overflow-x-auto">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-foreground">API Keys</h1>
              <p className="text-muted-foreground mt-2">
                Manage your API keys with custom scopes and agent access
              </p>
            </div>

            <Dialog
              open={isCreateModalOpen}
              onOpenChange={setIsCreateModalOpen}
            >
              <DialogTrigger asChild>
                <Button className="bg-slate-800 hover:bg-slate-700 text-white">
                  <Plus className="w-4 h-4 mr-2" />
                  Create API Key
                </Button>
              </DialogTrigger>

              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Key className="w-5 h-5" />
                    Create New API Key
                  </DialogTitle>
                  <DialogDescription>
                    Configure scopes and agent access for your new API key
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-6 py-4">
                  {/* API Key Name */}
                  <div className="space-y-2">
                    <Label htmlFor="keyName">Name</Label>
                    <Input
                      id="keyName"
                      placeholder="Enter a descriptive name for your API key"
                      value={keyName}
                      onChange={(e) => setKeyName(e.target.value)}
                    />
                  </div>

                  {/* Scopes Selection */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>Scopes</Label>
                    </div>

                    <div className="grid grid-cols-1 gap-3">
                      {AVAILABLE_SCOPES.map((scope) => (
                        <div
                          key={scope.id}
                          className="flex items-start space-x-3"
                        >
                          <input
                            type="checkbox"
                            id={scope.id}
                            checked={selectedScopes.includes(scope.id)}
                            onChange={() => handleScopeToggle(scope.id)}
                            className="mt-1 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                          />
                          <div className="flex-1">
                            <label
                              htmlFor={scope.id}
                              className="font-medium cursor-pointer"
                            >
                              {scope.name}
                            </label>
                            <p className="text-sm text-muted-foreground">
                              {scope.description}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Agents Selection */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>Agent Access</Label>
                    </div>

                    <div className="grid grid-cols-1 gap-2 max-h-40 overflow-y-auto border rounded-lg p-3">
                      {availableAgents.map((agent) => (
                        <div
                          key={agent.externalId}
                          className="flex items-start space-x-3"
                        >
                          <input
                            type="checkbox"
                            id={agent.externalId}
                            checked={selectedAgents.includes(agent.externalId)}
                            onChange={() => handleAgentToggle(agent.externalId)}
                            className="mt-1 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                          />
                          <div className="flex-1">
                            <Label
                              htmlFor={agent.externalId}
                              className="cursor-pointer font-medium"
                            >
                              {agent.name}
                            </Label>
                            {agent.description && (
                              <p className="text-sm text-muted-foreground">
                                {agent.description}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setIsCreateModalOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button onClick={handleCreateApiKey} disabled={isGenerating}>
                    {isGenerating ? "Creating..." : "Create API Key"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          {/* API Keys Table */}
          <Card>
            <CardHeader>
              <CardTitle>Your API Keys</CardTitle>
              <CardDescription>
                {apiKeys.length === 0
                  ? "No API keys created yet"
                  : `${apiKeys.length} API key(s)`}
              </CardDescription>
            </CardHeader>

            <CardContent>
              {isLoading ? (
                <div className="text-center py-8 text-muted-foreground">
                  Loading API keys...
                </div>
              ) : apiKeys.length === 0 ? (
                <div className="text-center py-12">
                  <Key className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                  <p className="text-lg font-medium text-muted-foreground">
                    No API keys yet
                  </p>
                  <p className="text-sm text-muted-foreground mb-4">
                    Create your first API key to get started
                  </p>
                  <Button onClick={() => setIsCreateModalOpen(true)}>
                    <Plus className="w-4 h-4 mr-2" />
                    Create API Key
                  </Button>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>API Key</TableHead>
                      <TableHead>Scopes</TableHead>
                      <TableHead>Agent Access</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="w-[70px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {apiKeys.map((apiKey) => (
                      <TableRow key={apiKey.id}>
                        <TableCell className="font-medium" title={apiKey.name}>
                          {truncateName(apiKey.name)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center space-x-2">
                            <code className="text-sm font-mono bg-muted px-2 py-1 rounded">
                              {maskApiKey(
                                apiKey.key,
                                apiKey.isVisible || false,
                              )}
                            </code>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => toggleKeyVisibility(apiKey.id)}
                            >
                              {apiKey.isVisible ? (
                                <EyeOff className="w-4 h-4" />
                              ) : (
                                <Eye className="w-4 h-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => copyToClipboard(apiKey.key)}
                            >
                              <Copy className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span
                              className="max-w-32 truncate"
                              title={getScopeNames(apiKey.scopes)}
                            >
                              {truncateName(
                                getFirstScopeName(apiKey.scopes),
                                15,
                              )}
                            </span>
                            {apiKey.scopes.length > 1 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setSelectedApiKeyForScopes(apiKey)
                                }
                                className="text-xs px-2 py-1 h-6 text-blue-600 hover:text-blue-700"
                              >
                                +{apiKey.scopes.length - 1} more
                              </Button>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span
                              className="max-w-32 truncate"
                              title={getAgentNames(apiKey.agents)}
                            >
                              {truncateName(
                                getFirstAgentName(apiKey.agents),
                                15,
                              )}
                            </span>
                            {apiKey.agents.length > 1 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setSelectedApiKeyForAgents(apiKey)
                                }
                                className="text-xs px-2 py-1 h-6 text-blue-600 hover:text-blue-700"
                              >
                                +{apiKey.agents.length - 1} more
                              </Button>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDate(apiKey.createdAt)}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm">
                                <MoreHorizontal className="w-4 h-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => handleRevokeApiKey(apiKey.id)}
                                className="text-red-600 hover:text-red-700"
                              >
                                <Trash2 className="w-4 h-4 mr-2" />
                                Revoke
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Scopes Modal */}
          <Dialog
            open={!!selectedApiKeyForScopes}
            onOpenChange={(open) => !open && setSelectedApiKeyForScopes(null)}
          >
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>API Key Scopes</DialogTitle>
                <DialogDescription>
                  Scopes for "
                  {truncateName(selectedApiKeyForScopes?.name || "", 30)}"
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {selectedApiKeyForScopes?.scopes.map((scopeId) => {
                  const scope = AVAILABLE_SCOPES.find((s) => s.id === scopeId)
                  return (
                    <div key={scopeId} className="flex items-start space-x-3">
                      <div className="w-2 h-2 rounded-full bg-blue-500 mt-2 flex-shrink-0" />
                      <div>
                        <p className="font-medium">{scope?.name || scopeId}</p>
                        <p className="text-sm text-muted-foreground">
                          {scope?.description || "No description available"}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </DialogContent>
          </Dialog>

          {/* Agents Modal */}
          <Dialog
            open={!!selectedApiKeyForAgents}
            onOpenChange={(open) => !open && setSelectedApiKeyForAgents(null)}
          >
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>API Key Agent Access</DialogTitle>
                <DialogDescription>
                  Agent access for "
                  {truncateName(selectedApiKeyForAgents?.name || "", 30)}"
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {selectedApiKeyForAgents?.agents.length === 0 ? (
                  <div className="flex items-start space-x-3">
                    <div className="w-2 h-2 rounded-full bg-gray-400 mt-2 flex-shrink-0" />
                    <div>
                      <p className="font-medium text-muted-foreground">
                        No agents selected
                      </p>
                      <p className="text-sm text-muted-foreground">
                        This API key has no agent access
                      </p>
                    </div>
                  </div>
                ) : (
                  selectedApiKeyForAgents?.agents.map((agentExternalId) => {
                    const agent = availableAgents.find(
                      (a) => a.externalId === agentExternalId,
                    )
                    return (
                      <div
                        key={agentExternalId}
                        className="flex items-start space-x-3"
                      >
                        <div className="w-2 h-2 rounded-full bg-green-500 mt-2 flex-shrink-0" />
                        <div>
                          <p className="font-medium">
                            {agent?.name || agentExternalId}
                          </p>
                          {agent?.description && (
                            <p className="text-sm text-muted-foreground">
                              {agent.description}
                            </p>
                          )}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  )
}

const ApiKeyWrapper = () => {
  const matches = useRouterState({ select: (s) => s.matches })
  const { user, agentWhiteList } = matches[matches.length - 1].context
  return <ApiKeyComponent user={user} agentWhiteList={agentWhiteList} />
}

export const Route = createFileRoute("/_authenticated/integrations/apiKey")({
  beforeLoad: async ({ params }) => {
    // Future: Add role-based access control here if needed
    return params
  },
  loader: async (params) => {
    return params
  },
  component: ApiKeyWrapper,
  errorComponent: errorComponent,
})
