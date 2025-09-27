import React, { useState } from "react"
import { createPortal } from "react-dom"
import Editor from "@monaco-editor/react"
import { X, Save } from "lucide-react"

interface CodeEditorProps {
  isOpen: boolean
  onClose: () => void
  language: string
  initialValue: string
  onChange?: (value: string) => void
  onSave?: (value: string) => void
}

const getMonacoLanguage = (language: string): string => {
  switch (language.toLowerCase()) {
    case "python":
      return "python"
    case "javascript":
      return "javascript"
    case "r":
      return "r"
    default:
      return "plaintext"
  }
}

export const CodeEditor: React.FC<CodeEditorProps> = ({
  isOpen,
  onClose,
  language,
  initialValue,
  onChange,
  onSave,
}) => {
  const [code, setCode] = useState(initialValue)

  // Update code when initialValue changes
  React.useEffect(() => {
    setCode(initialValue)
  }, [initialValue])

  // Add keyboard shortcuts and manage body overflow
  React.useEffect(() => {
    if (!isOpen) return

    // Prevent body scrolling when modal is open
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "s") {
        event.preventDefault()
        handleSave()
      }
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      // Restore body scrolling when modal closes
      document.body.style.overflow = 'unset'
    }
  }, [isOpen, code, onClose])

  const handleEditorChange = (value: string | undefined) => {
    const newValue = value || ""
    setCode(newValue)
    onChange?.(newValue)
  }

  const handleSave = () => {
    onSave?.(code)
    onClose()
  }

  if (!isOpen) return null

  const modalContent = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      {/* Darker Backdrop */}
      <div 
        className="absolute inset-0 bg-black bg-opacity-85" 
        onClick={onClose}
      />
      
      {/* Windowed Editor */}
      <div className="relative w-[95vw] h-[90vh] bg-white dark:bg-gray-900 rounded-lg shadow-2xl border border-gray-200 dark:border-gray-700 flex flex-col max-w-7xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Code Editor
            </h2>
            <span className="px-2 py-1 text-xs bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded-md font-medium capitalize">
              {language}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              title="Close (Esc)"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Editor */}
        <div className="flex-1 p-4">
          <Editor
            height="100%"
            language={getMonacoLanguage(language)}
            value={code}
            onChange={handleEditorChange}
            theme="light"
            options={{
              minimap: { enabled: true },
              fontSize: 14,
              lineNumbers: "on",
              roundedSelection: false,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              insertSpaces: true,
              wordWrap: "on",
              bracketPairColorization: { enabled: true },
              folding: true,
              lineNumbersMinChars: 3,
              scrollbar: {
                vertical: "visible",
                horizontal: "visible",
              },
            }}
            loading={
              <div className="flex items-center justify-center h-full">
                <div className="text-gray-500 dark:text-gray-400">
                  Loading editor...
                </div>
              </div>
            }
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Press Ctrl+S to save • Press Esc to close
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-md transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors flex items-center gap-2"
            >
              <Save size={16} />
              Save & Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  // Render using React Portal to ensure it's outside all other components
  return createPortal(modalContent, document.body)
}