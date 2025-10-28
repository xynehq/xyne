import {
  createFileRoute,
  redirect,
  useRouterState,
} from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { api } from "@/api"
import { errorComponent } from "@/components/error"
import { Sidebar } from "@/components/Sidebar"
import { PublicUser, PublicWorkspace } from "shared/types"
import { toast } from "@/hooks/use-toast"
// import { IntegrationsSidebar } from '@/components/IntegrationsSidebar'
import { useTheme } from "@/components/ThemeContext"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import {
  Search,
  Users,
  Mail,
  HardDrive,
  Calendar,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  ChevronDown,
  ChevronUp,
} from "lucide-react"
import { Apps, UserRole } from "shared/types"

// Badge Component
const Badge = ({
  children,
  variant = "default",
  className = "",
}: {
  children: React.ReactNode
  variant?: "default" | "secondary" | "destructive"
  className?: string
}) => {
  const variants = {
    default: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
    secondary: "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300",
    destructive: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
  }

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${variants[variant]} ${className}`}
    >
      {children}
    </span>
  )
}

// Avatar Components
const Avatar = ({
  children,
  className = "",
}: {
  children: React.ReactNode
  className?: string
}) => (
  <div
    className={`relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full ${className}`}
  >
    {children}
  </div>
)

const AvatarImage = ({
  src,
  alt,
  onError,
}: {
  src?: string
  alt?: string
  onError?: (e: any) => void
}) => (
  <img
    className="aspect-square h-full w-full object-cover"
    src={src}
    alt={alt}
    onError={onError}
  />
)

const AvatarFallback = ({
  children,
  className = "",
}: {
  children: React.ReactNode
  className?: string
}) => (
  <div
    className={`flex h-full w-full items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 ${className}`}
  >
    {children}
  </div>
)

// Skeleton Component
const Skeleton = ({ className = "" }: { className?: string }) => (
  <div
    className={`animate-pulse rounded-md bg-gray-200 dark:bg-gray-700 ${className}`}
  />
)

export const Route = createFileRoute("/_authenticated/admin/userManagement")({
  beforeLoad: ({ context }) => {
    if (
      !(context.user.role === "Admin" || context.user.role === "SuperAdmin")
    ) {
      throw redirect({ to: "/" })
    }
  },
  component: () => {
    const matches = useRouterState({ select: (s) => s.matches })
    const { user, workspace, agentWhiteList } =
      matches[matches.length - 1].context
    return (
      <UsersListPage
        user={user}
        workspace={workspace}
        agentWhiteList={agentWhiteList}
      />
    )
  },
  errorComponent: errorComponent,
})

interface User {
  id: string
  email: string
  name: string
  photoLink: string
  role: UserRole
  createdAt: Date
  syncJobs?: Record<
    Apps,
    {
      lastSyncDate: Date | null
      createdAt: Date | null
      connectorStatus?: string
    } | null
  >
}
interface IngestedUsers {
  id: number
  email: string
  syncJobs?: Record<
    Apps,
    {
      lastSyncDate: Date | null
      createdAt: Date | null
      connectorStatus?: string
    } | null
  >
}

interface UsersListPageProps {
  user: PublicUser
  workspace: PublicWorkspace
  agentWhiteList: boolean
}

const formatSyncDate = (dateInput?: Date | null | undefined): string => {
  if (!dateInput) return "Never"

  const now = new Date()
  const dateToFormat = new Date(dateInput)
  const diffInMs = now.getTime() - dateToFormat.getTime()
  const diffInMinutes = Math.round(diffInMs / (1000 * 60))
  const diffInHours = Math.round(diffInMs / (1000 * 60 * 60))

  const todayMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  )
  const yesterdayMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
  )
  const syncDateMidnight = new Date(
    dateToFormat.getFullYear(),
    dateToFormat.getMonth(),
    dateToFormat.getDate(),
  )

  if (diffInMinutes < 60) {
    return `${diffInMinutes}m ago`
  } else if (
    diffInHours < 24 &&
    syncDateMidnight.getTime() === todayMidnight.getTime()
  ) {
    return `${diffInHours}h ago`
  } else if (syncDateMidnight.getTime() === yesterdayMidnight.getTime()) {
    return "Yesterday"
  } else {
    return dateToFormat.toLocaleDateString()
  }
}

const formatCreatedAt = (dateInput?: Date | null | undefined): string => {
  if (!dateInput) return ""
  const dateToFormat = new Date(dateInput)
  return `Created: ${dateToFormat.toLocaleDateString()}`
}

const getSyncStatusColor = (dateInput?: Date | null | undefined): string => {
  if (!dateInput) return "text-muted-foreground"

  const now = new Date()
  const diffInHours =
    (now.getTime() - new Date(dateInput).getTime()) / (1000 * 60 * 60)

  if (diffInHours < 1) return "text-green-600 dark:text-green-400"
  if (diffInHours < 24) return "text-yellow-600 dark:text-yellow-400"
  return "text-red-600 dark:text-red-400"
}

const getRoleBadgeVariant = (role: UserRole) => {
  switch (role) {
    case UserRole.SuperAdmin:
      return "destructive"
    case UserRole.Admin:
      return "default"
    case UserRole.User:
      return "secondary"
    default:
      return "secondary"
  }
}

const getConnectorStatusColor = (status?: string): string => {
  switch (status) {
    case "connected":
      return "text-green-600 dark:text-green-400"
    case "not-connected":
      return "text-red-600 dark:text-red-400"
    case "error":
      return "text-red-600 dark:text-red-400"
    case "connecting":
      return "text-gray-500 dark:text-gray-400"
    default:
      return "text-muted-foreground"
  }
}

const formatConnectorStatus = (status?: string): string => {
  if (!status) return ""
  switch (status) {
    case "connected":
      return "Connected"
    case "not-connected":
      return "Not Connected"
    case "connecting":
      return "Connecting"
    case "error":
      return "Error"
    default:
      return status
  }
}

function UsersListPage({
  user: currentUser,
  workspace,
  agentWhiteList,
}: UsersListPageProps) {
  const {} = useTheme()

  const [users, setUsers] = useState<User[]>([])
  const [ingestedUsers, setIngestedUsers] = useState<IngestedUsers[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState("")
  const [activeTab, setActiveTab] = useState<"loggedIn" | "ingested">(
    "loggedIn",
  )
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const [userToConfirmRoleChange, setUserToConfirmRoleChange] = useState<{
    user: User
    newRole: UserRole
  } | null>(null)
  const [isUpdating, setIsUpdating] = useState(false)
  const [syncingUser, setSyncingUser] = useState<string | null>(null)
  const [syncingSlackUser, setSyncingSlackUser] = useState<string | null>(null)
  const [_, setSelectDropdownOpen] = useState<string | null>(null)
  const [sortField, setSortField] = useState<
    "gmailSync" | "driveSync" | "calendarSync" | "slackSync"
  >("gmailSync")
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc")
  const [sortDateType, setSortDateType] = useState<
    "lastSyncDate" | "createdAt"
  >("lastSyncDate")

  const totalUsers = users.length
  const superAdmins = users.filter(
    (user) => user.role === UserRole.SuperAdmin,
  ).length
  const admins = users.filter((user) => user.role === UserRole.Admin).length
  const regularUsers = users.filter(
    (user) => user.role === UserRole.User,
  ).length

  const syncSortOptions = [
    {
      label: "Gmail",
      value: "gmailSync",
      icon: <Mail className="inline mr-2 h-4 w-4" />,
    },
    {
      label: "Google Drive",
      value: "driveSync",
      icon: <HardDrive className="inline mr-2 h-4 w-4" />,
    },
    {
      label: "Google Calendar",
      value: "calendarSync",
      icon: <Calendar className="inline mr-2 h-4 w-4" />,
    },
    {
      label: "Slack",
      value: "slackSync",
      icon: <MessageSquare className="inline mr-2 h-4 w-4" />,
    },
  ]

  const dateTypeOptions = [
    {
      label: "Last Sync Date",
      value: "lastSyncDate",
    },
    {
      label: "Created At",
      value: "createdAt",
    },
  ]

  // Get current selection labels for display
  const getCurrentSortLabel = () => {
    const appOption = syncSortOptions.find((opt) => opt.value === sortField)
    const dateTypeOption = dateTypeOptions.find(
      (opt) => opt.value === sortDateType,
    )
    return `${dateTypeOption?.label} - ${appOption?.label}`
  }

  // Map sortField to Apps enum
  const sortFieldToApp = {
    gmailSync: Apps.Gmail,
    driveSync: Apps.GoogleDrive,
    calendarSync: Apps.GoogleCalendar,
    slackSync: Apps.Slack,
  }

  // Function to fetch logged in users
  const fetchLoggedInUsers = async () => {
    try {
      setLoading(true)
      setError(null)

      const res = await api.admin.list_loggedIn_users.$get()

      if (!res.ok) {
        const errorData = await res.json()
        throw new Error(errorData.message || "Failed to fetch users")
      }

      const data = await res.json()
      // Map syncJobs to expected structure
      if (data && data.data && Array.isArray(data.data)) {
        setUsers(
          data.data.map((user: any) => ({
            ...user,
            syncJobs: Object.fromEntries(
              Object.entries(user.syncJobs || {}).map(([app, value]) => [
                app,
                value === null
                  ? { lastSyncDate: null, createdAt: null }
                  : typeof value === "object" && Object.keys(value).length > 0
                    ? value // already in correct format
                    : {
                        lastSyncDate:
                          typeof value === "string" || typeof value === "number"
                            ? new Date(value)
                            : null,
                        createdAt: null,
                      },
              ]),
            ),
          })),
        )
      } else {
        throw new Error("Unexpected API response format")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unknown error occurred")
      console.error("Error fetching logged in users:", err)
    } finally {
      setLoading(false)
    }
  }

  // Function to fetch ingested users
  const fetchIngestedUsers = async () => {
    try {
      setLoading(true)
      setError(null)

      const ingestedRes = await api.admin.list_ingested_users.$get()

      if (!ingestedRes.ok) {
        const errorData = await ingestedRes.json()
        throw new Error(errorData.message || "Failed to fetch ingested users")
      }

      const ingestedData = await ingestedRes.json()
      if (
        ingestedData &&
        ingestedData.data &&
        Array.isArray(ingestedData.data)
      ) {
        setIngestedUsers(
          ingestedData.data.map((user: any) => ({
            ...user,
            email: user.email || "", // Ensure email is empty string if null/undefined
            syncJobs: Object.fromEntries(
              Object.entries(user.syncJobs || {}).map(([app, value]) => [
                app,
                value === null
                  ? { lastSyncDate: null, createdAt: null }
                  : typeof value === "object" && Object.keys(value).length > 0
                    ? value // already in correct format
                    : {
                        lastSyncDate:
                          typeof value === "string" || typeof value === "number"
                            ? new Date(value)
                            : null,
                        createdAt: null,
                      },
              ]),
            ),
          })),
        )
      } else {
        setIngestedUsers([])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unknown error occurred")
      console.error("Error fetching ingested users:", err)
    } finally {
      setLoading(false)
    }
  }

  // Effect to fetch data based on activeTab changes with smooth transition
  useEffect(() => {
    const handleTabChange = async () => {
      setIsTransitioning(true)

      // Transition delay for smooth animation
      await new Promise((resolve) => setTimeout(resolve, 150))

      if (activeTab === "loggedIn") {
        await fetchLoggedInUsers()
      } else if (activeTab === "ingested") {
        await fetchIngestedUsers()
      }

      // Small delay before showing content
      await new Promise((resolve) => setTimeout(resolve, 100))
      setIsTransitioning(false)
    }

    handleTabChange()
  }, [activeTab])

  // Robust fix: actively monitor and reset pointer-events on body if set to 'none'
  useEffect(() => {
    const fixPointerEvents = () => {
      if (document.body.style.pointerEvents === "none") {
        document.body.style.pointerEvents = ""
      }
    }
    // Run once immediately
    fixPointerEvents()
    // Set up a MutationObserver to watch for style changes
    const observer = new MutationObserver(fixPointerEvents)
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["style"],
    })
    // Also set up an interval as a fallback
    const interval = setInterval(fixPointerEvents, 100)
    return () => {
      observer.disconnect()
      clearInterval(interval)
      document.body.style.pointerEvents = ""
    }
  }, [])

  // Generic function to filter and sort user arrays
  const filterAndSortUsers = <
    T extends {
      email: string
      name?: string
      syncJobs?: Record<
        Apps,
        { lastSyncDate: Date | null; createdAt: Date | null } | null
      >
    },
  >(
    userArray: T[],
    searchTerm: string,
    sortField?: string,
    sortDateType?: string,
    sortDirection?: string,
  ): T[] => {
    // Filter users based on search term
    let filtered = userArray.filter((user) => {
      if (!searchTerm) return true // If no search term, include all users
      const searchLower = searchTerm.toLowerCase()
      return (
        user.name?.toLowerCase().includes(searchLower) ||
        user.email?.toLowerCase().includes(searchLower)
      )
    })

    // Sort by selected sync app and date type
    if (sortField && sortDateType && sortDirection) {
      const app = sortFieldToApp[sortField as keyof typeof sortFieldToApp]
      if (app) {
        filtered = [...filtered].sort((a, b) => {
          const aDate = a.syncJobs?.[app]?.[
            sortDateType as "lastSyncDate" | "createdAt"
          ]
            ? new Date(
                a.syncJobs?.[app]?.[
                  sortDateType as "lastSyncDate" | "createdAt"
                ]!,
              ).getTime()
            : 0
          const bDate = b.syncJobs?.[app]?.[
            sortDateType as "lastSyncDate" | "createdAt"
          ]
            ? new Date(
                b.syncJobs?.[app]?.[
                  sortDateType as "lastSyncDate" | "createdAt"
                ]!,
              ).getTime()
            : 0
          return sortDirection === "asc" ? aDate - bDate : bDate - aDate
        })
      }
    }

    return filtered
  }

  const filteredUsers = filterAndSortUsers(
    users,
    searchTerm,
    sortField,
    sortDateType,
    sortDirection,
  )
  const filteredIngestedUsers = filterAndSortUsers(
    ingestedUsers,
    searchTerm,
    sortField,
    sortDateType,
    sortDirection,
  )

  const handleRoleChange = async (userId: string, newRole: UserRole) => {
    try {
      setIsUpdating(true)
      const res = await api.admin.change_role.$post({
        form: { userId, newRole },
      })

      if (!res.ok) {
        throw new Error("Failed to update role")
      }
      if (activeTab === "loggedIn") {
        await fetchLoggedInUsers()
      } else if (activeTab === "ingested") {
        await fetchIngestedUsers()
      }

      toast.success({
        title: "Success",
        description: "User role has been successfully updated.",
      })
      setUserToConfirmRoleChange(null)
    } catch (error) {
      console.error("Error updating role:", error)
      toast.error({
        title: "Error",
        description: "Failed to update user role.",
      })
    } finally {
      setIsUpdating(false)
    }
  }

  const handleDropdownChange = (user: User, newRole: UserRole) => {
    if (user.role !== newRole) {
      setUserToConfirmRoleChange({ user, newRole })
    }
  }

  const handleRoleSelectChange = (user: User, newRole: UserRole) => {
    handleDropdownChange(user, newRole)
    setSelectDropdownOpen(null) // Close dropdown after selection
  }

  const handleSync = async (user: User) => {
    if (
      !user.syncJobs?.[Apps.Gmail] &&
      !user.syncJobs?.[Apps.GoogleDrive] &&
      !user.syncJobs?.[Apps.GoogleCalendar]
    ) {
      toast.error({
        title: "Error",
        description: `Please set up the Google integration for ${user.name || user.email}.`,
      })
      return
    }

    try {
      setSyncingUser(user.email)
      const res = await api.admin.syncGoogleWorkSpaceByMail.$post({
        json: { email: user.email },
      })

      if (!res.ok) {
        throw new Error("Failed to trigger sync")
      }

      // Re-fetch data for current active tab
      if (activeTab === "loggedIn") {
        await fetchLoggedInUsers()
      } else if (activeTab === "ingested") {
        await fetchIngestedUsers()
      }

      toast.success({
        title: "Success",
        description: "Google Workspace sync has been successfully triggered.",
      })
    } catch (error) {
      console.error("Error triggering sync:", error)
      toast.error({
        title: "Error",
        description: "Failed to trigger Google Workspace sync.",
      })
    } finally {
      setSyncingUser(null)
    }
  }

  const handleSlackSync = async (user: User) => {
    if (!user.syncJobs?.[Apps.Slack]) {
      toast.error({
        title: "Error",
        description: `Please set up the Slack integration for ${user.name || user.email}.`,
      })
      return
    }

    try {
      setSyncingSlackUser(user.email)
      const res = await api.admin.syncSlackByMail.$post({
        json: { email: user.email },
      })

      if (!res.ok) {
        throw new Error("Failed to trigger Slack sync")
      }

      toast.success({
        title: "Success",
        description: "Slack sync has been successfully triggered.",
      })
    } catch (error) {
      console.error("Error triggering Slack sync:", error)
      toast.error({
        title: "Error",
        description: "Failed to trigger Slack sync.",
      })
    } finally {
      setSyncingSlackUser(null)
    }
  }

  if (loading) {
    return (
      <div className="flex w-full h-full bg-gray-50 dark:bg-gray-900">
        <Sidebar
          photoLink={currentUser?.photoLink ?? ""}
          role={currentUser?.role}
          isAgentMode={agentWhiteList}
        />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex w-full h-full bg-gray-50 dark:bg-gray-900">
        <Sidebar
          photoLink={currentUser?.photoLink ?? ""}
          role={currentUser?.role}
          isAgentMode={agentWhiteList}
        />
        <div className="flex-grow ml-[52px] min-h-screen flex items-center justify-center">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 px-4 py-3 rounded-lg">
            <p className="font-medium">Error loading users</p>
            <p className="text-sm">{error}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex w-full h-full"
      style={{
        background: "hsl(0, 0%, 98%)", // main background
      }}
    >
      <Sidebar
        photoLink={currentUser?.photoLink ?? ""}
        role={currentUser?.role}
        isAgentMode={agentWhiteList}
      />
      <div
        className="flex-grow ml-[52px] p-8"
        style={{
          background: "hsl(0, 0%, 97%)", // dashboard background
          minHeight: "100vh",
        }}
      >
        <div className="space-y-8">
          {/* Header */}
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              User Management
            </h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1">
              Manage users, roles, and sync integrations
            </p>
          </div>

          {/* Tab Navigation */}
          <div className="border-b border-gray-200 dark:border-gray-700">
            <nav className="-mb-px flex space-x-8">
              <button
                onClick={() => setActiveTab("loggedIn")}
                disabled={isTransitioning}
                className={`py-2 px-1 border-b-2 font-medium text-sm transition-all duration-200 ease-in-out ${
                  activeTab === "loggedIn"
                    ? "border-blue-500 text-blue-600 dark:text-blue-400"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300"
                } ${isTransitioning ? "opacity-60 cursor-not-allowed" : ""}`}
              >
                {/* Logged In Users ({users.length}) */}
                Logged In Users
              </button>
              <button
                onClick={() => setActiveTab("ingested")}
                disabled={isTransitioning}
                className={`py-2 px-1 border-b-2 font-medium text-sm transition-all duration-200 ease-in-out ${
                  activeTab === "ingested"
                    ? "border-blue-500 text-blue-600 dark:text-blue-400"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300"
                } ${isTransitioning ? "opacity-60 cursor-not-allowed" : ""}`}
              >
                {/* Ingested Users ({ingestedUsers.length}) */}
                Ingested Users
              </button>
            </nav>
          </div>

          {/* Stats Cards */}
          <div className="space-y-6">
            {isTransitioning ? (
              // Skeleton for stats cards
              <div className="grid grid-cols-4 gap-6">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Card
                    key={i}
                    className="bg-white dark:bg-gray-800 border-0 shadow-sm"
                  >
                    <CardContent className="p-6">
                      <div className="flex items-center justify-between">
                        <div className="space-y-2">
                          <Skeleton className="h-4 w-20" />
                          <Skeleton className="h-8 w-12" />
                        </div>
                        <Skeleton className="h-6 w-6 rounded-full" />
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <div
                className="transition-all duration-300 ease-out"
                style={{
                  transitionProperty: "opacity, transform",
                  transitionDuration: "300ms",
                  transitionTimingFunction:
                    "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                }}
              >
                {activeTab === "loggedIn" ? (
                  <div className="grid grid-cols-4 gap-6">
                    <Card className="bg-white dark:bg-gray-800 border-0 shadow-sm">
                      <CardContent className="p-6">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                              Total Users
                            </p>
                            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-2">
                              {totalUsers}
                            </p>
                          </div>
                          <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                            <Users className="h-6 w-6 text-gray-600 dark:text-gray-400" />
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    <Card className="bg-white dark:bg-gray-800 border-0 shadow-sm">
                      <CardContent className="p-6">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                              Super Admins
                            </p>
                            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-2">
                              {superAdmins}
                            </p>
                          </div>
                          <div className="w-3 h-3 bg-red-500 rounded-full"></div>
                        </div>
                      </CardContent>
                    </Card>

                    <Card className="bg-white dark:bg-gray-800 border-0 shadow-sm">
                      <CardContent className="p-6">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                              Admins
                            </p>
                            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-2">
                              {admins}
                            </p>
                          </div>
                          <div className="w-3 h-3 bg-blue-500 rounded-full"></div>
                        </div>
                      </CardContent>
                    </Card>

                    <Card className="bg-white dark:bg-gray-800 border-0 shadow-sm">
                      <CardContent className="p-6">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                              Regular Users
                            </p>
                            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-2">
                              {regularUsers}
                            </p>
                          </div>
                          <div className="w-3 h-3 bg-gray-500 rounded-full"></div>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                ) : (
                  <div className="grid grid-cols-4 gap-6">
                    <Card className="bg-white dark:bg-gray-800 border-0 shadow-sm">
                      <CardContent className="p-6">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                              Total Ingested Users
                            </p>
                            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-2">
                              {ingestedUsers.length}
                            </p>
                          </div>
                          <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                            <Users className="h-6 w-6 text-gray-600 dark:text-gray-400" />
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                )}
              </div>
            )}

            {/* Users Section */}
            {isTransitioning ? (
              // Skeleton for users section
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <Skeleton className="h-6 w-16 mb-2" />
                    <Skeleton className="h-4 w-72" />
                  </div>
                  <div className="flex items-center space-x-3">
                    <Skeleton className="h-10 w-64" />
                    <Skeleton className="h-10 w-48" />
                  </div>
                </div>

                <Card className="bg-white dark:bg-gray-800 border-0 shadow-sm">
                  <CardContent className="p-0">
                    <div className="space-y-4 p-6">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <div key={i} className="flex items-center space-x-4">
                          <Skeleton className="h-10 w-10 rounded-full" />
                          <div className="space-y-2 flex-1">
                            <Skeleton className="h-4 w-48" />
                            <Skeleton className="h-3 w-32" />
                          </div>
                          <Skeleton className="h-6 w-16" />
                          <Skeleton className="h-4 w-12" />
                          <Skeleton className="h-4 w-12" />
                          <Skeleton className="h-4 w-12" />
                          <Skeleton className="h-4 w-12" />
                          <Skeleton className="h-8 w-8" />
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            ) : (
              <div className="space-y-6 transition-all duration-300 ease-out">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      Users
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      A list of all users in your workspace with their sync
                      status
                    </p>
                  </div>
                  <div className="flex items-center space-x-3">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
                      <Input
                        placeholder="Search users..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="pl-10 w-64 bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          className="bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 min-w-[200px]"
                        >
                          {getCurrentSortLabel()}
                          <ChevronDown className="ml-2 h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="w-64 bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700"
                      >
                        <div className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 font-semibold">
                          Sort by Date Type
                        </div>
                        {dateTypeOptions.map((dateOpt) => (
                          <DropdownMenuItem
                            key={dateOpt.value}
                            onClick={() =>
                              setSortDateType(
                                dateOpt.value as typeof sortDateType,
                              )
                            }
                            className="flex items-center gap-2"
                          >
                            {dateOpt.label}
                            {sortDateType === dateOpt.value && (
                              <div className="ml-auto w-2 h-2 bg-blue-500 rounded-full" />
                            )}
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <div className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 font-semibold">
                          Sort by App
                        </div>
                        {syncSortOptions.map((opt) => (
                          <DropdownMenuItem
                            key={opt.value}
                            onClick={() => {
                              if (sortField === opt.value) {
                                setSortDirection((d) =>
                                  d === "asc" ? "desc" : "asc",
                                )
                              } else {
                                setSortField(opt.value as typeof sortField)
                                setSortDirection("desc")
                              }
                            }}
                            className="flex items-center gap-2"
                          >
                            {opt.icon}
                            {opt.label}
                            {sortField === opt.value &&
                              (sortDirection === "asc" ? (
                                <ChevronUp className="ml-auto h-4 w-4" />
                              ) : (
                                <ChevronDown className="ml-auto h-4 w-4" />
                              ))}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                {/* Users Table */}
                <Card className="bg-white dark:bg-gray-800 border-0 shadow-sm">
                  <div className="overflow-hidden">
                    {activeTab === "loggedIn" ? (
                      // Logged In Users Table
                      filteredUsers.length === 0 ? (
                        <div className="text-center py-12">
                          <Users className="mx-auto h-12 w-12 text-gray-400" />
                          <h3 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
                            {searchTerm ? "No users found" : "No users yet"}
                          </h3>
                          <p className="mt-2 text-gray-500 dark:text-gray-400">
                            {searchTerm
                              ? "Try adjusting your search terms"
                              : "Get started by adding your first user"}
                          </p>
                        </div>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow className="border-gray-200 dark:border-gray-700 hover:bg-transparent">
                              <TableHead className="text-gray-500 dark:text-gray-400 font-medium py-4 px-6">
                                User
                              </TableHead>
                              <TableHead className="text-gray-500 dark:text-gray-400 font-medium py-4 px-6">
                                Role
                              </TableHead>
                              <TableHead className="text-center text-gray-500 dark:text-gray-400 font-medium py-4 px-6">
                                <div className="flex items-center justify-center gap-2">
                                  <Mail className="h-4 w-4" />
                                  Gmail
                                </div>
                              </TableHead>
                              <TableHead className="text-center text-gray-500 dark:text-gray-400 font-medium py-4 px-6">
                                <div className="flex items-center justify-center gap-2">
                                  <HardDrive className="h-4 w-4" />
                                  Drive
                                </div>
                              </TableHead>
                              <TableHead className="text-center text-gray-500 dark:text-gray-400 font-medium py-4 px-6">
                                <div className="flex items-center justify-center gap-2">
                                  <Calendar className="h-4 w-4" />
                                  Calendar
                                </div>
                              </TableHead>
                              <TableHead className="text-center text-gray-500 dark:text-gray-400 font-medium py-4 px-6">
                                <div className="flex items-center justify-center gap-2">
                                  <MessageSquare className="h-4 w-4" />
                                  Slack
                                </div>
                              </TableHead>
                              <TableHead className="w-12 py-4 px-6"></TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {filteredUsers.map((user) => (
                              <TableRow
                                key={user.id}
                                className="border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                              >
                                <TableCell className="py-4 px-6">
                                  <div className="flex items-center space-x-3">
                                    <Avatar className="h-10 w-10">
                                      <AvatarImage
                                        src={
                                          user.photoLink
                                            ? `/api/v1/proxy/${encodeURIComponent(user.photoLink)}`
                                            : undefined
                                        }
                                        alt={user.name || user.email}
                                        onError={(e) => {
                                          ;(
                                            e.target as HTMLImageElement
                                          ).style.display = "none"
                                        }}
                                      />
                                      <AvatarFallback className="bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-sm font-medium">
                                        {user.name?.[0]?.toUpperCase() ||
                                          user.email[0].toUpperCase()}
                                      </AvatarFallback>
                                    </Avatar>
                                    <div className="min-w-0 flex-1">
                                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                                        {user.name || user.email}
                                      </p>
                                      <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
                                        {user.email}
                                      </p>
                                    </div>
                                  </div>
                                </TableCell>

                                <TableCell className="py-4 px-6">
                                  {currentUser.role === UserRole.SuperAdmin &&
                                  currentUser.email !== user.email ? (
                                    <div className="relative inline-block">
                                      <select
                                        value={user.role}
                                        onChange={(e) =>
                                          handleRoleSelectChange(
                                            user,
                                            e.target.value as UserRole,
                                          )
                                        }
                                        disabled={isUpdating}
                                        className="appearance-none bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md px-3 py-1.5 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed min-w-[110px] font-medium"
                                      >
                                        {Object.values(UserRole).map((role) => (
                                          <option key={role} value={role}>
                                            {role}
                                          </option>
                                        ))}
                                      </select>
                                      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
                                        <ChevronDown className="h-4 w-4 text-gray-400" />
                                      </div>
                                    </div>
                                  ) : (
                                    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-black dark:bg-white text-white dark:text-black">
                                      {user.role}
                                    </span>
                                  )}
                                </TableCell>

                                <TableCell className="text-center py-4 px-6">
                                  <div className="flex flex-col items-center space-y-1">
                                    <span
                                      className={`text-sm font-medium ${getSyncStatusColor(
                                        user.syncJobs?.[Apps.Gmail]
                                          ?.lastSyncDate,
                                      )}`}
                                    >
                                      {formatSyncDate(
                                        user.syncJobs?.[Apps.Gmail]
                                          ?.lastSyncDate,
                                      )}
                                    </span>
                                    {user.syncJobs?.[Apps.Gmail]?.createdAt && (
                                      <span className="text-xs text-gray-400 dark:text-gray-500">
                                        Created:{" "}
                                        {new Date(
                                          user.syncJobs[Apps.Gmail].createdAt,
                                        ).toLocaleDateString()}
                                      </span>
                                    )}
                                  </div>
                                </TableCell>

                                <TableCell className="text-center py-4 px-6">
                                  <div className="flex flex-col items-center space-y-1">
                                    <span
                                      className={`text-sm font-medium ${getSyncStatusColor(
                                        user.syncJobs?.[Apps.GoogleDrive]
                                          ?.lastSyncDate,
                                      )}`}
                                    >
                                      {formatSyncDate(
                                        user.syncJobs?.[Apps.GoogleDrive]
                                          ?.lastSyncDate,
                                      )}
                                    </span>
                                    {user.syncJobs?.[Apps.GoogleDrive]
                                      ?.createdAt && (
                                      <span className="text-xs text-gray-400 dark:text-gray-500">
                                        Created:{" "}
                                        {new Date(
                                          user.syncJobs[Apps.GoogleDrive]
                                            .createdAt,
                                        ).toLocaleDateString()}
                                      </span>
                                    )}
                                  </div>
                                </TableCell>

                                <TableCell className="text-center py-4 px-6">
                                  <div className="flex flex-col items-center space-y-1">
                                    <span
                                      className={`text-sm font-medium ${getSyncStatusColor(
                                        user.syncJobs?.[Apps.GoogleCalendar]
                                          ?.lastSyncDate,
                                      )}`}
                                    >
                                      {formatSyncDate(
                                        user.syncJobs?.[Apps.GoogleCalendar]
                                          ?.lastSyncDate,
                                      )}
                                    </span>
                                    {user.syncJobs?.[Apps.GoogleCalendar]
                                      ?.createdAt && (
                                      <span className="text-xs text-gray-400 dark:text-gray-500">
                                        Created:{" "}
                                        {new Date(
                                          user.syncJobs[Apps.GoogleCalendar]
                                            .createdAt,
                                        ).toLocaleDateString()}
                                      </span>
                                    )}
                                  </div>
                                </TableCell>

                                <TableCell className="text-center py-4 px-6">
                                  <div className="flex flex-col items-center space-y-1">
                                    <span
                                      className={`text-sm font-medium ${getSyncStatusColor(
                                        user.syncJobs?.[Apps.Slack]
                                          ?.lastSyncDate,
                                      )}`}
                                    >
                                      {formatSyncDate(
                                        user.syncJobs?.[Apps.Slack]
                                          ?.lastSyncDate,
                                      )}
                                    </span>
                                    {user.syncJobs?.[Apps.Slack]?.createdAt && (
                                      <span className="text-xs text-gray-400 dark:text-gray-500">
                                        Created:{" "}
                                        {new Date(
                                          user.syncJobs[Apps.Slack].createdAt,
                                        ).toLocaleDateString()}
                                      </span>
                                    )}
                                  </div>
                                </TableCell>

                                <TableCell className="py-4 px-6">
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 hover:bg-gray-100 dark:hover:bg-gray-700"
                                      >
                                        <MoreHorizontal className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent
                                      align="end"
                                      className="w-56 bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700"
                                    >
                                      <DropdownMenuItem
                                        onClick={() => setSelectedUser(user)}
                                      >
                                        View Details
                                      </DropdownMenuItem>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem
                                        onClick={() => handleSync(user)}
                                        disabled={syncingUser === user.email}
                                      >
                                        {syncingUser === user.email ? (
                                          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                        ) : (
                                          <RefreshCw className="mr-2 h-4 w-4" />
                                        )}
                                        Sync Google Workspace
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        onClick={() => handleSlackSync(user)}
                                        disabled={
                                          syncingSlackUser === user.email
                                        }
                                      >
                                        {syncingSlackUser === user.email ? (
                                          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                        ) : (
                                          <MessageSquare className="mr-2 h-4 w-4" />
                                        )}
                                        Sync Slack
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )
                    ) : // Ingested Users Table
                    filteredIngestedUsers.length === 0 ? (
                      <div className="text-center py-12">
                        <Users className="mx-auto h-12 w-12 text-gray-400" />
                        <h3 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
                          {searchTerm
                            ? "No ingested users found"
                            : "No ingested users yet"}
                        </h3>
                        <p className="mt-2 text-gray-500 dark:text-gray-400">
                          {searchTerm
                            ? "Try adjusting your search terms"
                            : "Ingested users will appear here when available"}
                        </p>
                      </div>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow className="border-gray-200 dark:border-gray-700 hover:bg-transparent">
                            <TableHead className="text-gray-500 dark:text-gray-400 font-medium py-4 px-6">
                              Email
                            </TableHead>
                            <TableHead className="text-center text-gray-500 dark:text-gray-400 font-medium py-4 px-6">
                              <div className="flex items-center justify-center gap-2">
                                <Mail className="h-4 w-4" />
                                Gmail
                              </div>
                            </TableHead>
                            <TableHead className="text-center text-gray-500 dark:text-gray-400 font-medium py-4 px-6">
                              <div className="flex items-center justify-center gap-2">
                                <HardDrive className="h-4 w-4" />
                                Drive
                              </div>
                            </TableHead>
                            <TableHead className="text-center text-gray-500 dark:text-gray-400 font-medium py-4 px-6">
                              <div className="flex items-center justify-center gap-2">
                                <Calendar className="h-4 w-4" />
                                Calendar
                              </div>
                            </TableHead>
                            <TableHead className="text-center text-gray-500 dark:text-gray-400 font-medium py-4 px-6">
                              <div className="flex items-center justify-center gap-2">
                                <MessageSquare className="h-4 w-4" />
                                Slack
                              </div>
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filteredIngestedUsers.map((user) => (
                            <TableRow
                              key={user.id}
                              className="border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                            >
                              <TableCell className="py-4 px-6">
                                <div className="flex items-center space-x-3">
                                  <Avatar className="h-10 w-10">
                                    <AvatarFallback className="bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-sm font-medium">
                                      {user?.email?.[0]?.toUpperCase() || "?"}
                                    </AvatarFallback>
                                  </Avatar>
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                                      {user.email}
                                    </p>
                                  </div>
                                </div>
                              </TableCell>

                              <TableCell className="text-center py-4 px-6">
                                <div className="flex flex-col items-center space-y-1">
                                  <span
                                    className={`text-sm font-medium ${getSyncStatusColor(
                                      user.syncJobs?.[Apps.Gmail]?.lastSyncDate,
                                    )}`}
                                  >
                                    {formatSyncDate(
                                      user.syncJobs?.[Apps.Gmail]?.lastSyncDate,
                                    )}
                                  </span>
                                  {user.syncJobs?.[Apps.Gmail]?.createdAt && (
                                    <span className="text-xs text-gray-400 dark:text-gray-500">
                                      Created:{" "}
                                      {new Date(
                                        user.syncJobs[Apps.Gmail].createdAt,
                                      ).toLocaleDateString()}
                                    </span>
                                  )}
                                </div>
                              </TableCell>

                              <TableCell className="text-center py-4 px-6">
                                <div className="flex flex-col items-center space-y-1">
                                  <span
                                    className={`text-sm font-medium ${getSyncStatusColor(
                                      user.syncJobs?.[Apps.GoogleDrive]
                                        ?.lastSyncDate,
                                    )}`}
                                  >
                                    {formatSyncDate(
                                      user.syncJobs?.[Apps.GoogleDrive]
                                        ?.lastSyncDate,
                                    )}
                                  </span>
                                  {user.syncJobs?.[Apps.GoogleDrive]
                                    ?.createdAt && (
                                    <span className="text-xs text-gray-400 dark:text-gray-500">
                                      Created:{" "}
                                      {new Date(
                                        user.syncJobs[Apps.GoogleDrive]
                                          .createdAt,
                                      ).toLocaleDateString()}
                                    </span>
                                  )}
                                </div>
                              </TableCell>

                              <TableCell className="text-center py-4 px-6">
                                <div className="flex flex-col items-center space-y-1">
                                  <span
                                    className={`text-sm font-medium ${getSyncStatusColor(
                                      user.syncJobs?.[Apps.GoogleCalendar]
                                        ?.lastSyncDate,
                                    )}`}
                                  >
                                    {formatSyncDate(
                                      user.syncJobs?.[Apps.GoogleCalendar]
                                        ?.lastSyncDate,
                                    )}
                                  </span>
                                  {user.syncJobs?.[Apps.GoogleCalendar]
                                    ?.createdAt && (
                                    <span className="text-xs text-gray-400 dark:text-gray-500">
                                      Created:{" "}
                                      {new Date(
                                        user.syncJobs[Apps.GoogleCalendar]
                                          .createdAt,
                                      ).toLocaleDateString()}
                                    </span>
                                  )}
                                </div>
                              </TableCell>

                              <TableCell className="text-center py-4 px-6">
                                <div className="flex flex-col items-center space-y-1">
                                  <span
                                    className={`text-sm font-medium ${getSyncStatusColor(
                                      user.syncJobs?.[Apps.Slack]?.lastSyncDate,
                                    )}`}
                                  >
                                    {formatSyncDate(
                                      user.syncJobs?.[Apps.Slack]?.lastSyncDate,
                                    )}
                                  </span>
                                  {user.syncJobs?.[Apps.Slack]?.createdAt && (
                                    <span className="text-xs text-gray-400 dark:text-gray-500">
                                      Created:{" "}
                                      {new Date(
                                        user.syncJobs[Apps.Slack].createdAt,
                                      ).toLocaleDateString()}
                                    </span>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </div>
                </Card>
              </div>
            )}
          </div>

          <Dialog
            open={!!userToConfirmRoleChange}
            onOpenChange={() => setUserToConfirmRoleChange(null)}
          >
            <DialogContent className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 max-w-md">
              <DialogHeader>
                <DialogTitle className="text-gray-900 dark:text-gray-100">
                  Confirm Role Change
                </DialogTitle>
                <DialogDescription className="text-gray-600 dark:text-gray-400">
                  Are you sure you want to change this user's role? This action
                  cannot be undone.
                </DialogDescription>
              </DialogHeader>

              {userToConfirmRoleChange && (
                <div className="py-4">
                  <div className="flex items-center space-x-3 mb-4">
                    <Avatar>
                      <AvatarImage
                        src={
                          userToConfirmRoleChange.user.photoLink
                            ? `/api/v1/proxy/${encodeURIComponent(userToConfirmRoleChange.user.photoLink)}`
                            : undefined
                        }
                        onError={(e) => {
                          ;(e.target as HTMLImageElement).style.display = "none"
                        }}
                      />
                      <AvatarFallback className="bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300">
                        {userToConfirmRoleChange.user.name?.[0]?.toUpperCase() ||
                          userToConfirmRoleChange.user.email[0].toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {userToConfirmRoleChange?.user?.name ||
                          userToConfirmRoleChange?.user.email}
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400">
                        {userToConfirmRoleChange?.user.email}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center space-x-2 text-sm text-gray-700 dark:text-gray-300">
                    <span>Role will change from</span>
                    <Badge
                      variant={getRoleBadgeVariant(
                        userToConfirmRoleChange.user.role,
                      )}
                    >
                      {userToConfirmRoleChange.user.role}
                    </Badge>
                    <span>to</span>
                    <Badge
                      variant={getRoleBadgeVariant(
                        userToConfirmRoleChange.newRole,
                      )}
                    >
                      {userToConfirmRoleChange.newRole}
                    </Badge>
                  </div>
                </div>
              )}

              <DialogFooter className="gap-2">
                <Button
                  variant="outline"
                  onClick={() => setUserToConfirmRoleChange(null)}
                  className="border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() =>
                    handleRoleChange(
                      userToConfirmRoleChange!.user.id,
                      userToConfirmRoleChange!.newRole,
                    )
                  }
                  disabled={isUpdating}
                  className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 text-white"
                >
                  {isUpdating ? "Changing..." : "Confirm Change"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog
            open={!!selectedUser}
            onOpenChange={(open) => {
              if (!open) {
                setSelectedUser(null)
                setSelectDropdownOpen(null)
              }
            }}
          >
            <DialogContent className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 max-w-lg">
              <DialogHeader>
                <DialogTitle className="text-gray-900 dark:text-gray-100">
                  User Details
                </DialogTitle>
                <DialogDescription>
                  Detailed information about the selected user and their sync
                  status.
                </DialogDescription>
              </DialogHeader>

              {selectedUser && (
                <div className="space-y-6">
                  <div className="flex items-center space-x-4">
                    <Avatar className="h-16 w-16">
                      <AvatarImage
                        src={
                          selectedUser.photoLink
                            ? `/api/v1/proxy/${encodeURIComponent(selectedUser.photoLink)}`
                            : undefined
                        }
                        onError={(e) => {
                          ;(e.target as HTMLImageElement).style.display = "none"
                        }}
                      />
                      <AvatarFallback className="text-lg bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300">
                        {selectedUser.name?.[0]?.toUpperCase() ||
                          selectedUser.email[0].toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                        {selectedUser?.name || selectedUser.email}
                      </h3>
                      <p className="text-gray-500 dark:text-gray-400">
                        {selectedUser.email}
                      </p>
                      <Badge
                        variant={getRoleBadgeVariant(selectedUser.role)}
                        className="mt-1"
                      >
                        {selectedUser.role}
                      </Badge>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <h4 className="font-medium mb-2 text-gray-900 dark:text-gray-100">
                        Account Created
                      </h4>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {new Date(selectedUser.createdAt).toLocaleDateString(
                          "en-US",
                          {
                            year: "numeric",
                            month: "long",
                            day: "numeric",
                          },
                        )}
                      </p>
                    </div>

                    <div>
                      <h4 className="font-medium mb-2 text-gray-900 dark:text-gray-100">
                        User ID
                      </h4>
                      <p className="text-sm text-gray-500 dark:text-gray-400 font-mono">
                        {selectedUser.id}
                      </p>
                    </div>
                  </div>

                  <div>
                    <h4 className="font-medium mb-3 text-gray-900 dark:text-gray-100">
                      Sync Status
                    </h4>
                    <div className="grid grid-cols-2 gap-3">
                      {Object.entries(Apps).map(([key, app]) => (
                        <div
                          key={key}
                          className={`
                          flex flex-col p-3 rounded-lg
                          border
                          ${
                            selectedUser.syncJobs?.[app]?.lastSyncDate
                              ? "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700"
                              : "bg-gray-100 dark:bg-gray-800 border-gray-100 dark:border-gray-800 opacity-60"
                          }
                          min-h-[70px]
                        `}
                        >
                          <div className="flex items-center space-x-2">
                            {app === Apps.Gmail && (
                              <Mail className="h-4 w-4 text-gray-600 dark:text-gray-400" />
                            )}
                            {app === Apps.GoogleDrive && (
                              <HardDrive className="h-4 w-4 text-gray-600 dark:text-gray-400" />
                            )}
                            {app === Apps.GoogleCalendar && (
                              <Calendar className="h-4 w-4 text-gray-600 dark:text-gray-400" />
                            )}
                            {app === Apps.Slack && (
                              <MessageSquare className="h-4 w-4 text-gray-600 dark:text-gray-400" />
                            )}
                            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                              {app}
                            </span>
                          </div>
                          <span
                            className={`text-sm ${getSyncStatusColor(selectedUser.syncJobs?.[app]?.lastSyncDate)}`}
                          >
                            {formatSyncDate(
                              selectedUser.syncJobs?.[app]?.lastSyncDate,
                            )}
                          </span>
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            {selectedUser.syncJobs?.[app]?.createdAt
                              ? formatCreatedAt(
                                  selectedUser.syncJobs?.[app]?.createdAt,
                                )
                              : ""}
                          </span>
                          {app === Apps.Slack &&
                            selectedUser.syncJobs?.[app]?.connectorStatus && (
                              <span
                                className={`text-xs block ${getConnectorStatusColor(
                                  selectedUser.syncJobs?.[app]?.connectorStatus,
                                )}`}
                              >
                                {formatConnectorStatus(
                                  selectedUser.syncJobs?.[app]?.connectorStatus,
                                )}
                              </span>
                            )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  )
}
