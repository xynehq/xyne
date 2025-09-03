import { useState } from "react"
import { ChevronRight, ChevronDown } from "lucide-react"
import type { FileNode } from "@/utils/fileUtils"

interface SimpleFileTreeProps {
  items: FileNode[]
  collection: any
  onFileClick: (file: FileNode) => void
  selectedFile?: FileNode
  onToggle: (node: FileNode) => void
}

// Helper function to flatten the tree structure
const flattenTree = (
  nodes: FileNode[],
  level = 0,
): { node: FileNode; level: number }[] => {
  const result: { node: FileNode; level: number }[] = []

  nodes.forEach((node) => {
    result.push({ node, level })
    if (node.type === "folder" && node.isOpen && node.children) {
      result.push(...flattenTree(node.children, level + 1))
    }
  })

  return result
}

const SimpleFileTree = ({
  items,
  onFileClick,
  selectedFile,
  onToggle,
}: SimpleFileTreeProps) => {
  const flatItems = flattenTree(items)

  return (
    <div className="text-sm text-gray-700 dark:text-gray-300">
      {flatItems.map(({ node, level }, index) => (
        <FileNodeComponent
          key={index}
          node={node}
          level={level}
          onFileClick={onFileClick}
          selectedFile={selectedFile}
          onToggle={onToggle}
        />
      ))}
    </div>
  )
}

const FileNodeComponent = ({
  node,
  level = 0,
  onFileClick,
  selectedFile,
  onToggle,
}: {
  node: FileNode
  level?: number
  onFileClick: (file: FileNode) => void
  selectedFile?: FileNode
  onToggle: (node: FileNode) => void
}) => {
  const [isHovered, setIsHovered] = useState(false)
  const isSelected = selectedFile === node
  const isClickableFile = node.type === "file"

  return (
    <div
      className={`relative flex items-center py-2 px-4 cursor-pointer transition-colors duration-150 rounded-md ml-3 m-3 ${
        isSelected
          ? "bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100"
          : isHovered
            ? "bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200"
            : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-[#404040]"
      }`}
      style={{
        paddingLeft: `${level * 24 + 16}px`,
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()

        if (node.type === "folder") {
          onToggle(node)
        } else if (isClickableFile) {
          onFileClick(node)
        }
      }}
    >
      {/* Indentation lines for nested items */}
      {/* {level > 0 && (
        <div
          className="absolute left-0 top-0 bottom-0 border-l border-gray-300 dark:border-[#404040]"
          style={{ 
            left: `${(level - 1) * 24 + 16}px`,
          }}
        />
      )} */}

      {node.type === "folder" && (
        <>
          <span className="mr-2 flex items-center flex-shrink-0 text-gray-500 dark:text-gray-400">
            {node.isOpen ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )}
          </span>
        </>
      )}

      <span
        className={`text-sm leading-relaxed truncate min-w-0 ${
          isSelected ? "font-medium" : ""
        }`}
        title={node.name}
      >
        {node.name}
      </span>
    </div>
  )
}

export default SimpleFileTree
