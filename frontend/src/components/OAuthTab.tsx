import { useState } from "react"
import { Button } from "@/components/ui/button"
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
  setOAuthIntegrationStatus: (status: OAuthIntegrationStatus) => void
  updateStatus: string
}

const OAuthTab = ({
  isPending,
  oauthIntegrationStatus,
  setOAuthIntegrationStatus,
}: OAuthTabProps) => {
  const [isEditing, setIsEditing] = useState(false)

  const handleEdit = () => {
    setIsEditing(true)
  }
  return (
    <TabsContent value="oauth">
      {isPending ? (
        <LoaderContent />
      ) : oauthIntegrationStatus === OAuthIntegrationStatus.Provider ? (
        <OAuthForm
          onSuccess={() => {
            setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuth)
            setIsEditing(false)
          }}
          isEditing={isEditing}
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
                onSuccess={() => {
                  setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuth)
                  setIsEditing(false)
                }}
                isEditing={isEditing}
              />
            ) : (
              <>
                <div className="flex justify-between items-center">
                  <OAuthButton
                    app={Apps.GoogleDrive}
                    setOAuthIntegrationStatus={setOAuthIntegrationStatus}
                    text="Connect with Google OAuth"
                  />
                  <Pencil
                    className="flex justify-end cursor-pointer  text-muted-foreground hover:text-gray-800"
                    onClick={handleEdit}
                    size={18}
                  />
                </div>
              </>
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
              <>
                <p className="mb-4">Connected</p>
              </>
            ) : (
              "Connecting"
            )}
          </CardContent>
        </Card>
      )}
    </TabsContent>
  )
}

export default OAuthTab
