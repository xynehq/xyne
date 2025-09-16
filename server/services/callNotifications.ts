// Call notification system using WebSockets
import { EventEmitter } from "events"
import type { WSContext } from "hono/ws"
import type { ServerWebSocket } from "bun"

interface CallNotification {
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

class CallNotificationService extends EventEmitter {
  private activeConnections = new Map<string, WSContext<ServerWebSocket>>()
  
  // Register user's WebSocket connection
  registerUser(userId: string, ws: WSContext<ServerWebSocket>) {
    this.activeConnections.set(userId, ws)
    console.log(`User ${userId} connected for call notifications`)
    
    // Note: Connection cleanup is handled by the WebSocket upgrade handler
  }
  
  // Remove user connection (called when WebSocket closes)
  removeUser(userId: string) {
    const wasConnected = this.activeConnections.has(userId)
    this.activeConnections.delete(userId)
    if (wasConnected) {
      console.log(`User ${userId} disconnected from call notifications`)
    }
  }
  
  // Send call invitation to target user
  sendCallInvitation(notification: CallNotification) {
    const targetWs = this.activeConnections.get(notification.target.id)
    
    if (targetWs) {
      targetWs.send(JSON.stringify({
        type: 'call_notification',
        data: notification
      }))
      return true
    }
    
    console.log(`Target user ${notification.target.id} is not connected for real-time notifications`)
    return false
  }
  
  // Notify caller about call status
  notifyCallStatus(callerId: string, status: string, data?: any) {
    const callerWs = this.activeConnections.get(callerId)
    
    if (callerWs) {
      callerWs.send(JSON.stringify({
        type: 'call_status',
        status,
        data
      }))
    }
  }
}

export const callNotificationService = new CallNotificationService()
