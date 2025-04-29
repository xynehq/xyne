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

interface OAuthTabProps {
  isPending: boolean
  oauthIntegrationStatus: OAuthIntegrationStatus
  setOAuthIntegrationStatus: Dispatch<SetStateAction<OAuthIntegrationStatus>>
  updateStatus: string
  connectorId?: string
  refetch: any
}

const OAuthTab = ({
  isPending,
  oauthIntegrationStatus,
  setOAuthIntegrationStatus,
  connectorId,
  refetch,
}: OAuthTabProps) => {
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
          refetch={refetch}
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
                refetch={refetch}
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
            {oauthIntegrationStatus === OAuthIntegrationStatus.OAuthConnected
              ? "Connected"
              : "Connecting"}
          </CardContent>
        </Card>
      )}
    </TabsContent>
  )
}

export default OAuthTab
