import { useState, useEffect } from "react"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"
import { Settings, Hash, Lock, Archive, Trash2, LogOut } from "lucide-react"
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
import { ConfirmModal } from "@/components/ui/confirmModal"
import type { Channel, ChannelMemberRole } from "@/types"

interface ChannelSettingsProps {
  isOpen: boolean
  onClose: () => void
  channel: Channel
  onChannelUpdated: () => void
  onChannelLeft: () => void
  onChannelDeleted: () => void
  currentUserRole: ChannelMemberRole
}

export default function ChannelSettings({
  isOpen,
  onClose,
  channel,
  onChannelUpdated,
  onChannelLeft,
  onChannelDeleted,
  currentUserRole,
}: ChannelSettingsProps) {
  const [channelName, setChannelName] = useState(channel.name)
  const [description, setDescription] = useState(channel.description || "")
  const [purpose, setPurpose] = useState(channel.purpose || "")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false)
  const [errors, setErrors] = useState<{ name?: string }>({})

  // Update form when channel changes
  useEffect(() => {
    setChannelName(channel.name)
    setDescription(channel.description || "")
    setPurpose(channel.purpose || "")
  }, [channel])

  // Check if user can edit (admin or owner)
  const canEdit = currentUserRole === "owner" || currentUserRole === "admin"
  const isOwner = currentUserRole === "owner"

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

  // Handle channel name change
  const handleNameChange = (value: string) => {
    const formatted = value.toLowerCase().replace(/[^a-z0-9-_]/g, "")
    setChannelName(formatted)

    if (errors.name) {
      validateChannelName(formatted)
    }
  }

  // Update channel details
  const handleUpdateChannel = async () => {
    if (!canEdit) return

    if (!validateChannelName(channelName)) {
      return
    }

    setIsSubmitting(true)

    try {
      const response = await api.channels.update.$put({
        json: {
          channelId: channel.id,
          name: channelName !== channel.name ? channelName : undefined,
          description:
            description !== channel.description ? description : undefined,
          purpose: purpose !== channel.purpose ? purpose : undefined,
        },
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: "Channel updated successfully",
        })
        onChannelUpdated()
        onClose()
      } else {
        const error = await response.json()
        toast({
          title: "Error",
          description: error.message || "Failed to update channel",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to update channel:", error)
      toast({
        title: "Error",
        description: "Failed to update channel",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  // Archive/Unarchive channel
  const handleArchiveChannel = async () => {
    if (!canEdit) return

    setIsSubmitting(true)

    try {
      const response = await api.channels.archive.$post({
        json: { channelId: channel.id },
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: channel.isArchived
            ? "Channel unarchived successfully"
            : "Channel archived successfully",
        })
        onChannelUpdated()
        setShowArchiveConfirm(false)
        onClose()
      } else {
        const error = await response.json()
        toast({
          title: "Error",
          description:
            error.message ||
            `Failed to ${channel.isArchived ? "unarchive" : "archive"} channel`,
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to archive channel:", error)
      toast({
        title: "Error",
        description: `Failed to ${channel.isArchived ? "unarchive" : "archive"} channel`,
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
      setShowArchiveConfirm(false)
    }
  }

  // Leave channel
  const handleLeaveChannel = async () => {
    setIsSubmitting(true)

    try {
      const response = await api.channels.leave.$post({
        json: { channelId: channel.id },
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: `You left #${channel.name}`,
        })
        onChannelLeft()
        setShowLeaveConfirm(false)
        onClose()
      } else {
        const error = await response.json()
        toast({
          title: "Error",
          description: error.message || "Failed to leave channel",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to leave channel:", error)
      toast({
        title: "Error",
        description: "Failed to leave channel",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
      setShowLeaveConfirm(false)
    }
  }

  // Delete channel
  const handleDeleteChannel = async () => {
    if (!isOwner) return

    setIsSubmitting(true)

    try {
      const response = await api.channels[":channelId"].$delete({
        param: { channelId: channel.id.toString() },
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: `#${channel.name} has been deleted`,
        })
        onChannelDeleted()
        setShowDeleteConfirm(false)
        onClose()
      } else {
        const error = await response.json()
        toast({
          title: "Error",
          description: error.message || "Failed to delete channel",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to delete channel:", error)
      toast({
        title: "Error",
        description: "Failed to delete channel",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
      setShowDeleteConfirm(false)
    }
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Channel settings
            </DialogTitle>
            <DialogDescription>
              Manage settings for #{channel.name}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {/* Channel Info */}
            <div className="space-y-4">
              <h3 className="font-semibold">Channel information</h3>

              {/* Channel Name */}
              <div className="space-y-2">
                <Label htmlFor="channel-name">Channel name</Label>
                <div className="relative">
                  {channel.type === "private" ? (
                    <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  ) : (
                    <Hash className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  )}
                  <Input
                    id="channel-name"
                    type="text"
                    value={channelName}
                    onChange={(e) => handleNameChange(e.target.value)}
                    disabled={!canEdit}
                    className={`pl-9 ${errors.name ? "border-red-500" : ""}`}
                    maxLength={80}
                  />
                </div>
                {errors.name && (
                  <p className="text-sm text-red-500">{errors.name}</p>
                )}
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={!canEdit}
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
                <Label htmlFor="purpose">Purpose</Label>
                <Textarea
                  id="purpose"
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  disabled={!canEdit}
                  placeholder="Why does this channel exist?"
                  rows={2}
                  maxLength={250}
                />
              </div>

              {canEdit && (
                <Button
                  onClick={handleUpdateChannel}
                  disabled={
                    isSubmitting ||
                    (channelName === channel.name &&
                      description === (channel.description || "") &&
                      purpose === (channel.purpose || ""))
                  }
                >
                  {isSubmitting ? "Saving..." : "Save changes"}
                </Button>
              )}
            </div>

            {/* Danger Zone */}
            <div className="space-y-4 pt-4 border-t">
              <h3 className="font-semibold text-red-600 dark:text-red-400">
                Danger zone
              </h3>

              {/* Archive/Unarchive */}
              {canEdit && (
                <div className="flex items-start justify-between p-4 border rounded-lg">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 font-medium">
                      <Archive className="h-4 w-4" />
                      <span>
                        {channel.isArchived ? "Unarchive" : "Archive"} channel
                      </span>
                    </div>
                    <p className="text-sm text-gray-500">
                      {channel.isArchived
                        ? "Restore this channel and make it active again"
                        : "Hide this channel from the sidebar and make it read-only"}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => setShowArchiveConfirm(true)}
                    disabled={isSubmitting}
                  >
                    {channel.isArchived ? "Unarchive" : "Archive"}
                  </Button>
                </div>
              )}

              {/* Leave Channel */}
              {!isOwner && (
                <div className="flex items-start justify-between p-4 border rounded-lg">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 font-medium">
                      <LogOut className="h-4 w-4" />
                      <span>Leave channel</span>
                    </div>
                    <p className="text-sm text-gray-500">
                      You'll need to be re-invited to rejoin
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => setShowLeaveConfirm(true)}
                    disabled={isSubmitting}
                  >
                    Leave
                  </Button>
                </div>
              )}

              {/* Delete Channel */}
              {isOwner && (
                <div className="flex items-start justify-between p-4 border border-red-200 dark:border-red-800 rounded-lg bg-red-50 dark:bg-red-950/20">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 font-medium text-red-600 dark:text-red-400">
                      <Trash2 className="h-4 w-4" />
                      <span>Delete channel</span>
                    </div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      Permanently delete this channel and all its messages
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    onClick={() => setShowDeleteConfirm(true)}
                    disabled={isSubmitting}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmation Modals */}
      <ConfirmModal
        showModal={showLeaveConfirm}
        setShowModal={(value) => {
          if (value.open === false) setShowLeaveConfirm(false)
        }}
        modalTitle="Leave channel?"
        modalMessage={`Are you sure you want to leave #${channel.name}? You'll need to be re-invited to rejoin.`}
        onConfirm={handleLeaveChannel}
      />

      <ConfirmModal
        showModal={showArchiveConfirm}
        setShowModal={(value) => {
          if (value.open === false) setShowArchiveConfirm(false)
        }}
        modalTitle={`${channel.isArchived ? "Unarchive" : "Archive"} channel?`}
        modalMessage={
          channel.isArchived
            ? `Are you sure you want to unarchive #${channel.name}? It will be visible and active again.`
            : `Are you sure you want to archive #${channel.name}? It will be hidden from the sidebar and made read-only.`
        }
        onConfirm={handleArchiveChannel}
      />

      <ConfirmModal
        showModal={showDeleteConfirm}
        setShowModal={(value) => {
          if (value.open === false) setShowDeleteConfirm(false)
        }}
        modalTitle="Delete channel?"
        modalMessage={`Are you sure you want to permanently delete #${channel.name}? This action cannot be undone. All messages and channel data will be permanently deleted.`}
        onConfirm={handleDeleteChannel}
      />
    </>
  )
}
