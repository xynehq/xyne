import * as React from "react"
import { useState, useEffect } from "react"
import { 
  Dialog, 
  DialogContent, 
  DialogTrigger
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

interface CredentialData {
  name: string
  user: string
  password: string
  allowedDomains: string
}

interface CredentialModalProps {
  children: React.ReactNode
  onSave?: (data: CredentialData) => void
  initialData?: Partial<CredentialData>
}

export function CredentialModal({ 
  children, 
  onSave, 
  initialData = {} 
}: CredentialModalProps) {
  const [open, setOpen] = useState(false)
  const [formData, setFormData] = useState<CredentialData>({
    name: initialData.name || "Unnamed Credential",
    user: initialData.user || "",
    password: initialData.password || "",
    allowedDomains: initialData.allowedDomains || "All"
  })

  // Update form data when initialData changes or modal opens
  useEffect(() => {
    if (open) {
      setFormData({
        name: initialData.name || "Unnamed Credential",
        user: initialData.user || "",
        password: initialData.password || "",
        allowedDomains: initialData.allowedDomains || "All"
      })
    }
  }, [initialData, open])

  const handleSave = () => {
    onSave?.(formData)
    setOpen(false)
  }

  const updateField = (field: keyof CredentialData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children}
      </DialogTrigger>
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
            className="bg-orange-500 hover:bg-orange-600 text-white px-6 flex-shrink-0 mr-6"
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
                  <Input
                    type="password"
                    value={formData.password}
                    onChange={(e) => updateField("password", e.target.value)}
                    placeholder=""
                    className="w-full"
                  />
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
        </div>
      </DialogContent>
    </Dialog>
  )
}