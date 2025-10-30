import React, { useRef, useEffect } from "react"
import { Editor } from "@monaco-editor/react"
import { X, Save } from "lucide-react"
import { Button } from "@/components/ui/button"

interface CodeEditorProps {
  isOpen: boolean
  onClose: () => void
  language: string
  initialValue: string
  onChange: (value: string) => void
  onSave: (value: string) => void
}

export const CodeEditor: React.FC<CodeEditorProps> = ({
  isOpen,
  onClose,
  language,
  initialValue,
  onChange,
  onSave,
}) => {
  const editorRef = useRef<any>(null)
  const [currentValue, setCurrentValue] = React.useState(initialValue)

  // Update current value when initialValue changes
  useEffect(() => {
    setCurrentValue(initialValue)
  }, [initialValue])

  // Handle editor mount
  const handleEditorDidMount = (editor: any) => {
    editorRef.current = editor
    // Focus the editor when it mounts
    editor.focus()
  }

  // Handle value change
  const handleEditorChange = (value: string | undefined) => {
    const newValue = value || ""
    setCurrentValue(newValue)
    onChange(newValue)
  }

  // Handle save
  const handleSave = () => {
    onSave(currentValue)
    onClose()
  }

  // Handle Ctrl+S or Cmd+S
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "s") {
      event.preventDefault()
      handleSave()
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center">
      <div 
        className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-[90vw] h-[80vh] flex flex-col overflow-hidden"
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Code Editor
            </h2>
            <span className="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded capitalize">
              {language}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={handleSave}
              className="bg-blue-600 hover:bg-blue-700 text-white text-sm"
              size="sm"
            >
              <Save className="w-4 h-4 mr-2" />
              Save
            </Button>
            <button
              onClick={onClose}
              className="flex items-center justify-center w-8 h-8 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
            >
              <X className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            </button>
          </div>
        </div>

        {/* Editor */}
        <div className="flex-1 overflow-hidden">
          <Editor
            height="100%"
            language={language}
            value={currentValue}
            onChange={handleEditorChange}
            onMount={handleEditorDidMount}
            theme="vs-dark"
            options={{
              fontSize: 14,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: "on",
              lineNumbers: "on",
              folding: true,
              cursorBlinking: "blink",
              cursorSmoothCaretAnimation: "on",
              renderWhitespace: "selection",
              selectOnLineNumbers: true,
              tabSize: 2,
              insertSpaces: true,
            }}
          />
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Press <kbd className="px-1 py-0.5 text-xs bg-gray-200 dark:bg-gray-700 rounded">Ctrl+S</kbd> or{" "}
            <kbd className="px-1 py-0.5 text-xs bg-gray-200 dark:bg-gray-700 rounded">Cmd+S</kbd> to save
          </p>
        </div>
      </div>
    </div>
  )
}