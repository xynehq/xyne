import { toast } from "@/hooks/use-toast"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { authFetch } from "@/utils/authFetch"
import { getErrorMessage } from "@/lib/utils"
import { DatabaseConnectorConfig } from "@/server/shared/types"
import { useState } from "react"

interface DatabaseConnectorForm {
  name: string
  engine: "postgres" | "mysql"
  host: string
  port: number
  database: string
  schema: string
  username: string
  password: string
  tablesInclude: string
  tablesIgnore: string
  tablesEmbed: string
  watermarkColumn: string
  batchSize: number
}

const defaultForm: DatabaseConnectorForm = {
  name: "",
  engine: "postgres",
  host: "",
  port: 5432,
  database: "",
  schema: "",
  username: "",
  password: "",
  tablesInclude: "",
  tablesIgnore: "",
  tablesEmbed: "",
  watermarkColumn: "",
  batchSize: 1000,
}

async function createDatabaseConnector(body: {
  name: string
  engine: "postgres" | "mysql"
  host: string
  port: number
  database: string
  schema?: string
  username: string
  password: string
  tablesInclude?: string
  tablesIgnore?: string
  tablesEmbed?: string
  watermarkColumn?: string
  batchSize: number
}) {
  const res = await authFetch("/api/v1/connectors/database/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.message || res.statusText)
  }
  return res.json()
}

async function updateDatabaseConnector(body: {
  connectorId: string
  name: string
  engine: "postgres" | "mysql"
  host: string
  port: number
  database: string
  schema?: string
  tablesInclude?: string
  tablesIgnore?: string
  tablesEmbed?: string
  watermarkColumn?: string
  batchSize: number
}) {
  const res = await authFetch("/api/v1/connectors/database/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.message || res.statusText)
  }
  return res.json()
}

async function rotateCredentials(body: {
  connectorId: string
  newUsername: string
  newPassword: string
}) {
  const res = await authFetch("/api/v1/connectors/database/rotate-credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.message || res.statusText)
  }
  return res.json()
}

interface DatabaseConnectorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingConnector?: {
    id: string
    name: string
    config: DatabaseConnectorConfig
  } | null
}

function RequiredLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor: string }) {
  return (
    <Label htmlFor={htmlFor}>
      {children} <span className="text-destructive">*</span>
    </Label>
  )
}

// Validation constants
const PORT_MIN = 1
const PORT_MAX = 65535
const BATCH_SIZE_MIN = 1
const BATCH_SIZE_MAX = 100000

// Parse and validate numeric form fields with proper bounds checking
function parsePort(value: string | null, defaultValue: number = 5432): number {
  if (!value) return defaultValue
  const parsed = parseInt(value, 10)
  if (Number.isNaN(parsed)) return defaultValue
  if (parsed < PORT_MIN) return PORT_MIN
  if (parsed > PORT_MAX) return PORT_MAX
  return parsed
}

function parseBatchSize(value: string | null, defaultValue: number = 1000): number {
  if (!value) return defaultValue
  const parsed = parseInt(value, 10)
  if (Number.isNaN(parsed)) return defaultValue
  if (parsed < BATCH_SIZE_MIN) return BATCH_SIZE_MIN
  if (parsed > BATCH_SIZE_MAX) return BATCH_SIZE_MAX
  return parsed
}

