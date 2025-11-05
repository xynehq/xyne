import {
  createContext,
  useContext,
  useState,
  ReactNode,
  useEffect,
} from "react"
import { api } from "@/api"

interface UnreadCountContextType {
  totalUnreadCount: number
  unreadCounts: Record<string, number>
  setTotalUnreadCount: (count: number) => void
  setUnreadCounts: (counts: Record<string, number>) => void
  incrementUnreadCount: (userId: string) => void
  clearUnreadCount: (userId: string) => void
  refreshUnreadCounts: () => Promise<void>
}

interface UnreadCountData {
  userId: string
  count: number
  user: {
    id: string
    name: string
    email: string
    photoLink?: string | null
  }
}

const UnreadCountContext = createContext<UnreadCountContextType | undefined>(
  undefined,
)

export function UnreadCountProvider({ children }: { children: ReactNode }) {
  const [totalUnreadCount, setTotalUnreadCount] = useState(0)
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({})
  const [initialized, setInitialized] = useState(false)

  // Fetch unread counts from API
  const refreshUnreadCounts = async () => {
    try {
      const response = await api.messages["unread-counts"].$get()
      if (response.ok) {
        const data = await response.json()
        const counts: Record<string, number> = {}
        let total = 0

        data.unreadCounts.forEach((item: UnreadCountData) => {
          counts[item.userId] = item.count
          total += item.count
        })

        setUnreadCounts(counts)
        setTotalUnreadCount(total)
      }
    } catch (error) {
      console.error("Failed to fetch unread counts:", error)
    }
  }

  // Initialize unread counts on mount
  useEffect(() => {
    if (!initialized) {
      refreshUnreadCounts()
      setInitialized(true)
    }
  }, [initialized])

  // Note: We don't subscribe to WebSocket here because we need to know
  // which chat is currently open to avoid incrementing counts for active chats.
  // This is handled in individual components like buzz/chats.tsx

  // Helper function to increment count for a specific user
  const incrementUnreadCount = (userId: string) => {
    setUnreadCounts((prev) => {
      const newCounts = {
        ...prev,
        [userId]: (prev[userId] || 0) + 1,
      }
      const total = Object.values(newCounts).reduce(
        (sum, count) => sum + count,
        0,
      )
      setTotalUnreadCount(total)
      return newCounts
    })
  }

  // Helper function to clear count for a specific user
  const clearUnreadCount = (userId: string) => {
    setUnreadCounts((prev) => {
      const newCounts = { ...prev }
      delete newCounts[userId]
      const total = Object.values(newCounts).reduce(
        (sum, count) => sum + count,
        0,
      )
      setTotalUnreadCount(total)
      return newCounts
    })
  }

  return (
    <UnreadCountContext.Provider
      value={{
        totalUnreadCount,
        unreadCounts,
        setTotalUnreadCount,
        setUnreadCounts,
        incrementUnreadCount,
        clearUnreadCount,
        refreshUnreadCounts,
      }}
    >
      {children}
    </UnreadCountContext.Provider>
  )
}

export function useUnreadCount() {
  const context = useContext(UnreadCountContext)
  if (context === undefined) {
    throw new Error("useUnreadCount must be used within an UnreadCountProvider")
  }
  return context
}
