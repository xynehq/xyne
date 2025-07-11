import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Calendar, User, Hash } from "lucide-react"

interface DataSourceViewerProps {
  id: string
  title: string
  description: string
  text: string
  uploadedBy?: string
  createdAt?: number
  fileSize?: number
  mimeType?: string
}

export const DataSourceViewer = (data: DataSourceViewerProps) => {
  const {
    id,
    title,
    description,
    text,
    uploadedBy,
    createdAt,
    fileSize,
    mimeType,
  } = data

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return "Unknown size"
    const sizes = ["Bytes", "KB", "MB", "GB"]
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return `${Math.round((bytes / Math.pow(1024, i)) * 100) / 100} ${sizes[i]}`
  }

  const formatDate = (timestamp?: number) => {
    if (!timestamp) return "Unknown date"
    return new Date(timestamp).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  const getMimeTypeColor = (mime?: string) => {
    if (!mime) return "bg-gray-100 text-gray-800"
    if (mime.includes("pdf")) return "bg-red-50 text-red-600"
    if (mime.includes("word")) return "bg-blue-50 text-blue-600"
    if (mime.includes("text")) return "bg-green-50 text-green-600"
    return "bg-gray-100 text-gray-800"
  }

  return (
    <div className="container mx-auto p-6 max-w-5xl">
      <Card className="w-full shadow-lg">
        <CardHeader className="space-y-6 bg-gradient-to-r from-blue-40 to-indigo-40">
          <div className="flex items-start justify-between">
            <div className="space-y-3 flex-1">
              <CardTitle className="text-3xl font-bold text-gray-900 flex items-center gap-3">
                {title}
              </CardTitle>
              {description && (
                <p className="text-lg text-gray-600 leading-relaxed max-w-3xl">
                  {description}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            {mimeType && (
              <span
                className={`px-3 py-1 rounded-full text-sm font-medium ${getMimeTypeColor(mimeType)}`}
              >
                {mimeType.split("/")[1]?.toUpperCase() || mimeType}
              </span>
            )}
            {fileSize && (
              <span className="px-3 py-1 rounded-full text-sm font-medium bg-purple-100 text-purple-800">
                {formatFileSize(fileSize)}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            {uploadedBy && (
              <div className="flex items-center gap-2 text-gray-600 bg-white px-3 py-2 rounded-lg">
                <User className="h-4 w-4 text-blue-500" />
                <span className="font-medium">Uploaded by:</span>
                <span className="font-semibold">{uploadedBy}</span>
              </div>
            )}
            {createdAt && (
              <div className="flex items-center gap-2 text-gray-600 bg-white px-3 py-2 rounded-lg">
                <Calendar className="h-4 w-4 text-green-500" />
                <span className="font-medium">Created:</span>
                <span className="font-semibold">{formatDate(createdAt)}</span>
              </div>
            )}
            <div className="flex items-center gap-2 text-gray-600 bg-white px-3 py-2 rounded-lg">
              <Hash className="h-4 w-4 text-purple-500" />
              <span className="font-medium">ID:</span>
              <span className="font-mono text-xs truncate">{id}</span>
            </div>
          </div>
        </CardHeader>

        <div className="border-t border-gray-200"></div>

        <CardContent className="p-6">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold text-gray-900">
                Document Content
              </h3>
              <span className="text-sm text-gray-500">
                {text.length} characters
              </span>
            </div>
            <div className="bg-gray-50 rounded-lg p-6 border border-gray-200">
              <div className="h-screen overflow-y-auto">
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800 font-mono">
                  {text}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
