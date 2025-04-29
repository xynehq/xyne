import { TabsContent } from "@/components/ui/tabs";
import { useState } from "react";
import {
  OAuthButton,
  OAuthForm,
} from "@/routes/_authenticated/admin/integrations/google";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Apps } from "shared/types";
import { LoaderContent } from "@/lib/common";
import { OAuthIntegrationStatus } from "@/types";
import { X } from "lucide-react";
import Modal from "./ui/Modal";

interface OAuthTabProps {
  isPending: boolean;
  oauthIntegrationStatus: OAuthIntegrationStatus;
  setOAuthIntegrationStatus: (status: OAuthIntegrationStatus) => void;
  updateStatus: string;
  handleDelete: () => void;
}

const OAuthTab = ({
  isPending,
  oauthIntegrationStatus,
  setOAuthIntegrationStatus,
  updateStatus,
  handleDelete,
}: OAuthTabProps) => {
  const [modalState, setModalState] = useState<{
    open: boolean;
    title: string;
    description: string;
  }>({ open: false, title: "", description: "" });

  const handleConfirmDelete = () => {
    handleDelete();
    setModalState({ open: false, title: "", description: "" });
  };

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
            {oauthIntegrationStatus === OAuthIntegrationStatus.OAuthConnected ? (
              <div className="flex items-center justify-between">
                <span>Connected</span>
                <button
                  onClick={() =>
                    setModalState({
                      open: true,
                      title: "Confirm Disconnect",
                      description: "Are you sure you want to disconnect Google OAuth?",
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

      <Modal
        isOpen={modalState.open}
        setIsOpen={setModalState}
        onConfirm={handleConfirmDelete}
        modelTitle={modalState.title}
        modelDescription={modalState.description}
      />
    </TabsContent>
  );
};

export default OAuthTab;