import {
  createFileRoute,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router"
import { useState } from "react"
import { toast } from "@/hooks/use-toast"
import { Button } from "@/components/ui/button"
import { CheckCircle2 } from "lucide-react"
import { api } from "@/api"
import { getErrorMessage } from "@/lib/utils"
import { AuthType, Apps } from "shared/types"
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
import { OAuthModal } from "@/oauth"

export interface IntegrationProps {
  user: PublicUser
  workspace: PublicWorkspace
  agentWhiteList: boolean
}

// Get connectors helper function
export const getConnectors = async (): Promise<any> => {
  const res = await api.connectors.all.$get()

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Unauthorized")
    }
    throw new Error("Could not get connectors")
  }
  return res.json()
}

export const ZohoDeskUserAuth = ({
  user,
  workspace,
  agentWhiteList,
}: IntegrationProps) => {
  const navigate = useNavigate()
  const [isConnecting, setIsConnecting] = useState(false)

  const { isPending, data, refetch } = useQuery<any[]>({
    queryKey: ["user-connectors"],
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

  const zohoDeskConnector = data?.find(
    (v) => v.app === "zoho-desk" && v.authType === AuthType.OAuth,
  )

  const handleOAuth = async () => {
    setIsConnecting(true)
    const oauth = new OAuthModal()
    try {
      // OAuthModal already monitors the popup and resolves when OAuth completes
      await oauth.startAuth("zoho-desk" as Apps)

      // OAuth completed successfully, refetch immediately
      await refetch()

      toast({
        title: "Authentication successful",
        description: "Your Zoho Desk account has been connected successfully.",
      })
      setIsConnecting(false)
    } catch (error: any) {
      toast({
        title: "Could not complete Zoho OAuth",
        description:
          error?.message || "Authentication was cancelled or failed.",
        variant: "destructive",
      })
      setIsConnecting(false)
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
              <CardTitle>Zoho Desk Authentication</CardTitle>
              <CardDescription>
                Authenticate with your Zoho account to access support tickets
                from your department
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
                    <div className="flex items-center gap-3">
                      <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400" />
                      <div>
                        <h3 className="font-medium text-green-900 dark:text-green-100">
                          Authentication Complete
                        </h3>
                        <p className="text-sm text-green-700 dark:text-green-300 mt-1">
                          You can now access Zoho Desk tickets from your
                          department
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="text-sm text-gray-600 dark:text-gray-400 space-y-2">
                    <p>
                      <strong>Status:</strong> {zohoDeskConnector.status}
                    </p>
                    <p>
                      <strong>Connected:</strong>{" "}
                      {new Date(zohoDeskConnector.createdAt).toLocaleString()}
                    </p>
                    {zohoDeskConnector.subject && (
                      <p>
                        <strong>Account:</strong> {zohoDeskConnector.subject}
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                    <p className="text-sm text-blue-900 dark:text-blue-100">
                      <strong>Why authenticate?</strong>
                    </p>
                    <ul className="text-xs text-blue-800 dark:text-blue-200 mt-2 space-y-1 list-disc list-inside">
                      <li>Access support tickets from your department</li>
                      <li>View ticket history and details</li>
                      <li>Search across your department's tickets</li>
                    </ul>
                  </div>

                  <Button
                    onClick={handleOAuth}
                    disabled={isConnecting}
                    className="w-full"
                  >
                    {isConnecting ? "Connecting..." : "Connect Zoho Account"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {zohoDeskConnector && (
            <div className="mt-6 w-[500px]">
              <Card>
                <CardHeader>
                  <CardTitle>How It Works</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
                  <p>
                    <strong>Access Control:</strong> You can only see tickets
                    from your department
                  </p>
                  <p>
                    <strong>Data Sync:</strong> Tickets are synced daily by the
                    admin
                  </p>
                  <p>
                    <strong>Search:</strong> Use the chat interface to search
                    tickets
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

export const Route = createFileRoute("/_authenticated/integrations/zoho-desk")({
  beforeLoad: async ({ params }) => {
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
      <ZohoDeskUserAuth
        user={user}
        workspace={workspace}
        agentWhiteList={agentWhiteList}
      />
    )
  },
})