// Rotate credentials dialog - separate from config editing
function RotateCredentialsDialog({
  open,
  onOpenChange,
  connectorId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectorId: string
}) {
  const [newUsername, setNewUsername] = useState("")
  const [newPassword, setNewPassword] = useState("")

  const rotateMutation = useMutation({
    mutationFn: rotateCredentials,
    onSuccess: () => {
      toast({ title: "Credentials rotated successfully" })
      onOpenChange(false)
      setNewUsername("")
      setNewPassword("")
    },
    onError: (e) => {
      toast({
        title: "Failed to rotate credentials",
        description: getErrorMessage(e),
        variant: "destructive",
      })
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    rotateMutation.mutate({
      connectorId,
      newUsername,
      newPassword,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Change credentials</DialogTitle>
          <DialogDescription>
            Enter new database credentials.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <RequiredLabel htmlFor="new-username">New username</RequiredLabel>
            <Input
              id="new-username"
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <RequiredLabel htmlFor="new-password">New password</RequiredLabel>
            <Input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={rotateMutation.isPending}>
              {rotateMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                "Save"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function DatabaseConnectorDialog({
  open,
  onOpenChange,
  editingConnector,
}: DatabaseConnectorDialogProps) {
  const queryClient = useQueryClient()
  const [showRotateDialog, setShowRotateDialog] = useState(false)

  const createMutation = useMutation({
    mutationFn: createDatabaseConnector,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connectors"] })
      onOpenChange(false)
      toast({ title: "Database connector created" })
    },
    onError: (e) => {
      toast({
        title: "Failed to create connector",
        description: getErrorMessage(e),
        variant: "destructive",
      })
    },
  })

  const updateMutation = useMutation({
    mutationFn: updateDatabaseConnector,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connectors"] })
      onOpenChange(false)
      toast({ title: "Database connector updated" })
    },
    onError: (e) => {
      toast({
        title: "Failed to update connector",
        description: getErrorMessage(e),
        variant: "destructive",
      })
    },
  })

  const editForm = editingConnector
    ? {
        name: editingConnector.name || "",
        engine: editingConnector.config?.engine || "postgres" as const,
        host: editingConnector.config?.host || "",
        port: editingConnector.config?.port || 5432,
        database: editingConnector.config?.database || "",
        schema: editingConnector.config?.schema || "",
        tablesInclude: editingConnector.config?.tables?.include?.join(", ") || "",
        tablesIgnore: editingConnector.config?.tables?.ignore?.join(", ") || "",
        tablesEmbed: editingConnector.config?.tables?.embed?.join(", ") || "",
        watermarkColumn: editingConnector.config?.watermarkColumn || "",
        batchSize: editingConnector.config?.batchSize || 1000,
      }
    : null

  // Use editForm for edit mode, defaultForm (with username/password) for create mode
  const form = editingConnector ? editForm! : defaultForm

  const handleCreateSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const data: DatabaseConnectorForm = {
      name: formData.get("name") as string,
      engine: formData.get("engine") as "postgres" | "mysql",
      host: formData.get("host") as string,
      port: parsePort(formData.get("port") as string | null),
      database: formData.get("database") as string,
      schema: formData.get("schema") as string,
      username: formData.get("username") as string,
      password: formData.get("password") as string,
      tablesInclude: formData.get("tablesInclude") as string,
      tablesIgnore: formData.get("tablesIgnore") as string,
      tablesEmbed: formData.get("tablesEmbed") as string,
      watermarkColumn: formData.get("watermarkColumn") as string,
      batchSize: parseBatchSize(formData.get("batchSize") as string | null),
    }

    createMutation.mutate({
      name: data.name,
      engine: data.engine,
      host: data.host,
      port: data.port,
      database: data.database,
      schema: data.schema || undefined,
      username: data.username,
      password: data.password,
      tablesInclude: data.tablesInclude || undefined,
      tablesIgnore: data.tablesIgnore || undefined,
      tablesEmbed: data.tablesEmbed || undefined,
      watermarkColumn: data.watermarkColumn || undefined,
      batchSize: data.batchSize,
    })
  }

  const handleUpdateSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!editingConnector) return

    const formData = new FormData(e.currentTarget)
    const data = {
      name: formData.get("name") as string,
      engine: formData.get("engine") as "postgres" | "mysql",
      host: formData.get("host") as string,
      port: parsePort(formData.get("port") as string | null),
      database: formData.get("database") as string,
      schema: formData.get("schema") as string,
      tablesInclude: formData.get("tablesInclude") as string,
      tablesIgnore: formData.get("tablesIgnore") as string,
      tablesEmbed: formData.get("tablesEmbed") as string,
      watermarkColumn: formData.get("watermarkColumn") as string,
      batchSize: parseBatchSize(formData.get("batchSize") as string | null),
    }

    updateMutation.mutate({
      connectorId: editingConnector.id,
      ...data,
      schema: data.schema || undefined,
      tablesInclude: data.tablesInclude || undefined,
      tablesIgnore: data.tablesIgnore || undefined,
      tablesEmbed: data.tablesEmbed || undefined,
      watermarkColumn: data.watermarkColumn || undefined,
    })
  }

  const isLoading = createMutation.isPending || updateMutation.isPending

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingConnector ? "Edit database connection" : "New database connection"}
            </DialogTitle>
            <DialogDescription>
              {editingConnector
                ? "Update your database connection settings."
                : "Connect a Postgres or MySQL database to sync tables into search. MVP: Postgres only."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={editingConnector ? handleUpdateSubmit : handleCreateSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <RequiredLabel htmlFor="name">Connection name</RequiredLabel>
                <Input
                  id="name"
                  name="name"
                  defaultValue={form.name}
                  placeholder="My DB"
                  required
                />
              </div>
              <div className="space-y-2">
                <RequiredLabel htmlFor="engine">Engine</RequiredLabel>
                <Select name="engine" defaultValue={form.engine}>
                  <SelectTrigger id="engine">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="postgres">PostgreSQL</SelectItem>
                    <SelectItem value="mysql" disabled>MySQL (coming soon)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <RequiredLabel htmlFor="host">Host</RequiredLabel>
                <Input
                  id="host"
                  name="host"
                  defaultValue={form.host}
                  placeholder="localhost"
                  required
                />
              </div>
              <div className="space-y-2">
                <RequiredLabel htmlFor="port">Port</RequiredLabel>
                <Input
                  id="port"
                  name="port"
                  type="number"
                  min={PORT_MIN}
                  max={PORT_MAX}
                  defaultValue={form.port}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <RequiredLabel htmlFor="database">Database</RequiredLabel>
                <Input
                  id="database"
                  name="database"
                  defaultValue={form.database}
                  placeholder="mydb"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="schema">Schema</Label>
                <Input
                  id="schema"
                  name="schema"
                  defaultValue={form.schema}
                  placeholder="public"
                />
              </div>
            </div>
            {/* Credentials section - different for create vs edit */}
            {!editingConnector ? (
              // Create mode: show username/password fields
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <RequiredLabel htmlFor="username">Username</RequiredLabel>
                  <Input
                    id="username"
                    name="username"
                    defaultValue={defaultForm.username}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <RequiredLabel htmlFor="password">Password</RequiredLabel>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    defaultValue={defaultForm.password}
                    required
                  />
                </div>
              </div>
            ) : (
              // Edit mode: show masked credentials with rotate button
              <div className="space-y-3">
                <Label>Credentials</Label>
                <div className="flex items-center gap-4 p-3 bg-muted rounded-md">
                  <div className="flex-1">
                    <span className="text-sm text-muted-foreground">Username: </span>
                    <span className="text-sm font-medium">••••••••</span>
                  </div>
                  <div className="flex-1">
                    <span className="text-sm text-muted-foreground">Password: </span>
                    <span className="text-sm font-medium">••••••••</span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowRotateDialog(true)}
                  >
                    Change
                  </Button>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="tablesInclude">Tables include</Label>
                <Input
                  id="tablesInclude"
                  name="tablesInclude"
                  defaultValue={form.tablesInclude}
                  placeholder="users,orders"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tablesIgnore">Tables ignore</Label>
                <Input
                  id="tablesIgnore"
                  name="tablesIgnore"
                  defaultValue={form.tablesIgnore}
                  placeholder="migrations,logs"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tablesEmbed">Tables to embed</Label>
              <Input
                id="tablesEmbed"
                name="tablesEmbed"
                defaultValue={form.tablesEmbed}
                placeholder="users,messages"
              />
              <p className="text-xs text-muted-foreground">
                <strong>Embed:</strong> Full table data is copied into the Knowledge Base (uses storage; answers query it via DuckDB).{" "}
                <strong>Schema-only:</strong> Only table structure is stored; when answering, live SQL runs on your database. List table names here to embed; all other synced tables are schema-only.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="watermarkColumn">Watermark column</Label>
                <Input
                  id="watermarkColumn"
                  name="watermarkColumn"
                  defaultValue={form.watermarkColumn}
                  placeholder="updated_at"
                />
              </div>
              <div className="space-y-2">
                <RequiredLabel htmlFor="batchSize">Batch size</RequiredLabel>
                <Input
                  id="batchSize"
                  name="batchSize"
                  type="number"
                  min={BATCH_SIZE_MIN}
                  max={BATCH_SIZE_MAX}
                  step={1}
                  defaultValue={form.batchSize}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : editingConnector ? (
                  "Save"
                ) : (
                  "Create"
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rotate Credentials Dialog - only for edit mode */}
      {editingConnector && (
        <RotateCredentialsDialog
          open={showRotateDialog}
          onOpenChange={setShowRotateDialog}
          connectorId={editingConnector.id}
        />
      )}
    </>
  )
}