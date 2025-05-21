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
import { Apps } from "shared/types"
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
  startDate?: Date
  endDate?: Date
  insertDrive: boolean
  insertGmail: boolean
  insertCalendar: boolean
  insertContacts: boolean
}

const OAuthTab = ({
  isPending,
  oauthIntegrationStatus,
  setOAuthIntegrationStatus,
  updateStatus,
  handleDelete,
  startDate,
  endDate,
  insertDrive,
  insertGmail,
  insertCalendar,
  insertContacts,
}: OAuthTabProps) => {
  const [modalState, setModalState] = useState<{
    open: boolean
    title: string
    description: string
  }>({ open: false, title: "", description: "" })
  const [selectedStartDate, setSelectedStartDate] = useState<Date | undefined>(startDate)
  const [selectedEndDate, setSelectedEndDate] = useState<Date | undefined>(endDate)
  const [selectedServices, setSelectedServices] = useState({
    insertDrive: false,
    insertGmail: false,
    insertCalendar: false,
    insertContacts: false
  })

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

  const handleOAuthSuccess = (
    startDate?: Date, 
    endDate?: Date,
    services?: {
      insertDrive: boolean,
      insertGmail: boolean,
      insertCalendar: boolean,
      insertContacts: boolean
    }
  ) => {
    console.log("[OAuthTab] Received form data:", { 
      startDate, 
      endDate,
      services 
    })
    setSelectedStartDate(startDate)
    setSelectedEndDate(endDate)
    if (services) {
      setSelectedServices(services)
    }
    setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuth)
  }

  return (
    <TabsContent value="oauth">
      {isPending ? (
        <LoaderContent />
      ) : oauthIntegrationStatus === OAuthIntegrationStatus.Provider ? (
        <OAuthForm
          onSuccess={handleOAuthSuccess}
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
              startDate={selectedStartDate}
              endDate={selectedEndDate}
              insertDrive={selectedServices.insertDrive}
              insertGmail={selectedServices.insertGmail}
              insertCalendar={selectedServices.insertCalendar}
              insertContacts={selectedServices.insertContacts}
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
