import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { X, Plus, Trash2, AlertCircle, Users, UserPlus, Shield, ExternalLink } from "lucide-react"
import { api } from "../../api"
import { WorkflowTemplate } from "./Types"

interface User {
  id: number
  name: string
  email: string
}

interface WorkflowUser {
  id: number
  userId: number
  workflowId: number
  role: string
  createdAt: string
  updatedAt: string
  user: {
    externalId: string
    email: string
    name: string
    photoLink?: string
  }
  workflow: {
    externalId: string
    name: string
    description?: string
    version: string
  }
}

interface WorkflowShareModalProps {
  isOpen: boolean
  onClose: () => void
  workflow: WorkflowTemplate
  onSuccess?: () => void
}

export function WorkflowShareModal({
  isOpen,
  onClose,
  workflow,
  onSuccess,
}: WorkflowShareModalProps) {
  const [newEmail, setNewEmail] = useState("")
  const [emails, setEmails] = useState<string[]>([])
  const [emailValidationError, setEmailValidationError] = useState<
    string | null
  >(null)
  const [isEmailValid, setIsEmailValid] = useState<boolean>(false)
  const [isLoading, setIsLoading] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  
  // Unauthorized agents popup state
  const [showUnauthorizedAgentsPopup, setShowUnauthorizedAgentsPopup] = useState(false)
  const [unauthorizedAgents, setUnauthorizedAgents] = useState<{
    agentId: string
    agentName: string
    toolId: string
    missingUserEmails: string[]
  }[]>([])
  
  // Current workflow users
  const [currentUsers, setCurrentUsers] = useState<WorkflowUser[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [removedUserEmails, setRemovedUserEmails] = useState<string[]>([])

  // User autocomplete states
  const [users, setUsers] = useState<User[]>([])
  const [filteredUsers, setFilteredUsers] = useState<User[]>([])
  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(-1)
  const autocompleteRef = useRef<HTMLDivElement>(null)

  // Email validation regex - comprehensive pattern for email validation
  const emailRegex =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

  // Validate email function
  const validateEmail = (
    email: string,
  ): { isValid: boolean; error: string | null } => {
    if (!email.trim()) {
      return { isValid: false, error: null }
    }

    if (email.length > 254) {
      return {
        isValid: false,
        error: "Email address is too long (max 254 characters)",
      }
    }

    if (!emailRegex.test(email)) {
      return { isValid: false, error: "Please enter a valid email address" }
    }

    // Additional checks
    const [localPart, domain] = email.split("@")

    if (localPart.length > 64) {
      return {
        isValid: false,
        error: "Email local part is too long (max 64 characters)",
      }
    }

    if (domain.length > 253) {
      return {
        isValid: false,
        error: "Email domain is too long (max 253 characters)",
      }
    }

    // Check for consecutive dots
    if (email.includes("..")) {
      return { isValid: false, error: "Email cannot contain consecutive dots" }
    }

    // Check if email starts or ends with dot
    if (localPart.startsWith(".") || localPart.endsWith(".")) {
      return { isValid: false, error: "Email cannot start or end with a dot" }
    }

    return { isValid: true, error: null }
  }

  // Load workspace users and current workflow users
  useEffect(() => {
    const loadUsers = async () => {
      try {
        const response = await api.workspace.users.$get()
        if (response.ok) {
          const data = await response.json()
          setUsers(data as User[])
        }
      } catch (error) {
        console.error("Failed to fetch workspace users:", error)
      }
    }

    const loadCurrentWorkflowUsers = async () => {
      setLoadingUsers(true)
      try {
        const response = await api.workflow.templates[workflow.id].permissions.$get()
        if (response.ok) {
          const data = await response.json()
          if (data.success) {
            setCurrentUsers(data.data.users || [])
          }
        } else {
          console.error("Failed to fetch workflow users:", await response.text())
        }
      } catch (error) {
        console.error("Failed to fetch workflow users:", error)
      } finally {
        setLoadingUsers(false)
      }
    }

    if (isOpen) {
      loadUsers()
      loadCurrentWorkflowUsers()
    }
  }, [isOpen, workflow.id])

  // Filter users based on search query
  useEffect(() => {
    if (newEmail.trim() === "") {
      setFilteredUsers([])
      setShowAutocomplete(false)
    } else {
      const filtered = users.filter(
        (user) =>
          !emails.includes(user.email.toLowerCase()) &&
          (user.name.toLowerCase().includes(newEmail.toLowerCase()) ||
            user.email.toLowerCase().includes(newEmail.toLowerCase())),
      )
      setFilteredUsers(filtered)
      setShowAutocomplete(filtered.length > 0)
    }
    setSelectedSearchIndex(-1)
  }, [newEmail, users, emails])

  // Handle keyboard navigation in autocomplete
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        setSelectedSearchIndex((prev) =>
          prev >= filteredUsers.length - 1 ? 0 : prev + 1,
        )
        break
      case "ArrowUp":
        e.preventDefault()
        setSelectedSearchIndex((prev) =>
          prev <= 0 ? filteredUsers.length - 1 : prev - 1,
        )
        break
      case "Enter":
        e.preventDefault()
        if (filteredUsers.length > 0 && selectedSearchIndex >= 0) {
          handleSelectUser(filteredUsers[selectedSearchIndex])
        } else if (filteredUsers.length > 0) {
          handleSelectUser(filteredUsers[0])
        } else {
          handleAddEmail()
        }
        break
      case "Escape":
        setShowAutocomplete(false)
        setSelectedSearchIndex(-1)
        break
    }
  }

  // Handle user selection from autocomplete
  const handleSelectUser = (user: User) => {
    setEmails((prev) => [...prev, user.email.toLowerCase()])
    setNewEmail("")
    setEmailValidationError(null)
    setIsEmailValid(false)
    setShowAutocomplete(false)
  }

  // Auto-scroll selected item into view
  useEffect(() => {
    if (selectedSearchIndex >= 0 && autocompleteRef.current) {
      const container = autocompleteRef.current
      const selectedElement = container.children[
        selectedSearchIndex
      ] as HTMLElement

      if (selectedElement) {
        const containerRect = container.getBoundingClientRect()
        const elementRect = selectedElement.getBoundingClientRect()

        if (elementRect.bottom > containerRect.bottom) {
          selectedElement.scrollIntoView({ behavior: "smooth", block: "end" })
        } else if (elementRect.top < containerRect.top) {
          selectedElement.scrollIntoView({ behavior: "smooth", block: "start" })
        }
      }
    }
  }, [selectedSearchIndex])

  // Handle email input change with validation
  const handleEmailInputChange = (value: string) => {
    setNewEmail(value)
    const validation = validateEmail(value)
    setIsEmailValid(validation.isValid)
    setEmailValidationError(validation.error)
  }

  // Add email to list
  const handleAddEmail = () => {
    const validation = validateEmail(newEmail)

    if (!validation.isValid) {
      setEmailValidationError(
        validation.error || "Please enter a valid email address",
      )
      setIsEmailValid(false)
      return
    }

    if (emails.includes(newEmail.toLowerCase())) {
      setEmailValidationError("This email address is already added")
      setIsEmailValid(false)
      return
    }

    // Check if email exists in workspace users
    const emailInWorkspace = users.some(
      (user) => user.email.toLowerCase() === newEmail.toLowerCase(),
    )
    if (!emailInWorkspace) {
      setEmailValidationError(
        "This email address is not found in your workspace",
      )
      setIsEmailValid(false)
      return
    }

    // Add the email (normalize to lowercase for consistency)
    setEmails((prev) => [...prev, newEmail.toLowerCase()])

    // Reset input and validation state
    setNewEmail("")
    setEmailValidationError(null)
    setIsEmailValid(false)
  }

  // Remove email from list
  const handleRemoveEmail = (emailToRemove: string) => {
    setEmails((prev) => prev.filter((email) => email !== emailToRemove))
  }

  // Remove user from current permissions (mark for removal)
  const handleRemoveCurrentUser = (userEmail: string) => {
    setRemovedUserEmails((prev) => [...prev, userEmail.toLowerCase()])
    // Also remove from emails list if they were added
    setEmails((prev) => prev.filter((email) => email !== userEmail.toLowerCase()))
  }

  // Handle enter key press for adding email
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      handleAddEmail()
    }
  }

  // Reset modal state when opened
  useEffect(() => {
    if (isOpen) {
      setEmails([])
      setNewEmail("")
      setEmailValidationError(null)
      setIsEmailValid(false)
      setSubmitError(null)
      setRemovedUserEmails([])
    }
  }, [isOpen])

  // Helper function to get role badge color
  const getRoleColor = (role: string) => {
    switch (role.toLowerCase()) {
      case 'owner':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
      case 'editor':
        return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
      case 'viewer':
        return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
      default:
        return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
    }
  }

  // Submit the share request
  const handleSubmit = async () => {
    // Calculate final list of users: current users (not removed) + new emails
    const currentUserEmails = currentUsers
      .filter(user => !removedUserEmails.includes(user.user.email.toLowerCase()))
      .map(user => user.user.email.toLowerCase())
    
    const finalUserEmails = [...new Set([...currentUserEmails, ...emails])]
    
    if (finalUserEmails.length === 0 && removedUserEmails.length === 0) {
      setSubmitError("Please add at least one email address or make changes to existing permissions")
      return
    }

    setIsLoading(true)
    setSubmitError(null)

    try {
      // Update the workflow template with the final user emails list
      const response = await api.workflow.templates[workflow.id].$put({
        json: {
          userEmails: finalUserEmails,
        },
      })

      if (response.ok) {
        // Success - call callback and close modal
        onSuccess?.()
        onClose()
        return
      }

      // Handle different error responses
      if (response.status === 403) {
        const errorData = await response.json()
        
        // Check if this is an unauthorized agents error
        if (errorData.details?.unauthorizedAgents) {
          setUnauthorizedAgents(errorData.details.unauthorizedAgents)
          setShowUnauthorizedAgentsPopup(true)
          return
        }
      }

      // Handle other errors
      const errorText = await response.text()
      throw new Error(`Failed to share workflow: ${errorText}`)

    } catch (error) {
      console.error("Failed to share workflow:", error)
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Failed to share workflow. Please try again.",
      )
    } finally {
      setIsLoading(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl max-w-lg w-full mx-4 relative">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors z-10"
        >
          <X className="w-6 h-6 text-gray-500 dark:text-gray-400" />
        </button>

        {/* Header */}
        <div className="p-6 pb-4">
          {/* Title */}
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Share Workflow
          </h2>

          {/* Workflow Info */}
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-blue-25 dark:bg-blue-900/15 rounded-lg flex items-center justify-center">
              <Users className="w-5 h-5 text-blue-400 dark:text-blue-300" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {workflow?.name}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Workflow
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 pb-6">
          {/* Current Users Section */}
          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              People with access ({currentUsers.length})
            </h3>
            
            {loadingUsers ? (
              <div className="flex items-center justify-center py-4">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                <span className="ml-2 text-sm text-gray-500">Loading users...</span>
              </div>
            ) : currentUsers.length === 0 ? (
              <div className="text-center py-4">
                <Users className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                <p className="text-sm text-gray-500">No users found</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-32 overflow-y-auto">
                {currentUsers
                  .filter(userPermission => !removedUserEmails.includes(userPermission.user.email.toLowerCase()))
                  .map((userPermission) => (
                  <div
                    key={userPermission.id}
                    className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-800 rounded-lg"
                  >
                    <div className="flex items-center gap-2">
                      {userPermission.user.photoLink ? (
                        <img
                          src={userPermission.user.photoLink}
                          alt={userPermission.user.name}
                          className="w-6 h-6 rounded-full"
                        />
                      ) : (
                        <div className="w-6 h-6 bg-gray-300 dark:bg-gray-600 rounded-full flex items-center justify-center">
                          <span className="text-xs text-gray-600 dark:text-gray-300">
                            {userPermission.user.name?.charAt(0) || userPermission.user.email.charAt(0)}
                          </span>
                        </div>
                      )}
                      
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {userPermission.user.name || userPermission.user.email}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {userPermission.user.email}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${getRoleColor(userPermission.role)}`}>
                        {userPermission.role}
                      </span>
                      {userPermission.role.toLowerCase() !== 'owner' && (
                        <button
                          onClick={() => handleRemoveCurrentUser(userPermission.user.email)}
                          className="p-1 hover:bg-red-100 dark:hover:bg-red-900/20 rounded transition-colors"
                          title="Remove user access"
                        >
                          <X className="w-3 h-3 text-gray-500 dark:text-red-400" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="border-t border-gray-200 dark:border-gray-700 mb-6"></div>
          {/* Email Input */}
          <div className="space-y-2 mb-4">
            <label
              htmlFor="email-input"
              className="block text-xs font-medium text-gray-700 dark:text-gray-300"
            >
              Add Email Address
            </label>
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <input
                  id="email-input"
                  type="email"
                  value={newEmail}
                  onChange={(e) => handleEmailInputChange(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onKeyPress={handleKeyPress}
                  placeholder="Search users by name or email..."
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100"
                />

                {/* Autocomplete Dropdown */}
                {showAutocomplete && (
                  <div className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg max-h-32 overflow-y-auto">
                    <div ref={autocompleteRef} className="py-0.5">
                      {filteredUsers.map((user, index) => (
                        <div
                          key={user.id}
                          onClick={() => handleSelectUser(user)}
                          className={`flex items-center justify-between px-2 py-1.5 cursor-pointer ${
                            index === selectedSearchIndex
                              ? "bg-blue-50 dark:bg-blue-900/30"
                              : "hover:bg-gray-50 dark:hover:bg-gray-700"
                          }`}
                        >
                          <div className="flex items-center space-x-1.5 min-w-0 flex-1 pr-1">
                            <span className="text-xs text-gray-900 dark:text-gray-100 truncate">
                              {user.name}
                            </span>
                            <span className="text-gray-400 flex-shrink-0 text-xs">
                              -
                            </span>
                            <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                              {user.email}
                            </span>
                          </div>
                          <UserPlus className="w-3 h-3 text-gray-400 flex-shrink-0" />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {emailValidationError && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {emailValidationError}
                  </p>
                )}
              </div>
              <Button
                onClick={handleAddEmail}
                disabled={!isEmailValid || !newEmail.trim()}
                size="sm"
                className="px-3 py-1.5 h-7 bg-blue-400 hover:bg-blue-500 hover:border-blue-500 text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-xs"
              >
                <Plus className="w-3 h-3" />
              </Button>
            </div>
          </div>

          {/* Email List */}
          {emails.length > 0 && (
            <div className="space-y-3 mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Added Users ({emails.length})
              </label>
              <div className="space-y-2 max-h-32 overflow-y-auto">
                {emails.map((email, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-800 rounded-lg"
                  >
                    <span className="text-sm text-gray-900 dark:text-gray-100">
                      {email}
                    </span>
                    <button
                      onClick={() => handleRemoveEmail(email)}
                      className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
                    >
                      <Trash2 className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Error Display */}
          {submitError && (
            <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-red-700 dark:text-red-300">
                  {submitError}
                </p>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
            <Button
              onClick={onClose}
              variant="outline"
              className="flex-1"
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
              disabled={isLoading || (emails.length === 0 && removedUserEmails.length === 0)}
            >
              {isLoading ? "Sharing..." : "Share Workflow"}
            </Button>
          </div>
        </div>
      </div>
      
      {/* Unauthorized Agents Popup */}
      {showUnauthorizedAgentsPopup && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl max-w-2xl w-full mx-4 relative max-h-[80vh] overflow-hidden">
            {/* Close Button */}
            <button
              onClick={() => setShowUnauthorizedAgentsPopup(false)}
              className="absolute top-4 right-4 p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors z-10"
            >
              <X className="w-6 h-6 text-gray-500 dark:text-gray-400" />
            </button>

            {/* Header */}
            <div className="p-6 pb-4 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 bg-red-100 dark:bg-red-900/30 rounded-lg flex items-center justify-center">
                  <Shield className="w-5 h-5 text-red-600 dark:text-red-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                    Agent Access Required
                  </h2>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Some agents in this workflow cannot be shared
                  </p>
                </div>
              </div>
            </div>

            {/* Content */}
            <div className="p-6 overflow-y-auto max-h-[60vh]">
              <div className="mb-4">
                <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-amber-800 dark:text-amber-200 mb-1">
                        Cannot share workflow
                      </p>
                      <p className="text-sm text-amber-700 dark:text-amber-300">
                        This workflow contains AI agents that are not accessible to some of the users you're trying to share with. To share this workflow, those users need access to the following agents:
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Unauthorized Agents List */}
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Restricted Agents ({unauthorizedAgents.length})
                </h3>
                
                {unauthorizedAgents.map((agent, index) => (
                  <div key={index} className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
                          <Shield className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                        </div>
                        <div>
                          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                            {agent.agentName}
                          </h4>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            Agent ID: {agent.agentId}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          // Open agent edit page in a new tab
                          window.open(`/agent?agentId=${agent.agentId}&mode=edit`, '_blank')
                        }}
                        className="flex items-center gap-1 px-2 py-1 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors"
                      >
                        <span>Manage Access</span>
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    </div>
                    
                    <div className="mb-3">
                      <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">
                        Users who need access:
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {agent.missingUserEmails.map((email, emailIndex) => (
                          <span
                            key={emailIndex}
                            className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
                          >
                            {email}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Instructions */}
              <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                <h4 className="text-sm font-medium text-blue-900 dark:text-blue-100 mb-2">
                  How to resolve this:
                </h4>
                <ol className="text-sm text-blue-800 dark:text-blue-200 space-y-1 list-decimal list-inside">
                  <li>Click "Manage Access" next to each restricted agent</li>
                  <li>Grant access to the listed users for each agent</li>
                  <li>Return to this workflow and try sharing again</li>
                </ol>
              </div>
            </div>

            {/* Footer */}
            <div className="p-6 pt-4 border-t border-gray-200 dark:border-gray-700">
              <div className="flex gap-3">
                <Button
                  onClick={() => setShowUnauthorizedAgentsPopup(false)}
                  variant="outline"
                  className="flex-1"
                >
                  Close
                </Button>
                <Button
                  onClick={() => {
                    setShowUnauthorizedAgentsPopup(false)
                  }}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
                >
                  Done
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
