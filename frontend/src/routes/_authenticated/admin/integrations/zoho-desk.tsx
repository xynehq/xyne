import { createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router"
import { useState } from "react"
import { useForm } from "@tanstack/react-form"
import { toast, useToast } from "@/hooks/use-toast"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Trash2 } from "lucide-react"
import { api } from "@/api"
import { getErrorMessage } from "@/lib/utils"
import { AuthType, UserRole } from "shared/types"
import { PublicUser, PublicWorkspace } from "shared/types"
import { Sidebar } from "@/components/Sidebar"
import { IntegrationsSidebar } from "@/components/IntegrationsSidebar"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useQuery } from "@tanstack/react-query"

export interface IntegrationProps {
  user: PublicUser
  workspace: PublicWorkspace
  agentWhiteList: boolean
}

// Get connectors helper function
export const getConnectors = async (userRole: UserRole): Promise<any> => {
  const isAdmin = userRole === UserRole.Admin || userRole === UserRole.SuperAdmin

  const res = isAdmin
    ? await api.admin.connectors.all.$get()
    : await api.connectors.all.$get()

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Unauthorized")
    }
    throw new Error("Could not get connectors")
  }
  return res.json()
}

// Delete connector helper
export const deleteConnector = async (connectorId: string) => {
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

interface ZohoDeskFormData {
  refreshToken: string
}

export const ZohoDeskForm = ({
  onSuccess,
  userRole,
}: {
  onSuccess: () => void
  userRole: PublicUser["role"]
}) => {
  const { toast } = useToast()
  const navigate = useNavigate()

  const form = useForm<ZohoDeskFormData>({
    defaultValues: {
      refreshToken: "",
    },
    onSubmit: async ({ value }) => {
      try {
        const payload = {
          authType: AuthType.OAuth,
          refreshToken: value.refreshToken,
        }

        const isAdmin =
          userRole === UserRole.Admin || userRole === UserRole.SuperAdmin

        const response = isAdmin
          ? await api.admin.connector.create.$post({
              json: payload,
            })
          : await api.connector.create.$post({
              json: payload,
            })

        if (!response.ok) {
          if (response.status === 401) {
            navigate({ to: "/auth" })
            throw new Error("Unauthorized")
          }
          const errorText = await response.text()
          throw new Error(
            `Failed to add Zoho Desk integration: ${response.status} ${response.statusText} - ${errorText}`,
          )
        }

        toast({
          title: "Zoho Desk integration added",
          description: "Credentials accepted. Sync will run daily at 2 AM.",
        })
        onSuccess()
      } catch (error) {
        toast({
          title: "Could not add Zoho Desk integration",
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
      className="grid w-full max-w-sm items-center gap-3"
    >
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-2">
        <p className="text-sm text-blue-900 dark:text-blue-100">
          <strong>How to get your refresh token:</strong>
        </p>
        <ol className="text-xs text-blue-800 dark:text-blue-200 mt-2 space-y-1 list-decimal list-inside">
          <li>Run the Zoho refresh token script</li>
          <li>Copy the refresh token from the output</li>
          <li>Paste it below</li>
        </ol>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="refreshToken">Zoho Refresh Token</Label>
        <form.Field
          name="refreshToken"
          validators={{
            onChange: ({ value }) =>
              !value ? "Refresh Token is required" : undefined,
          }}
          children={(field) => (
            <>
              <Input
                id="refreshToken"
                type="password"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="Enter your Zoho Refresh Token"
              />
              {field.state.meta.isTouched && field.state.meta.errors.length ? (
                <p className="text-red-600 dark:text-red-400 text-sm">
                  {field.state.meta.errors.join(", ")}
                </p>
              ) : null}
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Admin account refresh token for automatic access token renewal
              </p>
            </>
          )}
        />
      </div>

      <Button type="submit" className="mt-2">
        Add Zoho Desk Integration
      </Button>
    </form>
  )
}

export const ZohoDesk = ({
  user,
  workspace,
  agentWhiteList,
}: IntegrationProps) => {
  const navigate = useNavigate()
  const [, setZohoDeskStatus] = useState("")
  const [isStartingSyncLoading, setIsStartingSyncLoading] = useState(false)

  const { isPending, data, refetch } = useQuery<any[]>({
    queryKey: ["all-connectors"],
    queryFn: async (): Promise<any> => {
      try {
        return await getConnectors(user.role)
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

  const zohoDeskConnector = data?.find(
    (v) => v.app === "zoho-desk" && v.authType === AuthType.OAuth,
  )

  const handleDeleteConnector = async () => {
    if (!zohoDeskConnector) return

    try {
      await deleteConnector(zohoDeskConnector.id)
      toast({
        title: "Zoho Desk integration removed",
        description: "The integration has been successfully removed.",
      })
      refetch()
    } catch (error) {
      toast({
        title: "Failed to remove integration",
        description: getErrorMessage(error),
        variant: "destructive",
      })
    }
  }

  const handleStartSync = async () => {
    if (!zohoDeskConnector) return

    setIsStartingSyncLoading(true)
    try {
      const response = await api.admin["zoho-desk"].start_sync.$post({
        json: {},
      })

      if (!response.ok) {
        throw new Error(`Failed to start sync: ${response.statusText}`)
      }

      const result = await response.json()
      toast({
        title: "Sync Started",
        description: result.message || "Zoho Desk sync has been triggered successfully.",
      })
    } catch (error) {
      toast({
        title: "Failed to start sync",
        description: getErrorMessage(error),
        variant: "destructive",
      })
    } finally {
      setIsStartingSyncLoading(false)
    }
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
        <div className="flex flex-col h-full items-center justify-center">
          <Card className="w-[500px]">
            <CardHeader>
              <CardTitle>Zoho Desk Integration</CardTitle>
              <CardDescription>
                Configure admin-level Zoho Desk integration. Tickets will be synced
                daily at 2 AM.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isPending ? (
                <div className="flex justify-center py-8">
                  <svg
                    className="animate-spin h-8 w-8 text-primary"
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
              ) : zohoDeskConnector ? (
                <div className="space-y-4">
                  <div className="p-4 border rounded-lg bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium text-green-900 dark:text-green-100">
                          Refresh Token Present
                        </h3>
                        <p className="text-sm text-green-700 dark:text-green-300 mt-1">
                          Status: {zohoDeskConnector.status}
                        </p>
                        <p className="text-sm text-green-700 dark:text-green-300">
                          Daily sync at 2 AM
                        </p>
                      </div>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={handleDeleteConnector}
                      >
                        <Trash2 className="h-4 w-4 mr-1" />
                        Remove
                      </Button>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      onClick={handleStartSync}
                      disabled={isStartingSyncLoading}
                      className="flex-1"
                    >
                      {isStartingSyncLoading ? "Starting..." : "Start Ingestion"}
                    </Button>
                  </div>

                  <div className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                    <p>
                      <strong>Created:</strong>{" "}
                      {new Date(zohoDeskConnector.createdAt).toLocaleString()}
                    </p>
                    <p>
                      <strong>Last Sync:</strong>{" "}
                      {zohoDeskConnector.state?.lastUpdated
                        ? new Date(zohoDeskConnector.state.lastUpdated).toLocaleString()
                        : "Never"}
                    </p>
                  </div>
                </div>
              ) : (
                <ZohoDeskForm
                  onSuccess={() => {
                    setZohoDeskStatus("connected")
                    refetch()
                  }}
                  userRole={user.role}
                />
              )}
            </CardContent>
          </Card>

          {zohoDeskConnector && (
            <div className="mt-6 w-[500px]">
              <Card>
                <CardHeader>
                  <CardTitle>Integration Details</CardTitle>
                  <CardDescription>
                    How the Zoho Desk integration works
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
                  <p>
                    <strong>Sync Schedule:</strong> Daily at 2:00 AM (automatic)
                  </p>
                  <p>
                    <strong>Sync Type:</strong> Incremental (only modified tickets)
                  </p>
                  <p>
                    <strong>Permissions:</strong> Department-based access control
                  </p>
                  <p>
                    <strong>Data Synced:</strong> Tickets, threads, comments, and
                    attachments
                  </p>
                  <p className="mt-4 text-xs">
                    Note: Attachment OCR processing happens asynchronously after sync.
                  </p>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute(
  "/_authenticated/admin/integrations/zoho-desk",
)({
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
      <ZohoDesk
        user={user}
        workspace={workspace}
        agentWhiteList={agentWhiteList}
      />
    )
  },
})
