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
import { Key, Plus, Copy, Trash2, MoreHorizontal } from "lucide-react"
import { errorComponent } from "@/components/error"
import { authFetch } from "@/utils/authFetch"
import { api } from "@/api"
import { ApiKeyScopes } from "shared/types"
import type { PublicUser, SelectPublicAgent } from "shared/types"

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
  isNewlyCreated?: boolean
}

// Available scopes
const AVAILABLE_SCOPES: ApiKeyScope[] = [
  {
    id: ApiKeyScopes.CREATE_AGENT,
    name: "Create Agent",
    description: "Allows creating new agents",
  },
  {
    id: ApiKeyScopes.READ_AGENT,
    name: "Read Agent",
    description: "Allows reading agent details (read-only access)",
  },
  {
    id: ApiKeyScopes.AGENT_CHAT,
    name: "Agent Chat",
    description: "Allows chatting with agents",
  },
  {
    id: ApiKeyScopes.AGENT_CHAT_STOP,
    name: "Agent Chat Stop",
    description: "Allows stopping agent conversations",
  },
  {
    id: ApiKeyScopes.UPDATE_AGENT,
    name: "Update Agent",
    description: "Allows updating existing agents",
  },
  {
    id: ApiKeyScopes.DELETE_AGENT,
    name: "Delete Agent",
    description: "Allows deleting agents",
  },
  {
    id: ApiKeyScopes.CHAT_HISTORY,
    name: "Chat History",
    description: "Allows accessing chat history",
  },
  {
    id: ApiKeyScopes.CREATE_COLLECTION,
    name: "Create Collection",
    description: "Allows creating knowledge base collections",
  },
  {
    id: ApiKeyScopes.UPDATE_COLLECTION,
    name: "Update Collection",
    description: "Allows updating knowledge base collections",
  },
  {
    id: ApiKeyScopes.LIST_COLLECTIONS,
    name: "List Collections",
    description: "Allows listing all knowledge base collections",
  },
  {
    id: ApiKeyScopes.UPLOAD_FILES,
    name: "Upload Files",
    description: "Allows uploading files to knowledge base collections",
  },
  {
    id: ApiKeyScopes.SEARCH_COLLECTION,
    name: "Search Collection",
    description: "Allows searching within knowledge base collections",
  },
  {
    id: ApiKeyScopes.DELETE_COLLECTION,
    name: "Delete Collection",
    description: "Allows deleting knowledge base collections",
  },
  {
    id: ApiKeyScopes.DELETE_COLLECTION_ITEM,
    name: "Delete Collection Item",
    description: "Allows deleting items from knowledge base collections",
  },
]

interface ApiKeyProps {
  user: PublicUser
  agentWhiteList: boolean
}

