// WebSocket client for call notifications
import { useEffect, useRef, useState } from "react"

export interface CallNotification {
  type: "incoming_call" | "call_accepted" | "call_rejected" | "call_ended"
  callId: string
  roomName: string
  caller: {
    id: string
    name: string
    email: string
    photoLink?: string | null
  }
  target: {
    id: string
    name: string
    email: string
    photoLink?: string | null
  }
  callType: "video" | "audio"
  targetToken: string
  timestamp: number
}

export interface CallStatusUpdate {
  type: "call_status"
  status: string
  data?: any
}

type CallNotificationHandler = (notification: CallNotification) => void
type CallStatusHandler = (status: CallStatusUpdate) => void

class CallNotificationClient {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000
  private onNotificationCallbacks: CallNotificationHandler[] = []
  private onStatusCallbacks: CallStatusHandler[] = []
  private soundInterval: NodeJS.Timeout | null = null
  private audioContextInitialized = false

  constructor() {
    this.initializeAudioOnUserInteraction()
  }

  // Initialize audio context on first user interaction to comply with autoplay policy
  private initializeAudioOnUserInteraction() {
    const initAudio = async () => {
      if (this.audioContextInitialized) return

      try {
        const audioContext = new (
          window.AudioContext || (window as any).webkitAudioContext
        )()
        if (audioContext.state === "suspended") {
          await audioContext.resume()
        }
        await audioContext.close()
        this.audioContextInitialized = true

        // Remove event listeners after successful initialization
        document.removeEventListener("click", initAudio)
        document.removeEventListener("touchstart", initAudio)
        document.removeEventListener("keydown", initAudio)
      } catch (error) {
        console.error("Failed to initialize audio context:", error)
      }
    }

    // Add event listeners for user interactions
    document.addEventListener("click", initAudio, { once: true })
    document.addEventListener("touchstart", initAudio, { once: true })
    document.addEventListener("keydown", initAudio, { once: true })
  }

  // Request notification permissions for fallback
  async requestNotificationPermission() {
    if ("Notification" in window && Notification.permission === "default") {
      try {
        const permission = await Notification.requestPermission()
        return permission === "granted"
      } catch (error) {
        console.error("Failed to request notification permission:", error)
        return false
      }
    }
    return Notification.permission === "granted"
  }

  // Force initialize audio context immediately (bypass user interaction requirement)
  private async forceInitializeAudio() {
    try {
      const audioContext = new (
        window.AudioContext || (window as any).webkitAudioContext
      )()

      if (audioContext.state === "suspended") {
        await audioContext.resume()
      }

      await audioContext.close()
      this.audioContextInitialized = true
    } catch (error) {
      console.error("Failed to force-initialize audio context:", error)
    }
  }

