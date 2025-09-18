import { Button } from "@/components/ui/button"
import { CredentialModal } from "./CredentialModal"

export function CredentialExample() {
  const handleCredentialSave = (data: any) => {
    console.log("Credential saved:", data)
  }

  return (
    <div className="p-4">
      <h3 className="text-lg font-medium mb-4">Credential Modal Example</h3>
      
      <CredentialModal onSave={handleCredentialSave}>
        <Button variant="outline">
          Configure Credentials
        </Button>
      </CredentialModal>
    </div>
  )
}