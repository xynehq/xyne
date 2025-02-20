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
import { X } from "lucide-react"

interface OAuthTabProps {
  isPending: boolean
  oauthIntegrationStatus: OAuthIntegrationStatus
  setOAuthIntegrationStatus: (status: OAuthIntegrationStatus) => void
  updateStatus: string
  removeConnector: () => void
  disconnected: { disconnecting: boolean; completed: boolean }
  stopConnector: () => void
  stopIntegration: {
    inProgess: boolean
    completed: boolean
  }
}

const OAuthTab = ({
  isPending,
  oauthIntegrationStatus,
  setOAuthIntegrationStatus,
  updateStatus,
  removeConnector,
  stopConnector,
  disconnected,
  stopIntegration,
}: OAuthTabProps) => {
  const getStatusMessage = () => {
    if (stopIntegration.inProgess) {
      return "stopping"
    }
    if (disconnected.disconnecting) {
      return "disconnecting"
    }
    switch (oauthIntegrationStatus) {
      case OAuthIntegrationStatus.OAuthConnected:
        return "Connected"
      case OAuthIntegrationStatus.OAuthConnecting:
        return "Connecting"
      default:
        return "failed"
    }
  }

  const renderActionButton = () => {
    if (stopIntegration.inProgess || disconnected.disconnecting) {
      return (
        <div>
          <LoaderContent />
        </div>
      )
    }

    const handleClick =
      oauthIntegrationStatus === OAuthIntegrationStatus.OAuthConnected
        ? removeConnector
        : stopConnector

    return <X className="cursor-pointer" onClick={handleClick} />
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
          <CardContent className="flex items-center justify-between">
            {getStatusMessage()}
            {renderActionButton()}
          </CardContent>
        </Card>
      )}
    </TabsContent>
  )
}

export default OAuthTab
