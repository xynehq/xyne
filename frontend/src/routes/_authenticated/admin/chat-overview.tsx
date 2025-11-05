import {
  createFileRoute,
  redirect,
  useRouterState,
  useNavigate,
} from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { useAdminUserSelectionStore } from "@/store/useAdminUserSelectionStore"
import { api } from "@/api"
import { errorComponent } from "@/components/error"
import { Sidebar } from "@/components/Sidebar"
import { AdminChatsTable } from "@/components/AdminChatsTable"
import type { AdminChat } from "@/components/AdminChatsTable"
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { z } from "zod"

const chatOverviewSearchSchema = z.object({
  userName: z.string().optional(),
  userEmail: z.string().optional(),
  page: z.string().optional(),
  offset: z.string().optional(),
  search: z.string().optional(),
})

type ChatOverviewSearch = z.infer<typeof chatOverviewSearchSchema>

export const Route = createFileRoute("/_authenticated/admin/chat-overview")({
  beforeLoad: ({ context }) => {
    if (
      !(context.user.role === "Admin" || context.user.role === "SuperAdmin")
    ) {
      throw redirect({ to: "/" })
    }
  },
  validateSearch: (search: Record<string, unknown>): ChatOverviewSearch => {
    return chatOverviewSearchSchema.parse(search)
  },
  component: () => {
    const matches = useRouterState({ select: (s) => s.matches })
    const { user, workspace, agentWhiteList } =
      matches[matches.length - 1].context
    return (
      <ChatOverviewPage
        user={user}
        workspace={workspace}
        agentWhiteList={agentWhiteList}
      />
    )
  },
  errorComponent: errorComponent,
})

interface ChatOverviewPageProps {
  user: any
  workspace: any
  agentWhiteList: boolean
}

