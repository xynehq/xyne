import { errorComponent } from "@/components/error"
import { useQuery } from "@tanstack/react-query"
import {
  createFileRoute,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router"
import {
  AdminPageProps,
  deleteOauthConnector,
  getConnectors,
  minHeight,
  showUserStats,
} from "@/routes/_authenticated/admin/integrations/google"
import { getErrorMessage } from "@/lib/utils"
import { Sidebar } from "@/components/Sidebar"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useEffect, useState } from "react"
import { Apps, AuthType, ConnectorStatus, UserRole } from "shared/types"
import { wsClient } from "@/api"
import OAuthTab from "@/components/OAuthTab"
import { IntegrationsSidebar } from "@/components/IntegrationsSidebar"
import { UserStatsTable } from "@/components/ui/userStatsTable"
import { Connectors, OAuthIntegrationStatus } from "@/types"
import { toast } from "@/hooks/use-toast"

const logger = console

const UserLayout = ({ user, workspace, agentWhiteList }: AdminPageProps) => {
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

  const [updateStatus, setUpdateStatus] = useState("")
  const [userStats, setUserStats] = useState<{ [email: string]: any }>({})
  const activeTab = "oauth"
  const [oauthIntegrationStatus, setOAuthIntegrationStatus] =
    useState<OAuthIntegrationStatus>(
      data
        ? !!data.find(
            (v) => v.app === Apps.GoogleDrive && v.authType === AuthType.OAuth,
          )
          ? OAuthIntegrationStatus.OAuth
          : OAuthIntegrationStatus.Provider
        : OAuthIntegrationStatus.Provider,
    )

  useEffect(() => {
    if (!isPending && data && data.length > 0) {
      const connector = data.find(
        (v) => v.app === Apps.GoogleDrive && v.authType === AuthType.OAuth,
      )
      if (connector?.status === ConnectorStatus.Connecting) {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnecting)
      } else if (connector?.status === ConnectorStatus.Connected) {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnected)
      } else if (connector?.status === ConnectorStatus.Authenticated) {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthReadyForIngestion)
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
    let socket: WebSocket | null = null
    if (!isPending && data && data.length > 0) {
      const oauthConnector = data.find(
        (c) => c.app === Apps.GoogleDrive && c.authType === AuthType.OAuth,
      )
      if (oauthConnector) {
        socket = wsClient.ws.$ws({
          query: { id: oauthConnector.id },
        })
        socket?.addEventListener("open", () => {
          logger.info(`OAuth WebSocket opened for ${oauthConnector.id}`)
        })
        socket?.addEventListener("message", (e) => {
          const data = JSON.parse(e.data)
          const statusJson = JSON.parse(data.message)
          setUserStats(statusJson.userStats ?? {})
          setUpdateStatus(data.message)
        })
        socket?.addEventListener("close", (e) => {
          logger.info("OAuth WebSocket closed")
          if (e.reason === "Job finished") {
            setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnected)
          }
        })
      }
    }
    return () => {
      socket?.close()
    }
  }, [data, isPending])

  useEffect(() => {
    if (oauthIntegrationStatus === OAuthIntegrationStatus.OAuthConnecting) {
      refetch()
    }
  }, [oauthIntegrationStatus, refetch])

  const handleDelete = async () => {
    const googleOAuthConnector = data?.find(
      (c: Connectors) =>
        c.app === Apps.GoogleDrive && c.authType === AuthType.OAuth,
    )
    if (!googleOAuthConnector) {
      toast({
        title: "Deletion Failed",
        description: "Google OAuth connector not found.",
        variant: "destructive",
      })
      return
    }
    try {
      await deleteOauthConnector(googleOAuthConnector.id, user.role)
      toast({
        title: "Connector Deleted",
        description: "Google OAuth connector has been removed",
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
          <Tabs
            defaultValue="oauth"
            className={`w-[400px] min-h-[${minHeight}px] ${
              Object.keys(userStats).length > 0 ? "mt-[150px]" : ""
            }`}
          >
            <TabsList className="grid w-full grid-cols-1">
              <TabsTrigger value="oauth">Google OAuth</TabsTrigger>
            </TabsList>
            <OAuthTab
              isPending={isPending}
              oauthIntegrationStatus={oauthIntegrationStatus}
              setOAuthIntegrationStatus={setOAuthIntegrationStatus}
              updateStatus={updateStatus}
              handleDelete={handleDelete}
              userRole={user.role}
            />
          </Tabs>
          {showUserStats(userStats, activeTab, oauthIntegrationStatus) && (
            <UserStatsTable userStats={userStats} type={AuthType.OAuth} />
          )}
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute("/_authenticated/integrations/google")({
  beforeLoad: async ({ params, context }) => {
    const userWorkspace = context
    // Admins should be redirected to visit /admin/integrations
    if (
      userWorkspace?.user?.role === UserRole.SuperAdmin ||
      userWorkspace?.user?.role === UserRole.Admin
    ) {
      throw redirect({ to: "/admin/integrations/google" })
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
      <UserLayout
        user={user}
        workspace={workspace}
        agentWhiteList={agentWhiteList}
      />
    )
  },
  errorComponent: errorComponent,
})
