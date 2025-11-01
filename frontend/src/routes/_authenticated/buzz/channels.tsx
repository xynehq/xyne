import { createFileRoute } from "@tanstack/react-router"
import { useState, useEffect } from "react"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"
import ChannelList from "@/components/ChannelList"
import ChannelView from "@/components/ChannelView"
import CreateChannelModal from "@/components/CreateChannelModal"
import BrowseChannels from "@/components/BrowseChannels"
import ChannelSettings from "@/components/ChannelSettings"
import MembersManagement from "@/components/MembersManagement"
import type { Channel } from "@/types"
import { CallType } from "@/types"

interface User {
  id: string
  name: string
  email: string
  photoLink?: string | null
}

export const Route = createFileRoute("/_authenticated/buzz/channels")({
  component: BuzzChannels,
})

function BuzzChannels() {
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showBrowseModal, setShowBrowseModal] = useState(false)
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [showMembersModal, setShowMembersModal] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  // Fetch current user info
  const fetchCurrentUser = async () => {
    try {
      const response = await api.me.$get()
      if (response.ok) {
        const data = await response.json()
        setCurrentUser({
          id: data.user.id || data.user.externalId,
          name: data.user.name,
          email: data.user.email,
          photoLink: data.user.photoLink,
        })
      }
    } catch (error) {
      console.error("Failed to fetch current user:", error)
    }
  }

  // Load user data
  useEffect(() => {
    fetchCurrentUser()
  }, [])

  // Handle channel selection
  const handleChannelSelect = (channel: Channel) => {
    setSelectedChannel(channel)
  }

  // Handle channel created
  const handleChannelCreated = async (channelId: number) => {
    // Refresh channel list
    setRefreshKey((prev) => prev + 1)

    // Select the newly created channel
    try {
      const response = await api.channels[":channelId"].$get({
        param: { channelId: channelId.toString() },
      })

      if (response.ok) {
        const data = await response.json()
        setSelectedChannel(data)
      }
    } catch (error) {
      console.error("Failed to fetch new channel:", error)
    }
  }

  // Handle channel joined
  const handleChannelJoined = async (channelId: number) => {
    // Refresh channel list
    setRefreshKey((prev) => prev + 1)

    // Select the joined channel
    try {
      const response = await api.channels[":channelId"].$get({
        param: { channelId: channelId.toString() },
      })

      if (response.ok) {
        const data = await response.json()
        setSelectedChannel(data)
      }
    } catch (error) {
      console.error("Failed to fetch joined channel:", error)
    }
  }

  // Handle channel updated (settings changed, archived, etc.)
  const handleChannelUpdated = () => {
    setRefreshKey((prev) => prev + 1)

    // Refresh current channel data if one is selected
    if (selectedChannel) {
      fetchChannelData(selectedChannel.id)
    }
  }

  // Handle channel left
  const handleChannelLeft = () => {
    setRefreshKey((prev) => prev + 1)
    setSelectedChannel(null)
  }

  // Handle channel deleted
  const handleChannelDeleted = () => {
    setRefreshKey((prev) => prev + 1)
    setSelectedChannel(null)
  }

  // Fetch channel data
  const fetchChannelData = async (channelId: number) => {
    try {
      const response = await api.channels[":channelId"].$get({
        param: { channelId: channelId.toString() },
      })

      if (response.ok) {
        const data = await response.json()
        setSelectedChannel(data)
      }
    } catch (error) {
      console.error("Failed to fetch channel data:", error)
    }
  }

  // Handle switching to user DM
  const handleSwitchToUser = (userId: string) => {
    // Navigate to the chats page with the selected user
    window.location.href = `/buzz/chats?userId=${userId}`
  }

  // Handle call initiation for channels
  const initiateCall = async (channelId: number, callType: CallType) => {
    try {
      const response = await api.calls.initiate.$post({
        json: {
          callType,
          channelId,
        },
      })

      if (response.ok) {
        const data = await response.json()
        const callerLink = `${window.location.origin}/call/${data.callId}?type=${callType}`

        toast({
          title: "Call Started!",
          description: "Channel call initiated",
        })

        // Open call in new window/tab (same as direct messages)
        window.open(
          callerLink,
          "call-window-channel",
          "width=800,height=600,resizable=yes,scrollbars=no,status=no,location=no,toolbar=no,menubar=no",
        )

        if (!window.open) {
          console.warn("Popup blocked, falling back to navigation")
          window.location.href = callerLink
        }
      } else {
        const error = await response.json()
        toast({
          title: "Error",
          description: error.message || "Failed to initiate call",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to initiate call:", error)
      toast({
        title: "Error",
        description: "Failed to initiate call",
        variant: "destructive",
      })
    }
  }

  if (!currentUser) {
    return (
      <div className="flex items-center justify-center h-screen w-full">
        <div className="text-gray-500">Loading...</div>
      </div>
    )
  }

  return (
    <>
      {/* Channel List Sidebar */}
      <div className="fixed left-[112px] top-0 bottom-0 w-80 bg-white dark:bg-[#1E1E1E] border-r border-[#D7E0E9] dark:border-gray-700 z-10 flex flex-col">
        <ChannelList
          key={refreshKey}
          currentUserId={currentUser.id}
          selectedChannelId={selectedChannel?.id}
          onChannelSelect={handleChannelSelect}
          onCreateChannel={() => setShowCreateModal(true)}
          onBrowseChannels={() => setShowBrowseModal(true)}
        />
      </div>

      {/* Channel View - Right side */}
      {selectedChannel ? (
        <div className="fixed left-[432px] top-0 right-0 bottom-0 z-10">
          <ChannelView
            channel={selectedChannel}
            currentUser={currentUser}
            onInitiateCall={initiateCall}
            onOpenSettings={() => setShowSettingsModal(true)}
            onOpenMembers={() => setShowMembersModal(true)}
            onSwitchToUser={handleSwitchToUser}
          />
        </div>
      ) : (
        <div className="fixed left-[432px] top-0 right-0 bottom-0 z-10 flex flex-col items-center justify-center bg-white dark:bg-[#232323]">
          <div className="text-center space-y-2">
            <h3 className="text-xl font-semibold text-gray-700 dark:text-gray-300">
              Welcome to Channels
            </h3>
            <p className="text-sm text-gray-500">
              Select a channel from the sidebar or create a new one to get
              started
            </p>
          </div>
        </div>
      )}

      {/* Modals */}
      <CreateChannelModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onChannelCreated={handleChannelCreated}
      />

      <BrowseChannels
        isOpen={showBrowseModal}
        onClose={() => setShowBrowseModal(false)}
        onChannelJoined={handleChannelJoined}
      />

      {selectedChannel && selectedChannel.memberRole && (
        <>
          <ChannelSettings
            isOpen={showSettingsModal}
            onClose={() => setShowSettingsModal(false)}
            channel={selectedChannel}
            onChannelUpdated={handleChannelUpdated}
            onChannelLeft={handleChannelLeft}
            onChannelDeleted={handleChannelDeleted}
            currentUserRole={selectedChannel.memberRole}
          />

          <MembersManagement
            isOpen={showMembersModal}
            onClose={() => setShowMembersModal(false)}
            channelId={selectedChannel.id}
            channelName={selectedChannel.name}
            currentUserRole={selectedChannel.memberRole}
            currentUserId={currentUser.id}
          />
        </>
      )}
    </>
  )
}
