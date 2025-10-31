import { Users as UsersIcon, History, Hash } from "lucide-react"
import { cn } from "@/lib/utils"
import { useNavigate, useMatchRoute } from "@tanstack/react-router"
import { useUnreadCount } from "@/contexts/UnreadCountContext"

export default function BuzzSidebar() {
  const navigate = useNavigate()
  const matchRoute = useMatchRoute()
  const { totalUnreadCount } = useUnreadCount()

  const isChatsActive = matchRoute({ to: "/buzz/chats" })
  const isChannelsActive = matchRoute({ to: "/buzz/channels" })
  const isHistoryActive = matchRoute({ to: "/buzz/history" })

  return (
    <div
      className={cn(
        "fixed left-[52px] top-0 h-screen w-[60px] bg-white dark:bg-[#232323] border-r border-[#D7E0E9] dark:border-gray-700 flex flex-col z-10",
      )}
    >
      <div className="flex flex-col items-center pt-6 gap-2">
        <button
          onClick={() => {
            navigate({ to: "/buzz/chats" })
          }}
          className={cn(
            "relative flex w-10 h-10 rounded-lg items-center justify-center cursor-pointer transition-colors",
            isChatsActive
              ? "bg-[#D8DFE680] dark:bg-gray-700"
              : "hover:bg-[#D8DFE680] dark:hover:bg-gray-700",
          )}
          title="Chats"
        >
          <UsersIcon
            size={20}
            className={cn(
              isChatsActive
                ? "text-[#384049] dark:text-[#F1F3F4]"
                : "text-gray-500 dark:text-gray-400",
            )}
          />
          {/* Unread Count Badge */}
          {totalUnreadCount > 0 && (
            <div className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 flex items-center justify-center bg-red-600 dark:bg-red-500 rounded-full border-2 border-white dark:border-[#232323]">
              <span className="text-[10px] font-bold text-white leading-none">
                {totalUnreadCount > 99 ? "99+" : totalUnreadCount}
              </span>
            </div>
          )}
        </button>
        <button
          onClick={() => {
            navigate({ to: "/buzz/channels" })
          }}
          className={cn(
            "flex w-10 h-10 rounded-lg items-center justify-center cursor-pointer transition-colors",
            isChannelsActive
              ? "bg-[#D8DFE680] dark:bg-gray-700"
              : "hover:bg-[#D8DFE680] dark:hover:bg-gray-700",
          )}
          title="Channels"
        >
          <Hash
            size={20}
            className={cn(
              isChannelsActive
                ? "text-[#384049] dark:text-[#F1F3F4]"
                : "text-gray-500 dark:text-gray-400",
            )}
          />
        </button>
        <button
          onClick={() => {
            navigate({ to: "/buzz/history" })
          }}
          className={cn(
            "flex w-10 h-10 rounded-lg items-center justify-center cursor-pointer transition-colors",
            isHistoryActive
              ? "bg-[#D8DFE680] dark:bg-gray-700"
              : "hover:bg-[#D8DFE680] dark:hover:bg-gray-700",
          )}
          title="Call History"
        >
          <History
            size={20}
            className={cn(
              isHistoryActive
                ? "text-[#384049] dark:text-[#F1F3F4]"
                : "text-gray-500 dark:text-gray-400",
            )}
          />
        </button>
      </div>
    </div>
  )
}
