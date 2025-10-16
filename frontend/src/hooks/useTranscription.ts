import { useEffect, useRef, useState } from "react"
import { useRoomContext, useConnectionState } from "@livekit/components-react"
import { Track, ConnectionState } from "livekit-client"

interface UseTranscriptionOptions {
  callId: string
  enabled?: boolean
}

/**
 * Custom hook to capture and stream audio to the server for transcription
 * Uses the MediaRecorder API to capture audio from the local microphone
 */
export function useTranscription({
  callId,
  enabled = true,
}: UseTranscriptionOptions) {
  const room = useRoomContext()
  const connectionState = useConnectionState()
  const wsRef = useRef<WebSocket | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  console.log(
    `🔍 [TRANSCRIPTION] Hook state - enabled: ${enabled}, callId: ${callId}, hasRoom: ${!!room}, connectionState: ${connectionState}`,
  )

  useEffect(() => {
    console.log(
      `🔄 [TRANSCRIPTION] useEffect triggered - enabled: ${enabled}, callId: ${callId}, hasRoom: ${!!room}, connectionState: ${connectionState}`,
    )

    if (!enabled || !callId || !room) {
      console.log("❌ [TRANSCRIPTION] Skipping - missing required params")
      return
    }

    // Wait for room to be connected (which means auth worked)
    if (connectionState !== ConnectionState.Connected) {
      console.log(
        `⏳ [TRANSCRIPTION] Waiting for room to connect first... Current state: ${connectionState}`,
      )
      return
    }

    console.log(
      "✅ [TRANSCRIPTION] All conditions met, will setup transcription in 1 second...",
    )

    const setupTranscription = async () => {
      try {
        console.log("🔐 [TRANSCRIPTION] Getting authentication token...")

        // WORKAROUND: Since cookies don't work in new windows, we'll use a special endpoint
        // that returns the token directly. This only works if the user is already authenticated
        // via the join call API.
        let token: string | null = null

        try {
          const tokenResponse = await fetch("/api/v1/auth/ws-token", {
            method: "GET",
            credentials: "include", // This ensures cookies are sent
          })

          if (tokenResponse.ok) {
            const data = await tokenResponse.json()
            token = data.token
            console.log("✅ [TRANSCRIPTION] Got token from API endpoint")
          } else {
            console.warn(
              "⚠️ [TRANSCRIPTION] Token endpoint failed, trying cookies...",
            )
          }
        } catch (err) {
          console.warn("⚠️ [TRANSCRIPTION] Token endpoint error:", err)
        }

        // Fallback: try to get the cookie directly
        if (!token) {
          const getCookie = (name: string) => {
            const value = `; ${document.cookie}`
            const parts = value.split(`; ${name}=`)
            if (parts.length === 2) return parts.pop()?.split(";").shift()
            return null
          }

          token = getCookie("access-token") || getCookie("accessToken") || null
          if (token) {
            console.log("✅ [TRANSCRIPTION] Got token from cookies")
          }
        }

        if (!token) {
          console.error(
            "❌ [TRANSCRIPTION] No token available via API or cookies",
          )
          console.log("Available cookies:", document.cookie)
          setError("Cannot access authentication token")
          return
        }

        console.log("✅ [TRANSCRIPTION] Access token successfully retrieved")

        // Connect to transcription WebSocket
        // In development, connect to backend server (not Vite dev server)
        // In production, use same host
        const isDev = import.meta.env.DEV
        const backendHost = isDev ? "localhost:3000" : window.location.host
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"

        // Pass token as query parameter for cross-origin WebSocket in dev mode
        const wsUrl = `${protocol}//${backendHost}/ws/transcription?callId=${callId}&token=${encodeURIComponent(token)}`

        console.log("📞 [TRANSCRIPTION] Connecting to WebSocket...")
        console.log("📞 [TRANSCRIPTION] Backend host:", backendHost)
        console.log("📞 [TRANSCRIPTION] Has token:", !!token)

        const ws = new WebSocket(wsUrl)
        wsRef.current = ws

        ws.onopen = () => {
          console.log("✅ [TRANSCRIPTION] WebSocket connected successfully")
          setIsConnected(true)
          setError(null)
          startAudioCapture()
        }

        ws.onerror = (event) => {
          console.error("❌ [TRANSCRIPTION] WebSocket error:", event)
          setError("WebSocket connection failed - check authentication")
        }

        ws.onclose = (event) => {
          console.log(
            "👋 [TRANSCRIPTION] WebSocket disconnected. Code:",
            event.code,
            "Reason:",
            event.reason,
          )
          setIsConnected(false)
          stopAudioCapture()

          // Log specific close codes
          if (event.code === 1008) {
            console.error(
              "❌ [TRANSCRIPTION] Authentication failed or missing callId",
            )
            setError("Authentication failed")
          }
        }
      } catch (err) {
        console.error("Failed to setup transcription:", err)
        setError(err instanceof Error ? err.message : "Setup failed")
      }
    }

    const startAudioCapture = async () => {
      try {
        // Get the local microphone track from LiveKit room
        const localParticipant = room.localParticipant
        const microphoneTrack = localParticipant.getTrackPublication(
          Track.Source.Microphone,
        )

        if (!microphoneTrack || !microphoneTrack.track) {
          console.warn("⚠️ [TRANSCRIPTION] No microphone track found")
          return
        }

        // Get the MediaStreamTrack from LiveKit's Track
        const mediaStreamTrack = microphoneTrack.track.mediaStreamTrack
        const mediaStream = new MediaStream([mediaStreamTrack])

        console.log("🎤 [TRANSCRIPTION] Starting audio capture from microphone")

        // Create AudioContext for resampling to 16kHz (required by Whisper)
        const audioContext = new AudioContext({ sampleRate: 16000 })
        audioContextRef.current = audioContext

        const source = audioContext.createMediaStreamSource(mediaStream)
        const processor = audioContext.createScriptProcessor(4096, 1, 1)

        let chunkCount = 0
        processor.onaudioprocess = (event) => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            const inputData = event.inputBuffer.getChannelData(0)
            // Send Float32Array directly to server
            wsRef.current.send(inputData.buffer)

            chunkCount++
            if (chunkCount === 1) {
              console.log("🎵 [TRANSCRIPTION] First audio chunk sent to server")
            }
            if (chunkCount % 100 === 0) {
              console.log(
                `📊 [TRANSCRIPTION] Sent ${chunkCount} audio chunks to server`,
              )
            }
          }
        }

        source.connect(processor)
        processor.connect(audioContext.destination)

        console.log("✅ [TRANSCRIPTION] Audio capture started successfully")
      } catch (err) {
        console.error("❌ [TRANSCRIPTION] Failed to start audio capture:", err)
        setError(err instanceof Error ? err.message : "Audio capture failed")
      }
    }

    const stopAudioCapture = () => {
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        mediaRecorderRef.current.stop()
        mediaRecorderRef.current = null
      }

      if (
        audioContextRef.current &&
        audioContextRef.current.state !== "closed"
      ) {
        audioContextRef.current.close()
        audioContextRef.current = null
      }

      console.log("🛑 [TRANSCRIPTION] Audio capture stopped")
    }

    // Add a small delay to ensure cookies are set after join API call
    const timeoutId = setTimeout(() => {
      setupTranscription()
    }, 1000) // 1 second delay

    return () => {
      clearTimeout(timeoutId)
      stopAudioCapture()
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [callId, enabled, room, connectionState])

  return {
    isConnected,
    error,
  }
}
