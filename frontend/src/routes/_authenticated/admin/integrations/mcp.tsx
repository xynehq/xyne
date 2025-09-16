import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { useForm } from "@tanstack/react-form"
import { useToast } from "@/hooks/use-toast"
import { useNavigate } from "@tanstack/react-router"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { api } from "@/api"
import { getErrorMessage } from "@/lib/utils"
import { Apps, ConnectorType } from "shared/types" // Added ConnectorType
import { PublicUser, PublicWorkspace } from "shared/types"
import { Sidebar } from "@/components/Sidebar"
import { IntegrationsSidebar } from "@/components/IntegrationsSidebar"
import { RefreshCw, X, PlusCircle, Check, RotateCcw } from "lucide-react" // Added PlusCircle, Check, RotateCcw
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useState, useEffect, useRef } from "react" // Added React hooks
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog" // Added Dialog components
import { useQuery } from "@tanstack/react-query"
import { ConnectorStatus } from "shared/types"

// Interface for fetched tools (copied from ChatBox.tsx)
interface FetchedTool {
  id: number // This is the tool's internal DB ID
  workspaceId: number
  connectorId: number
  toolName: string
  toolSchema: string
  description: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

// Function to submit the MCP client connector details
const submitMCPClient = async (
  value: {
    name: string
    url: string
    mode: "sse" | "streamable-http"
    headers: Record<string, string>
  },
  navigate: ReturnType<typeof useNavigate>,
) => {
  const response = await api.admin.apikey.mcp.create.$post({
    json: {
      url: value.url,
      name: value.name,
      mode: value.mode,
      headers: value.headers,
    },
  })
  if (!response.ok) {
    if (response.status === 401) {
      navigate({ to: "/auth" })
      throw new Error("Unauthorized")
    }
    const errorText = await response.text()
    throw new Error(
      `Failed to add MCP connector: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }
  return response.json()
}

// Function to submit the MCP stdio connector details
const submitMCPStdio = async (
  value: { name: string; command: string; args: string; appType: string },
  navigate: ReturnType<typeof useNavigate>,
) => {
  const response = await api.admin.stdio.mcp.create.$post({
    form: {
      command: value.command,
      args: value.args.split(" "), // Split args by space into an array
      name: value.name,
      appType: value.appType,
    },
  })
  if (!response.ok) {
    if (response.status === 401) {
      navigate({ to: "/auth" })
      throw new Error("Unauthorized")
    }
    const errorText = await response.text()
    throw new Error(
      `Failed to add MCP stdio connector: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }
  return response.json()
}

// Delete MCP client connector
const deleteMCPClient = async (connectorId: string) => {
  const res = await api.admin.connector.delete.$delete({
    form: {
      connectorId,
    },
  })
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Unauthorized")
    }
    throw new Error("Could not delete connector")
  }
  return res.json()
}

// Get all connectors
export const getConnectors = async (): Promise<any> => {
  const res = await api.admin.connectors.all.$get()
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Unauthorized")
    }
    throw new Error("Could not get connectors")
  }
  return res.json()
}