  private async playCallSound() {
    try {
      // Create a new AudioContext for each sound to avoid state issues
      const audioContext = new (
        window.AudioContext || (window as any).webkitAudioContext
      )()

      // Check if AudioContext is suspended (common in production due to autoplay policy)
      if (audioContext.state === "suspended") {
        await audioContext.resume()
      }

      // Verify AudioContext is running
      if (audioContext.state !== "running") {
        await audioContext.close()
        this.playFallbackSound()
        return
      }

      // Create oscillator for the sound
      const oscillator = audioContext.createOscillator()
      const gainNode = audioContext.createGain()

      oscillator.connect(gainNode)
      gainNode.connect(audioContext.destination)

      // Configure the sound (pleasant notification tone)
      oscillator.frequency.setValueAtTime(800, audioContext.currentTime) // 800 Hz
      oscillator.frequency.setValueAtTime(1000, audioContext.currentTime + 0.1) // Rise to 1000 Hz
      oscillator.frequency.setValueAtTime(800, audioContext.currentTime + 0.2) // Back to 800 Hz

      // Volume envelope
      gainNode.gain.setValueAtTime(0, audioContext.currentTime)
      gainNode.gain.linearRampToValueAtTime(
        0.3,
        audioContext.currentTime + 0.05,
      )
      gainNode.gain.linearRampToValueAtTime(0.1, audioContext.currentTime + 0.2)
      gainNode.gain.linearRampToValueAtTime(
        0.3,
        audioContext.currentTime + 0.25,
      )
      gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + 0.4)

      // Play the sound
      oscillator.start(audioContext.currentTime)
      oscillator.stop(audioContext.currentTime + 0.4)

      // Clean up after sound finishes
      setTimeout(() => {
        try {
          audioContext.close()
        } catch (e) {
          // Ignore cleanup errors
        }
      }, 500)
    } catch (error) {
      console.error("Failed to play call notification sound:", error)
      // Fallback: try to play a simple beep
      this.playFallbackSound()
    }
  }

  private startCallSoundLoop() {
    // Stop any existing sound loop
    this.stopCallSoundLoop()

    // Immediately try all sound methods
    this.playCallSound()

    // Also try fallback immediately as backup
    setTimeout(() => {
      this.playFallbackSound()
    }, 100)

    // Set up repeating sound every 2 seconds
    this.soundInterval = setInterval(() => {
      this.playCallSound()
    }, 2000)
  }

  private stopCallSoundLoop() {
    if (this.soundInterval) {
      clearInterval(this.soundInterval)
      this.soundInterval = null
    }
  }

  private async playFallbackSound() {
    // Method 1: Try simple Web Audio API beep
    try {
      const audioContext = new (
        window.AudioContext || (window as any).webkitAudioContext
      )()

      if (audioContext.state === "suspended") {
        await audioContext.resume()
      }

      if (audioContext.state === "running") {
        const oscillator = audioContext.createOscillator()
        const gainNode = audioContext.createGain()

        oscillator.connect(gainNode)
        gainNode.connect(audioContext.destination)

        oscillator.frequency.value = 1000
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime)
        gainNode.gain.exponentialRampToValueAtTime(
          0.01,
          audioContext.currentTime + 0.5,
        )

        oscillator.start(audioContext.currentTime)
        oscillator.stop(audioContext.currentTime + 0.5)

        setTimeout(() => {
          try {
            audioContext.close()
          } catch (e) {
            // Ignore cleanup errors
          }
        }, 600)

        return
      }
    } catch (error) {
      console.error("Fallback Web Audio API failed:", error)
    }

    // Method 2: Try HTML5 Audio with data URL
    try {
      // Create a simple beep using data URL
      const audio = new Audio(
        "data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+D2u2AZATuBveFobC4BH3DA8tyJNgUWdcnu2oe5DQYyq+nRpW0oByZ8z/LMciMFJHfH8N2QQAoUXrTp66hVFApGn+D2u2AZATuBveFobC4BH3DA8tyJNgUWdcnu2oe5DQYyq+nRpW0oByZ8z/LMciMFJHfH8N2QQAoUXrTp66hVFApGn+D2u2AZATuBveFobC4BH3DA8tyJNgUWdcnu2oe5",
      )
      audio.volume = 0.3
      await audio.play()
      return
    } catch (error) {
      console.error("HTML5 Audio fallback failed:", error)
    }

    // Method 3: Last resort - try browser notification sound
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        const notification = new Notification("Incoming Call", {
          body: "Someone is calling you",
          icon: "/favicon.ico",
          silent: false,
          requireInteraction: true,
        })

        // Close notification after 1 second
        setTimeout(() => {
          notification.close()
        }, 1000)

        return
      }
    } catch (error) {
      console.error("Browser notification fallback failed:", error)
    }
  }

  connect() {
    try {
      // Use the same origin but with ws protocol
      const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/calls`
      this.ws = new WebSocket(wsUrl)

      this.ws.onopen = () => {
        console.log("Connected to call notifications")
        this.reconnectAttempts = 0
      }

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)

          if (message.type === "call_notification") {
            // Start notification sound loop for incoming calls
            if (message.data.type === "incoming_call") {
              // Force audio context initialization if not done
              if (!this.audioContextInitialized) {
                this.forceInitializeAudio()
              }

              this.startCallSoundLoop()
            }

            this.onNotificationCallbacks.forEach((callback) => {
              callback(message.data)
            })
          } else if (message.type === "call_status") {
            this.onStatusCallbacks.forEach((callback) => {
              callback(message)
            })
          }
        } catch (error) {
          console.error("Error parsing notification message:", error)
        }
      }

      this.ws.onclose = () => {
        console.log("Call notification connection closed")
        this.reconnect()
      }

      this.ws.onerror = (error) => {
        console.error("WebSocket error:", error)
      }
    } catch (error) {
      console.error("Error connecting to call notifications:", error)
      this.reconnect()
    }
  }

  private reconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      setTimeout(() => {
        console.log(
          `Reconnecting to call notifications... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
        )
        this.connect()
      }, this.reconnectDelay * this.reconnectAttempts)
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    // Stop any ongoing call sound when disconnecting
    this.stopCallSoundLoop()
  }

  // Public method to stop call notification sound
  stopCallNotificationSound() {
    this.stopCallSoundLoop()
  }

  onCallNotification(callback: CallNotificationHandler) {
    this.onNotificationCallbacks.push(callback)
    return () => {
      this.onNotificationCallbacks = this.onNotificationCallbacks.filter(
        (cb) => cb !== callback,
      )
    }
  }

  onCallStatus(callback: CallStatusHandler) {
    this.onStatusCallbacks.push(callback)
    return () => {
      this.onStatusCallbacks = this.onStatusCallbacks.filter(
        (cb) => cb !== callback,
      )
    }
  }

  sendCallResponse(
    callId: string,
    callerId: string,
    response: "accepted" | "rejected",
  ) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "call_response",
          callId,
          callerId,
          response,
        }),
      )
    }
  }
}

