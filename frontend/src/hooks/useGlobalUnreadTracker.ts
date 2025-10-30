import { useEffect } from "react"
import { callNotificationClient } from "@/services/callNotifications"
import { useUnreadCount } from "@/contexts/UnreadCountContext"
import { useLocation } from "@tanstack/react-router"

/**
 * Global hook to track unread messages across the entire app.
 * This hook should be mounted at the root level to ensure
 * unread counts are updated regardless of which page the user is on.
 */
export function useGlobalUnreadTracker() {
  const { incrementUnreadCount, clearUnreadCount } = useUnreadCount()
  const location = useLocation()

  useEffect(() => {
    // Check if user is currently viewing a specific chat
    const isOnBuzzChatsPage = location.pathname.includes("/buzz/chats")
    
    // Subscribe to direct messages
    const unsubscribeMessage = callNotificationClient.onDirectMessage(
      (message) => {
        // Only increment if we're NOT on the buzz/chats page
        // (the buzz/chats page handles its own logic for active chats)
        if (!isOnBuzzChatsPage) {
          incrementUnreadCount(message.sender.id)
        }
      }
    )

    return () => {
      unsubscribeMessage()
    }
  }, [location.pathname, incrementUnreadCount, clearUnreadCount])
}
