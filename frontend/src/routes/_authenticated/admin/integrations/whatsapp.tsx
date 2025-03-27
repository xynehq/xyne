import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { toast, useToast } from "@/hooks/use-toast"
import { useNavigate } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { api } from "@/api"
import { getErrorMessage } from "@/lib/utils"
import { Apps, AuthType } from "shared/types"
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
import { ConnectorStatus } from "shared/types"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { wsClient } from "@/api"
import { ConnectorType, Connector } from "@/types"

// Function to fetch connectors
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

// WhatsApp QR Code Status enum
enum WhatsAppQRStatus {
  NotConnected = "NOT_CONNECTED",
  Connecting = "CONNECTING",
  Connected = "CONNECTED",
  Error = "ERROR"
}

interface WhatsAppQRCodeProps {
  qrCode: string
  status: WhatsAppQRStatus
  onRefresh: () => void
}

// Function to create WhatsApp connector
const createWhatsAppConnector = async () => {
  try {
    const res = await api.admin.connectors.whatsapp.$post({
      json: {}
    })
    if (!res.ok) {
      throw new Error("Could not create WhatsApp connector")
    }
    return res.json()
  } catch (error) {
    const message = getErrorMessage(error)
    toast({
      title: "Error",
      description: message,
      variant: "destructive",
    })
    throw error
  }
}

const WhatsAppQRCode = ({ qrCode, status, onRefresh }: WhatsAppQRCodeProps) => {
  const handleConnect = async () => {
    try {
      await createWhatsAppConnector()
      onRefresh()
    } catch (error) {
      console.error("Error connecting WhatsApp:", error)
    }
  }

  return (
    <div className="flex flex-col items-center gap-4">
      {status === WhatsAppQRStatus.Connecting && (
        <div className="flex flex-col items-center gap-2">
          <p>Scan the QR code with WhatsApp to connect</p>
          {qrCode && <img src={qrCode} alt="WhatsApp QR Code" className="w-64 h-64" />}
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      )}
      {status === WhatsAppQRStatus.Connected && (
        <div className="flex flex-col items-center gap-2">
          <p className="text-green-600 font-medium">WhatsApp Connected</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onRefresh}>
              Refresh Status
            </Button>
            <Button onClick={onRefresh}>
              Get Info
            </Button>
          </div>
        </div>
      )}
      {status === WhatsAppQRStatus.Error && (
        <div className="flex flex-col items-center gap-2">
          <p className="text-red-600 font-medium">Connection Error</p>
          <Button variant="outline" onClick={onRefresh}>
            Retry Connection
          </Button>
        </div>
      )}
      {status === WhatsAppQRStatus.NotConnected && (
        <div className="flex flex-col items-center gap-2">
          <p>Click to start WhatsApp connection</p>
          <Button onClick={handleConnect}>Connect WhatsApp</Button>
        </div>
      )}
    </div>
  )
}

export interface IntegrationProps {
  user: PublicUser
  workspace: PublicWorkspace
}