// MCP Client Form Component
export const MCPClientForm = ({ onSuccess }: { onSuccess: () => void }) => {
  const { toast } = useToast()
  const navigate = useNavigate()
  const form = useForm<{
    name: string
    url: string
    mode: "sse" | "streamable-http"
    headers: { u_id: number; key: string; value: string }[]
  }>({
    defaultValues: {
      name: "",
      url: "",
      mode: "sse",
      headers: [{ u_id: Date.now(), key: "", value: "" }],
    },
    onSubmit: async ({ value }) => {
      try {
        // Transform headers from array to object, filtering out empty keys
        const headersObject = value.headers.reduce(
          (acc, header) => {
            if (header.key) {
              acc[header.key] = header.value
            }
            return acc
          },
          {} as Record<string, string>,
        )

        await submitMCPClient(
          {
            name: value.name,
            url: value.url,
            mode: value.mode,
            headers: headersObject,
          },
          navigate,
        )
        toast({
          title: "MCP Client Connected",
          description: "MCP Client successfully connected. Updating status...",
        })
        // Reset the form
        form.reset()
        onSuccess()
      } catch (error) {
        toast({
          title: "Could not connect MCP Client",
          description: `Error: ${getErrorMessage(error)}`,
          variant: "destructive",
        })
      }
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
      className="grid w-full items-center gap-1.5"
    >
      <form.Field
        name="name"
        validators={{
          onChange: ({ value }) => (!value ? "Name is required" : undefined),
        }}
        children={(field) => (
          <>
            <Label htmlFor={field.name} className="mt-2">
              Name
            </Label>
            <Input
              id={field.name}
              type="text"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Enter MCP Client Name"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <div className="text-red-500 text-sm">
                {field.state.meta.errors[0]}
              </div>
            ) : null}
          </>
        )}
      />

      <form.Field
        name="url"
        validators={{
          onChange: ({ value }) => (!value ? "URL is required" : undefined),
        }}
        children={(field) => (
          <>
            <Label htmlFor={field.name} className="mt-2">
              URL
            </Label>
            <Input
              id={field.name}
              type="text"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Enter MCP Client URL"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <div className="text-red-500 text-sm">
                {field.state.meta.errors[0]}
              </div>
            ) : null}
          </>
        )}
      />

      <form.Field
        name="mode"
        children={(field) => (
          <>
            <Label htmlFor={field.name} className="mt-2">
              Mode
            </Label>
            <Select
              value={field.state.value}
              onValueChange={(value) =>
                field.handleChange(value as "streamable-http" | "sse")
              }
            >
              <SelectTrigger id={field.name}>
                <SelectValue placeholder="Select a mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sse">SSE</SelectItem>
                <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
              </SelectContent>
            </Select>
          </>
        )}
      />

      <>
        <Label className="mt-2">Custom Headers</Label>
        <form.Field
          name="headers"
          children={(field) => {
            return (
              <div className="space-y-2 mt-1">
                {field.state.value.map((header, index) => (
                  <div key={header.u_id} className="flex items-center gap-2">
                    <form.Field
                      key={`headers[${index}].key`}
                      name={`headers[${index}].key`}
                      children={(subField) => (
                        <Input
                          value={subField.state.value}
                          onChange={(e) =>
                            subField.handleChange(e.target.value)
                          }
                          placeholder="Header Key"
                          className="flex-1"
                        />
                      )}
                    />
                    <form.Field
                      key={`headers[${index}].value`}
                      name={`headers[${index}].value`}
                      children={(subField) => (
                        <Input
                          value={subField.state.value}
                          onChange={(e) =>
                            subField.handleChange(e.target.value)
                          }
                          placeholder="Header Value"
                          className="flex-1"
                        />
                      )}
                    />
                    <Button
                      type="button"
                      variant="destructive"
                      size="icon"
                      onClick={() => field.removeValue(index)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  className="w-full mt-2"
                  onClick={() =>
                    field.pushValue({
                      u_id: Date.now() /* using Date.now() here so that we can keep this as key for our list */,
                      key: "",
                      value: "",
                    })
                  }
                >
                  <PlusCircle className="h-4 w-4 mr-2" />
                  Add Header
                </Button>
              </div>
            )
          }}
        />
      </>

      <Button
        type="submit"
        className="w-full mt-4"
        disabled={form.state.isSubmitting}
      >
        {form.state.isSubmitting ? "Adding..." : "Add MCP Client"}
      </Button>
    </form>
  )
}

// MCP Stdio Form Component
export const MCPStdioForm = ({ onSuccess }: { onSuccess: () => void }) => {
  const { toast } = useToast()
  const navigate = useNavigate()
  const form = useForm<{
    name: string
    command: string
    args: string
    appType: string
  }>({
    defaultValues: { name: "", command: "", args: "", appType: "" },
    onSubmit: async ({ value }) => {
      try {
        await submitMCPStdio(value, navigate)
        toast({
          title: "MCP Stdio Connected",
          description: "MCP Stdio successfully connected. Updating status...",
        })
        // Reset the form
        form.reset()
        onSuccess()
      } catch (error) {
        toast({
          title: "Could not connect MCP Stdio",
          description: `Error: ${getErrorMessage(error)}`,
          variant: "destructive",
        })
      }
    },
  })

  // App types for the dropdown
  const appTypes = [
    { value: "github", label: "GitHub" },
    { value: "custom", label: "Custom" },
  ]

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
      className="grid w-full items-center gap-1.5"
    >
      <Label htmlFor="name" className="mt-2">
        App Name
      </Label>
      <form.Field
        name="name"
        validators={{
          onChange: ({ value }) =>
            !value ? "App Name is required" : undefined,
        }}
        children={(field) => (
          <>
            <Input
              id="name"
              type="text"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Enter MCP App Name"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <div className="text-red-500 text-sm">
                {field.state.meta.errors[0]}
              </div>
            ) : null}
          </>
        )}
      />

      <Label htmlFor="appType" className="mt-2">
        App Type
      </Label>
      <form.Field
        name="appType"
        validators={{
          onChange: ({ value }) =>
            !value ? "App Type is required" : undefined,
        }}
        children={(field) => (
          <>
            <select
              id="appType"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
            >
              <option value="" disabled>
                Select App Type
              </option>
              {appTypes.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <div className="text-red-500 text-sm">
                {field.state.meta.errors[0]}
              </div>
            ) : null}
          </>
        )}
      />

      <Label htmlFor="command" className="mt-2">
        Command
      </Label>
      <form.Field
        name="command"
        validators={{
          onChange: ({ value }) => (!value ? "Command is required" : undefined),
        }}
        children={(field) => (
          <>
            <Input
              id="command"
              type="text"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Enter command (e.g., npm, python, bash)"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <div className="text-red-500 text-sm">
                {field.state.meta.errors[0]}
              </div>
            ) : null}
          </>
        )}
      />

      <Label htmlFor="args" className="mt-2">
        Arguments
      </Label>
      <form.Field
        name="args"
        children={(field) => (
          <>
            <Input
              id="args"
              type="text"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Enter command arguments (e.g., --port 3000)"
            />
          </>
        )}
      />

      <Button type="submit" className="mt-4">
        Add MCP Stdio
      </Button>
    </form>
  )
}

