import {
  VideoConference,
  formatChatMessageLinks,
} from "@livekit/components-react"
import { useTranscription } from "@/hooks/useTranscription"

interface CallRoomContentProps {
  callId: string
}

/**
 * Component that wraps the VideoConference with transcription functionality
 * Must be used inside a LiveKitRoom context
 */
export function CallRoomContent({ callId }: CallRoomContentProps) {
  console.log("🎬 [CallRoomContent] Rendering with callId:", callId)

  // Start transcription when component mounts
  const { isConnected, error } = useTranscription({
    callId,
    enabled: true,
  })

  console.log(
    "🎬 [CallRoomContent] Transcription status - connected:",
    isConnected,
    "error:",
    error,
  )

  return (
    <>
      {/* Show transcription status (optional - for debugging) */}
      {isConnected && (
        <div className="absolute top-4 right-4 z-50 bg-green-500/80 text-white text-xs px-3 py-1 rounded-full backdrop-blur-sm">
          🎙️ Transcribing
        </div>
      )}
      {error && (
        <div className="absolute top-4 right-4 z-50 bg-red-500/80 text-white text-xs px-3 py-1 rounded-full backdrop-blur-sm">
          ❌ Transcription error
        </div>
      )}

      {/* LiveKit provides a complete VideoConference component */}
      <VideoConference chatMessageFormatter={formatChatMessageLinks} />
    </>
  )
}
