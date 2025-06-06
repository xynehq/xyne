import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { toast, useToast } from "@/hooks/use-toast"
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
import { Square, Pause, Play, X } from "lucide-react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useQuery } from "@tanstack/react-query"
import { OAuthModal } from "@/oauth"
import { ConnectorStatus } from "shared/types"
import { OAuthIntegrationStatus } from "@/types"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { wsClient } from "@/api" // ensure wsClient is imported

export const updateConnectorStatus = async (
  connectorId: string,
  status: ConnectorStatus,
) => {
  const res = await api.admin.connector.update_status.$post({
    form: {
      connectorId,
      status,
    },
  })
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Unauthorized")
    }
    throw new Error("Could not update connector status")
  }
  return res.json()
}

// Delete connector
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

const submitSlackBotToken = async (
  value: { botToken: string },
  navigate: ReturnType<typeof useNavigate>,
) => {
  const response = await api.admin.apikey.create.$post({
    form: {
      apiKey: value.botToken,
      app: Apps.Slack,
    },
  })
  if (!response.ok) {
    if (response.status === 401) {
      navigate({ to: "/auth" })
      throw new Error("Unauthorized")
    }
    const errorText = await response.text()
    throw new Error(
      `Failed to add Slack integration: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }
  return response.json()
}

// Add this function to fetch connectors (similar to Google implementation)
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

export const SlackOAuthButton = ({
  app,
  text,
  setIntegrationStatus,
}: {
  app: Apps
  text: string
  setIntegrationStatus: (status: OAuthIntegrationStatus) => void
}) => {
  const handleOAuth = async () => {
    const oauth = new OAuthModal()
    try {
      await oauth.startAuth(app)
      setIntegrationStatus(OAuthIntegrationStatus.OAuthConnecting)
    } catch (error: any) {
      toast({
        title: "Could not finish Slack OAuth",
        description: `Error: ${error?.message}`,
        variant: "destructive",
      })
    }
  }

  return <Button onClick={handleOAuth}>{text}</Button>
}

interface SlackOAuthTabProps {
  isPending: boolean
  oauthIntegrationStatus: OAuthIntegrationStatus
  setOAuthIntegrationStatus: (status: OAuthIntegrationStatus) => void
  updateStatus: string
  refetch: () => void
  connectAction: ConnectAction
  setConnectAction: (status: ConnectAction) => void
  connector: any
}

const submitSlackOAuth = async (
  value: { clientId: string; clientSecret: string; scopes: string },
  navigate: ReturnType<typeof useNavigate>,
) => {
  const response = await api.admin.oauth.create.$post({
    form: {
      clientId: value.clientId,
      clientSecret: value.clientSecret,
      scopes: value.scopes.split(",").map((s) => s.trim()),
      app: Apps.Slack,
    },
  })
  if (!response.ok) {
    if (response.status === 401) {
      navigate({ to: "/auth" })
      throw new Error("Unauthorized")
    }
    const errorText = await response.text()
    throw new Error(
      `Failed to add Slack integration: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }
  return response.json()
}

export const SlackOAuthForm = ({ onSuccess }: { onSuccess: () => void }) => {
  const { toast } = useToast()
  const navigate = useNavigate()
  const form = useForm<{
    clientId: string
    clientSecret: string
    scopes: string
  }>({
    defaultValues: { clientId: "", clientSecret: "", scopes: "" },
    onSubmit: async ({ value }) => {
      try {
        await submitSlackOAuth(value, navigate)
        toast({
          title: "Slack integration added",
          description: "Bot token accepted. Updating status...",
        })
        onSuccess()
      } catch (error) {
        toast({
          title: "Could not add Slack integration",
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
      <Label htmlFor="clientId">Client Id</Label>
      <form.Field
        name="clientId"
        validators={{
          onChange: ({ value }) =>
            !value ? "Client Id is required" : undefined,
        }}
        children={(field) => (
          <>
            <Input
              id="clientId"
              type="text"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Enter your Client Id"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length
              ? null
              : null}
          </>
        )}
      />
      <Label htmlFor="clientSecret">Client Secret</Label>
      <form.Field
        name="clientSecret"
        validators={{
          onChange: ({ value }) =>
            !value ? "Client secret is required" : undefined,
        }}
        children={(field) => (
          <>
            <Input
              id="clientSecret"
              type="text"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Enter your Client secret"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length
              ? null
              : null}
          </>
        )}
      />
      <Label htmlFor="scopes">Scopes</Label>
      <form.Field
        name="scopes"
        validators={{
          onChange: ({ value }) => (!value ? "scopes is required" : undefined),
        }}
        children={(field) => (
          <>
            <Input
              id="scopes"
              type="text"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Enter your scopes"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length
              ? null
              : null}
          </>
        )}
      />
      <Button type="submit">Add</Button>
    </form>
  )
}

export const SlackBotTokenForm = ({ onSuccess }: { onSuccess: () => void }) => {
  const { toast } = useToast()
  const navigate = useNavigate()
  const form = useForm<{ botToken: string }>({
    defaultValues: { botToken: "" },
    onSubmit: async ({ value }) => {
      try {
        await submitSlackBotToken(value, navigate)
        toast({
          title: "Slack integration added",
          description: "Bot token accepted. Updating status...",
        })
        onSuccess()
      } catch (error) {
        toast({
          title: "Could not add Slack integration",
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
      <Label htmlFor="botToken">Bot Token</Label>
      <form.Field
        name="botToken"
        validators={{
          onChange: ({ value }) =>
            !value ? "Bot Token is required" : undefined,
        }}
        children={(field) => (
          <>
            <Input
              id="botToken"
              type="text"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Enter your Slack Bot Token"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length
              ? null
              : null}
          </>
        )}
      />
      <Button type="submit">Add</Button>
    </form>
  )
}
export interface IntegrationProps {
  user: PublicUser
  workspace: PublicWorkspace
  agentWhiteList: boolean
}

const SlackOAuthTab = ({
  isPending,
  oauthIntegrationStatus,
  setOAuthIntegrationStatus,
  updateStatus,
  refetch,
  connectAction,
  setConnectAction,
  connector,
}: SlackOAuthTabProps) => {
  const handleStatusUpdate = async (
    connectorId: string,
    newStatus: ConnectorStatus,
  ) => {
    try {
      await updateConnectorStatus(connectorId, newStatus)
      toast({
        title: "Status Updated",
        description: `Connector status changed to ${newStatus}`,
      })
      refetch()
    } catch (error) {
      toast({
        title: "Status Update Failed",
        description: getErrorMessage(error),
        variant: "destructive",
      })
    }
  }

  const handleDelete = async (connectorId: string) => {
    try {
      await deleteConnector(connectorId)
      toast({
        title: "Connector Deleted",
        description: "Slack connector has been removed",
      })
      setOAuthIntegrationStatus(OAuthIntegrationStatus.Provider)
      refetch()
    } catch (error) {
      toast({
        title: "Deletion Failed",
        description: getErrorMessage(error),
        variant: "destructive",
      })
    }
  }

  return (
    <TabsContent value="oauth">
      <Card>
        <CardHeader>
          <CardTitle>Slack OAuth</CardTitle>
          <CardDescription>
            Connect with slack to start ingestion
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
          ) : oauthIntegrationStatus === OAuthIntegrationStatus.Provider ? (
            <SlackOAuthForm
              onSuccess={() => {
                refetch()
                setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuth)
              }}
            />
          ) : oauthIntegrationStatus === OAuthIntegrationStatus.OAuth ? (
            <div className="flex flex-col items-center gap-4">
              <SlackOAuthButton
                app={Apps.Slack}
                text="Connect Slack OAuth"
                setIntegrationStatus={setOAuthIntegrationStatus}
              />
            </div>
          ) : oauthIntegrationStatus ===
              OAuthIntegrationStatus.OAuthConnecting ||
            oauthIntegrationStatus === OAuthIntegrationStatus.OAuthPaused ? (
            <div className="flex flex-col items-center gap-4">
              <p>Connecting to Slack...</p>
              <div className="flex items-center gap-2"></div>
              <div className="flex">
                <Square
                  onClick={() => {
                    handleStatusUpdate(
                      connector.id,
                      ConnectorStatus.NotConnected,
                    )
                  }}
                />
                {oauthIntegrationStatus ===
                OAuthIntegrationStatus.OAuthConnecting ? (
                  <Pause
                    onClick={() => {
                      handleStatusUpdate(connector.id, ConnectorStatus.Paused)
                    }}
                  />
                ) : (
                  <Play onClick={() => {}} />
                )}

                <X
                  onClick={() => {
                    handleDelete(connector.id)
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4">
              <p className="text-green-600 font-medium">
                Slack OAuth Connected
              </p>
              <Button variant="outline" onClick={() => refetch()}>
                Refresh Status
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </TabsContent>
  )
}

enum ConnectAction {
  Nil,
  Pause,
  Start,
  Stop,
  Remove,
  Edit,
}

export const Slack = ({
  user,
  workspace,
  agentWhiteList,
}: IntegrationProps) => {
  const navigate = useNavigate()
  const [slackStatus, setSlackStatus] = useState("")
  // @ts-ignore
  const [activeTab, setActiveTab] = useState("oauth")
  const startTimeRef = useRef<number | null>(null)

  const [connectAction, setConnectAction] = useState<ConnectAction>(
    ConnectAction.Nil,
  )

  const [oauthIntegrationStatus, setOAuthIntegrationStatus] =
    useState<OAuthIntegrationStatus>(OAuthIntegrationStatus.Provider)
  const [slackProgress, setSlackProgress] = useState<number>(0)
  const [slackUserStats, setSlackUserStats] = useState<{
    [email: string]: any
  }>({})

  // @ts-ignore
  const { isPending, error, data, refetch } = useQuery<any[]>({
    queryKey: ["all-connectors"],
    queryFn: async (): Promise<any> => {
      try {
        return await getConnectors()
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

  useEffect(() => {
    if (!isPending && data && data.length > 0) {
      const connector = data.find(
        (v) => v.app === Apps.Slack && v.authType === AuthType.OAuth,
      )

      if (connector?.status === ConnectorStatus.Connecting) {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnecting)
      } else if (connector?.status === ConnectorStatus.Connected) {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnected)
      } else if (connector?.status === ConnectorStatus.NotConnected) {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuth)
      } else if (connector?.status === ConnectorStatus.Paused) {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthPaused)
      } else {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.Provider)
      }
    } else {
      setOAuthIntegrationStatus(OAuthIntegrationStatus.Provider)
    }
  }, [data, isPending])

  const slackConnector = data?.find(
    (v) => v.app === Apps.Slack && v.authType === AuthType.OAuth,
  )
  useEffect(() => {
    let socket: WebSocket | null = null
    if (!isPending && data && data.length > 0) {
      // Open a websocket with the first connector id and pass app as Slack
      const slackConnector = data.find(
        (v) => v.app === Apps.Slack && v.authType === AuthType.OAuth,
      )
      if (slackConnector) {
        socket = wsClient.ws.$ws({
          query: {
            id: slackConnector.id,
            app: Apps.Slack,
          },
        })
      }
      socket?.addEventListener("open", () => {
        console.info("Slack socket opened")
      })
      socket?.addEventListener("message", (e) => {
        if (startTimeRef.current === null) {
          startTimeRef.current = Date.now()
        }
        const dataMsg = JSON.parse(e.data)
        const statusJson = JSON.parse(dataMsg.message)
        setSlackProgress(statusJson.progress ?? 0)
        setSlackUserStats(statusJson.userStats ?? {})
      })

      socket?.addEventListener("close", (e) => {
        console.info("Slack WebSocket connection closed", e.reason)
        if (e.reason === "Job finished") {
          setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnected)
        }
      })
      socket?.addEventListener("error", (error) => {
        console.error("WebSocket error:", error)
        toast({
          title: "Connection Error",
          description: "Lost connection to Slack integration service",
          variant: "destructive",
        })
      })
    }
    return () => {
      socket?.close()
    }
  }, [data, isPending])

  // New component: SlackUserStatsTable similar to Google
  const SlackUserStatsTable = ({
    userStats,
    type,
  }: {
    userStats: { [email: string]: any }
    type: AuthType
  }) => {
    const elapsedSeconds = startTimeRef.current
      ? (Date.now() - startTimeRef.current) / 1000
      : 1
    return (
      <Table className="ml-[20px] max-h-[400px]">
        <TableHeader>
          <TableRow>
            {type !== AuthType.OAuth && <TableHead>Email</TableHead>}
            <TableHead>Messages</TableHead>
            <TableHead>Replies</TableHead>
            <TableHead>Conversations</TableHead>
            <TableHead>Users</TableHead>
            <TableHead>msgs / s</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(userStats).map(([email, stats]) => (
            <TableRow key={email}>
              {type !== AuthType.OAuth && (
                <TableCell className={`${stats.done ? "text-lime-600" : ""}`}>
                  {email}
                </TableCell>
              )}
              <TableCell>{stats.slackMessageCount}</TableCell>
              <TableCell>{stats.slackMessageReplyCount}</TableCell>
              <TableCell>{stats.slackConversationCount}</TableCell>
              <TableCell>{stats.slackUserCount}</TableCell>
              <TableCell>
                {(stats.slackMessageCount / elapsedSeconds).toFixed(2)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
  }

  return (
    <div className="flex w-full h-full">
      <Sidebar
        photoLink={user?.photoLink ?? ""}
        role={user?.role}
        isAgentMode={agentWhiteList}
      />
      <IntegrationsSidebar role={user.role} isAgentMode={agentWhiteList} />
      <div className="w-full h-full flex items-center justify-center">
        <div className="flex flex-col h-full items-center justify-center">
          <Tabs
            defaultValue="oauth"
            className="w-[400px] min-h-[320px]"
            onValueChange={setActiveTab}
          >
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="oauth">OAuth</TabsTrigger>
              <TabsTrigger value="bot">Bot Token</TabsTrigger>
              <TabsTrigger value="user">User Token</TabsTrigger>
            </TabsList>

            <TabsContent value="bot">
              <Card>
                <CardHeader>
                  {/* <CardTitle>Slack Bot</CardTitle>
                  <CardDescription>
                    Add your Slack Bot Token to enable integration.
                  </CardDescription> */}
                </CardHeader>
                <CardContent>
                  <SlackBotTokenForm
                    onSuccess={() => setSlackStatus("connecting")}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="user">
              <Card>
                <CardHeader>
                  <CardTitle>Slack App</CardTitle>
                </CardHeader>
                <CardContent></CardContent>
              </Card>
            </TabsContent>
            <SlackOAuthTab
              isPending={isPending}
              oauthIntegrationStatus={oauthIntegrationStatus}
              setOAuthIntegrationStatus={setOAuthIntegrationStatus}
              updateStatus={slackStatus}
              refetch={refetch}
              connectAction={connectAction}
              setConnectAction={setConnectAction}
              connector={slackConnector}
            />
          </Tabs>

          {Object.keys(slackUserStats).length > 0 && (
            <div className="mt-4 w-full">
              <p className="mb-2">
                Slack Integration Progress: {slackProgress}%
              </p>
              <Progress value={slackProgress} className="w-[60%] mb-4" />
              <SlackUserStatsTable
                userStats={slackUserStats}
                type={AuthType.OAuth}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute(
  "/_authenticated/admin/integrations/slack",
)({
  beforeLoad: async ({ params, context }) => {
    // @ts-ignore
    const userWorkspace = context
    // Admins should be redirected to visit /admin/integrations
    // if (
    //   userWorkspace?.user?.role === UserRole.SuperAdmin ||
    //   userWorkspace?.user?.role === UserRole.Admin
    // ) {
    //   throw redirect({ to: '/admin/integrations/' })
    // }
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
      <Slack
        user={user}
        workspace={workspace}
        agentWhiteList={agentWhiteList}
      />
    )
  },
})
