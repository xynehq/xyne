import { useState, useEffect } from "react"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"
import {
  Users,
  Crown,
  Shield,
  UserPlus,
  UserMinus,
  MoreVertical,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { ConfirmModal } from "@/components/ui/confirmModal"
import { ChannelMemberRole } from "@/types"
import type { ChannelMember } from "@/types"
import UserPillSelector from "@/components/UserPillSelector"

interface WorkspaceUser {
  id: string
  name: string
  email: string
  photoLink?: string | null
}

interface MembersManagementProps {
  isOpen: boolean
  onClose: () => void
  channelId: number
  channelName: string
  currentUserRole: ChannelMemberRole
  currentUserId: string
}

export default function MembersManagement({
  isOpen,
  onClose,
  channelId,
  channelName,
  currentUserRole,
  currentUserId,
}: MembersManagementProps) {
  const [members, setMembers] = useState<ChannelMember[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [showAddMembers, setShowAddMembers] = useState(false)
  const [selectedNewMembers, setSelectedNewMembers] = useState<WorkspaceUser[]>(
    [],
  )
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [memberToRemove, setMemberToRemove] = useState<ChannelMember | null>(
    null,
  )
  const [memberToChangeRole, setMemberToChangeRole] =
    useState<ChannelMember | null>(null)
  const [newRole, setNewRole] = useState<ChannelMemberRole | null>(null)

  // Check permissions
  const canManageMembers =
    currentUserRole === ChannelMemberRole.Owner ||
    currentUserRole === ChannelMemberRole.Admin
  const isOwner = currentUserRole === ChannelMemberRole.Owner

  // Fetch channel members
  const fetchMembers = async () => {
    setLoading(true)
    try {
      const response = await api.channels.members.$get({
        query: { channelId: channelId.toString() },
      })

      if (!response.ok) {
        console.error("Failed to fetch members")
        throw new Error("API request failed")
      }

      const data = await response.json()
      setMembers(data.members || [])
    } catch (error) {
      console.error("Failed to fetch members:", error)
      toast({
        title: "Error",
        description: "Failed to load members",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  // Load members when modal opens
  useEffect(() => {
    if (isOpen) {
      fetchMembers()
      setShowAddMembers(false)
      setSelectedNewMembers([])
      setSearchQuery("")
    }
  }, [isOpen, channelId])

  // Add members
  const handleAddMembers = async () => {
    if (selectedNewMembers.length === 0) return

    setIsSubmitting(true)

    try {
      const response = await api.channels.members.add.$post({
        json: {
          channelId: channelId,
          memberIds: selectedNewMembers.map((user) => user.id),
        },
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: `Added ${selectedNewMembers.length} member${selectedNewMembers.length !== 1 ? "s" : ""}`,
        })
        setSelectedNewMembers([])
        setShowAddMembers(false)
        fetchMembers()
      } else {
        const error = await response.json()
        toast({
          title: "Error",
          description: error.message || "Failed to add members",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to add members:", error)
      toast({
        title: "Error",
        description: "Failed to add members",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  // Remove member
  const handleRemoveMember = async () => {
    if (!memberToRemove) return

    setIsSubmitting(true)

    try {
      const response = await api.channels.members.remove.$post({
        json: {
          channelId: channelId,
          memberId: memberToRemove.id,
        },
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: `Removed ${memberToRemove.name} from the channel`,
        })
        setMemberToRemove(null)
        fetchMembers()
      } else {
        const error = await response.json()
        toast({
          title: "Error",
          description: error.message || "Failed to remove member",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to remove member:", error)
      toast({
        title: "Error",
        description: "Failed to remove member",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
      setMemberToRemove(null)
    }
  }

  // Change member role
  const handleChangeRole = async () => {
    if (!memberToChangeRole || !newRole) return

    setIsSubmitting(true)

    try {
      const response = await api.channels.members.role.$put({
        json: {
          channelId: channelId,
          memberId: memberToChangeRole.id,
          role: newRole,
        },
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: `Changed ${memberToChangeRole.name}'s role to ${newRole}`,
        })
        setMemberToChangeRole(null)
        setNewRole(null)
        fetchMembers()
      } else {
        const error = await response.json()
        toast({
          title: "Error",
          description: error.message || "Failed to change role",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to change role:", error)
      toast({
        title: "Error",
        description: "Failed to change role",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
      setMemberToChangeRole(null)
      setNewRole(null)
    }
  }

  // Filter members by search query (for members list view)
  const filteredMembers = members.filter(
    (member) =>
      member.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      member.email.toLowerCase().includes(searchQuery.toLowerCase()),
  )

  // Get role icon and color
  const getRoleDisplay = (role: ChannelMemberRole) => {
    switch (role) {
      case ChannelMemberRole.Owner:
        return {
          icon: Crown,
          label: "Owner",
          color: "text-yellow-600 dark:text-yellow-400",
        }
      case ChannelMemberRole.Admin:
        return {
          icon: Shield,
          label: "Admin",
          color: "text-blue-600 dark:text-blue-400",
        }
      case ChannelMemberRole.Member:
        return {
          icon: null,
          label: "Member",
          color: "text-gray-600 dark:text-gray-400",
        }
    }
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Members
            </DialogTitle>
            <DialogDescription>
              Manage members for #{channelName}
            </DialogDescription>
          </DialogHeader>

          {!showAddMembers ? (
            <div className="space-y-4">
              {/* Header with search and add button */}
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  placeholder="Search members..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="flex-1"
                />
                {canManageMembers && (
                  <Button onClick={() => setShowAddMembers(true)}>
                    <UserPlus className="h-4 w-4 mr-2" />
                    Add
                  </Button>
                )}
              </div>

              {/* Members list */}
              {loading ? (
                <div className="text-center py-8 text-gray-500">
                  Loading members...
                </div>
              ) : filteredMembers.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  No members found
                </div>
              ) : (
                <div className="space-y-2 max-h-[500px] overflow-y-auto">
                  {filteredMembers.map((member) => {
                    const roleDisplay = getRoleDisplay(member.role)
                    const RoleIcon = roleDisplay.icon
                    const canModifyMember =
                      canManageMembers &&
                      member.id !== currentUserId &&
                      (isOwner || member.role !== ChannelMemberRole.Owner)

                    return (
                      <div
                        key={member.id}
                        className="flex items-center justify-between p-3 rounded-lg border hover:bg-gray-50 dark:hover:bg-gray-800"
                      >
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          {/* Avatar */}
                          {member.photoLink ? (
                            <img
                              src={`/api/v1/proxy/${encodeURIComponent(member.photoLink)}`}
                              alt={member.name}
                              className="h-10 w-10 rounded-full object-cover flex-shrink-0"
                            />
                          ) : (
                            <div className="h-10 w-10 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center flex-shrink-0">
                              <span className="text-sm font-medium">
                                {member.name.charAt(0).toUpperCase()}
                              </span>
                            </div>
                          )}

                          {/* Member info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">
                                {member.name}
                              </span>
                              {member.id === currentUserId && (
                                <span className="text-xs text-gray-500">
                                  (you)
                                </span>
                              )}
                            </div>
                            <div className="text-sm text-gray-500 truncate">
                              {member.email}
                            </div>
                          </div>

                          {/* Role badge */}
                          <div
                            className={`flex items-center gap-1 ${roleDisplay.color}`}
                          >
                            {RoleIcon && <RoleIcon className="h-4 w-4" />}
                            <span className="text-sm font-medium">
                              {roleDisplay.label}
                            </span>
                          </div>
                        </div>

                        {/* Actions dropdown */}
                        {canModifyMember && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="ml-2"
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {isOwner && (
                                <>
                                  <DropdownMenuItem
                                    onClick={() => {
                                      setMemberToChangeRole(member)
                                      setNewRole(ChannelMemberRole.Admin)
                                    }}
                                    disabled={
                                      member.role === ChannelMemberRole.Admin
                                    }
                                  >
                                    <Shield className="h-4 w-4 mr-2" />
                                    Make admin
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => {
                                      setMemberToChangeRole(member)
                                      setNewRole(ChannelMemberRole.Member)
                                    }}
                                    disabled={
                                      member.role === ChannelMemberRole.Member
                                    }
                                  >
                                    Make member
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                </>
                              )}
                              <DropdownMenuItem
                                onClick={() => setMemberToRemove(member)}
                                className="text-red-600 dark:text-red-400"
                              >
                                <UserMinus className="h-4 w-4 mr-2" />
                                Remove from channel
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Member count */}
              <div className="text-sm text-gray-500 pt-2 border-t">
                {members.length} member{members.length !== 1 ? "s" : ""}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Add members view with pill selector */}
              <div className="space-y-3">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Add people to #{channelName}
                </p>
                <UserPillSelector
                  selectedUsers={selectedNewMembers}
                  onUsersChange={setSelectedNewMembers}
                  placeholder="Search for people..."
                  excludeEmails={members.map((m) => m.email)}
                />
              </div>

              {selectedNewMembers.length > 0 && (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {selectedNewMembers.length} user
                  {selectedNewMembers.length !== 1 ? "s" : ""} selected
                </p>
              )}

              {/* Actions */}
              <div className="flex justify-end gap-3 pt-4 border-t">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowAddMembers(false)
                    setSelectedNewMembers([])
                    setSearchQuery("")
                  }}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleAddMembers}
                  disabled={isSubmitting || selectedNewMembers.length === 0}
                >
                  {isSubmitting
                    ? "Adding..."
                    : `Add ${selectedNewMembers.length || ""} member${selectedNewMembers.length !== 1 ? "s" : ""}`}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Confirmation Modals */}
      <ConfirmModal
        showModal={!!memberToRemove}
        setShowModal={(value) => {
          if (value.open === false) setMemberToRemove(null)
        }}
        modalTitle="Remove member?"
        modalMessage={`Are you sure you want to remove ${memberToRemove?.name} from #${channelName}? They'll need to be re-invited to rejoin.`}
        onConfirm={handleRemoveMember}
      />

      <ConfirmModal
        showModal={!!memberToChangeRole}
        setShowModal={(value) => {
          if (value.open === false) {
            setMemberToChangeRole(null)
            setNewRole(null)
          }
        }}
        modalTitle="Change role?"
        modalMessage={`Are you sure you want to change ${memberToChangeRole?.name}'s role to ${newRole}?`}
        onConfirm={handleChangeRole}
      />
    </>
  )
}
