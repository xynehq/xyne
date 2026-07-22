import { useState, useRef, useCallback, useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Upload,
  Trash2,
  Plus,
  X,
  FileText,
  FileUp,
  FolderOpen,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
} from "lucide-react"
import * as api from "@/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

function StatusBadge({ status }: { status: string }) {
  switch (status.toUpperCase()) {
    case "COMPLETED":
      return (
        <Badge
          variant="outline"
          className="gap-1 font-normal text-green-700 border-green-200 bg-green-50 dark:text-green-400 dark:border-green-800 dark:bg-green-950"
        >
          <CheckCircle2 className="h-3 w-3" />
          Completed
        </Badge>
      )
    case "PROCESSING":
      return (
        <Badge
          variant="outline"
          className="gap-1 font-normal text-blue-700 border-blue-200 bg-blue-50 dark:text-blue-400 dark:border-blue-800 dark:bg-blue-950"
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          Processing
        </Badge>
      )
    case "PENDING":
      return (
        <Badge
          variant="outline"
          className="gap-1 font-normal text-yellow-700 border-yellow-200 bg-yellow-50 dark:text-yellow-400 dark:border-yellow-800 dark:bg-yellow-950"
        >
          <Clock className="h-3 w-3" />
          Pending
        </Badge>
      )
    case "FAILED":
      return (
        <Badge
          variant="outline"
          className="gap-1 font-normal text-red-700 border-red-200 bg-red-50 dark:text-red-400 dark:border-red-800 dark:bg-red-950"
        >
          <AlertCircle className="h-3 w-3" />
          Failed
        </Badge>
      )
    default:
      return (
        <Badge variant="secondary" className="font-normal">
          {status}
        </Badge>
      )
  }
}

