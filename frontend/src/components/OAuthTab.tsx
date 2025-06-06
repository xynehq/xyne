import { useState, Dispatch, SetStateAction } from "react"
import { TabsContent } from "@/components/ui/tabs"
import { Pencil } from "lucide-react"
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
import { Apps } from "shared/types"
import { LoaderContent } from "@/lib/common"
import { OAuthIntegrationStatus } from "@/types"
import { X } from "lucide-react"
import { ConfirmModal } from "@/components/ui/confirmModal"

interface OAuthTabProps {
  isPending: boolean
  oauthIntegrationStatus: OAuthIntegrationStatus
  setOAuthIntegrationStatus: Dispatch<SetStateAction<OAuthIntegrationStatus>>
  updateStatus: string
  connectorId?: string
  refetch: any
  handleDelete: () => void
}

const OAuthTab = ({
  isPending,
  oauthIntegrationStatus,
  setOAuthIntegrationStatus,
  connectorId,
  refetch,
  handleDelete,
}: OAuthTabProps) => {
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

  const [isEditing, setIsEditing] = useState(false)
  const handleEdit = (connectorId: string) => {
    if (connectorId) {
      setIsEditing(true)
    }
  }

  const handleFormSuccess = () => {
    setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuth)
    setIsEditing(false)
    refetch()
  }

  return (
    <TabsContent value="oauth">
      {isPending ? (
        <LoaderContent />
      ) : oauthIntegrationStatus === OAuthIntegrationStatus.Provider ? (
        <OAuthForm
          onSuccess={handleFormSuccess}
          isEditing={isEditing}
          connectorId={connectorId}
        />
      ) : oauthIntegrationStatus === OAuthIntegrationStatus.OAuth ? (
        <Card>
          <CardHeader>
            <CardTitle>Google OAuth</CardTitle>
            <CardDescription>Connect using Google OAuth here.</CardDescription>
          </CardHeader>
          <CardContent>
            {isEditing ? (
              <OAuthForm
                onSuccess={handleFormSuccess}
                isEditing={isEditing}
                connectorId={connectorId}
              />
            ) : (
              <div className="flex justify-between items-center">
                <OAuthButton
                  app={Apps.GoogleDrive}
                  setOAuthIntegrationStatus={setOAuthIntegrationStatus}
                  text="Connect with Google OAuth"
                />
                {!!connectorId && (
                  <Pencil
                    className="flex justify-end cursor-pointer text-muted-foreground hover:text-gray-800"
                    onClick={() => {
                      handleEdit(connectorId as string)
                    }}
                    size={18}
                  />
                )}
              </div>
            )}
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
