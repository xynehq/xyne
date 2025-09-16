import React, { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ArrowLeft, X, Trash2, CornerDownLeft, AlertCircle, CheckCircle } from "lucide-react"
import { workflowToolsAPI } from "./api/ApiHandlers"

interface EmailConfigUIProps {
  isVisible: boolean
  onBack: () => void
  onClose?: () => void // New prop for closing all sidebars
  onSave?: (emailConfig: EmailConfig) => void
  toolData?: any
  toolId?: string // Tool ID for API updates
  stepData?: any // Step data for loading existing configuration
  showBackButton?: boolean // Whether to show the back button
  builder?: boolean
}

export interface EmailConfig {
  sendingFrom: string
  emailAddresses: string[]
}

const EmailConfigUI: React.FC<EmailConfigUIProps> = ({
  isVisible,
  onBack,
  onClose,
  onSave,
  toolData,
  toolId,
  stepData,
  showBackButton = false,
  builder = true,
}) => {
  const [emailConfig, setEmailConfig] = useState<EmailConfig>({
    sendingFrom: "no-reply@xyne.io",
    emailAddresses: [],
  })

  const [newEmailAddress, setNewEmailAddress] = useState("")
  const [emailValidationError, setEmailValidationError] = useState<string | null>(null)
  const [isEmailValid, setIsEmailValid] = useState<boolean>(false)

  // Email validation regex - comprehensive pattern for email validation
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

  // Validate email function
  const validateEmail = (email: string): { isValid: boolean; error: string | null } => {
    if (!email.trim()) {
      return { isValid: false, error: null }
    }
    
    if (email.length > 254) {
      return { isValid: false, error: "Email address is too long (max 254 characters)" }
    }
    
    if (!emailRegex.test(email)) {
      return { isValid: false, error: "Please enter a valid email address" }
    }
    
    // Additional checks
    const [localPart, domain] = email.split('@')
    
    if (localPart.length > 64) {
      return { isValid: false, error: "Email local part is too long (max 64 characters)" }
    }
    
    if (domain.length > 253) {
      return { isValid: false, error: "Email domain is too long (max 253 characters)" }
    }
    
    // Check for consecutive dots
    if (email.includes('..')) {
      return { isValid: false, error: "Email cannot contain consecutive dots" }
    }
    
    // Check if email starts or ends with dot
    if (localPart.startsWith('.') || localPart.endsWith('.')) {
      return { isValid: false, error: "Email cannot start or end with a dot" }
    }
    
    return { isValid: true, error: null }
  }

  // Handle email input change with validation
  const handleEmailInputChange = (value: string) => {
    setNewEmailAddress(value)
    const validation = validateEmail(value)
    setIsEmailValid(validation.isValid)
    setEmailValidationError(validation.error)
  }

  // Load existing data or reset to defaults when component becomes visible
  React.useEffect(() => {
    if (isVisible) {
      // Try to load from stepData.config first, then toolData, otherwise use defaults
      let existingConfig = null
      
      if (stepData?.config) {
        existingConfig = stepData.config
      } else if (toolData?.value || toolData?.config) {
        existingConfig = toolData.value || toolData.config || {}
      }
      
      if (existingConfig) {
        setEmailConfig({
          sendingFrom: existingConfig.sendingFrom || "no-reply@xyne.io",
          emailAddresses: existingConfig.emailAddresses || existingConfig.to_email || [],
        })
      } else {
        // Reset to defaults for new Email
        setEmailConfig({
          sendingFrom: "no-reply@xyne.io",
          emailAddresses: [],
        })
      }
      setNewEmailAddress("")
      setEmailValidationError(null)
      setIsEmailValid(false)
    }
  }, [isVisible, toolData, stepData])

  const handleAddEmail = () => {
    const validation = validateEmail(newEmailAddress)
    
    if (!validation.isValid) {
      setEmailValidationError(validation.error || "Please enter a valid email address")
      setIsEmailValid(false)
      return
    }
    
    if (emailConfig.emailAddresses.includes(newEmailAddress.toLowerCase())) {
      setEmailValidationError("This email address is already added")
      setIsEmailValid(false)
      return
    }
    
    // Add the email (normalize to lowercase for consistency)
    setEmailConfig((prev) => ({
      ...prev,
      emailAddresses: [...prev.emailAddresses, newEmailAddress.toLowerCase()],
    }))
    
    // Reset input and validation state
    setNewEmailAddress("")
    setEmailValidationError(null)
    setIsEmailValid(false)
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
      e.preventDefault()
      handleAddEmail()
    }
  }

  const handleSave = async () => {
    try {
      // If we have a toolId and not in builder mode, update the tool via API
      if (toolId && !builder) {
        const updatedToolData = {
          type: "email",
          value: emailConfig,
          config: {
            ...toolData?.config,
            to_email: emailConfig.emailAddresses,
            from_email: emailConfig.sendingFrom,
          },
        }

        await workflowToolsAPI.updateTool(toolId, updatedToolData)
        console.log("Email tool updated successfully")
      }

      // Call the parent save handler
      onSave?.(emailConfig)
    } catch (error) {
      console.error("Failed to save email configuration:", error)
      // Still call the parent handler even if API call fails
      onSave?.(emailConfig)
    }
  }

  return (
    <div
      className={`fixed top-[80px] right-0 h-[calc(100vh-80px)] bg-white dark:bg-gray-900 border-l border-slate-200 dark:border-gray-700 flex flex-col overflow-hidden z-50 ${
        isVisible ? "translate-x-0 w-[380px]" : "translate-x-full w-0"
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
        {showBackButton && (
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
            <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-400" />
          </button>
        )}

        <h2
          className="flex-1 text-gray-900 dark:text-gray-100"
          style={{
            alignSelf: "stretch",
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
          onClick={onClose || onBack}
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
          <X className="w-5 h-5 text-gray-600 dark:text-gray-400" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col">
        <div className="space-y-6 flex-1">
          {/* Sending From */}
          <div className="space-y-2">
            <Label
              htmlFor="sending-from"
              className="text-sm font-medium text-slate-700 dark:text-gray-300"
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
              className="w-full bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600"
              disabled
            />
            <p className="text-xs text-slate-500 dark:text-gray-400">Email isn't editable</p>
          </div>

          {/* Add Email Address */}
          <div className="space-y-2">
            <Label
              htmlFor="add-email"
              className="text-sm font-medium text-slate-700 dark:text-gray-300"
            >
              Add Email Address
            </Label>
            <div className="relative">
              <Input
                id="add-email"
                value={newEmailAddress}
                onChange={(e) => handleEmailInputChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="type email address"
                className={`w-full pr-16 dark:bg-gray-800 dark:text-gray-300 ${
                  emailValidationError
                    ? "border-red-500 dark:border-red-400 focus:border-red-500 dark:focus:border-red-400"
                    : isEmailValid && newEmailAddress
                    ? "border-green-500 dark:border-green-400 focus:border-green-500 dark:focus:border-green-400"
                    : "dark:border-gray-600"
                }`}
              />
              <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                <div className="flex items-center justify-center w-6 h-6">
                  {emailValidationError ? (
                    <AlertCircle className="w-4 h-4 text-red-500 dark:text-red-400" />
                  ) : isEmailValid && newEmailAddress ? (
                    <CheckCircle className="w-4 h-4 text-green-500 dark:text-green-400" />
                  ) : (
                    <CornerDownLeft className="w-4 h-4 text-slate-400 dark:text-gray-500" />
                  )}
                </div>
              </div>
            </div>
            
            {/* Email validation feedback */}
            {emailValidationError && (
              <div className="flex items-center gap-2 mt-2">
                <AlertCircle className="w-4 h-4 text-red-500 dark:text-red-400 flex-shrink-0" />
                <p className="text-sm text-red-600 dark:text-red-400">
                  {emailValidationError}
                </p>
              </div>
            )}
            
            {isEmailValid && newEmailAddress && !emailValidationError && (
              <div className="flex items-center gap-2 mt-2">
                <CheckCircle className="w-4 h-4 text-green-500 dark:text-green-400 flex-shrink-0" />
                <p className="text-sm text-green-600 dark:text-green-400">
                  Valid email address
                </p>
              </div>
            )}
            
            {newEmailAddress && !isEmailValid && !emailValidationError && (
              <div className="mt-2">
                <p className="text-sm text-slate-500 dark:text-gray-400">
                  Enter a valid email address
                </p>
              </div>
            )}

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
                      className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-8 h-8 ${avatarColor} rounded-full flex items-center justify-center text-white font-medium text-sm`}
                        >
                          {firstLetter}
                        </div>
                        <div className="text-sm font-medium text-slate-900 dark:text-gray-300">
                          {email}
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemoveEmail(email)}
                        className="p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
                      >
                        <Trash2 className="w-4 h-4 text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
        
        {/* Save Button - Sticky to bottom */}
        <div className="pt-6 px-0">
          {emailConfig.emailAddresses.length === 0 && (
            <p className="text-xs text-slate-500 dark:text-gray-400 mb-2 text-center">
              Add at least one email address to enable save
            </p>
          )}
          <Button
            onClick={handleSave}
            disabled={emailConfig.emailAddresses.length === 0}
            className={`w-full rounded-full shadow-none ${
              emailConfig.emailAddresses.length === 0
                ? "bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-not-allowed hover:bg-gray-100 dark:hover:bg-gray-800"
                : "bg-gray-900 hover:bg-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 text-white"
            }`}
          >
            Save Configuration
          </Button>
        </div>
      </div>
    </div>
  )
}

export default EmailConfigUI
