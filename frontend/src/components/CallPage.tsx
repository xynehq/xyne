import { useState, useEffect } from "react"
import { LiveKitRoom } from "@livekit/components-react"
import "@livekit/components-styles/index.css"
import { InviteUsersModal } from "./InviteUsersModal"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { UserPlus, Share2, Copy } from "lucide-react"
import { api } from "@/api"
import { useToast } from "@/hooks/use-toast"
import { CallRoomContent } from "@/components/CallRoomContent"

export default function CallPage() {
  // Get parameters from URL (support both 'room' and 'callId' for backwards compatibility)
  const urlParams = new URLSearchParams(window.location.search)
  const callId = urlParams.get("callId") || ""
  const token = urlParams.get("token") || ""
  const callType = urlParams.get("type") || "video"
  const LiveKitServerUrl = urlParams.get("serverUrl")

  const [isCallEnded, setIsCallEnded] = useState(false)
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [showShareModal, setShowShareModal] = useState(false)
  const [isJoining, setIsJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [actualToken, setActualToken] = useState(token)
  const [isCopying, setIsCopying] = useState(false)
  const [serverUrl, setServerUrl] = useState(LiveKitServerUrl)
  const { toast } = useToast()

  // Generate the shareable call link (without token for security)
  const shareableCallLink = `${window.location.origin}/call?callId=${callId}&type=${callType}`

  // If no token provided, try to join the call
  useEffect(() => {
    if (callId && !token && !isJoining && !joinError) {
      joinCall()
    }
  }, [callId, token, isJoining, joinError])

  const joinCall = async () => {
    if (!callId) return

    setIsJoining(true)
    setJoinError(null)

    try {
      const response = await api.calls.join.$post({
        json: { callId },
      })

      if (response.ok) {
        const data = await response.json()
        setActualToken(data.token)
        if (data.livekitUrl) setServerUrl(data.livekitUrl)
      } else {
        const errorData = await response.json()
        setJoinError(errorData.message || "Failed to join call")
      }
    } catch (error) {
      console.error("Error joining call:", error)
      setJoinError("Failed to join call. Please try again.")
    } finally {
      setIsJoining(false)
    }
  }

  const handleCopyLink = async () => {
    try {
      setIsCopying(true)
      await navigator.clipboard.writeText(shareableCallLink)
      toast({
        title: "Copied!",
        description: "Call link copied to clipboard.",
      })
    } catch (error) {
      console.error("Failed to copy link:", error)
      toast({
        title: "Error",
        description: "Failed to copy link. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsCopying(false)
    }
  }

  const handleShareNative = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Join ${callType} call`,
          text: `Join our ${callType} call`,
          url: shareableCallLink,
        })
      } catch (error) {
        console.error("Error sharing:", error)
        // Fallback to copy
        handleCopyLink()
      }
    } else {
      // Fallback to copy
      handleCopyLink()
    }
  }

  const handleDisconnect = async () => {
    // Mark as ended first to prevent duplicate calls
    setIsCallEnded(true)

    // Notify backend that user is leaving the call
    if (callId) {
      try {
        await api.calls.leave.$post({
          json: { callId },
        })
        console.log("Successfully notified server of disconnect")
      } catch (error: unknown) {
        console.error("Error notifying server of disconnect:", error)
        // Continue with disconnect even if API call fails
      }
    }

    // Close the call window after a short delay to ensure API call completes
    setTimeout(() => {
      window.close()
    }, 100)
  }

  // Track when user actually connects to the room (for participants tracking)
  const handleConnected = async () => {
    if (!callId) return

    try {
      // If user had a token (caller), we need to register them as a participant
      if (token && !isJoining) {
        await api.calls.join.$post({
          json: { callId },
        })
      }
    } catch (error) {
      console.error("Error registering participant:", error)
      // Don't show error to user - this is background tracking
    }
  }

  // Ensure leave API is called when user closes window/tab or navigates away
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (callId && !isCallEnded) {
        // Use synchronous fetch with keepalive for reliable delivery during page unload
        // keepalive ensures the request completes even after the page unloads
        fetch("/api/v1/calls/leave", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({ callId }),
          keepalive: true, // Critical: keeps request alive after page unload
        }).catch((error) => {
          console.error("Error in beforeunload leave call:", error)
        })
      }
    }

    window.addEventListener("beforeunload", handleBeforeUnload)
    // Also listen to pagehide for better mobile support
    window.addEventListener("pagehide", handleBeforeUnload)

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload)
      window.removeEventListener("pagehide", handleBeforeUnload)
    }
  }, [callId, isCallEnded])

  // Show loading state while joining
  if (isJoining) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-100 dark:bg-gray-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-200 mb-2">
            Joining Call...
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Please wait while we connect you to the call
          </p>
        </div>
      </div>
    )
  }

  // Show error if join failed or missing required params
  if (!callId || (!actualToken && joinError)) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-100 dark:bg-gray-900">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-200 mb-2">
            {joinError ? "Failed to Join Call" : "Invalid Call"}
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            {joinError || "Missing room or token information"}
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
    <div className="h-screen bg-gray-900 relative overflow-hidden">
      {/* Call Interface */}
      <div className="h-full relative overflow-hidden">
        {actualToken && serverUrl ? (
          <LiveKitRoom
            video={callType === "video"}
            audio={true}
            token={actualToken}
            serverUrl={serverUrl}
            // Use the default LiveKit styles
            data-lk-theme="default"
            style={{ height: "100%", overflow: "hidden" }}
            onConnected={handleConnected}
            onDisconnected={handleDisconnect}
          >
            {/* CallRoomContent includes VideoConference + Transcription */}
            <CallRoomContent callId={callId} />
          </LiveKitRoom>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-white">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
              <p>Connecting to call...</p>
              {isJoining && <p className="text-sm mt-2">Joining room...</p>}
            </div>
          </div>
        )}

        {/* Action Buttons - Bottom Left */}
        <div className="absolute bottom-4 left-4 flex gap-4 z-50">
          <div className="relative group">
            <button
              onClick={() => setShowInviteModal(true)}
              className="hover:bg-white/10 text-white rounded-lg h-10 w-10 flex items-center justify-center transition-all duration-200 bg-black/20 backdrop-blur-sm"
            >
              <UserPlus className="h-5 w-5" />
            </button>
            <div className="absolute -bottom-10 left-1/2 transform -translate-x-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
              Add people
            </div>
          </div>

          <div className="relative group">
            <button
              onClick={() => setShowShareModal(true)}
              className="hover:bg-white/10 text-white rounded-lg h-10 w-10 flex items-center justify-center transition-all duration-200 bg-black/20 backdrop-blur-sm"
            >
              <Share2 className="h-5 w-5" />
            </button>
            <div className="absolute -bottom-10 left-1/2 transform -translate-x-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
              Share
            </div>
          </div>
        </div>
      </div>

      {/* Invite Users Modal */}
      <InviteUsersModal
        isOpen={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        callId={callId}
        callType={callType as "video" | "audio"}
      />

      {/* Share Call Link Modal */}
      <Dialog open={showShareModal} onOpenChange={setShowShareModal}>
        <DialogContent className="sm:max-w-[425px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Share Call Link</DialogTitle>
            <DialogDescription>
              Share this link with others to invite them to join the {callType}{" "}
              call.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Link Section */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Call Link</label>
              <div className="flex items-center space-x-2">
                <Input
                  readOnly
                  value={shareableCallLink}
                  className="flex-1 font-mono text-sm min-w-0"
                />
                <Button
                  onClick={handleCopyLink}
                  disabled={isCopying}
                  variant="outline"
                  size="sm"
                  className="px-3 flex-shrink-0"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col gap-2 pt-2">
              <Button onClick={handleShareNative} className="w-full" size="sm">
                <Share2 className="h-4 w-4 mr-2" />
                Share Link
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