// List of MCP clients with enhanced controls
const MCPClientsList = ({
  clients,
  onDelete,
  onRefresh,
}: {
  clients: any[]
  onDelete: (id: string) => Promise<void>
  onRefresh: () => void
}) => {
  const { toast } = useToast()
  const [isToolModalOpen, setIsToolModalOpen] = useState(false)
  const [selectedClientForTools, setSelectedClientForTools] = useState<
    any | null
  >(null)
  const [connectorTools, setConnectorTools] = useState<FetchedTool[]>([])
  const [isLoadingTools, setIsLoadingTools] = useState(false)
  const [toolSearchTerm, setToolSearchTerm] = useState("")
  // Stores { connectorExternalId: Set<toolName> }
  const [selectedTools, setSelectedTools] = useState<
    Record<string, Set<string>>
  >({})
  const initialToolsStateRef = useRef<FetchedTool[]>([])

  const handleManageTools = async (client: any) => {
    if (
      client.type !== ConnectorType.MCP &&
      client.app !== Apps.MCP &&
      client.app !== Apps.Github
    ) {
      // Ensure it's an MCP connector
      toast({
        title: "Not an MCP Connector",
        description: "Tool management is only available for MCP connectors.",
        variant: "destructive",
      })
      return
    }
    setSelectedClientForTools(client)
    setIsLoadingTools(true)
    setIsToolModalOpen(true)
    setToolSearchTerm("")
    try {
      // client.id is the externalId of the connector
      const response = await api.admin.connector[client.id].tools.$get(
        undefined,
        { credentials: "include" },
      )
      const toolsData: FetchedTool[] | any = await response.json()

      if (Array.isArray(toolsData)) {
        setConnectorTools(toolsData)
        initialToolsStateRef.current = JSON.parse(JSON.stringify(toolsData)) // Deep copy for initial state

        // Pre-populate selectedTools based on fetched enabled status
        const initiallyEnabledTools = new Set(
          toolsData.filter((t) => t.enabled).map((t) => t.toolName),
        )
        setSelectedTools((prev) => ({
          ...prev,
          [client.id]: initiallyEnabledTools,
        }))
      } else {
        setConnectorTools([])
        initialToolsStateRef.current = []
        toast({
          title: "Error",
          description: "Received invalid tool data.",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error(`Error fetching tools for ${client.id}:`, error)
      setConnectorTools([])
      initialToolsStateRef.current = []
      toast({
        title: "Failed to fetch tools",
        description: getErrorMessage(error),
        variant: "destructive",
      })
      setIsToolModalOpen(false) // Close modal on error
    } finally {
      setIsLoadingTools(false)
    }
  }

  // Effect to handle tool status updates when the modal closes
  useEffect(() => {
    if (
      !isToolModalOpen &&
      selectedClientForTools &&
      initialToolsStateRef.current &&
      initialToolsStateRef.current.length >= 0
    ) {
      // Allow empty initial state if no tools
      const toolsToUpdate: Array<{ toolId: number; enabled: boolean }> = []
      const currentSelectedToolNames =
        selectedTools[selectedClientForTools.id] || new Set()

      initialToolsStateRef.current.forEach((initialTool) => {
        const isCurrentlySelected = currentSelectedToolNames.has(
          initialTool.toolName,
        )
        if (initialTool.enabled !== isCurrentlySelected) {
          toolsToUpdate.push({
            toolId: initialTool.id,
            enabled: isCurrentlySelected,
          })
        }
      })

      // Check for tools that were not in the initial list but might have been added (not applicable here but good practice)
      // For this case, we only care about tools that were initially fetched.

      if (toolsToUpdate.length > 0) {
        api.admin.tools.update_status
          .$post({ json: { tools: toolsToUpdate } }, { credentials: "include" })
          .then(async (res: Response) => {
            if (res.ok) {
              toast({
                title: "Tools Updated",
                description: "Tool statuses updated successfully.",
              })
              onRefresh() // Refresh the main list to reflect any status changes if necessary
            } else {
              const errorText = await res.text()
              console.error(
                "Failed to update tools. Server response:",
                errorText,
              )
              try {
                const errorData = JSON.parse(errorText)
                toast({
                  title: "Failed to update tools",
                  description: errorData.error || "Unknown error",
                  variant: "destructive",
                })
              } catch (e) {
                toast({
                  title: "Failed to update tools",
                  description: errorText,
                  variant: "destructive",
                })
              }
            }
          })
          .catch((error: any) => {
            console.error("Error calling update tools API:", error)
            toast({
              title: "API Error",
              description: `Error updating tools: ${getErrorMessage(error)}`,
              variant: "destructive",
            })
          })
      }
      // Reset states for next modal opening
      initialToolsStateRef.current = []
      setSelectedClientForTools(null)
      setConnectorTools([])
      // Keep selectedTools as it might be useful if user reopens modal for same/other client
    }
  }, [isToolModalOpen, selectedClientForTools, selectedTools, toast, onRefresh])

  if (clients.length === 0) {
    return (
      <p className="text-center text-gray-500 my-4">No MCP clients added yet</p>
    )
  }

  return (
    <div className="mt-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Tools</TableHead> {/* New Column for Tools */}
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {clients.map((client) => (
            <TableRow key={client.id}>
              <TableCell className="font-medium">
                {client.name || client.config?.name || client.app || "Unnamed"}
              </TableCell>
              <TableCell>
                {client.type === ConnectorType.MCP ||
                client.app === Apps.MCP ||
                client.app === Apps.Github
                  ? client.config?.command
                    ? "Stdio"
                    : "API Key"
                  : client.authType}
              </TableCell>
              <TableCell>
                <span
                  className={`px-2 py-1 rounded-full text-xs ${
                    client.status === ConnectorStatus.Connected
                      ? "bg-green-100 text-green-800"
                      : client.status === ConnectorStatus.Connecting
                        ? "bg-blue-100 text-blue-800"
                        : client.status === ConnectorStatus.Paused
                          ? "bg-yellow-100 text-yellow-800"
                          : "bg-gray-100 text-gray-800"
                  }`}
                >
                  {client.status}
                </span>
              </TableCell>
              <TableCell>
                {(client.type === ConnectorType.MCP ||
                  client.app === Apps.MCP ||
                  client.app === Apps.Github) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleManageTools(client)}
                    title="Manage Tools"
                  >
                    <PlusCircle className="h-4 w-4" />
                  </Button>
                )}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={async () => {
                      try {
                        await onDelete(client.id)
                        toast({
                          title: "Client Removed",
                          description:
                            "MCP Client has been removed successfully",
                        })
                      } catch (error) {
                        toast({
                          title: "Removal Failed",
                          description: getErrorMessage(error),
                          variant: "destructive",
                        })
                      }
                    }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Tool Selection Modal */}
      {selectedClientForTools && (
        <Dialog
          open={isToolModalOpen}
          onOpenChange={(isOpen) => {
            if (!isOpen) {
              // This will trigger the useEffect for saving
              setIsToolModalOpen(false)
            } else {
              setIsToolModalOpen(true)
            }
          }}
        >
          <DialogContent className="sm:max-w-[350px] flex flex-col max-h-[35vh] px-3 pt-3 pb-0">
            {" "}
            {/* Adjusted overall padding to p-3, then to px-3 pt-3 pb-1 */}
            <DialogHeader className="p-1 pt-0 flex flex-row justify-between items-center">
              {" "}
              {/* Added flex for alignment */}
              <DialogTitle className="text-lg">
                Manage Tools for{" "}
                {selectedClientForTools.config?.name ||
                  selectedClientForTools.name ||
                  selectedClientForTools.app}
              </DialogTitle>
            </DialogHeader>
            <div className="pt-0 pb-1">
              {" "}
              {/* Reduced padding around search input */}
              <Input
                type="text"
                placeholder="Search tools..."
                value={toolSearchTerm}
                onChange={(e) => setToolSearchTerm(e.target.value)}
                className="mb-1"
              />
            </div>
            {isLoadingTools ? (
              <div className="flex justify-center items-center h-32">
                <RefreshCw className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : (
              <div className="overflow-y-auto flex-grow pr-2">
                {" "}
                {/* Added pr-2 for scrollbar spacing */}
                {connectorTools.filter((tool) =>
                  tool.toolName
                    .toLowerCase()
                    .includes(toolSearchTerm.toLowerCase()),
                ).length > 0 ? (
                  connectorTools
                    .filter((tool) =>
                      tool.toolName
                        .toLowerCase()
                        .includes(toolSearchTerm.toLowerCase()),
                    )
                    .map((tool) => (
                      <div
                        key={tool.id} // Use tool.id (internal DB id) as key
                        className="flex items-center justify-between py-2 px-1 hover:bg-muted rounded cursor-pointer"
                        onClick={() => {
                          setSelectedTools((prev) => {
                            const newSelectedForClient = new Set(
                              prev[selectedClientForTools!.id] || [],
                            )
                            if (newSelectedForClient.has(tool.toolName)) {
                              newSelectedForClient.delete(tool.toolName)
                            } else {
                              newSelectedForClient.add(tool.toolName)
                            }
                            return {
                              ...prev,
                              [selectedClientForTools!.id]:
                                newSelectedForClient,
                            }
                          })
                        }}
                      >
                        <span
                          className="text-sm flex-grow mr-2 truncate"
                          title={tool.description || tool.toolName}
                        >
                          {tool.toolName}
                        </span>
                        <div className="h-5 w-5 flex items-center justify-center">
                          {" "}
                          {/* Simplified check icon display */}
                          {(
                            selectedTools[selectedClientForTools!.id] ||
                            new Set()
                          ).has(tool.toolName) && (
                            <Check className="h-4 w-4 text-green-500" />
                          )}
                        </div>
                      </div>
                    ))
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No tools found
                    {toolSearchTerm
                      ? ` for "${toolSearchTerm}"`
                      : connectorTools.length === 0
                        ? " for this connector"
                        : ""}
                    .
                  </p>
                )}
              </div>
            )}
            <DialogFooter className="mt-auto pt-2 pb-1 flex justify-between items-center">
              {selectedClientForTools &&
                selectedTools[selectedClientForTools.id] && (
                  <span className="text-xs text-muted-foreground">
                    ({selectedTools[selectedClientForTools.id]?.size || 0}{" "}
                    selected)
                  </span>
                )}
              {selectedClientForTools &&
                (selectedTools[selectedClientForTools.id]?.size || 0) > 0 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => {
                      if (selectedClientForTools) {
                        setSelectedTools((prev) => ({
                          ...prev,
                          [selectedClientForTools.id]: new Set(),
                        }))
                      }
                    }}
                    title="Clear all selected tools"
                  >
                    <RotateCcw className="h-4 w-4 text-muted-foreground hover:text-foreground" />
                  </Button>
                )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

// Main MCP component
export const MCPClient = ({
  user,
  workspace,
  agentWhiteList,
}: {
  user: PublicUser
  workspace: PublicWorkspace
  agentWhiteList: boolean
}) => {
  const navigate = useNavigate()

  // Get all connectors
  const { isPending, error, data, refetch } = useQuery<any[]>({
    queryKey: ["all-connectors"],
    queryFn: async (): Promise<any> => {
      try {
        const res = await api.admin.connectors.all.$get()
        if (!res.ok) {
          if (res.status === 401) {
            throw new Error("Unauthorized")
          }
          throw new Error("Could not get connectors")
        }
        return res.json()
      } catch (error) {
        const message = getErrorMessage(error)
        if (message === "Unauthorized") {
          navigate({ to: "/auth" })
          return []
        }
        throw error
      }
    },
  })
  console.log("error occurred: ", error)

  // Filter MCP client connectors (both API Key and Stdio) // TODO: add more generic way to filter
  const mcpConnectors =
    data?.filter((v) => v.app === Apps.MCP || v.app == Apps.Github) || []

  const handleDeleteClient = async (connectorId: string) => {
    await deleteMCPClient(connectorId)
    refetch()
  }

  return (
    <div className="flex w-full h-full">
      <Sidebar photoLink={user?.photoLink ?? ""} role={user?.role} isAgentMode={agentWhiteList} />
      <IntegrationsSidebar role={user.role} isAgentMode={agentWhiteList} />
      <div className="w-full h-full py-8 px-4 overflow-y-auto flex flex-col items-center justify-center">
        <div className="flex flex-col items-center">
          <h1 className="text-2xl font-bold mb-6">MCP Client Connectors</h1>

          {/* Add New Client Card */}
          <Card className="mb-6 w-[400px] min-h-[320px]">
            <CardHeader>
              <CardTitle>Add New MCP Client</CardTitle>
              <CardDescription>
                Connect to an MCP client using API key or stdio
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isPending ? (
                <div className="flex justify-center">
                  <svg
                    className="animate-spin h-5 w-5 text-primary"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                </div>
              ) : (
                <Tabs defaultValue="apikey">
                  <TabsList className="mb-4">
                    <TabsTrigger value="apikey">API Key</TabsTrigger>
                    <TabsTrigger value="stdio">Stdio</TabsTrigger>
                  </TabsList>
                  <TabsContent value="apikey">
                    <MCPClientForm
                      onSuccess={() => {
                        refetch()
                      }}
                    />
                  </TabsContent>
                  <TabsContent value="stdio">
                    <MCPStdioForm
                      onSuccess={() => {
                        refetch()
                      }}
                    />
                  </TabsContent>
                </Tabs>
              )}
            </CardContent>
          </Card>

          {/* Existing Clients Card */}
          <Card className="w-[400px]">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Existing MCP Clients</CardTitle>
                <CardDescription>
                  Manage your connected MCP clients
                </CardDescription>
              </div>
              <Button variant="outline" size="icon" onClick={() => refetch()}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </CardHeader>
            <CardContent>
              {isPending ? (
                <div className="flex justify-center">
                  <svg
                    className="animate-spin h-5 w-5 text-primary"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                </div>
              ) : (
                <MCPClientsList
                  clients={mcpConnectors}
                  onDelete={handleDeleteClient}
                  onRefresh={refetch}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute("/_authenticated/admin/integrations/mcp")({
  beforeLoad: async ({ params, context }) => {
    return params
  },
  loader: async (params) => {
    return params
  },
  component: () => {
    const matches = useRouterState({ select: (s) => s.matches })
    const { user, workspace, agentWhiteList } =
      matches[matches.length - 1].context
    return (
      <MCPClient
        user={user}
        workspace={workspace}
        agentWhiteList={agentWhiteList}
      />
    )
  },
})
