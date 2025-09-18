import * as React from "react"
import { useState } from "react"
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogTrigger,
  DialogFooter 
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
import { cn } from "@/lib/utils"
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
    name: initialData.name || "Unnamed credential 2",
    user: initialData.user || "",
    password: initialData.password || "",
    allowedDomains: initialData.allowedDomains || "All"
  })

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
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
            <Globe2 className="w-4 h-4 text-blue-600" />
          </div>
          <div>
            <h2 className="text-lg font-medium">{formData.name}</h2>
            <p className="text-sm text-gray-500">Basic Auth</p>
          </div>
          <div className="ml-auto">
            <Button 
              onClick={handleSave}
              className="bg-orange-500 hover:bg-orange-600 text-white px-6"
            >
              Save
            </Button>
          </div>
        </div>

        <div className="space-y-6">
          <div className="flex gap-6">
            <div className="w-32 flex-shrink-0">
              <div className="bg-gray-100 rounded px-3 py-2 text-sm text-gray-600">
                Connection
              </div>
            </div>
            <div className="flex-1">
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
                      className="w-full pr-20"
                    />
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                      <span className="text-xs text-gray-500">Fixed</span>
                      <span className="text-xs text-gray-500">Expression</span>
                    </div>
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
        </div>
      </DialogContent>
    </Dialog>
  )
}