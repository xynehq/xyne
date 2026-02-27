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
  username: string
  password?: string
  tablesInclude?: string
  tablesIgnore?: string
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

interface DatabaseConnectorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingConnector?: {
    id: string
    name: string
    config: any
  } | null
}

function RequiredLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor: string }) {
  return (
    <Label htmlFor={htmlFor}>
      {children} <span className="text-destructive">*</span>
    </Label>
  )
}

export function DatabaseConnectorDialog({
  open,
  onOpenChange,
  editingConnector,
}: DatabaseConnectorDialogProps) {
  const queryClient = useQueryClient()

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

  const form = editingConnector
    ? {
        name: editingConnector.name || "",
        engine: editingConnector.config?.engine || "postgres",
        host: editingConnector.config?.host || "",
        port: editingConnector.config?.port || 5432,
        database: editingConnector.config?.database || "",
        schema: editingConnector.config?.schema || "",
        username: "",
        password: "",
        tablesInclude: editingConnector.config?.tables?.include?.join(", ") || "",
        tablesIgnore: editingConnector.config?.tables?.ignore?.join(", ") || "",
        watermarkColumn: editingConnector.config?.watermarkColumn || "",
        batchSize: editingConnector.config?.batchSize || 1000,
      }
    : defaultForm

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const data: DatabaseConnectorForm = {
      name: formData.get("name") as string,
      engine: formData.get("engine") as "postgres" | "mysql",
      host: formData.get("host") as string,
      port: parseInt(formData.get("port") as string, 10) || 5432,
      database: formData.get("database") as string,
      schema: formData.get("schema") as string,
      username: formData.get("username") as string,
      password: formData.get("password") as string,
      tablesInclude: formData.get("tablesInclude") as string,
      tablesIgnore: formData.get("tablesIgnore") as string,
      watermarkColumn: formData.get("watermarkColumn") as string,
      batchSize: parseInt(formData.get("batchSize") as string, 10) || 1000,
    }

    if (editingConnector) {
      updateMutation.mutate({
        connectorId: editingConnector.id,
        name: data.name,
        engine: data.engine,
        host: data.host,
        port: data.port,
        database: data.database,
        schema: data.schema || undefined,
        username: data.username,
        password: data.password || undefined,
        tablesInclude: data.tablesInclude || undefined,
        tablesIgnore: data.tablesIgnore || undefined,
        watermarkColumn: data.watermarkColumn || undefined,
        batchSize: data.batchSize,
      })
    } else {
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
        watermarkColumn: data.watermarkColumn || undefined,
        batchSize: data.batchSize,
      })
    }
  }

  const isLoading = createMutation.isPending || updateMutation.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editingConnector ? "Edit database connection" : "New database connection"}
          </DialogTitle>
          <DialogDescription>
            {editingConnector
              ? "Update your database connection settings. Leave password blank to keep the existing password."
              : "Connect a Postgres or MySQL database to sync tables into search. MVP: Postgres only."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
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
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="postgres">PostgreSQL</SelectItem>
                  <SelectItem value="mysql">MySQL (coming soon)</SelectItem>
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
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <RequiredLabel htmlFor="username">Username</RequiredLabel>
              <Input
                id="username"
                name="username"
                defaultValue={form.username}
                required
              />
            </div>
            <div className="space-y-2">
              {editingConnector ? <Label htmlFor="password">Password</Label> : <RequiredLabel htmlFor="password">Password</RequiredLabel>}
              <Input
                id="password"
                name="password"
                type="password"
                defaultValue={form.password}
                required={!editingConnector}
                placeholder={editingConnector ? "••••••••" : undefined}
              />
            </div>
          </div>
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
                "Update"
              ) : (
                "Create"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}