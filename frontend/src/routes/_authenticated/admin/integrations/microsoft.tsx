import { Button } from "@/components/ui/button"
import {
  createFileRoute,
  redirect,
  useNavigate,
  UseNavigateResult,
  useRouterState,
} from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Apps, AuthType, ConnectorStatus, UserRole } from "shared/types"
import { api, wsClient } from "@/api"
import { toast, useToast } from "@/hooks/use-toast"
import { useForm } from "@tanstack/react-form"

import { cn, getErrorMessage } from "@/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { Connectors, OAuthIntegrationStatus } from "@/types"
import { OAuthModal } from "@/oauth"
import { Sidebar } from "@/components/Sidebar"
import { PublicUser, PublicWorkspace } from "shared/types"
import { Progress } from "@/components/ui/progress"
import { errorComponent } from "@/components/error"
import { LoaderContent } from "@/lib/common"
import { IntegrationsSidebar } from "@/components/IntegrationsSidebar"
import { UserStatsTable } from "@/components/ui/userStatsTable"
import { X } from "lucide-react"
import { ConfirmModal } from "@/components/ui/confirmModal"

const logger = console

const submitOAuthForm = async (
  value: OAuthFormData,
  navigate: UseNavigateResult<string>,
  userRole: UserRole,
) => {
  // Role-based API routing
  const isAdmin =
    userRole === UserRole.Admin || userRole === UserRole.SuperAdmin

  const response = isAdmin
    ? await api.admin.oauth.create.$post({
        form: {
          clientId: value.clientId,
          clientSecret: value.clientSecret,
          scopes: value.scopes,
          app: Apps.MicrosoftDrive,
        },
      })
    : await api.oauth.create.$post({
        form: {
          clientId: value.clientId,
          clientSecret: value.clientSecret,
          scopes: value.scopes,
          app: Apps.MicrosoftDrive,
        },
      })

  if (!response.ok) {
    // If unauthorized or status code is 401, navigate to '/auth'
    if (response.status === 401) {
      navigate({ to: "/auth" })
      throw new Error("Unauthorized")
    }
    const errorText = await response.text()
    throw new Error(
      `Failed to create Microsoft integration: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }
  return response.json()
}

type OAuthFormData = {
  clientId: string
  clientSecret: string
  scopes: string[]
}

export const OAuthForm = ({
  onSuccess,
  userRole,
}: { onSuccess: any; userRole: UserRole }) => {
  const { toast } = useToast()
  const navigate = useNavigate()
  const form = useForm<OAuthFormData>({
    defaultValues: {
      clientId: "",
      clientSecret: "",
      scopes: [
        "https://graph.microsoft.com/Files.Read.All",
        "https://graph.microsoft.com/Mail.Read",
        "https://graph.microsoft.com/Calendars.Read",
        "https://graph.microsoft.com/Contacts.Read",
        "https://graph.microsoft.com/User.Read",
        "offline_access",
      ],
    },
    onSubmit: async ({ value }) => {
      try {
        await submitOAuthForm(value, navigate, userRole)
        toast({
          title: "Microsoft OAuth integration added",
          description: "Perform OAuth to add the data",
        })
        onSuccess()
      } catch (error) {
        toast({
          title: "Could not create integration",
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
      className="grid w-full max-w-sm items-center gap-1.5"
    >
      <Label htmlFor="clientId">Client ID</Label>
      <form.Field
        name="clientId"
        validators={{
          onChange: ({ value }) =>
            !value ? "Client ID is required" : undefined,
        }}
        children={(field) => (
          <>
            <Input
              id="clientId"
              type="text"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Enter Microsoft Client ID"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <p className="text-red-600 dark:text-red-400 text-sm">
                {field.state.meta.errors.join(", ")}
              </p>
            ) : null}
          </>
        )}
      />
      <Label htmlFor="clientSecret">Client Secret</Label>
      <form.Field
        name="clientSecret"
        validators={{
          onChange: ({ value }) =>
            !value ? "Client Secret is required" : undefined,
        }}
        children={(field) => (
          <>
            <Input
              id="clientSecret"
              type="password"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Enter Microsoft Client Secret"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <p className="text-red-600 dark:text-red-400 text-sm">
                {field.state.meta.errors.join(", ")}
              </p>
            ) : null}
          </>
        )}
      />
      <Label htmlFor="scopes">Scopes</Label>
      <form.Field
        name="scopes"
        validators={{
          onChange: ({ value }) => (!value ? "Scopes are required" : undefined),
        }}
        children={(field) => (
          <>
            <Input
              id="scopes"
              type="text"
              value={field.state.value.join(",")}
              onChange={(e) => field.handleChange(e.target.value.split(",").map(s => s.trim()))}
              placeholder="Enter Microsoft Graph scopes"
              disabled
            />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Default Microsoft Graph scopes for OneDrive, Outlook, Calendar, and Contacts
            </p>
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <p className="text-red-600 dark:text-red-400 text-sm">
                {field.state.meta.errors.join(", ")}
              </p>
            ) : null}
          </>
        )}
      />

      <Button type="submit">Create Integration</Button>
    </form>
  )
}

export const OAuthButton = ({
  app,
  text,
  setOAuthIntegrationStatus,
}: {
  app: Apps
  text: string
  setOAuthIntegrationStatus: any
}) => {
  const handleOAuth = async () => {
    const oauth = new OAuthModal()
    try {
      await oauth.startAuth(app)
      setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnecting)
    } catch (error: any) {
      toast({
        title: "Could not finish oauth",
        description: `Error: ${error?.message}`,
        variant: "destructive",
      })
    }
  }

  return <Button onClick={handleOAuth}>{text}</Button>
}

export const LoadingSpinner = ({ className }: { className: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("animate-spin", className)}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

export const getConnectors = async (userRole: UserRole): Promise<any> => {
  // Role-based API routing
  const isAdmin =
    userRole === UserRole.Admin || userRole === UserRole.SuperAdmin

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

export const deleteOauthConnector = async (
  connectorId: string,
  userRole: UserRole,
) => {
  // Role-based API routing
  const isAdmin =
    userRole === UserRole.Admin || userRole === UserRole.SuperAdmin

  const res = isAdmin
    ? await api.admin.oauth.connector.delete.$delete({
        form: { connectorId },
      })
    : await api.oauth.connector.delete.$delete({
        form: { connectorId },
      })

  if (!res.ok) {
    let errorText = res.statusText
    try {
      errorText = await res.text()
    } catch (e) {}
    throw new Error(`Failed to delete connector (${res.status}): ${errorText}`)
  }

  try {
    return await res.json()
  } catch (e) {
    console.error("Failed to parse JSON response even though status was OK:", e)
    throw new Error(
      "Received an invalid response from the server after deletion.",
    )
  }
}

const MicrosoftOAuthTab = ({
  isPending,
  oauthIntegrationStatus,
  setOAuthIntegrationStatus,
  updateStatus,
  handleDelete,
  userRole,
}: {
  isPending: boolean
  oauthIntegrationStatus: OAuthIntegrationStatus
  setOAuthIntegrationStatus: (status: OAuthIntegrationStatus) => void
  updateStatus: string
  handleDelete: () => void
  userRole: UserRole
}) => {
  const [modalState, setModalState] = useState<{
    open: boolean
    title: string
    description: string
  }>({ open: false, title: "", description: "" })

  const handleConfirmDelete = () => {
    handleDelete()
    setModalState({ open: false, title: "", description: "" })
  }

  // Adapter function to match ConfirmModal's setShowModal interface
  const handleSetShowModal = (
    value: Partial<{
      open: boolean
      title: string
      description: string
    }>,
  ) => {
    setModalState((prev) => ({
      ...prev,
      ...value,
    }))
  }

  if (isPending) {
    return <LoaderContent />
  }

  if (oauthIntegrationStatus === OAuthIntegrationStatus.Provider) {
    return (
      <OAuthForm
        onSuccess={() =>
          setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuth)
        }
        userRole={userRole}
      />
    )
  }

  if (oauthIntegrationStatus === OAuthIntegrationStatus.OAuth) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Microsoft OAuth</CardTitle>
          <CardDescription>Connect using Microsoft OAuth here.</CardDescription>
        </CardHeader>
        <CardContent>
          <OAuthButton
            app={Apps.MicrosoftDrive}
            setOAuthIntegrationStatus={setOAuthIntegrationStatus}
            text="Connect with Microsoft OAuth"
          />
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Microsoft OAuth</CardTitle>
        </CardHeader>
        <CardContent>
          {oauthIntegrationStatus === OAuthIntegrationStatus.OAuthConnected ? (
            <div className="flex items-center justify-between">
              <span>Connected</span>
              <button
                onClick={() =>
                  handleSetShowModal({
                    open: true,
                    title: "Confirm Disconnect",
                    description:
                      "Are you sure you want to disconnect Microsoft OAuth?",
                  })
                }
                className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            "Connecting"
          )}
        </CardContent>
      </Card>

      <ConfirmModal
        showModal={modalState.open}
        setShowModal={handleSetShowModal}
        modalTitle={modalState.title}
        modalMessage={modalState.description}
        onConfirm={handleConfirmDelete}
      />
    </>
  )
}

export interface AdminPageProps {
  user: PublicUser
  workspace: PublicWorkspace
  agentWhiteList: boolean
}

const AdminLayout = ({ user, workspace, agentWhiteList }: AdminPageProps) => {
  const navigator = useNavigate()
  const { isPending, error, data, refetch } = useQuery<any[]>({
    queryKey: ["all-connectors"],
    queryFn: async (): Promise<any> => {
      try {
        return await getConnectors(user.role)
      } catch (error) {
        const message = getErrorMessage(error)
        if (message === "Unauthorized") {
          navigator({ to: "/auth" })
          return []
        }
        throw error
      }
    },
  })

  const [updateStatus, setUpateStatus] = useState("")
  const [progress, setProgress] = useState<number>(0)
  const [userStats, setUserStats] = useState<{ [email: string]: any }>({})
  const [oauthIntegrationStatus, setOAuthIntegrationStatus] =
    useState<OAuthIntegrationStatus>(
      data
        ? !!data.find(
            (v) => v.app === Apps.MicrosoftDrive && v.authType === AuthType.OAuth,
          )
          ? OAuthIntegrationStatus.OAuth
          : OAuthIntegrationStatus.Provider
        : OAuthIntegrationStatus.Provider,
    )

  useEffect(() => {
    if (!isPending && data && data.length > 0) {
      const connector = data.find(
        (v) => v.app === Apps.MicrosoftDrive && v.authType === AuthType.OAuth,
      )
      if (connector?.status === ConnectorStatus.Connecting) {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnecting)
      } else if (connector?.status === ConnectorStatus.Connected) {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnected)
      } else if (connector?.status === ConnectorStatus.NotConnected) {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuth)
      } else {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.Provider)
      }
    } else {
      setOAuthIntegrationStatus(OAuthIntegrationStatus.Provider)
    }
  }, [data, isPending])

  useEffect(() => {
    let oauthSocket: WebSocket | null = null

    if (!isPending && data && data.length > 0) {
      const oauthConnector = data.find(
        (c) => c.app === Apps.MicrosoftDrive && c.authType === AuthType.OAuth,
      )

      if (oauthConnector) {
        oauthSocket = wsClient.ws.$ws({
          query: { id: oauthConnector.id },
        })
        oauthSocket?.addEventListener("open", () => {
          logger.info(`Microsoft OAuth WebSocket opened for ${oauthConnector.id}`)
        })
        oauthSocket?.addEventListener("message", (e) => {
          const data = JSON.parse(e.data)
          const statusJson = JSON.parse(data.message)
          setProgress(statusJson.progress ?? 0)
          setUserStats(statusJson.userStats ?? {})
          setUpateStatus(data.message)
        })
        oauthSocket?.addEventListener("close", (e) => {
          logger.info("Microsoft OAuth WebSocket closed")
          if (e.reason === "Job finished") {
            setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnected)
          }
        })
      }
    }

    return () => {
      oauthSocket?.close()
    }
  }, [data, isPending])

  useEffect(() => {
    if (oauthIntegrationStatus === OAuthIntegrationStatus.OAuthConnecting) {
      refetch()
    }
  }, [oauthIntegrationStatus, refetch])

  const handleDelete = async () => {
    const microsoftOAuthConnector = data?.find(
      (c: Connectors) =>
        c.app === Apps.MicrosoftDrive && c.authType === AuthType.OAuth,
    )
    if (!microsoftOAuthConnector) {
      toast({
        title: "Deletion Failed",
        description: "Microsoft OAuth connector not found.",
        variant: "destructive",
      })
      return
    }
    try {
      await deleteOauthConnector(microsoftOAuthConnector.id, user.role)
      toast({
        title: "Connector Deleted",
        description: "Microsoft OAuth connector has been removed",
      })
      setOAuthIntegrationStatus(OAuthIntegrationStatus.Provider)
    } catch (error) {
      toast({
        title: "Deletion Failed",
        description: getErrorMessage(error),
        variant: "destructive",
      })
    }
  }

  if (error) return "An error has occurred: " + error.message

  const showUserStats = (
    userStats: { [email: string]: any },
    oauthIntegrationStatus: OAuthIntegrationStatus,
  ) => {
    if (!Object.keys(userStats).length) return false
    return (
      oauthIntegrationStatus === OAuthIntegrationStatus.OAuthConnecting &&
      Object.values(userStats).some((stats) => stats.type === AuthType.OAuth)
    )
  }

  return (
    <div className="flex w-full h-full dark:bg-[#1E1E1E]">
      <Sidebar
        photoLink={user?.photoLink ?? ""}
        role={user?.role}
        isAgentMode={agentWhiteList}
      />
      <IntegrationsSidebar role={user.role} isAgentMode={agentWhiteList} />
      <div className="w-full h-full flex justify-center items-center">
        <div className="flex flex-col items-center w-full max-w-[600px] p-4 justify-center h-full">
          {/* Main content area */}
          <div className="flex flex-col space-y-6 w-full">
            {/* Tab content container - fixed width for forms */}
            <div className="max-w-[400px] mx-auto w-full">
              <Card>
                <CardHeader>
                  <CardTitle>Microsoft Integration</CardTitle>
                  <CardDescription>
                    Connect your Microsoft account to sync OneDrive, Outlook, Calendar, and Contacts
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <MicrosoftOAuthTab
                    isPending={isPending}
                    oauthIntegrationStatus={oauthIntegrationStatus}
                    setOAuthIntegrationStatus={setOAuthIntegrationStatus}
                    updateStatus={updateStatus}
                    handleDelete={handleDelete}
                    userRole={user.role}
                  />
                </CardContent>
              </Card>
            </div>

            {/* OAuth user stats - full width container */}
            {showUserStats(userStats, oauthIntegrationStatus) && (
              <div className="w-full max-w-[600px] mx-auto overflow-x-auto mb-8">
                <h3 className="text-lg font-medium mb-2 dark:text-gray-100">
                  Ingested Users
                </h3>
                <UserStatsTable
                  userStats={userStats}
                  type={AuthType.OAuth}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute(
  "/_authenticated/admin/integrations/microsoft",
)({
  beforeLoad: async ({ params, context }) => {
    const userWorkspace = context
    // Normal users shouldn't be allowed to visit /admin/integrations
    if (
      userWorkspace?.user?.role !== UserRole.SuperAdmin &&
      userWorkspace?.user?.role !== UserRole.Admin
    ) {
      throw redirect({ to: "/admin/integrations/microsoft" })
    }
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
      <AdminLayout
        user={user}
        workspace={workspace}
        agentWhiteList={agentWhiteList}
      />
    )
  },
  errorComponent: errorComponent,
})
