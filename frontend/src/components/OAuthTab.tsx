import { TabsContent } from "@/components/ui/tabs"
import { useState } from "react"
import {
  OAuthButton,
  OAuthForm,
} from "@/routes/_authenticated/admin/integrations/google"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Apps, UserRole } from "shared/types"
import { LoaderContent } from "@/lib/common"
import { OAuthIntegrationStatus } from "@/types"
import { X } from "lucide-react"
import { ConfirmModal } from "@/components/ui/confirmModal"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"
import { getErrorMessage } from "@/lib/utils"

interface OAuthTabProps {
  isPending: boolean
  oauthIntegrationStatus: OAuthIntegrationStatus
  setOAuthIntegrationStatus: (status: OAuthIntegrationStatus) => void
  updateStatus: string
  handleDelete: () => void
  userRole: UserRole
  connectorId?: string
}

const OAuthTab = ({
  isPending,
  oauthIntegrationStatus,
  setOAuthIntegrationStatus,
  updateStatus,
  handleDelete,
  userRole,
  connectorId,
}: OAuthTabProps) => {
  const [modalState, setModalState] = useState<{
    open: boolean
    title: string
    description: string
  }>({ open: false, title: "", description: "" })
  const [isStartingIngestion, setIsStartingIngestion] = useState(false)

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

  const handleStartIngestion = async () => {
    if (!connectorId) {
      toast({
        title: "Error",
        description: "Connector ID not found",
        variant: "destructive",
      })
      return
    }

    setIsStartingIngestion(true)
    try {
      // Role-based API routing
      const isAdmin =
        userRole === UserRole.Admin || userRole === UserRole.SuperAdmin

      const response = isAdmin
        ? await api.admin.google.start_ingestion.$post({
            json: { connectorId },
          })
        : await api.google.start_ingestion.$post({
            json: { connectorId },
          })

      if (response.ok) {
        toast({
          title: "Ingestion Started",
          description: "Data ingestion has been initiated successfully",
        })
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnecting)
      } else {
        throw new Error("Failed to start ingestion")
      }
    } catch (error) {
      toast({
        title: "Failed to Start Ingestion",
        description: `Error: ${getErrorMessage(error)}`,
        variant: "destructive",
      })
    } finally {
      setIsStartingIngestion(false)
    }
  }

  return (
    <TabsContent value="oauth">
      {isPending ? (
        <LoaderContent />
      ) : oauthIntegrationStatus === OAuthIntegrationStatus.Provider ? (
        <OAuthForm
          onSuccess={() =>
            setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuth)
          }
          userRole={userRole}
        />
      ) : oauthIntegrationStatus === OAuthIntegrationStatus.OAuth ? (
        <Card>
          <CardHeader>
            <CardTitle>Google OAuth</CardTitle>
            <CardDescription>Connect using Google OAuth here.</CardDescription>
          </CardHeader>
          <CardContent>
            <OAuthButton
              app={Apps.GoogleDrive}
              setOAuthIntegrationStatus={setOAuthIntegrationStatus}
              text="Connect with Google OAuth"
            />
          </CardContent>
        </Card>
      ) : oauthIntegrationStatus ===
        OAuthIntegrationStatus.OAuthReadyForIngestion ? (
        <Card>
          <CardHeader>
            <CardTitle>Google OAuth</CardTitle>
            <CardDescription>
              OAuth authentication completed. Ready to start data ingestion.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={handleStartIngestion}
              disabled={isStartingIngestion}
            >
              {isStartingIngestion ? "Starting..." : "Start Ingestion"}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Google OAuth</CardTitle>
          </CardHeader>
          <CardContent>
            {oauthIntegrationStatus ===
            OAuthIntegrationStatus.OAuthConnected ? (
              <div className="flex items-center justify-between">
                <span>Connected</span>
                <button
                  onClick={() =>
                    handleSetShowModal({
                      open: true,
                      title: "Confirm Disconnect",
                      description:
                        "Are you sure you want to disconnect Google OAuth?",
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
      )}

      <ConfirmModal
        showModal={modalState.open}
        setShowModal={handleSetShowModal}
        modalTitle={modalState.title}
        modalMessage={modalState.description}
        onConfirm={handleConfirmDelete}
      />
    </TabsContent>
  )
}

export default OAuthTab