// Singleton instance
export const callNotificationClient = new CallNotificationClient()

// React hook for using call notifications
export function useCallNotifications() {
  const [incomingCall, setIncomingCall] = useState<CallNotification | null>(
    null,
  )
  const [callStatus, setCallStatus] = useState<CallStatusUpdate | null>(null)
  const clientRef = useRef(callNotificationClient)

  useEffect(() => {
    const client = clientRef.current

    // Request notification permissions for fallback
    client.requestNotificationPermission().catch(console.error)

    // Connect to WebSocket
    client.connect()

    // Set up notification handlers
    const removeNotificationHandler = client.onCallNotification(
      (notification) => {
        if (notification.type === "incoming_call") {
          setIncomingCall(notification)
        }
      },
    )

    const removeStatusHandler = client.onCallStatus((status) => {
      setCallStatus(status)
    })

    // Cleanup on unmount
    return () => {
      removeNotificationHandler()
      removeStatusHandler()
      client.disconnect()
    }
  }, [])

  // Stop sound when incoming call is cleared (handles timeouts, cancellations, etc.)
  useEffect(() => {
    if (!incomingCall) {
      clientRef.current.stopCallNotificationSound()
    }
  }, [incomingCall])

  const acceptCall = (notification: CallNotification) => {
    clientRef.current.sendCallResponse(
      notification.callId,
      notification.caller.id,
      "accepted",
    )
    clientRef.current.stopCallNotificationSound()
    setIncomingCall(null)

    // Open call in a new window (same as caller experience)
    const callUrl = `/call?token=${notification.targetToken}&room=${notification.roomName}&type=${notification.callType}`
    const callWindow = window.open(
      callUrl,
      "call-window-receiver",
      "width=800,height=600,resizable=yes,scrollbars=no,status=no,location=no,toolbar=no,menubar=no",
    )

    if (!callWindow) {
      console.error("Failed to open call window - popup might be blocked")
      // Fallback: navigate in current window if popup is blocked
      window.location.href = callUrl
    }
  }

  const rejectCall = (notification: CallNotification) => {
    clientRef.current.sendCallResponse(
      notification.callId,
      notification.caller.id,
      "rejected",
    )
    clientRef.current.stopCallNotificationSound()
    setIncomingCall(null)
  }

  const dismissCall = () => {
    clientRef.current.stopCallNotificationSound()
    setIncomingCall(null)
  }

  return {
    incomingCall,
    callStatus,
    acceptCall,
    rejectCall,
    dismissCall,
  }
}
