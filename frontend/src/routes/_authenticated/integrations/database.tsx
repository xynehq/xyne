import {
  createFileRoute,
  useRouterState,
} from "@tanstack/react-router"
import { useState } from "react"
import { toast } from "@/hooks/use-toast"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Sidebar } from "@/components/Sidebar"
import { IntegrationsSidebar } from "@/components/IntegrationsSidebar"
import {
  Database,
  Loader2,
  Play,
  RefreshCw,
  Trash2,
  Pencil,
  MoreVertical,
} from "lucide-react"
import { authFetch } from "@/utils/authFetch"
import { api } from "@/api"
import { getErrorMessage } from "@/lib/utils"
import type { PublicUser, PublicWorkspace } from "shared/types"
import { DatabaseConnectorDialog } from "@/components/DatabaseConnectorDialog"

const ConnectorTypeDatabase = "Database"
const APP_DATABASE = "database"

async function getConnectors(isAdmin: boolean): Promise<any[]> {
  const res = isAdmin
    ? await api.admin.connectors.all.$get()
    : await api.connectors.all.$get()
  if (!res.ok) throw new Error("Could not get connectors")
  return res.json()
}

async function triggerSync(connectorId: number) {
  const res = await authFetch("/api/v1/connectors/database/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectorId: String(connectorId) }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.message || res.statusText)
  }
  return res.json()
}

async function getSyncState(connectorId: number) {
  const res = await authFetch(
    `/api/v1/connectors/database/${connectorId}/sync-state`,
  )
  if (!res.ok) throw new Error("Could not get sync state")
  return res.json()
}

async function syncTable(connectorId: string, tableName: string) {
  const res = await authFetch("/api/v1/connectors/database/sync-table", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectorId, tableName }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.message || res.statusText)
  }
  return res.json()
}

async function deleteConnector(connectorId: string) {
  const res = await authFetch("/api/v1/connectors/database/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectorId }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.message || res.statusText)
  }
  return res.json()
}

