import { useState } from "react"
import {
  Folder,
  File as FileIcon,
  ChevronRight,
  ChevronDown,
  Plus,
  Download,
  Trash2,
  Check,
  Loader2,
  AlertOctagon,
  RotateCcw,
} from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { FileNode } from "@/utils/fileUtils"

// Helper function to truncate email smartly
const truncateEmail = (email: string, maxLength: number = 20): string => {
  if (email.length <= maxLength) return email

  const atIndex = email.indexOf("@")
  if (atIndex === -1) {
    // Not an email, just truncate normally
    return email.length > maxLength
      ? email.substring(0, maxLength - 3) + "..."
      : email
  }

  const username = email.substring(0, atIndex)
  const domain = email.substring(atIndex + 1)

  // If username + @ + domain is short enough, return as is
  if (email.length <= maxLength) return email

  // Calculate available space for domain (accounting for username, @, and ...)
  const availableDomainLength = maxLength - username.length - 1 - 3 // -1 for @, -3 for ...

  if (availableDomainLength > 0 && domain.length > availableDomainLength) {
    return `${username}@${domain.substring(0, availableDomainLength)}...`
  }

  // If username is too long, truncate it instead
  const availableUsernameLength = maxLength - domain.length - 1 - 3 // -1 for @, -3 for ...
  if (availableUsernameLength > 0) {
    return `${username.substring(0, availableUsernameLength)}...@${domain}`
  }

  // Fallback: just truncate the whole thing
  return email.substring(0, maxLength - 3) + "..."
}

// Reusable upload status indicator component
const UploadStatusIndicator = ({ 
  uploadStatus, 
  statusMessage 
}: { 
  uploadStatus: string
  statusMessage?: string 
}) => {
  return (
    <div className="flex-shrink-0">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              {uploadStatus === "completed" && (
                <Check size={14} className="text-green-600 dark:text-green-400" />
              )}
              {(uploadStatus === "processing" || uploadStatus === "pending") && (
                <Loader2 size={14} className="text-black dark:text-white animate-spin" />
              )}
              {uploadStatus === "failed" && (
                <AlertOctagon size={14} className="text-red-500" />
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p>{statusMessage || uploadStatus}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}

interface FileTreeProps {
  items: FileNode[]
  onAddFiles: (node: FileNode, path: string) => void
  onDelete: (node: FileNode, path: string) => void
  onToggle: (node: FileNode) => void
  onFileClick: (node: FileNode) => void
  onDownload?: (node: FileNode, path: string) => void
  onRetry?: (node: FileNode, path: string) => void
}

const FileTree = ({
  items,
  onAddFiles,
  onDelete,
  onToggle,
  onFileClick,
  onDownload,
  onRetry,
}: FileTreeProps) => {
  return (
    <div className="mt-2">
      {items.map((item, index) => (
        <FileNodeComponent
          key={index}
          node={item}
          onAddFiles={onAddFiles}
          onDelete={onDelete}
          onToggle={onToggle}
          onFileClick={onFileClick}
          onDownload={onDownload}
          onRetry={onRetry}
        />
      ))}
    </div>
  )
}

const FileNodeComponent = ({
  node,
  level = 0,
  path = "",
  onAddFiles,
  onDelete,
  onToggle,
  onFileClick,
  onDownload,
  onRetry,
}: {
  node: FileNode
  level?: number
  path?: string
  onAddFiles: (node: FileNode, path: string) => void
  onDelete: (node: FileNode, path: string) => void
  onToggle: (node: FileNode) => void
  onFileClick: (node: FileNode) => void
  onDownload?: (node: FileNode, path: string) => void
  onRetry?: (node: FileNode, path: string) => void
}) => {
  const [isHovered, setIsHovered] = useState(false)

  const indentStyle = { paddingLeft: `${level * 1.5}rem` }
  const currentPath = path ? `${path}/${node.name}` : node.name

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="grid grid-cols-12 items-center gap-4 text-sm text-gray-700 dark:text-gray-300 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-md">
        <div
          className="col-span-5 flex items-center hover:cursor-pointer"
          style={indentStyle}
        >
          {node.type === "folder" ? (
            <div
              className="flex items-center gap-2 cursor-pointer w-full"
              onClick={() => onToggle(node)}
            >
              {node.isOpen ? (
                <ChevronDown size={16} />
              ) : (
                <ChevronRight size={16} />
              )}
              <Folder size={16} />
              <span
                className="font-sans font-semibold text-gray-800 dark:text-gray-200"
                style={{ fontFamily: "Inter", fontWeight: 500 }}
              >
                {node.name}
              </span>
              {/* Upload status indicator for folders */}
              {node.uploadStatus && (
                <UploadStatusIndicator
                  uploadStatus={node.uploadStatus}
                  statusMessage={node.statusMessage}
                />
              )}
            </div>
          ) : (
            <div
              className="flex items-center gap-2 w-full"
              onClick={() => onFileClick && onFileClick(node)}
            >
              <FileIcon size={16} className="flex-shrink-0" />
              <span
                className="font-sans break-all text-gray-700 dark:text-gray-300"
                style={{ fontFamily: "Inter", fontWeight: 400 }}
              >
                {node.name}
              </span>
              {/* Upload status indicator */}
              {node.uploadStatus && (
                <UploadStatusIndicator
                  uploadStatus={node.uploadStatus}
                  statusMessage={node.statusMessage}
                />
              )}
            </div>
          )}
        </div>
        <div className="col-span-2">
          {isHovered && (
            <div className="flex items-center justify-end gap-2 pr-4">
              {node.type === "folder" && (
                <Plus
                  size={16}
                  className="cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation()
                    onAddFiles(node, currentPath)
                  }}
                />
              )}
              {node.type === "file" && onDownload && (
                <Download
                  size={16}
                  className="cursor-pointer text-gray-700 dark:text-gray-200 flex-shrink-0"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onDownload(node, currentPath)
                  }}
                />
              )}
              {(node.retryCount ?? 0) > 3 && onRetry && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <RotateCcw
                        size={16}
                        className="cursor-pointer text-gray-700 dark:text-gray-200 flex-shrink-0"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          onRetry(node, currentPath)
                        }}
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Retry</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <Trash2
                size={16}
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(node, currentPath)
                }}
              />
            </div>
          )}
        </div>
        <div className="col-span-1 text-center">
          {node.type === "file" ? 1 : node.files}
        </div>
        <div className="col-span-2">
          {node.lastUpdated
            ? new Date(node.lastUpdated).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
            : ""}
        </div>
        <div className="col-span-2 flex items-center gap-2">
          {node.updatedBy && (
            <>
              <div className="w-6 h-6 rounded-full bg-gray-800 text-white flex items-center justify-center text-xs font-bold flex-shrink-0">
                {node.updatedBy.charAt(0).toUpperCase()}
              </div>
              <div className="flex flex-col min-w-0">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-default max-w-[120px]">
                        {truncateEmail(node.updatedBy, 18)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{node.updatedBy}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </>
          )}
        </div>
      </div>
      {node.type === "folder" && node.isOpen && node.children && (
        <div>
          {node.children.map((child, index) => (
            <FileNodeComponent
              key={index}
              node={child}
              level={level + 1}
              path={currentPath}
              onAddFiles={onAddFiles}
              onDelete={onDelete}
              onToggle={onToggle}
              onFileClick={onFileClick}
              onDownload={onDownload}
              onRetry={onRetry}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default FileTree
