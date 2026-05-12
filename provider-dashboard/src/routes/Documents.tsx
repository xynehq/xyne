import { useState, useRef, useCallback } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Upload, Trash2, Plus, X, FileText, FileUp } from "lucide-react"
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

export function Documents() {
  const queryClient = useQueryClient()
  const [showUpload, setShowUpload] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ["documents"],
    queryFn: api.listDocuments,
  })

  const deleteMutation = useMutation({
    mutationFn: api.deleteDocument,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["documents"] }),
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Documents</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your knowledge base documents
          </p>
        </div>
        <Button onClick={() => setShowUpload(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Document
        </Button>
      </div>

      {showUpload && (
        <UploadForm
          onClose={() => setShowUpload(false)}
          onSuccess={() => {
            setShowUpload(false)
            queryClient.invalidateQueries({ queryKey: ["documents"] })
          }}
        />
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">
          Loading documents...
        </div>
      ) : !data?.documents.length ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
              <Upload className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">No documents yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Upload your first document to get started
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
                <TableHead>Title</TableHead>
                <TableHead>Visibility</TableHead>
                <TableHead>Access Tags</TableHead>
                <TableHead>Collection</TableHead>
                <TableHead className="text-right w-16">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.documents.map((doc) => (
                <TableRow key={doc.docId}>
                  <TableCell className="font-medium">{doc.title}</TableCell>
                  <TableCell>
                    <Badge
                      variant={doc.visibility === "public" ? "outline" : "secondary"}
                      className="font-normal"
                    >
                      {doc.visibility ?? "public"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {doc.accessTags.length > 0
                        ? doc.accessTags.map((tag) => (
                            <Badge key={tag} variant="secondary" className="font-normal">
                              {tag}
                            </Badge>
                          ))
                        : <span className="text-muted-foreground text-sm">—</span>}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {doc.collectionId || "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteMutation.mutate(doc.docId)}
                      disabled={deleteMutation.isPending}
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}

function UploadForm({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [collectionId, setCollectionId] = useState("default")
  const [visibility, setVisibility] = useState<"public" | "authenticated">("public")
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
    onError: (err) => setError(err instanceof Error ? err.message : "Upload failed"),
  })

  const fileMutation = useMutation({
    mutationFn: api.uploadFiles,
    onSuccess,
    onError: (err) => setError(err instanceof Error ? err.message : "Upload failed"),
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
      return [...prev, ...arr.filter((f) => !existing.has(`${f.name}-${f.size}`))]
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

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const sharedFields = (
    <>
      <div className="space-y-2">
        <Label>Collection ID</Label>
        <Input
          required
          value={collectionId}
          onChange={(e) => setCollectionId(e.target.value)}
          placeholder="default"
        />
      </div>

      <div className="space-y-2">
        <Label>Visibility</Label>
        <select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as "public" | "authenticated")}
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
        <Label>Access Tags {visibility === "public" && <span className="text-muted-foreground font-normal">(not applicable for public)</span>}</Label>
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
          <Button type="button" variant="outline" size="sm" onClick={addTag} className="h-9">
            Add
          </Button>
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="gap-1 pr-1 font-normal">
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
        <CardTitle className="text-base">Add Document</CardTitle>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2 mb-4">
            {error}
          </div>
        )}

        <Tabs defaultValue="text">
          <TabsList>
            <TabsTrigger value="text" className="gap-1.5">
              <FileText className="h-3.5 w-3.5" />
              Text Content
            </TabsTrigger>
            <TabsTrigger value="file" className="gap-1.5">
              <FileUp className="h-3.5 w-3.5" />
              File Upload
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
