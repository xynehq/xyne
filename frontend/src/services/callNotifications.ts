// WebSocket client for call notifications
import { useEffect, useRef, useState } from 'react'

export interface CallNotification {
  type: 'incoming_call' | 'call_accepted' | 'call_rejected' | 'call_ended'
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
  callType: 'video' | 'audio'
  targetToken: string
  timestamp: number
}

export interface CallStatusUpdate {
  type: 'call_status'
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

  connect() {
    try {
      // Use the same origin but with ws protocol
      const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/calls`
      this.ws = new WebSocket(wsUrl)

      this.ws.onopen = () => {
        console.log('Connected to call notifications')
        this.reconnectAttempts = 0
      }

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          
          if (message.type === 'call_notification') {
            this.onNotificationCallbacks.forEach(callback => {
              callback(message.data)
            })
          } else if (message.type === 'call_status') {
            this.onStatusCallbacks.forEach(callback => {
              callback(message)
            })
          }
        } catch (error) {
          console.error('Error parsing notification message:', error)
        }
      }

      this.ws.onclose = () => {
        console.log('Call notification connection closed')
        this.reconnect()
      }

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error)
      }
    } catch (error) {
      console.error('Error connecting to call notifications:', error)
      this.reconnect()
    }
  }

  private reconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      setTimeout(() => {
        console.log(`Reconnecting to call notifications... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`)
        this.connect()
      }, this.reconnectDelay * this.reconnectAttempts)
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  onCallNotification(callback: CallNotificationHandler) {
    this.onNotificationCallbacks.push(callback)
    return () => {
      this.onNotificationCallbacks = this.onNotificationCallbacks.filter(cb => cb !== callback)
    }
  }

  onCallStatus(callback: CallStatusHandler) {
    this.onStatusCallbacks.push(callback)
    return () => {
      this.onStatusCallbacks = this.onStatusCallbacks.filter(cb => cb !== callback)
    }
  }

  sendCallResponse(callId: string, callerId: string, response: 'accepted' | 'rejected') {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'call_response',
        callId,
        callerId,
        response
      }))
    }
  }
}

// Singleton instance
export const callNotificationClient = new CallNotificationClient()

// React hook for using call notifications
export function useCallNotifications() {
  const [incomingCall, setIncomingCall] = useState<CallNotification | null>(null)
  const [callStatus, setCallStatus] = useState<CallStatusUpdate | null>(null)
  const clientRef = useRef(callNotificationClient)

  useEffect(() => {
    const client = clientRef.current

    // Connect to WebSocket
    client.connect()

    // Set up notification handlers
    const removeNotificationHandler = client.onCallNotification((notification) => {
      if (notification.type === 'incoming_call') {
        setIncomingCall(notification)
      }
    })

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

  const acceptCall = (notification: CallNotification) => {
    clientRef.current.sendCallResponse(notification.callId, notification.caller.id, 'accepted')
    setIncomingCall(null)
    
    // Navigate to call page
    window.location.href = `/call?token=${notification.targetToken}&room=${notification.roomName}`
  }

  const rejectCall = (notification: CallNotification) => {
    clientRef.current.sendCallResponse(notification.callId, notification.caller.id, 'rejected')
    setIncomingCall(null)
  }

  const dismissCall = () => {
    setIncomingCall(null)
  }

  return {
    incomingCall,
    callStatus,
    acceptCall,
    rejectCall,
    dismissCall
  }
}
