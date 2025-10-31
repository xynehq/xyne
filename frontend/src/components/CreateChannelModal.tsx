import { useState, useEffect } from "react"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"
import { Hash, Lock, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ChannelType } from "@/types"

interface WorkspaceUser {
  id: string
  name: string
  email: string
  photoLink?: string | null
}

interface CreateChannelModalProps {
  isOpen: boolean
  onClose: () => void
  onChannelCreated: (channelId: number) => void
}

export default function CreateChannelModal({
  isOpen,
  onClose,
  onChannelCreated,
}: CreateChannelModalProps) {
  const [channelName, setChannelName] = useState("")
  const [description, setDescription] = useState("")
  const [purpose, setPurpose] = useState("")
  const [channelType, setChannelType] = useState<ChannelType>(
    ChannelType.Public,
  )
  const [selectedMembers, setSelectedMembers] = useState<string[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [memberSearchQuery, setMemberSearchQuery] = useState("")
  const [searchedUsers, setSearchedUsers] = useState<WorkspaceUser[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [errors, setErrors] = useState<{
    name?: string
    description?: string
  }>({})

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setChannelName("")
      setDescription("")
      setPurpose("")
      setChannelType(ChannelType.Public)
      setSelectedMembers([])
      setMemberSearchQuery("")
      setSearchedUsers([])
      setErrors({})
    }
  }, [isOpen])

  // Search users with debouncing
  useEffect(() => {
    const searchUsers = async () => {
      if (memberSearchQuery.trim().length < 2) {
        setSearchedUsers([])
        return
      }

      setIsSearching(true)
      try {
        const response = await api.workspace.users.search.$get({
          query: { q: memberSearchQuery },
        })

        if (response.ok) {
          const data = await response.json()
          setSearchedUsers(data.users || [])
        }
      } catch (error) {
        console.error("Failed to search users:", error)
      } finally {
        setIsSearching(false)
      }
    }

    const debounceTimer = setTimeout(searchUsers, 300)
    return () => clearTimeout(debounceTimer)
  }, [memberSearchQuery])

  // Validate channel name
  const validateChannelName = (name: string): boolean => {
    setErrors((prev) => ({ ...prev, name: undefined }))

    if (!name.trim()) {
      setErrors((prev) => ({ ...prev, name: "Channel name is required" }))
      return false
    }

    if (name.length < 1 || name.length > 80) {
      setErrors((prev) => ({
        ...prev,
        name: "Channel name must be between 1 and 80 characters",
      }))
      return false
    }

    // Channel name should only contain lowercase letters, numbers, hyphens, and underscores
    const validNamePattern = /^[a-z0-9-_]+$/
    if (!validNamePattern.test(name)) {
      setErrors((prev) => ({
        ...prev,
        name: "Channel name can only contain lowercase letters, numbers, hyphens, and underscores",
      }))
      return false
    }

    return true
  }

  // Handle channel name change with auto-formatting
  const handleNameChange = (value: string) => {
    // Convert to lowercase and remove invalid characters
    const formatted = value.toLowerCase().replace(/[^a-z0-9-_]/g, "")
    setChannelName(formatted)

    if (errors.name) {
      validateChannelName(formatted)
    }
  }

  // Toggle member selection
  const toggleMember = (userId: string) => {
    setSelectedMembers((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId],
    )
  }

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Validate
    if (!validateChannelName(channelName)) {
      return
    }

    setIsSubmitting(true)

    try {
      const response = await api.channels.$post({
        json: {
          name: channelName,
          description: description || undefined,
          purpose: purpose || undefined,
          type: channelType,
          memberIds: selectedMembers.length > 0 ? selectedMembers : undefined,
        },
      })

      if (response.ok) {
        const data = await response.json()
        toast({
          title: "Success",
          description: `Channel #${channelName} created successfully`,
        })
        onChannelCreated(data.channel.id)
        onClose()
      } else {
        const error = await response.json()
        toast({
          title: "Error",
          description: error.message || "Failed to create channel",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to create channel:", error)
      toast({
        title: "Error",
        description: "Failed to create channel",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create a channel</DialogTitle>
          <DialogDescription>
            Channels are where your team communicates. They're best when
            organized around a topic — #marketing, for example.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Channel Name */}
          <div className="space-y-2">
            <Label htmlFor="channel-name">
              Channel name <span className="text-red-500">*</span>
            </Label>
            <div className="relative">
              <Hash className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                id="channel-name"
                type="text"
                value={channelName}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g. plan-budget"
                className={`pl-9 ${errors.name ? "border-red-500" : ""}`}
                maxLength={80}
              />
            </div>
            {errors.name && (
              <p className="text-sm text-red-500">{errors.name}</p>
            )}
            <p className="text-xs text-gray-500">
              Use lowercase letters, numbers, hyphens, and underscores
            </p>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Description (optional)</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's this channel about?"
              rows={3}
              maxLength={250}
            />
            <p className="text-xs text-gray-500">
              {description.length}/250 characters
            </p>
          </div>

          {/* Purpose */}
          <div className="space-y-2">
            <Label htmlFor="purpose">Purpose (optional)</Label>
            <Textarea
              id="purpose"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="Why does this channel exist?"
              rows={2}
              maxLength={250}
            />
          </div>

          {/* Channel Type */}
          <div className="space-y-3">
            <Label>Channel type</Label>
            <div className="space-y-2">
              <label className="flex items-start space-x-3 p-3 rounded-lg border hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer">
                <input
                  type="radio"
                  name="channel-type"
                  value={ChannelType.Public}
                  checked={channelType === ChannelType.Public}
                  onChange={() => setChannelType(ChannelType.Public)}
                  className="mt-0.5"
                />
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2 font-medium">
                    <Hash className="h-4 w-4" />
                    <span>Public</span>
                  </div>
                  <p className="text-sm text-gray-500">
                    Anyone in the workspace can find and join this channel
                  </p>
                </div>
              </label>

              <label className="flex items-start space-x-3 p-3 rounded-lg border hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer">
                <input
                  type="radio"
                  name="channel-type"
                  value={ChannelType.Private}
                  checked={channelType === ChannelType.Private}
                  onChange={() => setChannelType(ChannelType.Private)}
                  className="mt-0.5"
                />
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2 font-medium">
                    <Lock className="h-4 w-4" />
                    <span>Private</span>
                  </div>
                  <p className="text-sm text-gray-500">
                    Only invited members can access this channel
                  </p>
                </div>
              </label>
            </div>
          </div>

          {/* Add Members (for private channels or optional for public) */}
          <div className="space-y-3">
            <Label>
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4" />
                <span>Add members (optional)</span>
              </div>
            </Label>
            <div className="space-y-2">
              <Input
                type="text"
                placeholder="Search users by name or email..."
                value={memberSearchQuery}
                onChange={(e) => setMemberSearchQuery(e.target.value)}
              />
              {memberSearchQuery.trim().length > 0 && (
                <div className="border rounded-lg max-h-48 overflow-y-auto">
                  {isSearching ? (
                    <div className="text-center py-4 text-sm text-gray-500">
                      Searching...
                    </div>
                  ) : searchedUsers.length === 0 ? (
                    <div className="text-center py-4 text-sm text-gray-500">
                      {memberSearchQuery.trim().length < 2
                        ? "Type at least 2 characters to search"
                        : "No users found"}
                    </div>
                  ) : (
                    searchedUsers.map((user) => (
                      <label
                        key={user.id}
                        className="flex items-center gap-3 p-3 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer border-b last:border-b-0"
                      >
                        <input
                          type="checkbox"
                          checked={selectedMembers.includes(user.id)}
                          onChange={() => toggleMember(user.id)}
                          className="rounded"
                        />
                        <div className="flex-1">
                          <div className="font-medium text-sm">{user.name}</div>
                          {user.email && (
                            <div className="text-xs text-gray-500">
                              {user.email}
                            </div>
                          )}
                        </div>
                      </label>
                    ))
                  )}
                </div>
              )}
              {selectedMembers.length > 0 && (
                <p className="text-sm text-gray-600">
                  {selectedMembers.length} member
                  {selectedMembers.length !== 1 ? "s" : ""} selected
                </p>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !channelName}>
              {isSubmitting ? "Creating..." : "Create channel"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
