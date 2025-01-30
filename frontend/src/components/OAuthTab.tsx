import { TabsContent } from "./ui/tabs"
import {
  LoaderContent,
  OAuthButton,
  OAuthForm,
  OAuthIntegrationStatus,
} from "@/routes/_authenticated/admin/integrations"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card"
import { Apps } from "shared/types"

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
  updateStatus,
}: OAuthTabProps) => {
  return (
    <TabsContent value="oauth">
      {isPending ? (
        <LoaderContent />
      ) : oauthIntegrationStatus === OAuthIntegrationStatus.Provider ? (
        <OAuthForm
          onSuccess={() =>
            setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuth)
          }
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
