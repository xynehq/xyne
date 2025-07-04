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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
}: { children: React.ReactNode; className?: string }) => (
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
}: { src?: string; alt?: string; onError?: (e: any) => void }) => (
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
}: { children: React.ReactNode; className?: string }) => (
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

// Add a simple toast function at the top of the file
const showToast = (message: string, type: "success" | "error" = "success") => {
  // Simple browser notification or console log for now
  toast({
    title: type === "success" ? "Success" : "Error",
    description: `${message}`,
    variant: type === "error" ? "destructive" : "default",
  })
  // You can replace this with your existing notification system
}

export const Route = createFileRoute("/_authenticated/admin/users")({
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState("")
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
      label: "Gmail Sync",
      value: "gmailSync",
      icon: <Mail className="inline mr-2 h-4 w-4" />,
    },
    {
      label: "Google Drive Sync",
      value: "driveSync",
      icon: <HardDrive className="inline mr-2 h-4 w-4" />,
    },
    {
      label: "Google Calendar Sync",
      value: "calendarSync",
      icon: <Calendar className="inline mr-2 h-4 w-4" />,
    },
    {
      label: "Slack Sync",
      value: "slackSync",
      icon: <MessageSquare className="inline mr-2 h-4 w-4" />,
    },
  ]

  // Map sortField to Apps enum
  const sortFieldToApp = {
    gmailSync: Apps.Gmail,
    driveSync: Apps.GoogleDrive,
    calendarSync: Apps.GoogleCalendar,
    slackSync: Apps.Slack,
  }

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        setLoading(true)
        const res = await api.admin.list_users.$get()

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
                            typeof value === "string" ||
                            typeof value === "number"
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
        setError(
          err instanceof Error ? err.message : "An unknown error occurred",
        )
        console.error("Error fetching users:", err)
      } finally {
        setLoading(false)
      }
    }

    fetchUsers()
  }, [])

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

  let filteredUsers = users.filter((user) => {
    const searchLower = searchTerm.toLowerCase()
    return (
      user.name?.toLowerCase().includes(searchLower) ||
      user.email.toLowerCase().includes(searchLower)
    )
  })

  // Only sort by selected sync app's createdAt
  if (sortField) {
    const app = sortFieldToApp[sortField]
    filteredUsers = [...filteredUsers].sort((a, b) => {
      const aDate = a.syncJobs?.[app]?.createdAt
        ? new Date(a.syncJobs?.[app]?.createdAt!).getTime()
        : 0
      const bDate = b.syncJobs?.[app]?.createdAt
        ? new Date(b.syncJobs?.[app]?.createdAt!).getTime()
        : 0
      return sortDirection === "asc" ? aDate - bDate : bDate - aDate
    })
  }

  const handleRoleChange = async (userId: string, newRole: UserRole) => {
    try {
      setIsUpdating(true)
      const res = await api.admin.change_role.$post({
        form: { userId, newRole },
      })

      if (!res.ok) {
        throw new Error("Failed to update role")
      }

      const usersRes = await api.admin.list_users.$get()
      if (!usersRes.ok) {
        throw new Error("Failed to re-fetch users after update")
      }

      const updatedUsersData = await usersRes.json()
      if (
        updatedUsersData &&
        updatedUsersData.data &&
        Array.isArray(updatedUsersData.data)
      ) {
        setUsers(updatedUsersData.data)
      }

      showToast("User role has been successfully updated.", "success")
      setUserToConfirmRoleChange(null)
    } catch (error) {
      console.error("Error updating role:", error)
      showToast("Failed to update user role.", "error")
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
      showToast(
        `Please set up the Google integration for ${user.name || user.email}.`,
        "error",
      )
      return
    }

    try {
      setSyncingUser(user.email)
      const res = await api.admin.syncGoogleWorkSpaceByMail.$post({
        form: { email: user.email },
      })

      if (!res.ok) {
        throw new Error("Failed to trigger sync")
      }

      const usersRes = await api.admin.list_users.$get()
      if (!usersRes.ok) {
        throw new Error("Failed to re-fetch users after sync")
      }

      const updatedUsersData = await usersRes.json()
      if (
        updatedUsersData &&
        updatedUsersData.data &&
        Array.isArray(updatedUsersData.data)
      ) {
        setUsers(updatedUsersData.data)
      }

      showToast(
        "Google Workspace sync has been successfully triggered.",
        "success",
      )
    } catch (error) {
      console.error("Error triggering sync:", error)
      showToast("Failed to trigger Google Workspace sync.", "error")
    } finally {
      setSyncingUser(null)
    }
  }

  const handleSlackSync = async (user: User) => {
    if (!user.syncJobs?.[Apps.Slack]) {
      showToast(
        `Please set up the Slack integration for ${user.name || user.email}.`,
        "error",
      )
      return
    }

    try {
      setSyncingSlackUser(user.email)
      const res = await api.admin.syncSlackByMail.$post({
        form: { email: user.email },
      })

      if (!res.ok) {
        throw new Error("Failed to trigger Slack sync")
      }

      const usersRes = await api.admin.list_users.$get()
      if (!usersRes.ok) {
        throw new Error("Failed to re-fetch users after sync")
      }

      const updatedUsersData = await usersRes.json()
      if (
        updatedUsersData &&
        updatedUsersData.data &&
        Array.isArray(updatedUsersData.data)
      ) {
        setUsers(updatedUsersData.data)
      }

      showToast("Slack sync has been successfully triggered.", "success")
    } catch (error) {
      console.error("Error triggering Slack sync:", error)
      showToast("Failed to trigger Slack sync.", "error")
    } finally {
      setSyncingSlackUser(null)
    }
  }

  if (loading) {
    return (
      <div className="flex w-full h-full bg-white dark:bg-gray-900">
        <Sidebar
          photoLink={currentUser?.photoLink ?? ""}
          role={currentUser?.role}
          isAgentMode={agentWhiteList}
        />
        <div className="flex-grow ml-[52px] p-6">
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-4 w-64 mt-2" />
              </div>
              <Skeleton className="h-10 w-64" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Card key={i}>
                  <CardHeader>
                    <Skeleton className="h-4 w-24" />
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-8 w-12" />
                  </CardContent>
                </Card>
              ))}
            </div>
            <Card>
              <CardHeader>
                <Skeleton className="h-6 w-32" />
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex items-center space-x-4">
                      <Skeleton className="h-10 w-10 rounded-full" />
                      <div className="space-y-2 flex-1">
                        <Skeleton className="h-4 w-48" />
                        <Skeleton className="h-3 w-32" />
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex w-full h-full bg-white dark:bg-gray-900">
        <Sidebar
          photoLink={currentUser?.photoLink ?? ""}
          role={currentUser?.role}
          isAgentMode={agentWhiteList}
        />
        <div className="flex-grow ml-[52px] min-h-screen flex items-center justify-center dark:bg-gray-900">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 px-4 py-3 rounded-lg">
            <p className="font-medium">Error loading users</p>
            <p className="text-sm">{error}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex w-full h-full bg-white dark:bg-gray-900">
      <Sidebar
        photoLink={currentUser?.photoLink ?? ""}
        role={currentUser?.role}
        isAgentMode={agentWhiteList}
      />
      <div className="flex-grow ml-[52px] p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
              User Management
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              Manage users, roles, and sync integrations
            </p>
          </div>
          <div className="flex items-center space-x-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-gray-500 h-4 w-4" />
              <Input
                placeholder="Search users..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 w-64"
              />
            </div>
            {/* Sync App Sort Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="ml-2 flex items-center gap-2"
                >
                  {syncSortOptions.find((opt) => opt.value === sortField)?.icon}
                  {
                    syncSortOptions.find((opt) => opt.value === sortField)
                      ?.label
                  }
                  {sortDirection === "asc" ? (
                    <ChevronUp className="ml-1 h-4 w-4" />
                  ) : (
                    <ChevronDown className="ml-1 h-4 w-4" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <div className="px-2 py-1 text-xs text-muted-foreground font-semibold">
                  Sort by Sync App
                </div>
                {syncSortOptions.map((opt) => (
                  <DropdownMenuItem
                    key={opt.value}
                    onClick={() => {
                      if (sortField === opt.value) {
                        setSortDirection((d) => (d === "asc" ? "desc" : "asc"))
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

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Users</CardTitle>
              <Users className="h-4 w-4 text-gray-600 dark:text-gray-400" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalUsers}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Super Admins
              </CardTitle>
              {/* <Badge variant="destructive" className="h-4 w-4 p-0">SA</Badge> */}
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{superAdmins}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Admins</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{admins}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Regular Users
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{regularUsers}</div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Users</CardTitle>
            <CardDescription>
              A list of all users in your workspace with their sync status
            </CardDescription>
          </CardHeader>
          <CardContent>
            {filteredUsers.length === 0 ? (
              <div className="text-center py-12">
                <Users className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500" />
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
              <div className="rounded-md border border-gray-200 dark:border-gray-700">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead className="text-center">
                        <div className="flex items-center justify-center gap-2">
                          <Mail className="h-4 w-4" />
                          Gmail
                        </div>
                      </TableHead>
                      <TableHead className="text-center">
                        <div className="flex items-center justify-center gap-2">
                          <HardDrive className="h-4 w-4" />
                          Drive
                        </div>
                      </TableHead>
                      <TableHead className="text-center">
                        <div className="flex items-center justify-center gap-2">
                          <Calendar className="h-4 w-4" />
                          Calendar
                        </div>
                      </TableHead>
                      <TableHead className="text-center">
                        <div className="flex items-center justify-center gap-2">
                          <MessageSquare className="h-4 w-4" />
                          Slack
                        </div>
                      </TableHead>
                      <TableHead className="w-[50px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredUsers.map((user) => (
                      <TableRow key={user.id}>
                        <TableCell>
                          <div className="flex items-center space-x-3">
                            <Avatar>
                              <AvatarImage
                                src={
                                  user.photoLink
                                    ? `/api/v1/proxy/${encodeURIComponent(user.photoLink)}`
                                    : undefined
                                }
                                alt={user.name || user.email}
                                onError={(e) => {
                                  // Hide broken images
                                  ;(
                                    e.target as HTMLImageElement
                                  ).style.display = "none"
                                }}
                              />
                              <AvatarFallback>
                                {user.name?.[0]?.toUpperCase() ||
                                  user.email[0].toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <div className="font-medium text-gray-900 dark:text-gray-100">
                                {user.name || user.email}
                              </div>
                              <div className="text-sm text-gray-500 dark:text-gray-400">
                                {user.email}
                              </div>
                            </div>
                          </div>
                        </TableCell>

                        <TableCell>
                          {currentUser.role === UserRole.SuperAdmin &&
                          currentUser.email !== user.email ? (
                            <div className="relative inline-block">
                              <select
                                id={`user-role-select-${user.id}`}
                                name={`user-role-select-${user.id}`}
                                value={user.role}
                                onChange={(e) =>
                                  handleRoleSelectChange(
                                    user,
                                    e.target.value as UserRole,
                                  )
                                }
                                onFocus={() => setSelectDropdownOpen(user.id)}
                                onBlur={() => setSelectDropdownOpen(null)}
                                disabled={isUpdating}
                                className="appearance-none bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 pr-6 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed min-w-[100px]"
                              >
                                {Object.values(UserRole).map((role) => (
                                  <option key={role} value={role}>
                                    {role}
                                  </option>
                                ))}
                              </select>
                              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-1">
                                <svg
                                  className="fill-current h-3 w-3 text-gray-700 dark:text-gray-300"
                                  xmlns="http://www.w3.org/2000/svg"
                                  viewBox="0 0 20 20"
                                >
                                  <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
                                </svg>
                              </div>
                              {isUpdating && (
                                <div className="absolute right-6 top-1/2 transform -translate-y-1/2">
                                  <div className="animate-spin rounded-full h-3 w-3 border-t-2 border-b-2 border-blue-500"></div>
                                </div>
                              )}
                            </div>
                          ) : (
                            <Badge variant={getRoleBadgeVariant(user.role)}>
                              {user.role}
                            </Badge>
                          )}
                        </TableCell>

                        <TableCell className="text-center">
                          <span
                            className={getSyncStatusColor(
                              user.syncJobs?.[Apps.Gmail]?.lastSyncDate,
                            )}
                          >
                            {formatSyncDate(
                              user.syncJobs?.[Apps.Gmail]?.lastSyncDate,
                            )}
                          </span>
                          <br />
                          <span className="text-xs text-muted-foreground">
                            {user.syncJobs?.[Apps.Gmail]?.createdAt
                              ? formatCreatedAt(
                                  user.syncJobs?.[Apps.Gmail]?.createdAt,
                                )
                              : ""}
                          </span>
                        </TableCell>

                        <TableCell className="text-center">
                          <span
                            className={getSyncStatusColor(
                              user.syncJobs?.[Apps.GoogleDrive]?.lastSyncDate,
                            )}
                          >
                            {formatSyncDate(
                              user.syncJobs?.[Apps.GoogleDrive]?.lastSyncDate,
                            )}
                          </span>
                          <br />
                          <span className="text-xs text-muted-foreground">
                            {user.syncJobs?.[Apps.GoogleDrive]?.createdAt
                              ? formatCreatedAt(
                                  user.syncJobs?.[Apps.GoogleDrive]?.createdAt,
                                )
                              : ""}
                          </span>
                        </TableCell>

                        <TableCell className="text-center">
                          <span
                            className={getSyncStatusColor(
                              user.syncJobs?.[Apps.GoogleCalendar]
                                ?.lastSyncDate,
                            )}
                          >
                            {formatSyncDate(
                              user.syncJobs?.[Apps.GoogleCalendar]
                                ?.lastSyncDate,
                            )}
                          </span>
                          <br />
                          <span className="text-xs text-muted-foreground">
                            {user.syncJobs?.[Apps.GoogleCalendar]?.createdAt
                              ? formatCreatedAt(
                                  user.syncJobs?.[Apps.GoogleCalendar]
                                    ?.createdAt,
                                )
                              : ""}
                          </span>
                        </TableCell>

                        <TableCell className="text-center">
                          <span
                            className={getSyncStatusColor(
                              user.syncJobs?.[Apps.Slack]?.lastSyncDate,
                            )}
                          >
                            {formatSyncDate(
                              user.syncJobs?.[Apps.Slack]?.lastSyncDate,
                            )}
                          </span>
                          <br />
                          <span className="text-xs text-muted-foreground">
                            {user.syncJobs?.[Apps.Slack]?.createdAt
                              ? formatCreatedAt(
                                  user.syncJobs?.[Apps.Slack]?.createdAt,
                                )
                              : ""}
                          </span>
                          {user.syncJobs?.[Apps.Slack]?.connectorStatus && (
                            <>
                              <br />
                              <span
                                className={`text-xs ${getConnectorStatusColor(
                                  user.syncJobs?.[Apps.Slack]?.connectorStatus,
                                )}`}
                              >
                                {formatConnectorStatus(
                                  user.syncJobs?.[Apps.Slack]?.connectorStatus,
                                )}
                              </span>
                            </>
                          )}
                        </TableCell>

                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
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
                                disabled={syncingSlackUser === user.email}
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
              </div>
            )}
          </CardContent>
        </Card>

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
                      {userToConfirmRoleChange.user.name ||
                        userToConfirmRoleChange.user.email}
                    </div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      {userToConfirmRoleChange.user.email}
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
                      {selectedUser.name || selectedUser.email}
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
  )
}
