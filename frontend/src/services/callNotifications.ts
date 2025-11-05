// WebSocket client for call notifications and direct messages
import { useEffect, useRef, useState } from "react"

export interface CallNotification {
  type: "incoming_call" | "call_accepted" | "call_rejected" | "call_ended"
  callId: string
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
  targetToken?: string // Optional - token generated on join
  livekitUrl?: string // Optional
  timestamp: number
}

export interface LexicalEditorState {
  root: {
    children: any[]
    direction?: string | null
    format?: string | number
    indent?: number
    type?: string
    version?: number
  }
}

export interface DirectMessage {
  type: "direct_message"
  messageId: number
  messageContent: LexicalEditorState
  createdAt: string
  sender: {
    id: string
    name: string
    email: string
    photoLink?: string | null
  }
  timestamp: number
}

export interface TypingIndicator {
  type: "typing_indicator"
  userId: string
  isTyping: boolean
}

export interface MessageRead {
  type: "message_read"
  readByUserId: string
}

export interface CallStatusUpdate {
  type: "call_status"
  status: string
  data?: any
}

// Channel notification interfaces
export interface ChannelMessage {
  type: "channel_message"
  messageId: number
  channelId: number
  channelName: string
  messageContent: LexicalEditorState
  plainTextContent: string
  createdAt: string
  sender: {
    id: string
    name: string
    email: string
    photoLink?: string | null
  }
  timestamp: number
}

export interface ChannelTypingIndicator {
  type: "channel_typing_indicator"
  channelId: number
  userId: string
  isTyping: boolean
}

export interface ChannelUpdate {
  type: "channel_update"
  channelId: number
  updateType: string
  updateData: any
}

export interface ChannelMembershipUpdate {
  type: "channel_membership_update"
  channelId: number
  updateType: "added" | "removed" | "role_changed"
  channelData?: any
}

export interface ThreadReply {
  type: "thread_reply"
  threadId: number
  parentMessageId: number
  messageType: "channel" | "direct"
  reply: {
    id: number
    messageContent: LexicalEditorState
    createdAt: string
    isEdited: boolean
    sender: {
      externalId: string
      name: string
      email: string
      photoLink?: string | null
    }
  }
}

export interface DirectMessageEdit {
  type: "direct_message_edit"
  messageId: number
  messageContent: LexicalEditorState
  updatedAt: string
}

export interface DirectMessageDelete {
  type: "direct_message_delete"
  messageId: number
}

export interface ChannelMessageEdit {
  type: "channel_message_edit"
  channelId: number
  messageId: number
  messageContent: LexicalEditorState
  updatedAt: string
}

export interface ChannelMessageDelete {
  type: "channel_message_delete"
  channelId: number
  messageId: number
}

type CallNotificationHandler = (notification: CallNotification) => void
type CallStatusHandler = (status: CallStatusUpdate) => void
type DirectMessageHandler = (message: DirectMessage) => void
type TypingIndicatorHandler = (indicator: TypingIndicator) => void
type MessageReadHandler = (readStatus: MessageRead) => void
type ChannelMessageHandler = (message: ChannelMessage) => void
type ChannelTypingIndicatorHandler = (indicator: ChannelTypingIndicator) => void
type ChannelUpdateHandler = (update: ChannelUpdate) => void
type ChannelMembershipUpdateHandler = (update: ChannelMembershipUpdate) => void
type ThreadReplyHandler = (reply: ThreadReply) => void
type DirectMessageEditHandler = (edit: DirectMessageEdit) => void
type DirectMessageDeleteHandler = (del: DirectMessageDelete) => void
type ChannelMessageEditHandler = (edit: ChannelMessageEdit) => void
type ChannelMessageDeleteHandler = (del: ChannelMessageDelete) => void

class CallNotificationClient {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000
  private onNotificationCallbacks: CallNotificationHandler[] = []
  private onStatusCallbacks: CallStatusHandler[] = []
  private onDirectMessageCallbacks: DirectMessageHandler[] = []
  private onTypingIndicatorCallbacks: TypingIndicatorHandler[] = []
  private onMessageReadCallbacks: MessageReadHandler[] = []
  private onChannelMessageCallbacks: ChannelMessageHandler[] = []
  private onChannelTypingIndicatorCallbacks: ChannelTypingIndicatorHandler[] =
    []
  private onChannelUpdateCallbacks: ChannelUpdateHandler[] = []
  private onChannelMembershipUpdateCallbacks: ChannelMembershipUpdateHandler[] =
    []
  private onThreadReplyCallbacks: ThreadReplyHandler[] = []
  private onDirectMessageEditCallbacks: DirectMessageEditHandler[] = []
  private onDirectMessageDeleteCallbacks: DirectMessageDeleteHandler[] = []
  private onChannelMessageEditCallbacks: ChannelMessageEditHandler[] = []
  private onChannelMessageDeleteCallbacks: ChannelMessageDeleteHandler[] = []
  private soundInterval: ReturnType<typeof setInterval> | null = null
  private audioContextInitialized = false
  private connectionInitialized = false
  private isMainWindow = true // Track if this is the main window

