import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { useEffect, useRef, useState, useCallback } from "react"
import { useForm } from "@tanstack/react-form"
import { toast, useToast } from "@/hooks/use-toast"
import { useNavigate } from "@tanstack/react-router"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Pencil, ArrowLeft, Square, RotateCcw, Pause, Play, RefreshCw } from "lucide-react"
import { api, wsClient } from "@/api"
import { getErrorMessage } from "@/lib/utils"
import { Apps, AuthType, IngestionType, UserRole } from "shared/types"
import { PublicUser, PublicWorkspace } from "shared/types"
import { Sidebar } from "@/components/Sidebar"
import { IntegrationsSidebar } from "@/components/IntegrationsSidebar"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Progress } from "@/components/ui/progress"
// Define ingestion status type locally to avoid importing from server schema
type DbIngestionStatus = "started" | "in_progress" | "completed" | "failed" | "cancelled" | "paused"

// Slack-specific metadata structure matching backend response
interface SlackIngestionMetadata {
  slack?: {
    websocketData?: {
      progress?: {
        totalChannels: number;
        processedChannels: number;
        currentChannel: string;
        totalMessages: number;
        processedMessages: number;
      };
      connectorId?: string;
    };
    ingestionState?: {
      endDate?: string;
      startDate?: string;
      lastUpdated: string;
      channelsToIngest?: string[];
      currentChannelId?: string;
      includeBotMessage?: boolean;
      currentChannelIndex?: number;
      lastMessageTimestamp?: string;
    };
  };
}

