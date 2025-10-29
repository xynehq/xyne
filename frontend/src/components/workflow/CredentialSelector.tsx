import React, { useState, useEffect } from "react"
import { ChevronDown, Plus, AlertTriangle, Edit, Trash2 } from "lucide-react"
import { CredentialModal, type CredentialData } from "../CredentialModal"
import { credentialsAPI, type Credential } from "./api/ApiHandlers"

interface CredentialSelectorProps {
  authType: "basic" | "bearer" | "api_key"
  selectedCredentialId?: string
  onSelect: (credentialId: string | null) => void
  className?: string
  existingCredentials?: any[] // Credentials from tool config
}

export function CredentialSelector({
  authType,
  selectedCredentialId,
  onSelect,
  className = "",
  existingCredentials = []
}: CredentialSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [editingCredential, setEditingCredential] = useState<Credential | null>(null)

  useEffect(() => {
    const fetchCredentials = async () => {
      try {
        // Start with existing credentials from tool config
        let allCredentials: Credential[] = []
        
        // Convert existing credentials from tool config to Credential format
        if (existingCredentials && existingCredentials.length > 0) {
          console.log('🔧 Converting existing credentials from tool config:', existingCredentials)
          const convertedCredentials = existingCredentials.map((toolCred, index) => ({
            id: selectedCredentialId || `tool-cred-${index}`, // Use the selectedCredentialId or generate one
            name: toolCred.name || `${toolCred.user} (Basic Auth)`,
            type: authType,
            user: toolCred.user,
            password: toolCred.password,
            isValid: true,
            allowedDomains: toolCred.allowedDomains
          } as Credential))
          allCredentials = convertedCredentials
          console.log('🔧 Converted tool credentials:', allCredentials)
        }
        
        // Also fetch from API (for new credentials that might be created)
        try {
          const apiCredentials = await credentialsAPI.fetchByType(authType)
          // Merge, avoiding duplicates (prefer tool config credentials)
          const toolCredIds = allCredentials.map(c => c.id)
          const newApiCredentials = apiCredentials.filter(c => !toolCredIds.includes(c.id))
          allCredentials = [...allCredentials, ...newApiCredentials]
          console.log('🔧 Final merged credentials:', allCredentials)
        } catch (apiError) {
          console.log('🔧 API fetch failed, using only tool config credentials:', apiError)
        }
        
        setCredentials(allCredentials)
      } catch (error) {
        console.error('Failed to process credentials:', error)
        setCredentials([])
      }
    }

    fetchCredentials()
  }, [authType, existingCredentials, selectedCredentialId])

  const selectedCredential = credentials.find(cred => cred.id === selectedCredentialId)
  const hasIssues = selectedCredential && !selectedCredential.isValid

  const handleCredentialSelect = (credentialId: string) => {
    onSelect(credentialId)
    setIsOpen(false)
  }


  const handleCreateNew = () => {
    setShowCreateModal(true)
    setIsOpen(false)
  }

  const handleEdit = (credentialId: string, event: React.MouseEvent) => {
    event.stopPropagation()
    const credential = credentials.find(cred => cred.id === credentialId)
    if (credential) {
      setEditingCredential(credential)
      setShowEditModal(true)
    }
  }

  const handleCredentialCreated = async (newCredential: CredentialData) => {
    try {
      const credential = await credentialsAPI.create({
        name: newCredential.name,
        type: authType,
        user: newCredential.user,
        password: newCredential.password,
        allowedDomains: newCredential.allowedDomains
      })

      setCredentials(prev => [...prev, credential])
      onSelect(credential.id)
      setShowCreateModal(false)
    } catch (error) {
      console.error('Failed to create credential:', error)
      // Handle error - maybe show a toast or alert
    }
  }

  const handleCredentialUpdated = async (updatedCredential: CredentialData) => {
    try {
      if (!editingCredential) return
      
      const credential = await credentialsAPI.update(editingCredential.id, {
        name: updatedCredential.name,
        user: updatedCredential.user,
        password: updatedCredential.password,
        allowedDomains: updatedCredential.allowedDomains
      })
      
      setCredentials(prev => prev.map(cred => 
        cred.id === editingCredential.id ? credential : cred
      ))
      setShowEditModal(false)
      setEditingCredential(null)
    } catch (error) {
      console.error('Failed to update credential:', error)
      // Handle error - maybe show a toast or alert
    }
  }

  const handleDelete = async (credentialId: string, credentialName: string, event: React.MouseEvent) => {
    event.stopPropagation()
    
    const confirmed = window.confirm(`Are you sure you want to delete the credential "${credentialName}"? This action cannot be undone.`)
    
    if (!confirmed) return
    
    try {
      await credentialsAPI.delete(credentialId)
      
      // Remove the credential from the list
      setCredentials(prev => prev.filter(cred => cred.id !== credentialId))
      
      // If this was the selected credential, clear the selection
      if (selectedCredentialId === credentialId) {
        onSelect(null)
      }
    } catch (error) {
      console.error('Failed to delete credential:', error)
      alert('Failed to delete credential. Please try again.')
    }
  }

  const getPlaceholderText = () => {
    if (hasIssues) {
      return `Selected credential unavailable: ${selectedCredential?.name}`
    }
    return "Select Credential"
  }

  const getDisplayText = () => {
    if (selectedCredential) {
      return selectedCredential.name
    }
    return getPlaceholderText()
  }

  return (
    <>
      <div className={`relative ${className}`}>
        <div className="flex items-center gap-2">
          <div
            className={`flex-1 px-3 py-2 border rounded-lg cursor-pointer flex items-center justify-between transition-colors ${
              hasIssues 
                ? "border-red-300 bg-red-50 dark:border-red-600 dark:bg-red-900/20" 
                : "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 hover:border-gray-400 dark:hover:border-gray-500"
            } ${isOpen ? "ring-2 ring-blue-500 dark:ring-blue-400" : ""}`}
            onClick={() => setIsOpen(!isOpen)}
          >
            <div className="flex items-center gap-2 flex-1 min-w-0">
              {hasIssues && (
                <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
              )}
              <span className={`text-sm truncate ${
                selectedCredential 
                  ? "text-gray-900 dark:text-gray-100" 
                  : "text-gray-500 dark:text-gray-400"
              }`}>
                {getDisplayText()}
              </span>
            </div>
            <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${
              isOpen ? "rotate-180" : ""
            }`} />
          </div>
          
          {/* Edit and Delete Buttons - Only show when a credential is selected */}
          {selectedCredential && (
            <div className="flex gap-2">
              <button
                onClick={(e) => handleEdit(selectedCredential.id, e)}
                className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors flex-shrink-0 border border-gray-300 dark:border-gray-600"
                title="Edit credential"
              >
                <Edit className="w-4 h-4" />
              </button>
              <button
                onClick={(e) => handleDelete(selectedCredential.id, selectedCredential.name, e)}
                className="p-2 text-gray-500 hover:text-red-700 dark:text-gray-400 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-colors flex-shrink-0 border border-gray-300 dark:border-gray-600"
                title="Delete credential"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* Dropdown */}
        {isOpen && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg z-50 max-h-60 overflow-y-auto" style={{ right: selectedCredential ? '6rem' : '0' }}>
            {/* Existing Credentials */}
            {credentials.length > 0 ? (
              <div className="py-1">
                {credentials.map((credential) => (
                  <div
                    key={credential.id}
                    className="px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer flex items-center gap-2"
                    onClick={() => handleCredentialSelect(credential.id)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {credential.name}
                      </div>
                      {credential.user && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                          User: {credential.user}
                        </div>
                      )}
                    </div>
                    {!credential.isValid && (
                      <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
                    )}
                  </div>
                ))}
                <div className="border-t border-gray-200 dark:border-gray-600" />
              </div>
            ) : (
              <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                No {authType} credentials found
              </div>
            )}

            {/* Create New Credential Footer */}
            <div
              className="px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer flex items-center gap-2 border-t border-gray-200 dark:border-gray-600"
              onClick={handleCreateNew}
            >
              <div className="w-4 h-4 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center">
                <Plus className="w-3 h-3 text-blue-600 dark:text-blue-400" />
              </div>
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Create new credential
              </span>
            </div>
          </div>
        )}

        {/* Click outside to close */}
        {isOpen && (
          <div 
            className="fixed inset-0 z-40" 
            onClick={() => setIsOpen(false)}
          />
        )}
      </div>

      {/* Controlled CredentialModal for creating new credentials */}
      <CredentialModal
        open={showCreateModal}
        onOpenChange={setShowCreateModal}
        onSave={handleCredentialCreated}
        initialData={{ name: "" }}
      />

      {/* Controlled CredentialModal for editing existing credentials */}
      {editingCredential && (
        <CredentialModal
          open={showEditModal}
          onOpenChange={setShowEditModal}
          onSave={handleCredentialUpdated}
          initialData={{
            name: editingCredential.name,
            user: editingCredential.user || "",
            password: "", // Don't pre-fill password for security
            allowedDomains: editingCredential.allowedDomains || "All"
          }}
        />
      )}
    </>
  )
}