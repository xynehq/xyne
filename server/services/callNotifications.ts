// Real-time messaging service using WebSockets - handles both calls and direct messages
import { EventEmitter } from "events"
import type { WSContext } from "hono/ws"
import type { ServerWebSocket } from "bun"

interface CallNotification {
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
  targetToken: string
  timestamp: number
}

interface DirectMessageNotification {
  type: "direct_message"
  messageId: number
  messageContent: string
  createdAt: Date
  sender: {
    id: string
    name: string
    email: string
    photoLink?: string | null
  }
  timestamp: number
}

class RealtimeMessagingService extends EventEmitter {
  private activeConnections = new Map<string, WSContext<ServerWebSocket>>()

  // Register user's WebSocket connection
  registerUser(userId: string, ws: WSContext<ServerWebSocket>) {
    this.activeConnections.set(userId, ws)
    console.log(`User ${userId} connected for real-time messaging`)

    // Note: Connection cleanup is handled by the WebSocket upgrade handler
  }

  // Remove user connection (called when WebSocket closes)
  removeUser(userId: string) {
    const wasConnected = this.activeConnections.has(userId)
    this.activeConnections.delete(userId)
    if (wasConnected) {
      console.log(`User ${userId} disconnected from real-time messaging`)
    }
  }

  // Check if user is online
  isUserOnline(userId: string): boolean {
    return this.activeConnections.has(userId)
  }

  // Send call invitation to target user
  sendCallInvitation(notification: CallNotification) {
    const targetWs = this.activeConnections.get(notification.target.id)

    if (targetWs) {
      targetWs.send(
        JSON.stringify({
          type: "call_notification",
          data: notification,
        }),
      )
      return true
    }

    console.log(
      `Target user ${notification.target.id} is not connected for real-time notifications`,
    )
    return false
  }

  // Notify caller about call status
  notifyCallStatus(callerId: string, status: string, data?: any) {
    const callerWs = this.activeConnections.get(callerId)

    if (callerWs) {
      callerWs.send(
        JSON.stringify({
          type: "call_status",
          status,
          data,
        }),
      )
    }
  }

  // Send direct message notification to target user
  sendDirectMessage(
    targetUserId: string,
    notification: DirectMessageNotification,
  ) {
    const targetWs = this.activeConnections.get(targetUserId)

    if (targetWs) {
      targetWs.send(
        JSON.stringify({
          type: "direct_message",
          data: notification,
        }),
      )
      return true
    }

    console.log(
      `Target user ${targetUserId} is not connected for real-time messages`,
    )
    return false
  }

  // Send typing indicator
  sendTypingIndicator(
    targetUserId: string,
    isTyping: boolean,
    typingUserId: string,
  ) {
    const targetWs = this.activeConnections.get(targetUserId)

    if (targetWs) {
      targetWs.send(
        JSON.stringify({
          type: "typing_indicator",
          data: {
            isTyping,
            userId: typingUserId,
          },
        }),
      )
      return true
    }

    return false
  }

  // Send message read receipt
  sendReadReceipt(targetUserId: string, readByUserId: string) {
    const targetWs = this.activeConnections.get(targetUserId)

    if (targetWs) {
      targetWs.send(
        JSON.stringify({
          type: "message_read",
          data: {
            readByUserId,
          },
        }),
      )
      return true
    }

    return false
  }
}

// Export both the new service and maintain backward compatibility
export const realtimeMessagingService = new RealtimeMessagingService()
export const callNotificationService = realtimeMessagingService // Maintain backward compatibility