// Complete ingestion object matching backend response
interface IngestionData {
  id: number;
  userId: number;
  connectorId: number;
  workspaceId: number;
  status: DbIngestionStatus;
  metadata: SlackIngestionMetadata;
  errorMessage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// Main response type matching backend API response
interface IngestionStatusResponse {
  success: boolean;
  hasActiveIngestion: boolean;
  ingestion?: IngestionData;
}

// Frontend-specific progress data structure for UI display
interface ProgressData {
  totalChannels?: number;
  processedChannels?: number;
  currentChannel?: string;
  totalMessages?: number;
  processedMessages?: number;
}



// Helper function to safely extract progress data from ingestion metadata
const getProgressData = (ingestion: IngestionData): ProgressData => {
  // Try to get progress from multiple sources
  const progress = ingestion.metadata?.slack?.websocketData?.progress;
  const state = ingestion.metadata?.slack?.ingestionState;
  
  return {
    totalChannels: progress?.totalChannels,
    processedChannels: progress?.processedChannels,
    currentChannel: progress?.currentChannel,
    totalMessages: progress?.totalMessages,
    processedMessages: progress?.processedMessages,
    // Fallback to state data if progress is not available
    ...(!progress && state && {
      totalChannels: state.channelsToIngest?.length,
      processedChannels: state.currentChannelIndex,
    })
  };
}

export const updateConnectorStatus = async (
  connectorId: string,
  status: ConnectorStatus,
  userRole: PublicUser["role"],
) => {
  // Role-based API routing
  const isAdmin =
    userRole === UserRole.Admin || userRole === UserRole.SuperAdmin

  const res = isAdmin
    ? await api.admin.connector.update_status.$post({
        form: {
          connectorId,
          status,
        },
      })
    : await api.connector.update_status.$post({
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

export const SlackOAuthButton = ({
  app,
  text,
  setIntegrationStatus,
  className,
}: {
  app: Apps
  text: string
  setIntegrationStatus: (status: OAuthIntegrationStatus) => void
  className?: string
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

  return (
    <Button type="button" onClick={handleOAuth} className={className}>
      {text}
    </Button>
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

type ManualIngestionFormData = {
  channelIds: string
  startDate: string
  endDate: string
  includeBotMessage: boolean
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
  handleRegularIngestion: () => Promise<void>
  isManualIngestionActive: boolean
  isRegularIngestionActive: boolean
  userRole: PublicUser["role"]
}

enum OAuthFormMode {
  UseGlobal,
  ProvideOwn,
}

export const SlackOAuthForm = ({
  onSuccess,
  userRole,
  mode,
}: {
  onSuccess: () => void
  userRole: PublicUser["role"]
  mode: OAuthFormMode
}) => {
  const { toast } = useToast()
  const navigate = useNavigate()
  const isUsingGlobal = mode === OAuthFormMode.UseGlobal

  const form = useForm<{
    clientId: string
    clientSecret: string
    scopes: string
    isGlobalProvider: boolean
  }>({
    defaultValues: {
      clientId: "",
      clientSecret: "",
      scopes: "",
      isGlobalProvider: false,
    }, // Default isGlobalProvider to false
    onSubmit: async ({ value }) => {
      try {
        const payload: any = { app: Apps.Slack }

        if (isUsingGlobal) {
          payload.isUsingGlobalCred = true
          // No other fields needed for global creds in the payload
        } else {
          payload.isUsingGlobalCred = false
          payload.clientId = value.clientId
          payload.clientSecret = value.clientSecret
          payload.scopes = value.scopes.split(",").map((s) => s.trim())
          payload.isGlobalProvider = value.isGlobalProvider // Send checkbox value when providing own
        }
        // Role-based API routing
        const isAdmin =
          userRole === UserRole.Admin || userRole === UserRole.SuperAdmin

        const response = isAdmin
          ? await api.admin.oauth.create.$post({
              form: payload,
            })
          : await api.oauth.create.$post({
              form: payload,
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
        toast({
          title: "Slack integration added",
          description: "Credentials accepted. Updating status...",
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
      {!isUsingGlobal && (
        <>
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
                {field.state.meta.isTouched &&
                field.state.meta.errors.length ? (
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
                {field.state.meta.isTouched &&
                field.state.meta.errors.length ? (
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
              onChange: ({ value }) =>
                !value ? "scopes is required" : undefined,
            }}
            children={(field) => (
              <>
                <Input
                  id="scopes"
                  type="text"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="Enter your scopes (comma-separated)"
                />
                {field.state.meta.isTouched &&
                field.state.meta.errors.length ? (
                  <p className="text-red-600 dark:text-red-400 text-sm">
                    {field.state.meta.errors.join(", ")}
                  </p>
                ) : null}
              </>
            )}
          />
        </>
      )}

      <Button type="submit">{isUsingGlobal ? "Connect" : "Add"}</Button>

      {!isUsingGlobal &&
        (userRole === "admin" || userRole === "SuperAdmin") && (
          <div className="flex items-center space-x-2 mt-4">
            <form.Field
              name="isGlobalProvider"
              children={(field) => (
                <input
                  type="checkbox"
                  id="isGlobalProvider"
                  checked={field.state.value}
                  onChange={(e) => field.handleChange(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
              )}
            />
            <Label
              htmlFor="isGlobalProvider"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Use this as Global OAuth Provider
            </Label>
          </div>
        )}
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
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <p className="text-red-600 dark:text-red-400 text-sm">
                {field.state.meta.errors.join(", ")}
              </p>
            ) : null}
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
  handleRegularIngestion,
  isManualIngestionActive,
  isRegularIngestionActive,
  userRole,
}: SlackOAuthTabProps) => {
  const { toast } = useToast() // Get toast hook
  const [isEditingGlobalCreds, setIsEditingGlobalCreds] = useState(false)
  const [formMode, setFormMode] = useState<OAuthFormMode>(
    OAuthFormMode.ProvideOwn,
  ) // State to control form mode
  const [isConnectingGlobal, setIsConnectingGlobal] = useState(false) // State for global connect loading

  // Use useQuery to fetch global provider status
  const { data: globalProviderStatus, isLoading: isLoadingGlobalProvider } =
    useQuery({
      queryKey: ["global-slack-provider"],
      queryFn: async () => {
        // Role-based API routing
        const isAdmin =
          userRole === UserRole.Admin || userRole === UserRole.SuperAdmin

        const res = isAdmin
          ? await api.admin.oauth["global-slack-provider"].$get()
          : await api.oauth["global-slack-provider"].$get()

        if (!res.ok) {
          // Handle error, maybe log it or show a toast
          toast({
            title: "Failed to check global provider",
            description: "Could not verify global Slack provider status",
            variant: "destructive",
          })
          return { exists: false } // Assume no global provider on error
        }
        return res.json()
      },
    })

  const hasGlobalProvider = globalProviderStatus?.exists ?? false

  const handleConnectGlobalOAuth = async () => {
    setIsConnectingGlobal(true)
    try {
      const payload = {
        isUsingGlobalCred: true,
        app: Apps.Slack,
      }
      // Role-based API routing
      const isAdmin =
        userRole === UserRole.Admin || userRole === UserRole.SuperAdmin

      const response = isAdmin
        ? await api.admin.oauth.create.$post({
            form: payload,
          })
        : await api.oauth.create.$post({
            form: payload,
          })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `Failed to connect using global credentials: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }
      toast({
        title: "Global credentials connected",
        description: "Provider created. Updating status...",
      })
      refetch() // Refetch connectors to update status
    } catch (error) {
      toast({
        title: "Could not connect using global credentials",
        description: `Error: ${getErrorMessage(error)}`,
        variant: "destructive",
      })
    } finally {
      setIsConnectingGlobal(false)
    }
  }

  const connectButtonText =
    connector?.isGlobal === false
      ? "Connect Slack Global OAuth"
      : "Connect Slack OAuth"

  return (
    <TabsContent value="oauth">
      <Card>
        <CardHeader>
          {isEditingGlobalCreds ? (
            <div className="flex items-center">
              <div
                onClick={() => setIsEditingGlobalCreds(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    setIsEditingGlobalCreds(false)
                }}
                role="button"
                tabIndex={0}
                aria-label="Back"
                className="mr-2 p-1 cursor-pointer rounded-md hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <ArrowLeft className="h-4 w-4" />
              </div>
              <CardTitle>Slack OAuth</CardTitle>
            </div>
          ) : (
            <CardTitle>Slack OAuth</CardTitle>
          )}
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
          ) : isEditingGlobalCreds ? (
            <>
              <SlackOAuthForm
                onSuccess={() => {
                  refetch() // This should update oauthIntegrationStatus
                  setIsEditingGlobalCreds(false) // Hide form after successful submission
                  // After submitting credentials, the state should ideally become OAuthIntegrationStatus.OAuth
                  // setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuth) // This might be set by refetch
                }}
                userRole={userRole}
                mode={formMode} // Pass the form mode
              />
            </>
          ) : oauthIntegrationStatus === OAuthIntegrationStatus.OAuth ? (
            // If provider is set up but not connected, show the Connect button
            <SlackOAuthButton
              app={Apps.Slack} // Assuming Apps.Slack is the correct app enum value
              text={connectButtonText} // Use dynamic text
              setIntegrationStatus={setOAuthIntegrationStatus}
              className="w-full"
            />
          ) : oauthIntegrationStatus === OAuthIntegrationStatus.Provider ||
            oauthIntegrationStatus === OAuthIntegrationStatus.OAuthPaused ? (
            // If no provider is set up or paused, show options to set up
            <div className="space-y-4">
              {isLoadingGlobalProvider ? (
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
                  <span className="ml-2">Checking for global provider...</span>
                </div>
              ) : hasGlobalProvider ? (
                <div className="flex items-center justify-between">
                  <Button
                    onClick={handleConnectGlobalOAuth} // Call the new handler
                    disabled={isConnectingGlobal} // Disable while connecting
                    className="flex-1 mr-2 text-sm"
                  >
                    {isConnectingGlobal
                      ? "Connecting..."
                      : "Connect using global credentials"}{" "}
                    {/* Dynamic text */}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setIsEditingGlobalCreds(true)
                      setFormMode(OAuthFormMode.ProvideOwn) // Set mode to ProvideOwn
                    }}
                    aria-label="Edit Credentials"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    No global provider found. Please use your own credentials.
                  </p>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setIsEditingGlobalCreds(true)
                      setFormMode(OAuthFormMode.ProvideOwn) // Set mode to ProvideOwn
                    }}
                    aria-label="Add Credentials"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          ) : oauthIntegrationStatus === OAuthIntegrationStatus.OAuthReadyForIngestion ? (
            // If OAuth completed and ready for ingestion, show the Start Ingestion button
            <div className="space-y-2">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                OAuth authentication completed. Ready to start data ingestion.
              </p>
              <Button
                onClick={handleRegularIngestion}
                disabled={isRegularIngestionActive}
                className="w-full"
              >
                {isRegularIngestionActive ? "Starting..." : "Start Ingestion"}
              </Button>
            </div>
          ) : oauthIntegrationStatus ===
              OAuthIntegrationStatus.OAuthConnected ? (
            // If connected, show the Start Ingestion button
            <Button
              onClick={handleRegularIngestion}
              disabled={isRegularIngestionActive}
            >
              {isRegularIngestionActive ? "Ingesting..." : "Start Ingestion"}
            </Button>
          ) : oauthIntegrationStatus ===
              OAuthIntegrationStatus.OAuthConnecting ? (
            // If connecting, show connecting status (same as Google)
            "Connecting"
          ) : null}
        </CardContent>
      </Card>
    </TabsContent>
  )
}

export const Slack = ({
  user,
  workspace,
  agentWhiteList,
}: IntegrationProps) => {
  const navigate = useNavigate()
  const [slackStatus, setSlackStatus] = useState("")
  const [, setActiveTab] = useState("oauth")
  const startTimeRef = useRef<number | null>(null)

  const [connectAction, setConnectAction] = useState<ConnectAction>(
    ConnectAction.Nil,
  )

  const [oauthIntegrationStatus, setOAuthIntegrationStatus] =
    useState<OAuthIntegrationStatus>(OAuthIntegrationStatus.Provider)
  const [slackProgress, setSlackProgress] = useState<number>(0)
  const [, setSlackUserStats] = useState<{
    [email: string]: any
  }>({})
  const [slackUserNormalIngestionStats, setSlackUserNormalIngestionStats] =
    useState<{
      [email: string]: any
    }>({})
  const [slackUserPartialIngestionStats, setSlackUserPartialIngestionStats] =
    useState<{
      [email: string]: any
    }>({})
  const [, setIngestionType] = useState<IngestionType>(
    IngestionType.fullIngestion,
  )
  const [isManualIngestionActive, setIsManualIngestionActive] = useState(false)
  const [isRegularIngestionActive, setIsRegularIngestionActive] =
    useState(false)

  // Enhanced ingestion management state
  const [ingestionStatus, setIngestionStatus] = useState<IngestionStatusResponse | null>(null)
  const [ingestionLoading, setIngestionLoading] = useState(true)
  const [ingestionError, setIngestionError] = useState<string | null>(null)
  
  // Refs for polling management
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const previousStatusRef = useRef<string | undefined>()
  const isFetchingRef = useRef<boolean>(false)

  // Simple polling functions for ingestion status
  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);

  const fetchIngestionStatus = useCallback(async (connectorId: string) => {
    // Prevent concurrent calls
    if (isFetchingRef.current) {
      return;
    }
    
    isFetchingRef.current = true;
    try {
      setIngestionError(null);
      
      const response = await api.ingestion.status.$get({
        query: { connectorId }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch ingestion status');
      }

      const data = await response.json();
      const currentStatus = data.ingestion?.status;
      
      // Show notifications for status changes (but not on initial page load)
      if (currentStatus !== previousStatusRef.current) {
        const isInitialLoad = previousStatusRef.current === undefined;
        previousStatusRef.current = currentStatus;
        
        // Only show completion toast for fresh completions, not on page refresh/load
        if (currentStatus === 'completed' && !isInitialLoad) {
          toast({
            title: "Ingestion Completed",
            description: "Slack channel ingestion has finished successfully!",
            duration: 10000,
          });
          stopPolling();
        } else if (currentStatus === 'failed') {
          toast({
            title: "Ingestion Failed", 
            description: data.ingestion?.errorMessage || "Ingestion failed with an unknown error",
            variant: "destructive",
            duration: 10000,
          });
          stopPolling();
        } else if (currentStatus === 'cancelled' && !isInitialLoad) {
          toast({
            title: "Ingestion Cancelled",
            description: "Ingestion was cancelled by user",
            duration: 10000,
          });
          stopPolling();
        }
      }

      // Start/stop polling based on status - Fixed: More explicit status checking to avoid empty string issues
      const shouldPoll = data.hasActiveIngestion && 
                        data.ingestion?.status && 
                        ['pending', 'in_progress'].includes(data.ingestion.status);
      
      
      // Fixed: Use ref to check current polling state instead of potentially stale state
      const isCurrentlyPolling = pollingIntervalRef.current !== null;
      
      if (shouldPoll && !isCurrentlyPolling) {
        // Always clear any existing interval first to prevent duplicates
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
        }
        // Fixed: Capture connectorId in closure to avoid stale values
        const currentConnectorId = connectorId;
        pollingIntervalRef.current = setInterval(() => {
          fetchIngestionStatus(currentConnectorId);
        }, 10000); // Poll every 10 seconds
      } else if (!shouldPoll && isCurrentlyPolling) {
        stopPolling();
      } else if (!shouldPoll && pollingIntervalRef.current) {
        // Force stop polling even if isPolling state is wrong
        stopPolling();
      }
      
      setIngestionStatus(data);
      setIngestionLoading(false);
      
      return data;
    } catch (err) {
      setIngestionError(getErrorMessage(err));
      setIngestionLoading(false);
      stopPolling();
      throw err;
    } finally {
      isFetchingRef.current = false;
    }
  }, [stopPolling]); // Fixed: Removed isPolling from dependencies to avoid stale closure issues

  // Enhanced start ingestion function
  const startChannelIngestion = useCallback(async (connectorId: string, channelsToIngest: string[], startDate: string, endDate: string, includeBotMessage: boolean) => {
    try {
      setIsManualIngestionActive(true);
      
      const isAdmin = user.role === UserRole.Admin || user.role === UserRole.SuperAdmin;
      const response = isAdmin
        ? await api.admin.slack.ingest_more_channel.$post({
            json: { connectorId, channelsToIngest, startDate, endDate, includeBotMessage },
          })
        : await api.slack.ingest_more_channel.$post({
            json: { connectorId, channelsToIngest, startDate, endDate, includeBotMessage },
          });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText);
      }

      toast({
        title: "Ingestion Started",
        description: "Slack channel ingestion has been initiated successfully.",
        duration: 20000,
      });
      
      // Refresh status and start polling
      await fetchIngestionStatus(connectorId);
    } catch (err) {
      toast({
        title: "Failed to Start Ingestion",
        description: getErrorMessage(err),
        variant: "destructive",
        duration: 20000,
      });
      throw err;
    } finally {
      setIsManualIngestionActive(false);
    }
  }, [user.role, fetchIngestionStatus]); // Fixed: Include fetchIngestionStatus in dependencies

  // Resume ingestion function
  const resumeIngestion = useCallback(async (ingestionId: number, connectorId: string) => {
    try {
      const response = await api.ingestion.resume.$post({
        json: { ingestionId: ingestionId.toString() }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || 'Failed to resume ingestion');
      }

      toast({
        title: "Ingestion Resumed",
        description: "Ingestion has been resumed from where it left off.",
        duration: 20000,
      });
      
      await fetchIngestionStatus(connectorId);
    } catch (err) {
      toast({
        title: "Failed to Resume Ingestion",
        description: getErrorMessage(err),
        variant: "destructive",
        duration: 20000,
      });
      throw err;
    }
  }, [fetchIngestionStatus]); // Fixed: Include fetchIngestionStatus in dependencies

  // Cancel ingestion function
  const cancelIngestion = useCallback(async (ingestionId: number, connectorId: string) => {
    try {
      const response = await api.ingestion.cancel.$post({
        json: { ingestionId: ingestionId.toString() }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || 'Failed to cancel ingestion');
      }

      toast({
        title: "Ingestion Cancelled",
        description: "Ingestion is being cancelled...",
        duration: 20000,
      });
      
      // Force stop polling before checking status
      stopPolling();
      await fetchIngestionStatus(connectorId);
    } catch (err) {
      toast({
        title: "Failed to Cancel Ingestion",
        description: getErrorMessage(err),
        variant: "destructive",
        duration: 20000,
      });
      throw err;
    }
  }, [stopPolling, fetchIngestionStatus]); // Fixed: Include dependencies

  // Pause ingestion function
  const pauseIngestion = useCallback(async (ingestionId: number, connectorId: string) => {
    try {
      const response = await api.ingestion.pause.$post({
        json: { ingestionId: ingestionId.toString() }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || 'Failed to pause ingestion');
      }

      toast({
        title: "Ingestion Paused",
        description: "Ingestion has been paused and can be resumed later.",
        duration: 20000,
      });
      
      // Force stop polling before checking status
      stopPolling();
      await fetchIngestionStatus(connectorId);
    } catch (err) {
      toast({
        title: "Failed to Pause Ingestion",
        description: getErrorMessage(err),
        variant: "destructive",
        duration: 20000,
      });
      throw err;
    }
  }, [stopPolling, fetchIngestionStatus]); // Fixed: Include dependencies


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

  useEffect(() => {
    if (!isPending && data && data.length > 0) {
      const connector = data.find(
        (v) => v.app === Apps.Slack && v.authType === AuthType.OAuth,
      )

      if (connector?.status === ConnectorStatus.Connecting) {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnecting)
      } else if (connector?.status === ConnectorStatus.Connected) {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnected)
      } else if (connector?.status === ConnectorStatus.Authenticated) {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthReadyForIngestion)
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

  // Initialize ingestion status checking when connector is available
  useEffect(() => {
    if (slackConnector?.cId) {
      fetchIngestionStatus(slackConnector.cId.toString());
    }
  }, [slackConnector?.cId, fetchIngestionStatus]); // Fixed: Include fetchIngestionStatus in dependencies

  // Cleanup polling on component unmount
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  useEffect(() => {
    let socket: WebSocket | null = null
    if (!isPending && data && data.length > 0) {
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
        if (statusJson.IngestionType) {
          if (statusJson.IngestionType === IngestionType.fullIngestion)
            setSlackUserNormalIngestionStats((prevStats) => {
              if (
                statusJson.userStats &&
                Object.keys(statusJson.userStats).length > 0
              ) {
                return statusJson.userStats
              }
              return Object.keys(prevStats).length > 0 ? prevStats : {}
            })
          else
            setSlackUserPartialIngestionStats((prevStats) => {
              if (
                statusJson.userStats &&
                Object.keys(statusJson.userStats).length > 0
              ) {
                return statusJson.userStats
              }
              return Object.keys(prevStats).length > 0 ? prevStats : {}
            })
        }
        setSlackUserStats((prevStats) => {
          // If new userStats are provided and are not empty, update the state.
          if (
            statusJson.userStats &&
            Object.keys(statusJson.userStats).length > 0
          ) {
            return statusJson.userStats
          }
          // Otherwise, if new userStats are empty or missing,
          // keep the previous stats if they already had data.
          // If previous stats were also empty, then return an empty object.
          return Object.keys(prevStats).length > 0 ? prevStats : {}
        })
        setIngestionType(
          statusJson.IngestionType ?? IngestionType.fullIngestion,
        )
      })

      socket?.addEventListener("close", (e) => {
        console.info("Slack WebSocket connection closed", e.reason)
        if (e.reason === "Job finished") {
          setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnected)
          setIsRegularIngestionActive(false)
        }
      })
      socket?.addEventListener("error", (error) => {
        console.error("WebSocket error:", error)
        toast({
          title: "Connection Error",
          description: "Lost connection to Slack integration service",
          variant: "destructive",
        })
        setIsRegularIngestionActive(false)
      })
    }
    return () => {
      socket?.close()
    }
  }, [data, isPending])

  const handleRegularIngestion = async () => {
    if (!slackConnector?.cId) {
      toast({
        title: "Slack connector not found",
        description: "Please ensure Slack is connected.",
        variant: "destructive",
      })
      return
    }

    setIsRegularIngestionActive(true)
    try {
      // Role-based API routing
      const isAdmin =
        user.role === UserRole.Admin || user.role === UserRole.SuperAdmin

      const response = isAdmin
        ? await api.admin.slack.start_ingestion.$post({
            json: {
              connectorId: slackConnector.cId,
            },
          })
        : await api.slack.start_ingestion.$post({
            json: {
              connectorId: slackConnector.cId,
            },
          })

      if (!response.ok) {
        const errorText = await response.text()
        toast({
          title: "Regular Ingestion Failed",
          description: `Error: ${errorText}`,
          variant: "destructive",
        })
        setIsRegularIngestionActive(false)
        return
      }

      toast({
        title: "Regular Ingestion Started",
        description: "Regular ingestion process initiated successfully.",
      })
    } catch (error) {
      toast({
        title: "An error occurred",
        description: `Error: ${getErrorMessage(error)}`,
        variant: "destructive",
      })
      setIsRegularIngestionActive(false)
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
                <CardHeader></CardHeader>
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
              handleRegularIngestion={handleRegularIngestion}
              isManualIngestionActive={isManualIngestionActive}
              isRegularIngestionActive={isRegularIngestionActive}
              userRole={user.role}
            />
          </Tabs>

          {Object.keys(slackUserNormalIngestionStats).length > 0 && (
            <div className="mt-4 w-full">
              <p className="mb-2 dark:text-gray-300">
                Slack Integration Progress
              </p>
              {/* <Progress value={slackProgress} className="w-[60%] mb-4" /> */}
              <SlackUserStatsTable
                userStats={slackUserNormalIngestionStats}
                type={AuthType.OAuth}
              />
            </div>
          )}

          {/* Accordion for Manual Ingestion */}
          <Accordion type="single" collapsible className="w-full mt-4">
            <AccordionItem value="manual-ingestion">
              <AccordionTrigger>Manual Ingestion</AccordionTrigger>
              <AccordionContent>
                {oauthIntegrationStatus ===
                  OAuthIntegrationStatus.OAuthConnecting ||
                oauthIntegrationStatus ===
                  OAuthIntegrationStatus.OAuthConnected ||
                oauthIntegrationStatus ===
                  OAuthIntegrationStatus.OAuthReadyForIngestion ? (
                  <ManualIngestionForm
                    connectorId={slackConnector?.cId}
                    isManualIngestionActive={isManualIngestionActive}
                    setIsManualIngestionActive={setIsManualIngestionActive}
                    slackProgress={slackProgress}
                    slackUserStats={slackUserPartialIngestionStats}
                    userRole={user.role}
                    ingestionStatus={ingestionStatus}
                    ingestionLoading={ingestionLoading}
                    ingestionError={ingestionError}
                    startChannelIngestion={startChannelIngestion}
                    resumeIngestion={resumeIngestion}
                    pauseIngestion={pauseIngestion}
                    cancelIngestion={cancelIngestion}
                    fetchIngestionStatus={fetchIngestionStatus}
                  />
                ) : (
                  <p>Please connect Slack OAuth to enable manual ingestion.</p>
                )}
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          {/* Show manual ingestion stats - always show if there's data */}
          {Object.keys(slackUserPartialIngestionStats).length > 0 && (
            <div className="mt-4 w-full">
              <p className="mb-2">Manual Ingestion Progress</p>
              {/* <Progress value={slackProgress} className="w-[60%] mb-4" /> */}
              <SlackUserStatsTable
                userStats={slackUserPartialIngestionStats}
                type={AuthType.OAuth}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const SlackUserStatsTable = ({
  userStats,
  type,
}: {
  userStats: { [email: string]: any }
  type: AuthType
}) => {
  const startTimeRef = useRef<number | null>(null)
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

export const Route = createFileRoute(
  "/_authenticated/admin/integrations/slack",
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
      <Slack
        user={user}
        workspace={workspace}
        agentWhiteList={agentWhiteList}
      />
    )
  },
})

interface ManualIngestionFormProps {
  connectorId: string | undefined
  isManualIngestionActive: boolean
  setIsManualIngestionActive: (active: boolean) => void
  slackProgress: number
  slackUserStats: { [email: string]: any }
  userRole: PublicUser["role"]
  // Enhanced ingestion management props
  ingestionStatus: IngestionStatusResponse | null
  ingestionLoading: boolean
  ingestionError: string | null
  startChannelIngestion: (connectorId: string, channelsToIngest: string[], startDate: string, endDate: string, includeBotMessage: boolean) => Promise<void>
  resumeIngestion: (ingestionId: number, connectorId: string) => Promise<void>
  pauseIngestion: (ingestionId: number, connectorId: string) => Promise<void>
  cancelIngestion: (ingestionId: number, connectorId: string) => Promise<void>
  fetchIngestionStatus: (connectorId: string) => Promise<void>
}

const ManualIngestionForm = ({
  connectorId,
  isManualIngestionActive,
  setIsManualIngestionActive,
  slackProgress,
  slackUserStats,
  userRole,
  // Enhanced ingestion management props
  ingestionStatus,
  ingestionLoading,
  ingestionError,
  startChannelIngestion,
  resumeIngestion,
  pauseIngestion,
  cancelIngestion,
  fetchIngestionStatus,
}: ManualIngestionFormProps) => {
  const { toast } = useToast()
  // const startTimeRef = useRef<number | null>(null)

  const form = useForm<ManualIngestionFormData>({
    defaultValues: { channelIds: "", startDate: "", endDate: "", includeBotMessage: false },
    onSubmit: async ({ value }) => {
      if (!connectorId) {
        toast({
          title: "Slack connector not found",
          description: "Please ensure Slack is connected.",
          variant: "destructive",
        })
        return
      }

      try {
        const channelIdsList = value.channelIds
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0)

        if (channelIdsList.length === 0) {
          toast({
            title: "Invalid Channel IDs",
            description: "Please provide at least one valid channel ID.",
            variant: "destructive",
          })
          return
        }

        // Use the enhanced start ingestion function
        await startChannelIngestion(connectorId, channelIdsList, value.startDate, value.endDate, value.includeBotMessage)
        form.reset()
      } catch (error) {
        // Error handling is done in the startChannelIngestion function
      }
    },
  })

  // Render ingestion status if there's an active or previous ingestion
  const renderIngestionStatus = () => {
    if (ingestionLoading) {
      return (
        <div className="mb-4 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <div className="flex items-center gap-2">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600 dark:border-blue-400"></div>
            <span className="text-blue-900 dark:text-blue-100">Checking ingestion status...</span>
          </div>
        </div>
      )
    }

    if (ingestionError) {
      return (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-center justify-between">
            <div className="text-red-700">Error: {ingestionError}</div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => fetchIngestionStatus(connectorId!)}
              disabled={ingestionLoading}
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              Retry
            </Button>
          </div>
        </div>
      )
    }

    if (!ingestionStatus?.hasActiveIngestion) {
      return null // No status to show
    }

    const ingestion = ingestionStatus.ingestion!
    
    if (ingestion.status === 'in_progress') {
      return (
        <div className="mb-4 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-medium text-blue-900 dark:text-blue-100">Ingestion In Progress</span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => pauseIngestion(ingestion.id, connectorId!)}
                  disabled={ingestionLoading}
                >
                  <Pause className="h-3 w-3 mr-1" />
                  Pause
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => cancelIngestion(ingestion.id, connectorId!)}
                  disabled={ingestionLoading}
                >
                  <Square className="h-3 w-3 mr-1" />
                  Cancel
                </Button>
              </div>
            </div>
            
            {(() => {
              // Extract progress from metadata if available
              const progressData = getProgressData(ingestion);
              
              if (progressData && (progressData.totalChannels || progressData.processedChannels)) {
                return (
                  <div className="space-y-2">
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gray-700 dark:text-gray-300">Channels</span>
                        <span className="text-gray-900 dark:text-gray-100">{progressData.processedChannels || 0} / {progressData.totalChannels || 0}</span>
                      </div>
                      <Progress 
                        value={(progressData.totalChannels ?? 0) > 0 ? ((progressData.processedChannels || 0) / (progressData.totalChannels ?? 0)) * 100 : 0} 
                        className="h-2"
                      />
                    </div>
                    
                    <div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-700 dark:text-gray-300">Messages Processed</span>
                        <span className="text-gray-900 dark:text-gray-100 font-medium">{progressData.processedMessages || 0}</span>
                      </div>
                    </div>
                    
                    {progressData.currentChannel && (
                      <div className="text-sm text-gray-600 dark:text-gray-400">
                        Current: {progressData.currentChannel}
                      </div>
                    )}
                  </div>
                );
              } else {
                return (
                  <div className="text-sm text-gray-600 dark:text-gray-400">
                    Progress information not available yet...
                  </div>
                );
              }
            })()}
          </div>
        </div>
      )
    }

    if (ingestion.status === 'paused') {
      return (
        <div className="mb-4 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
          <div className="flex items-end justify-between">
            <div className="flex-1">
              <div className="font-medium text-yellow-900 dark:text-yellow-100">
                Ingestion Paused
              </div>
              {(() => {
                const progressData = getProgressData(ingestion);
                if (progressData && (progressData.totalChannels || progressData.processedChannels || progressData.processedMessages)) {
                  return (
                    <div className="text-sm mt-1 text-yellow-700 dark:text-yellow-300">
                      Progress: {progressData.processedChannels || 0} / {progressData.totalChannels || 0} channels, {progressData.processedMessages || 0} messages processed
                    </div>
                  );
                }
                return null;
              })()}
            </div>
            <div className="flex gap-2 ml-4">
              <Button
                size="sm"
                variant="outline"
                onClick={() => resumeIngestion(ingestion.id, connectorId!)}
                disabled={ingestionLoading}
              >
                <Play className="h-3 w-3 mr-1" />
                Resume
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => cancelIngestion(ingestion.id, connectorId!)}
                disabled={ingestionLoading}
              >
                <Square className="h-3 w-3 mr-1" />
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )
    }

    if (['failed', 'cancelled'].includes(ingestion.status)) {
      return (
        <div className="mb-4 p-4 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-orange-900 dark:text-orange-100">
                Ingestion {ingestion.status === 'failed' ? 'Failed' : 'Cancelled'}
              </div>
              {(() => {
                const progressData = getProgressData(ingestion);
                return progressData && (progressData.totalChannels || progressData.processedChannels) && (
                  <div className="text-sm mt-1 text-orange-700 dark:text-orange-300">
                    Progress: {progressData.processedChannels || 0} / {progressData.totalChannels || 0} channels
                  </div>
                );
              })()}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => resumeIngestion(ingestion.id, connectorId!)}
                disabled={ingestionLoading}
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                Resume
              </Button>
              {ingestion.status === 'failed' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => cancelIngestion(ingestion.id, connectorId!)}
                  disabled={ingestionLoading}
                >
                  <Square className="h-3 w-3 mr-1" />
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </div>
      )
    }

    if (ingestion.status === 'completed') {
      return (
        <div className="mb-4 p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-green-600 dark:text-green-400">Ingestion Completed</div>
              {(() => {
                const progressData = getProgressData(ingestion);
                return progressData && (progressData.processedChannels || progressData.processedMessages) && (
                  <div className="text-sm mt-1 text-green-700 dark:text-green-300">
                    Processed {progressData.processedChannels || 0} channels with {progressData.processedMessages || 0} messages
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )
    }

    return null
  }

  return (
    <div className="space-y-4">
      {renderIngestionStatus()}
      
      {/* Only show form if no active ingestion */}
      {!ingestionStatus?.hasActiveIngestion || !['in_progress', 'paused', 'failed'].includes(ingestionStatus?.ingestion?.status || '') ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            form.handleSubmit()
          }}
          className="grid w-full max-w-sm items-center gap-1.5"
        >
          <Label htmlFor="channelIds">Channel IDs (comma-separated)</Label>
          <form.Field
            name="channelIds"
            children={(field) => (
              <Input
                id="channelIds"
                type="text"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="e.g., C123,C456"
              />
            )}
          />

          <Label htmlFor="startDate">Start Date</Label>
          <form.Field
            name="startDate"
            children={(field) => (
              <Input
                id="startDate"
                type="date"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          />

          <Label htmlFor="endDate">End Date</Label>
          <form.Field
            name="endDate"
            children={(field) => (
              <Input
                id="endDate"
                type="date"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          />

      <div className="flex items-center space-x-2 mt-4">
        <form.Field
          name="includeBotMessage"
          children={(field) => (
            <input
              type="checkbox"
              id="includeBotMessage"
              checked={field.state.value}
              onChange={(e) => field.handleChange(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
          )}
        />
        <Label
          htmlFor="includeBotMessage"
          className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
        >
          Include Bot Messages
        </Label>
      </div>

          <Button 
            type="submit" 
            disabled={
              isManualIngestionActive || 
              ingestionLoading || 
              ingestionError !== null ||
              (ingestionStatus?.hasActiveIngestion && ['pending', 'in_progress', 'paused'].includes(ingestionStatus?.ingestion?.status || ''))
            }
          >
            {isManualIngestionActive 
              ? "Starting..." 
              : ingestionLoading 
                ? "Checking status..."
                : ingestionError
                  ? "Unable to check status"
                  : (ingestionStatus?.hasActiveIngestion && ['pending', 'in_progress', 'paused'].includes(ingestionStatus?.ingestion?.status || ''))
                    ? `Ingestion ${ingestionStatus.ingestion?.status || 'active'}`
                    : "Start Channel Ingestion"
            }
          </Button>
        </form>
      ) : null}
    </div>
  )
}
