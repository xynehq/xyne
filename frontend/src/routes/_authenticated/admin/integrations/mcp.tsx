import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { useForm } from "@tanstack/react-form"
import { useToast } from "@/hooks/use-toast"
import { useNavigate } from "@tanstack/react-router"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { api } from "@/api"
import { getErrorMessage } from "@/lib/utils"
import { Apps, AuthType } from "shared/types"
import { PublicUser, PublicWorkspace } from "shared/types"
import { Sidebar } from "@/components/Sidebar"
import { IntegrationsSidebar } from "@/components/IntegrationsSidebar"
import { Trash2, RefreshCw } from "lucide-react"

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
import { useQuery } from "@tanstack/react-query"
import { ConnectorStatus } from "shared/types"

// Function to submit the MCP client connector details
const submitMCPClient = async (
  value: { name: string; url: string; apiKey: string },
  navigate: ReturnType<typeof useNavigate>,
) => {
  const response = await api.admin.apikey.mcp.create.$post({
    form: {
      url: value.url,
      apiKey: value.apiKey,
      name: value.name,
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

// MCP Client Form Component
export const MCPClientForm = ({ onSuccess }: { onSuccess: () => void }) => {
  const { toast } = useToast()
  const navigate = useNavigate()
  const form = useForm<{ name: string; url: string; apiKey: string }>({
    defaultValues: { name: "", url: "", apiKey: "" },
    onSubmit: async ({ value }) => {
      try {
        await submitMCPClient(value, navigate)
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
      <Label htmlFor="name" className="mt-2">
        Name
      </Label>
      <form.Field
        name="name"
        validators={{
          onChange: ({ value }) => (!value ? "Name is required" : undefined),
        }}
        children={(field) => (
          <>
            <Input
              id="name"
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

      <Label htmlFor="url">URL</Label>
      <form.Field
        name="url"
        validators={{
          onChange: ({ value }) => (!value ? "URL is required" : undefined),
        }}
        children={(field) => (
          <>
            <Input
              id="url"
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

      <Label htmlFor="apiKey" className="mt-2">
        API Key
      </Label>
      <form.Field
        name="apiKey"
        validators={{
          onChange: ({ value }) => (!value ? "API Key is required" : undefined),
        }}
        children={(field) => (
          <>
            <Input
              id="apiKey"
              type="text"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Enter MCP Client API Key"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <div className="text-red-500 text-sm">
                {field.state.meta.errors[0]}
              </div>
            ) : null}
          </>
        )}
      />

      <Button type="submit" className="mt-4">
        Add MCP Client
      </Button>
    </form>
  )
}

// List of MCP clients
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
            <TableHead>URL</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {clients.map((client) => (
            <TableRow key={client.id}>
              <TableCell className="font-medium">
                {client.config ? client.config.url : null}
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
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex justify-end mt-2">
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCw className="h-4 w-4 mr-2" /> Refresh
        </Button>
      </div>
    </div>
  )
}

// Main MCP component
export const MCPClient = ({
  user,
  workspace,
}: {
  user: PublicUser
  workspace: PublicWorkspace
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

  // Filter MCP client connectors
  const mcpConnectors =
    data?.filter((v) => v.app === Apps.MCP && v.authType === AuthType.ApiKey) ||
    []

  const handleDeleteClient = async (connectorId: string) => {
    await deleteMCPClient(connectorId)
    refetch()
  }

  return (
    <div className="flex w-full h-full">
      <Sidebar photoLink={user?.photoLink ?? ""} role={user?.role} />
      <IntegrationsSidebar role={user.role} />
      <div className="w-full h-full py-8 px-4 overflow-y-auto">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-2xl font-bold mb-6">MCP Client Connectors</h1>

          {/* Add New Client Card */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Add New MCP Client</CardTitle>
              <CardDescription>
                Connect to an MCP client by providing the URL and API key
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
                <MCPClientForm
                  onSuccess={() => {
                    refetch()
                  }}
                />
              )}
            </CardContent>
          </Card>

          {/* Existing Clients Card */}
          <Card>
            <CardHeader>
              <CardTitle>Existing MCP Clients</CardTitle>
              <CardDescription>
                Manage your connected MCP clients
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
    const { user, workspace } = matches[matches.length - 1].context
    return <MCPClient user={user} workspace={workspace} />
  },
})
