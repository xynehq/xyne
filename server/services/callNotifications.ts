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
  timestamp: number
}

interface DirectMessageNotification {
  type: "direct_message"
  messageId: number
  messageContent: any // Lexical JSON structure
  plainTextContent: string // Extracted plain text for previews
  createdAt: Date
  sender: {
    id: string
    name: string
    email: string
    photoLink?: string | null
  }
  timestamp: number
}

interface ChannelMessageNotification {
  type: "channel_message"
  messageId: number
  channelId: number
  channelName: string
  messageContent: any // Lexical JSON structure
  plainTextContent: string // Extracted plain text for previews
  createdAt: Date
  sender: {
    id: string
    name: string
    email: string
    photoLink?: string | null
  }
  timestamp: number
}

interface ChannelTypingIndicator {
  channelId: number
  userId: string
  isTyping: boolean
}

class RealtimeMessagingService extends EventEmitter {
  private activeConnections = new Map<string, WSContext<ServerWebSocket>>()

  // Register user's WebSocket connection
  registerUser(userId: string, ws: WSContext<ServerWebSocket>) {
    this.activeConnections.set(userId, ws)

    // Note: Connection cleanup is handled by the WebSocket upgrade handler
  }

  // Remove user connection (called when WebSocket closes)
  removeUser(userId: string) {
    const wasConnected = this.activeConnections.has(userId)
    this.activeConnections.delete(userId)
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

  // Send channel message to all members
  sendChannelMessage(
    memberUserIds: string[],
    notification: ChannelMessageNotification,
  ) {
    let sentCount = 0

    for (const userId of memberUserIds) {
      const userWs = this.activeConnections.get(userId)
      if (userWs) {
        try {
          userWs.send(
            JSON.stringify({
              type: "channel_message",
              data: notification,
            }),
          )
          sentCount++
        } catch (error) {
          console.error(
            `Failed to send channel message to user ${userId}:`,
            error,
          )
        }
      }
    }

    return sentCount
  }

  // Send channel typing indicator to all members
  sendChannelTypingIndicator(
    memberUserIds: string[],
    channelId: number,
    typingUserId: string,
    isTyping: boolean,
  ) {
    let sentCount = 0

    for (const userId of memberUserIds) {
      // Don't send typing indicator back to the person typing
      if (userId === typingUserId) continue

      const userWs = this.activeConnections.get(userId)
      if (userWs) {
        try {
          userWs.send(
            JSON.stringify({
              type: "channel_typing_indicator",
              data: {
                channelId,
                userId: typingUserId,
                isTyping,
              },
            }),
          )
          sentCount++
        } catch (error) {
          console.error(
            `Failed to send channel typing indicator to user ${userId}:`,
            error,
          )
        }
      }
    }

    return sentCount
  }

  // Send channel update notification (e.g., channel renamed, archived)
  sendChannelUpdate(
    memberUserIds: string[],
    channelId: number,
    updateType: string,
    updateData: any,
  ) {
    let sentCount = 0

    for (const userId of memberUserIds) {
      const userWs = this.activeConnections.get(userId)
      if (userWs) {
        try {
          userWs.send(
            JSON.stringify({
              type: "channel_update",
              data: {
                channelId,
                updateType,
                updateData,
              },
            }),
          )
          sentCount++
        } catch (error) {
          console.error(
            `Failed to send channel update to user ${userId}:`,
            error,
          )
        }
      }
    }

    return sentCount
  }

  // Notify specific user about channel membership change
  sendChannelMembershipUpdate(
    userId: string,
    channelId: number,
    updateType: "added" | "removed" | "role_changed",
    channelData?: any,
  ) {
    const userWs = this.activeConnections.get(userId)

    if (userWs) {
      try {
        userWs.send(
          JSON.stringify({
            type: "channel_membership_update",
            data: {
              channelId,
              updateType,
              channelData,
            },
          }),
        )
        return true
      } catch (error) {
        console.error(
          `Failed to send channel membership update to user ${userId}:`,
          error,
        )
      }
    }

    return false
  }

  // Send thread reply notification to a specific user
  sendThreadReply(userId: string, notification: any) {
    const userWs = this.activeConnections.get(userId)

    if (userWs) {
      try {
        userWs.send(
          JSON.stringify({
            type: "thread_reply",
            data: notification,
          }),
        )
        return true
      } catch (error) {
        console.error(`Failed to send thread reply to user ${userId}:`, error)
      }
    }

    return false
  }

  // Send direct message edit notification
  sendDirectMessageEdit(
    targetUserId: string,
    messageId: number,
    messageContent: any,
    updatedAt: Date,
  ) {
    const userWs = this.activeConnections.get(targetUserId)

    if (userWs) {
      try {
        userWs.send(
          JSON.stringify({
            type: "direct_message_edit",
            data: {
              messageId,
              messageContent,
              isEdited: true,
              updatedAt,
            },
          }),
        )
        return true
      } catch (error) {
        console.error(
          `Failed to send message edit notification to user ${targetUserId}:`,
          error,
        )
      }
    }

    return false
  }

  // Send direct message delete notification
  sendDirectMessageDelete(targetUserId: string, messageId: number) {
    const userWs = this.activeConnections.get(targetUserId)

    if (userWs) {
      try {
        userWs.send(
          JSON.stringify({
            type: "direct_message_delete",
            data: {
              messageId,
            },
          }),
        )
        return true
      } catch (error) {
        console.error(
          `Failed to send message delete notification to user ${targetUserId}:`,
          error,
        )
      }
    }

    return false
  }

  // Send channel message edit notification to all members
  sendChannelMessageEdit(
    memberUserIds: string[],
    channelId: number,
    messageId: number,
    messageContent: any,
    updatedAt: Date,
  ) {
    let sentCount = 0

    for (const userId of memberUserIds) {
      const userWs = this.activeConnections.get(userId)
      if (userWs) {
        try {
          userWs.send(
            JSON.stringify({
              type: "channel_message_edit",
              data: {
                channelId,
                messageId,
                messageContent,
                isEdited: true,
                updatedAt,
              },
            }),
          )
          sentCount++
        } catch (error) {
          console.error(
            `Failed to send channel message edit to user ${userId}:`,
            error,
          )
        }
      }
    }

    return sentCount
  }

  // Send channel message delete notification to all members
  sendChannelMessageDelete(
    memberUserIds: string[],
    channelId: number,
    messageId: number,
  ) {
    let sentCount = 0

    for (const userId of memberUserIds) {
      const userWs = this.activeConnections.get(userId)
      if (userWs) {
        try {
          userWs.send(
            JSON.stringify({
              type: "channel_message_delete",
              data: {
                channelId,
                messageId,
              },
            }),
          )
          sentCount++
        } catch (error) {
          console.error(
            `Failed to send channel message delete to user ${userId}:`,
            error,
          )
        }
      }
    }

    return sentCount
  }
}

// Export both the new service and maintain backward compatibility
export const realtimeMessagingService = new RealtimeMessagingService()
export const callNotificationService = realtimeMessagingService // Maintain backward compatibility
