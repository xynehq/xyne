import { useState, useEffect, useCallback } from "react"
import { format } from "date-fns"
import {
  MessageSquare,
  Bot,
  ThumbsUp,
  ThumbsDown,
  Search,
  Eye,
  Calendar,
  Filter,
  X,
  User,
  Loader2,
  Users,
} from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DateRangePicker } from "@/components/ui/date-range-picker"
import { formatCostInINR } from "@/lib/utils"
import { api } from "@/api"

export interface AdminChat {
  externalId: string
  title: string
  createdAt: string
  userName: string
  userEmail: string
  agentId?: string | null
  agentName?: string | null
  messageCount: number
  totalCost: number
  totalTokens: number
  likes: number
  dislikes: number
  isBookmarked: boolean
}

export interface AdminUser {
  id: number
  email: string
  name: string
  role: string
  createdAt: string
  lastLogin?: string | null
  isActive: boolean
  totalChats: number
  totalMessages: number
  likes: number
  dislikes: number
  totalCost: number
  totalTokens: number
}

// The API returns a simple array of strings (user message content)
type ChatMessages = string[]

interface ChatViewDialogProps {
  isOpen: boolean
  onClose: () => void
  chat: AdminChat | null
}

const ChatViewDialog = ({ isOpen, onClose, chat }: ChatViewDialogProps) => {
  const [messages, setMessages] = useState<ChatMessages>([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [messagesError, setMessagesError] = useState<string | null>(null)

  const fetchChatMessages = useCallback(async (chatId: string) => {
    try {
      setLoadingMessages(true)
      setMessagesError(null)

      const response = await api.admin.chat.queries[chatId].$get()

      if (!response.ok) {
        throw new Error("Failed to fetch chat messages")
      }

      const data = await response.json()

      if (data.success) {
        setMessages(data.data || [])
      } else {
        setMessagesError(data.message || "Failed to load messages")
      }
    } catch (error) {
      console.error("Error fetching chat messages:", error)
      setMessagesError("Failed to load messages. Please try again.")
    } finally {
      setLoadingMessages(false)
    }
  }, [])

  // Fetch messages when dialog opens and chat changes
  useEffect(() => {
    if (isOpen && chat) {
      fetchChatMessages(chat.externalId)
    } else {
      // Clear messages when dialog closes
      setMessages([])
      setMessagesError(null)
    }
  }, [isOpen, chat, fetchChatMessages])

  if (!chat) return null

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="text-xl font-bold pr-8">
              Chat Details
            </DialogTitle>
            <button
              onClick={onClose}
              className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </DialogHeader>

        <div className="space-y-6 flex-1 overflow-hidden">
          {/* Chat Title & Status */}
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold">{chat.title}</h3>
            {chat.agentId && (
              <Badge variant="secondary" className="flex items-center gap-1">
                <Bot className="h-3 w-3" />
                {chat.agentName || "Agent Chat"}
              </Badge>
            )}
            {chat.isBookmarked && <Badge variant="outline">Bookmarked</Badge>}
          </div>

          {/* User Information */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <User className="h-4 w-4" />
                User Information
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-sm">
                <span className="font-medium">Name:</span> {chat.userName} |{" "}
                <span className="font-medium">Email:</span> {chat.userEmail}
              </div>
            </CardContent>
          </Card>
          {/* Agent Information (if applicable) */}
          {chat.agentId && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Bot className="h-4 w-4" />
                  Agent Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-sm font-medium">Agent Name:</span>
                  <span className="text-sm">
                    {chat.agentName || "Unknown Agent"}
                  </span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Chat Messages */}
          <Card className="flex-1 flex flex-col min-h-0">
            <CardHeader className="pb-3 flex-shrink-0">
              <CardTitle className="text-base flex items-center gap-2">
                <MessageSquare className="h-4 w-4" />
                Messages
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col min-h-0">
              {loadingMessages ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin mr-2" />
                  <span className="text-sm text-muted-foreground">
                    Loading messages...
                  </span>
                </div>
              ) : messagesError ? (
                <div className="text-center py-8">
                  <div className="text-red-600 text-sm mb-2">
                    Error loading messages
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {messagesError}
                  </div>
                  <button
                    onClick={() => fetchChatMessages(chat.externalId)}
                    className="mt-3 px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                  >
                    Retry
                  </button>
                </div>
              ) : messages.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No messages found in this chat</p>
                </div>
              ) : (
                <div className="flex flex-col flex-1 min-h-0">
                  <div className="text-xs text-muted-foreground mb-4 p-2 bg-muted/50 rounded flex-shrink-0">
                    <User className="h-3 w-3 inline mr-1" />
                    Showing user messages only ({messages.length} messages)
                  </div>
                  <div className="space-y-3 overflow-y-auto pr-4 flex-1 min-h-0 max-h-96">
                    {messages.map((message, index) => (
                      <div key={index} className="flex justify-end">
                        <div className="max-w-[85%] rounded-lg p-3 bg-white dark:bg-blue-600 text-black dark:text-white border border-gray-200 dark:border-transparent">
                          <div className="text-sm whitespace-pre-wrap break-words">
                            {message}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface AdminChatsTableProps {
  chats: AdminChat[]
  loading?: boolean
  onChatView?: (chat: AdminChat) => void
  // Controlled component props for filters
  searchInput: string
  searchQuery: string
  onSearchInputChange: (input: string) => void
  onSearch: () => void
  onClearSearch: () => void
  onClearAllFilters: () => void
  filterType: "all" | "agent" | "normal"
  onFilterTypeChange: (type: "all" | "agent" | "normal") => void
  userFilter: "all" | string
  onUserFilterChange: (filter: "all" | string) => void
  sortBy: "created" | "messages" | "cost" | "tokens"
  onSortByChange: (sortBy: "created" | "messages" | "cost" | "tokens") => void
  // Date range filter props
  dateFrom: Date | undefined
  dateTo: Date | undefined
  onDateChange: (from: Date | undefined, to: Date | undefined) => void
  // Props to control visibility of user dropdown
  showUserFilter?: boolean
}

export const AdminChatsTable = ({
  chats,
  loading = false,
  onChatView,
  searchInput,
  searchQuery,
  onSearchInputChange,
  onSearch,
  onClearSearch,
  onClearAllFilters,
  filterType,
  onFilterTypeChange,
  userFilter,
  onUserFilterChange,
  sortBy,
  onSortByChange,
  dateFrom,
  dateTo,
  onDateChange,
  showUserFilter = true,
}: AdminChatsTableProps) => {
  const [selectedChat, setSelectedChat] = useState<AdminChat | null>(null)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)

  const handleViewChat = (chat: AdminChat) => {
    setSelectedChat(chat)
    setIsDialogOpen(true)
    onChatView?.(chat)
  }

  const handleCloseDialog = () => {
    setIsDialogOpen(false)
    setSelectedChat(null)
  }

  // Check if any filters are active
  const hasActiveFilters =
    searchQuery.trim() !== "" ||
    filterType !== "all" ||
    userFilter !== "all" ||
    sortBy !== "created" ||
    dateFrom !== undefined ||
    dateTo !== undefined

  // Fetch users on component mount
  useEffect(() => {
    const fetchUsers = async () => {
      try {
        setLoadingUsers(true)
        const response = await api.admin.users.$get()

        if (!response.ok) {
          throw new Error("Failed to fetch users")
        }

        const usersData = await response.json()
        setUsers(usersData)
      } catch (error) {
        console.error("Error fetching users:", error)
      } finally {
        setLoadingUsers(false)
      }
    }

    fetchUsers()
  }, [])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            All Chats
          </CardTitle>
          <CardDescription>System-wide chat conversations</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="text-muted-foreground">Loading chats data...</div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="h-5 w-5" />
                All Chats
              </CardTitle>
              <CardDescription>
                System-wide chat conversations with viewing capability
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-sm">
              {chats.length} total chats
            </Badge>
          </div>

          {/* Search and Filter Controls */}
          <div className="mt-4">
            <div className="flex flex-col sm:flex-row gap-4">
              {/* Search */}
              <div className="relative flex-1">
              <input
                type="text"
                placeholder="Search by chat title, user name, email, or agent..."
                value={searchInput}
                onChange={(e) => {
                  const newValue = e.target.value
                  onSearchInputChange(newValue)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    onSearch()
                  }
                }}
                className="w-full pl-2 pr-16 py-2 text-sm border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
              />
              <div className="absolute right-2 top-1/2 transform -translate-y-1/2 flex items-center gap-1">
                {searchInput && (
                  <button
                    type="button"
                    onClick={onClearSearch}
                    className="p-1 hover:bg-muted rounded-sm transition-colors"
                    title="Clear search"
                  >
                    <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={onSearch}
                  className="p-1 hover:bg-muted rounded-sm transition-colors"
                  title="Search"
                >
                  <Search className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                </button>
              </div>
            </div>

            {/* Filter Dropdown */}
            <div className="relative">
              <select
                value={filterType}
                onChange={(e) =>
                  onFilterTypeChange(
                    e.target.value as "all" | "agent" | "normal",
                  )
                }
                className="appearance-none bg-background border border-input rounded-md px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
              >
                <option value="all">All Chats</option>
                <option value="agent">Agent Chats</option>
                <option value="normal">Normal Chats</option>
              </select>
              <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                <Filter className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>

            {/* User Filter Dropdown - Only show if not filtering by specific user */}
            {showUserFilter && (
              <div className="relative">
                <select
                  value={userFilter}
                  onChange={(e) =>
                    onUserFilterChange(
                      e.target.value === "all" ? "all" : e.target.value,
                    )
                  }
                  className="appearance-none bg-background border border-input rounded-md px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent min-w-[150px]"
                  disabled={loadingUsers}
                >
                  <option value="all">All Users</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id.toString()}>
                      {user.name} ({user.email})
                    </option>
                  ))}
                </select>
                <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                  {loadingUsers ? (
                    <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />
                  ) : (
                    <Users className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
              </div>
            )}

            {/* Date Range Picker */}
            <DateRangePicker
              from={dateFrom}
              to={dateTo}
              onSelect={onDateChange}
              placeholder="Select date range"
            />

            {/* Sort Dropdown */}
            <div className="relative">
              <select
                value={sortBy}
                onChange={(e) =>
                  onSortByChange(
                    e.target.value as
                      | "created"
                      | "messages"
                      | "cost"
                      | "tokens",
                  )
                }
                className="appearance-none bg-background border border-input rounded-md px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
              >
                <option value="created">Sort by Date</option>
                <option value="messages">Sort by Messages</option>
                <option value="cost">Sort by Cost</option>
                <option value="tokens">Sort by Tokens</option>
              </select>
              <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                <svg
                  className="h-4 w-4 text-muted-foreground"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </div>
            </div>

              {/* Clear All Filters Button */}
              <button
                type="button"
                onClick={onClearAllFilters}
                disabled={!hasActiveFilters}
                className={`px-3 py-2 text-sm border border-input rounded-md transition-colors flex items-center gap-2 ${
                  hasActiveFilters
                    ? "bg-background hover:bg-muted text-foreground"
                    : "bg-muted/50 text-muted-foreground cursor-not-allowed"
                }`}
                title={
                  hasActiveFilters
                    ? "Clear all filters"
                    : "No active filters to clear"
                }
              >
                Clear
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {chats.length === 0 ? (
            <div className="text-center py-12">
              <MessageSquare className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-50" />
              <p className="text-muted-foreground">No chat data available</p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Chats List */}
              <div className="space-y-2 max-h-[55vh] overflow-y-auto">
                {chats.length > 0 ? (
                  chats.map((chat, index) => (
                    <div
                      key={chat.externalId}
                      className="flex items-center justify-between p-4 rounded-lg hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center space-x-4 flex-1">
                        <div className="flex items-center justify-center w-8 h-8 text-sm font-bold text-white bg-gradient-to-br from-purple-500 to-blue-600 rounded-full">
                          {index + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <h4
                              className="text-sm font-medium truncate"
                              title={chat.title}
                            >
                              {chat.title}
                            </h4>
                            {chat.agentId && (
                              <Badge variant="secondary" className="text-xs">
                                <Bot className="h-3 w-3 mr-1" />
                                {chat.agentName || "Agent"}
                              </Badge>
                            )}
                            {chat.isBookmarked && (
                              <Badge variant="outline" className="text-xs">
                                Bookmarked
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground truncate">
                            User: {chat.userName} ({chat.userEmail})
                          </p>
                          <p className="text-xs text-muted-foreground">
                            <Calendar className="h-3 w-3 inline mr-1" />
                            {new Date(chat.createdAt).toLocaleDateString(
                              "en-US",
                              {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              },
                            )}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 text-right">
                        <div className="flex flex-col items-center">
                          <span className="text-sm font-medium">
                            {chat.messageCount}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            messages
                          </span>
                        </div>
                        <div className="flex flex-col items-center">
                          <span className="text-sm font-medium">
                            {formatCostInINR(chat.totalCost)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            cost
                          </span>
                        </div>
                        <div className="flex flex-col items-center">
                          <span className="text-sm font-medium">
                            {chat.totalTokens.toLocaleString()}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            tokens
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <div className="flex items-center gap-1 text-green-600">
                            <ThumbsUp className="h-3 w-3" />
                            <span>{chat.likes}</span>
                          </div>
                          <div className="flex items-center gap-1 text-red-600">
                            <ThumbsDown className="h-3 w-3" />
                            <span>{chat.dislikes}</span>
                          </div>
                        </div>
                        <button
                          onClick={() => handleViewChat(chat)}
                          className="ml-3 px-3 py-1.5 text-xs text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 hover:border-blue-300 transition-colors font-medium flex items-center gap-1"
                        >
                          <Eye className="h-3 w-3" />
                          View
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <Search className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">
                      No chats found matching your criteria
                    </p>
                  </div>
                )}
              </div>

              {/* Results Summary */}
              {chats.length > 0 && (
                <div className="text-xs text-muted-foreground text-center pt-2 border-t">
                  Showing {chats.length} chats
                  {searchQuery && ` • Search: "${searchQuery}"`}
                  {filterType !== "all" && ` • ${filterType} chats only`}
                  {userFilter !== "all" &&
                    ` • User: ${users.find((u) => u.id.toString() === userFilter)?.name || "Unknown"}`}
                  {sortBy !== "created" && ` • Sorted by ${sortBy}`}
                  {(dateFrom || dateTo) && ` • Date: ${dateFrom ? format(new Date(dateFrom), 'dd/MM/yyyy') : 'Any'} - ${dateTo ? format(new Date(dateTo), 'dd/MM/yyyy') : 'Any'}`}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Chat View Dialog */}
      <ChatViewDialog
        isOpen={isDialogOpen}
        onClose={handleCloseDialog}
        chat={selectedChat}
      />
    </>
  )
}
