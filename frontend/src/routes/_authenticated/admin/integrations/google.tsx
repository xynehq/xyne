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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import OAuthTab from "@/components/OAuthTab"
import { LoaderContent } from "@/lib/common"
import { IntegrationsSidebar } from "@/components/IntegrationsSidebar"
import { UserStatsTable } from "@/components/ui/userStatsTable"

const logger = console

const submitServiceAccountForm = async (
  value: ServiceAccountFormData,
  navigate: UseNavigateResult<string>,
) => {
  const response = await api.admin.service_account.$post({
    form: {
      "service-key": value.file,
      app: Apps.GoogleDrive,
      email: value.email,
      whitelistedEmails: value.whitelistedEmails,
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
      `Failed to upload file: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }
  return response.json()
}

const submitOAuthForm = async (
  value: OAuthFormData,
  navigate: UseNavigateResult<string>,
) => {
  const response = await api.admin.oauth.create.$post({
    form: {
      clientId: value.clientId,
      clientSecret: value.clientSecret,
      scopes: value.scopes,
      app: Apps.GoogleDrive,
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
      `Failed to upload file: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }
  return response.json()
}

type ServiceAccountFormData = {
  email: string
  file: any
  whitelistedEmails?: string
}

type OAuthFormData = {
  clientId: string
  clientSecret: string
  scopes: string[]
}

export const OAuthForm = ({ onSuccess }: { onSuccess: any }) => {
  const { toast } = useToast()
  const navigate = useNavigate()
  const form = useForm<OAuthFormData>({
    defaultValues: {
      clientId: "",
      clientSecret: "",
      scopes: [],
    },
    onSubmit: async ({ value }) => {
      try {
        await submitOAuthForm(value, navigate)
        toast({
          title: "OAuth integration added",
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
      <Label htmlFor="clientId">client id</Label>
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
              placeholder="Enter client id"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <p className="text-red-600 text-sm">
                {field.state.meta.errors.join(", ")}
              </p>
            ) : null}
          </>
        )}
      />
      <Label htmlFor="clientSecret">client secret</Label>
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
              placeholder="Enter client secret"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <p className="text-red-600 text-sm">
                {field.state.meta.errors.join(", ")}
              </p>
            ) : null}
          </>
        )}
      />
      <Label htmlFor="scopes">scopes</Label>
      <form.Field
        name="scopes"
        validators={{
          onChange: ({ value }) => (!value ? "scopes are required" : undefined),
        }}
        children={(field) => (
          <>
            <Input
              id="scopes"
              type="text"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value.split(","))}
              placeholder="Enter OAuth scopes"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <p className="text-red-600 text-sm">
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

export const ServiceAccountForm = ({
  onSuccess,
  refetch,
}: {
  onSuccess: any
  refetch: any
}) => {
  //@ts-ignore
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const { toast } = useToast()
  const navigate = useNavigate()

  const form = useForm<ServiceAccountFormData>({
    defaultValues: {
      email: "",
      file: null,
      whitelistedEmails: "",
    },
    onSubmit: async ({ value }) => {
      if (!value.file) {
        toast({
          title: "No file selected",
          description: "Please upload a file before submitting.",
          variant: "destructive",
        })
        return
      }

      try {
        await submitServiceAccountForm(value, navigate) // Call the async function
        await refetch()
        toast({
          title: "File uploaded successfully",
          description: "Integration in progress",
        })
        onSuccess()
      } catch (error) {
        toast({
          title: "Could not upload the service account key",
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
      <Label htmlFor="email">Email</Label>
      <form.Field
        name="email"
        validators={{
          onChange: ({ value }) => (!value ? "Email is required" : undefined),
        }}
        children={(field) => (
          <>
            <Input
              id="email"
              type="email"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Enter your email"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <p className="text-red-600 text-sm">
                {field.state.meta.errors.join(", ")}
              </p>
            ) : null}
          </>
        )}
      />

      <Label htmlFor="whitelisted-emails">Whitelisted Emails (Optional)</Label>
      <form.Field
        name="whitelistedEmails"
        children={(field) => (
          <>
            <Input
              id="whitelisted-emails"
              type="text"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="user1@example.com,user2@example.com"
            />
          </>
        )}
      />

      <Label htmlFor="service-key">Google Service Account Key</Label>
      <form.Field
        name="file"
        validators={{
          onChange: ({ value }) => (!value ? "File is required" : undefined),
        }}
        children={(field) => (
          <>
            <Input
              id="service-key"
              type="file"
              onChange={(e) => field.handleChange(e.target.files?.[0])}
              className="file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <p className="text-red-600 text-sm">
                {field.state.meta.errors.join(", ")}
              </p>
            ) : null}
          </>
        )}
      />

      <Button type="submit">Upload</Button>
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
export const minHeight = 320

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

export const deleteOauthConnector = async (connectorId: string) => {
  const res = await api.admin.oauth.connector.delete.$delete({
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

type IngestMoreSAFormData = {
  connectorId: string
  emails: string
  startDate: string
  endDate: string
  insertDriveAndContacts: boolean
  insertGmail: boolean
  insertCalendar: boolean
}

const submitIngestMoreSAForm = async (
  value: IngestMoreSAFormData & { emailsList: string[] },
  navigate: UseNavigateResult<string>,
) => {
  const response = await api.admin.google.service_account.ingest_more.$post({
    json: {
      connectorId: value.connectorId,
      emailsToIngest: value.emailsList,
      startDate: value.startDate,
      endDate: value.endDate,
      insertDriveAndContacts: value.insertDriveAndContacts,
      insertGmail: value.insertGmail,
      insertCalendar: value.insertCalendar,
    },
  })
  if (!response.ok) {
    if (response.status === 401) {
      navigate({ to: "/auth" })
      throw new Error("Unauthorized")
    }
    const errorText = await response.text()
    throw new Error(
      `Failed to ingest more users: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }
  return response.json()
}

const IngestMoreUsersForm = ({
  connectorId,
  onSuccess,
  setIsIngestingMore,
}: {
  connectorId: string
  onSuccess: () => void
  setIsIngestingMore: (isIngesting: boolean) => void
}) => {
  const { toast } = useToast()
  const navigate = useNavigate()

  const form = useForm<IngestMoreSAFormData>({
    defaultValues: {
      connectorId: connectorId,
      emails: "",
      startDate: "",
      endDate: "",
      insertDriveAndContacts: true,
      insertGmail: true,
      insertCalendar: true,
    },
    onSubmit: async ({ value }) => {
      const emailsList = value.emails
        .split(",")
        .map((e) => e.trim())
        .filter((e) => e)
      if (emailsList.length === 0) {
        toast({
          title: "No emails provided",
          description: "Please enter at least one email address.",
          variant: "destructive",
        })
        return
      }
      setIsIngestingMore(true)
      try {
        let submissionStartDate = value.startDate
        let submissionEndDate = value.endDate

        if (
          submissionStartDate &&
          submissionStartDate.trim() !== "" &&
          (!submissionEndDate || submissionEndDate.trim() === "")
        ) {
          submissionEndDate = new Date().toISOString().split("T")[0]
        }

        // Validate that startDate is not after endDate if both are provided
        if (
          submissionStartDate &&
          submissionEndDate &&
          new Date(submissionStartDate) > new Date(submissionEndDate)
        ) {
          toast({
            title: "Invalid date range",
            description: "Start date must be before the end date.",
            variant: "destructive",
          })
          setIsIngestingMore(false)
          return
        }

        if (
          !value.insertDriveAndContacts &&
          !value.insertGmail &&
          !value.insertCalendar
        ) {
          toast({
            title: "No service selected",
            description: "Please select at least one Google service to ingest.",
            variant: "destructive",
          })
          setIsIngestingMore(false)
          return
        }

        await submitIngestMoreSAForm(
          {
            ...value,
            emailsList,
            startDate: submissionStartDate,
            endDate: submissionEndDate,
          },
          navigate,
        )
        toast({
          title: "Ingestion started for additional users",
          description: "Processing is underway. See progress updates.",
        })
        onSuccess()
        form.reset()
      } catch (error) {
        toast({
          title: "Could not start ingestion for additional users",
          description: `Error: ${getErrorMessage(error)}`,
          variant: "destructive",
        })
      } finally {
        setIsIngestingMore(false)
      }
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
      className="grid w-full max-w-sm items-center gap-1.5 mt-4"
    >
      <Label htmlFor="ingest-more-emails">
        Whitelisted Emails (comma-separated)
      </Label>
      <form.Field
        name="emails"
        validators={{
          onChange: ({ value }) =>
            !value ||
            value
              .split(",")
              .map((e) => e.trim())
              .filter((e) => e).length === 0
              ? "At least one email is required"
              : undefined,
        }}
        children={(field) => (
          <>
            <Input
              id="ingest-more-emails"
              type="text"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="user1@example.com,user2@example.com"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <p className="text-red-600 text-sm">
                {field.state.meta.errors.join(", ")}
              </p>
            ) : null}
          </>
        )}
      />

      <div className="mt-4">
        <Label>Date Range</Label>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="start-date">Start Date</Label>
            <form.Field
              name="startDate"
              children={(field) => (
                <Input
                  id="start-date"
                  type="date"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              )}
            />
          </div>
          <div>
            <Label htmlFor="end-date">End Date</Label>
            <form.Field
              name="endDate"
              children={(field) => (
                <Input
                  id="end-date"
                  type="date"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              )}
            />
          </div>
        </div>
      </div>

      <div className="mt-4">
        <Label>Services to Sync</Label>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div className="flex items-center space-x-2">
            <form.Field
              name="insertDriveAndContacts"
              children={(field) => (
                <input
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(e) => field.handleChange(e.target.checked)}
                  className="h-4 w-4"
                />
              )}
            />
            <Label>Drive & Contacts</Label>
          </div>
          <div className="flex items-center space-x-2">
            <form.Field
              name="insertGmail"
              children={(field) => (
                <input
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(e) => field.handleChange(e.target.checked)}
                  className="h-4 w-4"
                />
              )}
            />
            <Label>Gmail</Label>
          </div>
          <div className="flex items-center space-x-2">
            <form.Field
              name="insertCalendar"
              children={(field) => (
                <input
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(e) => field.handleChange(e.target.checked)}
                  className="h-4 w-4"
                />
              )}
            />
            <Label>Calendar</Label>
          </div>
        </div>
      </div>

      <Button type="submit" disabled={form.state.isSubmitting} className="mt-4">
        {form.state.isSubmitting ? (
          <LoadingSpinner className="mr-2 h-4 w-4" />
        ) : null}
        Ingest More Users
      </Button>
    </form>
  )
}

const ServiceAccountTab = ({
  connectors,
  onSuccess,
  isIntegrating,
  progress,
  refetch,
  userStats,
}: {
  connectors: Connectors[]
  updateStatus: string
  onSuccess: any
  isIntegrating: boolean
  progress: number
  userStats: any
  refetch: any
}) => {
  const googleSAConnector = connectors.find(
    (v) => v.app === Apps.GoogleDrive && v.authType === AuthType.ServiceAccount,
  )
  const [isIngestingMore, setIsIngestingMore] = useState(false)

  if (
    isIntegrating &&
    googleSAConnector &&
    googleSAConnector.status === ConnectorStatus.Connecting
  ) {
    return (
      <CardHeader>
        <CardTitle>Google Workspace</CardTitle>
        <CardDescription>Connecting {progress}%</CardDescription>
        <Progress value={progress} className="p-0 w-[60%]" />
      </CardHeader>
    )
  }

  if (!googleSAConnector && !isIntegrating) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>File Upload</CardTitle>
          <CardDescription>
            Upload your Google Service Account Key here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ServiceAccountForm onSuccess={onSuccess} refetch={refetch} />
        </CardContent>
      </Card>
    )
  } else if (googleSAConnector) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Google Workspace Service Account</CardTitle>
          {googleSAConnector.status === ConnectorStatus.Connecting &&
          !isIngestingMore ? (
            <>
              <CardDescription>Connecting {progress}%</CardDescription>
              <Progress value={progress} className="p-0 w-[60%]" />
            </>
          ) : (
            <>
              <CardDescription>
                Status: {googleSAConnector.status}
              </CardDescription>
            </>
          )}
        </CardHeader>
        {googleSAConnector.status === ConnectorStatus.Connected && (
          <CardContent>
            <CardTitle className="text-md mb-1">Ingest More Users</CardTitle>
            <CardDescription className="mb-3 text-sm">
              Add more users to service account. Enter comma-separated emails.
            </CardDescription>
            <IngestMoreUsersForm
              connectorId={(googleSAConnector as any).id}
              onSuccess={() => {
                refetch()
              }}
              setIsIngestingMore={setIsIngestingMore}
            />
            {isIngestingMore && (
              <div className="mt-4">
                <CardDescription>
                  Ingesting additional users...{" "}
                  {progress > 0 && progress < 100 ? `${progress}%` : ""}
                </CardDescription>
                {progress > 0 && progress < 100 && (
                  <Progress value={progress} className="p-0 w-[60%] mt-1" />
                )}
              </div>
            )}
          </CardContent>
        )}
      </Card>
    )
  }
  return <LoaderContent />
}

export const showUserStats = (
  userStats: { [email: string]: any },
  activeTab: string,
  oauthIntegrationStatus: OAuthIntegrationStatus,
) => {
  if (oauthIntegrationStatus === OAuthIntegrationStatus.OAuthConnected)
    return false
  if (!Object.keys(userStats).length) return false
  if (activeTab !== "service_account" && activeTab !== "oauth") return false

  const currentAuthType =
    activeTab === "oauth" ? AuthType.OAuth : AuthType.ServiceAccount
  return Object.values(userStats).some(
    (stats) => stats.type === currentAuthType,
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
  const [progress, setProgress] = useState<number>(0)
  const [userStats, setUserStats] = useState<{ [email: string]: any }>({})
  const [activeTab, setActiveTab] = useState<string>("service_account")
  const [isIntegratingSA, setIsIntegratingSA] = useState<boolean>(
    data
      ? !!data.find(
          (v) =>
            v.app === Apps.GoogleDrive &&
            v.authType === AuthType.ServiceAccount,
        )
      : false,
  )
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
      setIsIntegratingSA(
        !!data.find(
          (v) =>
            v.app === Apps.GoogleDrive &&
            v.authType === AuthType.ServiceAccount,
        ),
      )
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
      // setIsIntegratingProvider(!!data.find(v => v.app === Apps.GoogleDrive && v.authType === AuthType.OAuth))
    } else {
      setIsIntegratingSA(false)
      // setIsIntegratingProvider(false)
      setOAuthIntegrationStatus(OAuthIntegrationStatus.Provider)
    }
  }, [data, isPending])

  useEffect(() => {
    let serviceAccountSocket: WebSocket | null = null
    let oauthSocket: WebSocket | null = null

    if (!isPending && data && data.length > 0) {
      const serviceAccountConnector = data.find(
        (c) => c.authType === AuthType.ServiceAccount,
      )
      const oauthConnector = data.find((c) => c.authType === AuthType.OAuth)

      if (serviceAccountConnector) {
        serviceAccountSocket = wsClient.ws.$ws({
          query: { id: serviceAccountConnector.id }, // externalId
        })
        serviceAccountSocket?.addEventListener("open", () => {
          logger.info(
            `Service Account WebSocket opened for ${serviceAccountConnector.id}`,
          )
        })
        serviceAccountSocket?.addEventListener("message", (e) => {
          const data = JSON.parse(e.data)
          const statusJson = JSON.parse(data.message)
          setProgress(statusJson.progress ?? 0) // Could split to serviceAccountProgress
          setUserStats(statusJson.userStats ?? {})
          setUpateStatus(data.message)
        })
        serviceAccountSocket?.addEventListener("close", (e) => {
          logger.info("Service Account WebSocket closed")
          if (e.reason === "Job finished") {
            setIsIntegratingSA(true)
          }
        })
      }

      if (oauthConnector) {
        oauthSocket = wsClient.ws.$ws({
          query: { id: oauthConnector.id }, // externalId
        })
        oauthSocket?.addEventListener("open", () => {
          logger.info(`OAuth WebSocket opened for ${oauthConnector.id}`)
        })
        oauthSocket?.addEventListener("message", (e) => {
          const data = JSON.parse(e.data)
          const statusJson = JSON.parse(data.message)
          setProgress(statusJson.progress ?? 0) // Could split to oauthProgress
          setUserStats(statusJson.userStats ?? {})
          setUpateStatus(data.message)
        })
        oauthSocket?.addEventListener("close", (e) => {
          logger.info("OAuth WebSocket closed")
          if (e.reason === "Job finished") {
            setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnected)
          }
        })
      }
    }

    return () => {
      serviceAccountSocket?.close()
      oauthSocket?.close()
    }
  }, [data, isPending])

  useEffect(() => {
    if (oauthIntegrationStatus === OAuthIntegrationStatus.OAuthConnecting) {
      refetch()
    }
  }, [oauthIntegrationStatus, refetch])

  const showUserStats = (
    userStats: { [email: string]: any },
    activeTab: string,
    oauthIntegrationStatus: OAuthIntegrationStatus,
  ) => {
    if (!Object.keys(userStats).length) return false
    if (activeTab !== "service_account" && activeTab !== "oauth") return false

    const currentAuthType =
      activeTab === "oauth" ? AuthType.OAuth : AuthType.ServiceAccount

    if (currentAuthType === AuthType.OAuth) {
      return (
        oauthIntegrationStatus === OAuthIntegrationStatus.OAuthConnecting &&
        Object.values(userStats).some((stats) => stats.type === currentAuthType)
      )
    }

    return (
      isIntegratingSA &&
      Object.values(userStats).some((stats) => stats.type === currentAuthType)
    )
  }

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
      await deleteOauthConnector(googleOAuthConnector.id)
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

  // if (isPending) return <LoaderContent />
  if (error) return "An error has occurred: " + error.message
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
            defaultValue="service_account"
            className={`w-[400px] min-h-[${minHeight}px] ${Object.keys(userStats).length > 0 ? "mt-[150px]" : ""}`}
            onValueChange={setActiveTab}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="service_account">Service Account</TabsTrigger>
              <TabsTrigger value="oauth">Google OAuth</TabsTrigger>
            </TabsList>
            <TabsContent value="service_account">
              {isPending ? (
                <LoaderContent />
              ) : (
                <ServiceAccountTab
                  connectors={data}
                  updateStatus={updateStatus}
                  isIntegrating={isIntegratingSA}
                  onSuccess={() => setIsIntegratingSA(true)}
                  progress={progress}
                  userStats={userStats}
                  refetch={refetch}
                />
              )}
            </TabsContent>
            <OAuthTab
              isPending={isPending}
              oauthIntegrationStatus={oauthIntegrationStatus}
              setOAuthIntegrationStatus={setOAuthIntegrationStatus}
              updateStatus={updateStatus}
              handleDelete={handleDelete}
            />
          </Tabs>
          {showUserStats(userStats, activeTab, oauthIntegrationStatus) && (
            <UserStatsTable
              userStats={userStats}
              type={
                activeTab === "oauth" ? AuthType.OAuth : AuthType.ServiceAccount
              }
            />
          )}
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute(
  "/_authenticated/admin/integrations/google",
)({
  beforeLoad: async ({ params, context }) => {
    const userWorkspace = context
    // Normal users shouldn't be allowed to visit /admin/integrations
    if (
      userWorkspace?.user?.role !== UserRole.SuperAdmin &&
      userWorkspace?.user?.role !== UserRole.Admin
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
