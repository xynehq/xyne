import React, { useState, useEffect, useRef } from "react"
import { Search, UserPlus, X as LucideX } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { toast } from "@/hooks/use-toast"

interface User {
  id: number
  name: string
  email: string
}

interface UserEmailInputProps {
  label: string
  placeholder?: string
  users: User[]
  selectedEmails: string[]
  onEmailsChange: (emails: string[]) => void
  selectedByOther?: string[]
  className?: string
}

export const UserEmailInput: React.FC<UserEmailInputProps> = ({
  label,
  placeholder = "Search users by name or email...",
  users,
  selectedEmails,
  onEmailsChange,
  selectedByOther,
  className = "",
}) => {
  const [searchQuery, setSearchQuery] = useState("")
  const [filteredUsers, setFilteredUsers] = useState<User[]>([])
  const [showSearchResults, setShowSearchResults] = useState(false)
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(-1)
  const searchResultsRef = useRef<HTMLDivElement>(null)

  // Filter users based on search query and exclude already selected ones
  useEffect(() => {
    if (searchQuery.trim() === "") {
      setFilteredUsers([])
      setShowSearchResults(false)
    } else {
      const lowercasedQuery = searchQuery.toLowerCase()
      const selectedEmailsSet = new Set(selectedEmails)
      const filtered = users.filter(
        (user) =>
          !selectedEmailsSet.has(user.email) &&
          (user.name.toLowerCase().includes(lowercasedQuery) ||
            user.email.toLowerCase().includes(lowercasedQuery)),
      )
      setFilteredUsers(filtered)
      setShowSearchResults(true)
    }
  }, [searchQuery, users, selectedEmails])

  // Reset search index when search query changes
  useEffect(() => {
    setSelectedSearchIndex(-1)
  }, [searchQuery])

  // Handle keyboard navigation
  useEffect(() => {
    if (selectedSearchIndex >= 0 && searchResultsRef.current) {
      const container = searchResultsRef.current
      const selectedElement = container.children[selectedSearchIndex] as HTMLElement

      if (selectedElement) {
        const containerRect = container.getBoundingClientRect()
        const elementRect = selectedElement.getBoundingClientRect()

        if (elementRect.bottom > containerRect.bottom) {
          selectedElement.scrollIntoView({ behavior: "smooth", block: "end" })
        } else if (elementRect.top < containerRect.top) {
          selectedElement.scrollIntoView({ behavior: "smooth", block: "start" })
        }
      }
    }
  }, [selectedSearchIndex])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (filteredUsers.length === 0) return

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        setSelectedSearchIndex((prev) =>
          prev >= filteredUsers.length - 1 ? 0 : prev + 1,
        )
        break
      case "ArrowUp":
        e.preventDefault()
        setSelectedSearchIndex((prev) =>
          prev <= 0 ? filteredUsers.length - 1 : prev - 1,
        )
        break
      case "Enter":
        e.preventDefault()
        if (selectedSearchIndex >= 0) {
          handleSelectUser(filteredUsers[selectedSearchIndex])
        } else if (filteredUsers.length > 0) {
          handleSelectUser(filteredUsers[0])
        }
        break
    }
  }

  const handleSelectUser = (user: User) => {
    if(selectedByOther && selectedByOther.includes(user.email)) {
      toast({
        title: "User already assigned",
        description: `${user.email} is already assigned to another role. Users cannot be both owners and regular users.`,
        variant: "destructive",
      })
      return
    }
    if (!selectedEmails.includes(user.email)) {
      onEmailsChange([...selectedEmails, user.email])
    }
    setSearchQuery("")
    setShowSearchResults(false)
  }

  const handleRemoveEmail = (email: string) => {
    onEmailsChange(selectedEmails.filter((selectedEmail) => selectedEmail !== email))
  }

  // Get user object from email for display
  const getUserFromEmail = (email: string) => {
    return users.find(user => user.email === email)
  }

  return (
    <div className={className}>
      <Label className="text-base font-medium text-gray-800 dark:text-gray-300">
        {label}{" "}
        {selectedEmails.length > 0 && (
          <span className="text-sm text-gray-500 dark:text-gray-300 ml-1">
            ({selectedEmails.length})
          </span>
        )}
      </Label>
      <div className="mt-3 dark:bg-slate-700 border-gray-300 dark:border-slate-600 dark:text-gray-100">
        <div className="relative w-full">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder={placeholder}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="pl-10 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-lg w-full dark:text-gray-100"
          />
          {showSearchResults && (
            <Card className="absolute z-10 mt-1 shadow-lg w-full dark:bg-slate-800 dark:border-slate-700">
              <CardContent
                className="p-0 max-h-[125px] overflow-y-auto w-full scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-transparent hover:scrollbar-thumb-gray-400"
                ref={searchResultsRef}
                style={{
                  scrollbarWidth: "thin",
                  WebkitOverflowScrolling: "touch",
                  scrollbarColor: "#D1D5DB transparent",
                  overflowY: "auto",
                  display: "block",
                }}
              >
                {filteredUsers.length > 0 ? (
                  filteredUsers.map((user, index) => (
                    <div
                      key={user.id}
                      className={`flex items-center justify-between p-2 hover:bg-gray-100 dark:hover:bg-slate-700 cursor-pointer border-b dark:border-slate-700 last:border-b-0 ${
                        index === selectedSearchIndex
                          ? "bg-gray-100 dark:bg-slate-700"
                          : ""
                      }`}
                      onClick={() => handleSelectUser(user)}
                    >
                      <div className="flex items-center space-x-2 min-w-0 flex-1 pr-2">
                        <span className="text-sm text-gray-600 dark:text-white truncate">
                          {user.name}
                        </span>
                        <span className="text-gray-50 flex-shrink-0">-</span>
                        <span className="text-gray-500 truncate">{user.email}</span>
                      </div>
                      <UserPlus className="h-4 w-4 text-gray-400 flex-shrink-0" />
                    </div>
                  ))
                ) : (
                  <div className="p-3 text-center text-gray-500">
                    No users found matching "{searchQuery}"
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Selected emails display */}
      <Card className="mt-3 bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-700">
        <CardContent className="p-4">
          <div className="space-y-1.5 h-[126px] overflow-y-auto">
            {selectedEmails.length > 0 ? (
              selectedEmails.map((email) => {
                const user = getUserFromEmail(email)
                return (
                  <div
                    key={email}
                    className="flex items-center justify-between p-1.5 bg-gray-100 dark:bg-slate-700 rounded-lg"
                  >
                    <div className="flex items-center space-x-2 min-w-0 flex-1 pr-2">
                      <span className="text-sm text-gray-700 dark:text-slate-100 truncate">
                        {user?.name || email}
                      </span>
                      <span className="text-gray-500 dark:text-slate-400 flex-shrink-0">
                        -
                      </span>
                      <span className="text-gray-500 dark:text-slate-400 truncate">
                        {email}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveEmail(email)}
                      className="text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200 dark:hover:bg-slate-600 h-6 w-6 p-0 flex-shrink-0"
                    >
                      <LucideX className="h-3 w-3" />
                    </Button>
                  </div>
                )
              })
            ) : (
              <div className="text-center py-4 text-gray-500 dark:text-gray-400">
                <UserPlus className="h-8 w-8 mx-auto mb-2 text-gray-400 dark:text-gray-500" />
                <p>No users added yet</p>
                <p className="text-sm">
                  Search and select users to add them to this section
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
