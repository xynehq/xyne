import { useState, useEffect, useRef } from "react"
import { X } from "lucide-react"
import { api } from "@/api"
import { cn } from "@/lib/utils"

interface User {
  id: string
  name: string
  email: string
  photoLink?: string | null
}

interface UserPillSelectorProps {
  selectedUsers: User[]
  onUsersChange: (users: User[]) => void
  placeholder?: string
  maxHeight?: string
  excludeEmails?: string[]
}

export default function UserPillSelector({
  selectedUsers,
  onUsersChange,
  placeholder = "Search for people...",
  maxHeight = "max-h-40",
  excludeEmails = [],
}: UserPillSelectorProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [suggestions, setSuggestions] = useState<User[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Search for users
  const searchUsers = async (query: string) => {
    if (!query.trim()) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }

    try {
      const response = await api.workspace.users.search.$get({
        query: { q: query },
      })

      if (response.ok) {
        const data = await response.json()
        // Filter out already selected users and excluded emails
        const filtered = (data.users || []).filter(
          (user: User) =>
            !selectedUsers.find((u) => u.id === user.id) &&
            !excludeEmails.includes(user.email),
        )
        setSuggestions(filtered)
        setShowSuggestions(filtered.length > 0)
        setHighlightedIndex(0)
      }
    } catch (error) {
      console.error("Failed to search users:", error)
    }
  }

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      searchUsers(searchQuery)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchQuery, selectedUsers])

  // Handle user selection
  const handleSelectUser = (user: User) => {
    onUsersChange([...selectedUsers, user])
    setSearchQuery("")
    setSuggestions([])
    setShowSuggestions(false)
    inputRef.current?.focus()
  }

  // Handle user removal
  const handleRemoveUser = (userId: string) => {
    onUsersChange(selectedUsers.filter((u) => u.id !== userId))
    inputRef.current?.focus()
  }

  // Keep suggestions aligned with excludeEmails and selectedUsers changes
  useEffect(() => {
    setSuggestions((prev) => {
      const filtered = prev.filter(
        (user) =>
          !selectedUsers.some((u) => u.id === user.id) &&
          !excludeEmails.includes(user.email),
      )

      if (filtered.length !== prev.length) {
        setShowSuggestions(filtered.length > 0)
        setHighlightedIndex((current) =>
          filtered.length === 0 ? 0 : Math.min(current, filtered.length - 1),
        )
      }

      return filtered
    })
  }, [excludeEmails, selectedUsers])

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions) {
      // Backspace on empty input removes last user
      if (e.key === "Backspace" && !searchQuery && selectedUsers.length > 0) {
        handleRemoveUser(selectedUsers[selectedUsers.length - 1].id)
      }
      return
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        setHighlightedIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : prev,
        )
        break
      case "ArrowUp":
        e.preventDefault()
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : 0))
        break
      case "Enter":
        e.preventDefault()
        if (suggestions[highlightedIndex]) {
          handleSelectUser(suggestions[highlightedIndex])
        }
        break
      case "Escape":
        e.preventDefault()
        setShowSuggestions(false)
        setSearchQuery("")
        break
    }
  }

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setShowSuggestions(false)
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Input Container with Pills */}
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 p-2 border-2 rounded-lg bg-transparent transition-colors",
          showSuggestions
            ? "border-blue-500 dark:border-blue-400"
            : "border-gray-300 dark:border-gray-600",
          "hover:border-blue-400 dark:hover:border-blue-500",
          "focus-within:border-blue-500 dark:focus-within:border-blue-400",
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {/* User Pills */}
        {selectedUsers.map((user) => (
          <div
            key={user.id}
            className="flex items-center gap-1 px-1 py-0.5 bg-blue-100 dark:bg-blue-900/40 border border-blue-300 dark:border-blue-700 rounded"
          >
            {/* User Avatar */}
            {user.photoLink ? (
              <img
                src={`/api/v1/proxy/${encodeURIComponent(user.photoLink)}`}
                alt={user.name}
                className="w-4 h-4 rounded-sm"
              />
            ) : (
              <div className="w-4 h-4 rounded-sm bg-blue-600 dark:bg-blue-700 flex items-center justify-center">
                <span className="text-[8px] font-semibold text-white">
                  {user.name
                    .split(" ")
                    .map((n: string) => n[0])
                    .join("")
                    .toUpperCase()
                    .slice(0, 2)}
                </span>
              </div>
            )}

            {/* User Name */}
            <span className="text-xs font-medium text-blue-900 dark:text-blue-100">
              {user.name}
            </span>

            {/* Remove Button */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                handleRemoveUser(user.id)
              }}
              className="flex items-center justify-center w-3.5 h-3.5 rounded hover:bg-blue-200 dark:hover:bg-blue-800 transition-colors"
            >
              <X className="w-2.5 h-2.5 text-blue-700 dark:text-blue-300" />
            </button>
          </div>
        ))}

        {/* Input */}
        <input
          ref={inputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={selectedUsers.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[120px] bg-transparent outline-none text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-500"
        />
      </div>

      {/* Suggestions Dropdown */}
      {showSuggestions && suggestions.length > 0 && (
        <div
          className={cn(
            "absolute z-50 w-full mt-1 bg-white dark:bg-[#2A2A2A] border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-y-auto",
            maxHeight,
          )}
        >
          {suggestions.map((user, index) => (
            <div
              key={user.id}
              onClick={() => handleSelectUser(user)}
              className={cn(
                "flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors",
                highlightedIndex === index
                  ? "bg-blue-50 dark:bg-blue-900/20"
                  : "hover:bg-gray-50 dark:hover:bg-gray-800",
              )}
            >
              {/* User Avatar */}
              {user.photoLink ? (
                <img
                  src={`/api/v1/proxy/${encodeURIComponent(user.photoLink)}`}
                  alt={user.name}
                  className="w-8 h-8 rounded-full"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-blue-600 dark:bg-blue-700 flex items-center justify-center">
                  <span className="text-xs font-semibold text-white">
                    {user.name
                      .split(" ")
                      .map((n: string) => n[0])
                      .join("")
                      .toUpperCase()
                      .slice(0, 2)}
                  </span>
                </div>
              )}

              {/* User Info */}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                  {user.name}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {user.email}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
