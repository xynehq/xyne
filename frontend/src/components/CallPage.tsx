import { useState, useEffect, useRef, useCallback } from "react"
import {
  LiveKitRoom,
  VideoConference,
  formatChatMessageLinks,
  setLogLevel,
} from "@livekit/components-react"
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
import { useParams, useSearch } from "@tanstack/react-router"
import { CallType } from "@/types"

// Set LiveKit log level to warning or error only (suppresses debug logs)
setLogLevel("warn")

export default function CallPage() {
  // Get callId from route params: /call/:callId
  const params = useParams({ strict: false }) as { callId?: string }
  const search = useSearch({ strict: false }) as { type: CallType }

  const callId = params.callId || ""
  const callType = search.type

  const [isCallEnded, setIsCallEnded] = useState(false)
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [showShareModal, setShowShareModal] = useState(false)
  const [isJoining, setIsJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [isCopying, setIsCopying] = useState(false)
  const { toast } = useToast()

  // Generate the shareable call link (without token for security)
  // Only generate if callId is valid
  const shareableCallLink = callId
    ? `${window.location.origin}/call/${callId}?type=${callType}`
    : ""

  const joinCall = useCallback(async () => {
    if (!callId) return

    setIsJoining(true)
    setJoinError(null)

    try {
      const response = await api.calls.join.$post({
        json: { callId },
      })

      if (response.ok) {
        const data = await response.json()
        setToken(data.token)
        if (data.livekitUrl) {
          setServerUrl(data.livekitUrl)
        }
      } else {
        // Handle error response - check if there's JSON content
        let errorMessage = "Failed to join call"
        try {
          const errorData = await response.json()
          errorMessage = errorData.message || errorMessage
        } catch {
          // If response is not JSON, use status text
          errorMessage = `Server error: ${response.statusText || response.status}`
        }
        setJoinError(errorMessage)
      }
    } catch (error) {
      setJoinError("Failed to join call. Please try again.")
    } finally {
      setIsJoining(false)
    }
  }, [callId])

  // Automatically join the call on mount
  // Use useRef to track if we've already attempted to join
  const joinAttempted = useRef(false)

  useEffect(() => {
    if (callId && !token && !joinAttempted.current) {
      joinAttempted.current = true
      joinCall()
    }
  }, [callId, token, joinCall])

  const handleCopyLink = async () => {
    if (!shareableCallLink) {
      toast({
        title: "Error",
        description: "No valid call link available.",
        variant: "destructive",
      })
      return
    }

    try {
      setIsCopying(true)
      await navigator.clipboard.writeText(shareableCallLink)
      toast({
        title: "Copied!",
        description: "Call link copied to clipboard.",
      })
    } catch (error) {
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
    if (!shareableCallLink) {
      toast({
        title: "Error",
        description: "No valid call link available.",
        variant: "destructive",
      })
      return
    }

    if (navigator.share) {
      try {
        await navigator.share({
          title: `Join ${callType} call`,
          text: `Join our ${callType} call`,
          url: shareableCallLink,
        })
      } catch (error) {
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
      } catch (error: unknown) {
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
        }).catch(() => {
          // Silently fail - page is unloading anyway
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
  if (!callId || (!token && joinError)) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-100 dark:bg-gray-900">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-200 mb-2">
            {joinError ? "Failed to Join Call" : "Invalid Call"}
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            {joinError || "Missing call ID"}
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
        {token && serverUrl ? (
          <LiveKitRoom
            video={callType === "video"}
            audio={true}
            token={token}
            serverUrl={serverUrl}
            // Use the default LiveKit styles
            data-lk-theme="default"
            style={{ height: "100%", overflow: "hidden" }}
            onConnected={handleConnected}
            onDisconnected={handleDisconnect}
          >
            {/* LiveKit provides a complete VideoConference component */}
            <VideoConference chatMessageFormatter={formatChatMessageLinks} />
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
        callType={callType}
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
            {shareableCallLink ? (
              <>
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
                  <Button
                    onClick={handleShareNative}
                    className="w-full"
                    size="sm"
                  >
                    <Share2 className="h-4 w-4 mr-2" />
                    Share Link
                  </Button>
                </div>
              </>
            ) : (
              <div className="text-center py-4">
                <p className="text-sm text-muted-foreground">
                  Unable to generate shareable link.
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Please ensure you're in an active call.
                </p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
