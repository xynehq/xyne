import { useState, useRef, useEffect } from "react"
import { Phone, MessageSquare } from "lucide-react"
import { CallType } from "@/types"

interface MentionUser {
  id: string
  name: string
  email: string
  photoLink?: string
}

interface MentionPillProps {
  user: MentionUser
  onMessage?: (userId: string) => void
  onCall?: (userId: string, callType: CallType) => void
  currentUserId?: string
}

export function MentionPill({
  user,
  onMessage,
  onCall,
  currentUserId,
}: MentionPillProps) {
  const [showPopover, setShowPopover] = useState(false)
  const [popoverPosition, setPopoverPosition] = useState<{
    top: number
    left: number
    showAbove: boolean
  } | null>(null)
  const pillRef = useRef<HTMLSpanElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Check if this mention is for the current user
  const isSelfMention = currentUserId && user.id && currentUserId === user.id

  // Calculate popover position - default to above
  useEffect(() => {
    if (showPopover && pillRef.current) {
      const rect = pillRef.current.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom
      const spaceAbove = rect.top
      const popoverHeight = 200 // Approximate height

      // Show above by default, only show below if not enough space above
      const showAbove = spaceAbove >= popoverHeight || spaceAbove > spaceBelow

      setPopoverPosition({
        top: showAbove ? rect.top - popoverHeight - 8 : rect.bottom + 8,
        left: rect.left,
        showAbove,
      })
    }
  }, [showPopover])

  // Close popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        pillRef.current &&
        !pillRef.current.contains(event.target as Node)
      ) {
        setShowPopover(false)
      }
    }

    if (showPopover) {
      document.addEventListener("mousedown", handleClickOutside)
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [showPopover])

  const handleMessage = (e: React.MouseEvent) => {
    e.stopPropagation()
    onMessage?.(user.id)
    setShowPopover(false)
  }

  const handleCall = (e: React.MouseEvent) => {
    e.stopPropagation()
    // Default to audio call
    onCall?.(user.id, CallType.Audio)
    setShowPopover(false)
  }

  return (
    <span className="relative inline-block">
      <span
        ref={pillRef}
        className="mention-pill inline-flex items-center px-0 py-0 mx-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 text-sm font-medium cursor-pointer"
        onClick={() => setShowPopover(!showPopover)}
        onMouseEnter={() => setShowPopover(true)}
        onMouseLeave={() => {
          // Delay hiding to allow moving to popover
          setTimeout(() => {
            if (
              !popoverRef.current?.matches(":hover") &&
              !pillRef.current?.matches(":hover")
            ) {
              setShowPopover(false)
            }
          }, 100)
        }}
      >
        @{user.name}
      </span>

      {showPopover && popoverPosition && (
        <div
          ref={popoverRef}
          className="fixed z-[9999] w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl"
          style={{
            top: `${popoverPosition.top}px`,
            left: `${popoverPosition.left}px`,
          }}
          onMouseEnter={() => setShowPopover(true)}
          onMouseLeave={() => setShowPopover(false)}
        >
          {/* User Info Header */}
          <div className="p-6 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-3">
              {user.photoLink ? (
                <img
                  src={`/api/v1/proxy/${encodeURIComponent(user.photoLink)}`}
                  alt={user.name}
                  className="w-16 h-16 rounded-full"
                />
              ) : (
                <div className="w-16 h-16 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center">
                  <span className="text-xl font-semibold text-gray-700 dark:text-gray-200">
                    {user.name
                      .split(" ")
                      .map((n) => n[0])
                      .join("")
                      .toUpperCase()
                      .slice(0, 2)}
                  </span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
                  {user.name}
                </div>
                <div className="text-sm text-gray-500 dark:text-gray-400 truncate">
                  {user.email}
                </div>
              </div>
            </div>
          </div>

          {/* Action Pills */}
          <div className="p-3 flex items-center gap-2">
            {onMessage && (
              <button
                onClick={handleMessage}
                className={`flex items-center justify-center gap-2 px-3 py-1.5 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition-colors text-sm font-medium ${
                  isSelfMention ? "w-full" : "flex-1"
                }`}
              >
                <MessageSquare size={16} />
                <span>Message</span>
              </button>
            )}
            {/* Hide Call button when mentioning yourself */}
            {onCall && !isSelfMention && (
              <button
                onClick={handleCall}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition-colors text-sm font-medium"
              >
                <Phone size={16} />
                <span>Call</span>
              </button>
            )}
          </div>
        </div>
      )}
    </span>
  )
}