export function Documents() {
  const queryClient = useQueryClient()
  const [selectedCollectionId, setSelectedCollectionId] = useState<
    string | null
  >(null)
  const [showUpload, setShowUpload] = useState(false)
  const [showCreateCollection, setShowCreateCollection] = useState(false)

  const { data: collectionsData, isLoading: collectionsLoading } = useQuery({
    queryKey: ["collections"],
    queryFn: api.listCollections,
  })

  const collections = collectionsData?.collections ?? []
  const selectedCollection =
    collections.find((c) => c.id === selectedCollectionId) ?? null

  // Auto-select first collection
  useEffect(() => {
    if (!selectedCollectionId && collections.length > 0) {
      setSelectedCollectionId(collections[0].id)
    }
  }, [collections, selectedCollectionId])

  // Clear selection if deleted
  useEffect(() => {
    if (
      selectedCollectionId &&
      collections.length > 0 &&
      !collections.find((c) => c.id === selectedCollectionId)
    ) {
      setSelectedCollectionId(collections[0]?.id ?? null)
    }
  }, [collections, selectedCollectionId])

  const { data: itemsData, isLoading: itemsLoading } = useQuery({
    queryKey: ["collection-items", selectedCollectionId],
    queryFn: () => api.listCollectionItems(selectedCollectionId!),
    enabled: !!selectedCollectionId,
  })

  // Auto-refresh when items are pending/processing
  const hasPendingItems = itemsData?.items.some(
    (item) =>
      item.uploadStatus === "PENDING" || item.uploadStatus === "PROCESSING",
  )

  useQuery({
    queryKey: ["collection-items-poll", selectedCollectionId],
    queryFn: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["collection-items", selectedCollectionId],
      })
      await queryClient.invalidateQueries({ queryKey: ["collections"] })
      return null
    },
    enabled: !!hasPendingItems,
    refetchInterval: 3000,
  })

  const deleteCollectionMutation = useMutation({
    mutationFn: api.deleteCollection,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["collections"] })
      if (collections.length <= 1) {
        setSelectedCollectionId(null)
      }
    },
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Documents</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage collections and documents in your knowledge base
          </p>
        </div>
      </div>

      <div className="flex gap-6 min-h-[500px]">
        {/* Left pane: Collections */}
        <div className="w-64 shrink-0">
          <Card className="h-full">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 py-3 px-4">
              <CardTitle className="text-sm font-medium">Collections</CardTitle>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setShowCreateCollection(true)}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </CardHeader>
            <CardContent className="px-2 pb-2 pt-0">
              {showCreateCollection && (
                <CreateCollectionInline
                  onClose={() => setShowCreateCollection(false)}
                  onCreated={(id) => {
                    setShowCreateCollection(false)
                    setSelectedCollectionId(id)
                    queryClient.invalidateQueries({ queryKey: ["collections"] })
                  }}
                />
              )}

              {collectionsLoading ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  Loading...
                </div>
              ) : collections.length === 0 && !showCreateCollection ? (
                <div className="py-8 text-center">
                  <FolderOpen className="h-8 w-8 text-muted-foreground/50 mx-auto mb-2" />
                  <p className="text-xs text-muted-foreground">
                    No collections
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 text-xs"
                    onClick={() => setShowCreateCollection(true)}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Create one
                  </Button>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {collections.map((col) => (
                    <div
                      key={col.id}
                      className={cn(
                        "group flex items-center justify-between px-3 py-2 rounded-md text-sm cursor-pointer transition-colors",
                        selectedCollectionId === col.id
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
                      )}
                      onClick={() => setSelectedCollectionId(col.id)}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{col.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {col.totalItems} item{col.totalItems !== 1 ? "s" : ""}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (
                            confirm(
                              `Delete collection "${col.name}" and all its documents?`,
                            )
                          ) {
                            deleteCollectionMutation.mutate(col.id)
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right pane: Documents in selected collection */}
        <div className="flex-1 min-w-0">
          {!selectedCollection ? (
            <Card className="h-full">
              <CardContent className="flex flex-col items-center justify-center h-full py-16">
                <FolderOpen className="h-10 w-10 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {collections.length === 0
                    ? "Create a collection to get started"
                    : "Select a collection to view documents"}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-medium">
                    {selectedCollection.name}
                  </h3>
                  {selectedCollection.description && (
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {selectedCollection.description}
                    </p>
                  )}
                </div>
                <Button size="sm" onClick={() => setShowUpload(true)}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Add Document
                </Button>
              </div>

              {showUpload && (
                <UploadForm
                  collectionId={selectedCollection.id}
                  collectionName={selectedCollection.name}
                  onClose={() => setShowUpload(false)}
                  onSuccess={() => {
                    setShowUpload(false)
                    queryClient.invalidateQueries({
                      queryKey: ["collection-items", selectedCollectionId],
                    })
                    queryClient.invalidateQueries({ queryKey: ["collections"] })
                  }}
                />
              )}

              {itemsLoading ? (
                <div className="text-sm text-muted-foreground py-8 text-center">
                  Loading documents...
                </div>
              ) : !itemsData?.items.length ? (
                <Card>
                  <CardContent className="flex flex-col items-center justify-center py-16">
                    <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
                      <Upload className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-medium">No documents yet</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Upload documents to this collection
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-4"
                      onClick={() => setShowUpload(true)}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1.5" />
                      Add Document
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Size</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Uploaded</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {itemsData.items.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2">
                              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                              <span className="truncate">{item.name}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {item.mimeType
                              ? item.mimeType.split("/").pop()
                              : item.type}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {item.fileSize
                              ? formatFileSize(item.fileSize)
                              : "—"}
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={item.uploadStatus} />
                            {item.statusMessage &&
                              item.uploadStatus === "FAILED" && (
                                <p
                                  className="text-xs text-destructive mt-1 max-w-[200px] truncate"
                                  title={item.statusMessage}
                                >
                                  {item.statusMessage}
                                </p>
                              )}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {new Date(item.createdAt).toLocaleDateString()}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CreateCollectionInline({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [error, setError] = useState("")

  const mutation = useMutation({
    mutationFn: api.createCollection,
    onSuccess: (data) => onCreated(data.id),
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Failed to create"),
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setError("")
    mutation.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
    })
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="p-2 mb-2 bg-muted/50 rounded-md space-y-2"
    >
      <Input
        autoFocus
        placeholder="Collection name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-8 text-sm"
      />
      <Input
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="h-8 text-sm"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-1.5">
        <Button
          type="submit"
          size="sm"
          className="h-7 text-xs flex-1"
          disabled={mutation.isPending}
        >
          {mutation.isPending ? "Creating..." : "Create"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={onClose}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}

function UploadForm({
  collectionId,
  collectionName,
  onClose,
  onSuccess,
}: {
  collectionId: string
  collectionName: string
  onClose: () => void
  onSuccess: () => void
}) {
  const [visibility, setVisibility] = useState<"public" | "authenticated">(
    "public",
  )
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState("")
  const [error, setError] = useState("")

  // Text mode
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")

  // File mode
  const [files, setFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  const textMutation = useMutation({
    mutationFn: api.uploadDocuments,
    onSuccess,
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Upload failed"),
  })

  const fileMutation = useMutation({
    mutationFn: api.uploadFiles,
    onSuccess,
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Upload failed"),
  })

  const isPending = textMutation.isPending || fileMutation.isPending

  const addTag = () => {
    const tag = tagInput.trim()
    if (tag && !tags.includes(tag)) {
      setTags([...tags, tag])
      setTagInput("")
    }
  }

  const removeTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag))
  }

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const arr = Array.from(newFiles)
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => `${f.name}-${f.size}`))
      return [
        ...prev,
        ...arr.filter((f) => !existing.has(`${f.name}-${f.size}`)),
      ]
    })
  }, [])

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
    },
    [addFiles],
  )

  const handleTextSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    textMutation.mutate({
      collection_id: collectionId,
      documents: [{ title, content, visibility, access_tags: tags }],
    })
  }

  const handleFileSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    if (files.length === 0) {
      setError("Please select at least one file")
      return
    }
    fileMutation.mutate({
      files,
      collection_id: collectionId,
      visibility,
      access_tags: tags,
    })
  }

  const sharedFields = (
    <>
      <div className="space-y-2">
        <Label>Visibility</Label>
        <select
          value={visibility}
          onChange={(e) =>
            setVisibility(e.target.value as "public" | "authenticated")
          }
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="public">Public — visible to everyone</option>
          <option value="authenticated">Authenticated — requires login</option>
        </select>
        <p className="text-xs text-muted-foreground">
          {visibility === "authenticated" && tags.length === 0
            ? "All authenticated users will have access. Add access tags below to restrict further."
            : visibility === "authenticated"
              ? "Only users with matching access tags will have access."
              : "This document will be visible to everyone."}
        </p>
      </div>

      <div className="space-y-2">
        <Label>
          Access Tags{" "}
          {visibility === "public" && (
            <span className="text-muted-foreground font-normal">
              (not applicable for public)
            </span>
          )}
        </Label>
        <div className="flex gap-2">
          <Input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                addTag()
              }
            }}
            placeholder="Add a tag and press Enter"
            className="flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addTag}
            className="h-9"
          >
            Add
          </Button>
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {tags.map((tag) => (
              <Badge
                key={tag}
                variant="secondary"
                className="gap-1 pr-1 font-normal"
              >
                {tag}
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  className="rounded-full p-0.5 hover:bg-foreground/10"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>
    </>
  )

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="text-base">
          Add Document to{" "}
          <span className="text-muted-foreground">{collectionName}</span>
        </CardTitle>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-8 w-8"
        >
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2 mb-4">
            {error}
          </div>
        )}

        <Tabs defaultValue="file">
          <TabsList>
            <TabsTrigger value="file" className="gap-1.5">
              <FileUp className="h-3.5 w-3.5" />
              File Upload
            </TabsTrigger>
            <TabsTrigger value="text" className="gap-1.5">
              <FileText className="h-3.5 w-3.5" />
              Text Content
            </TabsTrigger>
          </TabsList>

          <TabsContent value="text">
            <form onSubmit={handleTextSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Document title"
                />
              </div>
              <div className="space-y-2">
                <Label>Content</Label>
                <Textarea
                  required
                  rows={4}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Paste or type document content..."
                  className="resize-y"
                />
              </div>
              {sharedFields}
              <div className="flex justify-end gap-3 pt-2">
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isPending}>
                  {isPending ? "Uploading..." : "Upload"}
                </Button>
              </div>
            </form>
          </TabsContent>

          <TabsContent value="file">
            <form onSubmit={handleFileSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label>Files</Label>
                <div
                  onDragOver={(e) => {
                    e.preventDefault()
                    setIsDragging(true)
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={cn(
                    "border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors",
                    isDragging
                      ? "border-ring bg-accent"
                      : "border-border hover:border-ring/50 hover:bg-accent/50",
                  )}
                >
                  <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
                    <FileUp className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm">
                    Drop files here or{" "}
                    <span className="text-foreground font-medium">browse</span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    PDF, DOCX, PPTX, XLSX, TXT and more
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.length) addFiles(e.target.files)
                      e.target.value = ""
                    }}
                  />
                </div>
                {files.length > 0 && (
                  <ul className="space-y-1 pt-1">
                    {files.map((file, i) => (
                      <li
                        key={`${file.name}-${file.size}`}
                        className="flex items-center justify-between px-3 py-2 bg-muted/50 rounded-md text-sm"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="truncate">{file.name}</span>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {formatFileSize(file.size)}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeFile(i)}
                          className="p-0.5 text-muted-foreground hover:text-destructive shrink-0"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {sharedFields}
              <div className="flex justify-end gap-3 pt-2">
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isPending}>
                  {isPending
                    ? "Uploading..."
                    : `Upload ${files.length || ""} File${files.length !== 1 ? "s" : ""}`}
                </Button>
              </div>
            </form>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
