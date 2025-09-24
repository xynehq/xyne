import { useState } from "react"
import { ChevronRight, ChevronDown } from "lucide-react"
import ReactMarkdown from "react-markdown"

interface JSONViewerProps {
  data: unknown
}

export const JSONViewer = ({ data }: JSONViewerProps) => {
  const [collapsed, setCollapsed] = useState<{ [key: string]: boolean }>({})

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const renderValue = (value: unknown, key: string, parentKey: string = "") => {
    const fullKey = parentKey ? `${parentKey}.${key}` : key
    const isCollapsed = collapsed[fullKey] !== false // Default to collapsed (true) unless explicitly set to false

    if (value === null) {
      return <span className="text-gray-500 italic">null</span>
    }

    if (value === undefined) {
      return <span className="text-gray-500 italic">undefined</span>
    }

    if (typeof value === "string") {
      // Special handling for chunks array with markdown
      if (
        key === "chunks" ||
        (parentKey.includes("chunks") && typeof value === "string")
      ) {
        return (
          <div className="ml-4">
            <div className="text-sm text-gray-600 dark:text-gray-400 mb-2">
              Rendered Markdown:
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 p-3 rounded border max-h-96 overflow-y-auto break-words">
              <ReactMarkdown className="prose prose-sm dark:prose-invert max-w-none break-words overflow-wrap-anywhere">
                {value}
              </ReactMarkdown>
            </div>
          </div>
        )
      }
      return (
        <span className="text-green-600 dark:text-green-400 break-words">
          "{value}"
        </span>
      )
    }

    if (typeof value === "number") {
      return <span className="text-blue-600 dark:text-blue-400">{value}</span>
    }

    if (typeof value === "boolean") {
      return (
        <span className="text-purple-600 dark:text-purple-400">
          {value.toString()}
        </span>
      )
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return <span className="text-gray-500">[]</span>
      }

      // For primitive arrays, show inline if short
      const allPrimitives = value.every(
        (item) =>
          typeof item === "number" ||
          typeof item === "string" ||
          typeof item === "boolean" ||
          item === null,
      )

      if (allPrimitives && value.length <= 10) {
        const inline = `[${value
          .map((item) =>
            typeof item === "string" ? `"${item}"` : String(item),
          )
          .join(", ")}]`
        if (inline.length < 100) {
          return (
            <span className="text-gray-700 dark:text-gray-300 font-mono text-sm">
              {inline}
            </span>
          )
        }
      }

      return (
        <div>
          <button
            onClick={() => toggleCollapse(fullKey)}
            className="flex items-center gap-1 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
          >
            {isCollapsed ? (
              <ChevronRight size={14} />
            ) : (
              <ChevronDown size={14} />
            )}
            <span className="font-mono">Array ({value.length} items)</span>
          </button>
          {!isCollapsed && (
            <div className="ml-4 mt-2 space-y-1">
              {value.map((item, index) => (
                <div key={index} className="flex gap-2">
                  <span className="text-gray-500 dark:text-gray-400 font-mono text-sm min-w-[30px]">
                    [{index}]:
                  </span>
                  <div className="flex-1">
                    {renderValue(item, `[${index}]`, fullKey)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )
    }

    if (typeof value === "object" && value !== null) {
      const keys = Object.keys(value as Record<string, unknown>)
      if (keys.length === 0) {
        return <span className="text-gray-500">{"{}"}</span>
      }

      return (
        <div>
          <button
            onClick={() => toggleCollapse(fullKey)}
            className="flex items-center gap-1 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
          >
            {isCollapsed ? (
              <ChevronRight size={14} />
            ) : (
              <ChevronDown size={14} />
            )}
            <span className="font-mono">Object ({keys.length} properties)</span>
          </button>
          {!isCollapsed && (
            <div className="ml-4 mt-2 space-y-2">
              {keys.map((objectKey) => (
                <div key={objectKey} className="flex gap-2">
                  <span className="text-gray-700 dark:text-gray-300 font-mono text-sm font-semibold min-w-fit">
                    {objectKey}:
                  </span>
                  <div className="flex-1">
                    {renderValue(
                      (value as Record<string, unknown>)[objectKey],
                      objectKey,
                      fullKey,
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )
    }

    return <span className="text-gray-500">{String(value)}</span>
  }

  // Filter out docId from the root level data if it's an object
  const filteredData =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (() => {
          const filtered = { ...data } as Record<string, unknown>
          delete filtered.docId
          return filtered
        })()
      : data

  return (
    <div className="text-sm">
      {typeof filteredData === "object" &&
      filteredData !== null &&
      !Array.isArray(filteredData)
        ? Object.keys(filteredData as Record<string, unknown>).map((key) => (
            <div key={key} className="mb-3 last:mb-0">
              <div className="flex gap-2">
                <span className="text-gray-800 dark:text-gray-200 font-mono font-semibold min-w-fit">
                  {key}:
                </span>
                <div className="flex-1">
                  {renderValue(
                    (filteredData as Record<string, unknown>)[key],
                    key,
                  )}
                </div>
              </div>
            </div>
          ))
        : renderValue(filteredData, "root")}
    </div>
  )
}
