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
import { Apps, UserRole } from "shared/types"
import { LoaderContent } from "@/lib/common"
import { OAuthIntegrationStatus } from "@/types"
import { X } from "lucide-react"
import { ConfirmModal } from "@/components/ui/confirmModal"

interface OAuthTabProps {
  isPending: boolean
  oauthIntegrationStatus: OAuthIntegrationStatus
  setOAuthIntegrationStatus: (status: OAuthIntegrationStatus) => void
  updateStatus: string
  handleDelete: () => void
  userRole: UserRole
}

const OAuthTab = ({
  isPending,
  oauthIntegrationStatus,
  setOAuthIntegrationStatus,
  updateStatus,
  handleDelete,
  userRole,
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
