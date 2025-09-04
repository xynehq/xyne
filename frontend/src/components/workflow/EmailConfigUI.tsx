import React, { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ArrowLeft, X, Trash2 } from "lucide-react"

interface EmailConfigUIProps {
  isVisible: boolean
  onBack: () => void
  onSave?: (emailConfig: EmailConfig) => void
}

export interface EmailConfig {
  sendingFrom: string
  emailAddresses: string[]
}

const EmailConfigUI: React.FC<EmailConfigUIProps> = ({
  isVisible,
  onBack,
  onSave,
}) => {
  const [emailConfig, setEmailConfig] = useState<EmailConfig>({
    sendingFrom: "noreply@xyne.com",
    emailAddresses: [],
  })

  const [newEmailAddress, setNewEmailAddress] = useState("")

  const handleAddEmail = () => {
    if (
      newEmailAddress &&
      !emailConfig.emailAddresses.includes(newEmailAddress)
    ) {
      setEmailConfig((prev) => ({
        ...prev,
        emailAddresses: [...prev.emailAddresses, newEmailAddress],
      }))
      setNewEmailAddress("")
    }
  }

  const handleRemoveEmail = (emailToRemove: string) => {
    setEmailConfig((prev) => ({
      ...prev,
      emailAddresses: prev.emailAddresses.filter(
        (email) => email !== emailToRemove,
      ),
    }))
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleAddEmail()
    }
  }

  const handleSave = () => {
    onSave?.(emailConfig)
  }

  return (
    <div
      className={`h-full bg-white border-l border-slate-200 flex flex-col overflow-hidden transition-transform duration-300 ease-in-out ${
        isVisible ? "translate-x-0 w-[400px]" : "translate-x-full w-0"
      }`}
    >
      {/* Header */}
      <div
        className="flex items-center border-b"
        style={{
          display: "flex",
          padding: "20px",
          alignItems: "center",
          gap: "10px",
          alignSelf: "stretch",
          borderBottom: "1px solid var(--gray-300, #E4E6E7)",
        }}
      >
        <button
          onClick={onBack}
          className="flex items-center justify-center"
          style={{
            width: "24px",
            height: "24px",
            padding: "0",
            border: "none",
            background: "transparent",
            cursor: "pointer",
          }}
        >
          <ArrowLeft className="w-5 h-5 text-gray-600" />
        </button>

        <h2
          className="flex-1"
          style={{
            alignSelf: "stretch",
            color: "var(--gray-900, #181B1D)",
            fontFamily: "Inter",
            fontSize: "16px",
            fontStyle: "normal",
            fontWeight: "600",
            lineHeight: "normal",
            letterSpacing: "-0.16px",
            textTransform: "capitalize",
          }}
        >
          Email
        </h2>

        <button
          onClick={onBack}
          className="flex items-center justify-center"
          style={{
            width: "24px",
            height: "24px",
            padding: "0",
            border: "none",
            background: "transparent",
            cursor: "pointer",
          }}
        >
          <X className="w-5 h-5 text-gray-600" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="space-y-6">
          {/* Sending From */}
          <div className="space-y-2">
            <Label
              htmlFor="sending-from"
              className="text-sm font-medium text-slate-700"
            >
              Sending from
            </Label>
            <Input
              id="sending-from"
              value={emailConfig.sendingFrom}
              onChange={(e) =>
                setEmailConfig((prev) => ({
                  ...prev,
                  sendingFrom: e.target.value,
                }))
              }
              placeholder="Enter sender email"
              className="w-full bg-gray-100"
              disabled
            />
            <p className="text-xs text-slate-500">Email isn't editable</p>
          </div>

          {/* Add Email Address */}
          <div className="space-y-2">
            <Label
              htmlFor="add-email"
              className="text-sm font-medium text-slate-700"
            >
              Add Email Address
            </Label>
            <div className="relative">
              <Input
                id="add-email"
                value={newEmailAddress}
                onChange={(e) => setNewEmailAddress(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="type email address"
                className="w-full pr-16"
              />
              <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                <span className="text-xs text-slate-400 bg-slate-100 px-2 py-1 rounded">
                  click "enter" to add
                </span>
              </div>
            </div>

            {/* Added Email Addresses */}
            {emailConfig.emailAddresses.length > 0 && (
              <div className="space-y-2 mt-4">
                {emailConfig.emailAddresses.map((email, index) => {
                  // Generate avatar color based on email
                  const avatarColors = [
                    "bg-yellow-400",
                    "bg-pink-500",
                    "bg-blue-500",
                    "bg-green-500",
                    "bg-purple-500",
                    "bg-red-500",
                    "bg-orange-500",
                    "bg-teal-500",
                  ]
                  const colorIndex = email.charCodeAt(0) % avatarColors.length
                  const avatarColor = avatarColors[colorIndex]

                  // Get first letter of email for avatar
                  const firstLetter = email.charAt(0).toUpperCase()

                  return (
                    <div
                      key={index}
                      className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-8 h-8 ${avatarColor} rounded-full flex items-center justify-center text-white font-medium text-sm`}
                        >
                          {firstLetter}
                        </div>
                        <div className="text-sm font-medium text-slate-900">
                          {email}
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemoveEmail(email)}
                        className="p-1 hover:bg-gray-200 rounded transition-colors"
                      >
                        <Trash2 className="w-4 h-4 text-gray-400 hover:text-red-500" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-slate-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <Button
          onClick={handleSave}
          className="w-full bg-black hover:bg-gray-800 text-white"
        >
          Save Configuration
        </Button>
      </div>
    </div>
  )
}

export default EmailConfigUI