export const WhatsApp = ({ user, workspace }: IntegrationProps) => {
  const navigate = useNavigate()
  const [whatsappStatus, setWhatsappStatus] = useState<WhatsAppQRStatus>(WhatsAppQRStatus.NotConnected)
  const [qrCode, setQrCode] = useState<string>("")
  const [whatsappProgress, setWhatsappProgress] = useState<number>(0)
  const [whatsappStats, setWhatsappStats] = useState<{
    [phone: string]: any
  }>({})
  const startTimeRef = useRef<number | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [connectors, setConnectors] = useState<Connector[]>([])
  const { toast } = useToast()

  const whatsappConnector = connectors.find(
    (connector) => connector.app === Apps.WhatsApp && connector.authType === AuthType.Custom
  )

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

  const handleRetry = async () => {
    try {
      // Find the existing WhatsApp connector
      const connectors = await getConnectors()
      const whatsappConnector = connectors.find(
        (connector: Connector) => connector.app === Apps.WhatsApp && connector.authType === AuthType.Custom
      )
      
      if (!whatsappConnector) {
        throw new Error("WhatsApp connector not found")
      }

      // Set status to connecting to show QR code
      setWhatsappStatus(WhatsAppQRStatus.Connecting)
      setQrCode("") // Reset QR code to trigger re-render

      // Start ingestion for the existing connector
      const res = await api.admin.connectors.whatsapp.$post({
        json: {
          connectorId: whatsappConnector.id,
          action: "startIngestion"
        }
      })
      
      if (!res.ok) {
        throw new Error("Could not start WhatsApp data ingestion")
      }

      // Refresh connectors to update status
      await refetch()
    } catch (error) {
      console.error("Error retrying WhatsApp connection:", error)
      toast({
        title: "Error",
        description: "Failed to retry WhatsApp connection",
        variant: "destructive",
      })
      setWhatsappStatus(WhatsAppQRStatus.Error)
    }
  }

  useEffect(() => {
    if (!isPending && data && data.length > 0) {
      const connector = data.find(
        (v) => v.app === Apps.WhatsApp && v.authType === AuthType.Custom,
      )

      if (connector?.status === ConnectorStatus.Connecting) {
        setWhatsappStatus(WhatsAppQRStatus.Connecting)
      } else if (connector?.status === ConnectorStatus.Connected) {
        setWhatsappStatus(WhatsAppQRStatus.Connected)
      } else if (connector?.status === ConnectorStatus.NotConnected) {
        setWhatsappStatus(WhatsAppQRStatus.NotConnected)
      }
    }
  }, [data, isPending])

  useEffect(() => {
    let socket: WebSocket | null = null
    let reconnectTimeout: NodeJS.Timeout | null = null

    const setupWebSocket = () => {
      if (!isPending && data && data.length > 0) {
        const whatsappConnector = data.find(
          (v) => v.app === Apps.WhatsApp && v.authType === AuthType.Custom,
        )
        console.log("Found WhatsApp connector:", whatsappConnector)
        
        if (whatsappConnector) {
          console.log("Creating WebSocket connection for connector:", whatsappConnector.externalId)
          socket = wsClient.ws.$ws({
            query: {
              id: whatsappConnector.externalId,
              app: Apps.WhatsApp,
            },
          })

          socket.addEventListener("open", () => {
            console.info("WhatsApp socket opened successfully")
          })

          socket.addEventListener("message", (e) => {
            console.log("Received WebSocket message:", e.data)
            if (startTimeRef.current === null) {
              startTimeRef.current = Date.now()
            }
            const dataMsg = JSON.parse(e.data)
            console.log("Parsed message:", dataMsg)
            const statusJson = JSON.parse(dataMsg.message)
            console.log("Status JSON:", statusJson)
            
            setWhatsappProgress(statusJson.progress ?? 0)
            setWhatsappStats(statusJson.userStats ?? {})
            
            if (statusJson.qrCode) {
              console.log("Received QR code, updating state")
              setQrCode(statusJson.qrCode)
            }
          })

          socket.addEventListener("close", (e) => {
            console.info("WhatsApp WebSocket connection closed:", e.reason)
            if (e.reason === "Job finished") {
              setWhatsappStatus(WhatsAppQRStatus.Connected)
            } else {
              // Attempt to reconnect after a delay
              if (reconnectTimeout) {
                clearTimeout(reconnectTimeout)
              }
              reconnectTimeout = setTimeout(() => {
                console.log("Attempting to reconnect WebSocket...")
                setupWebSocket()
              }, 5000)
            }
          })

          socket.addEventListener("error", (error) => {
            console.error("WebSocket error:", error)
            setWhatsappStatus(WhatsAppQRStatus.Error)
            toast({
              title: "Connection Error",
              description: "Lost connection to WhatsApp integration service",
              variant: "destructive",
            })
          })
        }
      }
    }

    setupWebSocket()

    return () => {
      if (socket) {
        console.log("Cleaning up WebSocket connection")
        socket.close()
      }
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout)
      }
    }
  }, [data, isPending])

  const WhatsAppStatsTable = ({
    userStats,
  }: {
    userStats: { [phone: string]: any }
  }) => {
    const elapsedSeconds = startTimeRef.current
      ? (Date.now() - startTimeRef.current) / 1000
      : 1
    return (
      <Table className="ml-[20px] max-h-[400px]">
        <TableHeader>
          <TableRow>
            <TableHead>Phone Number</TableHead>
            <TableHead>Messages</TableHead>
            <TableHead>Conversations</TableHead>
            <TableHead>Contacts</TableHead>
            <TableHead>msgs per second</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(userStats).map(([phone, stats]) => (
            <TableRow key={phone}>
              <TableCell className={`${stats.done ? "text-lime-600" : ""}`}>
                {phone}
              </TableCell>
              <TableCell>{stats.messageCount}</TableCell>
              <TableCell>{stats.conversationCount}</TableCell>
              <TableCell>{stats.contactCount}</TableCell>
              <TableCell>
                {(stats.messageCount / elapsedSeconds).toFixed(2)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
  }

  const handleGetInfo = async () => {
    try {
      const connectors = await api.getConnectors()
      console.log("All connectors:", JSON.stringify(connectors, null, 2))
      
      const whatsappConnector = connectors.find(
        (connector: { type: ConnectorType }) => connector.type === ConnectorType.WhatsApp
      )
      console.log("WhatsApp connector found:", JSON.stringify(whatsappConnector, null, 2))

      if (!whatsappConnector) {
        throw new Error("WhatsApp connector not found")
      }

      console.log("Using connector ID:", whatsappConnector.id, "Type:", typeof whatsappConnector.id)
      await api.startIngestion(whatsappConnector.id)
      await fetchConnectors()
    } catch (error) {
      console.error("Error getting WhatsApp info:", error)
      toast({
        title: "Error",
        description: "Failed to get WhatsApp info",
        variant: "destructive",
      })
    }
  }

  const handleDelete = async () => {
    try {
      const connectors = await getConnectors()
      const whatsappConnector = connectors.find(
        (connector: { app: Apps; authType: AuthType; id: number; externalId: string }) => 
          connector.app === Apps.WhatsApp && connector.authType === AuthType.Custom
      )

      if (!whatsappConnector) {
        throw new Error("WhatsApp connector not found")
      }

      const res = await api.admin.connectors.whatsapp.$delete({
        json: {
          connectorId: whatsappConnector.id
        }
      })

      if (!res.ok) {
        throw new Error("Could not delete WhatsApp connector")
      }

      toast({
        title: "Success",
        description: "WhatsApp connector removed successfully",
      })
      refetch()
    } catch (error) {
      console.error("Error deleting WhatsApp connector:", error)
      toast({
        title: "Error",
        description: "Failed to remove WhatsApp connector",
        variant: "destructive",
      })
    }
  }

  const fetchConnectors = async () => {
    try {
      const data = await api.getConnectors()
      setConnectors(data)
    } catch (error) {
      console.error("Error fetching connectors:", error)
    }
  }

  return (
    <div className="flex w-full h-full">
      <Sidebar photoLink={user?.photoLink ?? ""} role={user?.role} />
      <IntegrationsSidebar role={user.role} />
      <div className="w-full h-full flex items-center justify-center">
        <div className="flex flex-col h-full items-center justify-center">
          <Card className="w-[400px]">
            <CardHeader>
              <CardTitle>WhatsApp Integration</CardTitle>
              <CardDescription>
                Connect your WhatsApp to start message ingestion
              </CardDescription>
            </CardHeader>
            <CardContent>
              <WhatsAppQRCode
                qrCode={qrCode}
                status={whatsappStatus}
                onRefresh={handleRetry}
              />
            </CardContent>
          </Card>

          {Object.keys(whatsappStats).length > 0 && (
            <div className="mt-4 w-full">
              <p className="mb-2">
                WhatsApp Integration Progress: {whatsappProgress}%
              </p>
              <Progress value={whatsappProgress} className="w-[60%] mb-4" />
              <WhatsAppStatsTable userStats={whatsappStats} />
            </div>
          )}

          {whatsappConnector && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-medium">WhatsApp Status</h3>
                  <p className="text-sm text-gray-500">
                    Status: {whatsappConnector.status}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={handleRetry}
                    disabled={isLoading}
                  >
                    Get Info
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={handleDelete}
                    disabled={isLoading}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute(
  "/_authenticated/admin/integrations/whatsapp",
)({
  beforeLoad: async ({ params, context }) => {
    return params
  },
  loader: async (params) => {
    return params
  },
  component: () => {
    const matches = useRouterState({ select: (s) => s.matches })
    const { user, workspace } = matches[matches.length - 1].context
    return <WhatsApp user={user} workspace={workspace} />
  },
}) 