const ApiKeyComponent = ({ user, agentWhiteList }: ApiKeyProps) => {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [availableAgents, setAvailableAgents] = useState<ApiKeyAgent[]>([])
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [selectedApiKeyForScopes, setSelectedApiKeyForScopes] =
    useState<ApiKey | null>(null)
  const [selectedApiKeyForAgents, setSelectedApiKeyForAgents] =
    useState<ApiKey | null>(null)
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<ApiKey | null>(null)
  const [showNewKeyDialog, setShowNewKeyDialog] = useState(false)

  // Form state
  const [keyName, setKeyName] = useState("")
  const [selectedScopes, setSelectedScopes] = useState<string[]>([])
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])

  const { toast } = useToast()

  useEffect(() => {
    loadApiKeys()
    loadAvailableAgents()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadApiKeys = async () => {
    try {
      setIsLoading(true)
      const response = await authFetch("/api/v1/users/api-keys")
      if (response.ok) {
        const data = await response.json()
        if (data.success) {
          setApiKeys(data.keys || [])
        }
      }
    } catch (err) {
      console.error("Failed to load API keys:", err)
      toast({
        title: "Error",
        description: "Failed to load API keys",
        variant: "destructive",
      })
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
      const payload = {
        name: keyName,
        permissions: {
          scopes: selectedScopes,
          agents: selectedAgents,
        },
      }

      const response = await authFetch("/api/v1/users/api-key", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      })

      if (response.ok) {
        const result = await response.json()
        if (result.success && result.apiKey) {
          const newApiKey = { ...result.apiKey, isNewlyCreated: true }
          setApiKeys((prev) => [...prev, newApiKey])
          setNewlyCreatedKey(newApiKey)
          resetForm()
          setIsCreateModalOpen(false)
          setShowNewKeyDialog(true)
        } else {
          throw new Error("Failed to create API key")
        }
      } else {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.message || "Failed to create API key")
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to create API key",
        variant: "destructive",
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
      const response = await authFetch(`/api/v1/users/api-keys/${keyId}`, {
        method: "DELETE",
      })

      if (response.ok) {
        const result = await response.json()
        if (result.success) {
          setApiKeys((prev) => prev.filter((key) => key.id !== keyId))
          toast({
            title: "Success",
            description: "API key revoked successfully",
          })
        } else {
          throw new Error(result.message || "Failed to revoke API key")
        }
      } else {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.message || "Failed to revoke API key")
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to revoke API key",
        variant: "destructive",
      })
    }
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
    if (agentExternalIds.length === 0) return "All agents"
    return agentExternalIds
      .map(
        (externalId) =>
          availableAgents.find((a) => a.externalId === externalId)?.name ||
          externalId,
      )
      .join(", ")
  }

  const getFirstAgentName = (agentExternalIds: string[]) => {
    if (agentExternalIds.length === 0) return "All agents"
    const firstAgent = availableAgents.find(
      (a) => a.externalId === agentExternalIds[0],
    )
    return firstAgent?.name || agentExternalIds[0]
  }

  const maskApiKey = (key: string) => {
    // If the key is already masked (contains asterisks), return as is
    if (key.includes("*")) {
      return key
    }
    // Otherwise, mask it (fallback for newly created keys)
    const visiblePart = key.substring(0, 4)
    return `${visiblePart}${"*".repeat(28)}`
  }

  return (
    <div className="flex w-full h-full dark:bg-[#1E1E1E]">
      <Sidebar
        photoLink={user?.photoLink ?? ""}
        role={user?.role}
        isAgentMode={agentWhiteList}
      />
      <IntegrationsSidebar role={user.role} isAgentMode={agentWhiteList} />
      <div className="w-full h-full flex justify-center">
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

                    <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                      <p className="text-sm text-blue-800">
                        <strong>Note:</strong> If no agents are selected, the
                        API key will have access to all agents in your
                        workspace. Select specific agents to restrict access.
                      </p>
                    </div>

                    <div className="border rounded-lg p-3">
                      {availableAgents.length === 0 ? (
                        <div className="text-center py-8">
                          <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3">
                            <Key className="w-6 h-6 text-gray-400" />
                          </div>
                          <p className="text-sm font-medium text-gray-600 mb-1">
                            No agents to select
                          </p>
                          <p className="text-xs text-gray-500">
                            Create agents first to restrict API key access to
                            specific agents
                          </p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 gap-2 max-h-40 overflow-y-auto">
                          {availableAgents.map((agent) => (
                            <div
                              key={agent.externalId}
                              className="flex items-start space-x-3"
                            >
                              <input
                                type="checkbox"
                                id={agent.externalId}
                                checked={selectedAgents.includes(
                                  agent.externalId,
                                )}
                                onChange={() =>
                                  handleAgentToggle(agent.externalId)
                                }
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
                      )}
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
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {apiKeys.map((apiKey) => (
                      <TableRow key={apiKey.id}>
                        <TableCell className="font-medium" title={apiKey.name}>
                          {truncateName(apiKey.name)}
                        </TableCell>
                        <TableCell>
                          <code className="text-sm font-mono bg-muted px-2 py-1 rounded">
                            {maskApiKey(apiKey.key)}
                          </code>
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
                              <Button
                                variant="ghost"
                                size="sm"
                                className="focus-visible:ring-0"
                              >
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
                    <div className="w-2 h-2 rounded-full bg-green-500 mt-2 flex-shrink-0" />
                    <div>
                      <p className="font-medium">All agents</p>
                      <p className="text-sm text-muted-foreground">
                        This API key has access to all agents in the workspace
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

          {/* New API Key Success Modal */}
          <Dialog open={showNewKeyDialog} onOpenChange={setShowNewKeyDialog}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Key className="w-5 h-5 text-green-600" />
                  API Key Created Successfully!
                </DialogTitle>
                <DialogDescription>
                  Your API key has been created. Copy it now - you won't be able
                  to see it again!
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>API Key Name</Label>
                  <div className="p-3 bg-muted rounded-lg">
                    <p className="font-medium">{newlyCreatedKey?.name}</p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>API Key</Label>
                  <div className="flex items-center space-x-2">
                    <code className="flex-1 text-sm font-mono bg-muted px-3 py-2 rounded-lg break-all">
                      {newlyCreatedKey?.key}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        copyToClipboard(newlyCreatedKey?.key || "")
                      }
                    >
                      <Copy className="w-4 h-4 mr-2" />
                      Copy
                    </Button>
                  </div>
                </div>

                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <p className="text-sm text-yellow-800">
                    <strong>Important:</strong> This is the only time you'll be
                    able to see the full API key. Make sure to copy and store it
                    securely. After closing this dialog, you won't be able to
                    see the whole API key.
                  </p>
                </div>
              </div>

              <DialogFooter>
                <Button
                  onClick={() => setShowNewKeyDialog(false)}
                  className="w-full"
                >
                  I've Saved My API Key
                </Button>
              </DialogFooter>
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
    return params
  },
  loader: async (params) => {
    return params
  },
  component: ApiKeyWrapper,
  errorComponent: errorComponent,
})
