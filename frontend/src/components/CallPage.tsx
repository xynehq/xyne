import { useState } from "react"
import {
  LiveKitRoom,
  VideoConference,
  formatChatMessageLinks,
} from "@livekit/components-react"
import "@livekit/components-styles/index.css"
import { InviteUsersModal } from './InviteUsersModal'
import { Button } from '@/components/ui/button'
import { UserPlus } from 'lucide-react'

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL || "ws://localhost:7880"

export default function CallPage() {
  // Get parameters from URL
  const urlParams = new URLSearchParams(window.location.search)
  const room = urlParams.get("room") || ""
  const token = urlParams.get("token") || ""
  const callType = urlParams.get("type") || "video"
  
  const [isCallEnded, setIsCallEnded] = useState(false)
  const [showInviteModal, setShowInviteModal] = useState(false)

  const handleDisconnect = () => {
    setIsCallEnded(true)
    // Close the call window
    window.close()
  }

  if (!room || !token) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-100 dark:bg-gray-900">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-200 mb-2">
            Invalid Call
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Missing room or token information
          </p>
          <button
            onClick={() => window.close()}
            className="mt-4 px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
          >
            Close Window
          </button>
        </div>
      </div>
    )
  }

  if (isCallEnded) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-100 dark:bg-gray-900">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-200 mb-2">
            Call Ended
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            The call has been disconnected
          </p>
          <button
            onClick={() => window.close()}
            className="mt-4 px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
          >
            Close Window
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen bg-gray-900 flex flex-col">
      {/* Call Header */}
      <div className="bg-gray-800 text-white p-4 flex justify-between items-center">
        <div>
          <h1 className="text-lg font-semibold">
            {callType === "video" ? "Video Call" : "Audio Call"}
          </h1>
          <p className="text-sm text-gray-300">
            Room: {room}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Button
            onClick={() => setShowInviteModal(true)}
            variant="outline"
            size="sm"
            className="bg-transparent border-gray-600 text-white hover:bg-gray-700"
          >
            <UserPlus className="h-4 w-4 mr-2" />
            Invite People
          </Button>
          <div className="text-sm text-gray-300">
            <p>LiveKit Call Session</p>
          </div>
        </div>
      </div>
      
      {/* Call Interface */}
      <div className="flex-1">
        <LiveKitRoom
          video={callType === "video"}
          audio={true}
          token={token}
          serverUrl={LIVEKIT_URL}
          // Use the default LiveKit styles
          data-lk-theme="default"
          style={{ height: "100%" }}
          onDisconnected={handleDisconnect}
        >
          {/* LiveKit provides a complete VideoConference component */}
          <VideoConference 
            chatMessageFormatter={formatChatMessageLinks}
          />
        </LiveKitRoom>
      </div>
      
      {/* Invite Users Modal */}
      <InviteUsersModal
        isOpen={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        roomName={room}
        callType={callType as 'video' | 'audio'}
      />
    </div>
  )
}