  constructor() {
    this.initializeAudioOnUserInteraction()

    // Detect if this is a popup window (call window) or main window
    this.isMainWindow = !window.opener

    // Only set up connection management for main window
    if (this.isMainWindow) {
      this.setupWindowEventHandlers()
    }
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

  // Set up window event handlers to maintain connection stability
  private setupWindowEventHandlers() {
    // Prevent WebSocket disconnection on page visibility changes
    document.addEventListener("visibilitychange", () => {
      // Reconnect if connection was lost while page was hidden
      if (!document.hidden && !this.isConnected()) {
        this.connect()
      }
    })

    // Ensure connection on window focus
    window.addEventListener("focus", () => {
      if (!this.isConnected()) {
        this.connect()
      }
    })
  }

  connect() {
    // Only allow connection from main window to prevent conflicts
    if (!this.isMainWindow) {
      return
    }

    // Don't create a new connection if one already exists and is open or connecting
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return
    }

    // Prevent multiple connection attempts during initialization
    if (this.connectionInitialized) {
      return
    }
    this.connectionInitialized = true

    try {
      // Use the same origin but with ws protocol
      const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/calls`
      this.ws = new WebSocket(wsUrl)

      this.ws.onopen = () => {
        this.reconnectAttempts = 0
        this.connectionInitialized = false // Reset flag on successful connection
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
          } else if (message.type === "direct_message") {
            // Handle incoming direct message
            this.onDirectMessageCallbacks.forEach((callback) => {
              callback(message.data)
            })
          } else if (message.type === "typing_indicator") {
            // Handle typing indicator
            this.onTypingIndicatorCallbacks.forEach((callback) => {
              callback(message.data)
            })
          } else if (message.type === "message_read") {
            // Handle message read receipt
            this.onMessageReadCallbacks.forEach((callback) => {
              callback(message.data)
            })
          } else if (message.type === "channel_message") {
            // Handle incoming channel message
            this.onChannelMessageCallbacks.forEach((callback) => {
              callback(message.data)
            })
          } else if (message.type === "channel_typing_indicator") {
            // Handle channel typing indicator
            this.onChannelTypingIndicatorCallbacks.forEach((callback) => {
              callback(message.data)
            })
          } else if (message.type === "channel_update") {
            // Handle channel update
            this.onChannelUpdateCallbacks.forEach((callback) => {
              callback(message.data)
            })
          } else if (message.type === "channel_membership_update") {
            // Handle channel membership update
            this.onChannelMembershipUpdateCallbacks.forEach((callback) => {
              callback(message.data)
            })
          } else if (message.type === "thread_reply") {
            // Handle thread reply
            this.onThreadReplyCallbacks.forEach((callback) => {
              callback(message.data)
            })
          } else if (message.type === "direct_message_edit") {
            // Handle direct message edit
            this.onDirectMessageEditCallbacks.forEach((callback) => {
              callback(message.data)
            })
          } else if (message.type === "direct_message_delete") {
            // Handle direct message delete
            this.onDirectMessageDeleteCallbacks.forEach((callback) => {
              callback(message.data)
            })
          } else if (message.type === "channel_message_edit") {
            // Handle channel message edit
            this.onChannelMessageEditCallbacks.forEach((callback) => {
              callback(message.data)
            })
          } else if (message.type === "channel_message_delete") {
            // Handle channel message delete
            this.onChannelMessageDeleteCallbacks.forEach((callback) => {
              callback(message.data)
            })
          }
        } catch (error) {
          console.error("Error parsing notification message:", error)
        }
      }

      this.ws.onclose = () => {
        this.connectionInitialized = false // Reset flag on connection close
        // Only attempt reconnection from main window
        if (this.isMainWindow) {
          this.reconnect()
        }
      }

      this.ws.onerror = (error) => {
        console.error("WebSocket error:", error)
      }
    } catch (error) {
      console.error("Error connecting to call notifications:", error)
      this.connectionInitialized = false // Reset flag on error
      this.reconnect()
    }
  }

  private reconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      setTimeout(() => {
        this.connect()
      }, this.reconnectDelay * this.reconnectAttempts)
    }
  }

  disconnect() {
    // Only allow disconnection from main window or during app shutdown
    if (!this.isMainWindow) {
      return
    }

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connectionInitialized = false
    // Stop any ongoing call sound when disconnecting
    this.stopCallSoundLoop()
  }

  // Check if WebSocket is connected
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
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

  onDirectMessage(callback: DirectMessageHandler) {
    this.onDirectMessageCallbacks.push(callback)
    return () => {
      this.onDirectMessageCallbacks = this.onDirectMessageCallbacks.filter(
        (cb) => cb !== callback,
      )
    }
  }

  onTypingIndicator(callback: TypingIndicatorHandler) {
    this.onTypingIndicatorCallbacks.push(callback)
    return () => {
      this.onTypingIndicatorCallbacks = this.onTypingIndicatorCallbacks.filter(
        (cb) => cb !== callback,
      )
    }
  }

  onMessageRead(callback: MessageReadHandler) {
    this.onMessageReadCallbacks.push(callback)
    return () => {
      this.onMessageReadCallbacks = this.onMessageReadCallbacks.filter(
        (cb) => cb !== callback,
      )
    }
  }

  onChannelMessage(callback: ChannelMessageHandler) {
    this.onChannelMessageCallbacks.push(callback)
    return () => {
      this.onChannelMessageCallbacks = this.onChannelMessageCallbacks.filter(
        (cb) => cb !== callback,
      )
    }
  }

  onChannelTypingIndicator(callback: ChannelTypingIndicatorHandler) {
    this.onChannelTypingIndicatorCallbacks.push(callback)
    return () => {
      this.onChannelTypingIndicatorCallbacks =
        this.onChannelTypingIndicatorCallbacks.filter((cb) => cb !== callback)
    }
  }

  onChannelUpdate(callback: ChannelUpdateHandler) {
    this.onChannelUpdateCallbacks.push(callback)
    return () => {
      this.onChannelUpdateCallbacks = this.onChannelUpdateCallbacks.filter(
        (cb) => cb !== callback,
      )
    }
  }

  onChannelMembershipUpdate(callback: ChannelMembershipUpdateHandler) {
    this.onChannelMembershipUpdateCallbacks.push(callback)
    return () => {
      this.onChannelMembershipUpdateCallbacks =
        this.onChannelMembershipUpdateCallbacks.filter((cb) => cb !== callback)
    }
  }

  onThreadReply(callback: ThreadReplyHandler) {
    this.onThreadReplyCallbacks.push(callback)
    return () => {
      this.onThreadReplyCallbacks = this.onThreadReplyCallbacks.filter(
        (cb) => cb !== callback,
      )
    }
  }

  onDirectMessageEdit(callback: DirectMessageEditHandler) {
    this.onDirectMessageEditCallbacks.push(callback)
    return () => {
      this.onDirectMessageEditCallbacks =
        this.onDirectMessageEditCallbacks.filter((cb) => cb !== callback)
    }
  }

  onDirectMessageDelete(callback: DirectMessageDeleteHandler) {
    this.onDirectMessageDeleteCallbacks.push(callback)
    return () => {
      this.onDirectMessageDeleteCallbacks =
        this.onDirectMessageDeleteCallbacks.filter((cb) => cb !== callback)
    }
  }

  onChannelMessageEdit(callback: ChannelMessageEditHandler) {
    this.onChannelMessageEditCallbacks.push(callback)
    return () => {
      this.onChannelMessageEditCallbacks =
        this.onChannelMessageEditCallbacks.filter((cb) => cb !== callback)
    }
  }

  onChannelMessageDelete(callback: ChannelMessageDeleteHandler) {
    this.onChannelMessageDeleteCallbacks.push(callback)
    return () => {
      this.onChannelMessageDeleteCallbacks =
        this.onChannelMessageDeleteCallbacks.filter((cb) => cb !== callback)
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

  sendTypingIndicator(targetUserId: string, isTyping: boolean) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "typing_indicator",
          targetUserId,
          isTyping,
        }),
      )
    }
  }

  sendChannelTypingIndicator(
    channelId: number,
    memberUserIds: string[],
    isTyping: boolean,
  ) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "channel_typing_indicator",
          channelId,
          memberUserIds,
          isTyping,
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

    // Only set up connections and handlers for main window
    if (!window.opener) {
      // Request notification permissions for fallback
      client.requestNotificationPermission().catch(console.error)

      // Connect to WebSocket only if not already connected
      if (!client.isConnected()) {
        client.connect()
      }
    }

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

    // Cleanup on unmount - only remove handlers, keep connection alive for singleton
    return () => {
      removeNotificationHandler()
      removeStatusHandler()
      // Don't disconnect the singleton client as other components might be using it
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

    // Open call using the new cleaner route format
    // Route will automatically authenticate and fetch token via join API
    const callUrl = `/call/${notification.callId}?type=${notification.callType}`
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
