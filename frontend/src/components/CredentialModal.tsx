import { useState, useEffect } from "react"
import { 
  Dialog, 
  DialogContent
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from "@/components/ui/select"
import { Globe2 } from "lucide-react"

export interface CredentialData {
  name: string
  user: string
  password: string
  allowedDomains: string
}

interface CredentialModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave?: (data: CredentialData) => void
  initialData?: Partial<CredentialData>
  variant?: "minimal" | "full" // Controls UI features
}

export function CredentialModal({ 
  open,
  onOpenChange,
  onSave, 
  initialData = {},
  variant = "minimal"
}: CredentialModalProps) {
  const [formData, setFormData] = useState<CredentialData>({
    name: initialData.name || "",
    user: initialData.user || "",
    password: initialData.password || "",
    allowedDomains: initialData.allowedDomains || "All"
  })

  // Generate credential name based on user input
  const generateCredentialName = (user: string) => {
    if (!user.trim()) return "Unnamed Credential"
    
    // If it looks like an email, use the username part
    if (user.includes('@')) {
      const username = user.split('@')[0]
      return `${username} (Basic Auth)`
    }
    
    // Otherwise use the username directly
    return `${user} (Basic Auth)`
  }

  // Update form data when initialData changes or modal opens
  useEffect(() => {
    if (open) {
      const name = initialData.name || (initialData.user ? generateCredentialName(initialData.user) : "Unnamed Credential")
      setFormData({
        name: name,
        user: initialData.user || "",
        password: initialData.password || "",
        allowedDomains: initialData.allowedDomains || "All"
      })
    }
  }, [initialData, open])

  const handleSave = () => {
    onSave?.(formData)
    onOpenChange(false)
  }

  const updateField = (field: keyof CredentialData, value: string) => {
    setFormData(prev => {
      const newData = { ...prev, [field]: value }
      
      // Auto-update credential name when user field changes (only if name wasn't manually edited)
      if (field === 'user' && (!initialData.name || prev.name === generateCredentialName(prev.user) || prev.name === "Unnamed Credential")) {
        newData.name = generateCredentialName(value)
      }
      
      return newData
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <div className="flex items-start justify-between gap-4 mb-6 pr-12">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
              <Globe2 className="w-4 h-4 text-blue-600" />
            </div>
            <div className="flex-1 min-w-0">
              <input
                type="text"
                value={formData.name}
                onChange={(e) => updateField("name", e.target.value)}
                onFocus={(e) => {
                  // Prevent auto-selection of text on focus
                  setTimeout(() => {
                    e.target.setSelectionRange(e.target.value.length, e.target.value.length)
                  }, 0)
                }}
                onMouseUp={(e) => {
                  // Prevent text selection on mouse up
                  e.preventDefault()
                }}
                className="text-lg font-medium bg-transparent border-none outline-none w-full p-0 text-gray-900 dark:text-gray-100 focus:ring-0"
                placeholder="Enter text..."
                autoFocus={false}
              />
              <p className="text-sm text-gray-500">Basic Auth</p>
            </div>
          </div>
          <Button 
            onClick={handleSave}
            className="bg-gray-900 hover:bg-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 text-white px-6 flex-shrink-0 mr-6 rounded-full"
          >
            Save
          </Button>
        </div>

        <div className="space-y-6">
          <div className="flex gap-6">
            <div className="w-32 flex-shrink-0">
              <div className="bg-gray-100 rounded px-3 py-2 text-sm text-gray-600">
                Connection
              </div>
            </div>
            <div className="flex-1">
              {variant === "full" && (
                <>
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-yellow-700">
                        Need help filling out these fields?
                      </span>
                      <button className="text-sm text-yellow-700 underline hover:no-underline">
                        Open docs
                      </button>
                    </div>
                  </div>
                  
                  <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 mb-6">
                    <div className="flex items-center gap-2">
                      <span className="text-purple-700 text-sm">✨ Ask Assistant</span>
                      <span className="text-sm text-purple-600">for setup instructions</span>
                    </div>
                  </div>
                </>
              )}

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    User
                  </label>
                  <Input
                    value={formData.user}
                    onChange={(e) => updateField("user", e.target.value)}
                    placeholder=""
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Password
                  </label>
                  <div className="relative">
                    <Input
                      type="password"
                      value={formData.password}
                      onChange={(e) => updateField("password", e.target.value)}
                      placeholder=""
                      className={variant === "full" ? "w-full pr-20" : "w-full"}
                    />
                    {variant === "full" && (
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                        <span className="text-xs text-gray-500">Fixed</span>
                        <span className="text-xs text-gray-500">Expression</span>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Allowed HTTP Request Domains
                  </label>
                  <Select 
                    value={formData.allowedDomains} 
                    onValueChange={(value) => updateField("allowedDomains", value)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="All">All</SelectItem>
                      <SelectItem value="Custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </div>

          {variant === "full" && (
            <div className="border-l-4 border-blue-200 pl-4">
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <span className="w-4 h-4 rounded-full border border-gray-300 flex items-center justify-center">
                  <span className="text-xs">ℹ</span>
                </span>
                <span>Enterprise plan users can pull in credentials from external vaults.</span>
                <button className="text-blue-600 underline hover:no-underline">
                  More info
                </button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}