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
  getConnectors,
  minHeight,
} from "@/routes/_authenticated/admin/integrations/google"
import { getErrorMessage } from "@/lib/utils"
import { Sidebar } from "@/components/Sidebar"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useEffect, useState } from "react"
import { Apps, AuthType, ConnectorStatus, UserRole } from "shared/types"
import { wsClient } from "@/api"
import OAuthTab from "@/components/OAuthTab"
import { IntegrationsSidebar } from "@/components/IntegrationsSidebar"
import { OAuthIntegrationStatus } from "@/types"

const logger = console

const UserLayout = ({ user, workspace }: AdminPageProps) => {
  const navigator = useNavigate()
  const { isPending, error, data, refetch } = useQuery<any[]>({
    queryKey: ["all-connectors"],
    queryFn: async (): Promise<any> => {
      try {
        return await getConnectors()
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
      socket = wsClient.ws.$ws({
        query: {
          id: data[0]?.id,
        },
      })
      socket?.addEventListener("open", () => {
        logger.info("open")
      })
      socket?.addEventListener("close", (e) => {
        logger.info("close")
        if (e.reason === "Job finished") {
          setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnected)
        }
      })
      socket?.addEventListener("message", (e) => {
        const data = JSON.parse(e.data)
        setUpateStatus(data.message)
      })
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

  if (error) return "An error has occurred: " + error.message
  return (
    <div className="flex w-full h-full">
      <Sidebar photoLink={user?.photoLink ?? ""} role={user?.role} />
      <IntegrationsSidebar role={user.role} />
      <div className="w-full h-full flex items-center justify-center">
        <div className="flex flex-col h-full items-center justify-center">
          <Tabs
            defaultValue="oauth"
            className={`w-[400px] min-h-[${minHeight}px]`}
          >
            <TabsList className="grid w-full grid-cols-1">
              <TabsTrigger value="oauth">Google OAuth</TabsTrigger>
            </TabsList>

            <OAuthTab
              isPending={isPending}
              oauthIntegrationStatus={oauthIntegrationStatus}
              setOAuthIntegrationStatus={setOAuthIntegrationStatus}
              updateStatus={updateStatus}
              connectorId={
                data?.find(
                  (v) =>
                    v.app === Apps.GoogleDrive && v.authType === AuthType.OAuth,
                )?.id
              }
              refetch={refetch}
            />
          </Tabs>
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
      throw redirect({ to: "/integrations/google" })
    }
    return params
  },
  loader: async (params) => {
    return params
  },
  component: () => {
    const matches = useRouterState({ select: (s) => s.matches })
    const { user, workspace } = matches[matches.length - 1].context
    return <UserLayout user={user} workspace={workspace} />
  },
  errorComponent: errorComponent,
})