function ChatOverviewPage({
  user,
  workspace,
  agentWhiteList,
}: ChatOverviewPageProps) {
  const navigate = useNavigate()
  const search = Route.useSearch()
  const { selectedUser, clearSelectedUser, dateRange, setDateRange } = useAdminUserSelectionStore()
  const [adminChats, setAdminChats] = useState<AdminChat[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  // Pagination metadata state
  const [paginationMetadata, setPaginationMetadata] = useState<{
    totalCount: number
    hasNextPage: boolean
    hasPreviousPage: boolean
  } | null>(null)

  // Lift filter state from AdminChatsTable
  const [searchInput, setSearchInput] = useState<string>(search.search || "") // What user is typing
  const [searchQuery, setSearchQuery] = useState<string>("") // Actual search query for API
  const [filterType, setFilterType] = useState<"all" | "agent" | "normal">(
    "all",
  )
  const [userFilter, setUserFilter] = useState<"all" | string>("all")
  const [sortBy, setSortBy] = useState<
    "created" | "messages" | "cost" | "tokens"
  >("created")

  // Reset to page 1 when filter changes
  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, filterType, userFilter, sortBy, dateRange.from, dateRange.to])

  // Function to execute search
  const handleSearch = () => {
    setSearchQuery(searchInput.trim())
  }

  // Function to clear search
  const handleClearSearch = () => {
    setSearchInput("")
    setSearchQuery("")
  }

  // Function to clear all filters
  const handleClearAllFilters = () => {
    setSearchInput("")
    setSearchQuery("")
    setFilterType("all")
    setUserFilter("all")
    setSortBy("created")
    setDateRange(undefined, undefined)
  }

  useEffect(() => {
    const fetchAdminChats = async () => {
      try {
        setLoading(true)
        setError(null)

        // Build query with pagination and filters
        const query: any = {
          page: currentPage.toString(),
          offset: pageSize.toString(),
          paginated: "true",
        }

        // Add server-side filters
        if (search.search) {
          query.search = search.search
        }
        if (searchQuery.trim()) {
          query.search = searchQuery.trim()
        }
        // Use userId for filtering - prioritize selectedUser from store, then userFilter
        if (selectedUser?.userId) {
          query.userId = selectedUser.userId.toString()
        } else if (userFilter !== "all") {
          query.userId = userFilter
        }
        if (filterType !== "all") {
          query.filterType = filterType
        }
        if (sortBy !== "created") {
          query.sortBy = sortBy
        }
        // Add date range filters
        if (dateRange.from) {
          query.from = dateRange.from.toISOString()
        }
        if (dateRange.to) {
          query.to = dateRange.to.toISOString()
        }

        const [adminChatsResponse, adminAgentsResponse] = await Promise.all([
          api.admin.chats.$get({ query }),
          api.admin.agents.$get(),
        ])

        if (!adminChatsResponse.ok || !adminAgentsResponse.ok) {
          throw new Error("Failed to fetch admin data")
        }

        const adminChatsData = await adminChatsResponse.json()
        const adminAgents = await adminAgentsResponse.json()

        // Handle both new pagination format and old format for backward compatibility
        let chatsArray: any[]
        let paginationMeta: {
          totalCount: number
          hasNextPage: boolean
          hasPreviousPage: boolean
        } | null = null

        if (
          adminChatsData &&
          typeof adminChatsData === "object" &&
          "data" in adminChatsData &&
          "pagination" in adminChatsData
        ) {
          // New format with pagination metadata
          chatsArray = adminChatsData.data
          paginationMeta = {
            totalCount: adminChatsData.pagination.totalCount,
            hasNextPage: adminChatsData.pagination.hasNextPage,
            hasPreviousPage: adminChatsData.pagination.hasPreviousPage,
          }
        } else if (Array.isArray(adminChatsData)) {
          // Old format - direct array
          chatsArray = adminChatsData
          // Fallback: use length-based logic for hasNextPage
          paginationMeta = {
            totalCount: adminChatsData.length, // This is just the current page count
            hasNextPage: adminChatsData.length >= pageSize, // Old logic as fallback
            hasPreviousPage: currentPage > 1,
          }
        } else {
          throw new Error("Invalid response format from admin chats API")
        }

        // Set pagination metadata
        setPaginationMetadata(paginationMeta)

        // Process and set the admin chats data
        setAdminChats(
          chatsArray.map((chat: any) => ({
            externalId: chat.externalId,
            title: chat.title || "Untitled Chat",
            createdAt: chat.createdAt,
            userName: (chat.userName ??
              chat.user?.name ??
              "Unknown User") as string,
            userEmail: (chat.userEmail ?? chat.user?.email ?? "") as string,
            agentId: chat.agentId,
            agentName:
              chat.agentName ||
              (chat.agentId
                ? adminAgents.find((a: any) => a.externalId === chat.agentId)
                    ?.name
                : null),
            messageCount: chat.messageCount || chat.messages?.length || 0,
            totalCost: chat.totalCost || 0,
            totalTokens: chat.totalTokens || 0,
            likes: chat.likes || 0,
            dislikes: chat.dislikes || 0,
            isBookmarked: chat.isBookmarked || false,
          })),
        )
      } catch (err) {
        console.error("Error fetching admin chats:", err)
        setError(
          err instanceof Error ? err.message : "Failed to fetch admin data",
        )
      } finally {
        setLoading(false)
      }
    }

    fetchAdminChats()
  }, [
    search.search,
    currentPage,
    pageSize,
    searchQuery,
    filterType,
    userFilter,
    sortBy,
    selectedUser?.userId,
    dateRange.from,
    dateRange.to,
  ])

  const handleBackToDashboard = () => {
    // Clear selected user when navigating back to dashboard
    clearSelectedUser()
    navigate({ to: "/dashboard" })
  }

  // Determine page title and description based on filter (check store first, then URL)
  const getPageInfo = () => {
    const userEmail = selectedUser?.userEmail || search.userEmail
    const userName = selectedUser?.userName || search.userName

    if (userEmail) {
      return {
        title: `Chats for ${userName || userEmail}`,
        description: `All chat conversations for user: ${userEmail}`,
      }
    }
    return {
      title: "All Chats Overview",
      description:
        "Complete overview of all chat conversations across the platform",
    }
  }

  const { title, description } = getPageInfo()

  return (
    <div className="h-full w-full flex dark:bg-[#1E1E1E]">
      <Sidebar
        photoLink={user?.photoLink ?? ""}
        role={user?.role}
        isAgentMode={agentWhiteList}
      />
      <div className="flex flex-col flex-grow h-full ml-[52px]">
        <div className="p-4 space-y-4 max-w-7xl mx-auto w-full">
          {/* Header with Back Button */}
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBackToDashboard}
              className="flex items-center gap-2 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Dashboard
            </Button>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl tracking-wider font-display">{title}</h1>
              <p className="text-muted-foreground">{description}</p>
            </div>
          </div>

          {/* Error State */}
          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 px-4 py-3 rounded-lg">
              <p className="font-medium">Error loading chats</p>
              <p className="text-sm">{error}</p>
            </div>
          )}

          {/* Chat Overview Table */}
          <AdminChatsTable
            chats={adminChats}
            loading={loading}
            searchInput={searchInput}
            searchQuery={searchQuery}
            onSearchInputChange={setSearchInput}
            onSearch={handleSearch}
            onClearSearch={handleClearSearch}
            onClearAllFilters={handleClearAllFilters}
            filterType={filterType}
            onFilterTypeChange={setFilterType}
            userFilter={userFilter}
            onUserFilterChange={setUserFilter}
            sortBy={sortBy}
            onSortByChange={setSortBy}
            dateFrom={dateRange.from}
            dateTo={dateRange.to}
            onDateChange={(from, to) => setDateRange(from, to)}
            showUserFilter={!selectedUser?.userEmail}
            onChatView={(chat: AdminChat) => {
              console.log("Viewing chat:", chat.externalId)
              // You can implement chat viewing functionality here if needed
            }}
          />

          {/* Pagination Controls */}
          {!loading && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Show</span>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value))
                    setCurrentPage(1) // Reset to first page when changing page size
                  }}
                  className="border border-input bg-background rounded-md px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
                <span className="text-sm text-muted-foreground">
                  per page
                  {paginationMetadata?.totalCount !== undefined && (
                    <> (Total: {paginationMetadata.totalCount})</>
                  )}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                  disabled={
                    paginationMetadata
                      ? !paginationMetadata.hasPreviousPage
                      : currentPage === 1
                  }
                  className="flex items-center gap-1"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>

                <span className="text-sm text-muted-foreground px-4">
                  Page {currentPage}
                </span>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(currentPage + 1)}
                  disabled={
                    paginationMetadata
                      ? !paginationMetadata.hasNextPage
                      : adminChats.length < pageSize
                  }
                  className="flex items-center gap-1"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
