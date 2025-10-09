import { useState } from "react"
import { Button } from "@/components/ui/button"
import { CredentialModal, type CredentialData } from "./CredentialModal"

export function CredentialExample() {
  const [showModal, setShowModal] = useState(false)

  const handleCredentialSave = (data: CredentialData) => {
    console.log("Credential saved:", data)
  }

  return (
    <div className="p-4">
      <h3 className="text-lg font-medium mb-4">Credential Modal Example</h3>
      
      <Button variant="outline" onClick={() => setShowModal(true)}>
        Configure Credentials
      </Button>

      <CredentialModal 
        open={showModal}
        onOpenChange={setShowModal}
        onSave={handleCredentialSave}
        variant="full"
      />
    </div>
  )
}