export const DatabaseIntegration = ({
  user,
  workspace,
  agentWhiteList,
  isAdmin,
}: {
  user: PublicUser
  workspace: PublicWorkspace
  agentWhiteList: boolean
  isAdmin: boolean
}) => {
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingConnector, setEditingConnector] = useState<{
    id: string
    name: string
    config: any
  } | null>(null)
  const [expandedConnectors, setExpandedConnectors] = useState<Set<string>>(
    new Set()
  )

  const { data: connectors = [], isPending } = useQuery({
    queryKey: ["connectors", isAdmin],
    queryFn: () => getConnectors(isAdmin),
  })

  const databaseConnectors = connectors.filter(
    (c: any) => c.type === ConnectorTypeDatabase || c.app === APP_DATABASE,
  )

  const handleEdit = (conn: { id: string; name: string; config: any }) => {
    setEditingConnector(conn)
    setDialogOpen(true)
  }

  const handleAddNew = () => {
    setEditingConnector(null)
    setDialogOpen(true)
  }

  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open)
    if (!open) {
      setEditingConnector(null)
    }
  }

  const toggleConnector = (connectorId: string) => {
    setExpandedConnectors((prev) => {
      const next = new Set(prev)
      if (next.has(connectorId)) {
        next.delete(connectorId)
      } else {
        next.add(connectorId)
      }
      return next
    })
  }

  return (
    <div className="flex w-full h-full dark:bg-[#1E1E1E]">
      <Sidebar
        photoLink={user?.photoLink ?? ""}
        role={user?.role}
        isAgentMode={agentWhiteList}
      />
      <IntegrationsSidebar role={user.role} isAgentMode={agentWhiteList} />
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="w-8 h-8" />
              <h1 className="text-2xl font-semibold">Database</h1>
            </div>
            <Button onClick={handleAddNew}>Add database connection</Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Your database connections</CardTitle>
              <CardDescription>
                Click on a connector to view tables. Use the menu for sync, edit,
                and delete actions.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isPending ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
              ) : databaseConnectors.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No database connectors yet. Add one above.
                </p>
              ) : (
                <div className="space-y-1">
                  {databaseConnectors.map((conn: any) => (
                    <ConnectorRow
                      key={conn.id}
                      conn={conn}
                      isExpanded={expandedConnectors.has(String(conn.id))}
                      onToggle={() => toggleConnector(String(conn.id))}
                      onSync={() =>
                        queryClient.invalidateQueries({
                          queryKey: ["connectors"],
                        })
                      }
                      onDelete={() => {
                        queryClient.invalidateQueries({
                          queryKey: ["connectors"],
                        })
                      }}
                      onEdit={() => handleEdit(conn)}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <DatabaseConnectorDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        editingConnector={editingConnector}
      />
    </div>
  )
}

function ConnectorRow({
  conn,
  isExpanded,
  onToggle,
  onSync,
  onDelete,
  onEdit,
}: {
  conn: {
    id: string
    name: string
    internalId: number
    config?: any
  }
  isExpanded: boolean
  onToggle: () => void
  onSync: () => void
  onDelete: () => void
  onEdit: () => void
}) {
  const [syncing, setSyncing] = useState(false)
  const [syncingTable, setSyncingTable] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const internalId = conn.internalId
  const connectorIdStr = conn.id

  const { data: syncState, refetch: refetchState } = useQuery({
    queryKey: ["database-sync-state", internalId],
    queryFn: () => getSyncState(internalId),
    enabled: Boolean(internalId) && isExpanded,
  })

  const handleSync = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setSyncing(true)
    try {
      await triggerSync(internalId)
      toast({ title: "Sync started" })
      await refetchState()
      onSync()
    } catch (e) {
      toast({
        title: "Sync failed",
        description: getErrorMessage(e),
        variant: "destructive",
      })
    } finally {
      setSyncing(false)
    }
  }

  const handleSyncTable = async (tableName: string) => {
    setSyncingTable(tableName)
    try {
      await syncTable(connectorIdStr, tableName)
      toast({ title: `Synced ${tableName}` })
      await refetchState()
      onSync()
    } catch (e) {
      toast({
        title: `Sync failed for ${tableName}`,
        description: getErrorMessage(e),
        variant: "destructive",
      })
    } finally {
      setSyncingTable(null)
    }
  }

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (
      !confirm(
        "Delete this database connector? Synced data in Knowledge Base will be removed."
      )
    )
      return
    setDeleting(true)
    try {
      await deleteConnector(connectorIdStr)
      toast({ title: "Connector deleted" })
      onDelete()
    } catch (e) {
      toast({
        title: "Failed to delete connector",
        description: getErrorMessage(e),
        variant: "destructive",
      })
    } finally {
      setDeleting(false)
    }
  }

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    onEdit()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault()
      onToggle()
    }
  }

  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      <div
        className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={onToggle}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
      >
        <div className="flex items-center gap-3">
          <div>
            <p className="font-medium">{conn.name}</p>
            {conn.config && (
              <p className="text-xs text-muted-foreground">
                {conn.config.host}:{conn.config.port}/{conn.config.database}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreVertical className="w-4 h-4" />
                <span className="sr-only">Open menu</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleSync} disabled={syncing}>
                {syncing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
                <span className="ml-2">Sync all</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleEdit}>
                <Pencil className="w-4 h-4" />
                <span className="ml-2">Edit</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleDelete}
                disabled={deleting}
                className="text-destructive focus:text-destructive"
              >
                {deleting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
                <span className="ml-2">Delete</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {isExpanded && (
        <div className="border-t px-4 py-3 bg-muted/30">
          {syncState?.tables?.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Table</TableHead>
                  <TableHead>Rows synced</TableHead>
                  <TableHead>Last updated</TableHead>
                  <TableHead className="w-[100px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {syncState.tables.map((t: any) => (
                  <TableRow key={t.tableName}>
                    <TableCell>{t.tableName}</TableCell>
                    <TableCell>{t.rowsSynced ?? 0}</TableCell>
                    <TableCell>
                      {t.updatedAt ? formatDate(t.updatedAt) : "—"}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8"
                        onClick={() => handleSyncTable(t.tableName)}
                        disabled={syncingTable !== null}
                      >
                        {syncingTable === t.tableName ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <RefreshCw className="w-4 h-4" />
                        )}
                        <span className="ml-1">Sync</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No tables synced yet. Click "Sync all" from the menu to start
              syncing.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export const Route = createFileRoute(
  "/_authenticated/integrations/database",
)({
  component: () => {
    const matches = useRouterState({ select: (s) => s.matches })
    const ctx = matches[matches.length - 1].context as {
      user: PublicUser
      workspace: PublicWorkspace
      agentWhiteList: boolean
    }
    const isAdmin =
      ctx.user?.role === "SuperAdmin" || ctx.user?.role === "Admin"
    return (
      <DatabaseIntegration
        user={ctx.user}
        workspace={ctx.workspace}
        agentWhiteList={ctx.agentWhiteList}
        isAdmin={!!isAdmin}
      />
    )
  },
})